#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { validateSupportDatabase } from "../lib/support-database-validation.mjs";

export function validateSupportDatabaseFile(service, databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return validateSupportDatabase(db, service);
  } finally {
    db.close();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  if (process.argv.length !== 4) {
    console.error("usage: validate-support-database.mjs <auth|calendar|course|email> <database.db>");
    process.exitCode = 2;
  } else {
    try {
      validateSupportDatabaseFile(process.argv[2], process.argv[3]);
      console.log(`${process.argv[2]} database validation passed.`);
    } catch (error) {
      console.error(`${process.argv[2]} database validation failed: ${error.message || error}`);
      process.exitCode = 1;
    }
  }
}
