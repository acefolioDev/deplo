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
