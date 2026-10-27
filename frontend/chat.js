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
	};

	els.system.value = DEFAULT_SYSTEM;

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

	function renderSources(msg, sources) {
		if (!sources?.length) return;
		const details = el("details", "chat-sources");
		details.append(el("summary", "", `Sources (${sources.length})`));
		const list = el("ul");
		for (const s of sources) {
			const item = el("li");
			item.append(el("span", "chat-source-id", `[${s.id}]`), " ");
			const href = safeUrl(s.url);
			if (href) {
				const a = el("a", "", s.headline);
				a.href = href;
				a.target = "_blank";
				a.rel = "noopener noreferrer";
				item.append(a);
			} else {
				item.append(s.headline);
			}
			item.append(el("span", "chat-source-meta", ` ${s.source}`));
			list.append(item);
		}
		details.append(list);
		msg.append(details);
	}

	function renderUsage(msg, data) {
		const n = (v) => Number(v).toLocaleString();
		const u = data.usage || {};
		msg.append(el("div", "chat-usage", `Tokens: ${n(u.input_tokens ?? 0)} in · ${n(u.output_tokens ?? 0)} out · ${data.model}`));
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
		addMessage("user", question);
		const pending = addMessage("assistant pending", "Looking through the latest articles…");
		setBusy(true);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 90_000);
		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({ question, system: els.system.value.trim() || undefined, model: els.model.value }),
			});
			const data = await res.json().catch(() => ({}));

			pending.classList.remove("pending");
			if (!res.ok) {
				pending.className = "chat-msg error";
				pending.querySelector(".chat-text").textContent = describeError(res.status, data);
			} else {
				pending.querySelector(".chat-text").textContent = data.answer || "(The model returned an empty answer.)";
				if (data.truncated) pending.append(el("div", "chat-usage", "The answer was cut off at the length limit."));
				renderSources(pending, data.sources);
				renderUsage(pending, data);
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
