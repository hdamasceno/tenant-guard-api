-- Row-level security: the database's own guard against cross-tenant reads/writes.
--
-- Requests run inside a transaction that does
--   SET LOCAL ROLE app_tenant;
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- so every statement in that transaction is limited to one tenant's rows,
-- even raw SQL that forgot its WHERE clause. The app_tenant role has no login
-- and no password; the API's connection user switches into it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END
$$;

GRANT app_tenant TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Course", "Student", "Enrollment" TO app_tenant;
-- Global tables stay readable so joins and lookups work; writes are not granted.
GRANT SELECT ON "Tenant", "User", "Membership" TO app_tenant;

-- current_setting(..., true) returns NULL when unset, so no tenant means no rows.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

ALTER TABLE "Course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Student" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Enrollment" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "Course" TO app_tenant
  USING ("tenantId" = app_current_tenant())
  WITH CHECK ("tenantId" = app_current_tenant());

CREATE POLICY tenant_isolation ON "Student" TO app_tenant
  USING ("tenantId" = app_current_tenant())
  WITH CHECK ("tenantId" = app_current_tenant());

CREATE POLICY tenant_isolation ON "Enrollment" TO app_tenant
  USING ("tenantId" = app_current_tenant())
  WITH CHECK ("tenantId" = app_current_tenant());
