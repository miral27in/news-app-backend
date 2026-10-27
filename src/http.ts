export const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

const JSON_TYPE = "application/json; charset=utf-8";

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "Content-Type": JSON_TYPE, ...CORS_HEADERS, ...extraHeaders },
	});
}

export function methodNotAllowed(allow: string): Response {
	return json({ error: `Use ${allow}` }, 405, { Allow: `${allow}, OPTIONS` });
}

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
 * Gate for password-protected endpoints. The AGENT_KEY password must arrive as "Authorization: Bearer <password>"
 * (never in the URL, where it would be logged). Returns null when the caller may proceed, otherwise the response to
 * send. Fails closed: if the secret isn't configured, nobody gets in.
 */
export async function requirePassword(request: Request, env: Env): Promise<Response | null> {
	if (!env.AGENT_KEY) {
		console.error("AGENT_KEY secret is not set; refusing a password-protected request");
		return json({ error: "Endpoint is not configured" }, 503);
	}
	const header = request.headers.get("Authorization") ?? "";
	const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!supplied) {
		return json({ error: "Unauthorized: a password is required" }, 401, { "WWW-Authenticate": 'Bearer realm="news-pipeline"' });
	}
	if (!(await passwordMatches(supplied, env.AGENT_KEY))) {
		return json({ error: "Unauthorized: wrong password" }, 401, { "WWW-Authenticate": 'Bearer realm="news-pipeline"' });
	}
	return null;
}
