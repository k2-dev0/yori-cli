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

-- ここから yori migration 0010_custom_redaction.sql 相当。
-- yori-cliは0010のtableへliteralを登録するため、test fixtureも同じ制約を再現する。
-- project_repositoriesのFKが参照するprojectsの組UNIQUEを先に用意する。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_id_company_id_unique') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_id_company_id_unique UNIQUE (id, company_id);
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('0010_custom_redaction.sql')
ON CONFLICT (version) DO NOTHING;

CREATE OR REPLACE FUNCTION yori_is_redaction_placeholder_fragment(value text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        '[REDACTED:custom]',
        '[REDACTED:private_key]',
        '[REDACTED:aws_access_key]',
        '[REDACTED:google_api_key]',
        '[REDACTED:github_token]',
        '[REDACTED:slack_token]',
        '[REDACTED:openai_key]',
        '[REDACTED:jwt]',
        '[REDACTED:url_credentials]',
        '[REDACTED:authorization]',
        '[REDACTED:env_value]'
      ]) AS placeholder
     WHERE position(value in placeholder) > 0
  );
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS company_redaction_policies (
  company_id uuid PRIMARY KEY REFERENCES companies (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_redaction_rules (
  company_id uuid NOT NULL REFERENCES company_redaction_policies (company_id) ON DELETE CASCADE,
  literal text NOT NULL,
  PRIMARY KEY (company_id, literal),
  CONSTRAINT company_redaction_rules_literal_not_empty CHECK (literal <> ''),
  CONSTRAINT company_redaction_rules_literal_not_placeholder_fragment CHECK (NOT yori_is_redaction_placeholder_fragment(literal)),
  CONSTRAINT company_redaction_rules_literal_length CHECK (char_length(literal) <= 512)
);

CREATE OR REPLACE FUNCTION company_redaction_rules_enforce_limit() RETURNS trigger AS $$
DECLARE
  rule_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id = OLD.company_id THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM company_redaction_policies WHERE company_id = NEW.company_id FOR UPDATE;
  SELECT count(*) INTO rule_count FROM company_redaction_rules WHERE company_id = NEW.company_id;
  IF rule_count >= 100 THEN
    RAISE EXCEPTION 'company_redaction_rules exceeds the 100 rule limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_redaction_rules_enforce_limit ON company_redaction_rules;
CREATE TRIGGER company_redaction_rules_enforce_limit
  BEFORE INSERT OR UPDATE ON company_redaction_rules
  FOR EACH ROW EXECUTE FUNCTION company_redaction_rules_enforce_limit();

CREATE TABLE IF NOT EXISTS project_repositories (
  project_id uuid NOT NULL,
  company_id uuid NOT NULL,
  repository_identifier text NOT NULL,
  PRIMARY KEY (project_id, repository_identifier),
  CONSTRAINT project_repositories_project_company_fkey
    FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id) ON DELETE CASCADE,
  CONSTRAINT project_repositories_company_repository_unique UNIQUE (company_id, repository_identifier)
);

CREATE OR REPLACE FUNCTION project_repositories_enforce_company_repository_unique() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text || '|' || NEW.repository_identifier)::bigint);
  IF EXISTS (
    SELECT 1
      FROM projects p
     WHERE p.company_id = NEW.company_id
       AND p.repository_identifier = NEW.repository_identifier
       AND p.id <> NEW.project_id
  ) THEN
    RAISE EXCEPTION 'repository_identifier is already the primary repository of another project in this company'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_repositories_enforce_company_repository_unique ON project_repositories;
CREATE TRIGGER project_repositories_enforce_company_repository_unique
  BEFORE INSERT OR UPDATE ON project_repositories
  FOR EACH ROW EXECUTE FUNCTION project_repositories_enforce_company_repository_unique();

CREATE OR REPLACE FUNCTION projects_enforce_company_repository_unique() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id = OLD.company_id AND NEW.repository_identifier = OLD.repository_identifier THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text || '|' || NEW.repository_identifier)::bigint);
  IF EXISTS (
    SELECT 1
      FROM project_repositories pr
     WHERE pr.company_id = NEW.company_id
       AND pr.repository_identifier = NEW.repository_identifier
       AND pr.project_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'repository_identifier is already an alias of another project in this company'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_enforce_company_repository_unique ON projects;
CREATE TRIGGER projects_enforce_company_repository_unique
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_enforce_company_repository_unique();

INSERT INTO project_repositories (project_id, company_id, repository_identifier)
SELECT id, company_id, repository_identifier
  FROM projects
ON CONFLICT DO NOTHING;
