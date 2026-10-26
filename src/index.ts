/**
 * News Intelligence App backend.
 *
 *   GET  /health    service status + timestamp
 *   POST /agent     run the news pipeline (also GET); AGENT_KEY bypasses the 15-minute limit on keyless calls
 *   GET  /articles  stored articles, filterable (see src/articles.ts)
 *
 * The pipeline also runs daily at 7 AM US Eastern via the cron triggers in wrangler.jsonc.
 */
import { runAgent } from "./agent";
import { BadRequestError, listArticles } from "./articles";

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

// Keyless callers (the public dashboard's Refresh button) may start a run at most this often.
const PUBLIC_RUN_COOLDOWN_MS = 15 * 60 * 1000;

/** "key" = valid AGENT_KEY, "public" = no key supplied, "denied" = a key was supplied but is wrong. */
function callerKind(request: Request, env: Env): "key" | "public" | "denied" {
	const header = request.headers.get("Authorization") ?? "";
	const key = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("key");
	if (!key) return "public";
	return env.AGENT_KEY && key === env.AGENT_KEY ? "key" : "denied";
}

/** Seconds until a keyless caller may start another run, or 0 if allowed now. */
async function publicCooldownRemaining(db: D1Database, now: number): Promise<number> {
	const last = await db.prepare("SELECT MAX(started_at) AS started_at FROM agent_runs").first<{ started_at: string | null }>();
	if (!last?.started_at) return 0;
	const elapsed = now - Date.parse(last.started_at);
	return Math.max(0, Math.ceil((PUBLIC_RUN_COOLDOWN_MS - elapsed) / 1000));
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

			if (path === "/agent" && (request.method === "POST" || request.method === "GET")) {
				const caller = callerKind(request, env);
				if (caller === "denied") return json({ error: "Unauthorized" }, 401);

				const now = Date.now();
				if (caller === "public") {
					const wait = await publicCooldownRemaining(env.DB, now);
					if (wait > 0) {
						return json(
							{ error: "A refresh ran recently. Please try again later.", retry_after_seconds: wait },
							429,
						);
					}
				}
				await env.DB.prepare("INSERT INTO agent_runs (started_at, trigger) VALUES (?, ?)")
					.bind(new Date(now).toISOString(), caller === "key" ? "api_key" : "public")
					.run();
				return json(await runAgent(env));
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
