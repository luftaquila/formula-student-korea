import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Database from "better-sqlite3";
import { createDatabase } from "../shared/db-setup.mjs";
import { createCachedValidator, createRemoteUserValidator, ensureDataDir } from "../shared/express-setup.mjs";
import { currentCompetitionYear } from "../shared/competition-year.mjs";
import { createQueueApp } from "../queue/index.mjs";
import { createInspectionApp } from "../inspection/index.mjs";
import { createTrafficApp } from "../traffic/index.mjs";
import { createScoreApp } from "../score/index.mjs";
import { createDocumentsApp } from "../documents/index.mjs";
import { createModuleYearGuard } from "./lib/year-guard.mjs";
import { installCanonicalTeamReferences } from "./lib/team-references.mjs";
import { ensureCompetitionTeamSchema } from "./lib/team-store.mjs";
import { createTeamsModule } from "./modules/teams.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 9200;
const UI_MODULES = Object.freeze(["entry", "queue", "inspection", "traffic", "score", "documents"]);

function defaultStaticRoots() {
  return Object.fromEntries(UI_MODULES.map((name) => [name, path.resolve(here, `../${name}/web/dist`)]));
}

function mountUi(app, prefix, staticRoot, moduleApp) {
  // Reuse the module's authentication middleware before the shared process
  // serves its SPA. Without this pass, consolidating static hosting would
  // silently make every module UI public even though its API stayed gated.
  app.use(prefix, moduleApp);
  app.use(prefix, express.static(staticRoot, {
    index: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html") || filePath.endsWith("env-config.js")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));
  app.get([prefix, `${prefix}/{*splat}`], (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile("index.html", { root: staticRoot });
  });
}

function mountFlatModuleApi(app, prefix, moduleApp) {
  app.use(prefix, (req, res, next) => {
    if (/^\/(?:api|internal)(?:\/|$)/i.test(req.path)) return res.status(404).json({ code: "NOT_FOUND" });
    req.url = `/api${req.url.startsWith("/") ? "" : "/"}${req.url}`;
    moduleApp(req, res, next);
  });
}

export function createCompetitionApp(options = {}) {
  ensureDataDir();

  const dbPath = options.dbPath || "./data/competition.db";
  const db = options.db || createDatabase(Database, dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  ensureCompetitionTeamSchema(db);

  const staticRoots = { ...defaultStaticRoots(), ...options.staticRoots };
  if (!options.skipStaticValidation) {
    for (const name of UI_MODULES) {
      const indexPath = path.join(staticRoots[name], "index.html");
      if (!fs.existsSync(indexPath)) throw new Error(`missing ${name} SPA entrypoint: ${indexPath}`);
    }
  }
  const uploadRoot = path.resolve(options.uploadRoot || "./data/uploads");
  const validateUserCacheTtl = options.validateUserCacheTtl ?? 5000;
  const rawValidateUser = options.validateUser || createRemoteUserValidator();
  const sharedValidateUser = validateUserCacheTtl > 0
    ? createCachedValidator(rawValidateUser, validateUserCacheTtl)
    : rawValidateUser;
  const common = {
    db,
    validateUser: sharedValidateUser,
    // sharedValidateUser already applies the process-wide Competition cache.
    // Disable six nested module caches so a request to a less-used module
    // cannot extend a stale role beyond the single configured TTL.
    validateUserCacheTtl: 0,
    skipSpaFallback: true,
  };
  let dispatchScoreSourceEvent = () => {};
  let dispatchTeamChange = () => {};

  // Schema initialization is deliberately serial: later modules create their
  // read filters over the canonical team tables initialized above, and every
  // factory receives this exact SQLite connection.
  const teams = createTeamsModule({
    db,
    validateUser: sharedValidateUser,
    validateUserCacheTtl: 0,
    staticRoot: staticRoots.entry,
    skipSpaFallback: true,
    onChange: (data) => dispatchTeamChange(data),
  });
  const guarded = (module) => createModuleYearGuard({ module, db });
  const queue = createQueueApp({
    ...common,
    staticRoot: staticRoots.queue,
    teamStore: teams.store,
    mutationGuard: guarded("queue"),
    smsRequest: options.smsRequest,
    smsConfig: options.smsConfig,
  });
  const inspection = createInspectionApp({
    ...common,
    staticRoot: staticRoots.inspection,
    mutationGuard: guarded("inspection"),
    onEvent: (event, data) => dispatchScoreSourceEvent("inspection", event, data),
  });
  const traffic = createTrafficApp({
    ...common,
    staticRoot: staticRoots.traffic,
    teamStore: teams.store,
    mutationGuard: guarded("traffic"),
    onEvent: (event, data) => dispatchScoreSourceEvent("traffic", event, data),
  });
  const score = createScoreApp({
    ...common,
    staticRoot: staticRoots.score,
    mutationGuard: guarded("score"),
    skipSSESubscriptions: true,
    competitionQueries: {
      teams: teams.store,
      inspection: inspection.queries,
      traffic: traffic.queries,
    },
  });
  dispatchScoreSourceEvent = score.sourceEvent;
  dispatchTeamChange = (data) => {
    score.sourceEvent("entry", "entries", data);
    queue.sourceEvent("entries", data);
    inspection.sourceEvent("entries", data);
    traffic.sourceEvent("entries", data);
  };
  const documents = createDocumentsApp({
    ...common,
    staticRoot: staticRoots.documents,
    uploadsDir: uploadRoot,
    teamStore: teams.store,
    mutationGuard: guarded("documents"),
    enableNotificationScheduler: options.enableNotificationScheduler,
    sendNotificationEmail: options.sendNotificationEmail,
    beforeSubmissionMetadataCommit: options.beforeSubmissionMetadataCommit,
  });
  installCanonicalTeamReferences(db);

  const modules = { teams, queue, inspection, traffic, score, documents };
  const app = express();
  app.disable("x-powered-by");

  app.get("/health/live", (req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", (req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not-ready" });
    }
  });
  app.get("/api/health", (req, res) => res.send("ok"));
  app.get("/competition/api/v1/meta", (req, res) => {
    const currentYear = currentCompetitionYear();
    const years = teams.store.listYears();
    if (!years.includes(currentYear)) years.unshift(currentYear);
    res.json({ currentYear, years });
  });

  app.use("/competition/api/v1", (req, res, next) => {
    if (!/^\/(?:teams|vehicle-types|health|logs)(?:\/|$)/i.test(req.path)) return next();
    teams.app(req, res, next);
  });
  for (const name of ["queue", "inspection", "traffic", "score", "documents"]) {
    mountFlatModuleApi(app, `/competition/api/v1/${name}`, modules[name].app);
  }

  // Old API paths are intentionally not a second compatibility facade. This
  // makes stale browser bundles fail loudly instead of creating two long-lived
  // route contracts. UI paths themselves remain stable.
  for (const name of UI_MODULES) {
    app.use(`/${name}/api`, (req, res) => res.status(404).json({ code: "NOT_FOUND" }));
  }

  mountUi(app, "/entry", staticRoots.entry, teams.app);
  for (const name of ["queue", "inspection", "traffic", "score", "documents"]) {
    mountUi(app, `/${name}`, staticRoots[name], modules[name].app);
  }

  app.use((req, res) => res.status(404).json({ code: "NOT_FOUND" }));

  const timers = [
    ...(queue.timers || []),
    ...(traffic.timers || []),
    ...(documents.timers || []),
  ];
  let drained = false;
  let closed = false;
  let closePromise = null;
  const start = () => queue.loadSmsConfig({ retries: 10, delayMs: 3000 });
  const drain = () => {
    if (!drained) {
      drained = true;
      for (const module of Object.values(modules)) module.closeSse?.();
    }
    return Promise.all(Object.values(modules).map((module) => module.drain?.()).filter(Boolean));
  };
  const close = () => {
    if (closePromise) return closePromise;
    if (closed) return Promise.resolve();
    closed = true;
    const drainPromise = drain();
    for (const timer of timers) clearTimeout(timer);
    const closeDatabase = () => {
      if (!options.db && db.open) db.close();
    };
    if (!documents.hasPendingNotificationTasks?.()) {
      closeDatabase();
      closePromise = Promise.resolve();
    } else {
      closePromise = drainPromise.then(closeDatabase);
    }
    return closePromise;
  };

  return { app, db, teams: teams.store, modules, start, drain, close };
}

export function createShutdownHandler({
  server,
  runtime,
  deadlineMs = 55_000,
  exit = (code) => process.exit(code),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let shuttingDown = false;
  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[competition] ${signal}; draining HTTP requests`);
    runtime.drain().catch((error) => {
      console.error(`[competition] drain failed: ${error.message || error}`);
    });
    const forced = setTimeoutFn(() => exit(1), deadlineMs);
    forced?.unref?.();
    server.close(async () => {
      try {
        await runtime.close();
        clearTimeoutFn(forced);
        exit(0);
      } catch (error) {
        clearTimeoutFn(forced);
        console.error(`[competition] shutdown failed: ${error.message || error}`);
        exit(1);
      }
    });
  };
}

if (import.meta.filename === process.argv[1]) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const created = createCompetitionApp({ port });
  const server = created.app.listen(port, () => {
    console.log(`Competition service running on port ${port}`);
    created.start().catch((error) => console.error(`[competition] startup task failed: ${error.message || error}`));
  });
  const shutdown = createShutdownHandler({ server, runtime: created });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("exit", () => created.close());
}
