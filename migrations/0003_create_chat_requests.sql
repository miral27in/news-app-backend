-- One row per dashboard chat request (client IP stored only as a salted hash); used for hourly rate limits.
CREATE TABLE chat_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at TEXT NOT NULL,
	ip_hash TEXT NOT NULL
);

CREATE INDEX idx_chat_requests_created ON chat_requests (created_at);
