// POST /api/chat: the dashboard's chat panel calls this instead of the Worker directly.
// The pipeline password (AGENT_KEY, a Pages secret) is added here, on the server, so it never appears in the
// page's JavaScript. The Worker rate-limits calls marked X-Agent-Source: dashboard, per visitor IP and overall.
const WORKER_URL = "https://news-app-backend.miral27in.workers.dev";

// The panel offers a fast and a capable model; anything else falls back to the fast one.
const FAST_MODEL = "claude-haiku-5-5";
const ALLOWED_MODELS = [FAST_MODEL, "claude-opus-5-5"];

const MAX_BODY_CHARS = 30_000;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function reply(status, body) {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env }) {
	if (!env.AGENT_KEY) return reply(503, { error: "Chat is not configured" });

	const text = await request.text();
	if (text.length > MAX_BODY_CHARS) return reply(413, { error: "Request is too large" });

	let input;
	try {
		input = JSON.parse(text);
	} catch {
		return reply(400, { error: "Body must be valid JSON" });
	}
	if (typeof input !== "object" || input === null) return reply(400, { error: "Body must be a JSON object" });

	// Forward only the fields the panel uses; the Worker validates their contents and lengths.
	const payload = {
		question: input.question,
		system: input.system,
		model: ALLOWED_MODELS.includes(input.model) ? input.model : FAST_MODEL,
	};

	const upstream = await fetch(`${WORKER_URL}/chat`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.AGENT_KEY}`,
			"Content-Type": "application/json",
			"X-Agent-Source": "dashboard",
			"X-Client-IP": request.headers.get("CF-Connecting-IP") || "",
		},
		body: JSON.stringify(payload),
	});

	// Pass back only the status and body, never the upstream headers.
	return new Response(upstream.body, { status: upstream.status, headers: JSON_HEADERS });
}

export function onRequest() {
	return reply(405, { error: "Use POST" });
}
