// POST /api/refresh: the dashboard's Refresh button calls this instead of the Worker directly.
// The pipeline password (AGENT_KEY, a Pages secret) is added here, on the server, so it never appears in
// the page's JavaScript. The Worker rate-limits calls marked X-Agent-Source: dashboard.
const WORKER_URL = "https://news-app-backend.miral27in.workers.dev";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export async function onRequestPost({ env }) {
	if (!env.AGENT_KEY) {
		return new Response(JSON.stringify({ error: "Refresh is not configured" }), { status: 503, headers: JSON_HEADERS });
	}

	const upstream = await fetch(`${WORKER_URL}/agent`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.AGENT_KEY}`, "X-Agent-Source": "dashboard" },
	});

	// Pass back only the status and body, never the upstream headers.
	return new Response(upstream.body, { status: upstream.status, headers: JSON_HEADERS });
}

export function onRequest() {
	return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...JSON_HEADERS, Allow: "POST" } });
}
