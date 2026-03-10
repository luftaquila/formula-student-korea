import fs from "fs";

export function ensureDataDir() {
  if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data", { recursive: true });
  }
}

export function createApp(logFile, { express, pinoHttp }) {
  ensureDataDir();

  const app = express();
  app.use(express.json());
  app.use(express.static("./web/dist"));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    if (req.headers.authorization) {
      req.headers.authuser = Buffer.from(req.headers.authorization.split(" ")[1], "base64")
        .toString("utf-8")
        .split(":")[0];
    }
    next();
  });
  app.use(
    pinoHttp({
      stream: fs.createWriteStream(`./data/${logFile}`, { flags: "a" }),
      customProps: (req, res) => ({ reqBody: req.body }),
    }),
  );

  return app;
}

export function setupProcessHandlers(db) {
  process.on("exit", () => db.close());
  process.on("SIGHUP", () => process.exit(128 + 1));
  process.on("SIGINT", () => process.exit(128 + 2));
  process.on("SIGTERM", () => process.exit(128 + 15));
}

export function createDbRun() {
  return function dbRun(fn) {
    try {
      return { success: true, result: fn() };
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { success: false, status: 400, error: "이미 존재하는 항목입니다." };
      }
      if (e.status && e.message) {
        return { success: false, status: e.status, error: e.message };
      }
      return { success: false, status: 500, error: `DB 오류: ${e.message || e}` };
    }
  };
}
