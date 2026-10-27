import Anthropic from "@anthropic-ai/sdk";
import {
	ChatRequestError,
	buildContext,
	buildSystemPrompt,
	estimateTokens,
	extractWebSources,
	loadCandidates,
	parseChatRequest,
	rankArticles,
	type ChatRequest,
} from "./chat";
import { recordDashboardChat } from "./chat-limits";
import { json } from "./http";

export interface ChatOptions {
	/** Request came from the public dashboard proxy: apply hourly limits and smaller output caps. */
	fromDashboard?: boolean;
	/** The visitor's IP as forwarded by the proxy (only used for rate limiting, stored hashed). */
	clientIp?: string;
	/** Replaces the global fetch used for the Anthropic call. Tests use it to inspect the request and fake the reply. */
	fetch?: typeof fetch;
}

const DEFAULT_MAX_TOKENS = 4000;
const DASHBOARD_MAX_TOKENS = 1200;
// Searching adds results to the context and a longer answer, so the dashboard gets more room when it's on.
const DASHBOARD_WEB_MAX_TOKENS = 2000;
const WEB_SEARCH_MAX_USES = 3;
const MAX_CONTINUATIONS = 3;

// Basic web search variant on purpose: web_search_20260209 runs batches of searches from a code step, which blew
// through max_uses on the news pipeline and left topics empty.
const webSearchTool = { type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES } as const;

function maxTokensFor(req: ChatRequest, opts: ChatOptions): number {
	if (!opts.fromDashboard) return DEFAULT_MAX_TOKENS;
	return req.webSearch ? DASHBOARD_WEB_MAX_TOKENS : DASHBOARD_MAX_TOKENS;
}

/** POST /chat: answers a question using the most relevant recent articles as context. Caller must already be authorized. */
export async function handleChat(request: Request, env: Env, opts: ChatOptions = {}): Promise<Response> {
	let req: ChatRequest;
	try {
		req = parseChatRequest(await request.text());
	} catch (err) {
		if (err instanceof ChatRequestError) return json({ error: err.message }, 400);
		throw err;
	}

	// Checked after validation so malformed requests don't use up a visitor's allowance.
	if (opts.fromDashboard) {
		const wait = await recordDashboardChat(env.DB, opts.clientIp, env.AGENT_KEY);
		if (wait > 0) {
			return json({ error: "Chat limit reached. Please try again later.", retry_after_seconds: wait }, 429);
		}
	}

	const now = new Date();
	const ranked = rankArticles(await loadCandidates(env.DB, now), req.question, now, req.maxArticles);

	const sources = ranked.map(({ article: a, matched }) => ({
		id: a.id,
		topic: a.topic,
		headline: a.headline,
		source: a.source,
		published_at: a.published_at,
		url: a.url,
		relevance_score: a.relevance_score,
		keyword_match: matched,
	}));
	const context = buildContext(ranked);
	const contextTokens = estimateTokens(context);
	const system = buildSystemPrompt(req.system, req.webSearch);

	if (req.dryRun) {
		return json({
			dry_run: true,
			model: req.model,
			articles_used: ranked.length,
			context_tokens_estimate: contextTokens,
			web_search: { enabled: req.webSearch },
			system,
			context,
			sources,
		});
	}

	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: opts.fetch });
	const messages: Anthropic.MessageParam[] = [{ role: "user", content: `${context}\n\nQuestion: ${req.question}` }];
	const content: Anthropic.ContentBlock[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let searches = 0;
	let response: Anthropic.Message | undefined;

	try {
		// A search-heavy turn can pause (pause_turn); sending the content back resumes it. Usage is summed across turns.
		for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
			response = await client.messages.create({
				model: req.model,
				max_tokens: maxTokensFor(req, opts),
				system,
				// Q&A over supplied context is easy work, so keep thinking light; thinking can't be turned off on these models.
				output_config: { effort: "low" },
				...(req.webSearch ? { tools: [webSearchTool] } : {}),
				messages,
			});
			inputTokens += response.usage.input_tokens;
			outputTokens += response.usage.output_tokens;
			searches += response.usage.server_tool_use?.web_search_requests ?? 0;
			content.push(...response.content);

			if (response.stop_reason !== "pause_turn") break;
			messages.push({ role: "assistant", content: response.content });
		}
	} catch (err) {
		if (err instanceof Anthropic.APIError) {
			console.error("chat: Anthropic API error", err.status, err.message);
			return json({ error: "The AI service could not answer right now", upstream_status: err.status, detail: err.message }, 502);
		}
		throw err;
	}

	if (response?.stop_reason === "refusal") {
		return json({ error: "Claude declined to answer this question", category: response.stop_details?.category ?? null }, 422);
	}

	const answer = content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();

	return json({
		answer,
		model: response?.model ?? req.model,
		truncated: response?.stop_reason === "max_tokens" || response?.stop_reason === "pause_turn",
		articles_used: ranked.length,
		context_tokens_estimate: contextTokens,
		sources,
		web_search: { enabled: req.webSearch, searches, sources: extractWebSources(content) },
		usage: { input_tokens: inputTokens, output_tokens: outputTokens },
	});
}
