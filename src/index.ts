/**
 * News Intelligence App backend.
 *
 *   GET  /health    service status + timestamp (public)
 *   POST /agent     run the news pipeline; requires "Authorization: Bearer <AGENT_KEY>" (401 otherwise)
 *   GET  /articles  stored articles, filterable (public; see src/articles.ts)
 *
 * The pipeline also runs daily at 7 AM US Eastern via the cron triggers in wrangler.jsonc.
 */
import { runAgent } from "./agent";
import { BadRequestError, listArticles } from "./articles";
import { TOPICS } from "./topics";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

const SCHEDULE_TIME_ZONE = "America/New_York";
const SCHEDULE_HOUR = 7;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}

// The dashboard's Refresh button reaches /agent through a Pages function that holds the password, so
// anyone who opens the dashboard can trigger a run. Those calls (marked with X-Agent-Source: dashboard)
// are therefore limited to one run per this interval, which caps the credits a visitor can spend.
const DASHBOARD_RUN_COOLDOWN_MS = 15 * 60 * 1000;
const DASHBOARD_SOURCE = "dashboard";

/** Constant-time password check: compares SHA-256 digests so the comparison time doesn't leak a prefix match. */
async function passwordMatches(supplied: string, expected: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(supplied)),
		crypto.subtle.digest("SHA-256", enc.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Checks the AGENT_KEY password, which must arrive as "Authorization: Bearer <password>" (never in the URL,
 * where it would be logged). Fails closed: if the secret isn't configured, nobody gets in.
 */
async function checkAgentAuth(request: Request, env: Env): Promise<"ok" | "missing" | "wrong" | "unconfigured"> {
	if (!env.AGENT_KEY) return "unconfigured";
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith("Bearer ") || header.length <= 7) return "missing";
	return (await passwordMatches(header.slice(7), env.AGENT_KEY)) ? "ok" : "wrong";
}

/** Seconds until the dashboard may start another run, or 0 if allowed now. */
async function dashboardCooldownRemaining(db: D1Database, now: number): Promise<number> {
	const last = await db
		.prepare("SELECT MAX(started_at) AS started_at FROM agent_runs WHERE trigger = ?")
		.bind(DASHBOARD_SOURCE)
		.first<{ started_at: string | null }>();
	if (!last?.started_at) return 0;
	const elapsed = now - Date.parse(last.started_at);
	return Math.max(0, Math.ceil((DASHBOARD_RUN_COOLDOWN_MS - elapsed) / 1000));
}

/** Hour of day in the schedule's time zone, so the 7 AM run survives daylight-saving changes. */
function localHour(date: Date): number {
	const hour = new Intl.DateTimeFormat("en-US", {
		timeZone: SCHEDULE_TIME_ZONE,
		hour: "numeric",
		hourCycle: "h23",
	}).format(date);
	return Number(hour);
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const { pathname, searchParams } = new URL(request.url);
		const path = pathname.replace(/\/+$/, "") || "/";

		try {
			if (path === "/health" && request.method === "GET") {
				return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });
			}

			if (path === "/agent") {
				if (request.method !== "POST") {
					return new Response(JSON.stringify({ error: "Use POST" }), {
						status: 405,
						headers: { "Content-Type": "application/json; charset=utf-8", Allow: "POST, OPTIONS", ...CORS_HEADERS },
					});
				}

				const auth = await checkAgentAuth(request, env);
				if (auth === "unconfigured") {
					console.error("AGENT_KEY secret is not set; refusing to run the pipeline");
					return json({ error: "Pipeline endpoint is not configured" }, 503);
				}
				if (auth !== "ok") {
					return new Response(
						JSON.stringify({ error: auth === "missing" ? "Unauthorized: a password is required" : "Unauthorized: wrong password" }),
						{
							status: 401,
							headers: {
								"Content-Type": "application/json; charset=utf-8",
								"WWW-Authenticate": 'Bearer realm="news-pipeline"',
								...CORS_HEADERS,
							},
						},
					);
				}

				// Optional ?topic=<id> reruns a single topic (e.g. after one of three failed).
				const topic = searchParams.get("topic");
				if (topic && !TOPICS.some((t) => t.id === topic)) {
					return json({ error: `Unknown topic. Use one of: ${TOPICS.map((t) => t.id).join(", ")}` }, 400);
				}

				const now = Date.now();
				const fromDashboard = request.headers.get("X-Agent-Source") === DASHBOARD_SOURCE;
				if (fromDashboard) {
					const wait = await dashboardCooldownRemaining(env.DB, now);
					if (wait > 0) {
						return json(
							{ error: "A refresh ran recently. Please try again later.", retry_after_seconds: wait },
							429,
						);
					}
				}
				await env.DB.prepare("INSERT INTO agent_runs (started_at, trigger) VALUES (?, ?)")
					.bind(new Date(now).toISOString(), fromDashboard ? DASHBOARD_SOURCE : "api_key")
					.run();
				return json(await runAgent(env, topic ?? undefined));
			}

			if (path === "/articles" && request.method === "GET") {
				return json(await listArticles(env.DB, searchParams));
			}

			return json({ error: "Not found", endpoints: ["/health", "/agent", "/articles"] }, 404);
		} catch (err) {
			if (err instanceof BadRequestError) return json({ error: err.message }, 400);
			console.error("request failed", err);
			return json({ error: "Internal error", detail: err instanceof Error ? err.message : String(err) }, 500);
		}
	},

	async scheduled(controller, env, ctx): Promise<void> {
		// Two UTC crons (11:00 and 12:00) cover 7 AM Eastern in both EDT and EST; run only on the matching one.
		if (localHour(new Date(controller.scheduledTime)) !== SCHEDULE_HOUR) return;
		ctx.waitUntil(
			runAgent(env).then((result) => console.log("scheduled agent run", JSON.stringify(result))),
		);
	},
} satisfies ExportedHandler<Env>;
