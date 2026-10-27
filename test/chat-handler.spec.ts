import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, estimateTokens, extractWebSources, parseChatRequest, ChatRequestError } from "../src/chat";
import { handleChat } from "../src/chat-handler";

const testEnv = { ...env, ANTHROPIC_API_KEY: "test-key" } as Env;

beforeAll(async () => {
	// exec() runs one statement per line, so each CREATE TABLE has to stay on a single line.
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, headline TEXT NOT NULL, source TEXT NOT NULL, published_at TEXT, url TEXT NOT NULL UNIQUE, summary TEXT, relevance_score INTEGER, fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
	);
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS chat_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, ip_hash TEXT NOT NULL)",
	);
	const today = new Date().toISOString().slice(0, 10);
	const insert = env.DB.prepare("INSERT OR IGNORE INTO articles (topic, headline, source, published_at, url, summary, relevance_score) VALUES (?, ?, ?, ?, ?, ?, ?)");
	await env.DB.batch([
		insert.bind("weather", "Storm Josephine lashes New England", "FOX Weather", today, "https://e.com/1", "Gusty winds and coastal flooding along the coast.", 8),
		insert.bind("weather", "Nor'easter forms off the East Coast", "AccuWeather", today, "https://e.com/2", "A nor'easter developed and strengthened.", 7),
		insert.bind("nfl", "Ravens QB injury update", "SI", today, "https://e.com/3", "Lamar Jackson is expected to play.", 8),
	]);
});

beforeEach(async () => {
	await env.DB.exec("DELETE FROM chat_requests");
});

interface Sent {
	body: Record<string, any>;
}

/** A fake fetch for the Anthropic client: records each request body and replies with the next canned message. */
function fakeAnthropic(replies: Array<Record<string, unknown> | { status: number; error: string }>) {
	const sent: Sent[] = [];
	const fetchImpl = async (_url: unknown, init?: RequestInit) => {
		sent.push({ body: JSON.parse(String(init?.body)) });
		const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
		if ("status" in reply) {
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.error } }), {
				status: reply.status,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { sent, fetch: fetchImpl as typeof fetch };
}

function message(over: Record<string, unknown> = {}) {
	return {
		id: "msg_test",
		type: "message",
		role: "assistant",
		model: "claude-opus-5-5",
		content: [{ type: "text", text: "Josephine is moving away from the coast [1]." }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 900, output_tokens: 60 },
		...over,
	};
}

const WEB_CONTENT = [
	{ type: "text", text: "From the articles: Josephine is passing [1]." },
	{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Josephine latest" } },
	{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://web.example/a", title: "Web A", encrypted_content: "x", page_age: null }] },
	{
		type: "text",
		text: " The web adds that cleanup has begun.",
		citations: [
			{ type: "web_search_result_location", url: "https://web.example/a", title: "Web A", cited_text: "cleanup", encrypted_index: "i1" },
			{ type: "web_search_result_location", url: "https://web.example/a", title: "Web A", cited_text: "again", encrypted_index: "i2" },
		],
	},
];

function post(body: unknown) {
	return new Request("https://example.com/chat", { method: "POST", body: JSON.stringify(body) });
}

describe("web_search option", () => {
	it("is off by default: no tool is sent and the system prompt stays article-only", async () => {
		const fake = fakeAnthropic([message()]);
		const res = await handleChat(post({ question: "What is the storm doing?" }), testEnv, { fetch: fake.fetch });
		expect(res.status).toBe(200);

		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].body.tools).toBeUndefined();
		expect(fake.sent[0].body.system).not.toContain("Web search is enabled");

		const data = await res.json<any>();
		expect(data.web_search).toEqual({ enabled: false, searches: 0, sources: [] });
		expect(data.usage).toEqual({ input_tokens: 900, output_tokens: 60 });
	});

	it("when on: sends the web search tool, relaxes the prompt, and reports searches and cited web sources", async () => {
		const fake = fakeAnthropic([message({ content: WEB_CONTENT, usage: { input_tokens: 2100, output_tokens: 150, server_tool_use: { web_search_requests: 2 } } })]);
		const res = await handleChat(post({ question: "What is the storm doing?", web_search: true }), testEnv, { fetch: fake.fetch });
		expect(res.status).toBe(200);

		expect(fake.sent[0].body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
		expect(fake.sent[0].body.system).toContain("Web search is enabled");

		const data = await res.json<any>();
		expect(data.web_search.enabled).toBe(true);
		expect(data.web_search.searches).toBe(2);
		expect(data.web_search.sources).toEqual([{ title: "Web A", url: "https://web.example/a" }]); // de-duplicated
		expect(data.answer).toContain("cleanup has begun");
		expect(data.usage).toEqual({ input_tokens: 2100, output_tokens: 150 });
	});

	it("reports how many articles came from the database and an estimate of their context tokens", async () => {
		const fake = fakeAnthropic([message()]);
		const data = await (await handleChat(post({ question: "storm New England", max_articles: 2 }), testEnv, { fetch: fake.fetch })).json<any>();

		expect(data.articles_used).toBe(2);
		expect(data.sources).toHaveLength(2);
		// The estimate covers exactly the article block that was put in the user message.
		const userMessage: string = fake.sent[0].body.messages[0].content;
		const articlesBlock = userMessage.slice(0, userMessage.indexOf("</articles>") + "</articles>".length);
		expect(data.context_tokens_estimate).toBe(estimateTokens(articlesBlock));
		expect(data.context_tokens_estimate).toBeGreaterThan(50);
	});

	it("resumes a paused turn and adds up tokens and searches across turns", async () => {
		const fake = fakeAnthropic([
			message({ stop_reason: "pause_turn", content: [WEB_CONTENT[1], WEB_CONTENT[2]], usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: 1 } } }),
			message({ content: [WEB_CONTENT[3]], usage: { input_tokens: 1200, output_tokens: 80, server_tool_use: { web_search_requests: 1 } } }),
		]);
		const data = await (await handleChat(post({ question: "storm", web_search: true }), testEnv, { fetch: fake.fetch })).json<any>();

		expect(fake.sent).toHaveLength(2);
		expect(fake.sent[1].body.messages.at(-1).role).toBe("assistant"); // the paused content was sent back
		expect(data.usage).toEqual({ input_tokens: 2200, output_tokens: 130 });
		expect(data.web_search.searches).toBe(2);
		expect(data.truncated).toBe(false);
	});
});

describe("dashboard output caps", () => {
	it("gives the dashboard 1200 tokens normally and 2000 with web search on", async () => {
		const plain = fakeAnthropic([message()]);
		await handleChat(post({ question: "storm" }), testEnv, { fetch: plain.fetch, fromDashboard: true, clientIp: "203.0.113.1" });
		expect(plain.sent[0].body.max_tokens).toBe(1200);

		const web = fakeAnthropic([message()]);
		await handleChat(post({ question: "storm", web_search: true }), testEnv, { fetch: web.fetch, fromDashboard: true, clientIp: "203.0.113.2" });
		expect(web.sent[0].body.max_tokens).toBe(2000);
	});

	it("leaves direct (password) callers at 4000", async () => {
		const fake = fakeAnthropic([message()]);
		await handleChat(post({ question: "storm" }), testEnv, { fetch: fake.fetch });
		expect(fake.sent[0].body.max_tokens).toBe(4000);
	});
});

describe("failures", () => {
	it("maps an Anthropic API error to a 502 that names the upstream status", async () => {
		const fake = fakeAnthropic([{ status: 400, error: "You have reached your specified API usage limits." }]);
		const res = await handleChat(post({ question: "storm" }), testEnv, { fetch: fake.fetch });
		expect(res.status).toBe(502);
		const data = await res.json<any>();
		expect(data.upstream_status).toBe(400);
		expect(data.detail).toContain("usage limits");
	});

	it("maps a refusal to a 422", async () => {
		const fake = fakeAnthropic([message({ stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: "cyber", explanation: null } })]);
		const res = await handleChat(post({ question: "storm" }), testEnv, { fetch: fake.fetch });
		expect(res.status).toBe(422);
	});
});

describe("helpers", () => {
	it("validates web_search", () => {
		expect(parseChatRequest(JSON.stringify({ question: "q", web_search: true })).webSearch).toBe(true);
		expect(parseChatRequest(JSON.stringify({ question: "q" })).webSearch).toBe(false);
		expect(() => parseChatRequest(JSON.stringify({ question: "q", web_search: "yes" }))).toThrow(ChatRequestError);
	});

	it("adds the web search guidance only when enabled, ahead of the operator's prompt", () => {
		expect(buildSystemPrompt("Be brief.", false)).not.toContain("Web search is enabled");
		const on = buildSystemPrompt("Be brief.", true);
		expect(on).toContain("Web search is enabled");
		expect(on.indexOf("Web search is enabled")).toBeLessThan(on.indexOf("Be brief."));
	});

	it("ignores citations that aren't web results and tolerates missing ones", () => {
		expect(
			extractWebSources([
				{ type: "text", text: "no citations" },
				{ type: "text", citations: [{ type: "char_location", url: "https://x.example" }] },
				{ type: "server_tool_use" },
			]),
		).toEqual([]);
	});

	it("estimates about four characters per token", () => {
		expect(estimateTokens("a".repeat(400))).toBe(100);
		expect(estimateTokens("")).toBe(0);
	});
});
