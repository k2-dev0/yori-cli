-- yori-cli のテスト専用スキーマ。
-- 正本は yori の src/db/migrations/0001_init.sql:6-45 であり、ここでは管理CLIが扱う
-- companies / employees / projects / project_members / auth_tokens だけを同じ制約で再現する。
-- yori-cli は migration を持たないため、本番DBのスキーマは yori 側の migration が作る。
-- CREATE IF NOT EXISTS により、同一テストDBへの再実行を許容する。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version)
VALUES ('0001_init.sql')
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  repository_identifier text NOT NULL,
  active_generation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, repository_identifier)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, employee_id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
