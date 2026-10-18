# CleverSQL roadmap

## Positioning

**The safe data layer for humans and agents.**

CleverSQL should win because it owns the transition from *data intent* to
*verified database change*, not because it has the best SQL autocomplete.

## Non-goals

- another general-purpose chat box for SQL;
- a full BI platform;
- a schema migration framework;
- an admin panel generator that sacrifices operational safety for screens;
- unrestricted write-capable database credentials for agents.

## v0.1 — Trust foundation

Status: implemented in this repository.

- SQLite adapter;
- read-only SQL connection and authorizer;
- schema browser;
- typed insert/update/delete;
- preview in a rolled-back transaction;
- row-level diff;
- stale-preview rejection;
- apply and conflict-safe revert;
- local audit ledger;
- MCP Streamable HTTP with eight tools;
- local web console;
- bearer token for external binding;
- automated safety and protocol tests.

## v0.2 — Make adoption effortless

Status: core shipped.

- PostgreSQL via URL;
- Supabase-compatible SSL and schema allowlisting;
- explicit primary-key, identity, and rollback semantics;
- `npx cleversql <url>`;
- one-command/copy-ready MCP setup snippets for Codex, VS Code, Cursor, and
  generic clients;
- 90-second launch demo;
- PostgreSQL role template;
- database statement timeouts.

Still useful follow-ups: MySQL, Docker image, CSV import, query history, schema
annotations, PII detection, SQLite worker isolation, and an OpenAPI schema.

Success target: first query in under 60 seconds; first governed change in under
three minutes.

## v0.3 — Team safety

- project/workspace model;
- user accounts and SSO;
- scoped agent tokens;
- policy DSL for table, action, row, column, environment, and actor;
- approvals for high-risk changes;
- Slack/webhook approval flow;
- per-agent rate and blast-radius limits;
- immutable audit export to S3/GCS/Postgres;
- signed change envelopes;
- dual-control mode for sensitive tables.

The key product moment: a reviewer sees an agent's exact intended diff and can
approve, reject, or request a narrower scope without opening a SQL client.

## v0.4 — Operational intelligence

- drift-aware change suggestions;
- schema lineage and impact analysis;
- policy simulation against historical changes;
- data-residency and redaction policies;
- change bundles for multi-table operations;
- time-bounded emergency access;
- "agent incident replay" from the audit graph;
- native support for MCP resources, prompts, and elicitation where available.

## v1.0 — The agent data control plane

The mature product is not a database UI. It is the contract every agent uses
before touching operational data:

```text
identity -> policy -> discovery -> intent -> preview -> approval -> commit -> proof
```

Users should be able to revoke a generic database service account and replace it
with a CleverSQL agent credential that is narrower, observable, reviewable, and
reversible.

## Distribution strategy

### Launch wedge

1. **The 90-second demo.** Seed a realistic SaaS database, run one query, preview
   a row change, show the diff, apply, undo. Publish the recording.
2. **Open protocol.** Publish the change-plan JSON schema and MCP tool contract.
   Let other agent runtimes call CleverSQL without needing the console.
3. **Agent integrations.** Ship recipes for coding agents, desktop agents,
   support copilots, and internal operations bots.
4. **"Stop giving agents root."** Lead with the security and accountability
   story, not generic AI productivity.
5. **One-file shareability.** A demo database plus audit ledger is easy to
   inspect, fork, record, and discuss.

### Proof points to publish

- preview does not mutate data;
- stale preview is rejected;
- rollback refuses to overwrite newer work;
- every MCP write is tied to an actor and reason;
- read-only surface rejects raw writes even when the agent asks directly;
- zero runtime dependencies for the SQLite path.

### Community flywheel

- adapters and policies as first-class extension points;
- "safe change recipes" contributed by users;
- benchmark corpus of agent tasks with irreversible-write traps;
- public incident write-ups where CleverSQL prevented or contained a bad change;
- compatibility tests for MCP clients and agent frameworks.

## Metrics that matter

- time to first successful query;
- time to first successful preview and apply;
- percentage of agent write attempts that go through preview;
- stale-change detection rate;
- revert success rate;
- number of generic write credentials retired;
- repeat weekly active workspaces;
- tool calls per connected agent;
- unapproved-write count, which must remain zero.

Stars are lagging distribution. Trust is the leading product metric.
