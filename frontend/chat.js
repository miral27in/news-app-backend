(() => {
	const DEFAULT_SYSTEM =
		"You are a veteran news analyst covering the NFL, the stock market and weather. " +
		"Give clear, balanced analysis grounded in the articles you are given. Lead with the key takeaway, " +
		"point out uncertainty or conflicting reports, and keep answers under about 150 words unless asked for more.";

	const $ = (id) => document.getElementById(id);
	const els = {
		system: $("chat-system"),
		model: $("chat-model"),
		reset: $("chat-reset"),
		log: $("chat-log"),
		form: $("chat-form"),
		input: $("chat-input"),
		send: $("chat-send"),
		sendLabel: $("chat-send-label"),
		web: $("hood-web"),
		hoodEmpty: $("hood-empty"),
		hoodGrid: $("hood-grid"),
		hood: {
			articles: $("hood-articles"),
			context: $("hood-context"),
			input: $("hood-input"),
			output: $("hood-output"),
			searches: $("hood-searches"),
			model: $("hood-model"),
		},
	};

	els.system.value = DEFAULT_SYSTEM;

	const num = (v) => Number(v ?? 0).toLocaleString();

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function scrollToEnd() {
		els.log.scrollTop = els.log.scrollHeight;
	}

	function addMessage(kind, text) {
		els.log.querySelector(".chat-empty")?.remove();
		const msg = el("div", `chat-msg ${kind}`);
		msg.append(el("div", "chat-text", text));
		els.log.append(msg);
		scrollToEnd();
		return msg;
	}

	function safeUrl(url) {
		try {
			const u = new URL(url);
			return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
		} catch {
			return null;
		}
	}

	function linkTo(url, label) {
		const href = safeUrl(url);
		if (!href) return document.createTextNode(label);
		const a = el("a", "", label);
		a.href = href;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		return a;
	}

	function sourceGroup(title, items) {
		const group = el("div", "chat-source-group");
		group.append(el("div", "chat-source-title", title));
		const list = el("ul");
		for (const item of items) list.append(item);
		group.append(list);
		return group;
	}

	// Database articles and web pages are listed separately so a reader can tell where each fact came from.
	function renderSources(msg, dbSources, webSources) {
		if (!dbSources?.length && !webSources?.length) return;
		const details = el("details", "chat-sources");
		const parts = [];
		if (dbSources?.length) parts.push(`${dbSources.length} from database`);
		if (webSources?.length) parts.push(`${webSources.length} from the web`);
		details.append(el("summary", "", `Sources (${parts.join(", ")})`));

		if (dbSources?.length) {
			details.append(
				sourceGroup(
					"Stored articles",
					dbSources.map((s) => {
						const li = el("li");
						li.append(el("span", "chat-source-id", `[${s.id}]`), " ", linkTo(s.url, s.headline), el("span", "chat-source-meta", ` ${s.source}`));
						return li;
					}),
				),
			);
		}
		if (webSources?.length) {
			details.append(
				sourceGroup(
					"Web",
					webSources.map((s) => {
						const li = el("li");
						li.append(linkTo(s.url, s.title));
						return li;
					}),
				),
			);
		}
		msg.append(details);
	}

	// Always-visible stats line under each answer (the Under the Hood panel shows the same numbers larger).
	function renderStats(msg, data) {
		const web = data.web_search || {};
		const usage = data.usage || {};
		const line = el("div", "chat-usage");
		const add = (label, value) => {
			const item = el("span", "chat-usage-item");
			item.append(`${label} `, el("strong", "", value));
			line.append(item);
		};
		add("Database:", `${num(data.articles_used)} article${data.articles_used === 1 ? "" : "s"} (≈${num(data.context_tokens_estimate)} context tokens)`);
		add("Web search:", web.enabled ? `${num(web.searches)} search${web.searches === 1 ? "" : "es"}` : "off");
		add("Tokens:", `${num(usage.input_tokens)} in · ${num(usage.output_tokens)} out`);
		line.append(el("span", "chat-usage-item chat-usage-model", data.model));
		msg.append(line);
	}

	function updateHood(data) {
		const web = data.web_search || {};
		const usage = data.usage || {};
		els.hood.articles.textContent = num(data.articles_used);
		els.hood.context.textContent = `≈${num(data.context_tokens_estimate)}`;
		els.hood.input.textContent = num(usage.input_tokens);
		els.hood.output.textContent = num(usage.output_tokens);
		els.hood.searches.textContent = web.enabled ? num(web.searches) : "off";
		els.hood.model.textContent = data.model;
		els.hoodEmpty.hidden = true;
		els.hoodGrid.hidden = false;
	}

	function setBusy(on) {
		els.send.disabled = on;
		els.input.disabled = on;
		els.send.classList.toggle("is-loading", on);
		els.sendLabel.textContent = on ? "Thinking…" : "Send";
	}

	function minutes(seconds) {
		const m = Math.max(1, Math.ceil((seconds || 60) / 60));
		return `${m} minute${m === 1 ? "" : "s"}`;
	}

	function describeError(status, data) {
		if (status === 429) return `You've reached the chat limit for now. Please try again in about ${minutes(data.retry_after_seconds)}.`;
		if (status === 400 || status === 413) return data.error || "That message couldn't be sent. Please shorten it and try again.";
		if (status === 422) return "The model declined to answer that question.";
		if (status === 502 && /usage limit/i.test(data.detail || "")) return "The AI service has reached its usage limit, so chat is unavailable right now.";
		if (status === 502) return "The AI service couldn't answer right now. Please try again in a moment.";
		if (status === 401 || status === 503) return "Chat isn't available right now. Please try again later.";
		return data.error || `Something went wrong (error ${status}).`;
	}

	async function ask(question) {
		// Read the toggle once, so the label, the request and the result all agree even if it's flipped mid-request.
		const webSearch = els.web.checked;
		addMessage("user", question);
		const pending = addMessage(
			"assistant pending",
			webSearch ? "Checking the latest articles and searching the web…" : "Looking through the latest articles…",
		);
		setBusy(true);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 120_000);
		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					question,
					system: els.system.value.trim() || undefined,
					model: els.model.value,
					web_search: webSearch,
				}),
			});
			const data = await res.json().catch(() => ({}));

			pending.classList.remove("pending");
			if (!res.ok) {
				pending.className = "chat-msg error";
				pending.querySelector(".chat-text").textContent = describeError(res.status, data);
			} else {
				pending.querySelector(".chat-text").textContent = data.answer || "(The model returned an empty answer.)";
				if (data.truncated) pending.append(el("div", "chat-usage", "The answer was cut off at the length limit."));
				renderSources(pending, data.sources, data.web_search?.sources);
				renderStats(pending, data);
				updateHood(data);
			}
		} catch (err) {
			pending.className = "chat-msg error";
			pending.querySelector(".chat-text").textContent =
				err.name === "AbortError" ? "That took too long. Please try again." : "Couldn't reach the server. Check your connection and try again.";
		} finally {
			clearTimeout(timer);
			setBusy(false);
			scrollToEnd();
			els.input.focus();
		}
	}

	els.form.addEventListener("submit", (e) => {
		e.preventDefault();
		const question = els.input.value.trim();
		if (!question || els.send.disabled) return;
		els.input.value = "";
		ask(question);
	});

	// Enter sends; Shift+Enter inserts a newline.
	els.input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			els.form.requestSubmit();
		}
	});

	els.reset.addEventListener("click", () => {
		els.system.value = DEFAULT_SYSTEM;
	});
})();
