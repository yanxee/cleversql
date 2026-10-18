import { CleverSQLError } from "./utils.js";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const TOOLS = [
  {
    name: "cleversql_overview",
    title: "Inspect CleverSQL workspace",
    description:
      "Return database identity, safety limits, tables, row counts, and recent governed changes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_describe_table",
    title: "Describe a table",
    description:
      "Return columns, primary key, foreign keys, indexes, row count, and mutation safety for one table or view.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Exact table or view name." },
      },
      required: ["table"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_browse_rows",
    title: "Browse table rows",
    description:
      "Browse deterministic, paginated rows from one table or view. Use this before proposing a change.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["table"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_query",
    title: "Run a read-only SQL query",
    description:
      "Run one SELECT, WITH, EXPLAIN, or VALUES statement against a read-only connection. Raw write SQL is intentionally blocked.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "One read-only SQL statement." },
        params: {
          type: "array",
          description: "Positional parameters for ? placeholders.",
          items: {},
          maxItems: 100,
        },
        maxRows: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          default: 100,
        },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_preview_change",
    title: "Preview a governed change",
    description:
      "Dry-run a structured insert, update, or delete. Returns before/after rows and a changeId. This never commits data. Always inspect the diff before applying.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["insert", "update", "delete"],
        },
        table: { type: "string" },
        where: {
          description:
            "Filters. Use {id: 42} for equality or an array such as [{column:'status',op:'eq',value:'trial'}]. update/delete require at least one filter.",
          anyOf: [
            { type: "object", additionalProperties: true },
            {
              type: "array",
              maxItems: 12,
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  op: {
                    type: "string",
                    enum: [
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
                    ],
                  },
                  value: {},
                },
                required: ["column", "op"],
                additionalProperties: false,
              },
            },
          ],
        },
        values: {
          type: "object",
          description: "Column values for insert or update.",
          additionalProperties: true,
        },
        reason: {
          type: "string",
          minLength: 4,
          maxLength: 240,
          description: "Why this change is necessary. Stored in the audit trail.",
        },
        maxAffected: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Refuse the change if more rows match.",
        },
      },
      required: ["action", "table", "reason"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_apply_change",
    title: "Apply a previewed change",
    description:
      "Apply a change by id after a successful preview. Fails if the matched rows changed since preview.",
    inputSchema: {
      type: "object",
      properties: {
        changeId: { type: "string", pattern: "^chg_[a-f0-9]{14}$" },
      },
      required: ["changeId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_list_changes",
    title: "List changes",
    description:
      "List preview, applied, reverted, or expired changes with their diffs and audit reasons.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "preview", "applied", "reverted", "expired"],
          default: "all",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cleversql_revert_change",
    title: "Revert an applied change",
    description:
      "Restore the before-state of an applied change. Fails if newer edits conflict with the rollback.",
    inputSchema: {
      type: "object",
      properties: {
        changeId: { type: "string", pattern: "^chg_[a-f0-9]{14}$" },
        reason: {
          type: "string",
          maxLength: 240,
          description: "Optional reason for the rollback.",
        },
      },
      required: ["changeId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function rpcError(code, message, data) {
  return {
    jsonrpc: "2.0",
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function textResult(value, isError = false) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isError || typeof value === "string"
      ? {}
      : { structuredContent: value }),
    isError,
  };
}

function requireString(args, name) {
  if (typeof args?.[name] !== "string" || args[name].trim().length === 0) {
    throw new CleverSQLError(`${name} is required.`);
  }
  return args[name];
}

async function callTool(cleversql, name, args = {}, { actor = "mcp-agent" } = {}) {
  switch (name) {
    case "cleversql_overview":
      return cleversql.dashboard();
    case "cleversql_describe_table":
      return cleversql.table(requireString(args, "table"));
    case "cleversql_browse_rows":
      return cleversql.browseTable(requireString(args, "table"), args);
    case "cleversql_query":
      return cleversql.query(requireString(args, "sql"), args);
    case "cleversql_preview_change":
      return cleversql.previewChange(args, { actor });
    case "cleversql_apply_change":
      return cleversql.applyChange(requireString(args, "changeId"), { actor });
    case "cleversql_list_changes":
      return cleversql.listChanges(args);
    case "cleversql_revert_change":
      return cleversql.revertChange(requireString(args, "changeId"), {
        actor,
        reason: args.reason ?? "",
      });
    default:
      throw new CleverSQLError(`Unknown tool: ${name}`, {
        code: "TOOL_NOT_FOUND",
      });
  }
}

export function createMcpBridge(cleversql, { version = "0.2.0" } = {}) {
  async function handle(message, context = {}) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(-32600, "Invalid JSON-RPC request.");
    }

    if (message.id === undefined) {
      return null;
    }

    const id = message.id;
    const params = message.params ?? {};

    try {
      switch (message.method) {
        case "initialize": {
          const requested = params.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                logging: {},
              },
              serverInfo: {
                name: "cleversql",
                title: "CleverSQL",
                version,
              },
              instructions:
                "CleverSQL exposes a read-only query surface plus a governed change protocol. Use cleversql_query and schema tools freely. Never attempt raw write SQL: use cleversql_preview_change, inspect the returned diff, then cleversql_apply_change. Every change requires a reason. Use cleversql_revert_change for rollback.",
            },
          };
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "logging/setLevel":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
        case "tools/call": {
          const toolName = requireString(params, "name");
          const result = await callTool(cleversql, toolName, params.arguments ?? {}, {
            actor: context.actor ?? "mcp-agent",
          });
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(result),
          };
        }
        case "resources/list":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resources: [
                {
                  uri: "cleversql://schema",
                  name: "Database schema",
                  title: "Current CleverSQL schema",
                  description:
                    "Machine-readable tables, columns, primary keys, foreign keys, row counts, and mutation safety.",
                  mimeType: "application/json",
                },
              ],
            },
          };
        case "resources/read": {
          if (params.uri !== "cleversql://schema") {
            throw new CleverSQLError(`Unknown resource: ${params.uri}`, {
              code: "RESOURCE_NOT_FOUND",
            });
          }
          const schema = await cleversql.schemaResource();
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [
                {
                  uri: params.uri,
                  mimeType: "application/json",
                  text: JSON.stringify(schema, null, 2),
                },
              ],
            },
          };
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`,
            },
          };
      }
    } catch (error) {
      if (message.method === "tools/call") {
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(
            {
              error: error.code ?? "TOOL_ERROR",
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            },
            true,
          ),
        };
      }
      return rpcError(-32603, error.message, {
        code: error.code ?? "INTERNAL_ERROR",
      });
    }
  }

  return {
    handle,
    tools: TOOLS,
  };
}
