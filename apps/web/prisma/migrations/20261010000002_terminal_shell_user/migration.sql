DROP INDEX IF EXISTS terminal_one_open_per_server;

ALTER TABLE terminal_sessions
  ADD COLUMN shell_user text NOT NULL DEFAULT 'root';

CREATE INDEX terminal_session_server_status_idx
  ON terminal_sessions(server_id, status, created_at);
