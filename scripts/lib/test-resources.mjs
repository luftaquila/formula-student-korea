import { readFileSync } from "node:fs";

export function assertTestResourceLimits({ memory, swap, tasks }) {
  const finiteLimit = (value, max) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= max;
  if (!finiteLimit(memory, 1024 ** 3) || swap !== "0" || !finiteLimit(tasks, 256)) {
    throw new Error("a cgroup with memory <= 1 GiB, swap disabled and tasks <= 256 is required");
  }
}

export function assertTestCgroup() {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  if (!cgroup) throw new Error("cgroup v2 is required");
  const read = (name) => readFileSync(`/sys/fs/cgroup${cgroup}/${name}`, "utf8").trim();
  assertTestResourceLimits({ memory: read("memory.max"), swap: read("memory.swap.max"), tasks: read("pids.max") });
}
