import fs from "fs";
import path from "path";

export function createUploadStorage({ options, logger, db }) {
  const removeDirectory =
    options.removeDirectory || ((dir) => fs.rmSync(dir, { recursive: true, force: true }));

  // 업로드 디렉토리 생성
  const UPLOADS_DIR = path.resolve(options.uploadsDir || "./data/uploads");

  let UPLOADS_REAL_DIR = null;

  let TMP_DIR = null;

  function safeExt(filename) {
    const ext = path.extname(filename || "").toLowerCase();
    return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
  }

  // zip 엔트리/아카이브 폴더명에서 경로 구분자·금지 문자를 "_"로 치환.
  function sanitize(s) {
    return s.replace(/[/\\:*?"<>|]/g, "_");
  }

  function rmDir(dir, { logFailure = true, req = null } = {}) {
    try {
      removeDirectory(dir);
      return { removed: true, error: null };
    } catch (err) {
      if (logFailure) logger.warn(req, "file.cleanup", { error: err.message, dir });
      return { removed: false, error: err.message || String(err) };
    }
  }

  function logCleanupFailures(req, action, target, context, cleanup) {
    const failed = cleanup.filter((item) => !item.removed);
    if (failed.length === 0) return;
    logger.warn(
      req,
      action,
      {
        error: "partial_file_cleanup",
        reason: "partial_file_cleanup",
        ...context,
        failed_cleanup: failed,
      },
      target,
    );
  }

  function teamUploadDir(sessionId, teamNum) {
    return path.join(UPLOADS_DIR, String(sessionId), String(teamNum));
  }

  function submissionRelativeDir(submission) {
    const storageDir = submission?.storage_dir;
    if (typeof storageDir !== "string" || !storageDir.trim()) {
      throw new Error(`submission ${submission?.id ?? "?"} has no canonical storage directory`);
    }
    if (path.isAbsolute(storageDir)) {
      throw new Error(`submission ${submission?.id ?? "?"} has an absolute storage directory`);
    }
    return storageDir;
  }

  function submissionUploadDir(submission) {
    const root = UPLOADS_REAL_DIR;
    if (!root) throw new Error("managed uploads directory is not initialized");
    const target = path.resolve(root, submissionRelativeDir(submission));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("submission storage path escapes the uploads directory");
    }
    return target;
  }

  function submissionFilePath(submission, storedName) {
    if (typeof storedName !== "string" || !storedName || path.basename(storedName) !== storedName) {
      throw new Error(`submission_file has an invalid stored name: ${String(storedName)}`);
    }
    const directory = submissionUploadDir(submission);
    const target = path.resolve(directory, storedName);
    if (!target.startsWith(`${directory}${path.sep}`)) {
      throw new Error("submission file path escapes its storage directory");
    }
    return target;
  }

  function assertExistingPathComponentsAreNotSymlinks(target) {
    const parsed = path.parse(target);
    let cursor = parsed.root;
    const components = path.relative(parsed.root, target).split(path.sep).filter(Boolean);
    for (const component of components) {
      cursor = path.join(cursor, component);
      let stat;
      try {
        stat = fs.lstatSync(cursor);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`uploads directory path contains a symbolic link: ${cursor}`);
      }
    }
  }

  function cleanupManagedUploads() {
    const configuredRoot = path.resolve(UPLOADS_DIR);
    let root = configuredRoot;
    const referencedRows = db
      .prepare(
        `
    SELECT s.id, s.session_id, s.team_num, s.storage_dir, f.stored_name
    FROM submission_file f JOIN submission s ON s.id = f.submission_id
  `,
      )
      .all();
    const submissions = db.prepare("SELECT id, storage_dir FROM submission").all();
    const referenced = new Set();
    const deleted = [];
    try {
      assertExistingPathComponentsAreNotSymlinks(configuredRoot);
      if (!fs.existsSync(configuredRoot)) fs.mkdirSync(configuredRoot, { recursive: true });
      assertExistingPathComponentsAreNotSymlinks(configuredRoot);
      const configuredStat = fs.lstatSync(configuredRoot);
      if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
        throw new Error("uploads directory must be a real directory, not a symbolic link");
      }
      root = fs.realpathSync.native(configuredRoot);
      if (root === path.parse(root).root)
        throw new Error("filesystem root cannot be used as the uploads directory");
      UPLOADS_REAL_DIR = root;
      for (const submission of submissions) submissionUploadDir(submission);
      TMP_DIR = path.join(root, "_tmp");
      fs.mkdirSync(TMP_DIR, { recursive: true });
      for (const file of referencedRows) {
        const target = submissionFilePath(file, file.stored_name);
        const relative = path.relative(root, target);
        let cursor = root;
        let stat;
        for (const component of relative.split(path.sep)) {
          cursor = path.join(cursor, component);
          stat = fs.lstatSync(cursor);
          if (stat.isSymbolicLink()) {
            throw new Error(`referenced upload path contains a symbolic link: ${relative}`);
          }
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`referenced upload is not a regular file: ${relative}`);
        }
        referenced.add(target);
      }
      const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (target === TMP_DIR) {
            for (const temp of fs.readdirSync(target))
              deleted.push(path.relative(root, path.join(target, temp)));
            fs.rmSync(target, { recursive: true, force: true });
            fs.mkdirSync(target, { recursive: true });
          } else if (entry.isDirectory()) {
            walk(target);
            if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
          } else if (!entry.isFile() || !referenced.has(path.resolve(target))) {
            fs.rmSync(target, { recursive: true, force: true });
            deleted.push(path.relative(root, target));
          }
        }
      };
      walk(root);
      logger.log(null, "file.startup_cleanup", {
        uploadRoot: root,
        referencedFiles: referenced.size,
        deletedCount: deleted.length,
        deleted,
      });
    } catch (error) {
      logger.warn(null, "file.startup_cleanup", {
        error: error.message || String(error),
        uploadRoot: root,
        deletedCount: deleted.length,
        deleted,
      });
      throw new Error(`managed upload cleanup failed: ${error.message || error}`);
    }
  }

  return {
    UPLOADS_DIR,
    readTMP_DIR: () => TMP_DIR,
    safeExt,
    sanitize,
    rmDir,
    logCleanupFailures,
    submissionUploadDir,
    submissionFilePath,
    cleanupManagedUploads,
  };
}
