import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import {
  CleverSQLError,
  assertReadOnlySql,
  assertSingleStatement,
  getFirstKeyword,
  isPlainObject,
  jsonSafe,
  quoteIdent,
} from "./utils.js";

const { Pool } = pg;

const FILTER_OPS = new Set([
  "eq",
  "neq",
  "in",
  "like",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "not_null",
]);

function postgresError(error) {
  if (error instanceof CleverSQLError) return error;
  const message = String(error?.message ?? error);
  let status = 400;
  let code = "DATABASE_ERROR";

  if (error?.code === "42501" || /permission denied|read-only transaction/i.test(message)) {
    status = 403;
    code = "DATABASE_PERMISSION_DENIED";
  } else if (
    ["23505", "23503", "23502", "23514"].includes(error?.code) ||
    /constraint/i.test(message)
  ) {
    status = 409;
    code = "CONSTRAINT_VIOLATION";
  } else if (["42P01", "42703"].includes(error?.code)) {
    status = 404;
    code = "OBJECT_NOT_FOUND";
  } else if (error?.code === "40001") {
    status = 409;
    code = "SERIALIZATION_FAILURE";
  } else if (error?.code === "57014") {
    status = 408;
    code = "QUERY_TIMEOUT";
  } else if (["42601", "42P02", "22P02"].includes(error?.code)) {
    status = 400;
    code = "SQL_SYNTAX_ERROR";
  }

  return new CleverSQLError(message, { status, code });
}

function columnLookup(columns) {
  return new Map(columns.map((column) => [column.name.toLowerCase(), column]));
}

function qualifiedTable(table) {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.tableName)}`;
}

function stripTrailingSemicolon(sql) {
  return sql.trim().replace(/;+\s*$/, "");
}

function parseSchemas(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return parts.length ? parts : ["public"];
  }
  return ["public"];
}

function sslFromDsn(connectionString, requestedSsl) {
  if (requestedSsl === false) return false;
  if (requestedSsl === true) return { rejectUnauthorized: false };
  if (requestedSsl && typeof requestedSsl === "object") return requestedSsl;

  let mode = process.env.PGSSLMODE ?? "";
  try {
    mode =
      new URL(connectionString).searchParams.get("sslmode") ??
      mode;
  } catch {
    // Let pg report malformed connection strings.
  }
  if (["verify-full", "verify-ca"].includes(mode)) {
    return { rejectUnauthorized: true };
  }
  if (["require", "prefer"].includes(mode)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function redactedDsn(connectionString) {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "postgresql://[redacted]";
  }
}

function formatColumnType(row) {
  if (row.data_type === "ARRAY") {
    return `${String(row.udt_name ?? "").replace(/^_/, "")}[]`;
  }
  if (row.data_type === "USER-DEFINED") return row.udt_name ?? "USER-DEFINED";
  if (row.character_maximum_length != null) {
    return `${row.data_type}(${row.character_maximum_length})`;
  }
  if (row.numeric_precision != null && row.numeric_scale != null) {
    return `${row.data_type}(${row.numeric_precision},${row.numeric_scale})`;
  }
  return row.data_type ?? "ANY";
}

export class PostgresAdapter {
  constructor(
    dsn,
    {
      readOnly = false,
      schemas = ["public"],
      queryTimeoutMs = 15_000,
      ssl = null,
    } = {},
  ) {
    this.dsn = dsn;
    this.readOnlyMode = readOnly;
    this.schemas = parseSchemas(schemas);
    this.allSchemas = this.schemas.includes("all");
    this.queryTimeoutMs = queryTimeoutMs;
    this.transactionContext = new AsyncLocalStorage();
    this.objectCache = null;
    this.objectCacheAt = 0;
    this._metadata = null;

    const base = {
      connectionString: dsn,
      application_name: "cleversql",
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      ssl: sslFromDsn(dsn, ssl),
    };
    this.readPool = new Pool({ ...base, max: 3, application_name: "cleversql-read" });
    this.readPool.on("error", () => {});
    this.writePool = null;
    if (!readOnly) {
      this.writePool = new Pool({
        ...base,
        max: 2,
        application_name: "cleversql-write",
      });
      this.writePool.on("error", () => {});
    }
  }

  static async open(dsn, options = {}) {
    const adapter = new PostgresAdapter(dsn, options);
    try {
      await adapter.readPool.query("SELECT 1 AS ok");
      return adapter;
    } catch (error) {
      await adapter.close();
      throw postgresError(error);
    }
  }

  get driver() {
    return "postgres";
  }

  get canWrite() {
    return this.writePool !== null;
  }

  get connectionLabel() {
    return redactedDsn(this.dsn);
  }

  async metadata() {
    if (this._metadata) return this._metadata;
    const result = await this.readPool.query(`
      SELECT
        current_database() AS database_name,
        current_user AS current_user,
        pg_database_size(current_database())::bigint AS size_bytes,
        current_setting('server_version') AS server_version
    `);
    const row = result.rows[0];
    this._metadata = {
      driver: "postgres",
      name: row.database_name,
      label: row.database_name,
      path: null,
      sizeBytes: Number(row.size_bytes ?? 0),
      host: redactedDsn(this.dsn),
      user: row.current_user,
      serverVersion: row.server_version,
      schemas: this.allSchemas ? ["all"] : this.schemas,
    };
    return this._metadata;
  }

  async close() {
    await Promise.all([
      this.readPool.end().catch(() => {}),
      this.writePool?.end().catch(() => {}),
    ]);
  }

  activeClient({ write = false } = {}) {
    const transaction = this.transactionContext.getStore();
    if (transaction?.client) return transaction.client;
    return write ? this.writePool : this.readPool;
  }

  async listObjects() {
    if (this.objectCache && Date.now() - this.objectCacheAt < 2_000) {
      return this.objectCache;
    }

    const params = [];
    let schemaClause = "";
    if (!this.allSchemas) {
      params.push(this.schemas);
      schemaClause = "AND table_schema = ANY($1::text[])";
    } else {
      schemaClause =
        "AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'";
    }

    const result = await this.readPool.query(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_type IN ('BASE TABLE', 'VIEW')
       ${schemaClause}
       ORDER BY table_schema, table_name`,
      params,
    );

    this.objectCache = result.rows.map((row) => ({
      name: `${row.table_schema}.${row.table_name}`,
      schema: row.table_schema,
      tableName: row.table_name,
      type: row.table_type === "VIEW" ? "view" : "table",
      sql: null,
    }));
    this.objectCacheAt = Date.now();
    return this.objectCache;
  }

  async resolveObject(name) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new CleverSQLError("Table name is required.");
    }
    const requested = name.trim();
    const objects = await this.listObjects();
    const exact = objects.find((item) => item.name === requested);
    if (exact) return exact;

    const lowered = requested.toLowerCase();
    const lowerMatch = objects.find((item) => item.name.toLowerCase() === lowered);
    if (lowerMatch) return lowerMatch;

    if (!requested.includes(".")) {
      const bareMatches = objects.filter(
        (item) => item.tableName.toLowerCase() === lowered,
      );
      if (bareMatches.length === 1) return bareMatches[0];
      const publicMatch = bareMatches.find((item) => item.schema === "public");
      if (publicMatch) return publicMatch;
    }

    throw new CleverSQLError(`Table or view not found: ${requested}`, {
      status: 404,
      code: "OBJECT_NOT_FOUND",
    });
  }

  async inspectObject(
    name,
    { includeRows = false, includeIndexes = false } = {},
  ) {
    const object = await this.resolveObject(name);
    const columnResult = await this.readPool.query(
      `SELECT
         column_name,
         data_type,
         udt_name,
         is_nullable,
         column_default,
         ordinal_position,
         character_maximum_length,
         numeric_precision,
         numeric_scale,
         is_identity,
         identity_generation,
         is_generated
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [object.schema, object.tableName],
    );

    const keyResult = await this.readPool.query(
      `SELECT kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1
         AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [object.schema, object.tableName],
    );
    const primaryKey = keyResult.rows.map((row) => row.column_name);

    const columns = columnResult.rows.map((row) => ({
      name: row.column_name,
      type: formatColumnType(row),
      notNull: row.is_nullable === "NO" || primaryKey.includes(row.column_name),
      defaultValue: row.column_default ?? null,
      primaryKeyPosition:
        primaryKey.indexOf(row.column_name) >= 0
          ? primaryKey.indexOf(row.column_name) + 1
          : 0,
      generated: row.is_generated === "ALWAYS" && row.is_identity !== "YES",
      identity: row.is_identity === "YES",
      identityGeneration: row.identity_generation ?? null,
    }));

    const foreignKeyResult = await this.readPool.query(
      `SELECT
         kcu.column_name,
         ccu.table_schema AS references_schema,
         ccu.table_name AS references_table,
         ccu.column_name AS references_column,
         rc.update_rule,
         rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [object.schema, object.tableName],
    );

    let rowCount = null;
    if (includeRows) {
      const countResult = await this.readPool.query(
        `SELECT COUNT(*)::bigint AS count FROM ${qualifiedTable(object)}`,
      );
      rowCount = Number(countResult.rows[0].count);
    }

    let indexes = [];
    if (includeIndexes) {
      const indexResult = await this.readPool.query(
        `SELECT
           idx.relname AS index_name,
           ix.indisunique AS is_unique,
           pg_get_indexdef(ix.indexrelid) AS definition
         FROM pg_class tbl
         JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
         JOIN pg_index ix ON ix.indrelid = tbl.oid
         JOIN pg_class idx ON idx.oid = ix.indexrelid
         WHERE ns.nspname = $1 AND tbl.relname = $2
         ORDER BY idx.relname`,
        [object.schema, object.tableName],
      );
      indexes = indexResult.rows.map((row) => {
        const match = String(row.definition).match(/\(([^)]+)\)/);
        return {
          name: row.index_name,
          unique: Boolean(row.is_unique),
          columns: match
            ? match[1].split(",").map((column) => column.trim().split(" ")[0])
            : [],
          definition: row.definition,
        };
      });
    }

    const pkColumn = columns.find((column) => column.name === primaryKey[0]);
    const autoIncrement =
      primaryKey.length === 1 &&
      Boolean(
        pkColumn?.identity ||
          String(pkColumn?.defaultValue ?? "").includes("nextval("),
      );

    return {
      ...object,
      columns,
      primaryKey,
      foreignKeys: foreignKeyResult.rows.map((row) => ({
        column: row.column_name,
        referencesTable:
          row.references_schema === "public"
            ? row.references_table
            : `${row.references_schema}.${row.references_table}`,
        referencesColumn: row.references_column,
        onUpdate: row.update_rule,
        onDelete: row.delete_rule,
      })),
      indexes,
      rowCount,
      mutable:
        this.canWrite &&
        object.type === "table" &&
        primaryKey.length > 0,
      autoIncrement,
      reason:
        object.type !== "table"
          ? "Views are read-only in this release."
          : primaryKey.length === 0
            ? "Add a primary key before using safe changes."
            : !this.canWrite
              ? "The workspace is running in read-only mode."
              : null,
    };
  }

  async catalog({ includeRows = false } = {}) {
    const objects = await this.listObjects();
    const tables = [];
    for (const object of objects) {
      tables.push(
        await this.inspectObject(object.name, {
          includeRows,
        }),
      );
    }
    return tables;
  }

  async browseTable(name, { limit = 50, offset = 0 } = {}) {
    const table = await this.inspectObject(name);
    const order = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map(quoteIdent).join(", ")}`
      : "";
    const result = await this.readPool.query(
      `SELECT * FROM ${qualifiedTable(table)}${order} LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );
    const truncated = result.rows.length > limit;
    const rows = result.rows.slice(0, limit).map(jsonSafe);
    return {
      table: {
        name: table.name,
        type: table.type,
        columns: table.columns,
        primaryKey: table.primaryKey,
        mutable: table.mutable,
        rowCount: table.rowCount,
      },
      rows,
      limit,
      offset,
      truncated,
    };
  }

  async readQuery(sql, { params = [], maxRows = 500 } = {}) {
    assertReadOnlySql(sql);
    assertSingleStatement(sql);
    if (!Array.isArray(params)) {
      throw new CleverSQLError("params must be an array.");
    }
    if (params.length > 100) {
      throw new CleverSQLError("Too many query parameters.");
    }

    const keyword = getFirstKeyword(sql);
    const wrapped =
      keyword === "EXPLAIN"
        ? stripTrailingSemicolon(sql)
        : `SELECT * FROM (${stripTrailingSemicolon(sql)}) AS __cleversql_read LIMIT ${maxRows + 1}`;
    const started = performance.now();
    const client = await this.readPool.connect();

    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(
        `SET LOCAL statement_timeout = ${Math.max(1, this.queryTimeoutMs)}`,
      );
      const result = await client.query(wrapped, params);
      const truncated = result.rows.length > maxRows;
      const rows = result.rows.slice(0, maxRows).map(jsonSafe);
      await client.query("ROLLBACK");
      return {
        columns:
          result.fields?.map((field) => field.name) ??
          Object.keys(rows[0] ?? {}),
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original query error.
      }
      throw postgresError(error);
    } finally {
      client.release();
    }
  }

  normalizeFilters(table, where) {
    if (where == null) return [];
    let entries;

    if (Array.isArray(where)) {
      entries = where;
    } else if (isPlainObject(where)) {
      entries = Object.entries(where).map(([column, value]) => ({
        column,
        op: "eq",
        value,
      }));
    } else {
      throw new CleverSQLError("where must be an object or an array.");
    }
    if (entries.length === 0) return [];
    if (entries.length > 12) {
      throw new CleverSQLError("A change can use at most 12 filters.");
    }

    const lookup = columnLookup(table.columns);
    return entries.map((entry) => {
      if (!isPlainObject(entry)) {
        throw new CleverSQLError("Each where entry must be an object.");
      }
      const op = String(entry.op ?? "eq").toLowerCase();
      if (!FILTER_OPS.has(op)) {
        throw new CleverSQLError(`Unsupported filter operator: ${op}`);
      }
      const column = lookup.get(String(entry.column ?? "").toLowerCase());
      if (!column) {
        throw new CleverSQLError(
          `Unknown filter column "${entry.column}" on ${table.name}.`,
        );
      }
      if (op === "in") {
        if (!Array.isArray(entry.value) || entry.value.length === 0) {
          throw new CleverSQLError(
            `Filter "${column.name}" with op=in needs a non-empty array.`,
          );
        }
        if (entry.value.length > 100) {
          throw new CleverSQLError(
            "A filter with op=in supports at most 100 values.",
          );
        }
      }
      return {
        column: column.name,
        op,
        value: entry.value ?? null,
      };
    });
  }

  filterClause(filters, startIndex = 1) {
    const clauses = [];
    const params = [];
    let index = startIndex;
    const next = () => `$${index++}`;

    for (const filter of filters) {
      const column = quoteIdent(filter.column);
      switch (filter.op) {
        case "eq":
          if (Array.isArray(filter.value)) {
            if (filter.value.length === 0) {
              clauses.push("FALSE");
            } else {
              const placeholders = filter.value.map(() => next());
              clauses.push(`${column} IN (${placeholders.join(", ")})`);
              params.push(...filter.value);
            }
          } else if (filter.value === null) {
            clauses.push(`${column} IS NULL`);
          } else {
            clauses.push(`${column} = ${next()}`);
            params.push(filter.value);
          }
          break;
        case "neq":
          if (filter.value === null) {
            clauses.push(`${column} IS NOT NULL`);
          } else {
            clauses.push(`${column} <> ${next()}`);
            params.push(filter.value);
          }
          break;
        case "in": {
          const placeholders = filter.value.map(() => next());
          clauses.push(`${column} IN (${placeholders.join(", ")})`);
          params.push(...filter.value);
          break;
        }
        case "like":
          clauses.push(`${column} LIKE ${next()}`);
          params.push(filter.value);
          break;
        case "gt":
          clauses.push(`${column} > ${next()}`);
          params.push(filter.value);
          break;
        case "gte":
          clauses.push(`${column} >= ${next()}`);
          params.push(filter.value);
          break;
        case "lt":
          clauses.push(`${column} < ${next()}`);
          params.push(filter.value);
          break;
        case "lte":
          clauses.push(`${column} <= ${next()}`);
          params.push(filter.value);
          break;
        case "is_null":
          clauses.push(`${column} IS NULL`);
          break;
        case "not_null":
          clauses.push(`${column} IS NOT NULL`);
          break;
        default:
          throw new CleverSQLError(
            `Unsupported filter operator: ${filter.op}`,
          );
      }
    }

    return {
      sql: clauses.length ? clauses.join(" AND ") : null,
      params,
    };
  }

  async selectRows(table, filters, { limit = 101 } = {}) {
    const where = this.filterClause(filters);
    const orderBy = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map(quoteIdent).join(", ")}`
      : "";
    const client = this.activeClient({ write: true });
    const sql = `SELECT * FROM ${qualifiedTable(table)}${
      where.sql ? ` WHERE ${where.sql}` : ""
    }${orderBy} LIMIT $${where.params.length + 1}`;
    const result = await client.query(sql, [...where.params, limit]);
    return result.rows.map(jsonSafe);
  }

  async selectRowsByKeys(table, rows) {
    if (rows.length === 0) return [];
    if (table.primaryKey.length === 0) {
      throw new CleverSQLError("This table has no primary key.");
    }

    const clauses = [];
    const params = [];
    let index = 1;
    for (const row of rows) {
      const keys = table.primaryKey.map((column) => {
        params.push(row[column]);
        return `${quoteIdent(column)} = $${index++}`;
      });
      clauses.push(`(${keys.join(" AND ")})`);
    }

    const orderBy = table.primaryKey.map(quoteIdent).join(", ");
    const client = this.activeClient({ write: true });
    const result = await client.query(
      `SELECT * FROM ${qualifiedTable(table)}
       WHERE ${clauses.join(" OR ")}
       ORDER BY ${orderBy}`,
      params,
    );
    return result.rows.map(jsonSafe);
  }

  validateValues(table, values, { allowIdentity = false } = {}) {
    if (!isPlainObject(values)) {
      throw new CleverSQLError("values must be an object.");
    }
    const lookup = columnLookup(table.columns);
    const normalized = {};
    for (const [name, value] of Object.entries(values)) {
      const column = lookup.get(name.toLowerCase());
      if (!column) {
        throw new CleverSQLError(`Unknown column "${name}" on ${table.name}.`);
      }
      if (column.generated) {
        throw new CleverSQLError(
          `Generated column "${column.name}" is read-only.`,
        );
      }
      if (
        !allowIdentity &&
        column.identityGeneration === "ALWAYS"
      ) {
        throw new CleverSQLError(
          `Identity column "${column.name}" is generated by the database.`,
        );
      }
      normalized[column.name] = value ?? null;
    }
    if (Object.keys(normalized).length === 0) {
      throw new CleverSQLError("values must contain at least one column.");
    }
    return normalized;
  }

  async executeOperation(table, operation) {
    const where = this.filterClause(operation.filters);
    const client = this.activeClient({ write: true });

    if (operation.action === "insert") {
      const values = this.validateValues(table, operation.values);
      const columns = Object.keys(values);
      const placeholders = columns.map((_, index) => `$${index + 1}`);
      const result = await client.query(
        `INSERT INTO ${qualifiedTable(table)} (${columns
          .map(quoteIdent)
          .join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING *`,
        columns.map((column) => values[column]),
      );
      return result.rows.map(jsonSafe);
    }

    if (!where.sql) {
      throw new CleverSQLError("Writes require at least one filter.", {
        code: "UNBOUNDED_WRITE_BLOCKED",
      });
    }

    if (operation.action === "update") {
      const values = this.validateValues(table, operation.values);
      const columns = Object.keys(values);
      if (columns.some((column) => table.primaryKey.includes(column))) {
        throw new CleverSQLError(
          "Primary key updates are blocked in v0.2. Delete and recreate the row instead.",
          { code: "PRIMARY_KEY_UPDATE_BLOCKED" },
        );
      }
      const setSql = columns
        .map((column, index) => `${quoteIdent(column)} = $${index + 1}`)
        .join(", ");
      const whereWithOffset = this.filterClause(
        operation.filters,
        columns.length + 1,
      );
      const result = await client.query(
        `UPDATE ${qualifiedTable(table)}
         SET ${setSql}
         WHERE ${whereWithOffset.sql}
         RETURNING *`,
        [
          ...columns.map((column) => values[column]),
          ...whereWithOffset.params,
        ],
      );
      return result.rows.map(jsonSafe);
    }

    if (operation.action === "delete") {
      const result = await client.query(
        `DELETE FROM ${qualifiedTable(table)}
         WHERE ${where.sql}
         RETURNING *`,
        where.params,
      );
      return result.rows.map(jsonSafe);
    }

    throw new CleverSQLError(`Unsupported action: ${operation.action}`);
  }

  async deleteByKeys(table, rows) {
    if (rows.length === 0) return [];
    const clauses = [];
    const params = [];
    let index = 1;
    for (const row of rows) {
      clauses.push(
        `(${table.primaryKey
          .map((column) => {
            params.push(row[column]);
            return `${quoteIdent(column)} = $${index++}`;
          })
          .join(" AND ")})`,
      );
    }
    const client = this.activeClient({ write: true });
    const result = await client.query(
      `DELETE FROM ${qualifiedTable(table)}
       WHERE ${clauses.join(" OR ")}
       RETURNING *`,
      params,
    );
    return result.rows.map(jsonSafe);
  }

  async updateByKeys(table, rows, values) {
    const writableColumns = new Set(
      table.columns
        .filter((column) => !column.generated)
        .map((column) => column.name),
    );
    const columns = Object.keys(values).filter(
      (column) =>
        !table.primaryKey.includes(column) && writableColumns.has(column),
    );
    if (columns.length === 0 || rows.length === 0) return [];

    const params = columns.map((column) => values[column] ?? null);
    let index = params.length + 1;
    const clauses = rows.map(
      (row) =>
        `(${table.primaryKey
          .map((column) => {
            params.push(row[column]);
            return `${quoteIdent(column)} = $${index++}`;
          })
          .join(" AND ")})`,
    );
    const setSql = columns
      .map((column, columnIndex) => `${quoteIdent(column)} = $${columnIndex + 1}`)
      .join(", ");
    const client = this.activeClient({ write: true });
    const result = await client.query(
      `UPDATE ${qualifiedTable(table)}
       SET ${setSql}
       WHERE ${clauses.join(" OR ")}
       RETURNING *`,
      params,
    );
    return result.rows.map(jsonSafe);
  }

  async insertRow(table, row) {
    const lookup = columnLookup(table.columns);
    const restorable = Object.fromEntries(
      Object.entries(row).filter(
        ([column]) => !lookup.get(column.toLowerCase())?.generated,
      ),
    );
    const values = this.validateValues(table, restorable, {
      allowIdentity: true,
    });
    const columns = Object.keys(values);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const override = table.columns.some(
      (column) =>
        column.identityGeneration === "ALWAYS" &&
        columns.includes(column.name),
    )
      ? " OVERRIDING SYSTEM VALUE"
      : "";
    const client = this.activeClient({ write: true });
    const result = await client.query(
      `INSERT INTO ${qualifiedTable(table)} (${columns
        .map(quoteIdent)
        .join(", ")})${override}
       VALUES (${placeholders.join(", ")})
       RETURNING *`,
      columns.map((column) => values[column]),
    );
    return result.rows.map(jsonSafe);
  }

  async transaction(callback, { commit = true } = {}) {
    if (!this.writePool) {
      throw new CleverSQLError("The workspace is read-only.", {
        status: 403,
        code: "DATABASE_READ_ONLY",
      });
    }
    const client = await this.writePool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query(
        `SET LOCAL statement_timeout = ${Math.max(1, this.queryTimeoutMs)}`,
      );
      const result = await this.transactionContext.run({ client }, () =>
        callback(),
      );
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw postgresError(error);
    } finally {
      client.release();
    }
  }
}
