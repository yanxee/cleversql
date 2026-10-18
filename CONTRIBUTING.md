# Contributing to CleverSQL

CleverSQL is a safety-focused tool. Contributions should preserve the core
invariant:

> Reads are deliberately broad. Writes are deliberately narrow, reviewable,
> conflict-aware, and reversible.

## Local setup

```bash
npm ci
npx --no-install cleversql demo
```

The SQLite demo runs on Node.js 24.10+ without a separate database service.

## Before opening a pull request

```bash
npm test
npm run check
```

With a PostgreSQL test database:

```bash
CLEVERSQL_TEST_POSTGRES_URL='postgresql://...' npm run test:postgres
```

## Change protocol

- Do not add an endpoint that accepts arbitrary write SQL.
- Keep preview in a transaction that is rolled back.
- Preserve optimistic concurrency checks between preview and apply.
- Keep revert conflict-safe; never overwrite newer writes silently.
- Add or update tests for every safety-boundary change.
- Avoid logging database credentials or full connection strings.

## Scope

Good first contributions are adapters, introspection improvements, agent-client
compatibility, policy primitives, query limits, and tests. Large product
direction changes should start with an issue before implementation.
