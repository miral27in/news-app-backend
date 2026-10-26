(() => {
	const API = (window.NEWS_API_BASE || "").replace(/\/+$/, "");
	const TOPICS = [
		{ id: "nfl", name: "NFL" },
		{ id: "stock_market", name: "Stock market" },
		{ id: "weather", name: "Weather" },
	];

	const $ = (id) => document.getElementById(id);
	const els = {
		topic: $("topic"),
		minScore: $("min-score"),
		limit: $("limit"),
		content: $("content"),
		banner: $("banner"),
		refresh: $("refresh"),
		refreshLabel: $("refresh-label"),
		lastRefreshed: $("last-refreshed"),
	};

	let lastRefreshedIso = null;
	let loadSeq = 0;

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function showBanner(kind, message) {
		els.banner.dataset.kind = kind;
		els.banner.textContent = message;
		els.banner.hidden = false;
	}

	function hideBanner() {
		els.banner.hidden = true;
	}

	// --- formatting ---------------------------------------------------------

	function parseDate(value) {
		if (!value) return null;
		const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
		// A bare date is a calendar day, not an instant: build it locally so the day never shifts.
		const d = dateOnly ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]) : new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}

	function formatDate(value) {
		const d = parseDate(value);
		return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Date unknown";
	}

	function relativeTime(date) {
		const seconds = Math.round((Date.now() - date.getTime()) / 1000);
		if (seconds < 60) return "just now";
		const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
		for (const [unit, size] of units) {
			if (seconds >= size) {
				const n = Math.floor(seconds / size);
				return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
			}
		}
		return "just now";
	}

	function renderLastRefreshed() {
		if (!lastRefreshedIso) {
			els.lastRefreshed.textContent = "No data yet. Press Refresh to fetch the news.";
			return;
		}
		// SQLite timestamps from the Worker are ISO UTC; fall back gracefully if one lacks the Z.
		const d = parseDate(/[zZ]|[+-]\d{2}:?\d{2}$/.test(lastRefreshedIso) ? lastRefreshedIso : `${lastRefreshedIso}Z`);
		if (!d) {
			els.lastRefreshed.textContent = "Last refreshed: unknown";
			return;
		}
		els.lastRefreshed.textContent =
			`Last refreshed ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (${relativeTime(d)})`;
	}

	function scoreClass(score) {
		if (score >= 8) return "score-high";
		if (score >= 5) return "score-mid";
		return "score-low";
	}

	// --- rendering ----------------------------------------------------------

	function safeUrl(url) {
		try {
			const u = new URL(url);
			return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
		} catch {
			return null;
		}
	}

	function renderCard(article) {
		const card = el("article", "card");

		const title = el("h3");
		const href = safeUrl(article.url);
		if (href) {
			const a = el("a", "", article.headline);
			a.href = href;
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			title.append(a);
		} else {
			title.textContent = article.headline;
		}

		const score = article.relevance_score;
		const badge = el("span", `score ${scoreClass(score ?? 0)}`);
		if (score == null) {
			badge.textContent = "n/a";
			badge.setAttribute("aria-label", "No relevance score");
		} else {
			badge.append(String(score), el("small", "", "/10"));
			badge.setAttribute("aria-label", `Relevance ${score} out of 10`);
		}

		const byline = el("p", "byline", `${article.source} · ${formatDate(article.published_at)}`);
		card.append(title, badge, byline);
		if (article.summary) card.append(el("p", "summary", article.summary));
		return card;
	}

	function renderArticles(articles) {
		els.content.replaceChildren();

		if (!articles.length) {
			const empty = el("div", "empty");
			empty.append(
				el("strong", "", "No articles to show"),
				document.createTextNode(
					lastRefreshedIso
						? "Try lowering the minimum relevance or choosing another topic."
						: "Press Refresh to search for the latest news.",
				),
			);
			els.content.append(empty);
			return;
		}

		const byTopic = new Map();
		for (const a of articles) {
			if (!byTopic.has(a.topic)) byTopic.set(a.topic, []);
			byTopic.get(a.topic).push(a);
		}

		// Known topics first in a fixed order, then anything unexpected.
		const known = new Set(TOPICS.map((t) => t.id));
		const ordered = [
			...TOPICS.filter((t) => byTopic.has(t.id)),
			...[...byTopic.keys()].filter((id) => !known.has(id)).map((id) => ({ id, name: id })),
		];

		for (const topic of ordered) {
			const items = byTopic.get(topic.id);
			const section = el("section", "topic-group");
			const heading = el("h2", "", topic.name);
			heading.append(" ", el("span", "topic-count", `${items.length} article${items.length === 1 ? "" : "s"}`));
			section.append(heading, ...items.map(renderCard));
			els.content.append(section);
		}
	}

	function renderSkeleton() {
		els.content.replaceChildren(el("div", "skeleton"), el("div", "skeleton"), el("div", "skeleton"));
	}

	// --- data ---------------------------------------------------------------

	async function loadArticles({ showSkeleton = true } = {}) {
		const seq = ++loadSeq;
		els.content.setAttribute("aria-busy", "true");
		if (showSkeleton) renderSkeleton();

		const params = new URLSearchParams();
		if (els.topic.value) params.set("topic", els.topic.value);
		if (els.minScore.value) params.set("min_score", els.minScore.value);
		params.set("limit", els.limit.value);

		try {
			const res = await fetch(`${API}/articles?${params}`);
			if (!res.ok) throw new Error(`The API answered ${res.status}`);
			const data = await res.json();
			if (seq !== loadSeq) return; // a newer request superseded this one
			lastRefreshedIso = data.last_refreshed;
			renderLastRefreshed();
			renderArticles(data.articles);
		} catch (err) {
			if (seq !== loadSeq) return;
			els.content.replaceChildren();
			showBanner("error", `Couldn't load articles. ${err.message}. Check your connection and try again.`);
			els.lastRefreshed.textContent = "Last refreshed: unavailable";
		} finally {
			if (seq === loadSeq) els.content.setAttribute("aria-busy", "false");
		}
	}

	function setRefreshing(on) {
		els.refresh.disabled = on;
		els.refresh.classList.toggle("is-loading", on);
		els.refreshLabel.textContent = on ? "Searching the news…" : "Refresh";
	}

	function friendlyAgentError(message) {
		if (/credit balance/i.test(message)) {
			return "The AI service has no credit left, so no new articles could be fetched.";
		}
		return "The news search failed for some topics.";
	}

	async function refresh() {
		hideBanner();
		setRefreshing(true);
		showBanner("info", "Searching the web for new articles. This usually takes one to three minutes.");

		try {
			const res = await fetch(`${API}/agent`, { method: "POST" });
			const data = await res.json().catch(() => ({}));

			if (res.status === 429) {
				const mins = Math.max(1, Math.ceil((data.retry_after_seconds || 60) / 60));
				showBanner("info", `The news was refreshed recently. You can run another refresh in about ${mins} minute${mins === 1 ? "" : "s"}.`);
			} else if (!res.ok) {
				throw new Error(data.error || `The API answered ${res.status}`);
			} else {
				const failed = (data.topics || []).filter((t) => t.error);
				if (failed.length === (data.topics || []).length && failed.length > 0) {
					showBanner("error", friendlyAgentError(failed[0].error));
				} else if (failed.length) {
					showBanner("error", `Added ${data.inserted} new articles, but ${failed.length} topic(s) failed: ${failed.map((t) => t.topic).join(", ")}.`);
				} else {
					showBanner("ok", `Added ${data.inserted} new article${data.inserted === 1 ? "" : "s"}; ${data.skipped} already stored (Claude returned ${data.total_returned}).`);
				}
			}
		} catch (err) {
			showBanner("error", `Refresh failed. ${err.message}`);
		} finally {
			setRefreshing(false);
		}

		await loadArticles({ showSkeleton: false });
	}

	// --- wiring -------------------------------------------------------------

	for (const control of [els.topic, els.minScore, els.limit]) {
		control.addEventListener("change", () => {
			hideBanner();
			loadArticles();
		});
	}
	els.refresh.addEventListener("click", refresh);
	document.getElementById("filters").addEventListener("submit", (e) => e.preventDefault());

	// Keep "(x minutes ago)" honest while the page stays open.
	setInterval(renderLastRefreshed, 60_000);

	loadArticles();
})();
