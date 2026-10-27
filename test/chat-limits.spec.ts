import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_PER_VISITOR_PER_HOUR, CHAT_TOTAL_PER_HOUR, recordDashboardChat } from "../src/chat-limits";

beforeEach(async () => {
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS chat_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, ip_hash TEXT NOT NULL)",
	);
	await env.DB.exec("DELETE FROM chat_requests");
});

describe("recordDashboardChat", () => {
	it("allows a visitor up to the hourly limit, then blocks them but not other visitors", async () => {
		const now = Date.now();
		for (let i = 0; i < CHAT_PER_VISITOR_PER_HOUR; i++) {
			expect(await recordDashboardChat(env.DB, "203.0.113.7", "salt", now)).toBe(0);
		}
		const wait = await recordDashboardChat(env.DB, "203.0.113.7", "salt", now);
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(3600);

		expect(await recordDashboardChat(env.DB, "198.51.100.9", "salt", now)).toBe(0);
	});

	it("lets a visitor back in once their oldest request leaves the one-hour window", async () => {
		const start = Date.now();
		for (let i = 0; i < CHAT_PER_VISITOR_PER_HOUR; i++) await recordDashboardChat(env.DB, "203.0.113.7", "salt", start);
		expect(await recordDashboardChat(env.DB, "203.0.113.7", "salt", start + 3_600_000 + 1000)).toBe(0);
	});

	it("enforces the overall hourly cap across visitors", async () => {
		const now = Date.now();
		for (let i = 0; i < CHAT_TOTAL_PER_HOUR; i++) {
			expect(await recordDashboardChat(env.DB, `192.0.2.${i}`, "salt", now)).toBe(0);
		}
		expect(await recordDashboardChat(env.DB, "192.0.2.250", "salt", now)).toBeGreaterThan(0);
	});

	it("stores a hash, not the IP address", async () => {
		await recordDashboardChat(env.DB, "203.0.113.7", "salt");
		const row = await env.DB.prepare("SELECT ip_hash FROM chat_requests").first<{ ip_hash: string }>();
		expect(row?.ip_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(row?.ip_hash).not.toContain("203");
	});
});

describe("POST /chat from the dashboard", () => {
	it("returns 429 with retry_after_seconds once the visitor is over the limit, before any AI call", async () => {
		const ip = "203.0.113.50";
		for (let i = 0; i < CHAT_PER_VISITOR_PER_HOUR; i++) await recordDashboardChat(env.DB, ip, env.AGENT_KEY);

		const response = await SELF.fetch("https://example.com/chat", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.AGENT_KEY}`,
				"Content-Type": "application/json",
				"X-Agent-Source": "dashboard",
				"X-Client-IP": ip,
			},
			body: JSON.stringify({ question: "What is new?" }),
		});
		expect(response.status).toBe(429);
		const body = await response.json<{ retry_after_seconds: number }>();
		expect(body.retry_after_seconds).toBeGreaterThan(0);
	});

	it("does not count invalid requests against the limit", async () => {
		const response = await SELF.fetch("https://example.com/chat", {
			method: "POST",
			headers: { Authorization: `Bearer ${env.AGENT_KEY}`, "Content-Type": "application/json", "X-Agent-Source": "dashboard", "X-Client-IP": "203.0.113.51" },
			body: JSON.stringify({ question: "" }),
		});
		expect(response.status).toBe(400);
		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_requests").first<{ n: number }>();
		expect(row?.n).toBe(0);
	});
});
