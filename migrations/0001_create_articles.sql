-- News articles fetched per topic, with AI-generated summary and relevance score.
-- Timestamps are ISO 8601 UTC strings (e.g. 2026-10-26T20:45:00.000Z).
CREATE TABLE articles (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	topic TEXT NOT NULL,
	headline TEXT NOT NULL,
	source TEXT NOT NULL,
	published_at TEXT,
	url TEXT NOT NULL UNIQUE,
	summary TEXT,
	relevance_score INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
	fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_articles_topic_published ON articles (topic, published_at DESC);
