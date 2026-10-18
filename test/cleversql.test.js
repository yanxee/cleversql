import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { CleverSQL } from "../src/cleversql.js";
import { seedDemoDatabase } from "../src/demo.js";
import { createMcpBridge } from "../src/mcp.js";
import { startServer } from "../src/server.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cleversql-test-"));
}

describe("governed SQLite workspace", () => {
  let root;
  let databasePath;
  let workspace;

  before(async () => {
    root = makeTempDir();
    databasePath = path.join(root, "demo.db");
    seedDemoDatabase(databasePath);
    workspace = await CleverSQL.open({
      database: databasePath,
      stateDir: path.join(root, "state"),
      maxRows: 200,
      maxChanges: 5,
    });
  });

  after(async () => {
    await workspace?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("discovers the demo schema and row counts", async () => {
    const dashboard = await workspace.dashboard();
    assert.equal(dashboard.database.driver, "sqlite");
    assert.equal(dashboard.stats.tables, 5);
    assert.ok(dashboard.stats.rows > 250);
    assert.ok(dashboard.tables.some((table) => table.name === "customers"));
    assert.deepEqual((await workspace.table("customers")).primaryKey, ["id"]);
  });

  test("read surface accepts CTEs but blocks write SQL", async () => {
    const result = await workspace.query(
      "WITH active AS (SELECT * FROM subscriptions WHERE status = 'active') SELECT count(*) AS n FROM active",
    );
    assert.ok(result.rows[0].n > 0);
    await assert.rejects(
      () => workspace.query("DELETE FROM customers"),
      (error) => error.code === "WRITE_SQL_BLOCKED",
    );
    await assert.rejects(
      () => workspace.query("SELECT load_extension('x')"),
      /not authorized|unable to open|load/i,
    );
    await assert.rejects(
      () => workspace.query("SELECT 1; SELECT 2;"),
      (error) => error.code === "MULTIPLE_STATEMENTS_BLOCKED",
    );
  });

  test("preview runs in a rolled-back transaction", async () => {
    const before = (
      await workspace.query("SELECT id, status FROM customers WHERE id = 2")
    ).rows[0];
    const plan = await workspace.previewChange({
      action: "update",
      table: "customers",
      where: { id: 2 },
      values: { status: "paused" },
      reason: "Pause the account after a billing review",
    });
    const after = (
      await workspace.query("SELECT id, status FROM customers WHERE id = 2")
    ).rows[0];

    assert.equal(plan.status, "preview");
    assert.equal(plan.diff.length, 1);
    assert.equal(before.status, after.status);
    assert.equal(workspace.getChange(plan.id).status, "preview");
  });

  test("apply commits the reviewed diff and revert restores it", async () => {
    const original = (
      await workspace.query("SELECT id, status FROM customers WHERE id = 3")
    ).rows[0];
    const preview = await workspace.previewChange({
      action: "update",
      table: "customers",
      where: { id: 3 },
      values: { status: "paused" },
      reason: "Temporarily pause the workspace during review",
    });
    const applied = await workspace.applyChange(preview.id);
    const changed = (
      await workspace.query("SELECT id, status FROM customers WHERE id = 3")
    ).rows[0];
    assert.equal(applied.status, "applied");
    assert.notEqual(changed.status, original.status);

    const reverted = await workspace.revertChange(applied.id, {
      reason: "The review was cancelled",
    });
    const restored = (
      await workspace.query("SELECT id, status FROM customers WHERE id = 3")
    ).rows[0];
    assert.equal(reverted.status, "reverted");
    assert.equal(restored.status, original.status);
  });

  test("apply fails closed when the matched row drifts", async () => {
    const preview = await workspace.previewChange({
      action: "update",
      table: "customers",
      where: { id: 4 },
      values: { status: "trial" },
      reason: "Reset the account to a trial after a support request",
    });

    const external = new DatabaseSync(databasePath);
    external
      .prepare("UPDATE customers SET status = 'churned' WHERE id = ?")
      .run(4);
    external.close();

    await assert.rejects(
      () => workspace.applyChange(preview.id),
      (error) => error.code === "STALE_CHANGE" && error.status === 409,
    );
    const current = (
      await workspace.query("SELECT status FROM customers WHERE id = 4")
    ).rows[0];
    assert.equal(current.status, "churned");
  });

  test("delete preview can be applied and reverted", async () => {
    const before = (
      await workspace.query(
        "SELECT * FROM activity_events ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
    const preview = await workspace.previewChange({
      action: "delete",
      table: "activity_events",
      where: { id: before.id },
      reason: "Remove a duplicate activity event",
    });
    assert.equal(preview.diff[0].kind, "delete");
    await workspace.applyChange(preview.id);
    assert.equal(
      (
        await workspace.query(
          "SELECT count(*) AS n FROM activity_events WHERE id = ?",
          { params: [before.id] },
        )
      ).rows[0].n,
      0,
    );
    await workspace.revertChange(preview.id, {
      reason: "Restore the removed event",
    });
    const restored = (
      await workspace.query("SELECT * FROM activity_events WHERE id = ?", {
        params: [before.id],
      })
    ).rows[0];
    assert.equal(restored.detail, before.detail);
  });

  test("insert preview can be applied and reverted", async () => {
    const preview = await workspace.previewChange({
      action: "insert",
      table: "activity_events",
      values: {
        customer_id: 1,
        kind: "change_preview",
        detail: "Created by the governed integration test",
        created_at: "2026-10-17T12:00:00.000Z",
      },
      reason: "Add a test event for the governed write workflow",
    });
    assert.equal(preview.diff[0].kind, "insert");
    const applied = await workspace.applyChange(preview.id);
    const insertedId = applied.after[0].id;
    assert.ok(insertedId);
    await workspace.revertChange(preview.id, {
      reason: "Clean up the integration test",
    });
    assert.equal(
      (
        await workspace.query(
          "SELECT count(*) AS n FROM activity_events WHERE id = ?",
          { params: [insertedId] },
        )
      ).rows[0].n,
      0,
    );
  });

  test("unbounded writes and writes to keyless tables are rejected", async () => {
    await assert.rejects(
      () =>
        workspace.previewChange({
          action: "delete",
          table: "customers",
          reason: "This should never be accepted",
        }),
      (error) => error.code === "UNBOUNDED_WRITE_BLOCKED",
    );
  });

  test("reverts deletes on tables with generated columns", async () => {
    const external = new DatabaseSync(databasePath);
    external.exec(`
      CREATE TABLE computed_notes (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        upper_body TEXT GENERATED ALWAYS AS (upper(body)) STORED
      );
      INSERT INTO computed_notes (id, body) VALUES (1, 'hello');
    `);
    external.close();

    const preview = await workspace.previewChange({
      action: "delete",
      table: "computed_notes",
      where: { id: 1 },
      reason: "Verify generated-column rollback",
    });
    await workspace.applyChange(preview.id);
    await workspace.revertChange(preview.id, {
      reason: "Restore the computed row",
    });
    const restored = await workspace.query(
      "SELECT body, upper_body FROM computed_notes WHERE id = 1",
    );
    assert.deepEqual(restored.rows[0], {
      body: "hello",
      upper_body: "HELLO",
    });
  });
});

describe("read-only workspace", () => {
  test("blocks previews while preserving queries", async () => {
    const root = makeTempDir();
    const databasePath = path.join(root, "demo.db");
    seedDemoDatabase(databasePath);
    const workspace = await CleverSQL.open({
      database: databasePath,
      stateDir: path.join(root, "state"),
      readOnly: true,
    });
    try {
      assert.equal((await workspace.dashboard()).safety.readOnly, true);
      assert.ok(
        (await workspace.query("SELECT count(*) AS n FROM customers")).rows[0]
          .n > 0,
      );
      await assert.rejects(
        () =>
          workspace.previewChange({
            action: "update",
            table: "customers",
            where: { id: 1 },
            values: { status: "active" },
            reason: "Read-only test change",
          }),
        (error) => error.code === "DATABASE_READ_ONLY",
      );
    } finally {
      await workspace.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MCP bridge", () => {
  let root;
  let workspace;
  let bridge;

  before(async () => {
    root = makeTempDir();
    const databasePath = path.join(root, "demo.db");
    seedDemoDatabase(databasePath);
    workspace = await CleverSQL.open({
      database: databasePath,
      stateDir: path.join(root, "state"),
    });
    bridge = createMcpBridge(workspace);
  });

  after(async () => {
    await workspace?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("initializes and lists guarded tools", async () => {
    const initialized = await bridge.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-client", version: "1.0.0" },
        capabilities: {},
      },
    });
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    assert.equal(initialized.result.serverInfo.name, "cleversql");

    const listed = await bridge.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(listed.result.tools.length, 8);
    assert.ok(
      listed.result.tools.some(
        (tool) => tool.name === "cleversql_preview_change",
      ),
    );
  });

  test("calls read-only SQL through tools/call", async () => {
    const response = await bridge.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "cleversql_query",
        arguments: {
          sql: "SELECT count(*) AS n FROM customers",
          maxRows: 10,
        },
      },
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.rows[0].n, 48);
  });

  test("returns a tool-level error for raw write SQL", async () => {
    const response = await bridge.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "cleversql_query",
        arguments: { sql: "UPDATE customers SET status = 'active'" },
      },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /WRITE_SQL_BLOCKED/);
  });
});

describe("HTTP server", () => {
  let root;
  let workspace;
  let running;
  let base;
  const token = "test-token";

  before(async () => {
    root = makeTempDir();
    const databasePath = path.join(root, "demo.db");
    seedDemoDatabase(databasePath);
    workspace = await CleverSQL.open({
      database: databasePath,
      stateDir: path.join(root, "state"),
    });
    running = await startServer({
      cleversql: workspace,
      port: 0,
      host: "127.0.0.1",
      token,
    });
    base = running.url;
  });

  after(async () => {
    await running?.close();
    await workspace?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("requires auth on API routes and serves the console", async () => {
    const unauthorized = await fetch(`${base}/api/dashboard`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${base}/api/dashboard`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.equal(payload.product, "CleverSQL");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Query freely/);
  });

  test("supports MCP initialize over streamable HTTP", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "http-test", version: "1.0.0" },
          capabilities: {},
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.serverInfo.name, "cleversql");
  });

  test("returns copy-ready client configurations", async () => {
    const response = await fetch(`${base}/api/connect`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    const codex = payload.clients.find((client) => client.id === "codex");
    assert.match(codex.command, /codex mcp add cleversql --url/);
    assert.match(codex.config, /\[mcp_servers\.cleversql\]/);
    assert.ok(
      payload.clients.some((client) => client.id === "vscode"),
    );
  });

  test("blocks cross-origin mutations", async () => {
    const response = await fetch(`${base}/api/changes/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
  });
});
