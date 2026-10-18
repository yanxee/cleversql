#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = [
  process.env.CLEVERSQL_HOME,
  process.cwd(),
  path.resolve(process.cwd(), "cleversql-next"),
  path.resolve(process.cwd(), "..", "cleversql-next"),
  path.join(os.homedir(), "cleversql"),
  path.join(os.homedir(), "projects", "CleverSQL", "cleversql-next"),
  "F:\\Codex\\projects\\CleverSQL\\cleversql-next",
].filter(Boolean);

const home = candidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "bin", "cleversql.js")),
);

if (!home) {
  console.error(
    [
      "CleverSQL checkout not found.",
      "Set CLEVERSQL_HOME to the folder containing bin/cleversql.js.",
      "Example: CLEVERSQL_HOME=F:\\Codex\\projects\\CleverSQL\\cleversql-next",
    ].join("\n"),
  );
  process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 10)) {
  console.error(
    `CleverSQL requires Node.js 24.10 or newer. Current version: ${process.versions.node}.`,
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [path.join(home, "bin", "cleversql.js"), ...process.argv.slice(2)],
  {
    cwd: home,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Unable to start CleverSQL: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
