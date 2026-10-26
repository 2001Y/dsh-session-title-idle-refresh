// Mock-ctx unit test for dsh-session-title-idle-refresh.
// Usage on the Mac mini (against the INSTALLED copy so @deepseek-ai
// imports resolve through the profile's pnpm store):
//   node /tmp/title-idle-test.mjs
import { apply, selectMessagesForTitle } from "/Users/akitani/.dsh/profiles/web/node_modules/dsh-session-title-idle-refresh/lib/index.js";

let failures = 0;
const check = (label, cond) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failures++;
};

// ---------- selectMessagesForTitle ----------
{
	const msgs = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, text: "x".repeat(500) }));
	const sel = selectMessagesForTitle(msgs, 4096);
	const bytes = Buffer.byteLength(JSON.stringify(sel), "utf8");
	check("trim: fits budget", bytes <= 4096);
	check("trim: keeps first seq", sel[0]?.seq === 1);
	check("trim: keeps last seq", sel[sel.length - 1]?.seq === 50);
	const seqs = sel.map((m) => m.seq);
	check("trim: chronological", seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
	check("trim: empty input", selectMessagesForTitle([], 4096).length === 0);
	const huge = [{ seq: 7, text: "y".repeat(100000) }];
	const selHuge = selectMessagesForTitle(huge, 2048);
	check("trim: single huge message still yields one", selHuge.length === 1 && selHuge[0].seq === 7);
}

// ---------- scanner ----------
const MIN = 60 * 1000;
const now = Date.now();
const msg = (seq, time, text = `message ${seq}`) => ({
	seq, time, type: "user/message",
	data: { source: { kind: "user" }, content: [{ type: "text", text }] }
});
const other = (seq, time) => ({ seq, time, type: "turn/end", data: {} });
const mkSession = (id, events, title, header = {}) => ({
	id, header, _events: events, _title: title,
	snapshotEvents() { return this._events; }
});
const titleSnap = (title, seqs, kind = "provider") => ({
	title, messageSeqs: seqs, eventSeq: 99, updatedAt: now - 60 * MIN,
	source: kind === "user" ? { kind: "user" } : { kind, provider: "someone" }
});

const stale = mkSession("stale", [msg(1, now - 50 * MIN), other(2, now - 49 * MIN), msg(5, now - 45 * MIN), other(6, now - 44 * MIN)], titleSnap("Old Topic", [1]));
const pinned = mkSession("pinned", [msg(1, now - 50 * MIN), msg(5, now - 45 * MIN), other(6, now - 44 * MIN)], titleSnap("Mine", [], "user"));
const covered = mkSession("covered", [msg(1, now - 50 * MIN), msg(5, now - 45 * MIN), other(6, now - 44 * MIN)], titleSnap("Fresh", [1, 5]));
const active = mkSession("active", [msg(1, now - 50 * MIN), msg(5, now - 45 * MIN), other(6, now - 1 * MIN)], titleSnap("Old", [1]));
const child = mkSession("child", [msg(1, now - 50 * MIN), msg(5, now - 45 * MIN), other(6, now - 44 * MIN)], titleSnap("Old", [1]), { parentSession: "stale" });
const single = mkSession("single", [msg(1, now - 50 * MIN), other(2, now - 49 * MIN)], titleSnap("Only", [1]));

const calls = [];
let registered = null;
let intervalCb = null;
const ctx = {
	logger: { info() {}, warn() {} },
	sessionTitle: {
		register(p) { registered = p; },
		get(s) { return s._title; },
		async refresh(s) { calls.push(s.id); return { title: "New Title" }; }
	},
	sessions: { list: () => [stale, pinned, covered, active, child, single] },
	interval(cb) { intervalCb = cb; return () => {}; },
	llm: {}
};

apply(ctx, { idleMs: 30 * MIN, scanMs: 60000, minMessages: 2, maxPerScan: 3 });
check("provider registered", registered !== null);
check("provider automatic is first-prompt", registered?.automatic === "first-prompt");
check("interval registered", typeof intervalCb === "function");

await intervalCb();
await new Promise((r) => setTimeout(r, 50));
check("refresh called exactly once (stale only)", calls.length === 1 && calls[0] === "stale");

await intervalCb();
await new Promise((r) => setTimeout(r, 50));
check("second scan does not retry same tail", calls.length === 1);

console.log(failures === 0 ? "ALL OK" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
