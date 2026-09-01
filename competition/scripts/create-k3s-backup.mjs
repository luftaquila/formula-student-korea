#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import Database from "better-sqlite3";
import { validateCompetitionDatabase } from "../lib/database-validation.mjs";
import { validateSupportDatabase } from "../lib/support-database-validation.mjs";

const DATABASES = Object.freeze([
  Object.freeze({ name: "competition", relative: "competition/competition.db" }),
  Object.freeze({ name: "auth", relative: "auth/auth.db" }),
  Object.freeze({ name: "calendar", relative: "calendar/calendar.db" }),
  Object.freeze({ name: "course", relative: "course/course.db" }),
  Object.freeze({ name: "email", relative: "email/email.db" }),
]);

const REQUIRED_DATABASE_MANIFEST = [
  "format=fsk-required-databases-v1",
  ...DATABASES.map(({ name }) => `${name}.db`),
  "",
].join("\n");

function assertDirectory(target, description) {
  const resolved = path.resolve(target);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${description} must be a real directory: ${resolved}`);
  }
  const real = fs.realpathSync.native(resolved);
  if (real === path.parse(real).root) {
    throw new Error(`${description} cannot be the filesystem root`);
  }
  return real;
}

function resolveInside(root, relative, description) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative)) {
    throw new Error(`${description} is not a non-empty relative path`);
  }
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${description} escapes its root: ${relative}`);
  }
  return target;
}

function assertPathHasNoSymlink(root, target, description) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${description} escapes its root`);
  }
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`${description} contains a symbolic link: ${relative}`);
    }
  }
}

function assertRegularFile(root, target, description) {
  try {
    assertPathHasNoSymlink(root, target, description);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${description} is missing: ${target}`, { cause: error });
    }
    throw error;
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) throw new Error(`${description} is not a regular file`);
  return stat;
}

async function snapshotDatabase(sourceRoot, source, destination, service) {
  assertRegularFile(sourceRoot, source, `${service} database`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }

  const snapshot = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    if (service === "competition") validateCompetitionDatabase(snapshot);
    else validateSupportDatabase(snapshot, service);
  } finally {
    snapshot.close();
  }
}

function copyFileNoFollow(sourceRoot, source, destination, description, expectedSize = null) {
  assertRegularFile(sourceRoot, source, description);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
  let destinationFd;
  try {
    const before = fs.fstatSync(sourceFd);
    if (!before.isFile()) throw new Error(`${description} is not a regular file`);
    if (expectedSize !== null && before.size !== expectedSize) {
      throw new Error(`${description} size differs from database metadata`);
    }

    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0,
        Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) throw new Error(`${description} changed while being copied`);
      fs.writeSync(destinationFd, buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    fs.fsyncSync(destinationFd);

    const after = fs.fstatSync(sourceFd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`${description} changed while being copied`);
    }
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function copyReferencedUploads(databasePath, sourceRoot, destinationRoot) {
  const uploadRoot = assertDirectory(sourceRoot, "Competition upload root");
  fs.mkdirSync(destinationRoot, { recursive: true });
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = database.prepare(`
      SELECT f.id, f.stored_name, f.size, s.storage_dir
      FROM submission_file f
      JOIN submission s ON s.id = f.submission_id
      ORDER BY f.id
    `).all();
  } finally {
    database.close();
  }

  const copied = new Set();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.size) || row.size < 0) {
      throw new Error(`submission_file ${row.id} has an invalid size`);
    }
    if (typeof row.stored_name !== "string" || !row.stored_name ||
        path.basename(row.stored_name) !== row.stored_name) {
      throw new Error(`submission_file ${row.id} has an invalid stored name`);
    }
    const directory = resolveInside(uploadRoot, row.storage_dir,
      `submission_file ${row.id} storage directory`);
    const source = resolveInside(directory, row.stored_name,
      `submission_file ${row.id} stored name`);
    const relative = path.relative(uploadRoot, source);
    if (copied.has(relative)) continue;
    copyFileNoFollow(uploadRoot, source, path.join(destinationRoot, relative),
      `submission_file ${row.id}`, row.size);
    copied.add(relative);
  }
  return copied.size;
}

function sha256File(target) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(target, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function archiveDirectory(source, destination) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize().catch(reject);
  });
}

export async function createK3sBackup(sourceRootPath, outputPath) {
  const sourceRoot = assertDirectory(sourceRootPath, "FSK data root");
  const output = path.resolve(outputPath);
  const outputParent = path.dirname(output);
  fs.mkdirSync(outputParent, { recursive: true });
  if (fs.existsSync(output)) throw new Error(`backup output already exists: ${output}`);

  const staging = fs.mkdtempSync(path.join(outputParent, ".fsk-backup-stage-"));
  const partial = path.join(outputParent, `.${path.basename(output)}.partial-${process.pid}`);
  try {
    const databaseDir = path.join(staging, "db");
    for (const database of DATABASES) {
      await snapshotDatabase(sourceRoot, path.join(sourceRoot, database.relative),
        path.join(databaseDir, `${database.name}.db`), database.name);
    }
    fs.writeFileSync(path.join(databaseDir, "required-databases.txt"),
      REQUIRED_DATABASE_MANIFEST, { mode: 0o600 });

    const competitionSource = path.join(sourceRoot, "competition");
    const competitionTarget = path.join(staging, "competition");
    copyFileNoFollow(sourceRoot,
      path.join(competitionSource, "competition.db.migration.json"),
      path.join(competitionTarget, "competition.db.migration.json"), "migration report");
    copyFileNoFollow(sourceRoot, path.join(competitionSource, ".cutover-active"),
      path.join(competitionTarget, ".cutover-active"), "cutover marker");

    const uploadCount = copyReferencedUploads(path.join(databaseDir, "competition.db"),
      path.join(competitionSource, "uploads"), path.join(competitionTarget, "uploads"));
    const hashes = Object.fromEntries(DATABASES.map(({ name }) => [
      `${name}.db`, sha256File(path.join(databaseDir, `${name}.db`)),
    ]));
    fs.writeFileSync(path.join(staging, "backup.json"), `${JSON.stringify({
      format: "fsk-k3s-backup-v1",
      createdAt: new Date().toISOString(),
      databases: hashes,
      referencedUploads: uploadCount,
    }, null, 2)}\n`, { mode: 0o600 });

    await archiveDirectory(staging, partial);
    fs.linkSync(partial, output);
    fs.unlinkSync(partial);
    return { output, uploadCount, sha256: sha256File(output) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  if (process.argv.length !== 4) {
    console.error("usage: create-k3s-backup.mjs <fsk-data-root> <output.zip>");
    process.exitCode = 2;
  } else {
    try {
      const result = await createK3sBackup(process.argv[2], process.argv[3]);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(`FSK backup failed: ${error.message || error}`);
      process.exitCode = 1;
    }
  }
}
