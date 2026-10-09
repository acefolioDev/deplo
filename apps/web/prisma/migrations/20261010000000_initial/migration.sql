-- 001_initial.sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE login_attempts (
  key_hash text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_key_time_idx ON login_attempts(key_hash, occurred_at);
CREATE TABLE servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  ip text,
  description text,
  status text NOT NULL DEFAULT 'unpaired' CHECK (status IN ('unpaired','online','offline','revoked')),
  agent_version text,
  docker_available boolean NOT NULL DEFAULT false,
  caddy_available boolean NOT NULL DEFAULT false,
  metrics jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);
CREATE TABLE pairing_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_credentials_server_idx ON agent_credentials(server_id);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);
CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name IN ('production','staging')),
  image_ref text,
  container_port integer NOT NULL DEFAULT 3000 CHECK (container_port BETWEEN 1 AND 65535),
  memory_mb integer NOT NULL DEFAULT 256 CHECK (memory_mb BETWEEN 32 AND 32768),
  cpu_quota integer NOT NULL DEFAULT 100000 CHECK (cpu_quota BETWEEN 10000 AND 800000),
  health_path text NOT NULL DEFAULT '/health',
  active_deployment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  image_ref text NOT NULL,
  image_digest text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','healthy','failed','cancelled')),
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
ALTER TABLE environments ADD CONSTRAINT environments_active_deployment_fk FOREIGN KEY(active_deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;
CREATE INDEX deployments_env_created_idx ON deployments(environment_id, created_at DESC);
CREATE UNIQUE INDEX deployments_active_idx ON deployments(environment_id) WHERE status IN ('queued','running');
CREATE TABLE deployment_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id),
  environment_id uuid NOT NULL REFERENCES environments(id),
  deployment_id uuid REFERENCES deployments(id),
  kind text NOT NULL CHECK(kind IN ('deploy','stop','restart','logs')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','failed')),
  attempt integer NOT NULL DEFAULT 0,
  lease_hash text,
  lease_expires_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(deployment_id,kind)
);
CREATE INDEX deployment_jobs_poll_idx ON deployment_jobs(server_id,status,created_at);
CREATE TABLE environment_variables (
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment_id,name)
);
CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','configured','error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_user_time_idx ON audit_logs(user_id,created_at DESC);

-- 002_runtime_options.sql
ALTER TABLE environments ADD COLUMN volume_path text;
ALTER TABLE environments ADD COLUMN registry_username text;
ALTER TABLE environments ADD COLUMN registry_token_ciphertext text;

-- 003_runtime_status.sql
ALTER TABLE environments ADD COLUMN runtime_status text NOT NULL DEFAULT 'stopped' CHECK(runtime_status IN ('running','stopped'));

-- 004_architecture.sql
ALTER TABLE servers ADD COLUMN architecture text;

-- 005_rotation.sql
ALTER TABLE agent_credentials ADD COLUMN pending boolean NOT NULL DEFAULT false;
ALTER TABLE agent_credentials ADD COLUMN expires_at timestamptz;

-- 006_log_retention.sql
CREATE UNIQUE INDEX deployment_jobs_one_active_logs ON deployment_jobs(environment_id,kind) WHERE kind='logs' AND status IN ('pending','leased');
CREATE INDEX deployment_jobs_log_retention ON deployment_jobs(kind,finished_at);

-- 007_terminal.sql
ALTER TABLE servers ADD COLUMN terminal_available boolean NOT NULL DEFAULT false;

CREATE TABLE terminal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  cols integer NOT NULL DEFAULT 80 CHECK (cols BETWEEN 20 AND 300),
  rows integer NOT NULL DEFAULT 24 CHECK (rows BETWEEN 5 AND 100)
);
CREATE UNIQUE INDEX terminal_one_open_per_server ON terminal_sessions(server_id) WHERE status IN ('pending','active');
CREATE INDEX terminal_session_expiry ON terminal_sessions(expires_at);

CREATE TABLE terminal_inputs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  data text NOT NULL
);
CREATE INDEX terminal_inputs_session_id ON terminal_inputs(session_id,id);

CREATE TABLE terminal_outputs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  data text NOT NULL
);
CREATE INDEX terminal_outputs_session_id ON terminal_outputs(session_id,id);

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
