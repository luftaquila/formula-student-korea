import path from "path";
import fs from "fs";

export function createDownloadService({ db, logger }) {
  // 브라우저에서 안전하게 인라인으로 표시 가능한 MIME/확장자 화이트리스트.
  // SVG·HTML은 same-origin XSS 위험이 있어 제외한다.
  const INLINE_MIME = new Set([
    "application/pdf",
    "text/plain",
    "text/csv",
    "text/markdown",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "video/mp4",
    "video/webm",
    "video/ogg",
  ]);

  const INLINE_EXT_MIME = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };

  function inlineDisposition(originalName, mimeType) {
    const ext = path.extname(originalName || "").toLowerCase();
    const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (mime && INLINE_MIME.has(mime)) return mime;
    if (INLINE_EXT_MIME[ext]) return INLINE_EXT_MIME[ext];
    return null;
  }

  // BOM이 있으면 해당 인코딩을 따르고, BOM이 없으면 UTF-8을 엄격하게 검증한다.
  // UTF-8과 CP949로 모두 해석 가능한 바이트열은 구분할 수 없으므로 UTF-8을 우선한다.
  function createTextCharsetDetector() {
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    let prefix = Buffer.alloc(0);
    let started = false;
    let settledCharset = "";

    function decodeUtf8(bytes) {
      if (settledCharset) return settledCharset;
      try {
        utf8Decoder.decode(bytes, { stream: true });
      } catch {
        settledCharset = "euc-kr";
      }
      return settledCharset;
    }

    function start(bytes) {
      started = true;
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) settledCharset = "utf-16le";
      else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
        settledCharset = "utf-16be";
      else decodeUtf8(bytes);
      return settledCharset;
    }

    return {
      write(chunk) {
        if (settledCharset) return settledCharset;
        if (started) return decodeUtf8(chunk);
        const bytes = prefix.length > 0 ? Buffer.concat([prefix, chunk]) : chunk;
        if (bytes.length < 2) {
          prefix = Buffer.from(bytes);
          return "";
        }
        prefix = Buffer.alloc(0);
        return start(bytes);
      },
      finish() {
        if (!started) start(prefix);
        if (settledCharset) return settledCharset;
        try {
          utf8Decoder.decode();
        } catch {
          return "euc-kr";
        }
        return "utf-8";
      },
    };
  }

  async function detectTextCharset(filePath) {
    const detector = createTextCharsetDetector();
    for await (const chunk of fs.createReadStream(filePath)) {
      const charset = detector.write(chunk);
      if (charset) return charset;
    }
    return detector.finish();
  }

  // 신규 업로드는 판별 결과를 DB에 저장한다. 기존 파일은 최초 열람 때 비동기로 한 번만
  // 판별하고 저장하며, 동시에 들어온 Range 요청은 같은 Promise를 공유한다.
  const textCharsetPromises = new Map();

  async function getTextCharset(file, filePath) {
    if (["utf-8", "euc-kr", "utf-16le", "utf-16be"].includes(file.text_charset))
      return file.text_charset;
    if (!textCharsetPromises.has(file.id)) {
      const pending = detectTextCharset(filePath)
        .then((charset) => {
          try {
            db.prepare("UPDATE submission_file SET text_charset = ? WHERE id = ?").run(
              charset,
              file.id,
            );
          } catch (e) {
            logger.warn(null, "file.charset_cache", {
              error: e.message,
              file_id: file.id,
              file: file.original_name,
            });
          }
          return charset;
        })
        .catch(() => "utf-8");
      textCharsetPromises.set(file.id, pending);
      pending.finally(() => {
        if (textCharsetPromises.get(file.id) === pending) textCharsetPromises.delete(file.id);
      });
    }
    return textCharsetPromises.get(file.id);
  }

  async function setFileResponseHeaders(res, file, filePath) {
    const inlineType = inlineDisposition(file.original_name, file.mime_type);
    const encoded = encodeURIComponent(file.original_name);
    // Caddy가 전역으로 nosniff를 붙이지만, 프록시 없이 직접 접속하는 경로(dev 등)도 방어
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (inlineType) {
      const contentType = inlineType.startsWith("text/")
        ? `${inlineType}; charset=${await getTextCharset(file, filePath)}`
        : inlineType;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encoded}`);
    } else {
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`);
    }
  }

  // 브라우저 인라인 뷰어(PDF 등)는 Range 요청으로 파일을 여러 조각으로 나눠 가져온다.
  // res.sendFile은 매 Range 요청마다 핸들러를 재실행하므로, 모든 요청에서 로깅하면
  // 다운로드 1회에 로그가 수십 건 찍힌다. 초기 요청(Range 없음 또는 bytes=0-)에서만
  // 로깅해 다운로드 1회당 로그 1건을 유지한다.
  function isInitialDownload(req) {
    const range = req.headers.range;
    return !range || range.startsWith("bytes=0-");
  }

  return {
    inlineDisposition,
    createTextCharsetDetector,
    setFileResponseHeaders,
    isInitialDownload,
  };
}
