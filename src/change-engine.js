import {
  CleverSQLError,
  assertNoExtraKeys,
  buildDiff,
  hashRows,
  newChangeId,
  normalizeActor,
  nowIso,
  rowIndex,
  tableKey,
} from "./utils.js";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AFFECTED = 25;
const ACTION_VALUES = new Set(["insert", "update", "delete"]);

function sortRows(rows, primaryKey) {
  return [...rows].sort((a, b) =>
    tableKey(a, primaryKey).localeCompare(tableKey(b, primaryKey)),
  );
}

function summarize(plan) {
  const diff = plan.diff;
  const columns = new Set();
  for (const item of diff) {
    for (const column of item.changed) columns.add(column);
  }
  return {
    matchedRows: plan.before.length,
    affectedRows:
      plan.action === "delete" ? plan.before.length : plan.after.length,
    changedRows: diff.length,
    changedColumns: [...columns].sort(),
    reversible: true,
  };
}

async function normalizeOperation(input, adapter) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CleverSQLError("Change operation must be an object.");
  }
  assertNoExtraKeys(
    input,
    ["action", "table", "where", "values", "reason", "maxAffected"],
    "change",
  );

  const action = String(input.action ?? "").toLowerCase();
  if (!ACTION_VALUES.has(action)) {
    throw new CleverSQLError("action must be insert, update, or delete.");
  }
  if (typeof input.table !== "string" || input.table.trim().length === 0) {
    throw new CleverSQLError("table is required.");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length < 4) {
    throw new CleverSQLError(
      "A reason of at least 4 characters is required for every change.",
      { code: "REASON_REQUIRED" },
    );
  }

  const table = await adapter.inspectObject(input.table, {
    includeIndexes: true,
  });
  if (!adapter.canWrite) {
    throw new CleverSQLError("The workspace is read-only.", {
      status: 403,
      code: "DATABASE_READ_ONLY",
    });
  }
  if (table.type !== "table") {
    throw new CleverSQLError("Views are read-only in this release.");
  }
  if (table.primaryKey.length === 0) {
    throw new CleverSQLError(
      `Table "${table.name}" has no primary key. Safe changes require a stable row identity.`,
      { status: 409, code: "PRIMARY_KEY_REQUIRED" },
    );
  }

  const filters = adapter.normalizeFilters(table, input.where);
  if ((action === "update" || action === "delete") && filters.length === 0) {
    throw new CleverSQLError("update and delete require at least one filter.", {
      code: "UNBOUNDED_WRITE_BLOCKED",
    });
  }
  if (action === "insert" && filters.length > 0) {
    throw new CleverSQLError("insert does not accept where filters.");
  }

  let values = null;
  if (action === "insert" || action === "update") {
    values = adapter.validateValues(table, input.values);
  }
  if (action === "delete" && input.values != null) {
    throw new CleverSQLError("delete does not accept values.");
  }

  const requestedMax = Number.parseInt(
    input.maxAffected ?? DEFAULT_MAX_AFFECTED,
    10,
  );
  const maxAffected = Math.min(
    100,
    Math.max(1, Number.isFinite(requestedMax) ? requestedMax : DEFAULT_MAX_AFFECTED),
  );

  return {
    action,
    table,
    filters,
    values,
    reason: input.reason.trim().slice(0, 240),
    maxAffected,
  };
}

function makePlan(operation, actor) {
  const createdAt = nowIso();
  return {
    id: newChangeId(),
    version: 1,
    status: "preview",
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + PREVIEW_TTL_MS).toISOString(),
    action: operation.action,
    table: operation.table.name,
    primaryKey: operation.table.primaryKey,
    filters: operation.filters,
    values: operation.values,
    reason: operation.reason,
    maxAffected: operation.maxAffected,
    actor: normalizeActor(actor, "human"),
    summary: null,
    before: [],
    after: [],
    diff: [],
  };
}

function ensurePreviewable(plan) {
  if (plan.status === "expired") {
    throw new CleverSQLError(
      "This preview expired. Preview the change again before applying it.",
      { status: 409, code: "CHANGE_EXPIRED" },
    );
  }
  if (plan.status !== "preview") {
    throw new CleverSQLError(
      `Only preview changes can be applied. This change is ${plan.status}.`,
      { status: 409, code: "CHANGE_NOT_PREVIEWABLE" },
    );
  }
  if (Date.parse(plan.expiresAt) <= Date.now()) {
    throw new CleverSQLError(
      "This preview expired. Preview the change again before applying it.",
      { status: 409, code: "CHANGE_EXPIRED" },
    );
  }
}

async function currentMatches(adapter, table, expectedRows) {
  if (expectedRows.length === 0) return true;
  const current = await adapter.selectRowsByKeys(table, expectedRows);
  return hashRows(sortRows(current, table.primaryKey)) === hashRows(
    sortRows(expectedRows, table.primaryKey),
  );
}

export class ChangeEngine {
  constructor(adapter, store) {
    this.adapter = adapter;
    this.store = store;
  }

  async preview(input, { actor = "human" } = {}) {
    const operation = await normalizeOperation(input, this.adapter);
    const plan = makePlan(operation, actor);

    await this.adapter.transaction(
      async () => {
        let before = [];
        if (operation.action !== "insert") {
          before = await this.adapter.selectRows(
            operation.table,
            operation.filters,
            { limit: operation.maxAffected + 1 },
          );
          if (before.length > operation.maxAffected) {
            throw new CleverSQLError(
              `This change matches more than ${operation.maxAffected} rows. Narrow the filters or raise maxAffected up to 100.`,
              { status: 413, code: "CHANGE_TOO_LARGE" },
            );
          }
        }

        const returned = await this.adapter.executeOperation(
          operation.table,
          operation,
        );

        if (operation.action === "insert") {
          plan.before = [];
          plan.after = sortRows(returned, operation.table.primaryKey);
        } else if (operation.action === "delete") {
          plan.before = sortRows(returned, operation.table.primaryKey);
          plan.after = [];
        } else {
          plan.before = sortRows(before, operation.table.primaryKey);
          plan.after = sortRows(returned, operation.table.primaryKey);
        }

        plan.diff = buildDiff(
          plan.before,
          plan.after,
          operation.table.primaryKey,
        );
        plan.summary = summarize(plan);
      },
      { immediate: true, commit: false },
    );

    this.store.save(plan);
    this.store.audit({
      event: "previewed",
      changeId: plan.id,
      actor: plan.actor,
      table: plan.table,
      action: plan.action,
      reason: plan.reason,
      summary: plan.summary,
    });
    return plan;
  }

  get(changeId) {
    return this.store.get(changeId);
  }

  list({ status = "all", limit = 50 } = {}) {
    return this.store.list({ status, limit });
  }

  async apply(changeId, { actor = "human" } = {}) {
    const plan = this.store.get(changeId);
    ensurePreviewable(plan);
    const table = await this.adapter.inspectObject(plan.table);
    if (!table.mutable) {
      throw new CleverSQLError(
        table.reason || `Table "${plan.table}" is no longer mutable.`,
        { status: 409, code: "TABLE_NOT_MUTABLE" },
      );
    }

    await this.adapter.transaction(
      async () => {
        if (plan.action !== "insert") {
          const current = await this.adapter.selectRows(
            table,
            plan.filters,
            { limit: plan.maxAffected + 1 },
          );
          if (
            hashRows(sortRows(current, table.primaryKey)) !==
            hashRows(sortRows(plan.before, table.primaryKey))
          ) {
            throw new CleverSQLError(
              "The matched rows changed after this preview. Preview again to see the latest values.",
              { status: 409, code: "STALE_CHANGE" },
            );
          }
        }

        const returned = await this.adapter.executeOperation(table, {
          action: plan.action,
          filters: plan.filters,
          values: plan.values,
        });
        if (plan.action === "delete") {
          plan.after = [];
        } else {
          plan.after = sortRows(returned, table.primaryKey);
        }
        plan.diff = buildDiff(plan.before, plan.after, table.primaryKey);
        plan.summary = summarize(plan);
      },
      { immediate: true, commit: true },
    );

    plan.status = "applied";
    plan.appliedAt = nowIso();
    plan.appliedBy = normalizeActor(actor, "human");
    this.store.save(plan);
    this.store.audit({
      event: "applied",
      changeId: plan.id,
      actor: plan.appliedBy,
      table: plan.table,
      action: plan.action,
      reason: plan.reason,
      summary: plan.summary,
    });
    return plan;
  }

  async revert(changeId, { actor = "human", reason = "" } = {}) {
    const plan = this.store.get(changeId);
    if (plan.status !== "applied") {
      throw new CleverSQLError(
        `Only applied changes can be reverted. This change is ${plan.status}.`,
        { status: 409, code: "CHANGE_NOT_REVERTIBLE" },
      );
    }

    const table = await this.adapter.inspectObject(plan.table);
    if (!table.mutable) {
      throw new CleverSQLError(
        table.reason || `Table "${plan.table}" cannot be reverted.`,
        { status: 409, code: "TABLE_NOT_MUTABLE" },
      );
    }

    let restoredRows = [];
    await this.adapter.transaction(
      async () => {
        if (plan.action === "insert") {
          if (!(await currentMatches(this.adapter, table, plan.after))) {
            throw new CleverSQLError(
              "Inserted rows changed after this change. Revert would overwrite newer work.",
              { status: 409, code: "REVERT_CONFLICT" },
            );
          }
          restoredRows = await this.adapter.deleteByKeys(table, plan.after);
        } else if (plan.action === "delete") {
          const current = await this.adapter.selectRowsByKeys(
            table,
            plan.before,
          );
          if (current.length > 0) {
            throw new CleverSQLError(
              "A row using the deleted primary key exists again. Revert is unsafe.",
              { status: 409, code: "REVERT_CONFLICT" },
            );
          }
          for (const row of plan.before) {
            restoredRows.push(...(await this.adapter.insertRow(table, row)));
          }
        } else {
          if (!(await currentMatches(this.adapter, table, plan.after))) {
            throw new CleverSQLError(
              "The row changed again after this update. Revert would overwrite newer work.",
              { status: 409, code: "REVERT_CONFLICT" },
            );
          }
          const before = rowIndex(plan.before, table.primaryKey);
          for (const afterRow of plan.after) {
            const original = before.get(tableKey(afterRow, table.primaryKey));
            if (!original) {
              throw new CleverSQLError(
                "The original row snapshot is incomplete. Revert is unsafe.",
                { status: 409, code: "REVERT_CONFLICT" },
              );
            }
            restoredRows.push(
              ...(await this.adapter.updateByKeys(
                table,
                [afterRow],
                original,
              )),
            );
          }
        }
      },
      { immediate: true, commit: true },
    );

    const newColumns = new Set(plan.summary?.changedColumns ?? []);
    for (const row of restoredRows) {
      for (const column of Object.keys(row)) newColumns.add(column);
    }
    plan.status = "reverted";
    plan.revertedAt = nowIso();
    plan.revertedBy = normalizeActor(actor, "human");
    plan.revertReason = String(reason || "").trim().slice(0, 240) || null;
    plan.revertSummary = {
      affectedRows: restoredRows.length,
      changedColumns: [...newColumns].sort(),
    };
    this.store.save(plan);
    this.store.audit({
      event: "reverted",
      changeId: plan.id,
      actor: plan.revertedBy,
      table: plan.table,
      action: plan.action,
      reason: plan.revertReason,
      summary: plan.revertSummary,
    });
    return plan;
  }
}
