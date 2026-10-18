import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { after, before, describe, test } from "node:test";
import { CleverSQL } from "../src/cleversql.js";

const { Client } = pg;
const dsn = process.env.CLEVERSQL_TEST_POSTGRES_URL;
const postgresDescribe = dsn ? describe : describe.skip;

postgresDescribe("PostgreSQL integration", () => {
  const schema = `cleversql_it_${randomBytes(4).toString("hex")}`;
  const quotedSchema = `"${schema}"`;
  let root;
  let admin;
  let workspace;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cleversql-pg-test-"));
    admin = new Client({ connectionString: dsn });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    await admin.query(`
      CREATE TABLE ${quotedSchema}.customers (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL,
        status text NOT NULL,
        mrr integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${quotedSchema}.notes (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        body text NOT NULL,
        body_upper text GENERATED ALWAYS AS (upper(body)) STORED
      );
      INSERT INTO ${quotedSchema}.customers (name, status, mrr)
      VALUES ('Maya Chen', 'active', 900),
             ('Jonas Weber', 'trial', 300);
      INSERT INTO ${quotedSchema}.notes (body) VALUES ('Identity restore test');
    `);
    workspace = await CleverSQL.open({
      database: dsn,
      stateDir: path.join(root, "state"),
      schemas: [schema],
      maxChanges: 5,
    });
  });

  after(async () => {
    await workspace?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await admin?.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("discovers schema, keys, and read-only query results", async () => {
    const dashboard = await workspace.dashboard();
    assert.equal(dashboard.database.driver, "postgres");
    assert.doesNotMatch(JSON.stringify(dashboard.database), /password/i);
    assert.equal(dashboard.stats.tables, 2);
    assert.ok(dashboard.stats.rows >= 3);

    const table = await workspace.table(`${schema}.customers`);
    assert.deepEqual(table.primaryKey, ["id"]);
    assert.equal(table.mutable, true);

    const result = await workspace.query(
      `SELECT name, mrr FROM ${quotedSchema}.customers ORDER BY mrr DESC`,
    );
    assert.equal(result.rows[0].name, "Maya Chen");
  });

  test("previews, applies, and reverts a row change", async () => {
    const preview = await workspace.previewChange({
      action: "update",
      table: `${schema}.customers`,
      where: { id: 2 },
      values: { status: "active" },
      reason: "Activate after payment cleared",
    });
    assert.equal(preview.diff[0].changed[0], "status");

    const unchanged = await workspace.query(
      `SELECT status FROM ${quotedSchema}.customers WHERE id = 2`,
    );
    assert.equal(unchanged.rows[0].status, "trial");

    await workspace.applyChange(preview.id);
    const applied = await workspace.query(
      `SELECT status FROM ${quotedSchema}.customers WHERE id = 2`,
    );
    assert.equal(applied.rows[0].status, "active");

    await workspace.revertChange(preview.id, {
      reason: "Integration-test cleanup",
    });
    const reverted = await workspace.query(
      `SELECT status FROM ${quotedSchema}.customers WHERE id = 2`,
    );
    assert.equal(reverted.rows[0].status, "trial");
  });

  test("rejects stale PostgreSQL previews", async () => {
    const preview = await workspace.previewChange({
      action: "update",
      table: `${schema}.customers`,
      where: { id: 1 },
      values: { mrr: 1100 },
      reason: "Increase MRR after a plan change",
    });
    await admin.query(
      `UPDATE ${quotedSchema}.customers SET mrr = 1000 WHERE id = 1`,
    );
    await assert.rejects(
      () => workspace.applyChange(preview.id),
      (error) => error.code === "STALE_CHANGE",
    );
  });

  test("restores a deleted GENERATED ALWAYS identity row", async () => {
    const existing = await workspace.query(
      `SELECT * FROM ${quotedSchema}.notes ORDER BY id LIMIT 1`,
    );
    const note = existing.rows[0];
    const preview = await workspace.previewChange({
      action: "delete",
      table: `${schema}.notes`,
      where: { id: note.id },
      reason: "Verify identity-safe rollback",
    });
    await workspace.applyChange(preview.id);
    await workspace.revertChange(preview.id, {
      reason: "Restore the deleted identity row",
    });
    const restored = await workspace.query(
      `SELECT body, body_upper FROM ${quotedSchema}.notes WHERE id = $1`,
      { params: [note.id] },
    );
    assert.equal(restored.rows[0].body, note.body);
    assert.equal(restored.rows[0].body_upper, note.body.toUpperCase());
  });
});
