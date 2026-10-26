const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BadRequestError extends Error {}

export interface ArticleRow {
	id: number;
	topic: string;
	headline: string;
	source: string;
	published_at: string | null;
	url: string;
	summary: string | null;
	relevance_score: number | null;
	fetched_at: string;
}

/**
 * GET /articles filters (all optional):
 *   topic      exact topic id, e.g. nfl, stock_market, weather
 *   from, to   publication date range, YYYY-MM-DD, both inclusive
 *   source     publication name, case-insensitive exact match
 *   min_score  minimum relevance score, 1-10
 *   limit      max rows, default 50, max 200
 */
export async function listArticles(db: D1Database, params: URLSearchParams) {
	const where: string[] = [];
	const binds: (string | number)[] = [];

	const topic = params.get("topic");
	if (topic) {
		where.push("topic = ?");
		binds.push(topic);
	}

	const from = params.get("from");
	if (from) {
		if (!DATE_RE.test(from)) throw new BadRequestError("from must be YYYY-MM-DD");
		where.push("published_at >= ?");
		binds.push(from);
	}

	const to = params.get("to");
	if (to) {
		if (!DATE_RE.test(to)) throw new BadRequestError("to must be YYYY-MM-DD");
		// published_at may be a bare date or a full timestamp; "< next day" covers both.
		const next = new Date(`${to}T00:00:00Z`);
		next.setUTCDate(next.getUTCDate() + 1);
		where.push("published_at < ?");
		binds.push(next.toISOString().slice(0, 10));
	}

	const source = params.get("source");
	if (source) {
		where.push("source = ? COLLATE NOCASE");
		binds.push(source);
	}

	const minScore = params.get("min_score");
	if (minScore) {
		const n = Number(minScore);
		if (!Number.isInteger(n) || n < 1 || n > 10) throw new BadRequestError("min_score must be an integer 1-10");
		where.push("relevance_score >= ?");
		binds.push(n);
	}

	let limit = DEFAULT_LIMIT;
	const limitParam = params.get("limit");
	if (limitParam) {
		limit = Number(limitParam);
		if (!Number.isInteger(limit) || limit < 1) throw new BadRequestError("limit must be a positive integer");
		limit = Math.min(limit, MAX_LIMIT);
	}

	const sql = `SELECT * FROM articles
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
		LIMIT ?`;
	const { results } = await db
		.prepare(sql)
		.bind(...binds, limit)
		.all<ArticleRow>();

	return { count: results.length, articles: results };
}
