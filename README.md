# CleverSQL

[![CI](https://github.com/yanxee/cleversql/actions/workflows/ci.yml/badge.svg)](https://github.com/yanxee/cleversql/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-c8ff62.svg)](LICENSE)
[![Node.js 24.10+](https://img.shields.io/badge/node-%3E%3D24.10-c8ff62.svg)](package.json)

**The agent-safe data workspace.**

> Query freely. Change carefully.

![CleverSQL — Query freely. Change carefully.](docs/images/hero.svg)

CleverSQL gives humans and AI agents one local interface for database discovery,
read-only SQL, and governed data changes. Reads are open by design. Writes are
previewed inside a rolled-back transaction, checked for drift, applied as a
verified diff, and reversible from the audit ledger.

This is not another text-to-SQL demo. It is the missing control plane between an
agent and data that actually matters.

## 30-second demo

```bash
npm install
npm start
```

The demo creates a deterministic SaaS dataset, starts the console at
`http://127.0.0.1:4310`, and exposes an MCP endpoint at
`http://127.0.0.1:4310/mcp`.

No build step is required. Node.js 24.10+ is required. SQLite uses Node's
built-in driver; PostgreSQL uses `pg`.

## Why this exists

Most database tools optimize for one of two things:

1. helping a human write a query; or
2. letting an agent generate more SQL.

Both leave the dangerous part untouched: **changing production data**.

Agents need more than a database connection. They need a machine-readable schema,
a bounded write language, a way to inspect intent before commit, conflict
detection when the world changes, an audit trail, and a safe rollback path.

CleverSQL turns those requirements into the product contract:

```text
inspect -> query -> preview -> review diff -> apply -> revert
```

## The change protocol

Agents do not submit raw write SQL. They submit a typed operation:

```json
{
  "action": "update",
  "table": "customers",
  "where": { "id": 42 },
  "values": { "status": "active" },
  "reason": "Activate the account after annual payment cleared",
  "maxAffected": 1
}
```

Preview runs the operation in `BEGIN IMMEDIATE`, captures the before and after
rows, returns a row-level diff, and rolls the transaction back.

Apply re-checks the matched rows and fails with `STALE_CHANGE` if anything moved.
Every successful apply is stored in the local change ledger and can be reverted
later. Revert also checks for newer edits before restoring the prior values.

## MCP in one line

Point any MCP client at:

```json
{
  "mcpServers": {
    "cleversql": {
      "url": "http://127.0.0.1:4310/mcp"
    }
  }
}
```

For Codex:

```bash
codex mcp add cleversql --url http://127.0.0.1:4310/mcp
```

The console's **Connect** page generates copy-ready configurations for Codex,
VS Code, Cursor, and generic MCP clients.

Codex MCP reference:
[developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp)

The server implements MCP over Streamable HTTP and exposes eight tools:

| Tool | Purpose |
| --- | --- |
| `cleversql_overview` | Workspace, schema summary, limits, recent changes |
| `cleversql_describe_table` | Columns, keys, indexes, mutation safety |
| `cleversql_browse_rows` | Deterministic, paginated row access |
| `cleversql_query` | Read-only SQL on a read-only connection |
| `cleversql_preview_change` | Typed write dry-run with row diff |
| `cleversql_apply_change` | Apply a verified preview |
| `cleversql_list_changes` | Audit ledger |
| `cleversql_revert_change` | Conflict-safe rollback |

Raw `INSERT`, `UPDATE`, `DELETE`, DDL, `ATTACH`, and other write operations are
blocked on the read surface.

## Console

The local web console is a first-class surface, not an afterthought:

- schema browser with columns, primary keys, foreign keys, indexes, and rows;
- SQL lab with guided queries and structured results;
- governed change builder with row snapshots and red/green diffs;
- searchable change ledger with apply and rollback;
- MCP connection details and an auditable tool contract.

Everything is served by the same process and backed by the same change engine
that agents use.

## Safety model

- **Reads are bounded.** Query rows and change scope have configurable limits.
- **Writes are typed.** There is no raw write SQL endpoint.
- **Writes require identity.** Tables without a primary key cannot be mutated.
- **Writes require intent.** Every change needs a human-readable reason.
- **Previews are real dry-runs.** SQL executes in a transaction and is rolled back.
- **Stale intent fails closed.** A changed row invalidates the preview.
- **Rollbacks are verified.** Revert refuses to overwrite newer work.
- **Audit is local and portable.** Snapshots and `audit.jsonl` live under
  `.cleversql/` beside the database.
- **Localhost by default.** Binding to a non-loopback address requires a bearer
  token.

This is a strong v0.2 safety baseline, not a complete enterprise governance
suite. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the threat model and
current limits.

## Run against a SQLite database

```bash
node bin/cleversql.js ./app.db
node bin/cleversql.js ./app.db --read-only
node bin/cleversql.js ./app.db --host 0.0.0.0 --token
```

## Run against PostgreSQL or Supabase

```bash
export DATABASE_URL='postgresql://user:password@host:5432/database?sslmode=require'
node bin/cleversql.js "$DATABASE_URL" --schemas public
```

CleverSQL uses:

- a separate read-only transaction for user SQL;
- `REPEATABLE READ` governed write transactions;
- parameterized typed mutations with `RETURNING *`;
- schema-qualified object names such as `public.customers`;
- a configurable statement timeout;
- an explicit schema allowlist.

Supabase connection strings work directly. Use a dedicated database role scoped
to the schemas and tables CleverSQL should touch. See
[docs/POSTGRES.md](docs/POSTGRES.md) for the recommended grants.

Useful PostgreSQL options:

```text
--schemas public           Only expose one schema
--schemas public,private   Expose several schemas
--schemas all              Expose every non-system schema
--query-timeout-ms 15000   Statement timeout
--read-only                Disable governed writes
--ssl / --no-ssl           Override SSL mode detection
```

Useful options:

```text
--port <number>         HTTP port (default: 4310)
--state <directory>     Change snapshots and audit log location
--read-only             Disable the governed write surface
--schemas <list>        PostgreSQL schema allowlist
--query-timeout-ms <n>  Database statement timeout
--max-rows <number>     Query result cap (default: 500)
--max-changes <number>  Rows allowed per change (default: 25, max: 100)
--token [secret]        Require a bearer token; generates one if omitted
```

## Tests

```bash
npm test
npm run check
```

The test suite covers read-only enforcement, preview rollback, apply, stale
conflict rejection, delete/insert reverts, MCP initialization/tool calls,
authentication, and cross-origin mutation blocking.

PostgreSQL integration tests run when a test database is available:

```bash
CLEVERSQL_TEST_POSTGRES_URL='postgresql://...' npm run test:postgres
```

## 90-second launch demo

```bash
npm run demo:90s
```

The script demonstrates read access, a rolled-back preview, a stale-intent
conflict caused by another writer, re-preview, apply, and audited rollback. The
screen-recording script is in [docs/DEMO.md](docs/DEMO.md).

## Project layout

```text
bin/cleversql.js       CLI and startup
src/sqlite-adapter.js  Schema introspection and connection-level guards
src/postgres-adapter.js PostgreSQL read/write pools and typed mutations
src/change-engine.js   Preview, conflict detection, apply, revert
src/change-store.js    Local snapshots and audit ledger
src/mcp.js             MCP Streamable HTTP protocol and tools
src/server.js          Local console API and static server
public/                Zero-build web console
test/                  Integration and safety tests
docs/                  Architecture, strategy, and roadmap
```

## Status

`0.2.0` supports SQLite and PostgreSQL/Supabase, one local process, local audit,
and a typed row-level change protocol.

The next wedge is scoped agent credentials, reusable policy rules, and team
approvals. See [docs/ROADMAP.md](docs/ROADMAP.md).


## Origin

The original CleverSQL concept dates to 2017: describe a table, view, procedure,
function, or SQL statement once, then expose a uniform web data interface with
parameters, filters, sorting, paging, and alias mapping.

That instinct was an early database-to-API compiler. The 2026 version keeps the
data-first abstraction but moves the hard problem to where it now matters: safe,
reviewable, reversible changes by both humans and agents.

## License

MIT
