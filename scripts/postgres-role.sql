-- CleverSQL PostgreSQL role template
--
-- Replace:
--   your_database
--   replace-with-a-strong-secret
--   the schema and table names with the smallest scope you can operate with.

CREATE ROLE cleversql_agent LOGIN PASSWORD 'replace-with-a-strong-secret';

GRANT CONNECT ON DATABASE your_database TO cleversql_agent;
GRANT USAGE ON SCHEMA public TO cleversql_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cleversql_agent;

-- Governed writes are still limited to these tables.
GRANT INSERT, UPDATE, DELETE
  ON TABLE public.customers
  TO cleversql_agent;

GRANT INSERT, UPDATE, DELETE
  ON TABLE public.subscriptions
  TO cleversql_agent;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO cleversql_agent;

-- Verify the effective grants.
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'cleversql_agent'
ORDER BY table_schema, table_name, privilege_type;
