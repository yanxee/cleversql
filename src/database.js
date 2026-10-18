export function isPostgresTarget(target) {
  return /^postgres(ql)?:\/\//i.test(String(target ?? ""));
}

export async function createAdapter(
  target,
  {
    readOnly = false,
    schemas = ["public"],
    queryTimeoutMs = 15_000,
    ssl = null,
  } = {},
) {
  if (isPostgresTarget(target)) {
    const { PostgresAdapter } = await import("./postgres-adapter.js");
    return PostgresAdapter.open(target, {
      readOnly,
      schemas,
      queryTimeoutMs,
      ssl,
    });
  }
  const { SqliteAdapter } = await import("./sqlite-adapter.js");
  return new SqliteAdapter(target, { readOnly });
}
