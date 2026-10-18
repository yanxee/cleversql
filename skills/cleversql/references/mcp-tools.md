# CleverSQL MCP tool reference

Use these tools through the MCP endpoint:

`http://127.0.0.1:4310/mcp`

## Read tools

### `cleversql_overview`

No arguments. Returns the database identity, safety limits, tables, row counts, and recent governed changes. Call this first in an unfamiliar workspace.

### `cleversql_describe_table`

```json
{ "table": "customers" }
```

Returns columns, primary key, foreign keys, indexes, row count, and mutation safety. Use the exact table or view name.

### `cleversql_browse_rows`

```json
{ "table": "customers", "limit": 25, "offset": 0 }
```

`limit` is 1–200; `offset` is zero or greater. Prefer this over writing ad-hoc pagination SQL.

### `cleversql_query`

```json
{
  "sql": "SELECT id, status FROM customers WHERE id = ?",
  "params": [42],
  "maxRows": 100
}
```

One `SELECT`, `WITH`, `EXPLAIN`, or `VALUES` statement. Use positional `?` parameters. Raw writes and DDL are blocked.

## Change tools

### `cleversql_preview_change`

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

- `action`: `insert`, `update`, or `delete`
- `table`: exact table name
- `where`: equality object or an array of filters
- `values`: required for insert/update
- `reason`: 4–240 characters; stored in the audit ledger
- `maxAffected`: 1–100, default 25

Filter operators: `eq`, `neq`, `in`, `like`, `gt`, `gte`, `lt`, `lte`, `is_null`, `not_null`.

`update` and `delete` require at least one filter. Preview never commits data; it returns a `changeId`, matched rows, and before/after diffs.

### `cleversql_apply_change`

```json
{ "changeId": "chg_0123456789abcd" }
```

Applies a successful preview. The rows are checked again; a stale row causes `STALE_CHANGE`.

### `cleversql_list_changes`

```json
{ "status": "all", "limit": 25 }
```

`status`: `all`, `preview`, `applied`, `reverted`, or `expired`. Use this to find the `changeId` for a rollback or to inspect the audit trail.

### `cleversql_revert_change`

```json
{
  "changeId": "chg_0123456789abcd",
  "reason": "Restore the previous status after a bad import"
}
```

Restores the captured before-state. If newer edits conflict, the revert fails rather than overwriting them.

## Failure handling

| Error | Action |
| --- | --- |
| `STALE_CHANGE` | Re-read the rows with `browse_rows`, preview again, and review the new diff. |
| `CHANGE_EXPIRED` | Preview the change again. |
| More rows than `maxAffected` | Narrow the filters or raise `maxAffected` after confirming the blast radius. |
| `DATABASE_READ_ONLY` | The server is in read-only mode; report it instead of bypassing. |
| `UNAUTHORIZED` | Use the server's bearer token; do not print it. |

Never replace a failed typed change with raw write SQL. The typed preview/apply path is the safety contract.
