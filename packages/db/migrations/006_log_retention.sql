CREATE UNIQUE INDEX deployment_jobs_one_active_logs ON deployment_jobs(environment_id,kind) WHERE kind='logs' AND status IN ('pending','leased');
CREATE INDEX deployment_jobs_log_retention ON deployment_jobs(kind,finished_at);
