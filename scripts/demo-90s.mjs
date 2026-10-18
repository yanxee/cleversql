#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CleverSQL } from "../src/cleversql.js";
import { seedDemoDatabase } from "../src/demo.js";

const pace = process.argv.includes("--pace");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleversql-90s-"));
const databasePath = path.join(root, "demo.db");
const stateDir = path.join(root, "state");
seedDemoDatabase(databasePath);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function act(number, title, narration) {
  process.stdout.write(
    `\n\x1b[38;2;200;255;98mACT ${number}\x1b[0m  \x1b[1m${title}\x1b[0m\n`,
  );
  process.stdout.write(`       ${narration}\n\n`);
}

function line(label, value) {
  process.stdout.write(`       ${label.padEnd(15)} ${value}\n`);
}

let workspace;
try {
  workspace = await CleverSQL.open({
    database: databasePath,
    stateDir,
    maxChanges: 5,
  });
  const dashboard = await workspace.dashboard();

  process.stdout.write(`
  \x1b[1mCleverSQL · 90-second launch story\x1b[0m
  One local control plane for human queries and governed agent changes.
`);

  act(
    1,
    "Read freely",
    "The agent discovers the schema and asks a real business question.",
  );
  line("Database", `${dashboard.database.name} · ${dashboard.database.driver}`);
  line("Schema", `${dashboard.stats.tables} tables · ${dashboard.stats.rows} rows`);
  const report = await workspace.query(`
    SELECT c.company, s.plan_code, s.mrr
    FROM customers c
    JOIN subscriptions s ON s.customer_id = c.id
    WHERE s.status = 'active'
    ORDER BY s.mrr DESC
    LIMIT 3
  `);
  for (const row of report.rows) {
    line("Active account", `${row.company} · ${row.plan_code} · $${row.mrr}`);
  }
  if (pace) await sleep(1500);

  act(
    2,
    "Preview the intent",
    "The agent asks to activate one customer. CleverSQL returns an exact diff before commit.",
  );
  const preview = await workspace.previewChange({
    action: "update",
    table: "customers",
    where: { id: 1 },
    values: { status: "active" },
    reason: "Activate the workspace after the annual invoice cleared",
  });
  line("Change", preview.id);
  line("Matched rows", preview.summary.matchedRows);
  line(
    "Diff",
    `${preview.diff[0].before.status} → ${preview.diff[0].after.status}`,
  );
  line("Committed", "no — preview is rolled back");
  if (pace) await sleep(1700);

  act(
    3,
    "A human changes the same row",
    "A support engineer pauses the account while the agent is still reviewing.",
  );
  const otherWriter = new DatabaseSync(databasePath);
  otherWriter
    .prepare("UPDATE customers SET status = 'paused' WHERE id = 1")
    .run();
  otherWriter.close();
  try {
    await workspace.applyChange(preview.id);
  } catch (error) {
    line("Apply result", `${error.code} · stale intent rejected`);
    line("Outcome", "the newer human edit was preserved");
  }
  if (pace) await sleep(1700);

  act(
    4,
    "Re-preview and apply",
    "The agent sees the new state, previews again, and commits against the latest row.",
  );
  const freshPreview = await workspace.previewChange({
    action: "update",
    table: "customers",
    where: { id: 1 },
    values: { status: "active" },
    reason: "Human review completed; apply the activation against the paused row",
  });
  const applied = await workspace.applyChange(freshPreview.id);
  line("Apply result", `${applied.status} · ${applied.id}`);
  line(
    "Diff",
    `${freshPreview.diff[0].before.status} → ${freshPreview.diff[0].after.status}`,
  );
  if (pace) await sleep(1700);

  act(
    5,
    "Undo with a receipt",
    "The change was wrong. CleverSQL restores the before-state and keeps the audit trail.",
  );
  const reverted = await workspace.revertChange(applied.id, {
    reason: "The activation was approved against the wrong account",
  });
  const finalRow = await workspace.query(
    "SELECT status FROM customers WHERE id = 1",
  );
  line("Revert result", reverted.status);
  line("Current state", finalRow.rows[0].status);
  line("Audit events", "previewed → applied → reverted");

  process.stdout.write(`
  \x1b[38;2;200;255;98mDemo complete.\x1b[0m
  The agent could read at full speed, but every write had a reviewable diff,
  a conflict boundary, an actor, a reason, and a rollback path.
`);
} finally {
  await workspace?.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
