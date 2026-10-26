/**
 * News Intelligence App backend.
 *
 *   GET  /health    service status + timestamp
 *   POST /agent     run the news pipeline (also GET); requires AGENT_KEY when that secret is set
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

function isAuthorized(request: Request, env: Env): boolean {
	if (!env.AGENT_KEY) return true;
	const header = request.headers.get("Authorization") ?? "";
	const key = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("key");
	return key === env.AGENT_KEY;
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
				if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
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
