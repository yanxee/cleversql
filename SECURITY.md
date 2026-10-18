# Security policy

CleverSQL is designed to reduce accidental data loss and unsafe agent writes. It
is not yet a hardened multi-tenant database gateway.

## Supported versions

Security fixes are currently provided for the latest `0.2.x` release.

## Reporting a vulnerability

Please report vulnerabilities privately to the repository maintainer rather than
opening a public issue. Include:

- affected version;
- database driver;
- reproduction steps;
- whether the issue crosses the local read-only boundary, the governed write
  boundary, authentication, or the static console;
- expected and actual behavior.

## Deployment guidance

- Keep the default `127.0.0.1` binding for local use.
- Use `--token` whenever binding to another interface.
- Put the service behind TLS and a trusted reverse proxy if it is network
  accessible.
- Do not expose the service directly to the public internet.
- Run against a database credential scoped to the data CleverSQL actually needs.
- For PostgreSQL/Supabase, use the role template in
  [scripts/postgres-role.sql](scripts/postgres-role.sql) and never a superuser.
- Keep `.cleversql/` and the database in a backup policy that matches your audit
  retention requirements.

## Current security boundary

The v0.2 guarantees and known limitations are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The most important limitation is
that v0.2 has local bearer-token authentication, not a complete user, role, SSO,
or row-level policy system.
