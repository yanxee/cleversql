#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 10)) {
  process.stderr.write(
    `CleverSQL requires Node.js 24.10 or newer. Current version: ${process.versions.node}.\n`,
  );
  process.exit(1);
}

// node:sqlite still emits an experimental warning on Node 22-24. Keep product
// output focused without hiding warnings from other modules.
const nativeEmitWarning = process.emitWarning;
process.emitWarning = function filteredWarning(warning, ...args) {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return nativeEmitWarning.call(process, warning, ...args);
};

const { CleverSQL } = await import("../src/cleversql.js");
const { seedDemoDatabase } = await import("../src/demo.js");
const { startServer } = await import("../src/server.js");
const { isPostgresTarget } = await import("../src/database.js");

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function printHelp() {
  process.stdout.write(`
CleverSQL ${packageJson.version}
The agent-safe data workspace.

USAGE
  cleversql demo [options]
  cleversql <database.sqlite> [options]
  cleversql <postgresql://...> [options]

OPTIONS
  --port <number>        HTTP port (default: 4310)
  --host <address>       Bind address (default: 127.0.0.1)
  --state <directory>    Change snapshots and audit log location
  --read-only            Disable the governed write surface
  --schemas <list>       PostgreSQL schemas (default: public; use all)
  --query-timeout-ms <n> Database query timeout (default: 15000)
  --max-rows <number>    Query result cap (default: 500)
  --max-changes <number> Rows allowed per change (default: 25, max: 100)
  --ssl                  Force SSL for PostgreSQL
  --no-ssl               Disable SSL for PostgreSQL
  --token [secret]       Require a bearer token; generates one if omitted
  --open                 Open the console in a browser
  --no-open              Do not open a browser
  --reset                Recreate the demo database
  --help                 Show this help
  --version              Print the version

EXAMPLES
  npx cleversql demo
  npx cleversql ./app.db --read-only
  npx cleversql "$DATABASE_URL" --schemas public
  npx cleversql "$SUPABASE_DB_URL" --schemas public,private
  npx cleversql ./app.db --host 0.0.0.0 --token

MCP
  Point your agent at http://127.0.0.1:4310/mcp.
  Writes use preview -> apply -> revert. Raw write SQL is blocked.
`);
}

function parseArgs(argv) {
  const options = {
    command: null,
    database: null,
    port: 4310,
    host: "127.0.0.1",
    state: null,
    readOnly: false,
    schemas: "public",
    queryTimeoutMs: 15000,
    maxRows: 500,
    maxChanges: 25,
    ssl: null,
    token: null,
    open: null,
    reset: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${packageJson.version}\n`);
      process.exit(0);
    }
    if (arg === "--read-only") {
      options.readOnly = true;
      continue;
    }
    if (arg === "--ssl") {
      options.ssl = true;
      continue;
    }
    if (arg === "--no-ssl") {
      options.ssl = false;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--reset") {
      options.reset = true;
      continue;
    }
    if (arg === "--token") {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        options.token = next;
        index += 1;
      } else {
        options.token = randomBytes(24).toString("base64url");
      }
      continue;
    }

    const valueOptions = {
      "--port": "port",
      "--host": "host",
      "--state": "state",
      "--schemas": "schemas",
      "--query-timeout-ms": "queryTimeoutMs",
      "--max-rows": "maxRows",
      "--max-changes": "maxChanges",
    };
    if (valueOptions[arg]) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[valueOptions[arg]] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  options.port = Number.parseInt(options.port, 10);
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  for (const key of ["maxRows", "maxChanges"]) {
    const value = Number.parseInt(options[key], 10);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${key === "maxRows" ? "max-rows" : "max-changes"} must be a positive integer.`);
    }
    options[key] = value;
  }
  options.queryTimeoutMs = Number.parseInt(options.queryTimeoutMs, 10);
  if (
    !Number.isInteger(options.queryTimeoutMs) ||
    options.queryTimeoutMs < 100 ||
    options.queryTimeoutMs > 300_000
  ) {
    throw new Error("--query-timeout-ms must be between 100 and 300000.");
  }

  const demoIndex = positionals.findIndex((item) => item === "demo");
  if (demoIndex >= 0) {
    options.command = "demo";
    positionals.splice(demoIndex, 1);
  }
  options.database = positionals[0] ?? null;
  return options;
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function isLoopback(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

function postgresStateName(target) {
  try {
    const url = new URL(target);
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "database";
    return `${url.hostname}-${database}`
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .slice(0, 80);
  } catch {
    return "postgres";
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`CleverSQL: ${error.message}\n\n`);
    printHelp();
    process.exit(1);
  }

  if (!options.command && !options.database) {
    printHelp();
    process.exit(0);
  }

  if (!isLoopback(options.host) && !options.token) {
    process.stderr.write(
      "CleverSQL: non-loopback binding requires --token <secret> or --token to generate one.\n",
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  let databaseTarget;
  if (options.command === "demo") {
    databaseTarget = path.resolve(cwd, ".cleversql", "demo.db");
    const seeded = seedDemoDatabase(databaseTarget, { reset: options.reset });
    if (seeded.created) {
      process.stdout.write("Created a deterministic demo database.\n");
    }
  } else if (isPostgresTarget(options.database)) {
    databaseTarget = options.database;
  } else {
    databaseTarget = path.resolve(cwd, options.database);
  }

  const stateDir =
    options.state
      ? path.resolve(cwd, options.state)
      : options.command === "demo"
        ? path.resolve(cwd, ".cleversql")
        : isPostgresTarget(databaseTarget)
          ? path.resolve(
              cwd,
              ".cleversql",
              postgresStateName(databaseTarget),
            )
          : path.resolve(path.dirname(databaseTarget), ".cleversql");

  let workspace;
  let server;
  try {
    workspace = await CleverSQL.open({
      database: databaseTarget,
      stateDir,
      readOnly: options.readOnly,
      schemas:
        options.schemas === "all"
          ? ["all"]
          : String(options.schemas)
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
      queryTimeoutMs: options.queryTimeoutMs,
      ssl: options.ssl,
      maxRows: options.maxRows,
      maxChanges: options.maxChanges,
      version: packageJson.version,
    });
    server = await startServer({
      cleversql: workspace,
      host: options.host,
      port: options.port,
      token: options.token,
      version: packageJson.version,
    });
  } catch (error) {
    await workspace?.close().catch(() => {});
    process.stderr.write(`CleverSQL: ${error.message}\n`);
    process.exit(1);
  }

  const dashboard = await workspace.dashboard();
  const shouldOpen = options.open ?? options.command === "demo";
  const schemaLine =
    workspace.driver === "postgres"
      ? `  Schemas   ${dashboard.database.schemas.join(", ")}\n`
      : "";
  process.stdout.write(`
  CleverSQL ${packageJson.version}
  ${dashboard.tagline}

  Console   ${server.url}
  MCP       ${server.url}/mcp
  Database  ${workspace.databaseLabel} · ${workspace.driver === "postgres" ? "PostgreSQL" : "SQLite"}
${schemaLine}  Mode      ${workspace.readOnly ? "read-only" : "preview → apply → revert"}
  Limits    ${workspace.maxRows} query rows · ${workspace.maxChanges} rows/change
  State     ${stateDir}
${options.token ? `  Token     ${options.token}\n` : ""}
  Press Ctrl+C to stop.
`);

  if (shouldOpen) openBrowser(server.url);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close().catch(() => {});
    await workspace.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
