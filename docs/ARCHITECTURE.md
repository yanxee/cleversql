# CleverSQL architecture

## Product invariant

CleverSQL has two deliberately different data surfaces:

1. **Read surface:** broad SQL freedom on a read-only connection.
2. **Change surface:** a narrow, typed operation language with preview, review,
   conflict detection, apply, and rollback.

The change surface is the product. The SQL lab is the on-ramp.

## Process model

```text
CLI
 ├─ CleverSQL core
 │   ├─ Adapter factory
 │   │   ├─ SqliteAdapter
 │   │   └─ PostgresAdapter
 │   ├─ ChangeEngine
 │   └─ ChangeStore (.cleversql/)
 ├─ HTTP server
 │   ├─ static console
 │   ├─ JSON API
 │   └─ MCP Streamable HTTP endpoint
 └─ SQLite file
```

`0.2.0` is a single-process, local-first application and requires Node.js
24.10+ for the `node:sqlite` authorizer API. Synchronous SQLite
execution keeps transaction boundaries deterministic and prevents interleaved
preview/apply operations inside one process.

PostgreSQL uses separate read and write pools, an async-local transaction
context, and a schema allowlist. The SQLite transaction queue serializes writes;
PostgreSQL relies on database row locks, repeatable-read transactions, and row
hash checks.

## Read path

The server opens a separate SQLite connection with `readOnly: true`.

Additional defenses:

- SQL must begin with `SELECT`, `WITH`, `EXPLAIN`, or `VALUES`;
- SQLite's authorizer only permits `READ`, `SELECT`, `FUNCTION`, and `RECURSIVE`;
- `PRAGMA` is limited to schema introspection operations;
- `load_extension` is denied;
- result iteration stops at the configured row cap;
- write statements are rejected before they reach the connection.

The write connection is never used for user-authored SQL.

### PostgreSQL

User SQL runs through a separate read pool inside:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = 15000;
SELECT * FROM (<user query>) AS __cleversql_read LIMIT maxRows + 1;
ROLLBACK;
```

The schema allowlist is applied at introspection time. Dangerous functions and
direct database credentials remain a database-role concern, so the recommended
role is scoped to the exposed tables.

## Change state machine

```text
preview ──apply──> applied ──revert──> reverted
   │
   └──T+10 min──> expired
```

### Preview

1. Resolve the table and validate columns and operators.
2. Require a primary key and at least one filter for update/delete.
3. Begin an immediate transaction.
4. Select the before rows.
5. Execute the typed operation with `RETURNING *`.
6. Store the before/after snapshot and row-level diff.
7. Roll back.
8. Persist the preview and append an audit event.

Preview side effects from triggers are rolled back with the transaction.

### Apply

1. Load the preview and reject expired or non-preview states.
2. Begin an immediate transaction.
3. Re-read the matched rows.
4. Compare a stable hash against the previewed before-state.
5. Reject with `STALE_CHANGE` on any drift.
6. Execute the operation and commit.
7. Persist the applied state and audit event.

For PostgreSQL, apply uses `REPEATABLE READ`, explicit statement timeouts, and
row locks acquired by the mutation. Serialization failures surface as
`SERIALIZATION_FAILURE`; changed before-state surfaces as `STALE_CHANGE`.

### Revert

1. Load an applied change.
2. Verify the current rows still equal the applied after-state.
3. Build the inverse operation:
   - insert -> delete by primary key;
   - update -> restore prior non-key values;
   - delete -> reinsert the deleted row.
4. Apply the inverse operation atomically.
5. Reject with `REVERT_CONFLICT` if newer work is detected.
6. Persist the reverted state and audit event.

## Change storage

The default state directory is:

```text
<database-directory>/.cleversql/
  changes/<change-id>.json
  audit.jsonl
```

The state is deliberately portable and human-inspectable. It travels with the
database file and does not require a second service.

## Threat model

### In scope for v0.2

- accidental unbounded update/delete;
- agents generating dangerous raw write SQL;
- applying an outdated preview after another writer changes the same row;
- reverting over newer edits;
- accidental exposure on a LAN interface;
- cross-origin browser mutation attempts;
- path traversal in the static console;
- request-body abuse beyond 1 MB.

### Mitigations

- typed change operations and mandatory reasons;
- primary-key requirement;
- read-only SQLite connection plus authorizer;
- row-count caps and change caps;
- hash-based drift detection;
- transaction-wrapped apply and revert;
- bearer token requirement for non-loopback binding;
- same-origin validation for browser mutations;
- local security headers and CSP;
- audit ledger and persisted before/after snapshots.

### Not yet covered

- multi-user identity and single sign-on;
- row/column-level authorization policies;
- approval workflows;
- PII classification and masking;
- query cost admission control;
- malicious database triggers or hostile schema definitions;
- external tamper-evident audit storage;
- multi-process coordination across several CleverSQL servers;
- schema migrations and DDL changes.

Do not treat v0.2 as a production replacement for database access review.
Treat it as a safer boundary than giving an agent a write-capable database
credential.

## Scaling path

The adapter boundary is intentionally small:

- list and inspect objects;
- browse rows;
- execute read-only SQL;
- select rows by filters or primary keys;
- execute typed insert/update/delete operations;
- transaction wrappers.

PostgreSQL implements the same contract with:

- `BEGIN READ ONLY` for read queries;
- `information_schema` and `pg_catalog` introspection;
- `statement_timeout`;
- parameterized typed operations;
- `RETURNING *`;
- `OVERRIDING SYSTEM VALUE` for restoring `GENERATED ALWAYS` identity rows.

The change engine and MCP surface should remain database-neutral.

## Design tradeoffs

**SQLite's synchronous driver** was chosen for a deterministic local path.
Long-running SQL can block the process event loop. PostgreSQL queries have
server-side timeouts; SQLite worker-thread isolation remains future work.

**JSON files** make the audit trail portable and easy to inspect. They are not a
multi-writer database. Team mode needs a transactional metadata store.

**Typed row changes** cover the most common operational data edits but not bulk
migrations. Arbitrary write SQL remains blocked on purpose.

**Preview + apply** is not a distributed transaction. It is optimistic
concurrency control. The preview is valid only while the before-state hash
matches.

**PostgreSQL DDL and Dangerous Functions:** The read transaction prevents data
writes, but PostgreSQL still exposes side-effecting functions to sufficiently
privileged roles. CleverSQL should be connected with a least-privilege role.
