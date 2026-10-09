ALTER TABLE environments ADD COLUMN runtime_status text NOT NULL DEFAULT 'stopped' CHECK(runtime_status IN ('running','stopped'));
