import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertTestCgroup } from "./lib/test-resources.mjs";

const args = process.argv.slice(2);
const inside = args[0] === "--inside-cgroup";
if (inside) args.shift();
if (!args.length) {
  console.error("Usage: node scripts/test.mjs [Node test options] tests/path.test.mjs");
  process.exit(1);
}
let result;
if (inside) {
  try {
    assertTestCgroup();
  } catch (error) {
    console.error(`Tests refused: ${error.message}`);
    process.exit(1);
  }
  result = spawnSync(process.execPath, ["--max-old-space-size=256", "--test", "--test-concurrency=2", ...args], {
    stdio: "inherit",
    env: { ...process.env, TZ: "Asia/Seoul", NODE_OPTIONS: "--max-old-space-size=256" },
  });
} else {
  // A scope preserves cwd/environment and accounts for every descendant, including
  // native allocations and subprocesses that a V8 heap limit cannot contain.
  result = spawnSync("systemd-run", [
    "--user", "--scope", "--quiet",
    "-p", "MemoryMax=1G", "-p", "MemorySwapMax=0", "-p", "TasksMax=256",
    "-p", "RuntimeMaxSec=10min", "-p", "TimeoutStopSec=5s",
    process.execPath, fileURLToPath(import.meta.url), "--inside-cgroup", ...args,
  ], { stdio: "inherit" });
}
if (result.error) console.error(`Test runner failed: ${result.error.message}`);
if (result.signal) console.error(`Test runner terminated by ${result.signal}`);
process.exit(result.status ?? 1);
