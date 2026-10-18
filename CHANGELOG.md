# Changelog

## 0.2.0 — 2026-10-18

### Added

- PostgreSQL adapter with read-only and write pools.
- Supabase-compatible connection strings and SSL mode handling.
- Schema allowlisting with `--schemas`.
- PostgreSQL statement and query timeouts.
- PostgreSQL introspection for schemas, identity columns, foreign keys, and indexes.
- Transactional typed mutations using `RETURNING *`.
- `GENERATED ALWAYS AS IDENTITY` restore support for rollback.
- Real PostgreSQL integration suite.
- Copy-ready MCP configs for Codex, VS Code, Cursor, and generic clients.
- Deterministic 90-second launch demo.
- PostgreSQL role template and setup documentation.

### Changed

- Core, change engine, and HTTP handlers are async to support remote databases.
- SQLite transactional work is serialized through an internal queue.
- Table names from PostgreSQL are schema-qualified.
- Package version and public status moved to `0.2.0`.

## 0.1.0 — 2026-10-17

Initial reconstruction of CleverSQL as an agent-safe data workspace.

### Added

- SQLite schema discovery and data browser.
- Read-only SQL connection with statement and SQLite authorizer guards.
- Typed insert, update, and delete operations.
- Preview transactions with before/after snapshots and row-level diffs.
- Stale-change detection using stable row hashes.
- Apply and conflict-safe revert.
- Local JSON change store and append-only audit log.
- MCP Streamable HTTP endpoint with eight tools.
- Local zero-build web console.
- Demo SaaS dataset and guided SQL examples.
- Bearer-token gate for non-loopback binding.
- Cross-origin mutation blocking, CSP, and request limits.
- Integration tests for the complete change lifecycle and protocol.
