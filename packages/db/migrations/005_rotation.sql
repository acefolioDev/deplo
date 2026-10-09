ALTER TABLE agent_credentials ADD COLUMN pending boolean NOT NULL DEFAULT false;
ALTER TABLE agent_credentials ADD COLUMN expires_at timestamptz;
