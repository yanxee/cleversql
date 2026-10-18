import path from "node:path";
import { ChangeEngine } from "./change-engine.js";
import { ChangeStore } from "./change-store.js";
import { createAdapter, isPostgresTarget } from "./database.js";
import { CleverSQLError, clampInt, formatBytes } from "./utils.js";

const CHANGE_STATUSES = new Set([
  "all",
  "preview",
  "applied",
  "reverted",
  "expired",
]);

function safeDatabaseName(target) {
  try {
    const url = new URL(target);
    return (
      decodeURIComponent(url.pathname.replace(/^\//, "")) ||
      url.hostname ||
      "database"
    )
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .slice(0, 60);
  } catch {
    return "database";
  }
}

function defaultStateDir(target) {
  if (isPostgresTarget(target)) {
    return path.resolve(
      process.cwd(),
      ".cleversql",
      safeDatabaseName(target),
    );
  }
  return path.join(path.dirname(path.resolve(target)), ".cleversql");
}

export class CleverSQL {
  constructor({
    database,
    databasePath,
    adapter,
    stateDir,
    readOnly = false,
    maxRows = 500,
    maxChanges = 100,
    version = "0.2.0",
  }) {
    this.version = version;
    this.maxRows = clampInt(maxRows, 1, 5_000, 500);
    this.maxChanges = clampInt(maxChanges, 1, 100, 25);
    this.target = database ?? databasePath;

    if (!adapter) {
      throw new CleverSQLError(
        "Use await CleverSQL.open(...) to initialize a database workspace.",
        { code: "ASYNC_DATABASE_INITIALIZATION" },
      );
    }
    this.adapter = adapter;

    this.store = new ChangeStore(stateDir ?? defaultStateDir(this.target));
    this.engine = new ChangeEngine(this.adapter, this.store);
    this.databaseInfo = null;
  }

  static async open(options = {}) {
    const target = options.database ?? options.databasePath;
    if (!target) {
      throw new CleverSQLError("A database file or PostgreSQL URL is required.");
    }
    const adapter =
      options.adapter ??
      (await createAdapter(target, {
        readOnly: options.readOnly,
        schemas: options.schemas,
        queryTimeoutMs: options.queryTimeoutMs,
        ssl: options.ssl,
      }));
    const workspace = new CleverSQL({ ...options, adapter });
    workspace.databaseInfo = await adapter.metadata();
    return workspace;
  }

  get databasePath() {
    return this.adapter.filePath ?? this.adapter.connectionLabel ?? this.target;
  }

  get readOnly() {
    return !this.adapter.canWrite;
  }

  get driver() {
    return this.adapter.driver;
  }

  get databaseLabel() {
    return this.databaseInfo?.label ?? this.adapter.name ?? "database";
  }

  async metadata() {
    this.databaseInfo ??= await this.adapter.metadata();
    return this.databaseInfo;
  }

  async dashboard() {
    const metadata = await this.metadata();
    const tables = await this.adapter.catalog({ includeRows: true });
    const tableCount = tables.filter((item) => item.type === "table").length;
    const viewCount = tables.filter((item) => item.type === "view").length;
    const rowCount = tables.reduce(
      (total, item) => total + Number(item.rowCount ?? 0),
      0,
    );
    const changeCounts = this.store.counts();

    return {
      product: "CleverSQL",
      version: this.version,
      tagline: "Query freely. Change carefully.",
      database: {
        driver: metadata.driver,
        name: metadata.name,
        label: metadata.label,
        path: metadata.path,
        host: metadata.host,
        user: metadata.user,
        serverVersion: metadata.serverVersion,
        schemas: metadata.schemas,
        sizeBytes: metadata.sizeBytes,
        size: formatBytes(metadata.sizeBytes),
      },
      safety: {
        readOnly: this.readOnly,
        maxRows: this.maxRows,
        maxChanges: this.maxChanges,
        queryTimeoutMs: this.adapter.queryTimeoutMs ?? null,
        previewTtlMinutes: 10,
        writeProtocol: ["preview", "apply", "revert"],
      },
      stats: {
        tables: tableCount,
        views: viewCount,
        rows: rowCount,
        changes: changeCounts.total,
        pending: changeCounts.preview,
        applied: changeCounts.applied,
      },
      tables: tables.map((table) => ({
        name: table.name,
        type: table.type,
        columns: table.columns.length,
        rows: table.rowCount,
        primaryKey: table.primaryKey,
        mutable: table.mutable,
        reason: table.reason,
      })),
      recentChanges: this.store.list({ limit: 6 }),
    };
  }

  async tables() {
    return this.adapter.catalog({ includeRows: true });
  }

  async table(name, options = {}) {
    return this.adapter.inspectObject(name, {
      includeRows: true,
      includeIndexes: true,
      ...options,
    });
  }

  async browseTable(name, { limit = 50, offset = 0 } = {}) {
    return this.adapter.browseTable(name, {
      limit: clampInt(limit, 1, 200, 50),
      offset: Math.max(0, Number.parseInt(offset, 10) || 0),
    });
  }

  async query(sql, { params = [], maxRows } = {}) {
    return this.adapter.readQuery(sql, {
      params,
      maxRows: clampInt(maxRows, 1, this.maxRows, Math.min(100, this.maxRows)),
    });
  }

  async previewChange(operation, { actor = "human" } = {}) {
    return this.engine.preview(
      {
        maxAffected: this.maxChanges,
        ...operation,
      },
      { actor },
    );
  }

  async applyChange(changeId, { actor = "human" } = {}) {
    return this.engine.apply(changeId, { actor });
  }

  async revertChange(changeId, { actor = "human", reason = "" } = {}) {
    return this.engine.revert(changeId, { actor, reason });
  }

  getChange(changeId) {
    return this.engine.get(changeId);
  }

  listChanges({ status = "all", limit = 50 } = {}) {
    if (!CHANGE_STATUSES.has(status)) {
      throw new CleverSQLError(
        "status must be all, preview, applied, reverted, or expired.",
      );
    }
    return this.engine.list({
      status,
      limit: clampInt(limit, 1, 100, 50),
    });
  }

  async schemaResource() {
    const metadata = await this.metadata();
    const tables = await this.adapter.catalog({ includeRows: true });
    return {
      product: "CleverSQL",
      version: this.version,
      database: metadata,
      safety: {
        readOnly: this.readOnly,
        writes: "preview -> apply -> revert",
        maxAffectedRows: this.maxChanges,
      },
      tables: tables.map((table) => ({
        name: table.name,
        type: table.type,
        rowCount: table.rowCount,
        primaryKey: table.primaryKey,
        mutable: table.mutable,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.type,
          notNull: column.notNull,
          defaultValue: column.defaultValue,
        })),
        foreignKeys: table.foreignKeys,
      })),
    };
  }

  async close() {
    await this.adapter.close();
  }
}
