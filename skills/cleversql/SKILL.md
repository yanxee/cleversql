---
name: cleversql
description: Inspect, query, and safely change SQLite or PostgreSQL data through CleverSQL's agent-safe workspace, including previewed writes, conflict detection, audit, and revert. Use when the user names CleverSQL or asks for governed AI-agent database changes; do not use it for ordinary SQL generation or unrelated database administration.
metadata:
  short-description: Agent-safe SQLite/PostgreSQL access
---

# CleverSQL

CleverSQL exposes a read-only SQL surface plus a typed write protocol:

`inspect -> query -> preview -> review diff -> apply -> revert`

## Start the server

Node.js 24.10 or newer is required. Run `npm install` once in the CleverSQL checkout.

Use the bundled wrapper so the checkout is found without hardcoding the current directory:

- Demo: `node scripts/cleversql.mjs demo --no-open`
- SQLite: `node scripts/cleversql.mjs "C:\path\app.db" --no-open`
- PostgreSQL/Supabase: `node scripts/cleversql.mjs "$DATABASE_URL" --schemas public --no-open`
- Read-only mode: add `--read-only`

Set `CLEVERSQL_HOME` to the checkout root if the wrapper cannot find it. Run the server in a persistent terminal; do not restart it between tool calls.

- Console: `http://127.0.0.1:4310`
- MCP endpoint: `http://127.0.0.1:4310/mcp`
- Connect Codex: `codex mcp add cleversql --url http://127.0.0.1:4310/mcp`

For a non-loopback bind, add `--token`. Keep the token and database DSN out of logs, screenshots, and commits.

## Workflow

Reads:

1. `cleversql_overview` for workspace limits and recent changes.
2. `cleversql_describe_table` before relying on columns, keys, or mutation safety.
3. `cleversql_browse_rows` for deterministic pagination.
4. `cleversql_query` for one `SELECT`, `WITH`, `EXPLAIN`, or `VALUES` statement.

Writes:

1. Inspect the table and current rows first.
2. Call `cleversql_preview_change` with a typed operation, a narrow `where`, a `reason`, and `maxAffected`.
3. Review the returned `changeId`, matched rows, and before/after diff.
4. Call `cleversql_apply_change` only when the diff matches the user's intent.
5. Use `cleversql_list_changes` for audit and `cleversql_revert_change` for a requested or clearly necessary rollback.

Example preview:

```json
{
  "action": "update",
  "table": "customers",
  "where": { "id": 42 },
  "values": { "status": "active" },
  "reason": "Activate the account after payment cleared",
  "maxAffected": 1
}
```

## Rules

- Never send raw `INSERT`, `UPDATE`, `DELETE`, DDL, or `ATTACH` through `cleversql_query`; use the typed change tools.
- `update` and `delete` require at least one filter. Prefer a primary key; set `maxAffected` to the expected number of rows.
- Do not apply a preview whose diff, row count, or affected columns are unexpected.
- `STALE_CHANGE` means the rows moved after preview. Re-read them and preview again; never retry the old apply blindly.
- `CHANGE_EXPIRED` means preview again.
- `DATABASE_READ_ONLY` or `UNAUTHORIZED` is a server mode boundary; report it rather than bypassing it.
- Revert only when the user asks for a rollback or the applied change is clearly wrong. Explain what will be restored first.
- Treat v0.2.0 as local-first. Do not run it against production without explicit authorization and a reviewed database role.
- The `--state` directory contains before/after snapshots and the audit ledger. Keep it private and back it up.

## Tool map

| Tool | Use |
| --- | --- |
| `cleversql_overview` | Database identity, limits, tables, recent changes |
| `cleversql_describe_table` | Columns, keys, indexes, mutation safety |
| `cleversql_browse_rows` | Paginated rows before a change |
| `cleversql_query` | Read-only SQL |
| `cleversql_preview_change` | Typed write dry-run with diff and `changeId` |
| `cleversql_apply_change` | Apply a preview with stale-row checks |
| `cleversql_list_changes` | Preview/applied/reverted audit ledger |
| `cleversql_revert_change` | Conflict-safe rollback |

See [references/mcp-tools.md](references/mcp-tools.md) for exact arguments, returns, and recovery details.
