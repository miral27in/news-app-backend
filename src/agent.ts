import Anthropic from "@anthropic-ai/sdk";
import { ARTICLES_PER_RUN, MAX_ARTICLES_PER_TOPIC, TOPICS } from "./topics";

const MODEL = "claude-opus-5-5";
const MAX_CONTINUATIONS = 5;

type Topic = (typeof TOPICS)[number];

interface CandidateArticle {
	headline: string;
	source: string;
	published_at: string | null;
	url: string;
	summary: string;
	relevance_score: number;
}

export interface TopicResult {
	topic: string;
	returned: number;
	inserted: number;
	skipped: number;
	invalid: number;
	removed: number;
	error?: string;
}

export interface AgentResult {
	inserted: number;
	skipped: number;
	total_returned: number;
	invalid: number;
	removed: number;
	topics: TopicResult[];
	started_at: string;
	finished_at: string;
}

export async function runAgent(env: Env, onlyTopic?: string): Promise<AgentResult> {
	const startedAt = new Date().toISOString();
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

	// Topics are independent, so search them concurrently; one failing topic doesn't sink the run.
	const selected = onlyTopic ? TOPICS.filter((t) => t.id === onlyTopic) : TOPICS;
	const topics = await Promise.all(
		selected.map(async (topic): Promise<TopicResult> => {
			try {
				const candidates = await findArticlesWithRetry(client, topic);
				return await storeArticles(env.DB, topic.id, candidates);
			} catch (err) {
				console.error(`agent: topic ${topic.id} failed`, err);
				return {
					topic: topic.id,
					returned: 0,
					inserted: 0,
					skipped: 0,
					invalid: 0,
					removed: 0,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);

	const sum = (key: "returned" | "inserted" | "skipped" | "invalid" | "removed") =>
		topics.reduce((n, t) => n + t[key], 0);

	return {
		inserted: sum("inserted"),
		skipped: sum("skipped"),
		total_returned: sum("returned"),
		invalid: sum("invalid"),
		removed: sum("removed"),
		topics,
		started_at: startedAt,
		finished_at: new Date().toISOString(),
	};
}

/** Claude occasionally answers in prose (e.g. a search tool hiccup) instead of the JSON list; one retry usually fixes it. */
async function findArticlesWithRetry(client: Anthropic, topic: Topic) {
	try {
		return await findArticles(client, topic);
	} catch (err) {
		if (!(err instanceof Error) || !err.message.startsWith("No JSON array")) throw err;
		console.warn(`agent: topic ${topic.id} returned no JSON list, retrying once`);
		return await findArticles(client, topic);
	}
}

async function findArticles(client: Anthropic, topic: Topic): Promise<{ raw: unknown[]; valid: CandidateArticle[] }> {
	const today = new Date().toISOString().slice(0, 10);
	const prompt = `Today is ${today}. Use web search to find the ${ARTICLES_PER_RUN} most recent and significant news articles about ${topic.name} (${topic.searchHint}) published in the past 7 days.

Prefer reputable outlets and distinct stories (no duplicates of the same event). Use each article's real URL exactly as it appears in the search results.

Respond with only a JSON array of ${ARTICLES_PER_RUN} objects, no prose and no code fences. Each object has:
- "headline": the article's headline
- "source": the publication name, e.g. "ESPN" or "Reuters"
- "published_date": publication date as YYYY-MM-DD
- "url": the article URL
- "summary": a 2-3 sentence factual summary
- "relevance_score": integer 1-10 for how significant the story is to someone following ${topic.name}`;

	const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
	let response: Anthropic.Beta.BetaMessage | undefined;
	const textParts: string[] = [];

	for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
		response = await client.beta.messages.create({
			model: MODEL,
			max_tokens: 16000,
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			output_config: { effort: "medium" },
			tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
			messages,
		});

		// Web search splits the answer into many text blocks (one per citation span); keep them all.
		for (const block of response.content) {
			if (block.type === "text") textParts.push(block.text);
		}

		// pause_turn: the server paused a long tool-use turn; send the content back to resume it.
		if (response.stop_reason !== "pause_turn") break;
		messages.push({ role: "assistant", content: response.content });
	}

	if (response?.stop_reason === "refusal") {
		throw new Error(`Claude declined the request (${response.stop_details?.category ?? "no category"})`);
	}
	if (response?.stop_reason === "pause_turn") {
		throw new Error(`Search did not finish after ${MAX_CONTINUATIONS} continuations`);
	}

	const raw = extractJsonArray(textParts.join(""));
	const valid = raw.map(normalizeArticle).filter((a): a is CandidateArticle => a !== null);
	return { raw, valid };
}

/** Pulls the JSON array out of Claude's concatenated text, tolerating stray prose or code fences. */
export function extractJsonArray(text: string): unknown[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) {
		throw new Error(`No JSON array in Claude's response: ${text.slice(0, 200)}`);
	}
	const parsed: unknown = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("Claude's response JSON is not an array");
	return parsed;
}

export function normalizeArticle(item: unknown): CandidateArticle | null {
	if (typeof item !== "object" || item === null) return null;
	const o = item as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

	const headline = str(o.headline);
	const url = str(o.url);
	if (!headline || !/^https?:\/\//i.test(url)) return null;

	const score = Math.round(Number(o.relevance_score));
	return {
		headline,
		url,
		source: str(o.source) || new URL(url).hostname.replace(/^www\./, ""),
		published_at: normalizeDate(str(o.published_date ?? o.published_at)),
		summary: str(o.summary),
		relevance_score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 5,
	};
}

/** Returns YYYY-MM-DD for date-only input, a full ISO timestamp otherwise, or null if unparseable. */
function normalizeDate(value: string): string | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function storeArticles(
	db: D1Database,
	topicId: string,
	{ raw, valid }: { raw: unknown[]; valid: CandidateArticle[] },
): Promise<TopicResult> {
	const insert = db.prepare(
		`INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(url) DO NOTHING`,
	);
	// Keep the newest MAX_ARTICLES_PER_TOPIC per topic; undated articles fall back to fetch time.
	const prune = db
		.prepare(
			`DELETE FROM articles WHERE topic = ?1 AND id NOT IN (
				SELECT id FROM articles WHERE topic = ?1
				ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
				LIMIT ?2
			)`,
		)
		.bind(topicId, MAX_ARTICLES_PER_TOPIC);

	const inserts = valid.map((a) =>
		insert.bind(topicId, a.headline, a.source, a.published_at, a.url, a.summary, a.relevance_score),
	);
	const results = await db.batch([...inserts, prune]);

	const inserted = results.slice(0, inserts.length).filter((r) => r.meta.changes > 0).length;
	return {
		topic: topicId,
		returned: raw.length,
		inserted,
		skipped: valid.length - inserted,
		invalid: raw.length - valid.length,
		removed: results[results.length - 1].meta.changes,
	};
}
