#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { validateCompetitionDatabase } from "../lib/database-validation.mjs";

export function validateCompetitionDatabaseFile(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return validateCompetitionDatabase(db);
  } finally {
    db.close();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  if (process.argv.length !== 3) {
    console.error("usage: validate-database.mjs <competition.db>");
    process.exitCode = 2;
  } else {
    try {
      validateCompetitionDatabaseFile(process.argv[2]);
      console.log("Competition database validation passed.");
    } catch (error) {
      console.error(`Competition database validation failed: ${error.message || error}`);
      process.exitCode = 1;
    }
  }
}
