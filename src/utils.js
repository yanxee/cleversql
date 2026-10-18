import { createHash, randomBytes } from "node:crypto";

export class CleverSQLError extends Error {
  constructor(message, { status = 400, code = "BAD_REQUEST", details } = {}) {
    super(message);
    this.name = "CleverSQLError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return {
      $type: "binary",
      bytes: value.byteLength,
      base64: Buffer.from(value).toString("base64"),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

export function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Uint8Array) {
    return JSON.stringify(Buffer.from(value).toString("base64"));
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function hashRows(rows) {
  return hashValue(rows);
}

export function quoteIdent(identifier) {
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new CleverSQLError("Identifier must be a non-empty string.");
  }
  if (identifier.includes("\0")) {
    throw new CleverSQLError("Identifier contains an invalid character.");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function newChangeId() {
  return `chg_${randomBytes(7).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function getFirstKeyword(sql) {
  if (typeof sql !== "string") return "";
  let text = sql.trimStart();
  while (text.startsWith("--")) {
    const lineEnd = text.indexOf("\n");
    if (lineEnd === -1) return "";
    text = text.slice(lineEnd + 1).trimStart();
  }
  while (text.startsWith("/*")) {
    const commentEnd = text.indexOf("*/", 2);
    if (commentEnd === -1) return "";
    text = text.slice(commentEnd + 2).trimStart();
  }
  return (text.match(/^[a-zA-Z]+/)?.[0] ?? "").toUpperCase();
}

export function assertReadOnlySql(sql) {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new CleverSQLError("SQL must be a non-empty string.");
  }
  if (sql.length > 100_000) {
    throw new CleverSQLError("SQL exceeds the 100 KB limit.", {
      code: "SQL_TOO_LARGE",
    });
  }
  const keyword = getFirstKeyword(sql);
  if (!["SELECT", "WITH", "EXPLAIN", "VALUES"].includes(keyword)) {
    throw new CleverSQLError(
      "The read surface accepts SELECT, WITH, EXPLAIN, or VALUES. Use a preview change for writes.",
      { code: "WRITE_SQL_BLOCKED" },
    );
  }
}

export function assertSingleStatement(sql) {
  let index = 0;
  let state = "normal";
  let dollarTag = null;

  const significantAhead = (start) => {
    let cursor = start;
    while (cursor < sql.length) {
      if (/\s/.test(sql[cursor])) {
        cursor += 1;
        continue;
      }
      if (sql.startsWith("--", cursor)) {
        const lineEnd = sql.indexOf("\n", cursor + 2);
        if (lineEnd === -1) return false;
        cursor = lineEnd + 1;
        continue;
      }
      if (sql.startsWith("/*", cursor)) {
        const commentEnd = sql.indexOf("*/", cursor + 2);
        if (commentEnd === -1) return false;
        cursor = commentEnd + 2;
        continue;
      }
      return true;
    }
    return false;
  };

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "normal") {
      if (character === "-" && next === "-") {
        state = "line-comment";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        state = "block-comment";
        index += 2;
        continue;
      }
      if (character === "'") {
        state = "single-quote";
      } else if (character === '"') {
        state = "double-quote";
      } else if (character === "$") {
        const match = sql
          .slice(index)
          .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
        if (match) {
          dollarTag = match[0];
          state = "dollar-quote";
          index += dollarTag.length;
          continue;
        }
      } else if (character === ";") {
        if (significantAhead(index + 1)) {
          throw new CleverSQLError(
            "Only one SQL statement is allowed per query.",
            { code: "MULTIPLE_STATEMENTS_BLOCKED" },
          );
        }
        return;
      }
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") {
        index += 2;
      } else if (character === "'") {
        state = "normal";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "double-quote") {
      if (character === '"' && next === '"') {
        index += 2;
      } else if (character === '"') {
        state = "normal";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        state = "normal";
        index += dollarTag.length;
      } else {
        index += 1;
      }
    }
  }
}

export function normalizeActor(actor, fallback = "human") {
  if (typeof actor === "string" && actor.trim().length > 0) {
    return actor.trim().slice(0, 80);
  }
  return fallback;
}

export function tableKey(row, primaryKey) {
  return primaryKey.map((column) => stableStringify(row?.[column])).join("|");
}

export function rowIndex(rows, primaryKey) {
  const index = new Map();
  for (const row of rows) {
    index.set(tableKey(row, primaryKey), row);
  }
  return index;
}

export function changedColumns(before, after) {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => stableStringify(before[key]) !== stableStringify(after[key]))
    .sort();
}

export function buildDiff(beforeRows, afterRows, primaryKey) {
  const before = rowIndex(beforeRows, primaryKey);
  const after = rowIndex(afterRows, primaryKey);
  const keys = new Set([...before.keys(), ...after.keys()]);

  return [...keys]
    .sort()
    .map((key) => {
      const oldRow = before.get(key) ?? null;
      const newRow = after.get(key) ?? null;
      const displayKey = primaryKey
        .map((column) => {
          const value = oldRow?.[column] ?? newRow?.[column];
          return `${column}=${value === null || value === undefined ? "null" : value}`;
        })
        .join(", ");
      return {
        key,
        displayKey,
        before: jsonSafe(oldRow),
        after: jsonSafe(newRow),
        changed: changedColumns(oldRow, newRow),
        kind: oldRow && newRow ? "update" : newRow ? "insert" : "delete",
      };
    });
}

export function assertNoExtraKeys(value, allowed, label) {
  if (!isPlainObject(value)) {
    throw new CleverSQLError(`${label} must be an object.`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new CleverSQLError(
      `${label} contains unsupported fields: ${extras.join(", ")}.`,
      { code: "UNSUPPORTED_FIELD" },
    );
  }
}

export function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}
