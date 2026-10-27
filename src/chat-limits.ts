// Hourly limits for chat requests that come from the public dashboard (through the Pages proxy). Callers using
// the password directly (curl, scripts) aren't limited. Every counted request costs Anthropic credit, so the
// limits bound what an anonymous visitor, or all visitors together, can spend per hour.
export const CHAT_PER_VISITOR_PER_HOUR = 10;
export const CHAT_TOTAL_PER_HOUR = 60;
const WINDOW_MS = 60 * 60 * 1000;

/** Salted SHA-256 of the client IP, truncated: enough to count a visitor's requests without storing their address. */
async function hashIp(ip: string, salt: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
	return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secondsUntilFree(oldest: string | null, now: number): number {
	const freeAt = (oldest ? Date.parse(oldest) : now) + WINDOW_MS;
	return Math.max(1, Math.ceil((freeAt - now) / 1000));
}

/**
 * Counts this request against the hourly limits. Returns 0 when it's allowed (and records it), otherwise the
 * number of seconds until the caller may try again.
 */
export async function recordDashboardChat(db: D1Database, clientIp: string | undefined, salt: string, now = Date.now()): Promise<number> {
	const ipHash = await hashIp(clientIp || "unknown", salt);
	const since = new Date(now - WINDOW_MS).toISOString();

	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
			        COALESCE(SUM(ip_hash = ?1), 0) AS mine,
			        MIN(created_at) AS oldest,
			        MIN(CASE WHEN ip_hash = ?1 THEN created_at END) AS oldest_mine
			 FROM chat_requests WHERE created_at >= ?2`,
		)
		.bind(ipHash, since)
		.first<{ total: number; mine: number; oldest: string | null; oldest_mine: string | null }>();

	if (row && row.mine >= CHAT_PER_VISITOR_PER_HOUR) return secondsUntilFree(row.oldest_mine, now);
	if (row && row.total >= CHAT_TOTAL_PER_HOUR) return secondsUntilFree(row.oldest, now);

	await db.batch([
		db.prepare("INSERT INTO chat_requests (created_at, ip_hash) VALUES (?, ?)").bind(new Date(now).toISOString(), ipHash),
		// Housekeeping: nothing older than a day is ever read.
		db.prepare("DELETE FROM chat_requests WHERE created_at < ?").bind(new Date(now - 24 * WINDOW_MS).toISOString()),
	]);
	return 0;
}
