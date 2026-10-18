import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  constants as sqliteConstants,
} from "node:sqlite";
import {
  CleverSQLError,
  assertReadOnlySql,
  assertSingleStatement,
  isPlainObject,
  jsonSafe,
  quoteIdent,
} from "./utils.js";

const READ_ACTIONS = new Set([
  sqliteConstants.SQLITE_READ,
  sqliteConstants.SQLITE_SELECT,
  sqliteConstants.SQLITE_FUNCTION,
  sqliteConstants.SQLITE_RECURSIVE,
]);

const PRAGMA_ALLOWLIST = new Set([
  "table_info",
  "table_xinfo",
  "foreign_key_list",
  "index_list",
  "index_info",
]);

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

function sqliteError(error, fallbackStatus = 400) {
  if (error instanceof CleverSQLError) return error;
  const message = String(error?.message ?? error);
  let status = fallbackStatus;
  let code = "DATABASE_ERROR";

  if (/readonly|read-only/i.test(message)) {
    status = 403;
    code = "DATABASE_READ_ONLY";
  } else if (/UNIQUE constraint|FOREIGN KEY constraint|NOT NULL constraint/i.test(message)) {
    status = 409;
    code = "CONSTRAINT_VIOLATION";
  } else if (/no such table|no such column/i.test(message)) {
    status = 404;
    code = "OBJECT_NOT_FOUND";
  } else if (/syntax error|incomplete input|near /i.test(message)) {
    status = 400;
    code = "SQL_SYNTAX_ERROR";
  }

  return new CleverSQLError(message, { status, code });
}

function columnLookup(columns) {
  const lookup = new Map();
  for (const column of columns) {
    lookup.set(column.name.toLowerCase(), column);
  }
  return lookup;
}

function buildKeyClause(primaryKey) {
  return primaryKey
    .map((column) => `${quoteIdent(column)}=?`)
    .join(" AND ");
}

export class SqliteAdapter {
  constructor(filePath, { readOnly = false } = {}) {
    this.filePath = path.resolve(filePath);
    this.readOnlyMode = readOnly;
    this.transactionQueue = Promise.resolve();

    if (!fs.existsSync(this.filePath)) {
      throw new CleverSQLError(`Database file not found: ${this.filePath}`, {
        status: 404,
        code: "DATABASE_NOT_FOUND",
      });
    }

    this.readDb = new DatabaseSync(this.filePath, { readOnly: true });
    this.readDb.exec("PRAGMA busy_timeout = 5000;");
    this.readDb.setAuthorizer((action, arg1, arg2) => {
      if (READ_ACTIONS.has(action)) {
        if (
          action === sqliteConstants.SQLITE_FUNCTION &&
          String(arg2 || arg1).toLowerCase() === "load_extension"
        ) {
          return sqliteConstants.SQLITE_DENY;
        }
        return sqliteConstants.SQLITE_OK;
      }
      if (
        action === sqliteConstants.SQLITE_PRAGMA &&
        PRAGMA_ALLOWLIST.has(String(arg1).toLowerCase())
      ) {
        return sqliteConstants.SQLITE_OK;
      }
      return sqliteConstants.SQLITE_DENY;
    });

    this.writeDb = null;
    if (!readOnly) {
      this.writeDb = new DatabaseSync(this.filePath, {
        enableForeignKeyConstraints: true,
      });
      this.writeDb.exec("PRAGMA busy_timeout = 5000;");
    }
  }

  get driver() {
    return "sqlite";
  }

  get name() {
    return path.basename(this.filePath);
  }

  get sizeBytes() {
    return fs.statSync(this.filePath).size;
  }

  get canWrite() {
    return this.writeDb !== null;
  }

  async metadata() {
    return {
      driver: "sqlite",
      name: this.name,
      label: this.name,
      path: this.filePath,
      sizeBytes: this.sizeBytes,
    };
  }

  async close() {
    this.readDb.close();
    this.writeDb?.close();
  }

  listObjects() {
    return this.readDb
      .prepare(
        `SELECT name, type, sql
         FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE`,
      )
      .all()
      .map((row) => ({ name: row.name, type: row.type, sql: row.sql }));
  }

  resolveObject(name) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new CleverSQLError("Table name is required.");
    }
    const requested = name.trim();
    const object =
      this.listObjects().find((item) => item.name === requested) ??
      this.listObjects().find(
        (item) => item.name.toLowerCase() === requested.toLowerCase(),
      );
    if (!object) {
      throw new CleverSQLError(`Table or view not found: ${requested}`, {
        status: 404,
        code: "OBJECT_NOT_FOUND",
      });
    }
    return object;
  }

  inspectObject(name, { includeRows = false, includeIndexes = false } = {}) {
    const object = this.resolveObject(name);
    const columns = this.readDb
      .prepare(`PRAGMA table_xinfo(${quoteIdent(object.name)})`)
      .all()
      .filter((column) => column.hidden !== 1)
      .map((column) => ({
        name: column.name,
        type: column.type || "ANY",
        notNull: Boolean(column.notnull),
        defaultValue: column.dflt_value ?? null,
        primaryKeyPosition: Number(column.pk) || 0,
        generated: column.hidden === 2 || column.hidden === 3,
      }));

    const primaryKey = columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((column) => column.name);

    const foreignKeys = this.readDb
      .prepare(`PRAGMA foreign_key_list(${quoteIdent(object.name)})`)
      .all()
      .map((foreignKey) => ({
        column: foreignKey.from,
        referencesTable: foreignKey.table,
        referencesColumn: foreignKey.to,
        onUpdate: foreignKey.on_update,
        onDelete: foreignKey.on_delete,
      }));

    let rowCount = null;
    if (includeRows) {
      rowCount = Number(
        this.readDb
          .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(object.name)}`)
          .get().count,
      );
    }

    let indexes = [];
    if (includeIndexes) {
      indexes = this.readDb
        .prepare(`PRAGMA index_list(${quoteIdent(object.name)})`)
        .all()
        .map((index) => ({
          name: index.name,
          unique: Boolean(index.unique),
          origin: index.origin,
          columns: this.readDb
            .prepare(`PRAGMA index_info(${quoteIdent(index.name)})`)
            .all()
            .sort((a, b) => a.seqno - b.seqno)
            .map((column) => column.name),
        }));
    }

    const autoIncrement =
      primaryKey.length === 1 &&
      /AUTOINCREMENT/i.test(object.sql ?? "") &&
      /INTEGER/i.test(
        columns.find((column) => column.name === primaryKey[0])?.type ?? "",
      );

    return {
      ...object,
      columns,
      primaryKey,
      foreignKeys,
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

  catalog({ includeRows = false } = {}) {
    return this.listObjects().map((object) =>
      this.inspectObject(object.name, { includeRows }),
    );
  }

  browseTable(name, { limit = 50, offset = 0 } = {}) {
    const table = this.inspectObject(name);
    const order = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map(quoteIdent).join(", ")}`
      : "";
    const statement = this.readDb.prepare(
      `SELECT * FROM ${quoteIdent(table.name)}${order} LIMIT ? OFFSET ?`,
    );
    const rows = statement.all(limit + 1, offset);
    const truncated = rows.length > limit;
    if (truncated) rows.pop();
    return {
      table: {
        name: table.name,
        type: table.type,
        columns: table.columns,
        primaryKey: table.primaryKey,
        mutable: table.mutable,
        rowCount: table.rowCount,
      },
      rows: rows.map(jsonSafe),
      limit,
      offset,
      truncated,
    };
  }

  readQuery(sql, { params = [], maxRows = 500 } = {}) {
    assertReadOnlySql(sql);
    assertSingleStatement(sql);
    if (!Array.isArray(params)) {
      throw new CleverSQLError("params must be an array.");
    }
    if (params.length > 100) {
      throw new CleverSQLError("Too many query parameters.");
    }

    const started = performance.now();
    try {
      const statement = this.readDb.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      const iterator = statement.iterate(...params);
      let truncated = false;

      for (const row of iterator) {
        if (rows.length >= maxRows) {
          truncated = true;
          iterator.return?.();
          break;
        }
        rows.push(jsonSafe(row));
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      };
    } catch (error) {
      throw sqliteError(error);
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
          throw new CleverSQLError(`Filter "${column.name}" with op=in needs a non-empty array.`);
        }
        if (entry.value.length > 100) {
          throw new CleverSQLError("A filter with op=in supports at most 100 values.");
        }
      }
      return {
        column: column.name,
        op,
        value: entry.value ?? null,
      };
    });
  }

  filterClause(filters) {
    const clauses = [];
    const params = [];

    for (const filter of filters) {
      const column = quoteIdent(filter.column);
      switch (filter.op) {
        case "eq":
          if (Array.isArray(filter.value)) {
            if (filter.value.length === 0) {
              clauses.push("0 = 1");
            } else {
              clauses.push(
                `${column} IN (${filter.value.map(() => "?").join(", ")})`,
              );
              params.push(...filter.value);
            }
          } else if (filter.value === null) {
            clauses.push(`${column} IS NULL`);
          } else {
            clauses.push(`${column} = ?`);
            params.push(filter.value);
          }
          break;
        case "neq":
          if (filter.value === null) {
            clauses.push(`${column} IS NOT NULL`);
          } else {
            clauses.push(`${column} <> ?`);
            params.push(filter.value);
          }
          break;
        case "in":
          clauses.push(`${column} IN (${filter.value.map(() => "?").join(", ")})`);
          params.push(...filter.value);
          break;
        case "like":
          clauses.push(`${column} LIKE ?`);
          params.push(filter.value);
          break;
        case "gt":
          clauses.push(`${column} > ?`);
          params.push(filter.value);
          break;
        case "gte":
          clauses.push(`${column} >= ?`);
          params.push(filter.value);
          break;
        case "lt":
          clauses.push(`${column} < ?`);
          params.push(filter.value);
          break;
        case "lte":
          clauses.push(`${column} <= ?`);
          params.push(filter.value);
          break;
        case "is_null":
          clauses.push(`${column} IS NULL`);
          break;
        case "not_null":
          clauses.push(`${column} IS NOT NULL`);
          break;
        default:
          throw new CleverSQLError(`Unsupported filter operator: ${filter.op}`);
      }
    }

    return {
      sql: clauses.length > 0 ? clauses.join(" AND ") : null,
      params,
    };
  }

  selectRows(table, filters, { limit = 101 } = {}) {
    const where = this.filterClause(filters);
    const orderBy = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map(quoteIdent).join(", ")}`
      : "";
    const sql = `SELECT * FROM ${quoteIdent(table.name)}${
      where.sql ? ` WHERE ${where.sql}` : ""
    }${orderBy} LIMIT ?`;
    return this.readDb
      .prepare(sql)
      .all(...where.params, limit)
      .map(jsonSafe);
  }

  selectRowsByKeys(table, rows) {
    if (rows.length === 0) return [];
    if (table.primaryKey.length === 0) {
      throw new CleverSQLError("This table has no primary key.");
    }
    const keyClause = buildKeyClause(table.primaryKey);
    const clauses = rows.map(() => `(${keyClause})`).join(" OR ");
    const params = rows.flatMap((row) =>
      table.primaryKey.map((column) => row[column]),
    );
    const orderBy = table.primaryKey.map(quoteIdent).join(", ");
    return this.readDb
      .prepare(
        `SELECT * FROM ${quoteIdent(table.name)} WHERE ${clauses} ORDER BY ${orderBy}`,
      )
      .all(...params)
      .map(jsonSafe);
  }

  validateValues(table, values, { partial = false } = {}) {
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
        throw new CleverSQLError(`Generated column "${column.name}" is read-only.`);
      }
      normalized[column.name] = value ?? null;
    }
    if (!partial && Object.keys(normalized).length === 0) {
      throw new CleverSQLError("values must contain at least one column.");
    }
    return normalized;
  }

  executeOperation(table, operation) {
    const filters = operation.filters;
    const where = this.filterClause(filters);

    if (operation.action === "insert") {
      const values = this.validateValues(table, operation.values);
      const columns = Object.keys(values);
      const sql = `INSERT INTO ${quoteIdent(table.name)} (${columns
        .map(quoteIdent)
        .join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`;
      try {
        return this.writeDb
          .prepare(sql)
          .all(...columns.map((column) => values[column]))
          .map(jsonSafe);
      } catch (error) {
        throw sqliteError(error);
      }
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
      const sql = `UPDATE ${quoteIdent(table.name)} SET ${columns
        .map((column) => `${quoteIdent(column)} = ?`)
        .join(", ")} WHERE ${where.sql} RETURNING *`;
      try {
        return this.writeDb
          .prepare(sql)
          .all(
            ...columns.map((column) => values[column]),
            ...where.params,
          )
          .map(jsonSafe);
      } catch (error) {
        throw sqliteError(error);
      }
    }

    if (operation.action === "delete") {
      const sql = `DELETE FROM ${quoteIdent(table.name)} WHERE ${where.sql} RETURNING *`;
      try {
        return this.writeDb
          .prepare(sql)
          .all(...where.params)
          .map(jsonSafe);
      } catch (error) {
        throw sqliteError(error);
      }
    }

    throw new CleverSQLError(`Unsupported action: ${operation.action}`);
  }

  deleteByKeys(table, rows) {
    if (rows.length === 0) return [];
    const keyClause = buildKeyClause(table.primaryKey);
    const clauses = rows.map(() => `(${keyClause})`).join(" OR ");
    const params = rows.flatMap((row) =>
      table.primaryKey.map((column) => row[column]),
    );
    return this.writeDb
      .prepare(
        `DELETE FROM ${quoteIdent(table.name)} WHERE ${clauses} RETURNING *`,
      )
      .all(...params)
      .map(jsonSafe);
  }

  updateByKeys(table, rows, values) {
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
    const keyClause = buildKeyClause(table.primaryKey);
    const clauses = rows.map(() => `(${keyClause})`).join(" OR ");
    const keyParams = rows.flatMap((row) =>
      table.primaryKey.map((column) => row[column]),
    );
    const sql = `UPDATE ${quoteIdent(table.name)} SET ${columns
      .map((column) => `${quoteIdent(column)} = ?`)
      .join(", ")} WHERE ${clauses} RETURNING *`;
    return this.writeDb
      .prepare(sql)
      .all(
        ...columns.map((column) => values[column]),
        ...keyParams,
      )
      .map(jsonSafe);
  }

  insertRow(table, row) {
    const lookup = columnLookup(table.columns);
    const restorable = Object.fromEntries(
      Object.entries(row).filter(
        ([column]) => !lookup.get(column.toLowerCase())?.generated,
      ),
    );
    const values = this.validateValues(table, restorable);
    const columns = Object.keys(values);
    return this.writeDb
      .prepare(
        `INSERT INTO ${quoteIdent(table.name)} (${columns
          .map(quoteIdent)
          .join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`,
      )
      .all(...columns.map((column) => values[column]))
      .map(jsonSafe);
  }

  async transaction(callback, { immediate = true, commit = true } = {}) {
    if (!this.writeDb) {
      throw new CleverSQLError("The workspace is read-only.", {
        status: 403,
        code: "DATABASE_READ_ONLY",
      });
    }

    const execute = async () => {
      this.writeDb.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const result = await callback();
        this.writeDb.exec(commit ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        try {
          this.writeDb.exec("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
        throw sqliteError(error);
      }
    };

    const run = this.transactionQueue.then(execute, execute);
    this.transactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
