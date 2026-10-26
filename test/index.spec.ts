import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { extractJsonArray, normalizeArticle } from "../src/agent";

describe("HTTP endpoints", () => {
	it("GET /health returns status and timestamp with CORS", async () => {
		const response = await SELF.fetch("https://example.com/health");
		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = await response.json<{ status: string; timestamp: string }>();
		expect(body.status).toBe("ok");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});

	it("answers CORS preflight", async () => {
		const response = await SELF.fetch("https://example.com/articles", { method: "OPTIONS" });
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
	});

	it("rejects /agent with a wrong agent key", async () => {
		const response = await SELF.fetch("https://example.com/agent", {
			method: "POST",
			headers: { Authorization: "Bearer not-the-key" },
		});
		expect(response.status).toBe(401);
	});

	it("rate-limits keyless /agent calls after a recent run", async () => {
		await env.DB.exec("CREATE TABLE IF NOT EXISTS agent_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, trigger TEXT NOT NULL)");
		await env.DB.prepare("INSERT INTO agent_runs (started_at, trigger) VALUES (?, 'public')").bind(new Date().toISOString()).run();

		const response = await SELF.fetch("https://example.com/agent", { method: "POST" });
		expect(response.status).toBe(429);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = await response.json<{ retry_after_seconds: number }>();
		expect(body.retry_after_seconds).toBeGreaterThan(0);
	});

	it("validates /articles filters", async () => {
		const response = await SELF.fetch("https://example.com/articles?min_score=11");
		expect(response.status).toBe(400);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("returns 404 for unknown paths", async () => {
		const response = await SELF.fetch("https://example.com/nope");
		expect(response.status).toBe(404);
	});
});

describe("Claude response parsing", () => {
	it("extracts the JSON array from concatenated text blocks", () => {
		// Web search citations split the answer across blocks; joined, they may carry prose around the array.
		const blocks = ["Here are the articles:\n", '[{"headline": "A", ', '"url": "https://x.com/a"}]', "\nDone."];
		expect(extractJsonArray(blocks.join(""))).toEqual([{ headline: "A", url: "https://x.com/a" }]);
	});

	it("throws when there is no array", () => {
		expect(() => extractJsonArray("Sorry, no results.")).toThrow(/No JSON array/);
	});

	it("normalizes articles and rejects ones without a usable URL", () => {
		const article = normalizeArticle({
			headline: " Big game ",
			url: "https://www.espn.com/story",
			published_date: "2026-10-25",
			summary: "Summary.",
			relevance_score: 14,
		});
		expect(article).toEqual({
			headline: "Big game",
			url: "https://www.espn.com/story",
			source: "espn.com",
			published_at: "2026-10-25",
			summary: "Summary.",
			relevance_score: 10,
		});
		expect(normalizeArticle({ headline: "No link", url: "not a url" })).toBeNull();
	});
});
