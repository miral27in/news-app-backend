-- One row per pipeline run; used to rate-limit keyless (public dashboard) refreshes.
CREATE TABLE agent_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	started_at TEXT NOT NULL,
	trigger TEXT NOT NULL
);
