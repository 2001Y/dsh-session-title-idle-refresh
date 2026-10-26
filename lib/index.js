/**
 * dsh-session-title-idle-refresh
 *
 * A drop-in replacement for the stock session-title provider
 * (@deepseek-ai/dsh-session-title-first-prompt-llm), plus the idle
 * retitling the stock providers do not have.
 *
 * Why: the stock automatic modes are only 'first-prompt' and
 * 'all-prompts', both fired by arriving user messages. 'first-prompt'
 * titles a session from its first message forever; 'all-prompts'
 * re-titles on every message (an extra LLM call per prompt).
 *
 * This plugin registers ONE provider with automatic: 'first-prompt'
 * (so the initial title is generated exactly once, as before), but its
 * generate() reads ALL human messages — the same generation policy as
 * the stock all-prompts provider, including its "keep an adequate
 * title unchanged" stability rules. A Cordis timer then scans live
 * sessions: a session whose latest human message is not yet covered
 * by its title, and which has been idle for `idleMs`, gets a single
 * explicit ctx.sessionTitle.refresh(). User-renamed (pinned) titles
 * and subagent child sessions are never touched.
 *
 * The stock provider row must be disabled, as only one title provider
 * may be registered:
 *   - id: session-title-llm
 *     disabled: true
 */
import z from "@deepseek-ai/schemastery";
import { SessionTitleProviderId, normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { executeSessionTitleLlm, resolveSessionTitleLlmConfig } from "@deepseek-ai/dsh-session-title-llm";

const name = "session-title-idle-refresh";
const inject = ["sessionTitle", "llm", "sessions", "timer"];

const Config = z.object({
	/** Idle time after which a stale title is refreshed once. */
	idleMs: z.number().step(1).min(1000).default(30 * 60 * 1000),
	/** How often live sessions are scanned. */
	scanMs: z.number().step(1).min(5000).default(60 * 1000),
	/** Sessions with fewer human messages than this are left alone. */
	minMessages: z.number().step(1).min(1).default(2),
	/** Per-scan cap on refreshes, so one scan cannot fan out LLM calls. */
	maxPerScan: z.number().step(1).min(1).default(3),
	targetWords: z.number().step(1).min(1).default(5),
	targetCjkCharacters: z.number().step(1).min(1).default(10),
	maxInputBytes: z.number().step(1).min(1).default(16384),
	maxOutputTokens: z.number().step(1).min(1).default(4096),
	timeoutMs: z.number().step(1).min(1).default(60000)
});

function positiveInt(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveConfig(config = {}) {
	const idleMs = positiveInt(config.idleMs, 30 * 60 * 1000);
	const scanMs = Math.max(5000, positiveInt(config.scanMs, 60 * 1000));
	const minMessages = positiveInt(config.minMessages, 2);
	const maxPerScan = positiveInt(config.maxPerScan, 3);
	const targetWords = positiveInt(config.targetWords, 5);
	const targetCjkCharacters = positiveInt(config.targetCjkCharacters, 10);
	const execution = resolveSessionTitleLlmConfig({
		maxInputBytes: positiveInt(config.maxInputBytes, 16384),
		maxOutputTokens: positiveInt(config.maxOutputTokens, 4096),
		timeoutMs: positiveInt(config.timeoutMs, 60000)
	});
	return { idleMs, scanMs, minMessages, maxPerScan, targetWords, targetCjkCharacters, ...execution };
}

/** Select the route's least supported reasoning effort for a title call. */
const selectReasoningEffort = (model) => model.reasoning?.efforts[0]?.id;

/** Language-aware system instruction (same policy as the stock all-prompts provider). */
function systemPrompt(config, hasCurrentTitle) {
	return [
		"Create a concise title for an AI coding-assistant session from the supplied human messages.",
		"Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
		"Use the language of the messages.",
		`Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
		"If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.",
		...hasCurrentTitle ? [
			"An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.",
			"Follow-up questions, additional details within the same topic, acknowledgements such as \"thanks\", and requests to continue do not by themselves justify a title change.",
			"Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.",
			"Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate."
		] : []
	].join("\n");
}

/** Frame messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages, currentTitle) {
	if (currentTitle !== void 0) return `Update the session title from this JSON object:\n${JSON.stringify({
		currentTitle,
		messages
	})}`;
	return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
}

const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

/** Take the title from model output: first non-empty line, unwrapped. */
function titleFromOutput(text) {
	const line = text.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? "";
	const groups = EMPHASIS_WRAPPER.exec(line)?.groups;
	const marker = groups?.["marker"];
	const inner = groups?.["inner"];
	return marker === void 0 || inner === void 0 || inner.includes(marker) ? line : inner;
}

function titleFromResponse(response) {
	switch (response.finish.kind) {
		case "stop": break;
		case "tool-calls": throw new Error("session-title-llm: title output must contain text only");
		case "max-tokens": throw new Error("session-title-llm: title output reached maxOutputTokens");
		default: throw new Error(`session-title-llm: unexpected finish kind ${String(response.finish.kind)}`);
	}
	if (response.blocks.some((block) => block.type === "tool-call")) throw new Error("session-title-llm: title output must contain text only");
	const title = normalizeSessionTitle(titleFromOutput(response.blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ")), Number.MAX_SAFE_INTEGER);
	if (title.length === 0) throw new Error("session-title-llm: title model produced no text");
	return title;
}

const PER_MESSAGE_CAP_CHARS = 2000;

/**
 * Fit the human messages into the provider's byte budget: the first
 * message always, then as many of the latest messages as fit. Single
 * messages are truncated, never dropped silently mid-list.
 */
export function selectMessagesForTitle(messages, maxInputBytes) {
	const budget = Math.max(1024, Math.floor(maxInputBytes * 0.92) - 128);
	const cost = (m) => Buffer.byteLength(JSON.stringify(m), "utf8") + 1;
	const capped = (m, cap) => ({
		seq: m.seq,
		text: m.text.length > cap ? `${m.text.slice(0, cap)}…` : m.text
	});
	const picked = [];
	let used = 2;
	if (messages.length === 0) return picked;
	const first = capped(messages[0], PER_MESSAGE_CAP_CHARS);
	if (cost(first) <= budget) {
		picked.push(first);
		used += cost(first);
	}
	const tail = [];
	for (let i = messages.length - 1; i >= 1; i--) {
		const cand = capped(messages[i], PER_MESSAGE_CAP_CHARS);
		if (used + cost(cand) > budget) continue;
		tail.unshift(cand);
		used += cost(cand);
	}
	const selected = [...picked, ...tail];
	if (selected.length === 0) {
		// Even the first message alone overflows: keep only the newest
		// message, truncated hard to the budget.
		let cap = PER_MESSAGE_CAP_CHARS;
		let cand = capped(messages[messages.length - 1], cap);
		while (cost(cand) > budget && cap > 64) {
			cap = Math.floor(cap / 2);
			cand = capped(messages[messages.length - 1], cap);
		}
		selected.push(cand);
	}
	return selected;
}

/** Eligible human messages of one session, folded from its event log. */
function humanMessagesOf(session) {
	const out = [];
	for (const event of session.snapshotEvents()) {
		if (event.type !== "user/message" || event.data?.source?.kind !== "user") continue;
		const text = (event.data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
		if (text.trim().length === 0) continue;
		out.push({ seq: event.seq, time: event.time });
	}
	return out;
}

function apply(ctx, config) {
	const resolved = resolveConfig(config);
	// Plugin info logs also go to console: the host's ctx.logger default
	// level hides info, while console reaches the web log (as with other
	// third-party plugins). Key lifecycle events only — startup + refresh.
	const log = {
		info: (msg) => { ctx.logger?.info?.(msg); console.log(msg); },
		warn: (msg) => { ctx.logger?.warn?.(msg); console.warn(msg); }
	};
	const titleProvider = SessionTitleProviderId("session-title-idle-refresh");

	ctx.sessionTitle.register({
		id: titleProvider,
		automatic: "first-prompt",
		async generate(request) {
			const selected = selectMessagesForTitle(request.messages, resolved.maxInputBytes);
			const messageSeqs = selected.map((m) => m.seq);
			const anchor = request.currentTitle?.source.kind === "provider" ? request.currentTitle.title : void 0;
			const response = await executeSessionTitleLlm(ctx, resolved, request, titleProvider, {
				system: systemPrompt(resolved, anchor !== void 0),
				input: frameMessages(selected, anchor),
				messageSeqs,
				selectReasoningEffort
			});
			return {
				title: titleFromResponse(response),
				messageSeqs,
				model: response.model
			};
		}
	});

	// sessionId -> { throughSeq, nextTryAt }: one refresh attempt per
	// uncovered tail; failures and no-change results are not retried
	// until the session gains a newer human message and idles again,
	// and never sooner than the backoff below.
	const attempts = new Map();
	let scanning = false;

	const scan = async () => {
		if (scanning) return;
		scanning = true;
		try {
			const now = Date.now();
			let refreshed = 0;
			for (const session of ctx.sessions.list()) {
				if (refreshed >= resolved.maxPerScan) break;
				try {
					if (session.header?.parentSession != null) continue;
					const snap = ctx.sessionTitle.get(session);
					if (!snap || snap.source.kind === "user") continue;
					const events = session.snapshotEvents();
					if (events.length === 0) continue;
					const lastEventTime = events[events.length - 1].time;
					if (now - lastEventTime < resolved.idleMs) continue;
					const humans = humanMessagesOf(session);
					if (humans.length < resolved.minMessages) continue;
					const lastHuman = humans[humans.length - 1];
					if (now - lastHuman.time < resolved.idleMs) continue;
					const covered = snap.messageSeqs?.length ? Math.max(...snap.messageSeqs) : -1;
					if (covered >= lastHuman.seq) continue;
					const prev = attempts.get(session.id);
					if (prev && prev.throughSeq === lastHuman.seq && now < prev.nextTryAt) continue;
					attempts.set(session.id, {
						throughSeq: lastHuman.seq,
						nextTryAt: now + Math.max(resolved.idleMs, 30 * 60 * 1000)
					});
					log.info(`session-title-idle-refresh: refreshing idle session ${session.id} (idle ${Math.round((now - lastEventTime) / 60000)}min, ${humans.length} human messages); current title: "${snap.title}"`);
					const result = await ctx.sessionTitle.refresh(session);
					refreshed++;
					if (result) log.info(`session-title-idle-refresh: session ${session.id} title is now "${result.title}"`);
				} catch (error) {
					log.warn(`session-title-idle-refresh: failed on one session: ${error?.message ?? error}`);
				}
			}
		} catch (error) {
			log.warn(`session-title-idle-refresh: scan failed: ${error?.message ?? error}`);
		} finally {
			scanning = false;
		}
	};

	ctx.interval(() => { void scan(); }, resolved.scanMs);
	log.info(`session-title-idle-refresh: active (idleMs=${resolved.idleMs}, scanMs=${resolved.scanMs}, minMessages=${resolved.minMessages}); provider replaces session-title-first-prompt-llm`);
}

export { Config, apply, inject, name };
