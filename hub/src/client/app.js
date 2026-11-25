/* Sherit Mail: client. One inbox over three backends:
   hub (our Worker: custom domains), Gmail (REST from this browser with Worker-minted tokens; Gmail stays the mailbox of record),
   IMAP (work mailbox, synced by the Worker into the hub store: arrives with gate 2).
   Vanilla JS, no framework. IndexedDB cache renders first; every backend refreshes in the background. */
const VERSION = "__VERSION__";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Bidirectional controls in what a sender writes about himself: a display name ending in U+202E
// (RIGHT-TO-LEFT OVERRIDE) reversed the rest of the From line, the address included, in the rows and the header. Names and addresses
// shown lose every bidi control and mark (as attachment names do, ATT_INVIS); a subject loses the embeddings, overrides and isolates
// and is drawn in a <bdi>, so the marks an RTL subject may need stay and nothing in it can reorder the text around it.
const BIDI_ALL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, BIDI_CTRL = /[\u202a-\u202e\u2066-\u2069]/g;
const unbidi = (s) => String(s ?? "").replace(BIDI_ALL, "");
const ico = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`; // Font Awesome Free subset inlined in app.html
const lc = (s) => String(s || "").trim().toLowerCase();
const addrOf = (s) => { const m = String(s || "").match(/<([^<>]+)>/); return lc(m ? m[1] : s); };
// The display name of `"Name" <addr>`, else the address's local part. Without a regex over the whole value: the old
// /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/ backtracked cubically: 12.7 s for a From padded with 4,000 spaces. Same answers (200,020 inputs).
const nameOf = (s) => { const v = String(s || ""), i = v.indexOf("<"); if (i >= 0 && /^<[^>]+>\s*$/.test(v.slice(i))) { let n = v.slice(0, i).trim(); if (n.startsWith('"')) n = n.slice(1); if (n.endsWith('"')) n = n.slice(0, -1); if (!n.includes('"')) return n.trim(); } return v.split("@")[0].trim(); };
const toast = (m, ms = 2600, undo = null, label = "Undo") => { const t = $("#toast"); t.textContent = m; t.onclick = null; if (undo) { const b = document.createElement("button"); b.textContent = label; b.style.cssText = "margin-left:12px;padding:3px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit"; b.onclick = (e) => { e.stopPropagation(); t.style.display = "none"; undo(); }; t.appendChild(b); ms = 5000; } t.style.display = "block"; clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.display = "none"), ms); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// In-app confirm: a toast with buttons (Enter = confirm, Esc = cancel); never a native dialog, which freezes the page. Resolves false after 30 s.
function ask(message, { ok = "OK", cancel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const el = $("#ask"); if (ask.pending) ask.pending(false); el.innerHTML = ""; const msg = document.createElement("div"); msg.className = "msg"; msg.textContent = message; el.appendChild(msg);
    const row = document.createElement("div"); row.className = "btns"; const bc = document.createElement("button"); bc.textContent = cancel; const bo = document.createElement("button"); bo.textContent = ok; bo.className = danger ? "danger" : "primary"; row.append(bc, bo); el.appendChild(row);
    const finish = (v) => { ask.pending = null; el.classList.remove("on"); document.removeEventListener("keydown", onKey, true); clearTimeout(tm); resolve(v); };
    const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } };
    bc.onclick = () => finish(false); bo.onclick = () => finish(true); ask.pending = finish; const tm = setTimeout(() => finish(false), 30000);
    el.classList.add("on"); document.addEventListener("keydown", onKey, true); bo.focus();
  });
}
const modal = { cancel: null }; // one owner of #tmodal at a time: opening a new card cancels the previous owner (its promise resolves as cancelled)
function claimModal(onCancel) { const prev = modal.cancel; modal.cancel = null; if (prev) { try { prev(); } catch (_) {} } modal.cancel = onCancel; }
function releaseModal(fn) { if (modal.cancel === fn) modal.cancel = null; $("#tmodal").classList.remove("on"); }
// Escape, back and a click on the backdrop close the open card the way its Cancel does.
function cancelCard() { if (!$("#tmodal").classList.contains("on")) return false; const c = modal.cancel; if (c) { try { c(); } catch (_) {} } $("#tmodal").classList.remove("on"); return true; }
// In-app text prompt: small card with one field (Enter = OK, Esc = cancel). Resolves null on cancel.
function askText(title, value = "", { ok = "OK", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    const finish = (v) => { releaseModal(onCancel); resolve(v); }; const onCancel = () => finish(null); claimModal(onCancel);
    const m = $("#tcard"); m.innerHTML = `<h3 style="font-size:15px">${esc(title)}</h3><input class="f" id="askv" placeholder="${esc(placeholder)}" style="width:100%"><div class="row" style="justify-content:flex-end"><button id="askc">Cancel</button><button id="asko" class="primary">${esc(ok)}</button></div>`;
    const inp = $("#askv"); inp.value = value; $("#tmodal").classList.add("on"); inp.focus(); inp.select();
    $("#askc").onclick = () => finish(null); $("#asko").onclick = () => finish(inp.value); inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(inp.value); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); } };
  });
}
const b64u = { enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), decToStr: (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }, decBytes: (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } };
const utf8b64 = (s) => btoa(unescape(encodeURIComponent(s)));
// Every row's date is formatted on every render, and each toLocale*String call builds a fresh Intl formatter: 240 rows cost ~28 ms on a
// phone-speed CPU, more than building the rows themselves. The formatters are made once and each label is remembered;
// both are dropped when the day or the time zone changes, so "Today", "Yesterday" and the times stay true across midnight and travel.
const dateFmt = { key: "" };
const fmtFor = () => {
  const n = new Date(), key = n.toDateString() + "|" + n.getTimezoneOffset();
  if (dateFmt.key !== key) Object.assign(dateFmt, { key, n, when: new Map(), day: new Map(),
    time: new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }), md: new Intl.DateTimeFormat([], { month: "short", day: "numeric" }),
    wd: new Intl.DateTimeFormat([], { weekday: "long" }), mdl: new Intl.DateTimeFormat([], { month: "long", day: "numeric" }), mdly: new Intl.DateTimeFormat([], { month: "long", day: "numeric", year: "numeric" }) });
  return dateFmt;
};
const when = (ms) => { if (!ms) return ""; const f = fmtFor(); let v = f.when.get(ms); if (v === undefined) { const d = new Date(ms), n = f.n; v = d.toDateString() === n.toDateString() ? f.time.format(d) : f.md.format(d) + (d.getFullYear() !== n.getFullYear() ? " " + d.getFullYear() : ""); f.when.set(ms, v); } return v; };
const dayLabel = (ms) => { const f = fmtFor(); let v = f.day.get(ms); if (v === undefined) { const d = new Date(ms), n = f.n; const dd = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((dd(n) - dd(d)) / 86400000); v = diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? f.wd.format(d) : (d.getFullYear() !== n.getFullYear() ? f.mdly : f.mdl).format(d); f.day.set(ms, v); } return v; };
const hueFor = (s) => { let h = 0; for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const colorFor = (s) => `hsl(${hueFor(s)} 55% 45%)`;
const hexOf = (c) => { c = String(c || ""); if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase(); const m = /^hsl\((\d+(?:\.\d+)?)\s+(\d+)%\s+(\d+)%\)$/.exec(c); if (!m) return "#3b5bdb";
  const h = +m[1], s = m[2] / 100, l = m[3] / 100, k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join(""); };
const fileToB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
async function filesOf(input) { const out = []; for (const f of input?.files || []) out.push({ filename: f.name, type: f.type || "application/octet-stream", content: await fileToB64(f) }); return out; }
// A draft's files live in its own file input whichever way they came, the Attach picker or a drop, so sending, the
// unsaved-work check and the "2 files" label all read one list. The change event keeps the label true when code sets the list.
function setFiles(input, files) { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event("change")); }
const clearFiles = (input) => { input.value = ""; input.dispatchEvent(new Event("change")); };   // no DataTransfer: it runs on every conversation opened

// ---------- hub API (cookie session) ----------
// No request may wait for ever: everything the app does (the sync behind state.loading, a notification tap, the push import) sits
// behind one of these. The deadline covers reading the body too, and a body cut off by it is an error, never an empty success.
// Sends carry attachments over mobile uplinks, so anything that is not a GET gets the long one.
const NET_GET_MS = 45_000, NET_SEND_MS = 180_000;
const netDeadline = (ms) => { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms); if (typeof AbortController === "undefined") return undefined; const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
const netSignal = (o) => o.signal || netDeadline(String(o.method || "GET").toUpperCase() === "GET" ? NET_GET_MS : NET_SEND_MS);
const aborted = (e) => e && (e.name === "AbortError" || e.name === "TimeoutError");
async function api(p, o = {}) {
  const r = await fetch(p, { credentials: "same-origin", ...o, signal: netSignal(o), headers: { "content-type": "application/json", ...(o.headers || {}) } });
  perf.netCall((o.method || "GET") + " " + p.replace(/[0-9a-f-]{36}/g, ":id").split("&")[0], Number(r.headers.get("content-length")) || 0);
  if (r.status === 401) { state.signedOut = true; renderSignedOut(); throw new Error("Signed out"); }
  const j = await r.json().catch((e) => { if (aborted(e)) throw e; return {}; });
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, code: j.code, message_id: j.message_id, body: j });
  return j;
}

// ---------- IndexedDB cache: see store.js ----------

// ---------- state ----------
const state = {
  me: { identities: [] }, gmail: [], prefs: {}, push: {}, rules: [], schedules: [],
  view: { kind: "inbox", account: null, cat: null }, threads: new Map(), // key -> thread
  cur: null, curThread: null, selecting: false, checked: new Set(), search: "", signedOut: false, hubMsgIds: new Set(), hubMsgThread: new Map(), snoozedGmail: new Map(), loading: false, pendingSenders: new Set(), pageTokens: {}, serverSearch: new Map(), searchPending: false, searchHits: null,
};
// Drafts (the code is under "drafts"): declared here, before anything can render a row or the sidebar that reads them.
const draftStore = { map: new Map(), keys: new Set(), cursor: 0, chains: new Map(), syncing: null, loaded: null, persistT: null };
const editors = { c: newHandle("c"), r: newHandle("r") };   // the compose window and the reply box, each with the draft it is writing
const CATS = { personal: "Personal", notifications: "Notifications", newsletters: "Newsletters" };
const ACTIONS = { archive: "Done", trash: "Trash", snooze: "Snooze", spam: "Report spam", block: "Block sender", unsubscribe: "Unsubscribe", star: "Pin", read: "Mark read", unread: "Mark unread", none: "Nothing" };
const spamSwipe = (a, t) => a === "spam" && t && t.out ? "trash" : a;   // your own sent mail is never reported or blocked: Trash
// A swipe shows the colour of its ACTION, whichever side or length it is on : Done green, Trash red, Unsubscribe
// orange and far enough from red to tell apart, Snooze blue. Actions not named keep the old side/length colours.
const SWIPE_COLORS = { archive: "var(--ok)", trash: "var(--danger)", spam: "var(--danger)", block: "var(--danger)", unsubscribe: "var(--unsub)", snooze: "var(--acc)" };
const SWIPE_DEFAULTS = { left: "archive", leftLong: "trash", right: "snooze", rightLong: "block" }; // Spark-style: a short swipe and a long swipe per side
const prefs = () => ((p) => { p.swipes = { ...SWIPE_DEFAULTS, ...(p.swipes || {}) }; return p; })({ swipes: { ...SWIPE_DEFAULTS }, showDupes: false, groupByDay: true, notify: "all", gatekeeper: "off", openInChrome: true, groupSenders: true, signatures: {}, setAside: [], knownSenders: [], catOverrides: {}, priorityThreads: [], keys: {}, snippets: [], splits: [], muted: [], mutedAt: {}, renames: {}, replyLater: [], ...(state.prefs || {}) });
// Prefs come from the hub as free-form JSON; anything of the wrong shape falls back to its default so a bad value cannot break the UI.
function normalizePrefs(p) { const out = { ...p }; for (const k of ["setAside", "knownSenders", "priorityThreads", "snippets", "splits", "muted", "replyLater", "acctOrder", "ownRows"]) if (!Array.isArray(out[k])) delete out[k]; if (out.ownRows) out.ownRows = out.ownRows.filter((x) => typeof x === "string").map((x) => x.toLowerCase()); for (const k of ["acctNames", "acctColors", "swipes", "signatures", "catOverrides", "keys", "mutedAt", "renames", "notifyByAccount"]) if (!out[k] || typeof out[k] !== "object" || Array.isArray(out[k])) delete out[k]; for (const k of ["notify", "gatekeeper", "compose"]) if (typeof out[k] !== "string") delete out[k]; for (const k of ["openInChrome", "groupByDay", "showDupes", "groupSenders", "splitDomains"]) if (out[k] !== undefined && typeof out[k] !== "boolean") delete out[k]; if (out.snippets) out.snippets = out.snippets.filter((s) => s && typeof s.name === "string" && typeof s.text === "string"); if (out.splits) out.splits = out.splits.filter((s) => s && typeof s.name === "string" && typeof s.query === "string"); if (out.keys) for (const [k, v] of Object.entries(out.keys)) if (typeof v !== "string" || v.length > 12) delete out.keys[k]; if (out.acctOrder) out.acctOrder = out.acctOrder.filter((x) => typeof x === "string"); if (out.acctNames) out.acctNames = Object.fromEntries(Object.entries(out.acctNames).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, v.trim().slice(0, 40)])); if (out.acctColors) out.acctColors = Object.fromEntries(Object.entries(out.acctColors).filter(([, v]) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)).map(([k, v]) => [k, v.toLowerCase()])); return out; }
state.keep = new Set(); state.focus = null; state.lastChecked = null; state.bulkLog = [];
const KEY_DEFAULTS = { next: "j", prev: "k", open: "Enter", archive: "e", trash: "#", star: "s", unread: "u", snooze: "h", reply: "r", replyall: "a", forward: "f", compose: "c", search: "/", select: "x", palette: "k", mute: "m", unsubscribe: "!", replylater: "l", aside: "g", back: "Escape", readnext: "n", selectall: "A", fromhere: "X" };
const keyFor = (action) => (prefs().keys || {})[action] || KEY_DEFAULTS[action];
const hint = (action) => { const k = keyFor(action); return k && k.length <= 2 ? ` <span class="kb">${esc(k)}</span>` : (k === "Enter" ? " ⏎" : ""); };
async function setPref(k, v) { state.prefs[k] = v; try { await api("/api/prefs", { method: "PUT", body: JSON.stringify({ [k]: v }) }); } catch (e) { toast(e.message); } }
const catOf = (t) => { const r = senderRule(t.fromAddr, t.account); return (r && r.category) || t.cat; };
const isPriority = (t) => senderRule(t.fromAddr, t.account)?.action === "priority" || prefs().priorityThreads.includes(t.key);
const isNewSender = (t) => prefs().gatekeeper === "top" && viewBox() === "inbox" && !t.out && !!t.fromAddr && state.pendingSenders.has(t.fromAddr) && !senderRule(t.fromAddr, t.account) && !state.me.identities.some((i) => i.email === t.fromAddr) && !state.gmail.some((g) => g.email === t.fromAddr);
let expanded = new Set();
// An IMAP mailbox with no password is CONFIGURED, not CONNECTED; my call: a mailbox that is not wired up yet should not
// be shown; the functionality should work, but nothing needs to watch it. Until it has credentials it must not own
// threads, appear in the sidebar, or accept actions: an action queued against an unreachable mailbox throws and retries for ever,
// which is what left the queue permanently non-empty and stopped the installed app updating itself all day.
// The full list stays available to Settings, so it is still visible as something to finish wiring up rather than silently gone.
const imapAcctsAll = () => state.me.imap_accounts || [];
const imapAccts = () => imapAcctsAll().filter((a) => a.ready);
// A work mailbox's state as the hub last saw it. Settings said "connected" whenever a password was saved, through 11 hours of refused
// sign-ins on 2026-10-07.
const imapStatusHtml = (a) => !a.ready ? '<span style="color:var(--warn)">needs its password</span>'
  : a.signin_refused ? `<span style="color:var(--danger)">the server is refusing the password${a.retry_at ? " · next try " + esc(new Date(a.retry_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : ""}</span>`
  : a.last_error ? `<span style="color:var(--warn)">${esc(String(a.last_error).slice(0, 90))}</span>` : '<span style="color:var(--ok)">connected</span>';
const acctNames = () => (state.prefs && state.prefs.acctNames) || {};   // the user's names for accounts, synced (prefs)
// A colour for any sidebar entry, synced the same way: Domains and each split domain had a fixed one, and a work
// mailbox from wrangler.toml could not take one. A colour saved on a Gmail account or a work mailbox is the fallback.
const acctColors = () => (state.prefs && state.prefs.acctColors) || {};
const accountsAll = () => [{ id: "hub", kind: "hub", label: acctNames().hub || "Domains", color: acctColors().hub || "#3b5bdb", addresses: state.me.identities.map((i) => i.email) }, ...imapAccts().map((a) => ({ id: a.email, kind: "hub", imap: true, label: acctNames()[a.email] || a.label || a.email, color: acctColors()[a.email] || a.color || colorFor(a.email), addresses: [a.email], ready: a.ready, refused: !!a.signin_refused, retryAt: a.retry_at || null })), ...state.gmail.filter((g) => g.status === "active").map((g) => ({ id: g.email, kind: "gmail", label: acctNames()[g.email] || g.label || g.email.split("@")[0].replace(/\./g, " "), color: acctColors()[g.email] || g.color || colorFor(g.email), addresses: [g.email] }))];
const ownerOf = (t) => t.kind === "gmail" ? t.account : (imapAccts().some((a) => a.email === t.identity) ? t.identity : "hub");
const accountOf = (id) => accountsAll().find((a) => a.id === id);
// ---------- the sidebar's accounts: my order and names, Domains whole or one entry per domain ----------
// The user asked to reorder accounts by dragging them in Settings, with the sidebar following, and to rename the
// Domains entry or break it out per domain. Display only: mail still belongs to the account that
// fetches it (accountsAll, ownerOf). "hub:<domain>" is the hub's domain mail for one domain. Order, names and the split live in the
// synced prefs, so every device shows the same sidebar; a name set here wins over the hub's label, and clearing it falls back to it.
const domainOf = (addr) => (String(addr || "").split("@")[1] || "").toLowerCase();
// The letterhead: the hub frames a send from an address on one of these domains unless the draft says plain. The box
// shows only for such a From, on by default each time the composer or the reply box opens.
const brandFor = (addr) => ((state.me && state.me.brands) || []).includes(domainOf(addr));
function syncBrand(sel) { const l = $(sel === "#cfrom" ? "#cbrandl" : "#rbrandl"); if (!l) return; const on = brandFor($(sel).value); l.style.display = on ? "" : "none"; if (on) l.querySelector("input").checked = true; }
const noLetterhead = (sel) => { const l = $(sel === "#cfrom" ? "#cbrandl" : "#rbrandl"); return l && l.style.display !== "none" && !l.querySelector("input").checked ? true : undefined; };
const hubDomains = () => [...new Set(state.me.identities.map((i) => domainOf(i.email)).filter(Boolean))].sort();
// The domains given a sidebar row of their own; the rest stay together under the Domains entry. It was all or nothing
// (splitDomains), which still means every domain. Asked for every row of a list, so the answer is kept until the prefs
// or the addresses change (new arrays, or a push that changes the addresses' length).
let ownMemo = null;
function ownRowDomains() {
  const p = state.prefs || {}, ids = (state.me && state.me.identities) || [], key = [p.ownRows, p.splitDomains, ids, ids.length];
  if (ownMemo && ownMemo.key.every((x, i) => x === key[i])) return ownMemo.v;
  const hd = hubDomains(), v = new Set(hd.length < 2 ? [] : p.splitDomains ? hd : (Array.isArray(p.ownRows) ? p.ownRows : []).filter((d) => hd.includes(d)));
  ownMemo = { key, v }; return v;
}
const splitDomains = () => ownRowDomains().size > 0;
// A domain's name on a row or a chip: the name given to it in Settings, or the domain without its suffix ("sheritlabs"), in full when
// two of the hub's domains would cut to the same word (zone.test and zone.example).
function domLabel(d) {
  const n = acctNames()["hub:" + d]; if (n) return n;
  const s = shortDomain(d); return hubDomains().filter((x) => shortDomain(x) === s).length > 1 ? d : s;
}
function sideAccounts() {
  const names = acctNames(), base = [];
  for (const a of accountsAll()) {
    if (a.id !== "hub" || !splitDomains()) { base.push(a.id === "hub" ? { ...a, domains: hubDomains() } : a); continue; }
    const own = ownRowDomains(), rest = hubDomains().filter((d) => !own.has(d));
    if (rest.length) base.push({ ...a, domains: rest, addresses: a.addresses.filter((x) => rest.includes(domainOf(x))) });
    for (const d of hubDomains()) if (own.has(d)) base.push({ id: "hub:" + d, kind: "hub", domain: d, label: names["hub:" + d] || d, color: acctColors()["hub:" + d] || colorFor(d), addresses: a.addresses.filter((x) => domainOf(x) === d) });
  }
  // A saved order places what it names; Domains and its domains stand in for each other, so turning the split on or off keeps the place.
  const order = (state.prefs && state.prefs.acctOrder) || [];
  const pos = (id, i) => { let k = order.indexOf(id); if (k >= 0) return k;
    if (id.startsWith("hub:")) { k = order.indexOf("hub"); if (k >= 0) return k + 0.01 * (1 + hubDomains().indexOf(id.slice(4))); }
    if (id === "hub") { k = order.findIndex((x) => x.startsWith("hub:")); if (k >= 0) return k; }
    return order.length + i; };
  return base.map((a, i) => [pos(a.id, i), a]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
}
const sideOf = (id) => (id && sideAccounts().find((a) => a.id === id)) || accountOf(id);
const dataAccount = (id) => id && id.startsWith("hub:") ? "hub" : id;   // the account that fetches a sidebar entry's mail
// The Domains entry holds the domains without a row of their own.
const inAccount = (t, id) => id.startsWith("hub:") ? ownerOf(t) === "hub" && domainOf(t.identity) === id.slice(4) : id === "hub" ? ownerOf(t) === "hub" && !ownRowDomains().has(domainOf(t.identity)) : ownerOf(t) === id;
// The badge on a row of domain mail: the domain, under the name given to it.
// A domain without its suffix ("sheritlabs" for yourdomain.example): how a row shortens a default name that is a domain or an address.
const shortDomain = (d) => { const p = String(d || "").toLowerCase().split(".").filter(Boolean); return p.length < 2 ? p.join(".") : p.slice(0, p.length > 2 && TRUST_SUFFIX2.has(p.slice(-2).join(".")) ? -2 : -1).join("."); };
// Who a row is about (a conversation where the user wrote last read "You" in the list, with no sign of which
// vendor it was).
// When the last message is ours the row names where it went, as Gmail names the other party and Outlook's Sent view shows the To
// column: the first recipient that is not one of our addresses, by the name the To line gives it or else its address, "+N" for the
// rest. None of the 15 such conversations on 2026-10-12 had a name on its To line, so most show the address. A send with no To (Bcc
// only) still reads "You". Mail we received is unchanged: the sender's name, initial and colour.
function rowPeer(t) {
  const own = { label: unbidi(t.fromName || t.fromAddr), initial: unbidi(t.fromName)[0] || "?", key: t.fromAddr || t.fromName };
  if (!t.out) return own;
  const all = parseAddrList(t.to), others = all.filter((a) => !isMine(a.addr)), list = others.length ? others : all;
  if (!list.length) return own;
  const p = list[0], nm = unbidi(p.name || p.addr) || "?";
  return { label: "→ " + nm + (list.length > 1 ? " +" + (list.length - 1) : ""), initial: nm[0], key: p.addr };
}

// ---------- categorizer (Spark's Smart Inbox: Personal / Notifications / Newsletters) ----------
const AUTO_RE = /^(no-?reply|noreply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounce|bounces|auto|automated|system|info|support|hello|team|news|newsletter|digest|updates?|billing|receipts?|orders?|shipping|security|account|accounts|verify|verification)([._+-]|@|$)/i;
function categorize({ headers = {}, from = "", labels = [] }) {
  const h = (n) => headers[lc(n)] || "";
  if (h("list-unsubscribe") || h("list-id") || /bulk|list/i.test(h("precedence")) || labels.includes("CATEGORY_PROMOTIONS") || labels.includes("CATEGORY_FORUMS")) return "newsletters";
  if (labels.includes("CATEGORY_UPDATES") || labels.includes("CATEGORY_SOCIAL") || /auto-(generated|replied|notified)/i.test(h("auto-submitted")) || AUTO_RE.test(addrOf(from))) return "notifications";
  return "personal";
}
// The sender rules, indexed. senderRule() scanned every rule, lower-casing each pattern, on every call, and the list sort called it on
// both sides of every comparison: 38,706 comparisons for 3,854 inbox rows, 285 ms per refresh on my Mac. Rules
// are now bucketed by exact address and by domain, keeping their original positions, and each answer is remembered until the list
// changes (a new array, or a push that changes its length). The choice among the matching rules is the same loop over the same rules in
// the same order (a rule that does not match could never have been chosen) so the precedence cannot drift: account-scoped over
// every-account, exact address over domain, otherwise the earlier rule.
const ruleIndex = { of: null, n: -1, exact: new Map(), dom: new Map(), memo: new Map() };
function senderRule(addr, account) {
  const rules = state.rules;
  if (ruleIndex.of !== rules || ruleIndex.n !== rules.length) {
    Object.assign(ruleIndex, { of: rules, n: rules.length, exact: new Map(), dom: new Map(), memo: new Map() });
    rules.forEach((r, i) => { const p = lc(r.pattern); const isDom = p.startsWith("*@"); const m = isDom ? ruleIndex.dom : ruleIndex.exact; const k = isDom ? p.slice(2) : p; const l = m.get(k); if (l) l.push(i); else m.set(k, [i]); });
  }
  const mk = addr + "\u0001" + account; const hit = ruleIndex.memo.get(mk); if (hit !== undefined) return hit;
  const a = lc(addr), dom = a.split("@")[1];
  const idx = (ruleIndex.exact.get(a) || []).concat(dom !== undefined ? ruleIndex.dom.get(dom) || [] : []).sort((x, y) => x - y);
  let best = null;
  for (const i of idx) { const r = rules[i]; if (r.scope !== "*" && lc(r.scope) !== lc(account)) continue; const p = lc(r.pattern); const exact = p === a; if (!(exact || (p.startsWith("*@") && p.slice(2) === dom))) continue; if (!best || (r.scope !== "*" && best.scope === "*") || (exact && lc(best.pattern).startsWith("*@") && !(best.scope !== "*" && r.scope === "*"))) best = r; }
  ruleIndex.memo.set(mk, best); return best;
}

// ---------- adapters ----------
// What each thread action does, in one place: the state it leaves on the conversation (applyLocal, the
// bulk patch, the hub PATCH) and the Gmail labels it adds and removes (the Gmail adapter, bulk, the local label copy). Five tables
// and an if-chain said this separately and drifted: Pin wrote the opposite label locally, and Done meant archive in one place and
// archive + read in another. test/actions.py checks every path against this table and against gmailDelta. (ACTIONS, above, is
// the swipe labels.)
const THREAD_ACTIONS = {
  archive: { set: { state: "archived" }, add: [], remove: ["INBOX"] },
  done: { set: { state: "archived", unread: false }, add: [], remove: ["INBOX", "UNREAD"] },
  undone: { set: { state: "inbox", unread: true }, add: ["INBOX", "UNREAD"], remove: [] },
  trash: { set: { state: "trash" }, add: ["TRASH"], remove: ["INBOX"] },
  restore: { set: { state: "inbox" }, add: ["INBOX"], remove: ["TRASH"] },
  spam: { set: { state: "spam" }, add: ["SPAM"], remove: ["INBOX"] },
  notspam: { set: { state: "inbox" }, add: ["INBOX"], remove: ["SPAM"] },
  read: { set: { unread: false }, add: [], remove: ["UNREAD"] },
  unread: { set: { unread: true }, add: ["UNREAD"], remove: [] },
  star: { set: { starred: true }, add: ["STARRED"], remove: [] },
  unstar: { set: { starred: false }, add: [], remove: ["STARRED"] },
};
// Pin toggles: which of star / unstar it is, from the starred value BEFORE the toggle.
const actionKey = (action, wasStarred) => action === "star" ? (wasStarred ? "unstar" : "star") : action;
const hub = {
  id: "hub", kind: "hub",
  norm(t) {
    const l = t.last || {}; const out = l.direction === "out"; const labels = JSON.parse(t.labels || "[]");
    const uh = (() => { try { return typeof t.unsub === "string" ? JSON.parse(t.unsub) : (t.unsub || {}); } catch (_) { return {}; } })(); // newest inbound List-Unsubscribe of the thread (server column)
    const from = out ? l.identity : (l.from_name ? `${l.from_name} <${l.from_addr}>` : l.from_addr);
    const to = (() => { try { return JSON.parse(l.to_addrs || "[]").map((a) => a.address).join(", "); } catch (_) { return ""; } })();
    return { key: `hub|${t.id}`, account: "hub", kind: "hub", id: t.id, msgIds: (t.msg_ids || []).map((x) => String(x).replace(/^<|>$/g, "")), subject: l.subject || "(no subject)", snippet: l.snippet || "", from, fromAddr: out ? l.identity : lc(l.from_addr), fromName: out ? "You" : (l.from_name || nameOf(l.from_addr)), to, identity: l.identity || "", out, date: Date.parse(l.created_at || t.last_message_at) || 0, unread: !!t.unread, starred: !!t.starred, state: t.state, labels, cat: t.category || categorize({ from: l.from_addr || "" }), count: t.message_count || 1, lastMsgId: l.id, unsub: uh.list_unsubscribe || (!out && l.list_unsubscribe) || "", unsubPost: uh.list_unsubscribe_post || (!out && l.list_unsubscribe_post) || "", unsubKnown: true, msgIdHdr: (l.message_id || "").replace(/^<|>$/g, ""), hasAtt: !!t.has_att, sentOnly: t.has_in === 0, hasOut: t.has_out === 1 };
  },
  async list(box, q) { const d = await api(`/api/threads?limit=200&box=${box}${q ? "&q=" + encodeURIComponent(q) : ""}`); const rows = d.threads.map((t) => this.norm(t)); state.pageTokens[`hub|${box}|${q || ""}`] = rows.length >= 200 ? { before: d.threads[d.threads.length - 1].last_message_at } : null; return rows; },
  async more(box, q) { const k = `hub|${box}|${q || ""}`; const pt = state.pageTokens[k]; if (!pt) return []; const d = await api(`/api/threads?limit=200&box=${box}&before=${encodeURIComponent(pt.before)}${q ? "&q=" + encodeURIComponent(q) : ""}`); state.pageTokens[k] = d.threads.length >= 200 ? { before: d.threads[d.threads.length - 1].last_message_at } : null; return d.threads.map((t) => this.norm(t)); },
  // keep_unread: a prefetch, an undo's check or the feed reading a conversation is not the user opening it. GET marks it read on the
  // hub otherwise, so unopened mail turned read within a sync and the work mailbox never learned.
  // openThread marks it read itself, through the queue.
  async thread(id) { return this.normalize(await api("/api/threads/" + id + "?keep_unread=1")); },
  // A sent message's `from` is the From it went out with, "Name <address>"; it was "You (<address>)", which a reply's
  // "On …, X wrote:" line and a forward's "From:" line would have carried to the recipient.
  normalize(d) { return { thread: d.thread, messages: d.messages.map((m) => ({ id: m.id, from: m.direction === "out" ? (m.from_name ? `${m.from_name} <${m.identity}>` : m.identity) : (m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr), fromAddr: m.direction === "out" ? m.identity : lc(m.from_addr), to: (m.to_addrs || []).map((a) => a.address).join(", "), cc: (m.cc_addrs || []).map((a) => a.address).join(", "), date: Date.parse(m.created_at), subject: m.subject, text: m.body_text, html: m.body_html, out: m.direction === "out", identity: m.identity, replyTo: m.reply_to, authResults: m.auth_results || null, attachments: (m.attachments || []).map((a) => ({ id: a.id, name: a.filename, size: a.size_bytes, mime: a.content_type || "", disposition: a.disposition || "", cid: a.content_id, url: "/api/att/" + a.id })), msgIdHdr: (m.message_id || "").replace(/^<|>$/g, ""), refs: m.refs, labels: JSON.parse(m.labels || "[]"), gmailCopy: m.gmail_copy, lockKept: !!m.lock_kept, lockRoot: m.lock_root || null, lockClaim: m.lock_claim || null })) }; },
  async put(t, from, to) { const p = {}; if (to.state !== from.state) p.state = to.state; if (!!to.unread !== !!from.unread) p.unread = !!to.unread; if (to.starred !== undefined && !!to.starred !== !!from.starred) p.starred = !!to.starred; if (Object.keys(p).length) return api("/api/threads/" + t.id, { method: "PATCH", body: JSON.stringify(p) }); },
  async act(t, action) {
    if (action === "purge") return api("/api/threads/" + t.id, { method: "DELETE" });
    if (action === "spam") return;   // hub mail has no spam folder
    const a = THREAD_ACTIONS[actionKey(action, t.starred)]; if (a) return api("/api/threads/" + t.id, { method: "PATCH", body: JSON.stringify(a.set) });
  },
  async send(d) { return api("/api/send", { method: "POST", body: JSON.stringify(d) }); },
  async reply(msgId, d) { return api(`/api/messages/${msgId}/reply`, { method: "POST", body: JSON.stringify(d) }); },
  async forward(msgId, d) { return api(`/api/messages/${msgId}/forward`, { method: "POST", body: JSON.stringify(d) }); },
};

const gmailTokens = new Map();
async function gtoken(email) { const c = gmailTokens.get(email); if (c && Date.parse(c.expires_at) - Date.now() > 90000) return c.access_token; const j = await api(`/api/gmail/accounts/${encodeURIComponent(email)}/token`, { method: "POST" }); gmailTokens.set(email, j); return j.access_token; }
async function gapi(email, path, o = {}) {
  const at = await gtoken(email);
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { ...o, signal: netSignal(o), headers: { authorization: "Bearer " + at, ...(o.body ? { "content-type": "application/json" } : {}) } });
  perf.netCall("gmail " + path.replace(/\/[A-Za-z0-9_-]{8,}/g, "/:id").split("&")[0], Number(r.headers.get("content-length")) || 0);
  if (r.status === 401) { gmailTokens.delete(email); }
  if (r.status === 429) { gmailCooldown.set(email, Date.now() + 61000); }
  const j = await r.json().catch((e) => { if (aborted(e)) throw e; return {}; });
  if (!r.ok) throw Object.assign(new Error(r.status === 429 ? "Gmail is rate-limiting this account; the sync is paused for a minute and the action retries by itself" : ((j.error && j.error.message) || r.statusText)), { status: r.status });
  return j;
}
const hv = (m, n) => (((m || {}).payload || {}).headers || []).find((x) => lc(x.name) === lc(n))?.value || "";
const hmap = (m) => { const o = {}; for (const h of ((m || {}).payload || {}).headers || []) o[lc(h.name)] = h.value; return o; };
function gmailAdapter(email) {
  const META = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=List-Id&metadataHeaders=Precedence&metadataHeaders=Auto-Submitted&metadataHeaders=Message-ID";
  const self = {
    id: email, kind: "gmail",
    norm(th) {
      const every = th.messages || []; const msgs = shownMessages(every, (m) => m.labelIds); const last = msgs[msgs.length - 1] || {}; const first = msgs[0] || {}; // the messages Gmail's Inbox shows (store.js)
      const labels = new Set(); for (const m of msgs) for (const l of m.labelIds || []) labels.add(l);
      const lastIn = [...msgs].reverse().find((m) => !(m.labelIds || []).includes("SENT")) || last;
      const unsubMsg = [...msgs].reverse().find((m) => !(m.labelIds || []).includes("SENT") && hv(m, "List-Unsubscribe")) || null; // newest inbound message that carries List-Unsubscribe
      const from = hv(lastIn, "From") || hv(last, "From"); const out = (last.labelIds || []).includes("SENT");
      const st = labels.has("TRASH") ? "trash" : labels.has("SPAM") ? "spam" : (labels.has("INBOX") ? "inbox" : (state.snoozedGmail.has(`${email}|${th.id}`) ? "snoozed" : "archived"));   // as deriveGmailThread (store.js): a server-search row from in:spam was "archived"
      return { key: `${email}|${th.id}`, account: email, kind: "gmail", id: th.id, subject: hv(first, "Subject") || hv(last, "Subject") || "(no subject)", snippet: gmailSnippet(last.snippet), from, fromAddr: addrOf(from), fromName: out ? "You" : nameOf(from), to: hv(last, "To"), identity: email, out, date: Number(last.internalDate) || Date.parse(hv(last, "Date")) || 0, unread: labels.has("UNREAD"), starred: labels.has("STARRED"), state: st, labels: [...labels], cat: categorize({ headers: hmap(lastIn), from, labels: [...labels] }), count: msgs.length, shownIds: msgs.length < every.length ? msgs.map((m) => m.id) : null, binnedIds: trashedIds(every, msgs, (m) => m.labelIds), lastMsgId: last.id, msgIdHdr: (hv(last, "Message-ID") || "").replace(/^<|>$/g, ""), msgIds: every.map((m) => (hv(m, "Message-ID") || "").replace(/^<|>$/g, "")), hasAtt: false, unsub: unsubMsg ? hv(unsubMsg, "List-Unsubscribe") : "", unsubPost: unsubMsg ? hv(unsubMsg, "List-Unsubscribe-Post") : "", unsubKnown: true };
    },
    async fetchThreads(ids) { const out = []; const batch = 8; for (let i = 0; i < ids.length; i += batch) out.push(...await Promise.all(ids.slice(i, i + batch).map((id) => gapi(email, `threads/${id}?${META}`).catch(() => null)))); return out.filter(Boolean).map((t) => this.norm(t)); },
    async list(box, q) {
      let query = "";
      if (q) query = `q=${encodeURIComponent(q)}`;
      else if (box === "inbox") query = "labelIds=INBOX";
      else if (box === "starred") query = "labelIds=STARRED";
      else if (box === "trash") query = "labelIds=TRASH";
      else if (box === "sent") query = "labelIds=SENT";
      else if (box === "archived") query = "q=" + encodeURIComponent("-in:inbox -in:trash -in:spam -in:drafts -in:sent");
      else if (box === "unread") query = "labelIds=UNREAD&labelIds=INBOX";
      else if (box === "snoozed") { const ids = [...state.snoozedGmail.keys()].filter((k) => k.startsWith(email + "|")).map((k) => k.split("|")[1]); return this.fetchThreads(ids); }
      else if (box === "all") query = "q=" + encodeURIComponent("-in:trash -in:spam");
      else return [];
      const l = await gapi(email, `threads?maxResults=60&${query}`);
      state.pageTokens[`${email}|${box}|${q || ""}`] = l.nextPageToken ? { query, token: l.nextPageToken } : null;
      return this.fetchThreads((l.threads || []).map((t) => t.id));
    },
    async more(box, q) { const k = `${email}|${box}|${q || ""}`; const pt = state.pageTokens[k]; if (!pt) return []; const l = await gapi(email, `threads?maxResults=60&${pt.query}&pageToken=${encodeURIComponent(pt.token)}`); state.pageTokens[k] = l.nextPageToken ? { query: pt.query, token: l.nextPageToken } : null; return this.fetchThreads((l.threads || []).map((t) => t.id)); },
    async changedSince() { const cur = await idb.meta("gcursor:" + email); const p = await gapi(email, "profile"); if (!cur) { await idb.meta("gcursor:" + email, p.historyId); return true; } if (cur === p.historyId) return false; await idb.meta("gcursor:" + email, p.historyId); return true; },
    async thread(id, opts) { return this.normalize(await gapi(email, `threads/${id}?format=full`), opts); },
    // Normalising is split from fetching so the SAME code reads a thread the service worker already pulled down when the push
    // arrived (stashed raw under meta `pf:`). The worker stores bytes and stays dumb; there is exactly one parser, here.
    // `binned`: the conversation as Trash shows it, its trashed messages only, when others in it are live (trashedIds, store.js).
    normalize(th, { binned = false } = {}) {
      const every = th.messages || [], live = shownMessages(every, (m) => m.labelIds), lens = binned && live.length < every.length;
      const messages = (lens ? every.filter((m) => (m.labelIds || []).includes("TRASH")) : live).map((m) => { // a live conversation's trashed messages stay out of view, as in Gmail
        const parts = []; const walk = (p) => { if (!p) return; if (p.parts) p.parts.forEach(walk); else parts.push(p); }; walk(m.payload);
        const dec = (p) => p.body?.data ? b64u.decToStr(p.body.data) : "";
        const text = parts.filter((p) => /^text\/plain/i.test(p.mimeType) && !p.filename).map(dec).join("\n");
        const html = parts.filter((p) => /^text\/html/i.test(p.mimeType) && !p.filename).map(dec).join("\n");
        // `url` is what proxyImages() needs to resolve a `cid:` reference; the hub adapter has always supplied one and this did not, so
        // every inline image in Gmail mail rendered with an empty src. Served same-origin because the frame's CSP is `img-src 'self' data:`.
        const attachments = parts.filter((p) => p.filename && p.body?.attachmentId).map((p) => ({ id: p.body.attachmentId, name: p.filename, size: p.body.size, cid: (p.headers || []).find((h) => lc(h.name) === "content-id")?.value, mime: p.mimeType, msgId: m.id, url: `/api/gmail/att/${encodeURIComponent(email)}/${m.id}/${p.body.attachmentId}?mime=${encodeURIComponent(p.mimeType || "")}` }));
        const from = hv(m, "From"); const out = (m.labelIds || []).includes("SENT");
        return { id: m.id, authResults: ((m.payload || {}).headers || []).filter((x) => lc(x.name) === "authentication-results").map((x) => x.value), from: out ? from || email : from, fromAddr: out ? email : addrOf(from), to: hv(m, "To"), cc: hv(m, "Cc"), date: Number(m.internalDate) || 0, subject: hv(m, "Subject"), text, html: html || (m.payload?.mimeType === "text/html" && m.payload?.body?.data ? b64u.decToStr(m.payload.body.data) : ""), out, identity: email, replyTo: hv(m, "Reply-To"), attachments, msgIdHdr: (hv(m, "Message-ID") || "").replace(/^<|>$/g, ""), refs: hv(m, "References"), inReplyTo: hv(m, "In-Reply-To"), labels: m.labelIds || [], threadId: th.id, unsub: hv(m, "List-Unsubscribe"), unsubPost: hv(m, "List-Unsubscribe-Post") };
      });
      return { thread: { id: th.id }, messages, ...(lens ? { binnedView: true, others: live.length } : {}) };
    },
    async attachment(msgId, attId) { const a = await gapi(email, `messages/${msgId}/attachments/${attId}`); return b64u.decBytes(a.data); },
    // Undo: the conversation goes back exactly as it was. Trash is its own call on Gmail, in both directions.
    async put(t, from, to) {
      if (from.state === "trash" && to.state !== "trash") await gapi(email, `threads/${t.id}/untrash`, { method: "POST", body: "{}" });
      if (to.state === "trash" && from.state !== "trash") return gapi(email, `threads/${t.id}/trash`, { method: "POST", body: "{}" });
      const { add, remove } = gmailDelta(from, to); if (add.length || remove.length) return gapi(email, `threads/${t.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) });
    },
    async act(t, action) {
      const mod = (add, remove) => gapi(email, `threads/${t.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) });
      // Trash moves by its own calls on Gmail, in both directions; every other label change is the table's. The queued copy of the thread
      // is taken after the local change, so its state already reads "inbox": `_before` is what says it was in Trash.
      if (action === "trash") return gapi(email, `threads/${t.id}/trash`, { method: "POST", body: "{}" });
      // A live conversation restored from Trash has only some messages there: untrash brings those back (`binnedIds`, kept in `_before`).
      if (action === "restore" && (t.state === "trash" || t._before?.state === "trash" || t._before?.binnedIds?.length)) await gapi(email, `threads/${t.id}/untrash`, { method: "POST", body: "{}" });
      const a = THREAD_ACTIONS[actionKey(action, t.starred)]; if (!a) return;
      const add = a.add.filter((l) => l !== "TRASH"), remove = a.remove.filter((l) => l !== "TRASH");
      if (add.length || remove.length) return mod(add, remove);
    },
    async send(d) { const raw = buildMime(d); const r = await gapi(email, "messages/send", { method: "POST", body: JSON.stringify({ raw, ...(d.threadId ? { threadId: d.threadId } : {}) }) }); return { message_id: r.id, thread_id: r.threadId }; },
  };
  return self;
}
const gmailLabelIds = new Map();
async function gmailLabel(email, name) { const k = email + "|" + name; if (gmailLabelIds.has(k)) return gmailLabelIds.get(k); const l = await gapi(email, "labels"); let hit = (l.labels || []).find((x) => x.name === name); if (!hit) hit = await gapi(email, "labels", { method: "POST", body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) }); gmailLabelIds.set(k, hit.id); return hit.id; }
const adapters = { hub };
const adapterFor = (id) => id === "hub" ? hub : (adapters[id] ||= gmailAdapter(id));

// RFC 822 builder for Gmail sends (text + attachments); returns base64url
// Minimal Markdown → HTML for outgoing mail (headings, bold, italic, code, links, lists, quotes, paragraphs). Everything is escaped first.
function mdToHtml(src, bare = false) {
  const e = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (x) => e(x).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*]+)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^_\w])_([^_]+)_(?!\w)/g, "$1<i>$2</i>").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>').replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" rel="noopener noreferrer">$2</a>');
  const lines = src.replace(/\r/g, "").split("\n"); const out = []; let para = [], list = null, quote = [], code = null;
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } }; const flushL = () => { if (list) { out.push(`<${list.tag}>` + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + `</${list.tag}>`); list = null; } }; const flushQ = () => { if (quote.length) { out.push("<blockquote style=\"border-left:2px solid #ccc;padding-left:10px;margin:0;color:#555\">" + mdToHtml(quote.join("\n"), true) + "</blockquote>"); quote = []; } };
  for (const ln of lines) {
    if (code !== null) { if (/^```/.test(ln)) { out.push("<pre style=\"background:#f4f4f4;padding:8px;border-radius:4px\">" + e(code.join("\n")) + "</pre>"); code = null; } else code.push(ln); continue; }
    if (/^```/.test(ln)) { flushP(); flushL(); flushQ(); code = []; continue; }
    let m;
    if ((m = ln.match(/^(#{1,3})\s+(.*)$/))) { flushP(); flushL(); flushQ(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if ((m = ln.match(/^>\s?(.*)$/))) { flushP(); flushL(); quote.push(m[1]); continue; } else flushQ();
    if ((m = ln.match(/^\s*[-*]\s+(.*)$/))) { flushP(); if (!list || list.tag !== "ul") { flushL(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.tag !== "ol") { flushL(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { flushP(); flushL(); out.push("<hr>"); continue; }
    if (!ln.trim()) { flushP(); flushL(); continue; }
    flushL(); para.push(ln);
  }
  flushP(); flushL(); flushQ(); if (code) out.push("<pre>" + e(code.join("\n")) + "</pre>");
  return bare ? out.join("\n") : `<div style="font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#111">${out.join("\n")}</div>`;
}
const composeMode = () => prefs().compose || "text";
function withFormat(draft, on) { if (!on || !draft.text) return draft; return { ...draft, html: mdToHtml(draft.text) }; }
const hs = (v) => String(v ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim(); // header-safe: no CR/LF/control characters, ever
function buildMime(d) {
  d = { ...d, from: hs(d.from), from_name: hs(d.from_name), subject: hs(d.subject), messageId: hs(d.messageId), inReplyTo: hs(d.inReplyTo), references: hs(d.references), to: Array.isArray(d.to) ? d.to.map(hs).filter(Boolean) : hs(d.to), cc: Array.isArray(d.cc) ? d.cc.map(hs).filter(Boolean) : hs(d.cc), bcc: Array.isArray(d.bcc) ? d.bcc.map(hs).filter(Boolean) : hs(d.bcc), attachments: (d.attachments || []).map((a) => ({ ...a, filename: hs(a.filename).replace(/"/g, ""), type: hs(a.type).replace(/[";]/g, "") })) };
  const nl = "\r\n"; const boundary = "=_mh_" + Math.random().toString(36).slice(2);
  const enc2047 = (s) => /^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/["\\]/g, "")}"` : `=?UTF-8?B?${utf8b64(s)}?=`;
  const hdr = [`From: ${d.from_name ? `${enc2047(d.from_name)} <${d.from}>` : d.from}`, `To: ${Array.isArray(d.to) ? d.to.join(", ") : d.to}`];
  if (d.cc && (Array.isArray(d.cc) ? d.cc.length : d.cc)) hdr.push(`Cc: ${Array.isArray(d.cc) ? d.cc.join(", ") : d.cc}`);
  if (d.bcc && (Array.isArray(d.bcc) ? d.bcc.length : d.bcc)) hdr.push(`Bcc: ${Array.isArray(d.bcc) ? d.bcc.join(", ") : d.bcc}`);
  hdr.push(`Subject: =?UTF-8?B?${utf8b64(d.subject || "")}?=`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0");
  if (d.messageId) hdr.push(`Message-ID: <${d.messageId}>`);
  if (d.inReplyTo) hdr.push(`In-Reply-To: <${d.inReplyTo}>`); if (d.references) hdr.push(`References: ${d.references}`);
  const plainPart = `Content-Type: text/plain; charset=UTF-8${nl}Content-Transfer-Encoding: base64${nl}${nl}${utf8b64(d.text || "").replace(/(.{76})/g, "$1" + nl)}`;
  const altB = "=_alt_" + Math.random().toString(36).slice(2);
  const textPart = d.html ? `Content-Type: multipart/alternative; boundary="${altB}"${nl}${nl}--${altB}${nl}${plainPart}${nl}--${altB}${nl}Content-Type: text/html; charset=UTF-8${nl}Content-Transfer-Encoding: base64${nl}${nl}${utf8b64(d.html).replace(/(.{76})/g, "$1" + nl)}${nl}--${altB}--${nl}` : plainPart;
  let body;
  if (d.attachments && d.attachments.length) {
    body = `Content-Type: multipart/mixed; boundary="${boundary}"${nl}${nl}--${boundary}${nl}${textPart}${nl}`;
    for (const a of d.attachments) body += `--${boundary}${nl}Content-Type: ${a.type || "application/octet-stream"}; name="${a.filename}"${nl}Content-Disposition: attachment; filename="${a.filename}"${nl}Content-Transfer-Encoding: base64${nl}${nl}${a.content.replace(/(.{76})/g, "$1" + nl)}${nl}`;
    body += `--${boundary}--${nl}`;
  } else body = textPart;
  const raw = hdr.join(nl) + nl + body;
  return b64u.enc(new TextEncoder().encode(raw));
}

// ---------- sync ----------
function viewBox() { const k = state.view.kind; return ["inbox", "personal", "notifications", "newsletters", "feed", "replylater", "aside"].includes(k) ? "inbox" : k; }
// Opened from Trash, a live Gmail conversation with messages in Trash shows those messages, and its action bar is Trash's (Restore).
// …and in a search for in:trash, which lists it too (searchPasses)
const trashLens = (t) => !!t && t.kind === "gmail" && t.state !== "trash" && !!t.binnedIds?.length && (state.search ? searchOf(state.search).in.includes("trash") : viewBox() === "trash");
const inUnread = () => state.view.kind === "unread";
// Seven requests became one. They were already a Promise.all (parallel on the client) but still seven request/response
// pairs over the air, and boot latency measured at ~2.1 x RTT on the critical path, so about 0.7 s of a cold boot on a 300 ms
// mobile link. /api/bootstrap answers all of them in a single Worker invocation and computes each field independently, so one
// failing part cannot fail the boot: whatever is missing falls back to its own endpoint, and a hub too old to know the route
// falls back to all seven. This can never be slower than what it replaces.
async function bootstrapAll() {
  let b = null, bootErr = null;
  try { b = await api("/api/bootstrap"); } catch (e) { b = null; bootErr = e; }
  const bad = (x) => !x || x.__error;
  // `me` is load-bearing: boot has always relied on loadAccounts() REJECTING to short-circuit a signed-out or broken start
  // (`try { await loadAccounts(); } catch (e) { …; return; }`). Swallowing every failure here quietly killed that: a 401 would
  // paint the sign-in button, then resolve with empty defaults, then boot carried on and the next render() wiped the button and
  // installed a poll timer that hammered 401s for ever. So the identity call keeps its teeth; the rest may degrade.
  const needStrict = (k, url) => (bad(b?.[k]) ? api(url) : Promise.resolve(b[k]));
  const need = (k, url, dflt) => (bad(b?.[k]) ? api(url).catch((e) => { console.warn("bootstrap: " + k + " unavailable —", e?.message); return { ...dflt, __degraded: true }; }) : Promise.resolve(b[k]));
  if (b) perf.record("boot:bootstrap", 0.001); // presence marker: the Speed panel shows whether the fast path was taken at all
  const [me, g, p, pc, r, s, ps] = await Promise.all([
    needStrict("me", "/api/me"),
    need("gmail", "/api/gmail/accounts", { accounts: [] }),
    need("prefs", "/api/prefs", { prefs: {} }),
    need("push", "/api/push/config", { configured: false, public_key: null }),
    need("rules", "/api/sender-rules", { rules: [] }),
    need("schedule", "/api/schedule?status=pending", { actions: [] }),
    need("senders", "/api/senders?status=pending", { senders: [] }),
  ]);
  return { me, g, p, pc, r, s, ps, version: b?.version || null };
}
// This device's speed report goes to the hub at most every six hours (index.js POST /api/perf): perf.report() is timings, counts, boot
// phases and the device, never mail content. It replaces a hand export from Settings -> Speed as the way field data reaches a ranking.
async function sendSpeedReport(force = false) {
  let last = 0; try { last = +localStorage.getItem("mh:speedAt") || 0; } catch (_) {}
  if (!force && Date.now() - last < 6 * 3600e3) return false;
  const r = perf.report(); if (!r.rows.length) return false;
  try { await api("/api/perf", { method: "POST", body: JSON.stringify(r) }); } catch (_) { return false; }
  try { localStorage.setItem("mh:speedAt", String(Date.now())); } catch (_) {}
  return true;
}
// Connect Gmail finishes in the default browser, which never reloads this app the way the old same-window callback
// did, so the new account stayed out of the app until a relaunch. For 15 minutes after the click the app asks the hub for its Gmail
// accounts every 10 seconds, and at once when it is looked at again; when one that was not there before appears, the app loads it.
const gmailConnectWait = { at: 0, had: new Set(), busy: false, timer: null };
function gmailConnectWatch() {
  const w = gmailConnectWait; w.at = Date.now(); w.had = new Set(state.gmail.map((g) => g.email));
  clearInterval(w.timer); w.timer = setInterval(gmailConnectBack, 10_000);
}
async function gmailConnectBack() {
  const w = gmailConnectWait;
  if (!w.at || w.busy) return;
  const stop = () => { w.at = 0; clearInterval(w.timer); w.timer = null; };
  if (Date.now() - w.at > 15 * 60_000) return stop();
  w.busy = true;
  try {
    const added = ((await api("/api/gmail/accounts")).accounts || []).map((g) => g.email).filter((e) => !w.had.has(e));
    if (!added.length) return;
    stop(); await loadAccounts(); toast(`Connected ${added.join(", ")}`);
    render(); refresh({ silent: true }); if ($("#gmailConnect")) openSettings("accounts");
  } catch (_) {} finally { w.busy = false; }
}
addEventListener("focus", gmailConnectBack);
document.addEventListener("visibilitychange", gmailConnectBack);
async function loadAccounts() {
  const { me, g, p, pc, r, s, ps, version: bootVersion } = await bootstrapAll();
  if (bootVersion) { state.bootVersion = bootVersion; checkVersion.seed = bootVersion; }   // spent by checkVersion(): the eighth round trip, genuinely folded in
  if (g.__degraded && state.gmail?.length) { g.accounts = state.gmail; }   // keep the accounts we already had rather than blanking them
  else if (g.__degraded) toast("Couldn't load your accounts — retrying shortly");
  setImgPass(me?.img_key);   // the /api/img key (proxyImages); kept in localStorage, so a cold boot has it before this returns
  state.me = me; state.gmail = g.accounts; state.gmailConfigured = g.configured; state.prefs = normalizePrefs(p.prefs || {}); state.push = pc; state.rules = r.rules || []; state.schedules = s.actions || []; state.pendingSenders = new Set((ps.senders || []).map((x) => x.address));
  state.snoozedGmail = new Map(); for (const a of state.schedules) if (a.kind === "snooze" && a.account !== "hub") state.snoozedGmail.set(`${a.account}|${a.ref}`, a);
}
// The snapshot exists for ONE reader: the next cold boot, which paints from it before IndexedDB has opened. So it only has to be
// current by the time this page goes away. Dirty-flag it, flush it when the main thread is idle, and force it out on the two
// events that actually precede a boot: the page being hidden, and pagehide. Never on a 60-second timer.
let snapDirty = false, snapTimer = null;
function writeSnapshotNow() {
  if (!snapDirty) return false;
  if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
  let ok = false;
  try { ok = snapshot.write([...state.threads.values()], { accounts: state.gmail.filter((g) => g.status === "active").map((g) => g.email) }); }
  catch (_) { ok = false; }
  // The flag is cleared only on a WRITE THAT HAPPENED. snapshot.write returns false when its revision guard refuses, and clearing
  // first meant that refusal silently discarded the pending state.
  snapDirty = !ok;
  return ok;
}
function markSnapshotDirty() {
  snapDirty = true;
  if (snapTimer) return;
  snapTimer = setTimeout(() => { snapTimer = null; scheduleIdle(() => { if (!document.hidden) writeSnapshotNow(); }); }, 4000);
}
// hidden and pagehide are the last moments before the state that the next launch will read from; visibilitychange fires on Android
// when the app is backgrounded, which is exactly how this app is left.
addEventListener("visibilitychange", () => { if (document.hidden) { state.hiddenSincePoll = true; writeSnapshotNow(); } });
addEventListener("pagehide", () => writeSnapshotNow());
function dropStalePrerenders() { for (const [k, v] of prerendered) { const t = state.threads.get(k); if (!t || (t.updatedAt && t.updatedAt > v.at) || t.count !== v.d.messages.length) prerendered.delete(k); } }
// The mute moves up to the mail it just put away: it stayed at the moment of
// muting, so a muted conversation the user brought back to the inbox by hand, in Gmail or anywhere, was archived again on every
// refresh. Now only mail newer than the last re-archive does that, which is what a mute is for.
function applyMuted() { const p = prefs(); let moved = null; for (const k of p.muted || []) { const t = state.threads.get(k); if (t && t.state === "inbox" && (t.date || 0) > (p.mutedAt[k] || 0)) { localAct(t, "archive", { quiet: true }); (moved ||= { ...p.mutedAt })[k] = t.date || Date.now(); } } if (moved) { state.prefs.mutedAt = moved; api("/api/prefs", { method: "PUT", body: JSON.stringify({ mutedAt: moved }) }).catch(() => {}); } }   // quietly: a background re-archive must not toast a network error // only a NEW message re-archives; a hand un-archive in Gmail stays
// A Gmail account still owed messages after a sync's slice asks for the next slice a minute later, once the download
// throttle's window has turned over. With push live the backstop poll is ten minutes, too long for new mail to sit undownloaded. A
// hidden page waits: coming back into view refreshes anyway, and that refresh asks again.
const catchupTimers = new Map();
function scheduleCatchup(id, ms = 60_000) {
  if (catchupTimers.has(id)) return;
  catchupTimers.set(id, setTimeout(() => { catchupTimers.delete(id); if (document.hidden) return; if (state.loading) return scheduleCatchup(id, 15_000); refresh({ silent: true, accounts: [id] }); }, ms));
}
async function refresh({ silent = false, accounts = null } = {}) {
  // A refresh that never finished made every later one a silent no-op: my phone, 2026-10-03, for hours. The awaits
  // under it are bounded now (store.js watchdog, network deadlines); if one is ever found unbounded again, the phone's log says so.
  if (state.loading) { if (Date.now() - (state.loadingSince || 0) > 120_000 && !refresh.flagged) { refresh.flagged = true; nativeLog(`a refresh has been running for ${Math.round((Date.now() - state.loadingSince) / 1000)} s; later refreshes are being skipped`); } return; }
  state.loading = true; state.loadingSince = Date.now(); $("#refreshBtn").classList.add("busy"); $("#refreshBtn").disabled = true;
  syncDrafts();   // its own request and lock; nothing waits on it
  const netBefore = perf.net.calls, tRefresh = performance.now();
  // The watchdog below may only judge an interval this page was AWAKE for, or it convicts push of misses it never had:
  //  - the first poll of a session has no previous interval at all, and its sync legitimately pulls in everything that arrived
  //  while the app was closed, which would have fired "missed" on every single launch and disabled the backoff permanently;
  //  - and while the page is hidden the service worker still receives pushes and raises notifications, but `notePushDelivered`
  //  never runs because there is no page to message, so anything that arrived then looks undelivered on the next poll.
  const trustedBefore = pushLive(), threadsBefore = state.threads.size;
  const judgeable = !!state.lastPollStartedAt && !state.hiddenSincePoll;
  const pollStartedAt = state.lastPollStartedAt || 0;
  state.lastPollStartedAt = Date.now(); state.hiddenSincePoll = false;
  const syncStartedAt = Date.now();
  try {
    const want = (accounts ? accountsAll().filter((a) => accounts.includes(a.id)) : accountsAll()).filter((a) => !a.imap); // IMAP rows arrive through the hub
    // New mail goes on screen when ITS account has it, not when the slowest account is done. Every account used to be awaited
    // together and painted once at the end, so a Gmail message history had already delivered sat behind the other account and
    // behind the ten-minute reconcile pass, which is due on almost every reopen of the phone. One hold: Gmail paints wait for the
    // hub, because a Gmail copy of domain mail is hidden only once the hub row is known, and painting first would show the copy
    // and then swap it out. The hub answers in one round trip, so the hold costs next to nothing.
    let hubPending = want.some((a) => a.id === "hub"), held = false, painted = false;
    const paintEarly = () => {
      if (hubPending) { held = true; return; }
      held = false; dropStalePrerenders(); applyMuted(); render(); updateBadge();
      if (!painted) { painted = true; perf.record("refresh:first-paint", performance.now() - tRefresh); }
    };
    const hubDone = (changed) => { hubPending = false; if (changed || held) paintEarly(); };
    const results = await Promise.all(want.map(async (a) => {
      // A hub sync that did not run here ("running"/"busy": another sync or window holds it) has not answered, so the hold stands
      // until the final render. Only a hub that actually answered (or failed outright, where waiting cannot help) releases it.
      try { const r = await syncAccount(a, { onApplied: paintEarly }); if (a.id === "hub" && typeof r === "number") hubDone(r > 0); return { a, r }; }
      catch (e) { if (a.id === "hub") hubDone(false); if (!silent) toast(`${a.label}: ${e.message}`); return { a, r: null }; }
    }));
    for (const { a, r } of results) if (r && r.owed > 0) scheduleCatchup(a.id);
    if (!state.prefs.sendersBootstrapped && results.some((x) => x.r)) { try { await api("/api/senders/bootstrap", { method: "POST" }); const seen = [...new Set([...state.threads.values()].filter((t) => t.state === "inbox" && !t.out).map((t) => t.fromAddr).filter(Boolean))]; if (seen.length) await api("/api/senders", { method: "POST", body: JSON.stringify({ addresses: seen, status: "accepted" }) }); await setPref("sendersBootstrapped", true); } catch (_) {} } // first run: everyone already writing to you is accepted; screening starts now
    // Every account answered this time (none failed, none skipped because another sync held it): the store now knows at least
    // what the servers knew when this refresh began. sweepNotifications closes nothing raised after that.
    if (results.every((x) => x.r !== null && x.r !== "running" && x.r !== "busy")) state.syncedAsOf = Math.max(state.syncedAsOf || 0, syncStartedAt);
    const pSync = performance.now(); perf.record("refresh:phase:sync", pSync - tRefresh);
    // If this poll found mail while push was supposedly live, and no push reached this page since the poll before it, then push
    // had its chance and missed. That is the only honest signal available here: absence of push proves nothing on its own,
    // because there may simply have been no mail.
    if (judgeable && trustedBefore && state.threads.size > threadsBefore && !(state.lastPushAt > pollStartedAt)) notePushMissed("a poll found mail it had not delivered");
    dropStalePrerenders();
    searchIndex.indexThreads([...state.threads.values()].filter((t) => !searchIndex.lastIndexedAt || (t.updatedAt || 0) >= searchIndex.lastIndexedAt)); searchIndex.lastIndexedAt = Date.now();
    const pIndex = performance.now(); perf.record("refresh:phase:prerender+index", pIndex - pSync);
    applyMuted();
    const pMuted = performance.now(); perf.record("refresh:phase:muted", pMuted - pIndex);
    // Split three ways, plus the frame that follows: on my Mac this phase reads a steady 300-340 ms while render() alone
    // costs ~20 ms in a system-WebKit harness with the same 4,485 conversations and 92 sender rules. These say where it goes.
    const r0 = performance.now(); render(); const r1 = performance.now(); updateBadge(); const r2 = performance.now(); checkVersion(); const r3 = performance.now();
    perf.record("refresh:render:list", r1 - r0); perf.record("refresh:render:badge", r2 - r1); perf.record("refresh:render:version", r3 - r2);
    requestAnimationFrame(() => perf.record("refresh:render:to-frame", performance.now() - r0));   // style, layout and paint included
    const pRender = performance.now(); perf.record("refresh:phase:render", pRender - pMuted);
    // snapshot.write() used to run HERE, on every refresh: every 60 s while visible and on every push. It reduces over every
    // thread for a revision, synchronously READS AND PARSES the existing snapshot back out of localStorage, then filters and
    // SORTS all of them (1,502 on my phone) to keep the newest 150, stringifies and writes. All on the main thread,
    // all to maintain a cache whose only reader is the NEXT cold boot. Nothing about that needs to happen sixty times an hour.
    // It is now dirty-flagged and flushed on idle,
    // and forced out on the two events that actually precede a boot: the page being hidden, and pagehide.
    markSnapshotDirty();
    followOpenThread().catch(() => {});   // an open conversation whose row just learned of a newer message shows it
    scheduleIdle(mirrorHubCopies);   // hidden Gmail copies of domain mail follow their hub conversation (off the paint path)
    scheduleIdle(() => syncImgDims());   // sizes for the pictures the hub kept since the last one
    scheduleIdle(() => syncTrackers());   // pictures the hub blocked beyond the named list since the last one
    perf.record("refresh:total", performance.now() - tRefresh); perf.lastRefreshCalls = perf.net.calls - netBefore;
  } finally { state.loading = false; refresh.flagged = false; $("#refreshBtn").classList.remove("busy"); $("#refreshBtn").disabled = false; }
}
// The rows shown before the index answers, and wherever its worker is unavailable: every term of the query in one of the
// row's fields, a "quoted phrase" one term kept whole and in order, as the index (search.worker.js buildMatch) and the hub read it.
// `neg`: the -word exclusions instead, which the scan honours too, so "-word in:trash" lists Trash without the word.
const searchTerms = (q, { neg = false } = {}) => { const out = []; for (const m of String(q || "").matchAll(/(?:[a-z]+:)?"([^"]*)"|(\S+)/gi)) { let t = (m[1] ?? m[2]).trim(); if (m[2]) { const isNeg = t.startsWith("-") && t.length > 1; if (isNeg !== neg || /^-?account:/i.test(t)) continue; if (isNeg) t = t.slice(1); t = t.replace(/^(from|to|subject|body):/i, "").replace(/^"|"$/g, ""); } else if (neg) continue; if (t.trim()) out.push(t.trim().toLowerCase()); } return out; };
// The query's words against the row's fields; a query of operators alone (in:trash) makes every row a candidate for searchPasses.
const matchesSearch = (t, q) => { const s = typeof q === "string" ? parseSearch(q) : q; const hay = [t.subject, t.fromName, t.fromAddr, t.snippet, t.to].map((x) => String(x || "").toLowerCase()); const terms = searchTerms(s.text), not = searchTerms(s.text, { neg: true }); if (!terms.length && !not.length && !s.ops) return false; return terms.every((w) => hay.some((h) => h.includes(w))) && !not.some((w) => hay.some((h) => h.includes(w))); };
// One parse per query, not per row: rowHtml asks for every row drawn (trashLens). Its "now" is the moment the search was typed.
const searchOf = (q) => (searchOf.q === q ? searchOf.s : ((searchOf.q = q), (searchOf.s = parseSearch(q))));
// The operators on a row (parseSearch). With no in:, Trash and Spam are left out, as Gmail's search leaves them out. The
// folder, read and pin state are this device's, which carry its own actions before any server has them; a row a server found already
// matched the dates and the attachment message by message (Gmail's, the hub's), so it is not re-tested on those against the row's newest
// message alone.
function searchPasses(t, s, hit) {
  const st = t.state, binned = t.kind === "gmail" && !!t.binnedIds?.length;   // a live Gmail conversation with a message in Trash
  const IN = { inbox: st === "inbox", archived: st === "archived", trash: st === "trash" || binned, spam: st === "spam", snoozed: st === "snoozed", sent: !!(t.out || t.hasOut || (t.labels || []).includes("SENT")), anywhere: true };
  if ((st === "trash" || st === "spam") && !s.in.some((v) => v === "trash" || v === "spam" || v === "anywhere")) return false;
  if (!s.in.every((v) => IN[v]) || s.notIn.some((v) => (v === "trash" ? st === "trash" : IN[v]))) return false;
  if (s.want.some((w) => (w === "unread" && !t.unread) || (w === "read" && t.unread) || (w === "starred" && !t.starred) || (w === "unstarred" && t.starred))) return false;
  if (hit) return true;
  if ((s.want.includes("att") && !t.hasAtt) || (s.want.includes("noatt") && t.hasAtt)) return false;
  return !(s.after != null && (t.date || 0) < s.after) && !(s.before != null && (t.date || 0) >= s.before);
}
function visibleThreads() {
  if (state.view.kind === "drafts" && !state.search) return [];   // no conversation under Drafts for j/k, e or # to land on unseen
  const v = state.view; const box = viewBox(); const p = prefs(); const q = state.search; const vt0 = performance.now();
  let rows = [...state.threads.values()], leftOut = [];
  // A search is Gmail's: all the account's mail, narrowed by its operators and by the account picked, never by the tab, folder or list
  // it was typed in. It used to drop Trash and Spam whatever was asked, list only the open category tab's mail, show
  // Set aside, Reply later or Feed whole with the query ignored, and never find a set-aside conversation. (One typed in Trash or Spam
  // carries that folder's in: in the query itself, typedQuery.)
  if (q) {
    const s = searchOf(q), sh = state.serverHitKeys || new Set();
    if (state.searchHits) { const hits = state.searchHits; rows = rows.filter((t) => hits.has(t.key) || sh.has(t.key)); rows.forEach((t) => { t._hit = hits.get(t.key); }); }
    else rows = rows.filter((t) => matchesSearch(t, s) || sh.has(t.key));
    for (const [k, t] of state.serverSearch) if (!state.threads.has(k)) rows.push(t);
    // what a search of all mail leaves out (this device's Trash and Spam matches) for the footer's way to them, as Gmail's
    if (!s.in.length && !s.notIn.length) { const anywhere = { ...s, in: ["anywhere"] }; leftOut = rows.filter((t) => (t.state === "trash" || t.state === "spam") && searchPasses(t, anywhere, sh.has(t.key))); }
    rows = rows.filter((t) => searchPasses(t, s, sh.has(t.key)));
  } else {
    if (box === "inbox") rows = rows.filter((t) => t.state === "inbox");
    else if (box === "archived") rows = rows.filter((t) => t.state === "archived" && !(t.labels || []).includes("SENT") && !t.sentOnly && !(t.labels || []).includes("locked-out"));   // sent-only: Sent, not Archive; kept out by an address lock: Held, not Archive
    else if (box === "spam") rows = rows.filter((t) => t.state === "spam");
    else if (box === "trash") rows = rows.filter((t) => t.state === "trash" || (t.kind === "gmail" && t.binnedIds?.length));   // and a live Gmail conversation with a message in Trash, as Gmail's Trash lists it (trashedIds)
    else if (box === "snoozed") rows = rows.filter((t) => t.state === "snoozed");
    else if (box === "starred") rows = rows.filter((t) => t.starred && t.state !== "trash" && t.state !== "spam");
    else if (box === "unread") { rows = rows.filter((t) => state.keep.has(t.key) ? t.state !== "trash" && t.state !== "spam" && !isHubCopy(t) : unreadListed(t)); if (v.cat) rows = rows.filter((t) => catOf(t) === v.cat); }
    else if (box === "sent") rows = rows.filter((t) => (t.out || t.hasOut || (t.labels || []).includes("SENT")) && t.state !== "trash" && t.state !== "spam");   // any message sent, as Gmail's Sent
    else if (box === "held") rows = rows.filter((t) => t.kind === "hub" && (t.labels || []).some((x) => ["trademark-scam", "blocked", "locked-out"].includes(x)));
    else if (box === "all") rows = rows.filter((t) => t.state !== "trash" && t.state !== "spam");
    if (v.kind === "held") rows = rows.filter((t) => t.kind === "hub");
    if (v.kind === "aside") rows = [...state.threads.values()].filter((t) => p.setAside.includes(t.key));
    if (v.kind === "replylater") rows = [...state.threads.values()].filter((t) => p.replyLater.includes(t.key));
    if (v.kind === "feed") rows = [...state.threads.values()].filter((t) => catOf(t) === "newsletters" && t.state === "inbox");
  }
  // after the three lists above, which start over from every conversation: before them, one account's Set aside showed every account's
  if (v.account) { rows = rows.filter((t) => inAccount(t, v.account)); leftOut = leftOut.filter((t) => inAccount(t, v.account)); }
  if (v.dom && !q) rows = rows.filter((t) => domainOf(t.identity) === v.dom);   // one domain's chip in the business inbox
  if (!q && CATS[v.kind]) rows = rows.filter((t) => catOf(t) === v.kind);
  if (!p.showDupes) { rows = rows.filter((t) => !isHubCopy(t)); leftOut = leftOut.filter((t) => !isHubCopy(t)); }
  visibleThreads.leftOut = { trash: leftOut.some((t) => t.state === "trash"), spam: leftOut.some((t) => t.state === "spam") };
  if (!q && !["aside", "replylater", "feed"].includes(v.kind)) rows = rows.filter((t) => !p.setAside.includes(t.key));
  // Search results are newest first, like every other list. They used to be ranked by bm25 relevance with the server's hits
  // (no local score) appended after, so the order changed as each source answered and older mail sat above newer (
  // results were not in date order).
  // Field timers: this function reads ~290 ms per refresh on my Mac against 46 ms for the same 4,485 conversations
  // in a system-WebKit harness. Filtering vs sorting, how many comparisons, and how many conversations are in memory say which.
  const vt1 = performance.now(); let cmps = 0;
  if (q) rows.sort((a, b) => b.date - a.date);
  // Priority is worked out once per row, not on both sides of every comparison (isPriority() per comparison was the 285 ms above).
  else { const pinned = new Set(p.priorityThreads || []); const pri = new Map(); for (const t of rows) pri.set(t, senderRule(t.fromAddr, t.account)?.action === "priority" || pinned.has(t.key) ? 1 : 0); rows.sort((a, b) => (cmps++, (pri.get(b) - pri.get(a)) || (b.date - a.date))); }
  const vt2 = performance.now();
  if (vt2 - vt0 > 20) { perf.record("sort:filter", vt1 - vt0); perf.record("sort:compare", vt2 - vt1); perf.record("sort:count:comparisons", cmps); perf.record("sort:count:rows", rows.length); perf.record("sort:count:in-memory", state.threads.size); }
  return rows;
}
const isHubCopy = (t) => t.kind === "gmail" && (t.msgIds || [t.msgIdHdr]).filter(Boolean).length > 0 && (t.msgIds || [t.msgIdHdr]).filter(Boolean).every((id) => state.hubMsgIds.has(id));
// What Unread lists and counts: unread in an inbox, however old (every one loads: fillUnread, the hub's mirror), and
// unread anywhere else from the last SYNC.windowDays days, the window every device and the hub hold in full. Older mail outside the
// inbox is on a device only because of what it once loaded, so it used to depend on the device: on 2026-11-16 the Mac's Unread held
// 189 sxsw promos archived unread in 2014, which one scroll had loaded.
const unreadListed = (t) => !!t.unread && t.state !== "trash" && t.state !== "spam" && !isHubCopy(t) && (t.state === "inbox" || (t.date || 0) >= Date.now() - SYNC.windowDays * 864e5);
// The Gmail copy of domain mail follows what was done to the hub's own copy (trashing domain mail should trash its
// Gmail copy too, so one delete removes every copy). The copy is hidden here (isHubCopy), so trashing or finishing the hub
// conversation left it in Gmail's inbox, unread. This compares STATE rather than replaying actions: after each refresh every hidden
// copy is held against its hub conversation and only the difference goes to Gmail, so a failed call heals on a later pass, and an
// action taken from a notification, the CLI or another device is covered, as is everything handled before this existed. It only
// ever moves a copy OUT (into Trash, out of the inbox, read); a hub conversation back in the inbox leaves its copy where it is, so
// nothing here can refill Gmail. A hub conversation with an action still queued waits until the hub has taken it.
const MIRROR_MAX = 40;          // Gmail calls per pass (messages.modify, 5 quota units each); the rest go on the next refresh
const copyMirrored = new Map(); // Gmail message key -> the change already sent this session (the next delta records it)
async function mirrorHubCopies() {
  if (mirrorHubCopies.busy || !navigator.onLine || !state.hubMsgThread.size) return; mirrorHubCopies.busy = true;
  const t0 = performance.now(); let calls = 0, failed = false;
  try {
    const pending = pendingKeysNow();
    const hubOf = (id) => { const k = id && state.hubMsgThread.get(id); const h = k && state.threads.get(k); return h && !pending.has(h.key) ? h : null; };
    for (const t of [...state.threads.values()]) {
      if (calls >= MIRROR_MAX || failed) break;
      if (t.kind !== "gmail" || t.state === "trash" || pending.has(t.key) || !isHubCopy(t)) continue;
      const hubs = (t.msgIds || []).map(hubOf).filter(Boolean);
      if (!hubs.some((h) => h.state === "trash" || (h.state !== "inbox" && t.state === "inbox") || (!h.unread && t.unread))) continue;
      const msgs = await idb.getByIndex("messages", "threadKey", t.key); let touched = false;
      for (const m of msgs) {
        if (calls >= MIRROR_MAX) break;
        const h = hubOf(m.msgIdHdr); if (!h) continue;
        const l = new Set(m.labels || []), add = [], remove = [];
        if (h.state === "trash" && !l.has("TRASH")) add.push("TRASH");
        if (h.state !== "inbox" && l.has("INBOX")) remove.push("INBOX");
        if (!h.unread && l.has("UNREAD")) remove.push("UNREAD");
        const sig = add.join() + "/" + remove.join(); if (sig === "/" || copyMirrored.get(m.key) === sig) continue;
        await cooldownWait(t.account); calls++;
        try { await gapi(t.account, `messages/${m.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) }); }
        catch (e) { if (e?.status === 404) continue; failed = true; perf.record("mirror:copies:failed", 0); break; } // gone is fine; anything else waits for the next pass
        copyMirrored.set(m.key, sig); add.forEach((x) => l.add(x)); remove.forEach((x) => l.delete(x)); m.labels = [...l]; touched = true;
      }
      if (touched) { await idb.putAll("messages", msgs); await rebuildGmailThreads(t.account, [t.key]); }
    }
  } catch (_) {} finally { mirrorHubCopies.busy = false; if (calls) { perf.record("mirror:copies", performance.now() - t0); perf.record("mirror:copies:calls", calls); updateBadge(); } }
}
// Unread in the inbox, by sidebar entry: the Domains entry counts only the domains without a row of their own.
function counts() { const c = { inbox: 0, personal: 0, notifications: 0, newsletters: 0, unread: 0, acct: {} }; for (const t of state.threads.values()) { if (unreadListed(t)) c.unread++; if (t.state !== "inbox" || !t.unread) continue; if (isHubCopy(t)) continue; c.inbox++; c[catOf(t)] = (c[catOf(t)] || 0) + 1; const k = sideIdOf(t); c.acct[k] = (c.acct[k] || 0) + 1; } return c; }
// ---------- notifications: a conversation you have handled must not stay in the Android shade (Spark's behaviour) ----------
// Three layers, in falling order of cost. (a) This device, instantly and offline: close the notification whose tag is this thread.
// (b) This device while the app was closed: the service worker re-checks IndexedDB when the next push arrives and sweeps what is
// already handled. (c) Other devices: handled keys are reported to the hub in one debounced request per burst (never per action) and
// ride along on the next push the hub was already sending, so there is no extra push and no per-action Worker call.
const notifTag = (key) => "t-" + key;
// Links from an installed Android app open in an in-app Chrome tab. An Android intent: URL aimed at Chrome asks for the real browser
// instead; `S.browser_fallback_url` makes any device that cannot honour it load the plain URL, so the worst case is today's behaviour.
// Off on every other platform and when the app runs in a browser tab (there the normal target is already a real tab).
const androidApp = () => /Android/i.test(navigator.userAgent) && ["standalone", "fullscreen", "minimal-ui"].some((m) => matchMedia(`(display-mode: ${m})`).matches);
function chromeIntent(url) { // null when the URL cannot be expressed as an intent
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null;
    return `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=${u.protocol.slice(0, -1)};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  } catch (_) { return null; }
}
// Link warming was tried here on 2026-09-18 and REVERTED the same day, unanimously rejected.
// Three reasons, and the first two are enough on their own:
//  - it leaked. A preconnect is DNS + TCP + TLS from my real IP to whatever a message links to, including every
//  tracker domain in a newsletter, before any click. `mouseover` leaked on a hover the user never intended as a click. That is
//  exactly what proxyImages() exists to stop, and it fails this project's own "cannot leak information" bar outright.
//  - the benefit was never demonstrated. The receipt proved <link> elements were inserted, not that any tap got faster, and
//  The preconnect carried crossOrigin="anonymous", which a top-level navigation likely cannot reuse, so it
//  plausibly delivered all of the leak and none of the speed.
//  - the premise (that the PWA and the Chrome tab share a connection pool) was an inference about browser internals, unmeasured.
// If this is revisited, it needs a measurement of tap-to-first-byte in the opened tab, not a count of link elements.
function openExternal(url) {
  const raw = String(url || "").trim(); if (!/^https?:\/\//i.test(raw)) return null;
  if (nativeBridge) { nativeBridge.call("openExternal", { url: raw }).catch(() => {}); return true; }
  // One open, never two. `window.open(…, "noopener")` returns null by spec whether or not it succeeded, so it could never tell a
  // refused intent from an honoured one: the old `!== null` test always failed and opened the plain URL on top of the intent
  // Chrome had already taken: one tap, two tabs. The intent carries its own S.browser_fallback_url, so a device that cannot
  // honour it loads the plain URL itself; there is nothing left for this side to retry.
  const t0 = performance.now();
  const target = (prefs().openInChrome !== false && androidApp() && chromeIntent(raw)) || raw;
  window.open(target, "_blank", "noopener");
  perf.record("open-link", performance.now() - t0);   // this side's share of the tap; the rest is Chrome
  return target;
}
async function dismissNotifications(keys) {
  if (nativeBridge) { try { await nativeBridge.call("dismiss", { keys }); } catch (_) {} return; }
  const want = new Set(keys.map(notifTag)); if (!want.size) return;
  try { const reg = await navigator.serviceWorker?.ready; if (!reg?.getNotifications) return; for (const n of await reg.getNotifications()) if (want.has(n.tag)) n.close(); } catch (_) {}
}
// `since`: when the oldest key in the batch was handled. The report says how long ago that was, so the hub dates the handling to the
// action and not to the report's arrival after the debounce: a reply pushed in between keeps its notification.
//  The oldest, because an earlier date closes less: the safe side of a batch.
const handledReport = { keys: new Set(), timer: null, since: 0 };
function queueHandled(keys) {
  if (!handledReport.keys.size) handledReport.since = Date.now();
  for (const k of keys) handledReport.keys.add(k);
  clearTimeout(handledReport.timer); handledReport.timer = setTimeout(flushHandled, 4000);
}
function noteHandled(keys) { // (a) now, (c) reported in one batch
  const list = [...new Set(keys)].filter(Boolean); if (!list.length) return;
  dismissNotifications(list);
  warmEndpoint();                                   // resolved during the 4 s debounce, never on the request's critical path
  queueHandled(list);
}
// The report now carries THIS device's push endpoint. The hub uses it to leave this device out of the dismissal it fires off
// immediately afterwards: the notifications here are already closed (that happened in noteHandled, offline, before the request
// was even made), and waking a device to close nothing is the one case that ends with an empty shade and costs push budget.
// This device's push endpoint, CACHED. The report carries it so the hub can leave this device out of the dismissal it fires
// off immediately afterwards: the notifications here are already closed (noteHandled did that offline, before any request),
// and waking a device to close nothing is the one case that ends with an empty shade and costs push budget.
// It is cached rather than looked up per report because the lookup awaits `serviceWorker.ready`, a promise that can simply
// never settle, and because a second of latency here is a second added to the dismissal. Absent, the hub merely cannot
// exclude this device: one wasted push, self-correcting on the next boot. It must never delay or block the report itself.
// What this build's service worker can be trusted with. `dismiss2` means it carries the never-empty-shade rule, so the hub may
// send it a push that shows nothing (migration 0024). A device that has not re-registered since this build went out does not
// claim it, and keeps the old piggyback behaviour until it does.
const PUSH_CAPS = ["dismiss2"];
let pushEndpoint = null;
const noteEndpoint = (sub) => { pushEndpoint = sub?.endpoint || null; };
const warmEndpoint = () => { if (pushEndpoint) return; (async () => { try {
  const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
  noteEndpoint(await reg?.pushManager?.getSubscription());
} catch (_) {} })(); };
async function flushHandled() {
  const all = [...handledReport.keys]; if (!all.length || !navigator.onLine) return;
  // At most 200 per report (the hub's cap); the rest stay queued for the next one instead of being dropped with the batch.
  const keys = all.slice(0, 200), since = handledReport.since || Date.now();
  for (const k of keys) handledReport.keys.delete(k);
  if (handledReport.keys.size) { clearTimeout(handledReport.timer); handledReport.timer = setTimeout(flushHandled, 1000); }
  // In the Android app, the report names the phone (`fcm:<id>`), so the hub does not wake it to close what it closed itself.
  const device = await nativeDevice();
  try { await api("/api/notify/handled", { method: "POST", body: JSON.stringify({ keys, age: Date.now() - since, endpoint: pushEndpoint, ...(device ? { device } : {}) }) }); }
  catch (_) { for (const k of keys) handledReport.keys.add(k); handledReport.since = Math.min(handledReport.since || since, since); }
}
// Sweep: every notification whose conversation is no longer unread-in-inbox here is closed (app opened, or another window acted).
// Only a notification OLDER than what this page knows: one raised after the last completed sync may be for a reply the page has not
// seen yet, and the page's "read" would close it, and report it handled to every other device.
//  `syncedAsOf` is when the last complete refresh started; notification times and it are both this device's clock.
async function sweepNotifications() {
  const before = Math.max(1, state.syncedAsOf || 0);
  if (nativeBridge) {   // the Android app's shade: close what this store already knows is handled, and report it like below
    try { const live = (await nativeBridge.call("activeKeys")) || []; const gone = live.filter((k) => { const t = state.threads.get(k); return t && !(t.state === "inbox" && t.unread); });
      // The app closes only those posted before `before`, and answers with the keys it closed (an older app answers true).
      if (gone.length) { const r = await nativeBridge.call("dismiss", { keys: gone, before }); const done = Array.isArray(r) ? r : gone; if (done.length) queueHandled(done); } } catch (_) {}
    return;
  }
  try { const reg = await navigator.serviceWorker?.ready; if (!reg?.getNotifications) return;
    // The "All caught up" placeholder exists only to keep a push handler from finishing with an empty shade. With the app open
    // in front of the user it has no job at all, so it goes first, every time.
    const gone = []; for (const n of await reg.getNotifications()) { if (n.tag === "s-zero") { n.close(); continue; } if (!n.tag.startsWith("t-")) continue; if (n.timestamp && n.timestamp >= before) continue; const t = state.threads.get(n.tag.slice(2)); if (t && !(t.state === "inbox" && t.unread)) { n.close(); gone.push(n.tag.slice(2)); } }
    if (gone.length) queueHandled(gone);
  } catch (_) {}
}
function updateBadge() { try { const n = counts().inbox; if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (_) {} }
// ---------- updates apply themselves ----------
// A new build used to be a six-second toast; with many deploys a day the windows ran old code for hours (The cross-window
// fix was live but neither window had it). Now: a new version installs the new service worker at once (its shell cache is filled during
// install, so one reload is enough), and the page reloads as soon as that worker controls it AND nothing would be lost, not while a
// reply or draft has text, a card is open, a finger is on a row or an action is still queued. Hidden windows reload immediately; a busy
// window shows a bar and reloads the moment it is hidden or goes idle.
const update = { version: null, ready: false, armed: false, reloading: false, reload: null };
async function checkVersion() {
  try {
    // /api/bootstrap already returned the build version on this boot, so the first check spends that instead of making the call
    // again. It is consumed once: every later check goes to the network, which is the whole point of a version check.
    let v;
    if (checkVersion.seed) { v = { version: checkVersion.seed }; checkVersion.seed = null; }
    else v = await api("/api/version");
    if (!v.version || v.version === VERSION) return;
    if (update.version !== v.version) { update.version = v.version; update.ready = !navigator.serviceWorker; try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) { await reg.update(); if (reg.waiting) reg.waiting.postMessage("skipWaiting"); } else update.ready = true; } catch (_) {} setTimeout(async () => { if (update.ready) return; try { await fetch("/", { cache: "reload" }); await new Promise((r) => setTimeout(r, 1500)); } catch (_) {} update.ready = true; if (updateSafe()) applyUpdate(); }, 90_000); } // fallback when no controller change arrives: refresh the cached shell over the network first
    applyUpdate();
  } catch (_) {}
}
// A new worker taking control does not entitle it to reload over unsaved work either: mark it ready and let the same gate decide.
navigator.serviceWorker?.addEventListener?.("controllerchange", () => { update.ready = true; if (updateSafe()) applyUpdate(); });
// My Mac app sat on an old build all day while fifteen versions shipped past it, and this line is why: `!queue.pending()
// length` meant ONE undrainable action blocked every future update for ever. An action against the work mailbox throws and
// retries when that mailbox is unreachable: the sidebar has been showing "Work co, not connected", so the queue was never
// empty, the update was never "safe", and the app quietly stopped updating. That is the opposite of "it just works".
// The queue is DURABLE: it lives in IndexedDB and is drained on load, so a reload does not lose queued work; it resumes it. The
// guard was over-cautious to begin with. What genuinely must not be interrupted is unsaved typing, an open card, a finger on a
// row, or a drain actually in flight RIGHT NOW. A pending action that cannot drain is not a reason to run stale for ever, so the
// queue's veto expires: after UPDATE_MAX_HOLD the update goes in regardless, and typing still holds it as long as it lasts.
const UPDATE_MAX_HOLD = 10 * 60_000;
const updateSafe = () => {
  if ($("#tmodal")?.classList.contains("on")) return false;                      // a card is open
  if (($("#rtext")?.value || "").trim()) return false;                           // an unsent reply
  if (($("#rfiles")?.files?.length || 0) || ($("#cmodal")?.classList.contains("on") && ($("#cfiles")?.files?.length || 0))) return false;   // files attached to a draft
  // Any half-written message, not just its body: a subject and a recipient typed into an open composer are work a reload destroys
  // just as surely.
  if ($("#cmodal")?.classList.contains("on") && ["#ctext", "#csub", "#cto", "#ccc", "#cbcc"].some((k) => ($(k)?.value || "").trim())) return false;
  if (activeGestures.size || state.selecting) return false;                      // a finger on a row, or a selection in progress
  if (queue.draining) return false;                                              // a drain is in flight this instant
  // The hold is per EPISODE, not per session. Leaving heldSince set meant a later stuck queue inherited an already-expired budget
  // and reloaded instantly with no hold at all, and a mailbox that fails intermittently would have produced a reload roughly every
  // ten minutes for ever.
  if (!queue.pending().length) { update.heldSince = 0; return true; }
  if (!update.heldSince) update.heldSince = Date.now();
  return Date.now() - update.heldSince > UPDATE_MAX_HOLD;                        // stuck work may delay an update, never cancel it
};
function applyUpdate() {
  if (!update.version || update.reloading) return;
  // never loop: if two reloads did not land on the new version, leave the bar and stop reloading on our own
  let tries = 0; try { const [v, n] = (sessionStorage.getItem("mh:upd") || "").split(":"); if (v === update.version) tries = +n || 0; } catch (_) {}
  const go = () => { if (tries >= 2 && !update.manual) return; update.reloading = true; try { sessionStorage.setItem("mh:upd", `${update.version}:${tries + 1}`); } catch (_) {} toast("Updating…", 1500); setTimeout(() => (update.reload ? update.reload() : location.reload()), 250); };
  if (update.ready && updateSafe()) return go(); // hidden or not: never over typed text, an open card, a gesture or queued actions
  if (!update.armed) {
    update.armed = true;
    const bar = document.createElement("div"); bar.id = "upd"; bar.style.cssText = "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:60;background:var(--acc);color:#fff;padding:8px 14px;border-radius:999px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer"; bar.textContent = "New version ready — tap to update"; bar.onclick = () => { update.ready = true; update.manual = true; go(); }; document.body.appendChild(bar);
    document.addEventListener("visibilitychange", () => { if (document.hidden) applyUpdate(); });
    update.timer = setInterval(() => { if (update.ready && updateSafe()) { clearInterval(update.timer); go(); } }, 5000); // idle check: the reply box emptied, the card closed, the queue drained
  }
}

// ---------- render: sidebar ----------
// The places visited every day, then More. The Smart inbox rows were the chips above every inbox list, which carry
// their counts now; Feed is the Newsletters chip's Cards switch. More holds the rest, open or closed as this device left it, and while
// it is closed over one of its folders, More itself is lit. ⌘K's "Go to" reaches every one of them.
const NAV_MAIN = [["starred", "Pins", "pin"], ["sent", "Sent", "sent"], ["drafts", "Drafts", "compose"], ["archived", "Archive", "done"]];
const NAV_MORE = [["trash", "Trash", "trash"], ["spam", "Spam", "spam"], ["all", "All mail", "all"], ["snoozed", "Snoozed", "snoozed"], ["replylater", "Reply later", "replylater"], ["aside", "Set aside", "aside"], ["held", "Held", "held"]];
// An account's badge is the list's pale tile in the account's colour; the hub's domains are businesses, so rounded squares.
const navDot = (a) => `<span class="dot${a.kind === "hub" && !a.imap ? " biz" : ""}" style="--c:${esc(a.color)}">${esc(a.label[0].toUpperCase())}</span>`;
function renderNav() {
  const c = counts(); const v = state.view; const on = (k, a = null) => v.kind === k && (v.account || null) === a ? " on" : "";
  const acct = sideAccounts();
  let h = `<a class="${on("inbox").trim()}" data-view="inbox">${ico("inbox")}Inbox<span class="n">${c.inbox || ""}</span></a>`;
  for (const a of acct) h += `<a class="${on("inbox", a.id).trim()}" data-view="inbox" data-account="${esc(a.id)}" style="padding-left:18px" title="${a.imap && !a.ready ? "Waiting for the mailbox password (WORK_IMAP_PASSWORD)" : a.imap && a.refused ? "The mail server is refusing the password. The hub tries again on its own; change the password in Settings if it was changed." : ""}">${navDot(a)}${esc(a.label)}${a.imap && !a.ready ? ' <span class="badge">not connected</span>' : a.imap && a.refused ? ' <span class="badge" style="border-color:var(--danger);color:var(--danger)">password refused</span>' : ""}${syncState.progress[a.id]?.behind ? ' <span class="badge" title="This device was away and is catching up with Gmail">updating</span>' : ""}<span class="n">${c.acct[a.id] || ""}</span></a>`;
  // A folder row, and when it splits by account its arrow and, open, a row per account under it. Closed over one account's list, the
  // folder's own row stays lit so the place is still marked.
  const folder = (k, l, ic, n = "") => {
    const subs = folderAccounts(k), open = subs.length > 1 && navOpen().has(k);
    let r = `<a class="${v.kind === k && (!v.account || !open) ? "on" : ""}" data-view="${k}">${ico(ic)}${l}${n}${subs.length > 1 ? `<span class="exp${open ? " open" : ""}" data-exp="${k}" role="button" aria-expanded="${open}" aria-label="${l} for each account" title="${l} for each account">${ico("chevron")}</span>` : ""}</a>`;
    if (open) for (const a of subs) r += `<a class="${on(k, a.id).trim()}" data-view="${k}" data-account="${esc(a.id)}" style="padding-left:18px">${navDot(a)}${esc(a.label)}</a>`;
    return r;
  };
  h += folder("unread", "Unread", "unread", `<span class="n">${c.unread || ""}</span>`);
  for (const [k, l, ic] of NAV_MAIN) h += k === "drafts" ? `<a class="${v.kind === "drafts" ? "on" : ""}" data-view="drafts">${ico(ic)}${l}<span class="n">${draftLive().length || ""}</span></a>` : folder(k, l, ic);
  const moreOpen = navOpen().has("more"), inMore = !!v.split || v.kind === "scheduled" || NAV_MORE.some(([k]) => k === v.kind);
  h += `<a class="more${inMore && !moreOpen ? " on" : ""}" data-more="1" role="button" aria-expanded="${moreOpen}">${ico("more")}More<span class="exp${moreOpen ? " open" : ""}" data-exp="more" aria-hidden="true">${ico("chevron")}</span></a>`;
  if (moreOpen) {
    for (const [k, l, ic] of NAV_MORE) h += folder(k, l, ic);
    h += `<a class="${v.kind === "scheduled" ? "on" : ""}" data-view="scheduled">${ico("scheduled")}Snoozes & reminders<span class="n">${state.schedules.length || ""}</span></a>`;
    for (const sp of prefs().splits) h += `<a data-split="${esc(sp.name)}" class="${v.split === sp.name ? "on" : ""}">${ico("filter")}${esc(sp.name)}</a>`;
  }
  $("#nav").innerHTML = h;
  $$("#nav a").forEach((a) => a.onclick = () => { if (a.dataset.more) { setNavOpen("more", !navOpen().has("more")); return renderNav(); } if (a.dataset.split) return runSplit(prefs().splits.find((s) => s.name === a.dataset.split)); setView(a.dataset.view, a.dataset.account || null); });
  $$("#nav [data-exp]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); setNavOpen(b.dataset.exp, !navOpen().has(b.dataset.exp)); renderNav(); });
}
// Unread and every folder list each account under them, as Inbox does: an arrow on the row opens the list, and a tap on an account
// shows that folder for it alone (Spark's desktop sidebar does the same for any folder). An account
// is listed only where its mail can be: Spam is Gmail's alone (the hub has no spam folder of its own), Held the hub's alone (its
// address locks and blocks). Which folders are open is this device's choice, kept in local storage; going to one account's folder
// opens it. The smart inbox's categories need no list: an account's inbox carries them as chips.
const SPLIT_FOLDERS = new Set(["unread", "starred", "replylater", "aside", "feed", "snoozed", "sent", "archived", "held", "spam", "trash", "all"]);
function folderAccounts(k) {
  if (!SPLIT_FOLDERS.has(k)) return [];
  const acct = sideAccounts(); return k === "spam" ? acct.filter((a) => a.kind === "gmail") : k === "held" ? acct.filter((a) => a.kind === "hub") : acct;
}
function navOpen() { try { return new Set(JSON.parse(localStorage.getItem("mh_nav_open") || "[]")); } catch (_) { return new Set(); } }
function setNavOpen(k, open) { const s = navOpen(); if (open) s.add(k); else s.delete(k); try { localStorage.setItem("mh_nav_open", JSON.stringify([...s])); } catch (_) {} }
// dom: one domain of the Domains entry, picked by its chip above the business inbox; kept across the category chips.
function setView(kind, account = null, dom = null) {
  perf.measure("switch-view", () => {});
  state.view = { kind, account, cat: null, dom: account === "hub" && dom && !ownRowDomains().has(dom) ? dom : null }; state.cur = null; state.curThread = null; state.checked.clear(); state.selecting = false; state.keep = new Set(); state.focus = null;
  if (account && folderAccounts(kind).length > 1) { setNavOpen(kind, true); if (NAV_MORE.some(([k]) => k === kind)) setNavOpen("more", true); }   // the sidebar shows the account row it lit (⌘K gets here too)
  closeMenu(); dropLayer("thread");   // a folder tapped in the drawer used to remove the classes and strand both history entries: the next back did nothing
  $("#app").classList.remove("selecting", "viewing", "menu"); syncSearchPlaceholder();   // Drafts and Snoozes draw without render()
  if (kind === "scheduled") { renderNav(); return renderScheduled(); }
  if (kind === "drafts") { renderDrafts(); syncDrafts().then(() => { if (state.view.kind === "drafts") renderDrafts(); }); return; }
  render(); refresh({ silent: true });
}
// The phone's list header names the screen (The four-tab bar it replaces showed an "Inbox" tab instead).
const VIEW_TITLES = { inbox: "Inbox", unread: "Unread", starred: "Pins", replylater: "Reply later", aside: "Set aside", feed: "Feed", snoozed: "Snoozed", sent: "Sent", drafts: "Drafts", archived: "Archive", held: "Held", spam: "Spam", trash: "Trash", all: "All mail", scheduled: "Snoozes & reminders", ...CATS };
function phoneTitle() { const v = state.view || {}; if (state.search) return "Search"; if (v.account) { const a = sideOf(v.account); if (a) return folderAccounts(v.kind).length ? `${a.label} · ${VIEW_TITLES[v.kind]}` : v.dom ? `${a.label} · ${domLabel(v.dom)}` : a.label; } return VIEW_TITLES[v.kind] || (v.kind ? v.kind[0].toUpperCase() + v.kind.slice(1) : "Inbox"); }
// The phone layout (app.html's phone block keys on the same query): a narrow screen, or a touch screen held sideways. A phone turned
// sideways is about 400 px tall; the desktop layout there put the header, two rows of actions and the always-open reply box on top
// of the mail and left no room for it. No tablet is under 500 px tall; a short Mac window keeps the desktop layout.
const PHONE_MQ = "(max-width: 699px), (max-height: 499px) and (hover: none)";
const phoneUI = () => matchMedia(PHONE_MQ).matches;
function syncTabbar() { $("#app").classList.toggle("in-unread", inUnread()); const pt = $("#ptitle"); if (pt) { const t = phoneTitle(); if (pt.textContent !== t) pt.textContent = t; } syncSearchPlaceholder(); }
// The empty box says where a search typed now will look: "Search Trash" in Trash and Spam (typedQuery), "Search" everywhere else.
function syncSearchPlaceholder() { const f = SEARCH_FROM[viewBox()], ph = f ? `Search ${VIEW_TITLES[f]}` : "Search", q = $("#q"); if (q && q.placeholder !== ph) q.placeholder = ph; }
const SEARCH_SCOPES = [["", "All mail"], ["inbox", "Inbox"], ["archived", "Archive"], ["sent", "Sent"], ["snoozed", "Snoozed"], ["trash", "Trash"], ["spam", "Spam"], ["anywhere", "Everywhere"]];
// The query with its in: replaced by the one tapped ("" = none: all mail but Trash and Spam), run as though typed. A tap is a choice, so a
// search begun in Trash or Spam stops adding that folder (searchFrom null): All mail tapped there is all mail.
function searchScope(k) {
  const keep = [...String($("#q").value || state.search).matchAll(/(?:[a-z]+:)?"[^"]*"|\S+/gi)].map((m) => m[0]).filter((x) => { const o = /^-?in:(.+)$/i.exec(x); return !(o && SEARCH_IN[o[1].toLowerCase()]); });
  state.searchFrom = null; $("#q").value = [...keep, ...(k ? [SEARCH_GMAIL[k]] : [])].join(" "); $("#q").oninput();
}
// A search typed in Trash or Spam looks there (a search started in the Trash folder should start from
// it). All mail leaves those two out, as Gmail's does, so a search typed in Trash skipped the very folder on screen. The query gets
// the folder's in: (its chip lit, All mail one tap away) unless what was typed has an in: of its own. Which folder is decided when the
// search starts and kept until it is cleared or a chip is tapped (state.searchFrom: undefined = no search yet, null = all mail). The
// box keeps what was typed; state.search, which every path reads (the rows, the index, the hub, Gmail, Save as split), has the in:.
// Every other folder starts on all mail, or a search typed in the Inbox would be the inbox-only search this replaced.
const SEARCH_FROM = { trash: "trash", spam: "spam" };
function typedQuery(typed) {
  if (!typed) { state.searchFrom = undefined; return ""; }
  if (state.searchFrom === undefined) state.searchFrom = SEARCH_FROM[viewBox()] || null;
  const s = parseSearch(typed);
  return state.searchFrom && !s.in.length && !s.notIn.length ? `${typed} ${SEARCH_GMAIL[state.searchFrom]}` : typed;
}
// Gmail's footer when a search of all mail has matches in Trash or Spam (Google Workspace Updates, 2015-11: "a footer at the bottom of
// search results will indicate the match and direct the user to view the messages"), with the tap that shows them. From this device's
// rows (visibleThreads.leftOut): the servers are asked for all mail, so a match only a server holds is not known here.
function leftOutNote() {
  const lo = visibleThreads.leftOut || {}; if (!state.search || (!lo.trash && !lo.spam)) return null;
  const both = lo.trash && lo.spam, k = both ? "anywhere" : lo.trash ? "trash" : "spam";
  const d = document.createElement("div"); d.className = "leftout"; d.style.cssText = "padding:14px 14px 0;text-align:center;color:var(--mut);font-size:13px";
  d.innerHTML = `Some messages in ${both ? "Trash and Spam" : VIEW_TITLES[k]} match your search. <button data-leftout="${k}" style="padding:2px 10px;font-size:13px">Show them</button>`;
  d.querySelector("button").onclick = () => searchScope(k); return d;
}
function renderChips() {
  const v = state.view; const inInbox = ["inbox", "personal", "notifications", "newsletters"].includes(v.kind);
  // one account's folder says whose, first in the row; its × goes back to every account
  const one = v.account && folderAccounts(v.kind).length ? sideOf(v.account) : null;
  const acct = one ? `<button id="acctonly" data-allacct="1" title="Show every account" style="border-color:${one.color};color:${one.color}">${esc(one.label)} · ${VIEW_TITLES[v.kind]}${ico("close")}</button>` : "";
  const allAcct = () => $$("#chips [data-allacct]").forEach((b) => b.onclick = () => setView(v.kind, null));
  // A search's row: where it looks, one tap each; the same in: the box takes, so a phone needs no typing for it. Before the
  // Reply later row, which a search typed there used to keep. The account picked still narrows it, so its chip stays, without a folder.
  if (state.search) {
    const s = searchOf(state.search), cur = s.notIn.length || s.in.length > 1 ? null : s.in[0] || "";
    const one1 = v.account ? sideOf(v.account) : null;
    $("#chips").innerHTML = (one1 ? `<button data-allacct="1" title="Search every account" style="border-color:${one1.color};color:${one1.color}">${esc(one1.label)}${ico("close")}</button>` : "") + SEARCH_SCOPES.map(([k, l]) => `<button class="${cur === k ? "on" : ""}" data-scope="${k}">${l}</button>`).join("") + `<span style="flex:1"></span><button data-savesplit="1">Save as split</button><button data-clearsearch="1" class="ghost icon" title="Clear search">${ico("close")}</button>`;
    $$("#chips [data-scope]").forEach((b) => b.onclick = () => searchScope(b.dataset.scope)); $("[data-savesplit]").onclick = () => saveSplit(state.search); $("[data-clearsearch]").onclick = () => clearSearch(); allAcct(); return;
  }
  if (state.view.kind === "replylater") { const n = prefs().replyLater.filter((k) => state.threads.has(k)).length; $("#chips").innerHTML = acct + `<span class="badge">${n} waiting</span><span style="flex:1"></span><button data-focus="1" class="primary" ${n ? "" : "disabled"}>Focus &amp; Reply</button>`; $("[data-focus]").onclick = () => focusReply(0); allAcct(); return; }
  const shown = () => visibleThreads().filter((t) => !isNewSender(t));
  if (inUnread()) {
    const n = shown().length; const cats = [[null, "All"], ...Object.entries(CATS)];
    $("#chips").innerHTML = acct + cats.map(([k, l]) => `<button class="${(v.cat || null) === k ? "on" : ""}" data-ucat="${k || ""}">${l}</button>`).join("") + `<span class="badge" title="Unread mail in every inbox, however old, and unread mail outside the inbox from the last ${SYNC.windowDays} days">${n} unread</span><span style="flex:1"></span><button data-blanket="done" ${n ? "" : "disabled"} title="Done + read for everything shown">${ico("done")}Done all</button><button data-blanket="read" ${n ? "" : "disabled"}>Read all</button><button data-blanket="trash" ${n ? "" : "disabled"}>${ico("trash")}Trash all</button>`;
    $$("#chips button[data-ucat]").forEach((b) => b.onclick = () => { state.view.cat = b.dataset.ucat || null; state.keep = new Set(); render(); });
  } else if (inInbox || v.kind === "feed") {
    // The categories with their unread counts, which the sidebar's Smart inbox rows showed; in the business inbox, the
    // domains that have mail in this list just then, as Superhuman hides an empty split; Feed is Newsletters drawn as cards.
    const feed = v.kind === "feed", cat = CATS[v.kind] ? v.kind : feed ? "newsletters" : null, aside = new Set(prefs().setAside);
    const grp = v.account === "hub" ? sideOf("hub") : null, many = !!grp && (grp.domains || []).length > 1;
    const cc = { inbox: 0 }, dc = new Map();   // unread by category; by domain, [conversations in the list, unread]
    for (const t of state.threads.values()) {
      if (t.state !== "inbox" || isHubCopy(t) || (v.account && !inAccount(t, v.account))) continue;
      const tc = catOf(t), d = many ? domainOf(t.identity) : "";
      if (many && (!cat || tc === cat) && !aside.has(t.key)) { const e = dc.get(d) || [0, 0]; e[0]++; if (t.unread) e[1]++; dc.set(d, e); }
      if (v.dom && d !== v.dom) continue;
      if (t.unread) { cc.inbox++; cc[tc] = (cc[tc] || 0) + 1; }
    }
    const cn = (n) => n ? ` <span class="cn">${n}</span>` : "";
    const doms = many ? grp.domains.filter((d) => dc.has(d) || d === v.dom) : [];
    $("#chips").innerHTML = [["inbox", "All"], ...Object.entries(CATS)].map(([k, l]) => `<button class="${v.kind === k || (feed && k === "newsletters") ? "on" : ""}" data-cat="${k}">${l}${cn(cc[k])}</button>`).join("")
      + (doms.length > 1 || v.dom ? `<span class="csep"></span>` + doms.map((d) => `<button class="${v.dom === d ? "on" : ""}" data-dom="${esc(d)}" title="${esc(d)}">${esc(domLabel(d))}${cn((dc.get(d) || [0, 0])[1])}</button>`).join("") : "")
      + `<span style="flex:1"></span>` + (cat === "newsletters" ? `<button class="${feed ? "on" : ""}" data-feed="1" title="Read newsletters as cards">${ico("feed")}Cards</button>` : "")
      + `<button data-blanket="read" title="Mark everything shown as read">Read all</button><button data-blanket="archive" title="Mark everything shown as Done">Done all</button>`;
    $$("#chips button[data-cat]").forEach((b) => b.onclick = () => setView(b.dataset.cat, v.account, v.dom));
    $$("#chips button[data-dom]").forEach((b) => b.onclick = () => setView(v.kind, v.account, v.dom === b.dataset.dom ? null : b.dataset.dom));
    $$("#chips button[data-feed]").forEach((b) => b.onclick = () => setView(feed ? "newsletters" : "feed", v.account, v.dom));
  } else {
    $("#chips").innerHTML = acct;
  }
  allAcct();
  $$("#chips button[data-blanket]").forEach((b) => b.onclick = () => blanket(b.dataset.blanket, shown()));
}

// ---------- render: list ----------
// The first conversation row showing at the top of the list, and how far its top sits from the list's top edge (negative when it is
// partly scrolled off). What "the place in the list" means for every restore below.
function topVisibleRow(el) {
  const top = el.getBoundingClientRect().top;
  for (const d of el.children) if (d.dataset.key && d.getBoundingClientRect().bottom > top + 1) return { key: d.dataset.key, off: d.getBoundingClientRect().top - top };
  return null;
}
// Rows that skip layout (content-visibility, Chromium only) are sized from --rowh. It is measured from a real row (after every render
// and whenever the list's width changes, so the text size and the layout are always the current ones) which makes a skipped row exactly
// as tall as a laid-out one: a new row above the viewport, or scrolling back up past rows not yet drawn, moves nothing on screen.
function syncRowEstimate(el) {
  const a = topVisibleRow(el); const row = a && [...el.children].find((d) => d.dataset.key === a.key && d.querySelector(".snip")); if (!row) return false;
  const cs = getComputedStyle(row); const h = row.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
  const v = Math.round(h * 100) / 100 + "px"; if (h > 0 && el.style.getPropertyValue("--rowh") !== v) { el.style.setProperty("--rowh", v); return true; } return false;
}
function render() {
  if (state.view.kind === "drafts" && !state.search) return renderDrafts();   // its own list; a search shows its results
  renderGen++; for (const r of [...activeGestures]) { try { r(false); } catch (_) {} } activeGestures.clear();
  // WebKit (the Mac app's WKWebView) drops a scroller to the top the moment its children are cleared below; Chromium keeps the offset.
  // So on the Mac every rebuild of the SAME list (a trash in Unread, any refresh) threw the user back to the top (Deleting a
  // row further down jumped the list to the top). The offset is put back for the same list; a different view starts as it did.
  const listEl = $("#threads"); const ctx = [state.view.kind, state.view.account || "", state.view.cat || "", state.search || ""].join("\u0001");
  const keepTop = render.ctx === ctx ? listEl.scrollTop : null; const keepRows = render.ctx === ctx ? render.mainCursor || 0 : 0; render.ctx = ctx;
  // Restored by the top visible ROW, not the raw offset: where rows above it skip layout (content-visibility, Chromium) the rebuilt ones
  // are sized from an estimate, so the same scrollTop showed rows ~1,100 px away after a refresh deep in the list. Putting that row back
  // on the same pixel is right in both engines; the raw offset is the fallback when the row itself is gone.
  const anchor = keepTop !== null ? topVisibleRow(listEl) : null;
  // AT THE TOP, the top is the place (back in the app, the newest mail was above the view).
  // Keeping the top row on its pixel there pushed whatever had just arrived above it out of view; the list now stays at the top, and
  // only a list scrolled down keeps its row.
  const restoreTop = () => {
    if (keepTop === null) return;
    if (keepTop < 1) { if (listEl.scrollTop) listEl.scrollTop = 0; return; }
    const row = anchor && [...listEl.children].find((d) => d.dataset.key === anchor.key);
    if (row) { const d = row.getBoundingClientRect().top - listEl.getBoundingClientRect().top - anchor.off; if (Math.abs(d) >= 0.5) listEl.scrollTop += d; }
    else if (listEl.scrollTop !== keepTop) listEl.scrollTop = keepTop;
  };
  const pt0 = performance.now(); renderNav(); renderChips(); syncTabbar(); const pt1 = performance.now();
  const rows = visibleThreads(); const el = listEl; const pt2 = performance.now();
  // The same list re-rendering (every refresh, most actions) REUSES the nodes of rows whose markup did not change, and builds only the
  // rest. Clearing and rebuilding every row cost ~90 ms on a phone-speed CPU for 240 rows, and the rebuilt rows lost their laid-out size:
  // where rows above the viewport skip layout the list moved under my eyes, and on WebKit the scroller even reset to the top.
  // A different list (view, account, category, search) is still built from scratch.
  const reuse = keepTop !== null && rows.length > 0 && state.view.kind !== "feed";
  if (!reuse) el.innerHTML = "";
  if (!rows.length) { el.innerHTML = `<div class="empty">${state.loading ? "Loading…" : "Nothing here"}</div>`; const n = leftOutNote(); if (n) el.appendChild(n); return; }
  const oldRows = new Map(), oldDays = new Map();
  if (reuse) for (const d of el.children) { if (d.dataset.key && d._html) oldRows.set(d.dataset.key, d); else if (d.className === "day") { const a = oldDays.get(d.textContent) || []; a.push(d); oldDays.set(d.textContent, a); } }
  let lastDay = ""; const p = prefs(); const want = [];
  render.rows = rows; render.rendered = 0;
  // Gatekeeper: first-time senders are screened above the inbox (Spark's default placement)
  const fresh = rows.filter(isNewSender);
  if (fresh.length) {
    const box = document.createElement("div"); box.style.cssText = "border-bottom:2px solid var(--line);background:var(--card)";
    box.innerHTML = `<div class="day" style="background:transparent;display:flex;align-items:center;gap:8px">New senders <span class="badge">${fresh.length}</span><span style="flex:1"></span><button data-gk="acceptall" style="padding:2px 8px;font-size:12px">Accept all</button><button data-gk="blockall" style="padding:2px 8px;font-size:12px">Block all</button></div>` + fresh.map((t) => `<div class="t" data-key="${esc(t.key)}"><div ${tileAttrs(t, t.fromAddr)}>${esc((t.fromName || "?")[0].toUpperCase())}</div><div class="who"><span style="overflow:hidden;text-overflow:ellipsis">${esc(t.fromName || t.fromAddr)}</span><span class="badge">${esc(t.fromAddr)}</span></div><div class="when"><span class="tm">${when(t.date)}</span></div><div class="sub">${esc(t.subject)}</div><div class="snip" style="display:flex;gap:6px;flex-wrap:wrap;white-space:normal"><button data-gk="accept" data-key="${esc(t.key)}" style="padding:3px 9px;font-size:12px">${ico("check")}Accept</button><button data-gk="block" data-key="${esc(t.key)}" style="padding:3px 9px;font-size:12px">${ico("block")}Block</button>${isPublicMailbox(t.fromAddr) ? "" : `<button data-gk="acceptdom" data-key="${esc(t.key)}" class="ghost" style="padding:3px 8px;font-size:12px" title="Accept everyone at this domain">${ico("check")}*@${esc(t.fromAddr.split("@")[1])}</button><button data-gk="blockdom" data-key="${esc(t.key)}" class="ghost" style="padding:3px 8px;font-size:12px" title="Block everyone at this domain">${ico("block")}*@${esc(t.fromAddr.split("@")[1])}</button>`}<span style="flex:1"></span></div></div>`).join("");
    box.querySelectorAll(".t").forEach((d) => d.onclick = (e) => { if (e.target.closest("button")) return; openThread(d.dataset.key); });
    box.querySelectorAll("[data-gk]").forEach((b) => b.onclick = async (e) => { e.stopPropagation(); const k = b.dataset.gk; if (k.endsWith("dom")) { const t = state.threads.get(b.dataset.key); if (!t) return; return domainRule(t.fromAddr.split("@")[1], k === "acceptdom" ? "accept" : "block", t.account); } const targets = k.endsWith("all") ? fresh : [state.threads.get(b.dataset.key)].filter(Boolean); if (k.startsWith("accept")) { const addrs = [...new Set(targets.map((t) => t.fromAddr))]; await api("/api/senders", { method: "POST", body: JSON.stringify({ addresses: addrs, status: "accepted" }) }); addrs.forEach((x) => state.pendingSenders.delete(x)); for (const t of targets) { const r = senderRule(t.fromAddr, t.account); if (r && r.action === "block" && lc(r.pattern).startsWith("*@")) { try { const rr = await api("/api/sender-rules", { method: "POST", body: JSON.stringify({ pattern: t.fromAddr, action: "accept" }) }); state.rules.push(rr.rule); } catch (_) {} } } toast(`Accepted ${targets.length}`); render(); } else { if (!(await ask(`Block ${targets.length} sender(s)? Their mail goes to trash in every account.`, { ok: "Block", danger: true }))) return; for (const t of targets) await act(t, "block", { quiet: true }); toast(`Blocked ${targets.length}`); } });
    want.push(box);
  }
  if (state.view.kind === "feed") { renderFeed(rows, el); restoreTop(); return; }
  const mainAll = rows.filter((t) => !isNewSender(t)); render.mainAll = mainAll;
  const main = mainAll.slice(0, Math.max(RENDER_CHUNK, keepRows)); render.mainCursor = main.length;   // a rebuild of the same list keeps every row already scrolled into, or the offset is clamped back
  // Group by sender for Notifications / Newsletters (one line per sender, expandable)
  const grouped = new Map(); const groupable = p.groupSenders && (CATS[state.view.kind] ? state.view.kind !== "personal" : false);
  if (groupable) for (const t of main) { const g = grouped.get(t.fromAddr) || []; g.push(t); grouped.set(t.fromAddr, g); }
  const seenGroup = new Set();
  const rowNode = (t) => {
    const html = rowHtml(t, p); const d = oldRows.get(t.key);
    // A row still carrying a transform was slid off by a committed swipe whose action left it in the list (pin, read): rebuilt, never reused.
    if (d && d._html === html && d._t === t && !d.style.transform) { oldRows.delete(t.key); const c = rowClass(t); if (d.className !== c) d.className = c; return d; }
    return buildRow(t, p, html);
  };
  const dayNode = (day) => { const d = oldDays.get(day)?.shift(); if (d) return d; const n = document.createElement("div"); n.className = "day"; n.textContent = day; return n; };
  for (const t of main) {
    if (groupable && grouped.get(t.fromAddr)?.length > 1) {
      if (seenGroup.has(t.fromAddr)) { if (!expanded.has(t.fromAddr)) continue; } else {
        seenGroup.add(t.fromAddr); const g = grouped.get(t.fromAddr); const open = expanded.has(t.fromAddr);
        const gd = document.createElement("div"); gd.className = "t grp" + (g.some((x) => x.unread) ? " unread" : "");   // grey only when something in it is unread, like any row
        gd.innerHTML = `<div ${tileAttrs(t, t.fromAddr)}>${esc((unbidi(t.fromName)[0] || "?").toUpperCase())}</div><div class="who"><span style="overflow:hidden;text-overflow:ellipsis">${esc(unbidi(t.fromName || t.fromAddr))}</span><span class="badge">${g.length}</span></div><div class="when"><span class="tm">${when(t.date)}</span></div><div class="sub">${open ? "▾" : "▸"} ${esc(g.filter((x) => x.unread).length)} unread · <bdi>${esc(String(t.subject || "").replace(BIDI_CTRL, ""))}</bdi></div><div class="quick"><button data-g="archive" title="Done all from this sender">✓ all</button><button data-g="read" title="Read all">read</button></div>`;
        gd.onclick = () => { if (expanded.has(t.fromAddr)) expanded.delete(t.fromAddr); else expanded.add(t.fromAddr); render(); };
        gd.querySelectorAll("[data-g]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); bulk(b.dataset.g, g); });   // with Undo and the bulk log
        want.push(gd); if (!open) continue;
      }
    }
    const day = dayLabel(t.date);
    if (p.groupByDay && !state.search && day !== lastDay) { want.push(dayNode(day)); lastDay = day; }
    want.push(rowNode(t));
  }
  // Put the wanted nodes in order with as few DOM moves as possible: drop every node that is not wanted first, so the reused rows are
  // already in sequence and are left exactly where they are; only new or changed rows are inserted.
  const keep = new Set(want);
  for (const d of [...el.children]) if (!keep.has(d)) d.remove();
  const pt3 = performance.now(); let cur = el.firstChild;
  for (const n of want) { if (n === cur) cur = cur.nextSibling; else el.insertBefore(n, cur); }
  const pt3b = performance.now();
  render.lastDay = lastDay; render.groupable = groupable; render.grouped = grouped; render.seenGroup = seenGroup;
  render.io?.disconnect(); render.moreIo?.disconnect();   // the sentinel and footer this render replaced are not watched for ever
  if (render.mainCursor < mainAll.length) { const sent = document.createElement("div"); sent.className = "sentinel"; sent.style.cssText = "height:1px"; el.appendChild(sent); if (typeof IntersectionObserver !== "undefined") (render.io ||= new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) appendRows(); }, { root: el, rootMargin: "800px" })).observe(sent); }
  scheduleIdle(() => prefetchBodies(mainAll.slice(0, prefetchWindow())));
  markSnapshotDirty();   // render() kept a SECOND snapshot writer on a 1.5 s debounce: same full sort of every thread; one path now
  const moreIo = () => (render.moreIo ||= new IntersectionObserver((es) => { const m = es.find((e) => e.isIntersecting)?.target; if (m && $("#threads").scrollHeight > $("#threads").clientHeight + 40) setTimeout(() => (state.search ? searchMore(m) : autoLoad(m)), 150); }, { root: el, rootMargin: "600px" }));
  const hasMore = !state.search && accountsAll().some((a) => a.kind === "gmail" && (!state.view.account || a.id === state.view.account));
  if (state.search) {
    // A search goes deeper the same way older mail does: the local index answers at once, the servers' first pages follow, and
    // scrolling to the end pulls the next page from every account that still has one. The footer says where the search stands.
    const note = leftOutNote(); if (note) el.appendChild(note);
    const more = document.createElement("div"); more.className = "more"; more.style.cssText = "padding:14px;text-align:center;color:var(--mut);font-size:13px"; el.appendChild(more);
    const pending = serverSearch.pending || serverSearch.busy; const deeper = searchHasMore(state.search);
    more.textContent = pending ? "Searching the servers…" : deeper ? "Scroll for older matches" : state.serverHitKeys ? "Every match on the servers is listed" : "";
    if (!pending && deeper && typeof IntersectionObserver !== "undefined") moreIo().observe(more);
  }
  // Older mail loads by itself as the list is scrolled to its end (a sentinel below the last row); after three empty 30-day
  // extensions in a row the sentinel becomes a button so a quiet mailbox does not keep spending Gmail quota.
  else if (hasMore && ["inbox", "archived", "all", "sent"].includes(viewBox())) {
    const more = document.createElement("div"); more.className = "more"; more.style.cssText = "padding:14px;text-align:center;color:var(--mut);font-size:13px"; el.appendChild(more);
    const exhausted = (loadMore.empty || 0) >= 3;
    const show = () => { more.innerHTML = loadMore.busy ? "Loading older mail…" : exhausted ? `<button class="ghost">Look further back</button>` : ""; more.querySelector("button")?.addEventListener("click", () => { loadMore.empty = 0; autoLoad(more); }); };
    show();
    if (!exhausted && typeof IntersectionObserver !== "undefined") moreIo().observe(more);
  }
  const pt3c = performance.now(); restoreTop();   // after every row and footer is in, so the old offset is not clamped against a list still being built
  if (syncRowEstimate(listEl)) restoreTop();
  const pt4 = performance.now();   // the parts of a full render, recorded in the field (Settings -> Speed) so a slow one names its phase
  perf.record("render:nav", pt1 - pt0); perf.record("render:sort", pt2 - pt1); perf.record("render:rows", pt3 - pt2); perf.record("render:place", pt4 - pt3);
  perf.record("render:place:insert", pt3b - pt3); perf.record("render:place:footer", pt3c - pt3b); perf.record("render:place:restore", pt4 - pt3c);   // render:place was 36 ms on the Mac; which part
}
async function autoLoad(more) {
  if (loadMore.busy || !more.isConnected) return; loadMore.busy = true; loadMore.at = Date.now(); more.textContent = "Loading older mail…";
  const rowsBefore = visibleThreads().length; // "empty" means nothing new appeared in THIS view, not merely nothing fetched
  try { await loadMore({ quiet: true }); loadMore.empty = visibleThreads().length > rowsBefore ? 0 : (loadMore.empty || 0) + 1; }
  finally { loadMore.busy = false; render(); }   // render() keeps the place itself; a raw scrollTop put back here would undo its anchoring
}
async function loadMore({ quiet = false } = {}) {
  const want = accountsAll().filter((a) => a.kind === "gmail").filter((a) => !state.view.account || a.id === state.view.account);
  let total = 0;
  await Promise.all(want.map(async (a) => { try { const n = (await extendGmailWindow(a.id, 30)) || 0; total += n; if (!quiet) toast(`${a.label}: ${n} older messages loaded`); } catch (e) { toast(`${a.label}: ${e.message}`); } }));
  return total;
}

const RENDER_CHUNK = 80;
// How many conversations are kept body-ready ahead of the finger. On a touch device there is no hover to warm anything, and the user
//  clears the inbox from the top, so the window has to cover more than the first screen. Each miss costs a full body fetch
// (measured p50 373 ms) and 40 Gmail units; each hit costs the same 40 units earlier, so on a good link this trades order, not
// quota. On a BAD link it does not: twenty-five full message bodies is real data and real time on a radio that is already
// struggling, and prefetching them can cost the thing it is meant to buy. saveData already turns prefetch off entirely; this
// scales the rest to what the connection says it can carry.
function prefetchWindow() {
  try {
    const t = navigator.connection?.effectiveType || "";
    if (t === "slow-2g" || t === "2g") return 6;
    if (t === "3g") return 12;
  } catch (_) {}
  return 25;
}
// A row is its markup plus its classes. The markup is built as a string first so render() can tell an unchanged row from a changed one
// without creating anything: an unchanged row keeps its node (and with it its laid-out size and its place), only changed rows are rebuilt.
// An empty snippet is written as a zero-width space so its line keeps its height: every plain row is then exactly one height, which is
// what makes the measured size of a row that skips layout exact (5 of 560 real rows were 59 px instead of 77 px).
const rowClass = (t) => "t" + (state.cur === t.key ? " sel" : "") + (t.unread ? " unread" : "") + (state.checked.has(t.key) ? " checked" : "") + (state.focus === t.key ? " focus" : "") + (inUnread() && !t.unread ? " seen" : "");
// A search lists every folder, so each result not in the Inbox says where it is, as Gmail's results carry their folder.
const SEARCH_TAG = { archived: "Archive", trash: "Trash", spam: "Spam", snoozed: "Snoozed" };
// The list's look. A sender is a pale tile of its own hue with the letter in that hue; a business (the Smart Inbox files
// it under Notifications or Newsletters) is a rounded square, a person a circle. In the unified inbox the inbox a row came to is named
// just before the time, whose slot has one width, so the names line up down the list and a long subject can no longer push them off;
// the pin and the paperclip moved to the end of the subject line for the same reason.
const isBiz = (t) => !!t && !t.out && ["notifications", "newsletters"].includes(catOf(t));
const tileAttrs = (t, key) => `class="av${isBiz(t) ? " biz" : ""}" style="--h:${hueFor(key)}"`;
// The row names the sidebar entry the conversation is listed under, in that entry's colour: a work mailbox by its own
// name, never its domain's. Domain mail names its domain: under a Domains entry that holds several, the domain in that
// entry's colour, there and in that entry's own list, where the rows would otherwise not say which business they came to; a domain with
// its own row, that row's name. A default that is a domain or an address is shortened here only ("sheritlabs" for yourdomain.example,
// "work" for sam@work.example).
const sideIdOf = (t) => { const o = ownerOf(t); if (o !== "hub") return o; const d = domainOf(t.identity); return ownRowDomains().has(d) ? "hub:" + d : o; };
// A render asks this for every row, so the sidebar's entries are indexed once per synchronous run and dropped at its end: 17.5 µs a
// row in WebKit when each row rebuilt the list.
let sideMemo = null;
const sideIndex = () => { if (!sideMemo) { sideMemo = new Map(sideAccounts().map((a) => [a.id, a])); queueMicrotask(() => { sideMemo = null; }); } return sideMemo; };
function inboxTag(t) {
  const v = state.view; if (v.account && (v.account !== "hub" || v.dom)) return "";
  const id = sideIdOf(t), s = sideIndex().get(id) || accountOf(id); if (!s) return "";
  const d = id === "hub" && (s.domains || []).length > 1 ? domainOf(t.identity) : "";
  if (v.account && !d) return "";
  const label = d ? domLabel(d) : s.domain && s.label === s.domain ? domLabel(s.domain) : String(s.label || "").includes("@") ? shortDomain(domainOf(s.label)) : s.label;
  return `<span class="acl" style="--ac:${esc(s.color || "var(--mut)")}">${esc(label)}</span>`;
}
// A preview made of nothing but invisible characters. Marketing mail pads its hidden preview with zero-width spaces,
// joiners and direction marks so a mail app pulls no body text into it; a sender that wrote no preview sends the padding alone, so
// Gmail's snippet (the first ~200 characters) is all padding and the row's second line was blank (4 of 483 conversations in 30 days
// ). Such a row shows the first visible text of its newest message once that message's body is here (opened, or fetched
// ahead); until then the line stays blank, as before. The snippet itself is unchanged: search and find still read it.
const INVISIBLE_RE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]/g;
const visibleText = (s) => String(s || "").replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
const snipFill = new Map();   // thread key -> { stamp: the thread's newest message id when read, text }
let snipTimer = 0; const snipRender = () => { clearTimeout(snipTimer); snipTimer = setTimeout(render, 60); };
function newestText(t, msgs) {   // the text of the thread's newest message, only if it is the one the row's snippet is from
  let m = null; for (const x of msgs || []) if (x && (!m || (x.date || 0) >= (m.date || 0))) m = x;
  if (!m || (t.lastMsgId && m.id !== t.lastMsgId)) return "";
  let s = ""; try { s = visibleText(plainOf(m)); } catch (_) { return ""; }
  const subj = visibleText(t.subject); if (subj && s.toLowerCase().startsWith(subj.toLowerCase())) s = s.slice(subj.length).trim();   // a body that opens with its subject as a heading
  return s.slice(0, 200);
}
function fillSnip(t, msgs) { if (visibleText(t.snippet)) return; const text = newestText(t, msgs); snipFill.set(t.key, { stamp: t.lastMsgId || t.date || "", text }); if (text) snipRender(); }
function shownSnippet(t) {
  if (state.search && t._hit && t._hit.snip) return t._hit.snip;
  if (visibleText(t.snippet)) return t.snippet;
  const stamp = t.lastMsgId || t.date || "", f = snipFill.get(t.key); if (f && f.stamp === stamp) return f.text;
  snipFill.set(t.key, { stamp, text: "" });   // looked up once per newest message; a body cached later fills it through cacheThread
  idb.getByIndex("bodies", "threadKey", t.key).then((rows) => { const cur = snipFill.get(t.key); if (!cur || cur.stamp !== stamp || cur.text) return; const text = newestText(t, (rows || []).map((r) => r.m)); if (text) { cur.text = text; snipRender(); } }).catch(() => {});
  return "";
}
function rowHtml(t, p) {
    const who = rowPeer(t);
    return `<div class="swipe l">${ACTIONS[p.swipes.right] || ""}</div><div class="swipe r">${ACTIONS[p.swipes.left] || ""}</div>
      <div ${tileAttrs(t, who.key)}>${esc(who.initial.toUpperCase())}<span class="chk">${ico("check")}</span></div>
      <div class="who"><span class="ud"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(who.label)}</span>${t.count > 1 ? `<span class="badge">${t.count}</span>` : ""}${isPriority(t) ? `<span class="lbl pri">priority</span>` : ""}${!t.out && state.pendingSenders.has(t.fromAddr) ? `<span class="badge" title="First time this address has written to you">new</span>` : ""}${p.setAside.includes(t.key) ? `<span class="badge">set aside</span>` : ""}${t._server ? `<span class="badge">server</span>` : ""}</div>
      <div class="when">${inboxTag(t)}<span class="tm">${when(t.date)}</span></div>
      <div class="sub fx">${draftKeys().has(t.key) ? `<span class="drafttag">Draft</span>` : ""}<bdi>${esc(shownSubject(t))}</bdi> ${(t.labels || []).filter((x) => ["trademark-scam", "blocked", "over-budget", "removed-on-server", "locked-out"].includes(x)).map((x) => `<span class="lbl scam">${esc(x)}</span>`).join("")}${trashLens(t) ? `<span class="lbl">${t.binnedIds.length} in Trash</span>` : ""}${state.search && SEARCH_TAG[t.state] ? `<span class="lbl fold">${SEARCH_TAG[t.state]}</span>` : ""}${t.starred || t.hasAtt ? `<span class="ic">${t.starred ? ico("pin") : ""}${t.hasAtt ? `<span class="hasatt" role="img" aria-label="Has attachments" title="Has attachments">${ico("attach")}</span>` : ""}</span>` : ""}</div>
      <div class="snip">${esc(shownSnippet(t)) || "&#8203;"}</div>
      <div class="quick"><button data-q="archive" title="Done">${ico("done")}</button><button data-q="snooze" title="Snooze">${ico("snoozed")}</button><button data-q="trash" title="Trash">${ico("trash")}</button>${t.out ? "" : `<button data-q="unsubscribe" title="Unsubscribe from ${esc(unbidi(t.fromAddr))}">${ico("unsub")}</button>`}</div>`;
}
// The drag-to-select state; the gesture is below the selection helpers.
const dragSel = { id: null, on: false, eat: false, y0: 0, x: 0, y: 0, anchor: null, cur: null, add: false, base: null, keys: null, idx: null, lo: -1, hi: -1, raf: 0 };
function buildRow(t, p, html = rowHtml(t, p)) {
    const div = document.createElement("div"); div.className = rowClass(t); div.dataset.key = t.key;
    div.innerHTML = html; div._html = html; div._t = t;
    // Shift-click with nothing checked yet runs from the open conversation.
    div.querySelector(".av").onclick = (e) => { e.stopPropagation(); const from = state.lastChecked || state.cur; if (e.shiftKey && from) selectRange(from, t.key); else toggleCheck(t.key); };
    div.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") setFocus(t.key); });
    div.querySelectorAll(".quick button").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const lt = state.threads.get(t.key) || t; if (b.dataset.q === "unsubscribe") return act(lt, "unsubscribe"); actFlow(lt, b.dataset.q); });
    div.onclick = (e) => { if (gestureGuard.key === t.key && Date.now() < gestureGuard.until) return; if (e.shiftKey && (state.lastChecked || state.cur)) return selectRange(state.lastChecked || state.cur, t.key); return state.selecting ? toggleCheck(t.key) : openThread(t.key); };
    div.onmouseenter = () => scheduleIdle(() => prefetchBodies([t]));
    attachSwipe(div, t);
    return div;
}
function appendRows() {
  const el = $("#threads"); const sent = el.querySelector(".sentinel"); if (!render.mainAll) return;
  const next = render.mainAll.slice(render.mainCursor, render.mainCursor + RENDER_CHUNK); if (!next.length) { sent?.remove(); return; }
  const p = prefs(); const frag = document.createDocumentFragment();
  for (const t of next) {
    if (render.groupable && render.grouped.get(t.fromAddr)?.length > 1 && render.seenGroup.has(t.fromAddr) && !expanded.has(t.fromAddr)) continue;
    const day = dayLabel(t.date); if (p.groupByDay && day !== render.lastDay) { const d = document.createElement("div"); d.className = "day"; d.textContent = day; frag.appendChild(d); render.lastDay = day; }
    frag.appendChild(buildRow(t, p));
  }
  render.mainCursor += next.length; if (sent) el.insertBefore(frag, sent); else el.appendChild(frag);
  if (render.mainCursor >= render.mainAll.length) sent?.remove();
}
const scheduleIdle = (fn) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
// ---- prefetch + prerender: bodies for what you will probably open next, HTML built ahead of time ----
const prerendered = new Map(); const PRERENDER_MAX = 40; let prefetchBusy = false; const prefetchQueue = [];
async function prefetchBodies(threads) {
  prefetchBodies.calls = (prefetchBodies.calls || 0) + 1;   // a counter on the function itself, so a test can see internal calls
  if (navigator.connection?.saveData) return;
  for (const t of threads) if (t && !prerendered.has(t.key) && !prefetchQueue.includes(t.key)) prefetchQueue.push(t.key);
  if (prefetchBusy) return; prefetchBusy = true;
  try {
    while (prefetchQueue.length) {
      { const key0 = prefetchQueue[0]; const t0 = state.threads.get(key0); if (t0 && t0.kind === "gmail" && cooldownLeft(t0.account)) break; } // no background bodies while Gmail is rate-limiting
      const key = prefetchQueue.shift(); const t = state.threads.get(key) || [...state.serverSearch.values()].find((x) => x.key === key); if (!t || prerendered.has(key)) continue;
      let d = (await cachedThread(t)) || (await pushedThread(t));
      if (!d) { if (!navigator.onLine) break; try { d = await adapterFor(t.account).thread(t.id); await cacheThread(t, d); } catch (_) { continue; } }
      prerender(t, d);
      await new Promise((r) => scheduleIdle(r));
    }
  } finally { prefetchBusy = false; }
}
// The full fetch carries every header: a row that was synced before the client captured List-Unsubscribe (or whose newest inbound
// message changed) learns it when the conversation is opened or prefetched. The newest inbound message THAT CARRIES the header wins; a
// newer inbound message without one never erases a known header. The message records learn it too, so a
// later re-derivation keeps it; a thread whose inbound messages all lack it is marked known so the backfill skips it.
function refreshRowFromBodies(t, d) {
  try { const live = state.threads.get(t.key); if (!live || !d?.messages || d.binnedView) return; const inbound = d.messages.filter((m) => !m.out && m.unsub !== undefined); if (!inbound.length) return;
    const src = [...inbound].reverse().find((m) => m.unsub) || null; const u = src ? src.unsub : "", up = src ? (src.unsubPost || "") : "";
    const changed = (u && (u !== (live.unsub || "") || up !== (live.unsubPost || ""))) || !live.unsubKnown; if (!changed) return;
    if (u) { live.unsub = u; live.unsubPost = up; } live.unsubKnown = true; live.updatedAt = Date.now(); idb.putAll("threads", [live]);
    if (live.kind === "gmail") idb.getByIndex("messages", "threadKey", live.key).then((recs) => { const upd = (recs || []).filter((r) => { const m = d.messages.find((x) => x.id === r.id); if (!m || m.unsub === undefined || (r.unsub === m.unsub && (r.unsubPost || "") === (m.unsubPost || ""))) return false; r.unsub = m.unsub; r.unsubPost = m.unsubPost || ""; return true; }); if (upd.length) idb.putAll("messages", upd); }).catch(() => {});
  } catch (_) {}
}
// Rows whose message records predate the header capture (unsubKnown false or absent) learn List-Unsubscribe in the background without
// being opened. Newest threads first; for each, its inbound message records newest first: a record that already carries the field is
// read as is, a legacy record costs one messages.get (metadata, List-Unsubscribe + -Post, 20 quota units); the walk stops at the first
// header found, and a thread whose inbound messages all lack one is marked known. Hard cap: at most `perMinute` gets in any rolling
// `windowMs`, counted before every call whatever its outcome (404 = that message is gone, walk on; any other failure ends the run,
// counts a try on the row, and re-arms after a minute; three failed runs mark the row known). Never during a sync, never under a 429
// cooldown, never offline or on save-data. Outbound-last threads (you replied to the list) are candidates like any other.
const UNSUB_BACKFILL = { perMinute: 20, windowMs: 60000, batch: 20, maxTries: 3, calls: [] };
let unsubBackfillBusy = false, unsubBackfillTimer = null;
async function unsubPaced(fn) { // sliding window over the last windowMs, applied before the call regardless of its result
  const B = UNSUB_BACKFILL; for (;;) { const now = Date.now(); B.calls = B.calls.filter((t) => now - t < B.windowMs); if (B.calls.length < B.perMinute) break; await new Promise((r) => setTimeout(r, B.calls[0] + B.windowMs - now + 5)); }
  B.calls.push(Date.now()); (B.log ||= []).push(Date.now()); if (B.log.length > 500) B.log.shift(); return fn(); // log = every call ever made, for the rolling-cap receipt
}
async function backfillUnsub() {
  if (unsubBackfillBusy || !navigator.onLine || navigator.connection?.saveData || syncState.running.size) return; unsubBackfillBusy = true; clearTimeout(unsubBackfillTimer);
  let stopped = false;
  try {
    const cands = [...state.threads.values()].filter((t) => t.kind === "gmail" && !t.unsub && !t.unsubKnown).sort((a, b) => b.date - a.date).slice(0, UNSUB_BACKFILL.batch);
    for (const t of cands) {
      if (!navigator.onLine || cooldownLeft(t.account) || syncState.running.size) { stopped = true; break; }
      const recs = await idb.getByIndex("messages", "threadKey", t.key).catch(() => []);
      const inbound = [...(recs || [])].filter((r) => !(r.labels || []).includes("SENT")).sort((a, b) => b.date - a.date);
      let found = null, failed = false;
      for (const rec of inbound) {
        if (rec.unsub !== undefined) { if (rec.unsub) { found = rec; break; } continue; } // synced with the header captured: known value
        let m; try { m = await unsubPaced(() => gapi(t.account, `messages/${rec.id}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`)); }
        catch (e) { if (e.status === 404) { rec.unsub = ""; rec.unsubPost = ""; await idb.putAll("messages", [rec]); continue; } failed = true; break; }
        rec.unsub = hv(m, "List-Unsubscribe"); rec.unsubPost = hv(m, "List-Unsubscribe-Post"); await idb.putAll("messages", [rec]);
        if (rec.unsub) { found = rec; break; }
      }
      if (failed) { t.unsubTries = (t.unsubTries || 0) + 1; if (t.unsubTries >= UNSUB_BACKFILL.maxTries) t.unsubKnown = true; await idb.putAll("threads", [t]); stopped = true; break; }
      if (found) { t.unsub = found.unsub; t.unsubPost = found.unsubPost || ""; } t.unsubKnown = true; t.updatedAt = Date.now(); await idb.putAll("threads", [t]);
    }
    if (stopped) unsubBackfillTimer = setTimeout(backfillUnsub, 60000); else if (cands.length === UNSUB_BACKFILL.batch) scheduleIdle(backfillUnsub); // more may remain
  } finally { unsubBackfillBusy = false; }
}
// The first pictures of a mail being made ready, into this device's cache before it is opened. x-warm makes the hub
// answer only from what it holds, so a warm-up never reaches a sender; none when the phone is saving data. The same URL as the frame's
// own <img> request, so that request is a cache hit.
const warmed = new Set();
function warmPictures(docs) {
  if (navigator.connection?.saveData) return;
  const urls = [];
  for (const d of docs) { for (const m of String(d).matchAll(/\/api\/img\?u=[^"'\s<>)]+/g)) { const u = m[0].replace(/&amp;/g, "&"); if (!urls.includes(u)) urls.push(u); if (urls.length >= 4) break; } if (urls.length >= 4) break; }
  for (const u of urls) { if (warmed.has(u)) continue; if (warmed.size > 2000) warmed.clear(); warmed.add(u); fetch(u, { headers: { "x-warm": "1" }, priority: "low", credentials: "same-origin" }).catch(() => {}); }
}
function prerender(t, d) {
  refreshRowFromBodies(t, d);
  // Newest message first (the latest message goes at the top). d.messages stays oldest-first (that is the
  // data's order and the reply logic reads it) only the display is reversed, and openThread maps the elements back the same way.
  const shown = [...d.messages].reverse();
  const older = Math.max(0, shown.length - OPEN_NEWEST);
  const docs = [];
  const html = (older ? `<button class="ghost expall" style="margin:0 0 10px">Expand all ${shown.length} messages</button>` : "") + shown.map((m, i) => messageHtml(m, i, shown.length, docs, { thread: t })).join("");
  prerendered.set(t.key, { html, docs, d, at: Date.now() });
  warmPictures(docs);
  if (prerendered.size > PRERENDER_MAX) { const oldest = [...prerendered.entries()].sort((a, b) => a[1].at - b[1].at)[0]; prerendered.delete(oldest[0]); }
}
const cssEsc = (v) => (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");
function setFocus(key) { if (state.focus === key) return; const prev = state.focus; state.focus = key; if (prev) $(`.t[data-key="${cssEsc(prev)}"]`)?.classList.remove("focus"); if (key) $(`.t[data-key="${cssEsc(key)}"]`)?.classList.add("focus"); }
function syncChecks() { state.selecting = state.checked.size > 0; $("#app").classList.toggle("selecting", state.selecting); $("#selcount").textContent = `${state.checked.size} selected`; selSpam(); $$(".t").forEach((d) => d.classList.toggle("checked", state.checked.has(d.dataset.key))); }
function selectRange(a, b) { const rows = visibleThreads().filter((t) => !isNewSender(t)); const i = rows.findIndex((t) => t.key === a), j = rows.findIndex((t) => t.key === b); if (i < 0 || j < 0) return toggleCheck(b); for (const t of rows.slice(Math.min(i, j), Math.max(i, j) + 1)) state.checked.add(t.key); state.lastChecked = b; syncChecks(); }
function selectAll() { const rows = visibleThreads().filter((t) => !isNewSender(t)); for (const t of rows) state.checked.add(t.key); syncChecks(); toast(`${state.checked.size} selected`); }
function selectFromHere(key = state.focus || state.cur) { const rows = visibleThreads().filter((t) => !isNewSender(t)); const i = rows.findIndex((t) => t.key === key); if (i < 0) return selectAll(); for (const t of rows.slice(i)) state.checked.add(t.key); state.lastChecked = key; syncChecks(); toast(`${state.checked.size} selected from here`); }
function clearSelection() { state.checked.clear(); state.lastChecked = null; syncChecks(); }
function toggleCheck(key) { if (state.checked.has(key)) state.checked.delete(key); else { state.checked.add(key); state.lastChecked = key; } state.selecting = state.checked.size > 0; $("#app").classList.toggle("selecting", state.selecting); $("#selcount").textContent = `${state.checked.size} selected`; selSpam(); $$(".t").forEach((d) => d.classList.toggle("checked", state.checked.has(d.dataset.key))); }
// ---------- drag to select ----------
// A mouse pressed on a row and moved 6 px up or down selects every conversation from that row to the one under the pointer, in the
// list's order (selectRange's: those folded under a sender or not drawn yet count too); dragging back shrinks it. Within 48 px of the
// list's top or bottom the list scrolls, 4 to 24 px a frame by depth, and the selection follows. ⌘ or shift at the press adds to what was
// selected; otherwise the drag replaces it. The click that ends a drag opens nothing. Touch keeps its swipes and long-press (attachSwipe).
function dragUpdate() {
  const L = $("#threads"), r = L.getBoundingClientRect();
  const el = document.elementFromPoint(Math.max(r.left + 2, Math.min(r.right - 2, dragSel.x)), Math.max(r.top + 2, Math.min(r.bottom - 2, dragSel.y)));
  const k = el && el.closest ? el.closest("#threads .t[data-key]")?.dataset.key : null; if (k && dragSel.idx.has(k)) dragSel.cur = k;   // a heading or a sender's group row keeps the last row
  const i = dragSel.idx.get(dragSel.anchor), j = dragSel.idx.get(dragSel.cur); if (i === undefined || j === undefined) return;
  const lo = Math.min(i, j), hi = Math.max(i, j); if (lo === dragSel.lo && hi === dragSel.hi) return; dragSel.lo = lo; dragSel.hi = hi;
  state.checked.clear(); for (const x of dragSel.base) state.checked.add(x); for (let n = lo; n <= hi; n++) state.checked.add(dragSel.keys[n]);
  state.lastChecked = dragSel.cur; syncChecks();
}
function dragLoop() {
  dragSel.raf = requestAnimationFrame(dragLoop);
  const L = $("#threads"), r = L.getBoundingClientRect(), EDGE = 48, y = dragSel.y;
  const v = y < r.top + EDGE ? -Math.min(24, 4 + (r.top + EDGE - y) / 2) : y > r.bottom - EDGE ? Math.min(24, 4 + (y - (r.bottom - EDGE)) / 2) : 0;
  if (v) { const before = L.scrollTop; L.scrollTop += v; if (L.scrollTop !== before) dragUpdate(); }
}
function dragEnd() {
  if (dragSel.on) { dragSel.eat = true; cancelAnimationFrame(dragSel.raf); if (state.checked.size) toast(`${state.checked.size} selected`); }
  dragSel.id = null; dragSel.on = false; dragSel.keys = dragSel.idx = dragSel.base = null;
}
$("#threads").addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 0 || e.ctrlKey) return;   // a control-click is the Mac's right click
  const row = e.target.closest(".t[data-key]"); if (!row || e.target.closest(".quick, button, a, input, select, textarea")) return;
  Object.assign(dragSel, { id: e.pointerId, on: false, y0: e.clientY, x: e.clientX, y: e.clientY, anchor: row.dataset.key, cur: row.dataset.key, add: e.metaKey || e.shiftKey, lo: -1, hi: -1 });
});
window.addEventListener("pointermove", (e) => {
  if (e.pointerId !== dragSel.id) return;
  if (!(e.buttons & 1)) return dragEnd();   // the button came up outside the window
  dragSel.x = e.clientX; dragSel.y = e.clientY;
  if (!dragSel.on) {
    if (Math.abs(e.clientY - dragSel.y0) < 6) return;
    dragSel.keys = visibleThreads().filter((t) => !isNewSender(t)).map((t) => t.key); dragSel.idx = new Map(dragSel.keys.map((k, n) => [k, n]));
    dragSel.base = dragSel.add ? new Set(state.checked) : new Set(); dragSel.on = true;
    try { $("#threads").setPointerCapture(e.pointerId); } catch (_) {}
    try { getSelection().removeAllRanges(); } catch (_) {}
    dragSel.raf = requestAnimationFrame(dragLoop);
  }
  e.preventDefault(); dragUpdate();
});
window.addEventListener("pointerup", (e) => { if (e.pointerId === dragSel.id) dragEnd(); });
window.addEventListener("pointercancel", (e) => { if (e.pointerId === dragSel.id) dragEnd(); });
// The list's text is never selected by a press, a drag or a double-click (WebKit ignored the rows' user-select:none, app.html.t).
$("#threads").addEventListener("selectstart", (e) => e.preventDefault());
// The release that ends a drag makes one click; it opens nothing. Swallowed before any row sees it, and forgotten at the next press, so a
// click straight after a drag still opens (a 400 ms window had eaten one in the test).
$("#threads").addEventListener("click", (e) => { if (dragSel.eat) { dragSel.eat = false; e.stopPropagation(); e.preventDefault(); } }, true);
window.addEventListener("pointerdown", () => { dragSel.eat = false; }, true);
$$("#selbar button").forEach((b) => b.onclick = async () => { const k = b.dataset.bulk; if (k === "cancel") return clearSelection(); if (k === "all") return selectAll(); if (k === "fromhere") return selectFromHere(); const threads = [...state.checked].map(threadFor).filter(Boolean); clearSelection(); if (k === "spam") return spamMany(threads); bulk(k, threads); });
// Spam on several conversations at once (the selection bar, a right-click on a selection): Gmail mail reported,
// mail at your own domains trashed and its senders blocked (spamDomain), one Undo for all of it. Your own mail and mail already in
// Spam are left as they are.
const spamAble = (x) => !!x && (x.kind === "gmail" ? x.state !== "spam" : !x.out && !!x.fromAddr && x.state !== "trash");
async function spamMany(list) {
  const go = list.filter(spamAble); if (!go.length) return toast("Nothing here to report as spam");
  const undos = []; let g = 0, d = 0;
  for (const x of go) {
    if (x.kind === "gmail") { act(x, "spam", { quiet: true }).catch(() => {}); g++; undos.push(() => act(state.threads.get(x.key) || x, "notspam", { quiet: true })); }   // local now, the queue sends it
    else { const r = await spamDomain(x, { quiet: true }); if (r?.undo) { d++; undos.push(r.undo); } }
  }
  const senders = new Set(go.filter((x) => x.kind !== "gmail").map((x) => lc(x.fromAddr))).size;
  toast([g ? `Reported ${g} as spam` : "", d ? `trashed ${d} and blocked ${senders === 1 ? "the sender" : senders + " senders"}` : ""].filter(Boolean).join("; ") || "Nothing was reported", 6000,
    undos.length ? () => { for (const u of undos) Promise.resolve(u()).catch(() => {}); toast("Undone"); } : null);   // each puts its own back on screen at once; the server follows
}
function selSpam() { const b = $('#selbar [data-bulk="spam"]'); if (b) b.style.display = [...state.checked].some((k) => spamAble(state.threads.get(k))) ? "" : "none"; }

// ---------- bulk actions: one queue row per action, Gmail batchModify in 1,000-id chunks, hub bulk endpoint, undo ----------
const BULK_ACTIONS = ["archive", "done", "trash", "restore", "read", "unread", "star", "unstar"];
const BULK_PATCH = Object.fromEntries(BULK_ACTIONS.map((k) => [k, THREAD_ACTIONS[k].set]));
const BULK_LABELS = Object.fromEntries(BULK_ACTIONS.map((k) => [k, [THREAD_ACTIONS[k].add, THREAD_ACTIONS[k].remove]]));
const bulkWord = { archive: "done", done: "done", trash: "trashed", restore: "restored", read: "marked read", unread: "marked unread", star: "pinned", unstar: "unpinned", undo: "restored" };
async function applyGmailLabelsBulk(t, add, remove) { try { const msgs = await idb.getByIndex("messages", "threadKey", t.key); if (!msgs.length) return; for (const m of msgs) { const l = new Set(m.labels || []); add.forEach((x) => l.add(x)); remove.forEach((x) => l.delete(x)); m.labels = [...l]; } await idb.putAll("messages", msgs); } catch (_) {} }
// `inPlace` takes each row out of the list where it is, as a single Trash does, instead of rebuilding the list (an unsubscribe:
// the tapped row and the sender's other promotions); `id` lets the caller undo the job by name.
async function bulk(action, threads, { quiet = false, id = uuid4(), inPlace = false, sure = false } = {}) {
  action = doneOf(action);
  threads = threads.map((t) => (t && t._server && threadFor(t.key)) || t).filter(Boolean); if (!threads.length) return; // a server-search row is adopted, not silently skipped
  if (action === "trash" && threads.length > 50 && !sure && !(await ask(`Move ${threads.length} conversations to Trash? Undo stays available for 7 days.`, { ok: "Trash them", danger: true }))) return;
  const before = {}; const patchv = BULK_PATCH[action]; if (!patchv) return toast("Unknown bulk action " + action);
  const drop = () => { let full = false; for (const t of threads) { if (state.cur === t.key) removeFromList(t); else if (!dropRowNode(t.key, dayLabel(t.date))) full = true; } if (full) render(); };
  perf.measure("bulk:" + action, () => { for (const t of threads) { before[t.key] = { state: t.state, starred: t.starred, unread: t.unread }; Object.assign(t, patchv); if (action === "restore") t.binnedIds = null; /* threads.modify takes TRASH off every message, the trashed few of a live conversation too */ t.updatedAt = Date.now(); queue.recent.set(t.key, Date.now()); announce(t); } if (inUnread()) state.keep = new Set(); if (inPlace) drop(); else render(); updateBadge(); }); // recent: a sync already in flight cannot overwrite these rows
  const job = { id, at: Date.now(), action, keys: threads.map((t) => t.key), before, status: "queued", count: threads.length };
  const logged = bulkLogSave([job, ...state.bulkLog]);   // in the log before the first wait, so an Undo tapped at once finds it
  await idb.putAll("threads", threads);
  const [add, remove] = BULK_LABELS[action]; scheduleIdle(async () => { for (const t of threads) if (t.kind === "gmail") await applyGmailLabelsBulk(t, add, remove); });
  await logged;
  if (!quiet) toast(`${threads.length} ${bulkWord[action]}`, 5000, () => bulkUndo(id));
  if (action !== "unread") noteHandled(threads.map((t) => t.key));
  return queue.add({ op: "bulk", account: "bulk", threadKey: "bulk:" + id, args: { id, action, keys: job.keys } });
}
async function bulkUndo(id) {
  const job = state.bulkLog.find((j) => j.id === id); if (!job || ["undone", "undoing"].includes(job.status)) return toast(job?.status === "undoing" ? "Undo is already on its way" : "Nothing to undo");
  if (Date.now() - job.at > 7 * 86400000) return toast("Undo has expired (7 days)");
  if (job.done && job.done.length && job.done.length < job.keys.length) job.before = Object.fromEntries(Object.entries(job.before).filter(([k]) => job.done.includes(k))); // only what reached the server is undone remotely; the rest was already rolled back
  const threads = []; for (const [key, b] of Object.entries(job.before)) { let t = state.threads.get(key); if (!t) { t = await idb.get("threads", key); if (t) state.threads.set(key, t); } if (!t) continue; Object.assign(t, b); t.updatedAt = Date.now(); queue.recent.set(key, Date.now()); announce(t); threads.push(t); }
  render(); updateBadge(); await idb.putAll("threads", threads);
  scheduleIdle(async () => { for (const t of threads) if (t.kind === "gmail") { const b = job.before[t.key]; await applyGmailLabelsBulk(t, [...(b.state === "inbox" ? ["INBOX"] : []), ...(b.state === "trash" ? ["TRASH"] : []), ...(b.unread ? ["UNREAD"] : []), ...(b.starred ? ["STARRED"] : [])], [...(b.state !== "inbox" ? ["INBOX"] : []), ...(b.state !== "trash" ? ["TRASH"] : []), ...(b.unread ? [] : ["UNREAD"]), ...(b.starred ? [] : ["STARRED"])]); } });
  job.status = "undoing"; await bulkLogSave(state.bulkLog); toast(`${threads.length} restored`);
  return queue.add({ op: "bulk", account: "bulk", threadKey: "bulk:" + job.id, args: { id: job.id, action: "undo", keys: threads.map((t) => t.key), restore: job.before, reapply: job.action } });
}
async function bulkLogSave(jobs) { const cut = Date.now() - 7 * 86400000; state.bulkLog = jobs.filter((j) => j.at >= cut || ["queued", "undoing", "partial", "failed", "undo_failed"].includes(j.status)).slice(0, 200); try { await idb.putAll("meta", [{ key: "bulklog", jobs: state.bulkLog }]); } catch (_) {} }
async function bulkLogLoad() { try { const r = await idb.get("meta", "bulklog"); state.bulkLog = (r && Array.isArray(r.jobs)) ? r.jobs : []; } catch (_) { state.bulkLog = []; } }
async function blanket(action, rows) { if (!rows.length) return; if (action !== "trash" && rows.length > 50 && !(await ask(`${action === "read" ? "Mark" : "Mark as Done"} ${rows.length} conversations${action === "read" ? " as read" : ""}?`, { ok: action === "read" ? "Mark read" : "Done" }))) return; bulk(action, rows); }
// The sender's conversations in the list being looked at (in Unread, what it shows: unread, or read and kept on screen), and always the
// conversation the action was asked on: opening a mail in Unread marks it read, so "Trash all from" there counted 0 and
// left the open one where it was.
function senderThreads(t) {
  const acct = state.view.account, ub = inUnread();
  const rows = [...state.threads.values()].filter((x) => x.fromAddr === t.fromAddr && !isHubCopy(x) && (!acct || inAccount(x, acct)) && (ub ? (x.unread || state.keep.has(x.key)) && x.state !== "trash" && x.state !== "spam" : x.state === "inbox"));
  const self = state.threads.get(t.key); if (self && self.state !== "trash" && self.state !== "spam" && !rows.includes(self)) rows.push(self);
  return rows;
}
const senderScope = () => state.view.account ? "in " + (sideOf(state.view.account)?.label || state.view.account) : "in every account";
function senderBulk(t, action) { const rows = senderThreads(t); if (!rows.length) return toast("Nothing from this sender here"); bulk(action, rows); }
modifierHandlers.bulk = {
  label: "Bulk action",
  persist: async (r) => {
    const { action } = r.args; r.args.done ||= []; r.args.missing ||= []; r.args.imapFailed ||= []; const doneSet = new Set(r.args.done);
    const keys = r.args.keys.filter((k) => !doneSet.has(k)); const threads = keys.map((k) => state.threads.get(k)).filter(Boolean); const out = { gmailCalls: 0, hubCalls: 0 };
    const mark = async (ks) => { for (const k of ks) if (!doneSet.has(k)) { doneSet.add(k); r.args.done.push(k); } await queue.update(r); }; // progress survives a retry: completed targets are never re-sent
    const delta = (t) => { if (action !== "undo") return BULK_LABELS[action]; const b = r.args.restore[t.key]; return [[...(b.state === "inbox" ? ["INBOX"] : []), ...(b.state === "trash" ? ["TRASH"] : []), ...(b.unread ? ["UNREAD"] : []), ...(b.starred ? ["STARRED"] : [])], [...(b.state !== "inbox" ? ["INBOX"] : []), ...(b.state !== "trash" ? ["TRASH"] : []), ...(b.unread ? [] : ["UNREAD"]), ...(b.starred ? [] : ["STARRED"])]]; };
    const byAccount = new Map(); for (const t of threads) { const a = t.kind === "gmail" ? t.account : "hub"; (byAccount.get(a) || byAccount.set(a, []).get(a)).push(t); }
    for (const [acct, list] of byAccount) {
      if (acct === "hub") { // one request per distinct patch; the Worker answers with changed / missing / imap_failed ids
        const groups = new Map(); for (const t of list) { const p = action === "undo" ? { state: r.args.restore[t.key].state, unread: r.args.restore[t.key].unread, starred: r.args.restore[t.key].starred } : BULK_PATCH[action]; const sig = JSON.stringify(p); (groups.get(sig) || groups.set(sig, { p, items: [] }).get(sig)).items.push(t); }
        for (const { p, items } of groups.values()) for (let i = 0; i < items.length; i += 2000) {
          const chunk = items.slice(i, i + 2000); const res = await api("/api/threads/bulk", { method: "POST", body: JSON.stringify({ ids: chunk.map((t) => t.id), ...p }) }); out.hubCalls++;
          const missing = new Set(res.missing || []); const imapFailed = new Set(res.imap_failed || []);
          for (const t of chunk) { if (missing.has(t.id)) r.args.missing.push(t.key); if (imapFailed.has(t.id) && !r.args.imapFailed.includes(t.key)) r.args.imapFailed.push(t.key); }
          await mark(chunk.filter((t) => !missing.has(t.id) && !imapFailed.has(t.id)).map((t) => t.key)); // IMAP write-back failures stay undone → retried
        }
        continue;
      }
      // Gmail: the local cache cannot prove a thread is complete (older messages may sit outside the window and keep INBOX/UNREAD), so every
      // thread is modified as a whole with threads.modify. Six in flight; a 429 pauses via the cooldown.
      let idx = 0; let firstErr = null;
      const worker = async () => { while (idx < list.length && !firstErr) { const t = list[idx++]; const [add, remove] = delta(t); try { await cooldownWait(acct); await gapi(acct, `threads/${t.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) }); out.gmailCalls++; await mark([t.key]); } catch (e) { firstErr = firstErr || e; } } };
      await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
      if (firstErr) throw firstErr;
    }
    if (r.args.imapFailed.length) { const pending = r.args.imapFailed.filter((k) => !doneSet.has(k)); if (pending.length) throw new Error(`${pending.length} work-mailbox write-back(s) could not be queued; retrying`); }
    return { ...out, done: r.args.done.length, missing: r.args.missing, imapFailed: r.args.imapFailed };
  },
  after: async (r, res) => {
    const job = state.bulkLog.find((j) => j.id === r.args.id); if (!job) return;
    const missing = res.missing || [], imapFailed = res.imapFailed || [];
    if (missing.length) { for (const k of missing) { const t = state.threads.get(k); const b = job.before?.[k]; if (t && b && r.args.action !== "undo") Object.assign(t, b); } render(); toast(`${missing.length} conversation${missing.length > 1 ? "s" : ""} no longer exist on the hub and were left unchanged`, 6000); }
    if (imapFailed.length) toast(`${imapFailed.length} work-mailbox write-back${imapFailed.length > 1 ? "s" : ""} could not be queued (Settings → Bulk actions)`, 8000);
    if (r.args.action === "undo") job.status = "undone"; else { job.status = missing.length || imapFailed.length ? "partial" : "done"; job.done = r.args.done; job.missing = missing; job.imapFailed = imapFailed; job.calls = { gmail: res.gmailCalls, hub: res.hubCalls }; }
    await bulkLogSave(state.bulkLog);
  },
  rollback: async (r) => { // keep what the server accepted (r.args.done); revert only the rest locally; a failed undo re-applies the original action
    const job = state.bulkLog.find((j) => j.id === r.args.id); const done = new Set(r.args.done || []); const rest = r.args.keys.filter((k) => !done.has(k));
    const reverted = [];
    if (r.args.action === "undo") { const p = BULK_PATCH[r.args.reapply]; for (const k of rest) { const t = state.threads.get(k); if (t && p) { Object.assign(t, p); reverted.push(t); } } if (job) job.status = "undo_failed"; }
    else { for (const k of rest) { const t = state.threads.get(k); const b = job?.before?.[k]; if (t && b) { Object.assign(t, b); reverted.push(t); } } if (job) { job.status = done.size ? "partial" : "failed"; job.done = [...done]; } }
    for (const t of reverted) { t.updatedAt = Date.now(); announce(t); } if (reverted.length) idb.putAll("threads", reverted); // durable, and the other window follows
    if (job) await bulkLogSave(state.bulkLog); render(); updateBadge();
    toast(r.args.action === "undo" ? `Undo did not reach the server for ${rest.length} — Settings → Bulk actions to retry` : `${rest.length} of ${r.args.keys.length} not applied on the server and reverted here — Settings → Bulk actions to retry`, 9000);
  },
};
// ---------- swipes (touch) ----------
let lastListScroll = 0; const pressTimers = new Set(); let renderGen = 0; const activeGestures = new Set(); // render() bumps the generation and resets every live gesture
const gestureGuard = { key: null, until: 0 }; // click suppression tracked by thread key + time, so a rebuilt row honours it too
function attachSwipe(div, t0) {
  // The gesture keeps only the key; the live row object is looked up when the action fires (a sync may have replaced it). It was a
  // Proxy before: Undo put the Proxy itself into state.threads, whose getter then recursed forever (RangeError), and IndexedDB could not
  // clone it (DataCloneError), so no swiped action was ever saved locally (reproduced in test/swipe.py).
  const t = { key: t0.key }; const live = () => state.threads.get(t0.key) || null; // null: the row left the store before the action fired, nothing happens
  // Pointer Events + `touch-action: pan-y`: the browser owns vertical panning and fires pointercancel when it takes a gesture for
  // scrolling (MDN). The pointer is captured at pointerdown so pointerup/cancel always reach this row. A swipe starts
  // only once the movement is clearly horizontal (|dx| ≥ 12 px and ≥ 1.5 × |dy|); a swipe that turns vertical is abandoned. A long-press
  // (500 ms still) selects, and un-selects itself if that same finger then scrolls. Any render during a gesture cancels it.
  let id = null, x0 = 0, y0 = 0, dx = 0, dy = 0, mode = null, raf = 0, press = null, wasLong = false, gen = 0, samples = [], down = "";
  const SLOP = 8, LOCK = 12, DOMINANCE = 1.5, PRESS_MS = 500, SHORT = () => Math.max(64, div.clientWidth * 0.2), LONG = () => Math.max(150, div.clientWidth * 0.5);
  const l = () => div.querySelector(".swipe.l"), r = () => div.querySelector(".swipe.r");
  const pick = () => { const p = prefs(); const long = Math.abs(dx) >= LONG(); return dx > SHORT() ? (long ? p.swipes.rightLong : p.swipes.right) : dx < -SHORT() ? (long ? p.swipes.leftLong : p.swipes.left) : null; };
  const shown = () => { const lim = LONG(); const a = Math.abs(dx); return Math.sign(dx) * (a <= lim ? a : lim + (a - lim) * 0.35); }; // rubber-band past the long mark
  const paint = () => { raf = 0; if (mode !== "swipe") return; div.style.transform = `translateX(${shown()}px)`; const p = prefs(); const a = pick() || (dx > 0 ? p.swipes.right : p.swipes.left); const long = Math.abs(dx) >= LONG(); const side = dx > 0 ? l() : r(); const other = dx > 0 ? r() : l(); if (other) other.style.opacity = 0; if (side) { side.textContent = ACTIONS[spamSwipe(a, live())] || ""; side.style.background = swipeColor(a, dx > 0, long); side.style.opacity = Math.min(1, Math.abs(dx) / SHORT()); } if (long !== wasLong) { wasLong = long; try { navigator.vibrate?.(8); } catch (_) {} } };
  const cancelPress = () => { if (press) { clearTimeout(press); pressTimers.delete(press); press = null; } };
  const reset = (animate) => { if (raf) cancelAnimationFrame(raf); raf = 0; cancelPress(); activeGestures.delete(reset); div.style.transition = animate ? "transform .16s ease-out" : ""; div.style.transform = ""; div.classList.remove("swiping"); [l(), r()].forEach((x) => { if (x) x.style.opacity = 0; }); wasLong = false; mode = null; id = null; samples = []; setTimeout(() => (div.style.transition = ""), 180); };
  const guard = () => { gestureGuard.key = t.key; gestureGuard.until = Date.now() + 300; };
  const velocity = (now) => { // px/ms over the last ~60 ms; zero if the finger paused before release
    const last = samples[samples.length - 1]; if (!last || now - last.t > 100) return 0; let ref = last; for (let i = samples.length - 1; i >= 0; i--) { ref = samples[i]; if (last.t - ref.t >= 60) break; } const dt = last.t - ref.t; return dt > 0 ? (last.x - ref.x) / dt : 0; };
  div.addEventListener("pointerdown", (e) => {
    down = e.pointerType;
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    if (id !== null) reset(false);
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; mode = null; gen = renderGen; samples = [{ t: performance.now(), x: e.clientX }]; activeGestures.add(reset);
    try { div.setPointerCapture(id); } catch (_) {} // release/cancel always come back here (MDN: capture target of future pointer events)
    press = setTimeout(() => { pressTimers.delete(press); press = null; if (mode === null && gen === renderGen && performance.now() - lastListScroll > PRESS_MS) { mode = "press"; toggleCheck(t.key); try { navigator.vibrate?.(12); } catch (_) {} } }, PRESS_MS); pressTimers.add(press);
  });
  div.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return; dx = e.clientX - x0; dy = e.clientY - y0; const now = performance.now(); samples.push({ t: now, x: e.clientX }); if (samples.length > 12) samples.shift();
    if (gen !== renderGen) return reset(false);
    if (mode === "press") { if (Math.abs(dx) >= LOCK || Math.abs(dy) >= LOCK) { if (state.checked.has(t.key)) toggleCheck(t.key); mode = "scroll"; } return; } // a press that becomes a scroll un-selects
    if (mode === null) { if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return; cancelPress(); if (Math.abs(dy) >= Math.abs(dx)) { mode = "scroll"; return; } if (Math.abs(dx) < LOCK || Math.abs(dx) < DOMINANCE * Math.abs(dy)) return; mode = "swipe"; div.classList.add("swiping"); }
    if (mode === "swipe") { if (Math.abs(dy) > 48 && Math.abs(dy) > Math.abs(dx)) return reset(true); if (!raf) raf = requestAnimationFrame(paint); } // turned vertical: abandon
  });
  const finish = (e) => {
    if (e.pointerId !== id) return; const now = performance.now();
    if (gen !== renderGen) { guard(); return reset(false); } // the list changed under the finger: nothing happens
    if (mode === "press") { guard(); cancelPress(); activeGestures.delete(reset); mode = null; id = null; samples = []; return; }
    if (mode !== "swipe") { cancelPress(); activeGestures.delete(reset); mode = null; id = null; samples = []; return; }
    const vx = velocity(now); const flick = Math.abs(vx) > 0.6 && Math.abs(dx) > 40 && Math.sign(vx) === Math.sign(dx); const p = prefs(); const action = spamSwipe(pick() || (flick ? (dx > 0 ? p.swipes.right : p.swipes.left) : null), live());
    guard();
    if (!action || action === "none") return reset(true);
    // Block and Snooze ask first, so the row comes back for the card. Unsubscribe asks nothing when it can go in one tap, and then it
    // slides off like Trash: snapping back and then vanishing looked janky. Any other
    // row comes back while unsubscribe() looks its header up, or for the Block card (no link, or Spam).
    if (action === "block" || action === "snooze" || (action === "unsubscribe" && !unsubOneTap(live() || t))) { reset(true); const lt = live(); return lt ? act(lt, action) : undefined; }
    const g = gen; if (raf) cancelAnimationFrame(raf); raf = 0; cancelPress(); activeGestures.delete(reset); div.style.transition = "transform .18s ease-in"; div.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`; [l(), r()].forEach((x) => { if (x) x.style.opacity = 0; }); mode = null; id = null; samples = [];
    let fired = false; const go = () => { if (fired) return; fired = true; const lt = live(); if (g !== renderGen || !lt) { div.style.transition = ""; div.style.transform = ""; return; } act(lt, action); };
    div.addEventListener("transitionend", go, { once: true }); setTimeout(go, 220);
  };
  div.addEventListener("pointerup", finish);
  div.addEventListener("pointercancel", (e) => { if (e.pointerId !== id) return; if (mode === "press" && state.checked.has(t.key)) toggleCheck(t.key); reset(mode === "swipe"); });
  // A long press that selected keeps the system menu away; a mouse's or trackpad's right-click opens the quick menu (openQuickMenu).
  div.addEventListener("contextmenu", (e) => { if (press || mode === "press") return e.preventDefault(); if (e.pointerType === "touch" || down === "touch") return;
    const lt = live(); if (!lt) return; e.preventDefault(); e.stopPropagation(); guard(); openQuickMenu(e, lt); });   // guard: a Ctrl-click's click does not open the mail
}

// ---------- actions ----------
function restoreToList(t) { state.threads.set(t.key, t); announce(t); render(); updateBadge(); }
function removeFromList(t, { hard = false } = {}) { const dayOfRow = dayLabel(t.date); if (hard) { state.threads.delete(t.key); idb.del("threads", t.key); } else { t.updatedAt = Date.now(); idb.putAll("threads", [t]); announce(t); } if (state.cur === t.key) { state.cur = null; state.curThread = null; if (!state.advancing) { $("#msgs").innerHTML = '<div class="empty">Done</div>'; $("#actions").style.display = "none"; $("#replybox").style.display = "none"; if (!dropLayer("thread")) $("#app").classList.remove("viewing"); } } if (!dropRowNode(t.key, dayOfRow)) render(); updateBadge(); }
// Measured on the phone 2026-09-18, 97 trash actions: act:trash p50 389 ms with only 4% under 100 ms, while act:trash:net was
// p50 23 ms. The phase markers put 52 ms of it in removeFromList, which called render(), rebuilding the whole 80-row window for
// ONE row leaving, and the rest in the frame that could not arrive because the main thread was still busy doing that, ninety-seven
// times over. Taking the row out of the DOM directly is the same result for a fraction of the work; render() stays as the fallback
// for the cases a single node cannot express (grouped senders, an empty list, a row that was never rendered).
function dropRowNode(key, dayOfRow) {
  try {
    // No CSS selector here on purpose: thread keys contain "@" and "|", which need escaping, and CSS.escape is not universally
    // present (it is absent in jsdom, and was absent in older WebKit), so a selector would have silently fallen back to a full
    // render on any engine lacking it, which is exactly the cost this function exists to avoid.
    const el = $("#threads"); const node = el && [...el.querySelectorAll(".t")].find((d) => d.dataset.key === key);
    if (!node || state.selecting || state.search) return false;
    if (render.groupable) return false;                    // sender grouping re-buckets the list; let render() do it
    // The bookkeeping is decided BEFORE the DOM is touched. It used to remove the node first and update render.mainAll only if
    // findIndex happened to succeed, returning true either way, so a key the backing array did not know about left the list and
    // the array permanently disagreeing, with nothing to reconcile them.
    // Now a miss means this function declines and render() does the whole job, which is always correct.
    const i = render.mainAll ? render.mainAll.findIndex((x) => x.key === key) : -1;
    if (i < 0) return false;
    const prev = node.previousElementSibling, next = node.nextElementSibling;
    // C. A day heading may only be dropped when the window can SEE that nothing else belongs under it. If this row is the last
    // rendered one of its day but more of that day sit unrendered past the sentinel, the heading must stay, otherwise those rows
    // are appended later with no heading above them.
    const moreSameDayBeyondWindow = next && next.classList.contains("sentinel") && render.mainAll.slice(render.mainCursor)
      .some((x) => dayLabel(x.date) === (dayOfRow ?? dayLabel(state.threads.get(key)?.date ?? 0)));
    node.remove();
    if (prev && prev.classList.contains("day") && !moreSameDayBeyondWindow
        && (!next || next.classList.contains("day") || next.classList.contains("sentinel"))) prev.remove();
    render.mainAll.splice(i, 1); if (i < render.mainCursor) render.mainCursor--;
    if (!el.querySelector(".t")) return false;             // list just emptied: render() draws the "Nothing here" state
    renderNav(); renderChips();                            // the counts, which are cheap; the 80-row rebuild is what was not
    // render() also re-primed the body prefetch window, and replacing it here quietly took that away: clearing the inbox from the
    // top pulls unfetched rows up into view, and the next tap then pays a full network body fetch (open-thread:body p50 373 ms on
    // the phone). There is no hover on a touch device to cover it either. So the window is re-primed here too: prefetchBodies
    // already skips anything prerendered or queued, so this is cheap when it is not needed.
    markSnapshotDirty();   // render() drove this too; without it the next cold boot could paint a row that was already trashed
    if (render.mainAll) scheduleIdle(() => prefetchBodies(render.mainAll.slice(0, prefetchWindow())));
    return true;
  } catch (_) { return false; }
}
const ADVANCES = new Set(["archive", "done", "trash", "spam"]);
// Act on a thread; if it was the open conversation and it leaves the list, open the next one (previous at the end) instead of closing the pane.
function actFlow(t, action) {
  // Open means on screen: state.cur outlives the conversation view, which back only hides, so after reading a mail and going back to
  // the list, trashing or unsubscribing from that same row opened the next mail.
  const shown = $$("#threads .t[data-key]").map((d) => d.dataset.key); const rows = shown.length ? shown.map((k) => state.threads.get(k)).filter(Boolean) : visibleThreads(); const i = rows.findIndex((x) => x.key === t.key); const wasOpen = state.cur === t.key && $("#app").classList.contains("viewing");
  const leaves = ADVANCES.has(action) || (action === "read" && inUnread());
  const next = leaves && i >= 0 ? (rows[i + 1] || rows[i - 1] || null) : null; // next = the next RENDERED row, never a collapsed group member
  if (wasOpen && next) state.advancing = true;
  const r = act(t, action);
  if (wasOpen && next) { state.advancing = false; if (inUnread()) state.keep = new Set([next.key]); openThread(next.key); }
  else if (!wasOpen && next) setFocus(next.key);
  return r;
}
// Done marks the conversation read as well, wherever it is pressed. It used to archive only,
// outside the Unread view, so mail Done unopened from the inbox stayed in Unread until it was Done a second time there. The phone
// notification's Done already marked it read. Automatic archiving (mute, rules) does not come through here and stays as it was.
const doneOf = (action) => action === "archive" ? "done" : action;
// Acting on a snoozed conversation (Done, Trash, Restore, Spam) cancels its snooze, as designed. The code that did
// it sat after these actions had already returned, so it never ran: the snooze fired later and brought back mail that was Done or
// trashed. ?keep=1: the action decides where the conversation goes, not the cancel. Returns what
// was cancelled, so Undo can snooze it again.
function cancelSnooze(t) {
  if (t.state !== "snoozed" && !state.snoozedGmail.has(t.key)) return null;
  const sch = state.schedules.find((x) => x.kind === "snooze" && x.ref === t.id && x.account === t.account); const g = state.snoozedGmail.get(t.key);
  if (sch?.id) { api("/api/schedule/" + sch.id + "?keep=1", { method: "DELETE" }).catch(() => {}); state.schedules = state.schedules.filter((x) => x.id !== sch.id); }
  state.snoozedGmail.delete(t.key);
  if (t.kind === "gmail") gmailLabel(t.account, "Snoozed (Mail)").then((id) => id && gapi(t.account, `threads/${t.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [], removeLabelIds: [id] }) })).catch(() => {});
  const due = sch?.due_at || g?.due_at; return due ? { due_at: due } : null;
}
// Spam on mail at your own domains. There is no spam folder there, so Spam trashes the conversation at once, as
// Trash does, and blocks the sender (their mail goes straight to trash in every account), in one tap and without asking, where Block
// asks. Undo puts the conversation back where it was and lifts the block, unless the sender was blocked already; a sender waiting
// for a decision goes back to waiting. Your own mail is only trashed. Returns { undo } once both are done, false if the block failed.
async function spamDomain(t, { quiet = false } = {}) {
  const addr = lc(t.fromAddr || "");
  if (t.out || !addr.includes("@") || isMine(addr)) return act(t, "trash", { quiet });
  const t0 = performance.now(), before = { state: t.state === "snoozed" ? "inbox" : t.state, unread: t.unread, starred: t.starred };
  const isBlock = (r) => lc(r.pattern || "") === addr && r.action === "block" && (r.scope || "*") === "*";
  const had = state.rules.some(isBlock), pending = state.pendingSenders.has(t.fromAddr);
  act(t, "trash", { quiet: true }).catch(() => {});   // gone at once (act's local part runs before its first wait); the queue takes it to the server
  if (!had) {
    try { await api("/api/senders", { method: "POST", body: JSON.stringify({ address: addr, status: "blocked" }) }); state.rules.push({ pattern: addr, action: "block", scope: "*" }); state.pendingSenders.delete(t.fromAddr); }
    catch (e) { if (!quiet) toast(`Trashed, but ${t.fromAddr} could not be blocked: ${e.message}`, 8000); return false; }
  }
  perf.record("act:spam:domain", performance.now() - t0);
  const undo = async () => {
    const lt = state.threads.get(t.key) || t, post = { state: lt.state, unread: lt.unread, starred: lt.starred };
    Object.assign(lt, before); lt.updatedAt = Date.now(); idb.putAll("threads", [lt]); restoreToList(lt);
    queue.add({ op: "thread", account: lt.account, threadKey: lt.key, args: { action: "put", target: before, thread: slim(lt), undo: true, before: post, expect: post } }).catch(() => {});   // back on screen now; the queue tells the server
    if (had) return quiet ? null : toast("Back where it was");
    try { await api("/api/senders", { method: "POST", body: JSON.stringify({ address: addr, status: "accepted" }) });   // lifts the block rule
      if (pending) { await api("/api/senders", { method: "POST", body: JSON.stringify({ address: addr, status: "pending" }) }); state.pendingSenders.add(t.fromAddr); }
      state.rules = state.rules.filter((r) => !isBlock(r)); if (!quiet) toast(`Back, and ${t.fromAddr} is no longer blocked`); }
    catch (e) { toast(`Back, but ${t.fromAddr} is still blocked: ${e.message}`, 8000); }
  };
  if (!quiet) toast(had ? `Spam: trashed (${t.fromAddr} was already blocked)` : `Spam: trashed, and ${t.fromAddr} is blocked`, 6000, undo);
  return { undo };
}
// Snooze a conversation until `due`: the hub's schedule (it moves hub mail itself), and on Gmail the label and the inbox removal.
async function snoozeTo(t, due) {
  let labelId = null; if (t.kind === "gmail") labelId = await gmailLabel(t.account, "Snoozed (Mail)").catch(() => null);
  const r = await api("/api/schedule", { method: "POST", body: JSON.stringify({ kind: "snooze", account: t.account, ref: t.id, due_at: due.toISOString(), payload: { subject: t.subject, labelId } }) });
  if (t.kind === "gmail") { try { await gapi(t.account, `threads/${t.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: labelId ? [labelId] : [], removeLabelIds: ["INBOX"] }) }); } catch (e) { await api("/api/schedule/" + r.id + "?keep=1", { method: "DELETE" }).catch(() => {}); throw e; } }
  state.schedules.push({ id: r.id, kind: "snooze", account: t.account, ref: t.id, due_at: due.toISOString() }); if (t.kind === "gmail") state.snoozedGmail.set(t.key, { due_at: due.toISOString() });
  return { id: r.id, labelId };
}
async function act(t, action, { quiet = false } = {}) {
  action = doneOf(action);
  if (action === "spam" && t.kind !== "gmail") return spamDomain(t, { quiet });   // no spam folder there
  if (["archive", "done", "undone", "trash", "star", "read", "unread", "restore", "spam", "notspam", "purge"].includes(action)) {
    // `perf.measure` times from the triggering INPUT by default, and for a swipe that input is the `pointerdown` where the finger
    // landed, so the number included the whole gesture AND the deliberate 180 ms slide-off animation this row plays before act()
    // is even called. Measured on the phone across two baselines: the phases summed to 54 ms then 12 ms while act:trash read
    // 389 ms then 346 ms: an unexplained gap of 335 ms and then 334 ms. A gap that constant while the work under it dropped
    // four-fold is not congestion; it is a fixed offset, and the offset is the human plus the animation. So act:<action> is now
    // timed from the COMMIT (the moment the app is actually asked to do the work) which is the only part this code controls.
    const tap = perf.lastInput;
    const snoozed = ["done", "trash", "restore", "spam"].includes(action) ? cancelSnooze(t) : null;
    const out = perf.measure("act:" + action, () => localAct(t, action, { quiet, snoozed }), performance.now());
    // …and the end-to-end number is kept, honestly labelled, because it IS what the user experiences: it is just not a
    // measure of how fast the app is, and reading it as one once sent me chasing a 365 ms defect that did not exist.
    if (tap && performance.now() - tap < 5000) requestAnimationFrame(() => perf.record("act:" + action + ":e2e", performance.now() - tap));
    return out;
  }
  if (action === "doneall" || action === "trashall") return senderBulk(t, action === "doneall" ? "done" : "trash");
  if (!navigator.onLine) return toast("You're offline — this action needs a connection");
  const ad = adapterFor(t.account);
  try {
    if (action === "snooze") return pickTime("Snooze until", async (due) => { const r = await snoozeTo(t, due); const prev = t.state, back = { state: prev, unread: t.unread, starred: t.starred }; t.state = "snoozed"; removeFromList(t); if (t.kind === "gmail") applyGmailLabelsLocally(t, "archive"); toast("Snoozed until " + due.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }), 5000, async () => {
      // Undo puts it back where it was (archived stays archived) and takes the Snoozed label off; it always went to the inbox, and the
      // hub was told "inbox" while this device showed "archived".
      try { await api("/api/schedule/" + r.id + "?keep=1", { method: "DELETE" }); state.schedules = state.schedules.filter((s) => s.id !== r.id); state.snoozedGmail.delete(t.key);
        const from = { state: t.kind === "gmail" ? "archived" : "snoozed", unread: back.unread, starred: back.starred };
        if (t.kind === "gmail" && r.labelId) await gapi(t.account, `threads/${t.id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [], removeLabelIds: [r.labelId] }) }).catch(() => {});
        await adapterFor(t.account).put(t, from, back); if (t.kind === "gmail") applyGmailLabelsLocally(t, localDelta(from, back)); t.state = prev; restoreToList(t);
      } catch (e) { toast(e.message); } }); });
    if (action === "remind") return pickTime("Remind me", async (due) => { await api("/api/schedule", { method: "POST", body: JSON.stringify({ kind: "reminder", account: t.account, ref: t.id, due_at: due.toISOString(), payload: { title: "Follow up: " + t.subject, subject: t.subject, note: rowPeer(t).label, count: t.count } }) }); toast("Reminder set — it fires only if nobody replies"); });
    if (action === "mute") { const p = prefs(); const on = p.muted.includes(t.key); const at = { ...p.mutedAt }; if (on) delete at[t.key]; else at[t.key] = Date.now(); await setPref("muted", on ? p.muted.filter((k) => k !== t.key) : [...p.muted, t.key]); await setPref("mutedAt", at); if (!on && t.state === "inbox") localAct(t, "archive", { quiet: true }); render(); return toast(on ? "Unmuted" : "Muted - new replies stay out of the inbox"); }
    if (action === "replylater") { const p = prefs(); const on = p.replyLater.includes(t.key); await setPref("replyLater", on ? p.replyLater.filter((k) => k !== t.key) : [...p.replyLater, t.key]); render(); return toast(on ? "Removed from Reply later" : "Added to Reply later"); }
    if (action === "rename") { const nv = await askText("Subject as you want to see it (only on your side)", prefs().renames[t.key] || t.subject); if (nv === null) return; const r = { ...prefs().renames }; if (!nv.trim()) delete r[t.key]; else r[t.key] = nv.trim(); await setPref("renames", r); render(); if (state.cur === t.key) $("#vtitle").textContent = shownSubject(t); return; }
    if (action === "unsubscribe") return unsubscribe(t);
    if (action === "aside") { const p = prefs(); const on = p.setAside.includes(t.key); await setPref("setAside", on ? p.setAside.filter((k) => k !== t.key) : [...p.setAside, t.key]); render(); return toast(on ? "Back in the inbox" : "Set aside"); }
    if (action === "prithread") { const p = prefs(); const on = p.priorityThreads.includes(t.key); await setPref("priorityThreads", on ? p.priorityThreads.filter((k) => k !== t.key) : [...p.priorityThreads, t.key]); render(); return toast(on ? "Thread is no longer priority" : "Priority thread"); }
    if (action.startsWith("cat:")) { const c = action.slice(4); const r = await api("/api/sender-rules", { method: "POST", body: JSON.stringify({ pattern: t.fromAddr, category: c === "auto" ? null : c }) }); state.rules = state.rules.filter((x) => !(x.pattern === t.fromAddr && x.scope === "*")); if (r.rule) state.rules.push(r.rule); render(); return toast(c === "auto" ? "Category back to automatic" : `${t.fromAddr} → ${CATS[c]} from now on, in every account`); }
    if (action === "block") { if (!quiet && !(await ask(`Block ${t.fromAddr}? Future mail from this sender goes straight to trash in every account.`, { ok: "Block", danger: true }))) return; await api("/api/senders", { method: "POST", body: JSON.stringify({ address: t.fromAddr, status: "blocked" }) }); state.rules.push({ pattern: t.fromAddr, action: "block", scope: "*" }); state.pendingSenders.delete(t.fromAddr); const before = applyLocal(t, "trash"); removeFromList(t); try { await ad.act(t, "trash"); } catch (e) { Object.assign(t, before); t.updatedAt = Date.now(); idb.putAll("threads", [t]); if (t.kind === "gmail") applyGmailLabelsLocally(t, "restore"); restoreToList(t); return toast("Blocked " + t.fromAddr + ", but this conversation could not be trashed: " + e.message, 8000); } return quiet ? true : toast("Blocked " + t.fromAddr); }
    if (action === "priority") { await api("/api/sender-rules", { method: "POST", body: JSON.stringify({ pattern: t.fromAddr, action: "priority" }) }); state.rules.push({ pattern: t.fromAddr, action: "priority", scope: "*" }); render(); return toast("Priority sender: " + t.fromAddr); }
    await ad.act(t, action);
    if (state.curThread && state.curThread.key === t.key) syncActionBar(t);
  } catch (e) { toast(e.message); }
}
// Thread modifiers: apply locally now, persist through the queue. The inverse is what Undo (and a permanent failure) applies.
function applyLocal(t, action) {
  const before = { state: t.state, starred: t.starred, unread: t.unread };
  if (action === "restore" && t.binnedIds?.length) { before.binnedIds = t.binnedIds; t.binnedIds = null; }   // its trashed messages come back with it; a failed restore puts them back (rollback)
  const key = actionKey(action, before.starred), a = THREAD_ACTIONS[key]; if (a) Object.assign(t, a.set);
  t.updatedAt = Date.now(); idb.putAll("threads", [t]); if (t.kind === "gmail") applyGmailLabelsLocally(t, key);
  announce(t);
  return before;
}
// A notification button on this computer acted on a conversation and the hub has done it: the Windows app calls this once
// /api/notify/act answers. It is shown as if done here (out of the inbox, closed if it is open) and not sent again. The list kept it
// until the next minute's poll, and an open one stayed on screen (Trash on a Windows notification seemed to
// do nothing). Snooze leaves the inbox like Done; the next sync files it under Snoozed.
function actedElsewhere(key, action) {
  const t = state.threads.get(key), a = { done: "done", read: "read", trash: "trash", snooze: "archive" }[action];
  if (!t || !a) return false;
  applyLocal(t, a);
  const gone = a !== "read" && (viewBox() === "inbox" || inUnread());
  if (gone) removeFromList(t); else render();
  updateBadge();
  return true;
}
// Tell the other windows about a local change so they show it at once instead of an older view.
function announce(t) { broadcast({ type: "thread", key: t.key, patch: { state: t.state, unread: t.unread, starred: t.starred, updatedAt: t.updatedAt || Date.now() } }); }
// Field baseline 2026-09-18 from my phone: act:trash p50 365 ms while act:trash:net p50 was 26 ms; the OPTIMISTIC local
// half, the half that is supposed to feel instant, cost fourteen times the network call it hides, against a 100 ms bar. `act:*` is
// measured to the next animation frame, so it covers the work below plus however long that frame took to arrive. These phase
// markers split it so the next baseline names the culprit instead of us guessing; the R36 lesson: measure the cluster before
// optimising it. They are synchronous deltas, so they time real work rather than frame scheduling.
function localAct(t, action, { quiet = false, snoozed = null } = {}) {
  const p0 = performance.now();
  const before = applyLocal(t, action);
  const p1 = performance.now();
  // Trash and spam leave Unread too (its filter drops both states), so the row is taken out in place there as in the inbox: a full
  // render() rebuilt the whole list for one row, and on the Mac a rebuild is what moved the list .
  // Done in Unread takes the row out even when it was kept on screen as seen (it slid off and came back); Restore takes it out only
  // from a list it no longer belongs to (it blanked the reading pane with "Done" in Pins, Unread or search;
  if (action === "done" && inUnread()) state.keep.delete(t.key);
  const gone = (["archive", "done", "trash", "spam"].includes(action) && viewBox() === "inbox") || (["done", "trash", "spam"].includes(action) && inUnread()) || (action === "restore" && ["trash", "archived", "spam", "snoozed"].includes(viewBox())) || action === "purge";
  if (gone) removeFromList(t, { hard: action === "purge" }); else render();
  const p2 = performance.now();
  updateBadge(); if (state.curThread && state.curThread.key === t.key) syncActionBar(t);
  if (!(t.state === "inbox" && t.unread)) noteHandled([t.key]);
  const p3 = performance.now();
  perf.record("act:phase:applyLocal", p1 - p0);
  perf.record(gone ? "act:phase:removeFromList" : "act:phase:render", p2 - p1);
  perf.record("act:phase:badge+handled", p3 - p2);
  // Undo puts the conversation back exactly as it was before (state, unread, starred), as the bulk undo already did. Each action used
  // to send a fixed inverse: Trash, Spam and Done undone from Archive, Unread or Snoozed landed in the inbox, a read one came back
  // unread, and Gmail's Trash was never left. A snooze the action cancelled is set again.
  const undo = ["archive", "done", "trash", "spam"].includes(action) ? async () => {
    const post = { state: t.state, unread: t.unread, starred: t.starred };
    const again = snoozed && new Date(snoozed.due_at).getTime() > Date.now() + 60_000;
    const target = snoozed ? (again ? { ...before, state: "archived" } : { ...before, state: "inbox", unread: true }) : before;   // a snooze already due comes back as it would have
    Object.assign(t, target); t.updatedAt = Date.now(); idb.putAll("threads", [t]); if (t.kind === "gmail") applyGmailLabelsLocally(t, localDelta(post, target)); restoreToList(t);
    // A cancelled snooze is set again: put back, then snooze, in that order and directly (the hub snoozes only from inbox or archived),
    // as the snooze action's own Undo is direct.
    if (again) { try { await adapterFor(t.account).put(slim(t), post, target); await snoozeTo(t, new Date(snoozed.due_at)); t.state = "snoozed"; idb.putAll("threads", [t]); render(); } catch (e) { toast("Couldn't snooze it again: " + (e?.message || e), 6000); } return; }
    await queue.add({ op: "thread", account: t.account, threadKey: t.key, args: { action: "put", target, thread: slim(t), undo: true, before: post, expect: post } });
  } : null;
  const label = { archive: "Done", done: "Done", undone: "Back in inbox, unread", notspam: "Back in inbox", trash: "Trashed", spam: "Reported as spam — it's in Gmail's Spam now", restore: "Back in inbox", star: t.starred ? "Pinned" : "Unpinned", read: "", unread: "Marked unread", purge: "Deleted forever" }[action];
  if (!quiet && label) toast(label, undo ? 5000 : 2600, undo);
  const p4 = performance.now(); perf.record("act:phase:toast", p4 - p3);
  const q = queue.add({ op: "thread", account: t.account, threadKey: t.key, args: { action, thread: slim(t), before } });
  perf.record("act:phase:queue.add(sync)", performance.now() - p4);   // the durable IndexedDB write starts here
  return q;
}
// The server's current view of one thread's state (hub: the store; Gmail: the thread's labels), or null when it cannot be read.
async function serverState(t) {
  try {
    if (t.kind !== "gmail") { const r = await api("/api/threads/" + t.id + "?keep_unread=1"); const th = r.thread || r; return th && th.state ? { state: th.state, unread: !!th.unread, starred: !!th.starred } : null; }
    const th = await gapi(t.account, `threads/${t.id}?format=minimal`); const labels = new Set(); for (const m of shownMessages(th.messages || [], (x) => x.labelIds)) for (const l of m.labelIds || []) labels.add(l);
    return { state: labels.has("TRASH") ? "trash" : labels.has("SPAM") ? "spam" : labels.has("INBOX") ? "inbox" : "archived", unread: labels.has("UNREAD"), starred: labels.has("STARRED") };
  } catch (_) { return null; }
}
const slim = (t) => ({ key: t.key, account: t.account, kind: t.kind, id: t.id, state: t.state, starred: t.starred, unread: t.unread, subject: t.subject });
modifierHandlers.thread = {
  label: "Action",
  persist: async (r) => {
    if (r.args.undo && r.args.expect) { // an undo is only valid against the state it reverses: re-read the server first
      const srv = await serverState(r.args.thread); if (srv && srv.state !== r.args.expect.state) { const t = state.threads.get(r.threadKey); if (t) { Object.assign(t, srv); t.updatedAt = Date.now(); idb.putAll("threads", [t]); announce(t); render(); updateBadge(); } return { skipped: srv.state }; }
    }
    if (r.args.action === "put") return adapterFor(r.account).put(r.args.thread, r.args.before, r.args.target);
    return adapterFor(r.account).act({ ...r.args.thread, starred: r.args.action === "star" ? !r.args.thread.starred : r.args.thread.starred, _before: r.args.before }, r.args.action);
  },
  after: (r, res) => { if (res?.skipped) toast(`Undo skipped — that conversation had changed elsewhere (now ${res.skipped})`, 6000); },
  rollback: (r) => { const t = state.threads.get(r.threadKey); if (!t || !r.args.before) return; Object.assign(t, r.args.before); t.updatedAt = Date.now(); idb.putAll("threads", [t]); announce(t); render(); updateBadge(); },
};
modifierHandlers.send = {
  label: "Send",
  // A send cut off by its deadline has an UNKNOWN outcome: the hub records a send's idempotency key only after the mail has gone
  // (index.js sendMail), and Gmail's Message-ID lookup can run before the first send is searchable, so an automatic retry could
  // put the same mail out twice. It is handed back as not confirmed instead.
  persist: async (r) => { try { return await modifierHandlers.send.persistOnce(r); } catch (e) { if (aborted(e)) throw Object.assign(new Error("no answer from the server in time"), { permanent: true, code: "ambiguous_send" }); throw e; } },
  persistOnce: async (r) => {
    const d = r.args.draft;
    if (r.args.gmail) {
      if (d.messageId) { try { const found = await gapi(r.args.gmail, `messages?maxResults=1&q=${encodeURIComponent("rfc822msgid:" + d.messageId)}`); if ((found.messages || []).length) return { message_id: found.messages[0].id, dedup: true }; } catch (_) {} }
      const raw = buildMime(d); const res = await gapi(r.args.gmail, "messages/send", { method: "POST", body: JSON.stringify({ raw, ...(d.threadId ? { threadId: d.threadId } : {}) }) }); return { message_id: res.id, thread_id: res.threadId };
    }
    const body = { ...d, idempotency_key: r.key };
    if (r.args.replyTo) return hub.reply(r.args.replyTo, body);
    if (r.args.forwardOf) return hub.forward(r.args.forwardOf, body);
    return hub.send(body);
  },
  after: async (r, res) => { state.maybeSent = null; toast(res?.warning ? "Sent, but " + res.warning : "Sent", res?.warning ? 8000 : undefined); if (r.args.threadKey && prefs().replyLater.includes(r.args.threadKey)) setPref("replyLater", prefs().replyLater.filter((x) => x !== r.args.threadKey)).catch(() => {}); if (r.args.archiveKey) { const t = state.threads.get(r.args.archiveKey); if (t && t.state === "inbox") localAct(t, "done", { quiet: true }); } refresh({ silent: true, accounts: [r.args.gmail || "hub"] }); if (r.args.threadKey && !r.args.archiveKey) reloadOpenThread(r.args.threadKey, r.args.typed ?? r.args.draft?.text).catch(() => {}); },
  rollback: (r) => {
    if (r.code === "ambiguous_send") { state.maybeSent = { at: Date.now(), messageId: r.messageId || null }; toast("Not confirmed: this message may already have been sent. Check Sent before sending it again.", 12000); reopenDraft(r.args); return true; } // Never call an unknown outcome "Not sent"
    toast("Not sent - reopened as a draft", 6000); reopenDraft(r.args); },
};
// The Gmail labels that take a conversation from one state to another (state, unread, starred). Snoozed is archived on Gmail; Trash
// moves by its own calls (see put). `localDelta` adds TRASH for the copy kept on this device.
function gmailDelta(from, to) {
  const add = [], remove = [], inbox = (x) => x.state === "inbox";
  if (inbox(to) && !inbox(from)) add.push("INBOX"); else if (!inbox(to) && inbox(from)) remove.push("INBOX");
  if (to.state === "spam" && from.state !== "spam") add.push("SPAM"); else if (from.state === "spam" && to.state !== "spam") remove.push("SPAM");
  if (to.unread && !from.unread) add.push("UNREAD"); else if (!to.unread && from.unread) remove.push("UNREAD");
  if (to.starred !== undefined && from.starred !== undefined && !!to.starred !== !!from.starred) (to.starred ? add : remove).push("STARRED");
  return { add, remove };
}
function localDelta(from, to) { const d = gmailDelta(from, to); if (to.state === "trash" && from.state !== "trash") d.add.push("TRASH"); else if (from.state === "trash" && to.state !== "trash") d.remove.push("TRASH"); return d; }
async function applyGmailLabelsLocally(t, action) {
  try {
    const msgs = await idb.getByIndex("messages", "threadKey", t.key); if (!msgs.length) return;
    // A bare "star" here means the thread's starred value is already the new one (it pinned or unpinned): STARRED follows it.
    const a = typeof action === "object" ? action : THREAD_ACTIONS[action === "star" ? (t.starred ? "star" : "unstar") : action] || { add: [], remove: [] };
    const add = a.add, remove = a.remove;
    for (const m of msgs) { const l = new Set(m.labels || []); add.forEach((x) => l.add(x)); remove.forEach((x) => l.delete(x)); m.labels = [...l]; }
    await idb.putAll("messages", msgs); await rebuildGmailThreads(t.account, [t.key]);
  } catch (_) {}
}
const shownSubject = (t) => String(prefs().renames[t.key] || t.subject || "").replace(BIDI_CTRL, "");   // (F5: see unbidi)
const PUBLIC_MAILBOX = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|mac|aol|proton|protonmail|pm|hey|fastmail|msn|comcast|att|verizon|sbcglobal|mail|gmx|yandex|zoho)\.(com|net|me|ch|ru|de|co\.uk)$/i;
const isPublicMailbox = (addr) => PUBLIC_MAILBOX.test((addr || "").split("@")[1] || "");
async function domainRule(dom, action, account) {
  const scope = account && account !== "hub" && (await ask(`Apply to every account, or only ${account}?`, { ok: "Every account", cancel: "Only " + account })) === false ? account : "*";
  if (action === "block" && !(await ask(`Block everyone at ${dom}${scope === "*" ? "" : " for " + scope}? Address-level accept rules still win (exceptions).`, { ok: "Block domain", danger: true }))) return;
  try { const r = await api("/api/sender-rules", { method: "POST", body: JSON.stringify({ pattern: "*@" + dom, action, scope }) }); state.rules = state.rules.filter((x) => !(x.pattern === "*@" + dom && x.scope === scope)); state.rules.push(r.rule); if (action === "accept") { for (const t of state.threads.values()) if (t.fromAddr.endsWith("@" + dom)) state.pendingSenders.delete(t.fromAddr); } render(); toast(`${action === "block" ? "Blocked" : "Accepted"} *@${dom}`); } catch (e) { toast(e.message); }
}
// The row's Unsubscribe button is on EVERY received conversation (shown for every email), so this
// can no longer assume a List-Unsubscribe header. A Gmail row whose header was never captured learns it here with one metadata get:
// the same call backfillUnsub() makes in the background. Mail with no usable link cannot be unsubscribed from, and the only thing
// that actually stops it is blocking the sender, so that is offered (named as Block, with its own confirmation) rather than a toast.
async function learnUnsub(t) {
  if (t.unsub || t.unsubKnown || t.kind !== "gmail") return;
  // Newest inbound first, stopping at the first header: the same walk backfillUnsub() does, so an older message's link is not
  // missed and Block offered by mistake. Capped at three gets: this runs while the user waits on a tap.
  const recs = await idb.getByIndex("messages", "threadKey", t.key).catch(() => []);
  const inbound = [...(recs || [])].filter((r) => !(r.labels || []).includes("SENT")).sort((a, b) => b.date - a.date);
  let found = null, fetched = 0;
  for (const rec of inbound) {
    if (rec.unsub !== undefined) { if (rec.unsub) { found = rec; break; } continue; }   // captured at sync: a known value, no call
    if (fetched >= 3) break;
    fetched++;
    const m = await gapi(t.account, `messages/${rec.id}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`);
    rec.unsub = hv(m, "List-Unsubscribe"); rec.unsubPost = hv(m, "List-Unsubscribe-Post"); await idb.putAll("messages", [rec]);
    if (rec.unsub) { found = rec; break; }
  }
  if (found) { t.unsub = found.unsub; t.unsubPost = found.unsubPost || ""; t.unsubKnown = true; t.updatedAt = Date.now(); await idb.putAll("threads", [t]); return; }
  // Inconclusive: no local records (a push-adopted row, a search hit outside the window) or more unchecked records than the cap.
  // "No unsubscribe link" may only be said after looking, so read the conversation itself: one call, and it lands in the body cache.
  if (!inbound.length || inbound.some((r) => r.unsub === undefined)) {
    const d = await adapterFor(t.account).thread(t.id); cacheThread(t, d); refreshRowFromBodies(t, d);   // the live row learns it too
    const src = [...(d.messages || [])].reverse().find((m) => !m.out && m.unsub);
    if (src) { t.unsub = src.unsub; t.unsubPost = src.unsubPost || ""; }
    t.unsubKnown = true;
  }
}
const NATIVE_MAC = /\bSheritMac\//.test(navigator.userAgent);   // the native Mac app's web view announces itself in the user agent
const NATIVE_ANDROID = /\bSheritAndroid\//.test(navigator.userAgent);   // likewise the native Android app
// The Android app's own version, from the name it adds to the web view's user agent (MainActivity: "SheritAndroid/<versionName>").
const ANDROID_VERSION = (/\bSheritAndroid\/([0-9][0-9.]*)/.exec(navigator.userAgent) || [])[1] || null;
// Settings → About → Update (a tap to update from About). The hub's /dl/android/latest.json says which app
// is current (android/publish.sh writes it). Newer than this one: a button. The app from 1.14 does the update itself (bridge op
// "update": download, check the sha256, open Android's installer); an older one hands the APK's address to the browser, which downloads
// it, and opening the download installs it over this app (same signing key, nothing lost).
const versionNewer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function androidUpdateRow() {
  const btn = $("#appupd"), hint = $("#appupdhint"); if (!btn || !hint) return;
  const say = (t) => { hint.textContent = t; };
  let latest = null; try { const r = await fetch("/dl/android/latest.json", { cache: "no-store" }); if (r.ok) latest = await r.json(); } catch (_) {}
  if (!latest || !latest.versionName) { say("Could not check for an update."); btn.hidden = false; btn.textContent = "Check again"; btn.onclick = () => androidUpdateRow(); return; }
  if (!versionNewer(latest.versionName, ANDROID_VERSION || "0")) { say("Up to date."); btn.hidden = false; btn.textContent = "Check again"; btn.onclick = () => androidUpdateRow(); return; }
  say(`Version ${latest.versionName} is ready.`); btn.hidden = false; btn.className = "primary"; btn.textContent = `Update to ${latest.versionName}`;
  btn.onclick = async () => {
    btn.disabled = true; say("Downloading…");
    let r = null; try { r = nativeBridge ? await nativeBridge.call("update") : "old"; } catch (e) { const m = String(e && e.message); r = /unknown op/.test(m) ? "old" : /did not answer/.test(m) ? "Still downloading: Android's installer opens when it is ready." : `Update failed: ${m}`; }
    if (r === "old") { openExternal(latest.url); say("Your browser is downloading it. Open the download and tap Update."); btn.disabled = false; return; }
    say(/^installing/.test(String(r)) ? "Tap Update on Android's screen." : String(r || "")); btn.disabled = false;
  };
}
const NATIVE_WINDOWS = /\bSheritWindows\//.test(navigator.userAgent);   // and the native Windows app (windows/): its toasts come from the hub's feed
// The Android app injects `SheritAndroid` through WebViewCompat.addWebMessageListener, restricted to this origin. Message-body
// frames are sandboxed WITH allow-same-origin, so they have this origin too and the object may well be injected into them; what
// keeps it out of reach is that those frames have no allow-scripts, so nothing in a mail can run to call it. Never add
// allow-scripts to a message frame. (This comment used to say the frames had an opaque origin: they do not; 2026-10-03.)
// Requests are {id, op, args}; the app answers {id, result} or {id, error}.
const nativeBridge = (() => {
  const b = typeof SheritAndroid !== "undefined" ? SheritAndroid : null; if (!b) return null;
  let n = 0; const wait = new Map();
  b.onmessage = (e) => { try { const m = JSON.parse(e.data); const w = wait.get(m.id); if (!w) return; wait.delete(m.id); if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result); } catch (_) {} };
  return { call: (op, args = {}) => new Promise((resolve, reject) => { const id = ++n; wait.set(id, { resolve, reject }); b.postMessage(JSON.stringify({ id, op, args })); setTimeout(() => { if (wait.delete(id)) reject(new Error("the app did not answer")); }, 15000); }) };
})();
// The Android app's name for itself on the hub; an older app answers "unknown op" and the reports go unnamed.
// Asked for every report, never cached: right after an install the page can load before the app has its Firebase token,
//  and Firebase can
// rotate the token under a page that stays open, which changes the id. One local round trip.
const nativeDevice = () => nativeBridge ? nativeBridge.call("pushDevice").then((d) => d || null).catch(() => null) : Promise.resolve(null);
// What the page has to say about itself, in the phone's log (`adb logcat | grep SheritPage`): the only place a failure inside the
// app's web view can be read after the fact.
const nativeLog = (m) => { try { console.warn(m); nativeBridge && nativeBridge.call("log", { m: String(m).slice(0, 500) }).catch(() => {}); } catch (_) {} };
// Push stashes held in memory as well as in IndexedDB, keyed `<account>|<id>`. Adoption and pushedThread() read both, so a store
// that has stalled cannot hide mail the device already downloaded: the tap that follows still opens it from local bytes.
const memStash = new Map();
const MEM_STASH_MAX = 30;   // newest kept: each is a whole conversation held in page memory
function memStashPut(key, v) { memStash.delete(key); memStash.set(key, v); while (memStash.size > MEM_STASH_MAX) memStash.delete(memStash.keys().next().value); }
// Conversations the Android app downloaded when their notification arrived (FCM wakes it; WebView has no service-worker push)
// are handed over here and written exactly where sw.js writes its stashes, so adoption and pushedThread() treat them the same.
// The app keeps each file until the page says it is safely in IndexedDB: handing them over used to delete them first, so a store
// that could not take the write lost the mail from both places.
async function importNativeStashes() {
  if (!nativeBridge) return [];
  try {
    const list = ((await nativeBridge.call("takeStashes")) || []).filter((s) => s && s.raw && s.account && s.id);
    const saved = [], fresh = [];
    for (const s of list) {
      const v = { kind: s.kind, account: s.account, id: s.id, raw: s.raw, at: s.at || Date.now() };
      const k = `${s.account}|${s.id}`;
      if (memStash.get(k)?.at !== v.at) fresh.push(s);   // un-acked files come back on every call while the store is down: prime each once
      memStashPut(k, v);
      try { await idb.putAllStrict("meta", [{ k: `pf:${s.account}|${s.id}`, v }]); if (s.file) saved.push({ file: s.file, mtime: s.mtime }); } catch (_) {}
    }
    if (saved.length) nativeBridge.call("ackStashes", { files: saved }).catch(() => {});
    return fresh;
  } catch (_) { return []; }
}
// A conversation that arrived with its notification is made READY, not merely stored: its row is adopted into the list, its
// messages go into the body cache, and its HTML is prerendered. The tap that follows then has nothing left to fetch or build:
// openThread() takes the prerendered path and paints in the same frame (no inbox first, no "loading").
async function primeStashes(list) {
  if (!list || !list.length) return 0;
  await adoptPushStashes();
  let n = 0;
  for (const v of list) {
    const t = state.threads.get(`${v.account}|${v.id}`); if (!t) continue;
    try { const d = adapterFor(v.account).normalize(v.raw); if (!d?.messages?.length) continue; await cacheThread(t, d); prerender(t, d); n++; } catch (_) {}
  }
  if (n) { render(); updateBadge(); followOpenThread().catch(() => {}); }
  return n;
}
// Native apps hand a conversation over the moment it is downloaded, while the page is still out of sight:
//  Android: the FCM service stashes it natively and calls importNow(); the Mac app passes it straight to acceptStash().
async function acceptStash(v) {
  if (!v || !v.raw || !v.account || !v.id) return 0;
  const s = { kind: v.kind, account: v.account, id: v.id, raw: v.raw, at: v.at || Date.now() };
  await idb.meta(`pf:${s.account}|${s.id}`, s);
  return primeStashes([s]);
}
async function importNow() { return primeStashes(await importNativeStashes()); }
// A stalled store (store.js) leaves this page storeless but working: the list, taps and sends all go to the network. What it cannot
// do is keep anything for the next launch, and inside the Android app nothing short of a new process gets a working store back:
// WebView's IndexedDB backend runs inside the app's own process. So the app is restarted the next time it is out of sight, never
// over typed text or an action still waiting to go out, and the user never watches it happen. Anywhere else (a browser tab,
// the Mac app) the page reloads itself instead, at most once every ten minutes.
idb.onStall = (info) => {
  nativeLog(`IndexedDB stalled: ${info.what} unanswered after ${Math.round(info.age / 1000)} s awake, ${info.waiting} request(s) waiting; running storeless until the app restarts`);
  perf.record("idb:stall", info.age);
  if (document.hidden) recoverStore();
};
const typedWork = () => {
  const reply = ($("#rtext")?.value || "").trim(); if (reply && reply !== sigFor($("#rfrom")?.value || "").trim()) return true;
  if (($("#rfiles")?.files?.length || 0) > 0) return true;   // an attachment picked with nothing typed is unsaved work too
  return !!$("#cmodal")?.classList.contains("on") && (["#ctext", "#csub", "#cto", "#ccc", "#cbcc"].some((k) => ($(k)?.value || "").trim()) || ($("#cfiles")?.files?.length || 0) > 0);
};
function recoverStore() {
  if (!idb.stalled || recoverStore.asked) return;
  if (typedWork() || queue.pending().length || queue.draining) return;   // the next time the app is hidden tries again
  if (nativeBridge) {
    recoverStore.asked = true; nativeLog("restarting the app to get a working store back");
    // The app answers only after its last check, at the moment it would kill; a refusal (back in front, a push being handled) is
    // retried in a minute while the page stays out of sight, instead of waiting for the next time it is hidden.
    const again = () => { recoverStore.asked = false; if (document.hidden) setTimeout(recoverStore, 60_000); };
    nativeBridge.call("restart", { stalled: idb.stalled }).then((ok) => { if (!ok) again(); }, again); return;
  }
  try { if (Date.now() - (+sessionStorage.getItem("mh:storeReload") || 0) < 10 * 60_000) return; sessionStorage.setItem("mh:storeReload", String(Date.now())); } catch (_) { return; }
  recoverStore.asked = true; location.reload();
}
document.addEventListener("visibilitychange", () => { if (document.hidden) recoverStore(); else recoverStore.asked = false; });   // back in view still stalled: the app called the restart off, so the next hide asks again
const isMine = (addr) => { const a = lc(addr || ""); return !!a && ((state.me?.identities || []).some((i) => lc(i.email || "") === a) || (state.gmail || []).some((g) => lc(g.email || "") === a) || imapAccts().some((x) => lc(x.email || "") === a)); };
async function unsubscribe(t) {
  // The sender of a conversation whose last message is yours is YOU: unsubscribing or blocking would file your own address.
  if (t.out || isMine(t.fromAddr)) return toast("The last message here is yours — open the conversation to act on the sender");
  if (!t.fromAddr) return toast("This message has no sender address to unsubscribe from");
  try { await learnUnsub(t); } catch (e) { return toast("Couldn't check this message for an unsubscribe link: " + e.message); }
  const hdr = t.unsub || "";
  const links = [...hdr.matchAll(/<([^<>]+)>/g)].map((m) => m[1].trim()); const mailto = links.find((l) => /^mailto:/i.test(l));
  const https = links.find((l) => { try { const u = new URL(l); return u.protocol === "https:" && !/^\[?[\d.:]+\]?$/.test(u.hostname); } catch (_) { return false; } }); // https only, never an IP literal
  // Mail in Spam is never answered: an unsubscribe tells a spammer the address is read. Block is what stops it.
  const spam = t.state === "spam" || (t.labels || []).includes("SPAM");
  if (spam || (!mailto && !https)) {
    if (!(await ask(spam ? `This is in Spam, so ${t.fromAddr} is not asked to unsubscribe you: that would tell a spammer this address is read.\nBlock this sender instead? Future mail from them goes straight to Trash in every account.` : `${t.fromAddr} has no unsubscribe link${hdr ? " this app can use" : ""}.\nBlock this sender instead? Future mail from them goes straight to Trash in every account.`, { ok: "Block sender", danger: true }))) return;
    if (await act(t, "block", { quiet: true })) toast("Blocked " + t.fromAddr);   // true only when it fully succeeded; act() toasts its own failures
    return;
  }
  // One tap, no confirm card (RFC 8058 section 3.2 leaves "when and how the user consent is obtained" to the app, and
  // the tap is it). The unsubscribing must be quick; 5-15 s a tap was too slow. The conversation and the
  // sender's other promotions leave the list at once, as a Trash does; the next conversation opens only if this one was on screen, and
  // never another from this sender. Nothing reaches the hub or the list until the 5 s Undo has passed: then the app's queue (kept on
  // disk, so a phone that closes or goes offline sends it later) hands the hub the conversation and the sender, and the hub reads the
  // headers itself and does the rest in the background. No page ever opens here.
  const sweep = unsubSweepRows(t), rows = [t, ...sweep];
  const shown = $$("#threads .t[data-key]").map((d) => d.dataset.key); const list = shown.length ? shown.map((k) => state.threads.get(k)).filter(Boolean) : visibleThreads();
  const i = list.findIndex((x) => x.key === t.key), wasOpen = state.cur === t.key && $("#app").classList.contains("viewing");
  const next = i >= 0 ? (list.slice(i + 1).find((x) => x.fromAddr !== t.fromAddr) || list.slice(0, i).reverse().find((x) => x.fromAddr !== t.fromAddr) || null) : null;
  const id = uuid4();
  if (wasOpen && next) state.advancing = true;
  bulk("trash", rows, { quiet: true, id, inPlace: true, sure: true });   // the rows leave synchronously, inside this call; no "Trash 51?" card
  if (wasOpen && next) { state.advancing = false; openThread(next.key); } else if (!wasOpen && next) setFocus(next.key);
  // Queued at once, beside the trash: both rows are on disk within milliseconds. Waiting for the trash's queue.add first (it waits up to
  // 3 s for a service worker after its write) left a job that an app closed in those seconds never had (triage).
  const queued = queue.add({ op: "unsub", account: t.kind === "gmail" ? t.account : "hub", threadKey: "send:unsub:" + id, notBefore: Date.now() + Q.undoMs, args: { id, account: t.kind === "gmail" ? t.account : "hub", thread: t.id, sender: t.fromAddr } });
  // Undo puts the rows back at once. The job is cancelled once it is on disk (queue.add can take 3 s where no service worker answers),
  // which is always inside its 5 s: removed any earlier, a write still in flight would bring it back on the next launch.
  toast(`Unsubscribed from ${unbidi(t.fromName || t.fromAddr)}${sweep.length ? ` · ${sweep.length} more of their promotions trashed` : ""}`, Q.undoMs, async () => {
    unsubCancel(id); bulkUndo(id);   // marked cancelled at once, on disk: a row written late, or found after a restart, is never sent
    const row = await queued; if (queue.mem.get(row.key)?.sending) return toast("Too late to stop the unsubscribe: it is already on its way. The mail is back", 6000);
    await queue.remove(row.key);
  });
}
// What may leave the screen with the conversation unsubscribed from: the sender's other inbox conversations, in every account, that
// read as promotions. The when an order puts you on a list, the order mail stays and
// only the promotions go. List mail only (List-Unsubscribe), filed by Gmail under Promotions (hub mail has no category, so
// there the header decides), and no subject that reads like an order, a receipt, a delivery, a ticket, a booking or a payment. The hub
// sweeps the mail this device has not loaded by the same test, and also keeps what Gmail files under Purchases, which a row here cannot
// know. In the mail it was measured on, the few Purchases that are also Promotions with List-Unsubscribe and pass the subject test were
// notices, not orders. UNSUB_TXN is index.js's, character for character (test/unsubjob.mjs).
const UNSUB_TXN = /\b(orders?|ordered|receipts?|invoices?|purchased?|shipped|shipping|shipments?|delivered|delivery|deliveries|tracking|track|refunds?|refunded|returns?|reservations?|booking|booked|itinerary|tickets?|confirmation|confirmed|payments?|paid|statements?|renewal|renews?|autoship|bills?|billing)\b/i;
// True when unsubscribe(t) will go in one tap: a sender, not yours, not Spam, and a usable link already known, so no card is shown and
// nothing is fetched first. The swipe slides such a row off; any other row comes back for the card.
function unsubOneTap(t) {
  if (!t || t.out || !t.fromAddr || isMine(t.fromAddr) || t.state === "spam" || (t.labels || []).includes("SPAM")) return false;
  if (!t.unsub && !(t.unsubKnown || t.kind !== "gmail")) return false;   // learnUnsub would have to look first
  return [...String(t.unsub || "").matchAll(/<([^<>]+)>/g)].some((m) => { const l = m[1].trim(); if (/^mailto:/i.test(l)) return true; try { const u = new URL(l); return u.protocol === "https:" && !/^\[?[\d.:]+\]?$/.test(u.hostname); } catch (_) { return false; } });
}
// One-message conversations only: a row describes its conversation by its newest
// sender, its newest List-Unsubscribe, its first subject and the union of its labels, so a conversation holding an order beside a
// promotion, or the user's own reply, could pass. Those are left to the hub, which judges every message in them.
function unsubSweepRows(t) {
  return [...state.threads.values()].filter((x) => x.key !== t.key && (x.count || 1) === 1 && x.fromAddr === t.fromAddr && x.state === "inbox" && !x.out && !isHubCopy(x) && !!x.unsub && (x.kind !== "gmail" || (x.labels || []).includes("CATEGORY_PROMOTIONS")) && !UNSUB_TXN.test(x.subject || ""));
}
// Undo's mark, kept in localStorage (written at once, read at once, survives a restart): queue.add can still be writing its row when
// Undo is tapped, and a row it writes after that would otherwise go out on the next launch.
const unsubCancelled = () => { try { return JSON.parse(localStorage.getItem("mh:unsubCancelled") || "[]"); } catch (_) { return []; } };
function unsubCancel(id) { try { localStorage.setItem("mh:unsubCancelled", JSON.stringify([...unsubCancelled().filter((x) => x !== id), id].slice(-100))); } catch (_) {} }
modifierHandlers.unsub = {
  label: "Unsubscribe",
  persist: (r) => unsubCancelled().includes(r.args.id) ? { skipped: "undone" } : api("/api/unsubscribe/job", { method: "POST", body: JSON.stringify(r.args) }),
  // The hub files the sender under Newsletters as a category only (no accept); this device shows it at once.
  after: (r, res) => { if (res?.skipped) return; const s = r.args.sender, ex = state.rules.find((x) => x.pattern === s && x.scope === "*"); if (ex) ex.category = "newsletters"; else state.rules.push({ pattern: s, action: null, scope: "*", category: "newsletters" }); state.rules = [...state.rules]; setTimeout(loadUnsubs, 15_000); },   // the hub is usually done in a few seconds: the count catches up quietly
};
// ---------- the Unsubscribes list (slices 2 and 3) ----------
// What each list answered, from the hub. The ones that need the user, a list whose page wants a click and a sender still mailing after
// the FTC's 10 business days, are counted on the Settings button. A list's page opens only when its Open page is tapped, never on its
// own, and Block on a sender still mailing says first that their receipts go to Trash too.
const UNSUB_WORDS = { accepted: "Unsubscribed · the list said yes", confirmed: "Unsubscribed · its page says so", email_sent: "Unsubscribe email sent", handled: "You finished it on its page", needs_you: "Needs you · its page wants a click", nothing_there: "Nothing to unsubscribe from · its link does not exist, so the sender is blocked", spam: "In Spam · the sender was not contacted", no_link: "No unsubscribe link", gone: "The conversation was gone", error: "Did not go through" };
const unsubStill = (u) => u.still_count > 0 && !u.dismissed_at && senderRule(u.sender, "*")?.action !== "block";
const unsubNeeds = (u) => !u.dismissed_at && (u.outcome === "needs_you" || unsubStill(u));
const unsubNeedCount = () => (state.unsubs || []).filter(unsubNeeds).length;
async function loadUnsubs() {
  loadUnsubs.at = Date.now();
  try { state.unsubs = (await api("/api/unsubscribes")).unsubscribes || []; } catch (_) { state.unsubs ||= []; }
  const n = unsubNeedCount(), b = $("#settingsBtn"); if (!b) return state.unsubs;
  let d = b.querySelector(".nbadge"); if (!n) { d?.remove(); b.title = "Settings"; return state.unsubs; }
  if (!d) { d = document.createElement("span"); d.className = "nbadge"; b.appendChild(d); }
  d.textContent = String(n); b.title = `Settings · ${n === 1 ? "an unsubscribe needs" : n + " unsubscribes need"} you`;
  return state.unsubs;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - (loadUnsubs.at || 0) > 10 * 60_000) scheduleIdle(loadUnsubs); });
function unsubSection() {
  const rows = state.unsubs || [], need = rows.filter(unsubNeeds), rest = rows.filter((u) => !unsubNeeds(u)).slice(0, 60);
  const ago = (iso) => when(Date.parse(iso || "") || 0);
  const says = (u) => { const w = !u.outcome ? "Working on it…" : (UNSUB_WORDS[u.outcome] || u.outcome); const more = [u.swept ? `${u.swept} more of their promotions trashed` : "", u.kept ? `${u.kept} of their mails kept (orders and the like)` : ""].filter(Boolean); return [w, u.answer, ...more].filter(Boolean).join(" · "); };
  const who = (u) => `<b style="overflow-wrap:anywhere">${esc(u.sender)}</b> · ${esc(ago(u.created_at))}`;
  const needRow = (u) => unsubStill(u)
    ? sRow(who(u), `<button class="st-danger" data-unblock="${esc(u.id)}">Block</button><button class="ghost" data-unanswer="keep" data-unid="${esc(u.id)}">Keep</button>`, esc(`Still mailing after 10 business days: ${u.still_count} since, the last ${ago(u.still_at)}${u.still_subject ? `, "${u.still_subject}"` : ""} · ${says(u)}`))
    : sRow(who(u), `${u.url ? `<button data-unopen="${esc(u.id)}">Open page</button>` : ""}<button class="ghost" data-unanswer="done" data-unid="${esc(u.id)}">Done</button>`, esc(says(u)));
  return sGroup("Needs you", need.length ? need.map(needRow).join("") : sRow("Nothing needs you", "", "A list whose page wants a click, or a sender still mailing 10 business days after you unsubscribed, shows here."))
    + sGroup("Recent", rest.length ? rest.map((u) => sRow(who(u), "", esc(says(u)))).join("") : sRow("No unsubscribes yet"), { hint: "What each list answered when the hub unsubscribed you." });
}
function wireUnsubSection() {
  const byId = (id) => (state.unsubs || []).find((u) => u.id === id);
  $$("[data-unopen]").forEach((b) => b.onclick = () => { const u = byId(b.dataset.unopen); if (u?.url) openExternal(u.url); });
  $$("[data-unanswer]").forEach((b) => b.onclick = async () => { try { await api("/api/unsubscribes/" + b.dataset.unid, { method: "POST", body: JSON.stringify({ answer: b.dataset.unanswer }) }); await loadUnsubs(); openSettings("unsubscribes"); } catch (e) { toast(e.message); } });
  $$("[data-unblock]").forEach((b) => b.onclick = async () => {
    const u = byId(b.dataset.unblock); if (!u) return;
    if (!(await ask(`Block ${u.sender}? Every future mail from them goes straight to Trash in every account, their receipts and order emails too.`, { ok: "Block", danger: true }))) return;
    try { await api("/api/senders", { method: "POST", body: JSON.stringify({ address: u.sender, status: "blocked" }) }); state.rules.push({ pattern: u.sender, action: "block", scope: "*" }); state.rules = [...state.rules]; await loadUnsubs(); openSettings("unsubscribes"); toast("Blocked " + u.sender); } catch (e) { toast(e.message); }
  });
}
function pickTime(title, cb) {
  const now = new Date(); const at = (h, addDays = 0) => { const d = new Date(now); d.setDate(d.getDate() + addDays); d.setHours(h, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d; };
  const opts = [["In 1 hour", new Date(now.getTime() + 3600e3)], ["In 3 hours", new Date(now.getTime() + 3 * 3600e3)], ["This evening", at(18)], ["Tomorrow morning", at(8, 1)], ["Tomorrow afternoon", at(13, 1)], ["Saturday", (() => { const d = at(9); while (d.getDay() !== 6) d.setDate(d.getDate() + 1); return d; })()], ["Next week", (() => { const d = at(8, 1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; })()]];
  const onCancel = () => releaseModal(onCancel); claimModal(onCancel);
  $("#tcard").innerHTML = `<h3>${esc(title)}</h3>` + opts.map(([l, d], i) => `<button data-i="${i}" style="text-align:left">${l} <span class="badge" style="float:right">${d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></button>`).join("") + `<div class="row"><input type="datetime-local" class="f" id="tcustom" style="flex:1"><button id="tok" class="primary">Set</button></div><button id="tcancel" class="ghost">Cancel</button>`;
  $("#tmodal").classList.add("on");
  const done = (d) => { releaseModal(onCancel); if (d) cb(d).catch((e) => toast(e.message)); };
  $$("#tcard button[data-i]").forEach((b) => b.onclick = () => done(opts[b.dataset.i][1]));
  $("#tok").onclick = () => { const v = $("#tcustom").value; if (!v) return; done(new Date(v)); };
  $("#tcancel").onclick = () => done(null);
}

// ---------- thread view ----------
function syncActionBar(t) {
  $("#actions").style.display = "flex"; const lens = trashLens(t), trash = t.state === "trash" || lens;   // opened from Trash on its trashed messages: Trash's bar
  const b = (k) => $(`#actions [data-act="${k}"]`);
  const spam = t.state === "spam"; b("archive").style.display = trash || spam || t.state === "archived" ? "none" : ""; b("trash").style.display = trash ? "none" : ""; b("restore").style.display = t.state === "inbox" && !lens ? "none" : ""; b("restore").innerHTML = ico("inbox") + `<span class="al">${spam ? "Not spam" : "Restore"}</span>`;   // the click turns it into notspam; its data-act never changes, or b("restore") finds nothing next time
  b("snooze").style.display = trash ? "none" : "";
  b("spam").style.display = trash || spam || t.out || !t.fromAddr ? "none" : ""; b("spam").title = t.kind === "gmail" ? "Report spam (Gmail)" : "Spam: trash it and block the sender";
  const lab = (k, text, icon) => { b(k).innerHTML = ico(icon) + `<span class="al">${text}</span>` + hint(k); };
  lab("spam", "Spam", "spam");
  lab("star", t.starred ? "Unpin" : "Pin", "pin"); lab("archive", "Done", "done"); lab("trash", "Trash", "trash"); lab("snooze", "Snooze", "snoozed"); lab("unread", "Unread", "unread"); lab("forward", "Forward", "forward"); lab("replyall", "Reply all", "replyall");
  $("#vacct").textContent = t.kind === "hub" ? (t.identity || "hub") : (accountOf(t.account)?.label || t.account);
}
// ---------- link cleaning ----------
// A clicked link loses its tracking tags before it opens: DuckDuckGo's list (duckduckgo/privacy-configuration,
// features/tracking-parameters.json, Apache-2.0) plus every utm_* tag. Never on a host DuckDuckGo exempts (urldefense signs its links;
// the others broke), and never on a link that unsubscribes, confirms, resets or signs in, where a "tracking" tag can be the token
// (Brave keeps mkt_tok on unsubscribe paths for that reason). Tags are cut from the raw query text, so every other parameter keeps its
// exact encoding and a signed link still verifies. Google's /url and Microsoft SafeLinks wrappers carry the destination in the link
// itself and are unwrapped without being called. Most newsletter links are click-tracker redirects whose destination is sealed in an
// opaque token (SendGrid's upn= on 1,103 of 2,939 links in my mail): those are left alone; following one IS the
// click. A link with nothing to clean opens exactly as written. (remove all tracking)
const TRACKING_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "fb_action_ids", "fb_action_types", "fb_source", "fb_ref", "ga_source", "ga_medium", "ga_term", "ga_content", "ga_campaign", "ga_place", "action_object_map", "action_type_map", "action_ref_map", "gs_l", "mkt_tok", "hmb_campaign", "hmb_source", "hmb_medium"]);
const NO_CLEAN_HOSTS = /(^|\.)(axs\.com|urldefense\.com|centerwellpharmacy\.com|go365\.com|humana\.com)$/i;   // DuckDuckGo's exceptions
const NO_CLEAN_PATH = /unsubscribe|opt-?out|preferences|reset|verify|confirm|log-?in|sign-?in|auth|magic|token/i;
function unwrapLink(u) {
  const inner = (v) => { try { const x = new URL(v); return /^https?:$/.test(x.protocol) ? x : null; } catch (_) { return null; } };
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === "/url") return inner(u.searchParams.get("q") || u.searchParams.get("url") || "");
  if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return inner(u.searchParams.get("url") || "");
  return null;
}
function cleanLink(href) {
  let u; try { u = new URL(href); } catch (_) { return href; }
  let unwrapped = false; for (let i = 0; i < 3; i++) { const x = unwrapLink(u); if (!x) break; u = x; unwrapped = true; }
  if (NO_CLEAN_HOSTS.test(u.hostname) || NO_CLEAN_PATH.test(u.pathname) || !u.search) return unwrapped ? u.href : href;
  const kept = u.search.slice(1).split("&").filter((pair) => { let k = pair.split("=")[0]; try { k = decodeURIComponent(k.replace(/\+/g, " ")); } catch (_) {} return !(/^utm_/i.test(k) || TRACKING_PARAMS.has(k)); });
  if (kept.length === u.search.slice(1).split("&").length) return unwrapped ? u.href : href;
  return u.origin + u.pathname + (kept.length ? "?" + kept.join("&") : "") + u.hash;
}
// ---------- spy trackers (HEY-style) ----------
// An open-tracking pixel tells the sender THAT and WHEN a mail was read. The image proxy already hides where and on what; this stops the
// rest. A tracker is caught before any URL is rewritten, so it is never fetched at all: its image becomes a transparent 1x1 of the same
// size (the layout does not move) and the message says who was trying to track (block all tracking,
// as HEY does). Named vendors come from HEY's own list: DHH's gist 360f4dc7ddbce786f8e82b97cdad9d20, "tracker_blocking.rb",
// 2020, MIT per its author's comment of 2020-07-01: plus six seen in my mail. As in HEY, the generic small-pixel rule runs
// last so a vendor is reported by name. Measured on 151 of the user's recent newsletters: 133 carried a tracker, 80 a named one, and
// no content image was caught. Generic rules:
// width and height both 2 px or less, or a CSS size of 1 px or less, or a hidden image with no real size; spacer names and an image
// repeated 5+ times are exempt from the generic rules only.
const SPY_TRACKERS = [
  ["ActiveCampaign", /lt\.php(.*)?l=open/i], ["AWeber", /openrate\.aweber\.com/i], ["Bananatag", /bl-1\.com/i], ["Boomerang", /mailstat\.us\/tr/i],
  ["Campaign Monitor", /cmail(\d+)\.com\/t\//i], ["Cirrus Insight", /tracking\.cirrusinsight\.com/i], ["Close", /close\.com\/email_opened/i], ["Constant Contact", /rs6\.net\/on\.jsp/i],
  ["ContactMonkey", /contactmonkey\.com\/api\/v1\/tracker/i], ["ConvertKit", /convertkit-mail\.com\/o/i], ["Critical Impact", /portal\.criticalimpact\.com\/c2\//i], ["Emarsys", /emarsys\.com\/e2t\/o\//i],
  ["Gem", /zen\.sr\/o/i], ["Getnotify", /email81\.com\/case/i], ["GetResponse", /getresponse\.com\/open\.html/i], ["GrowthDot", /growthdot\.com\/api\/mail-tracking/i],
  ["FreshMail", /\/o\/(\w){10,}\/(\w){10,}/i], ["Front", /app\.frontapp\.com\/(.*)?\/seen/i], ["Hubspot", /t\.(hubspotemail|hubspotfree|signaux|senal|sidekickopen|sigopn)/i], ["iContact", /click\.icptrack\.com\/icp/i],
  ["Intercom", /via\.intercom\.io\/o/i], ["Intercom", /intercom-mail\.com\/via\/o/i], ["Litmus", /emltrk\.com/i], ["Mailchimp", /list-manage\.com\/track/i],
  ["Mailgun", /email\.(mailgun|mg)(.*)?\/o/i], ["Mailjet", /mjt\.lu\/oo/i], ["Mailspring", /getmailspring\.com\/open/i], ["MailTrack", /mailtrack\.io\/trace/i],
  ["MailTrack", /mltrk\.io\/pixel/i], ["Mandrill", /mandrillapp\.com\/track/i], ["Marketo", /resources\.marketo\.com\/trk/i], ["MixMax", /(email|track)\.mixmax\.com/i],
  ["Mixpanel", /api\.mixpanel\.com\/track/i], ["NetHunt", /nethunt\.co(.*)?\/pixel\.gif/i], ["Newton", /tr\.cloudmagic\.com/i], ["Outreach", /api\/mailings\/opened/i],
  ["phpList", /phplist\.com\/lists\/ut\.php/i], ["Polymail", /polymail\.io/i], ["Postmark", /pstmrk\.it\/open/i], ["Return Path", /returnpath\.net\/pixel\.gif/i],
  ["Sailthru", /sailthru\.com\/trk/i], ["Salesforce", /nova\.collect\.igodigital\.com/i], ["SendGrid", /wf\/open\?upn/i], ["Sendy", /\/sendy\/t\//i],
  ["Streak", /mailfoogae\.appspot\.com/i], ["Superhuman", /r\.superhuman\.com/i], ["Thunderhead", /na5\.thunderhead\.com/i], ["Tinyletter", /tinyletterapp\.com.*?open\.gif/i],
  ["YAMM", /yamm-track\.appspot/i], ["Yesware", /t\.yesware\.com/i], ["Zendesk Sell", /futuresimple\.com\/api\/v1\/sprite\.png/i],
  // seen in my own mail, 2026-10-04 (151 recent newsletters and notifications)
  ["SendGrid", /\/wf\/open/i], ["Klaviyo", /klclick\d*\.com\/o\//i], ["Brevo", /brevo\.net\/tr\/op\//i], ["Amazon SES", /awstrack\.me\/I0\//i], ["Substack", /eotrx\.substackcdn\.com/i], ["Facebook", /facebook\.com\/email_open_log_pic\.php/i],
  ["Texas Instruments", /e2e\.ti\.com\/notification\/read/i],   // TI E2E read receipt (NotificationId=<per-mail id>, a 43-byte GIF), seen in October 2026
];
const PIXEL_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const htmlUnent = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (m0, e) => { if (e[0] !== "#") return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[e.toLowerCase()]; const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m0; });
// The rules run without backtracking: four are `prefix(.*)?suffix`, and on a URL repeating the prefix the regex tried
// every split: ActiveCampaign's lt\.php(.*)?l=open took 1.9 s on one 100 KB URL. `a(.*)?b` (or `a.*?b`) here: `.` stops at a line
// break, and the first `a` on a line reaches every `b` a later one does. Same answers as the regexes (350,000 random inputs).
function spyThen(s, a, b) {
  a.lastIndex = 0; let m;
  while ((m = a.exec(s))) {
    const from = m.index + m[0].length; let end = from; while (end < s.length && !"\n\r\u2028\u2029".includes(s[end])) end++;
    b.lastIndex = 0; if (b.test(s.slice(from, end))) return true;
    a.lastIndex = Math.max(end, m.index + 1);
  }
  return false;
}
const SPY_LINEAR = SPY_TRACKERS.map(([name, rx]) => { const p = rx.source.split(/\(\.\*\)\?|\.\*\?/); return p.length === 2 && !/(^|[^\\])(\\\\)*\\$/.test(p[0]) ? [name, new RegExp(p[0], rx.flags + "g"), new RegExp(p[1], rx.flags)] : [name, rx, null]; });   // (not split after an escaping backslash)
const spyTracker = (url) => { for (const [name, a, b] of SPY_LINEAR) if (b ? spyThen(url, a, b) : a.test(url)) return name; return null; };
// An unquoted value runs to the next HTML whitespace or `>`, as the browser reads it (WHATWG 13.2.5.38, "attribute value (unquoted)
// state": a `=`, quote, `<` or backtick there is a parse error and is kept in the value). Stopping at `=` cut Google's
// `src=https://…?alt=media&amp;token=…` to `…?alt`: the picture was fetched without its token, refused, and shown broken.
const TAG_VAL = /("([^"]*)"|'([^']*)'|([^\t\n\f\r >]+))/.source;
// Where an attribute name may begin: after whitespace, or straight after the closing quote of the attribute before it. HTML allows
// the second (WHATWG 13.2.5.39, "after attribute value (quoted) state": anything but whitespace, / or > is a missing-whitespace-
// between-attributes parse error and is reconsumed as the next attribute's name), and one sender's templates write every <img> that
// way: `border="0"src="https://img.vendor.example/…"alt="Logo"`. Read with \s alone, none of that mail's nine pictures
// was proxied and the frame's CSP refused them all, which showed as empty boxes with the alt text. Each reader
// below, and the two srcset/background literals, consumes this one character and writes it back.
const ATTR_AT = "[\\s\"']";
const tagAttr = (tag, name) => { const m = tag.match(new RegExp(ATTR_AT + name + "\\s*=\\s*" + TAG_VAL, "i")); return m ? htmlUnent(m[2] ?? m[3] ?? m[4] ?? "") : null; };
const SPACER = /spacer|transparent\.gif|blank\.gif|clear\.gif/i;
// HTML's srcset grammar (WHATWG, "parse a srcset attribute"): a candidate's URL is a run of non-whitespace and may itself contain commas
// — Substack's image URLs do (…/fetch/$s_!DIki!,w_131,c_limit,…), and a candidate ends at the comma AFTER its descriptors, or at trailing
// commas on the URL. Splitting on every comma cut those URLs apart, so Substack's images asked the proxy for fragments.
function srcsetCandidates(v) {
  const s = String(v || ""), out = []; let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++; if (i >= s.length) break;
    let j = i; while (j < s.length && !/\s/.test(s[j])) j++;
    const url = s.slice(i, j);
    if (url.endsWith(",")) { let e = url.length; while (e && url[e - 1] === ",") e--; out.push({ url: url.slice(0, e), desc: "" }); i = j; continue; }   // a loop, not /,+$/: a run of commas was quadratic
    let k = j, depth = 0; while (k < s.length && !(s[k] === "," && depth === 0)) { if (s[k] === "(") depth++; else if (s[k] === ")") depth = Math.max(0, depth - 1); k++; }
    out.push({ url, desc: s.slice(j, k).trim() }); i = k + 1;
  }
  return out;
}
// Set by each side: the app answers from the blocks the hub made and synced to it (GET /api/trackers), the hub from
// its maintained lists, its vendored rules and the patterns it learned from arriving mail. (absolute URL, declared box { w, h } or null)
// -> { name, cls } or null, where cls is "ad" or "tracker".
let trackerVerdict = null;
const absImgUrl = (u) => { try { return new URL(/^\/\//.test(u) ? "https:" + u : u).href; } catch (_) { return ""; } };
// Catches every tracker in a mail's HTML, records it in `found` ({ name, host, likely, cls }) and returns the HTML with each one disarmed.
// Linear on any input. Three patterns differ from the old ones: an unclosed `<img` at the end is read to the end (the
// frame's own `</body>` closes it, so the browser draws it; it used to be skipped, and rescanned from every `<img` after it); a size is
// trimmed before it is read (two \s* around an optional "px" tried every split of a run of spaces); a url() stops at the next `url(`,
// which no URL that loads contains, so a run of unclosed ones is read once. A blocked picture that declares a real box (more than 2 px
// each way: an ad) is removed, and so is a link that held nothing else, so no empty box is left where the ad was; a pixel becomes the
// transparent GIF as before, which keeps the layout.
function blockSpyTrackers(h, found) {
  const px = (v) => { const m = /^(\d+(?:\.\d+)?)\s*(px)?$/i.exec(String(v || "").trim()); return m ? parseFloat(m[1]) : null; };
  const seen = new Map(); for (const m of h.matchAll(/<img\b[^>]*>?/gi)) { const s = tagAttr(m[0], "src"); if (s) seen.set(s, (seen.get(s) || 0) + 1); }
  const hostOf = (u) => { try { return new URL(u, "https://x.invalid").hostname; } catch (_) { return ""; } };
  h = h.replace(/<img\b[^>]*>?/gi, (tag) => {
    const url = (tagAttr(tag, "src") || "").trim(); if (!/^(https?:)?\/\//i.test(url)) return tag;
    const w = px(tagAttr(tag, "width")), ht = px(tagAttr(tag, "height")), st = (tagAttr(tag, "style") || "").toLowerCase().replace(/\s+/g, "");
    const css = (p) => { const m = new RegExp("(?:^|;)" + p + ":(\\d+(?:\\.\\d+)?)px").exec(st); return m ? parseFloat(m[1]) : null; };
    const side = (...v) => { v = v.filter((x) => x !== null); return v.length ? Math.min(...v) : null; };
    const sw = side(w, css("width"), css("max-width")), sh = side(ht, css("height"), css("max-height"));
    let name = spyTracker(url), likely = false, cls = "tracker";
    if (!name && trackerVerdict) { const v = trackerVerdict(absImgUrl(url), { w: sw, h: sh }); if (v) { name = v.name; cls = v.cls; } }
    if (!name) {
      const tiny = sw !== null && sh !== null && sw <= 2 && sh <= 2;
      const hidden = /display:none|visibility:hidden|opacity:0(;|!|$)/.test(st) && ((w === null && ht === null) || tiny);
      if ((tiny || hidden) && !SPACER.test(url) && (seen.get(url) || 0) < 5) { likely = true; name = hostOf(url) || "an unknown sender"; }
    }
    if (!name) return tag;
    found.push({ name, host: hostOf(url), likely, cls });
    if (sw !== null && sh !== null && sw > 2 && sh > 2) return `<mh-gone data-mh-tracker="${esc(name)}"></mh-gone>`;
    return tag.replace(new RegExp("(" + ATTR_AT + ")(?:src|srcset)\\s*=\\s*" + TAG_VAL, "gi"), "$1").replace(/^<img\b/i, `<img src="${PIXEL_GIF}" data-mh-tracker="${esc(name)}"`);
  });
  // an ad's own link: an <a> that held nothing but removed pictures and white space
  h = h.replace(/<a\b[^<>]*>(?:\s|&nbsp;|<mh-gone\b[^<>]*><\/mh-gone>)+<\/a>/gi, (m0) => (m0.includes("<mh-gone") ? m0.match(/<mh-gone\b[^<>]*><\/mh-gone>/gi).join("") : m0));
  const named = (u) => { const d = htmlUnent(u); let n = spyTracker(d), cls = "tracker";
    if (!n && trackerVerdict) { const v = trackerVerdict(absImgUrl(d.trim()), null); if (v) { n = v.name; cls = v.cls; } }
    if (n) found.push({ name: n, host: hostOf(d), likely: false, cls }); return n; };
  h = h.replace(/([\s"']srcset\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m0, pre, q, a, b) => { const all = srcsetCandidates(a ?? b), keep = all.filter((c) => !named(c.url));
    return keep.length === all.length ? m0 : pre + '"' + keep.map((c) => (c.url + (c.desc ? " " + c.desc : "")).replace(/"/g, "&quot;")).join(", ") + '"'; });
  h = h.replace(/([\s"']background\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m0, pre, q, a, b) => named(a ?? b) ? pre + `"${PIXEL_GIF}"` : m0);
  h = h.replace(/url\(\s*(['"]?)((?:https?:)?\/\/(?:(?!url\()[^)'"])+)\1\s*\)/gi, (m0, q, u) => named(u) ? `url(${PIXEL_GIF})` : m0);
  return h;
}
// The line a message shows when something was blocked: named vendors by name, a generic pixel by the host it would have called.
function trackerNote(found) {
  if (!found.length) return "";
  const spy = found.filter((f) => f.cls !== "ad"), ads = found.filter((f) => f.cls === "ad"), adFrom = [...new Set(ads.map((f) => f.name))];
  const named = [...new Set(spy.filter((f) => !f.likely).map((f) => f.name))], generic = [...new Set(spy.filter((f) => f.likely).map((f) => f.name))];
  const list = (a) => a.length <= 2 ? a.join(" and ") : `${a.slice(0, 2).join(", ")} and ${a.length - 2} more`;
  const parts = [];
  if (named.length) parts.push(`${named.length > 1 ? "spy trackers" : "a spy tracker"} from ${list(named)}`);
  if (generic.length) parts.push(`${generic.length === 1 ? "a likely spy pixel" : generic.length + " likely spy pixels"}${named.length ? "" : ` from ${list(generic)}`}`);
  if (ads.length) parts.push(`${ads.length === 1 ? "an ad" : ads.length + " ads"} from ${list(adFrom)}`);
  // "…from Mailchimp and Postmark, and an ad from LiveIntent": a comma before the last part when an earlier one already has an "and"
  const head = parts.slice(0, -1).join(", "), text = "Blocked " + (parts.length > 1 ? `${head}${/ and /.test(head) ? "," : ""} and ${parts[parts.length - 1]}` : parts[0]);
  return `<div class="trk" title="It would have told the sender that, and when, you opened this email. Images that do load go through Sherit's proxy, so senders never see your IP address or device.">${ico("block")}<span>${esc(text)}</span></div>`;
}
// The key the hub requires on every /api/img request the app makes (index.js imgSessionKey). The message frame is same-origin and
// its CSP allows img-src 'self', so a mail's OWN relative <img src="/api/img?u=…">, or an svg <image>, a poster, a CSS url(), would
// carry the session cookie and make the hub fetch whatever the sender chose, at the moment the mail is opened, past the tracker
// rules and past the arrival-time fetch. A mail cannot know this key; only proxyImages adds it.
let imgPass = (() => { try { return localStorage.getItem("mh:ik") || ""; } catch (_) { return ""; } })();
function setImgPass(k) {
  if (!k || k === imgPass) return; imgPass = k;
  try { localStorage.setItem("mh:ik", k); } catch (_) {}
  try { prerendered.clear(); } catch (_) {}   // bodies rendered with the old key would ask for images the hub now refuses
}
// The size a picture is asked for: the hub keeps a 1080 px WebP for phones and a 1600 px one for wider screens.
const picW = () => { try { return matchMedia(PHONE_MQ).matches ? 1080 : 1600; } catch (_) { return 1600; } };
// `t`, for a received mail, is the day the hub or Gmail received it: the hub never fetches a picture of recent mail from its sender at an
// open, and keeps doing so for old mail. The day, not the instant, so a logo in every
// day's mail is one entry in the device's cache a day, not one a mail.
const proxied = (url, t) => "/api/img?u=" + encodeURIComponent(url) + (imgPass ? "&k=" + imgPass : "") + "&w=" + picW() + (t > 0 ? "&t=" + Math.floor(t / 864e5) * 864e5 : "");
const keyed = (url) => (url && imgPass ? url + (url.includes("?") ? "&" : "?") + "k=" + imgPass : url);   // an attachment image (cid:) the app wrote
// ---- picture sizes ----
// Founder: a mail loaded in visible steps. The text is written at once and each picture then arrives
// with no box held for it, so the mail grows in steps. Half the pictures in real mail carry a width and no height (48 % of 583 in 116
// mails, against 45 % with both), and the browser holds a box only when it has both (HTML: the pair maps to aspect-ratio). The hub
// measures every picture it keeps (index.js imgSize) and this app syncs the sizes, keyed by urlHash of the URL as /api/img keys it.
// Only the ratio is applied, `aspect-ratio: auto w / h`, which defers to the picture's own ratio once it has loaded (CSS Sizing 4),
// so a missing or wrong size costs a step and never a different-looking mail. Only a picture with a width gets it (applyImgDims): the
// frame's own `img{height:auto}` overrides every height attribute, so a picture without a width takes its natural size,
// which a srcset or an EXIF density can make differ from its pixels; adding any width there could change how it looks.
// Same function as index.js urlHash, character for character (test/imgdims.mjs).
function urlHash(s) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); }
const imgDims = new Map(); let imgDimsSeq = 0, imgDimsDays = {}, imgDimsAt = 0, imgDimsLoaded = null;
// Two weeks of sizes, one list per day the hub measured them, in one record of the local store (~400 pictures a day, ~30 bytes each).
function loadImgDims() {
  return (imgDimsLoaded ||= (async () => { const v = await idb.meta("imgdims").catch(() => null); if (!v || !v.days) return;
    imgDimsSeq = v.seq || 0; imgDimsDays = v.days; for (const rows of Object.values(imgDimsDays)) for (const [k, w, h] of rows) imgDims.set(k, [w, h]); })());
}
async function syncImgDims({ force = false } = {}) {
  if (syncImgDims.busy || (!force && Date.now() - imgDimsAt < 60_000)) return;   // at most once a minute: refresh runs every 60 s and on each push
  syncImgDims.busy = true; imgDimsAt = Date.now();
  try {
    await loadImgDims(); let changed = false;
    for (let i = 0; i < 5; i++) {
      const j = await api("/api/imgdims?since=" + imgDimsSeq); if (!j || !j.days) break;
      for (const [day, rows] of Object.entries(j.days)) { (imgDimsDays[day] ||= []).push(...rows); for (const [k, w, h] of rows) imgDims.set(k, [w, h]); changed = true; }
      imgDimsSeq = j.seq || imgDimsSeq; if (!j.more) break;
    }
    const cut = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(imgDimsDays)) if (day < cut) { for (const [k] of imgDimsDays[day]) imgDims.delete(k); delete imgDimsDays[day]; changed = true; }
    if (changed) await idb.meta("imgdims", { seq: imgDimsSeq, days: imgDimsDays });
  } catch (_) {} finally { syncImgDims.busy = false; }
}
// ---- the pictures the hub blocked beyond the named list ----
// The hub decides when a mail arrives (two maintained lists, two vendored rules, the patterns it learned from this mailbox) and keeps
// each blocked picture's URL hash. The app syncs them as it syncs picture sizes and hides the same pictures by a lookup in memory, so
// opening a mail asks nothing more of the network. Two weeks are kept, one list per day; a withdrawn block (an Undo in Settings, or a
// learned pattern that turned itself off) arrives as `gone`. Until a block is in, /api/img itself still refuses the picture.
const trkMap = new Map(); let trkSeq = 0, trkDays = {}, trkAt = 0, trkLoaded = null;
function loadTrackers() {
  return (trkLoaded ||= (async () => { const v = await idb.meta("trackers").catch(() => null); if (!v || !v.days) return;
    trkSeq = v.seq || 0; trkDays = v.days; for (const rows of Object.values(trkDays)) for (const [k, n, c] of rows) trkMap.set(k, [n, c]); })());
}
async function syncTrackers({ force = false } = {}) {
  if (syncTrackers.busy || (!force && Date.now() - trkAt < 60_000)) return;
  syncTrackers.busy = true; trkAt = Date.now();
  try {
    await loadTrackers(); let changed = false; const seq0 = trkSeq, day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) {
      const j = await api("/api/trackers?since=" + trkSeq); if (!j || !Array.isArray(j.rows)) break;
      for (const [k, n, c, gone] of j.rows) {
        if (gone) { if (trkMap.delete(k)) { changed = true; for (const d of Object.keys(trkDays)) trkDays[d] = trkDays[d].filter((r) => r[0] !== k); } }
        else if (!trkMap.has(k)) { trkMap.set(k, [n, c]); (trkDays[day] ||= []).push([k, n, c]); changed = true; }
      }
      trkSeq = j.seq || trkSeq; if (!j.more) break;
    }
    const cut = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(trkDays)) if (d < cut) { for (const [k] of trkDays[d]) trkMap.delete(k); delete trkDays[d]; changed = true; }
    if (changed || trkSeq !== seq0) await idb.meta("trackers", { seq: trkSeq, days: trkDays });
    if (changed) { try { prerendered.clear(); } catch (_) {} }   // a body rendered before a block arrived still shows that picture
  } catch (_) {} finally { syncTrackers.busy = false; }
}
trackerVerdict = (u) => { const v = u && trkMap.get(urlHash(u)); return v ? { name: v[0], cls: v[1] } : null; };
// Run on a body just written into its frame, before the first fit and so before the first paint.
function applyImgDims(d) {
  if (!imgDims.size) return 0; let n = 0;
  const int = (im, a) => /^\s*\d/.test(im.getAttribute(a) || "");
  for (const im of d.images) {
    if (int(im, "width") && int(im, "height")) continue;   // the browser already holds this box
    // No width, from the attribute or the inline style: nothing for the ratio to hang on. Before the picture is in, Chromium draws such a
    // box 0 px wide and WebKit stretches it to the column with the ratio, then shrinks it (test/imgdims.py): left as before.
    if (!int(im, "width") && !im.style.width) continue;
    const s = im.getAttribute("src") || ""; if (!s.startsWith("/api/img?")) continue;
    let k; try { k = urlHash(new URL(new URLSearchParams(s.slice(9)).get("u")).href); } catch (_) { continue; }
    const v = imgDims.get(k); if (!v || !(v[0] > 0 && v[1] > 0)) continue;
    im.style.setProperty("aspect-ratio", `auto ${v[0]} / ${v[1]}`); n++;
  }
  return n;
}
// The frame may load images only from the hub's three image routes: a CSS url() or svg <image> in a mail cannot reach any other hub
// address with the session cookie. Path-scoped sources are CSP Level 2 (verified in a real WKWebView: /api/img and
// /api/att/ loaded, a CSS url() and an svg <image> aimed at /api/stats were refused); the key (imgPass) is the second lock on the
// same door. The frame also sets x-dns-prefetch-control off, as a spare: in that WKWebView it changed nothing measurable (plain
// links were not pre-resolved even when the mail turned prefetching on) and a <link rel="dns-prefetch"> ignored it, which is why
// proxyImages makes every <link> inert.
const frameImgSrc = () => ["/api/img", "/api/att/", "/api/gmail/att/"].map((p) => location.origin + p).join(" ");
// Every link in a mail is rewritten to where it really goes, and says so. The href becomes cleanLink's URL (tracking
// parameters off, Google and Outlook redirects unwrapped) which is what the tap handler did on Android and Windows and the Mac never
// saw: WebKit runs no page listener inside the scriptless frame, so there the shell opened the href as written. The title is that URL,
// so hovering shows where a link leads: the native tooltip, which nothing in the mail can clip or restyle (HTML: a title on a link is
// "the title or a description of the target resource").
// A mail's own title on a link goes: it is what the sender wanted shown, not where the link goes.
// A link in a mail leaves the mail, never navigates it: every <a> and <area> loses its `target` (the frame's <base
// target="_blank"> then applies, and a native shell hands the new window to the browser), and an href with any scheme but http(s) or
// mailto is dropped (a relative one, which resolves to the hub, stays). `target="_self"` with `intent:…` started any activity on the phone (Android), and with a web address
// loaded the page inside the message (Mac, Android); `<meta http-equiv="refresh">` navigated the frame with no click at all.
// The rule is enforced on the tags as the browser's tokenizer reads them: a `>` inside a quoted value
// no longer ends the tag (`<a title=">" href="intent:…" target="_self">` hid both the href and the target), and a value is decoded
// with every character reference that can spell a scheme (`javascript&colon;`, `&#106avascript:` without its semicolon,
// `jav&Tab;ascript:`) before the URL parser names its scheme. Comments and the raw-text elements (<style>, <script>, <textarea>,
// <title>…) are stepped over as the tokenizer steps over them, so their text is never read as tags. One pass, nothing rescanned.
// No element of a mail keeps a `title` or an `xlink:title` (F3): on the Mac, which has no status bar, the tooltip is the only sign of
// where a link goes and the innermost title wins, so <a href="https://evil.example/login"><span title="https://www.paypal.com/…">
// showed PayPal's address over a link to evil.example. cleanMailDom, run on the frame's own document the moment it is written, does
// it all again on the parsed tree (which also covers what a string cannot know, such as a <style> inside <svg>, whose text IS
// markup) and gives each web link its destination as href and title.
const linkOk = (v, webOnly = false) => { let u; try { u = new URL(v, "https://x.invalid/"); } catch (_) { return false; } return u.protocol === "https:" || u.protocol === "http:" || (!webOnly && u.protocol === "mailto:"); };
// An attribute value as the browser decodes it, as far as a scheme or a keyword can depend on it: every numeric reference (with or
// without `;`, 0x80-0x9F through windows-1252, 0 / surrogates / past U+10FFFF as U+FFFD), and the named references that spell ASCII.
// A named one not listed here spells something else, which cannot make a scheme. In an attribute a legacy name without `;` before a
// letter, digit or `=` stays as written, as in the browser.
const ENT_ASCII = { Tab: "\t", NewLine: "\n", excl: "!", quot: '"', QUOT: '"', num: "#", dollar: "$", percnt: "%", amp: "&", AMP: "&", apos: "'", lpar: "(", rpar: ")", ast: "*", midast: "*", plus: "+", comma: ",", period: ".", sol: "/", colon: ":", semi: ";", lt: "<", LT: "<", equals: "=", gt: ">", GT: ">", quest: "?", commat: "@", lsqb: "[", lbrack: "[", bsol: "\\", rsqb: "]", rbrack: "]", Hat: "^", lowbar: "_", UnderBar: "_", grave: "`", DiacriticalGrave: "`", lcub: "{", lbrace: "{", verbar: "|", vert: "|", VerticalLine: "|", rcub: "}", rbrace: "}", nbsp: " ", NonBreakingSpace: " " };
const ENT_LEGACY = new Set(["amp", "AMP", "quot", "QUOT", "lt", "LT", "gt", "GT", "nbsp"]);
const WIN1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
function attrUnent(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (m0, hx, dec, nm, semi, off, all) => {
    if (nm !== undefined) { if (semi) return ENT_ASCII[nm] ?? m0; if (!ENT_LEGACY.has(nm) || /[A-Za-z0-9=]/.test(all[off + m0.length] || "")) return m0; return ENT_ASCII[nm]; }
    let cp = hx !== undefined ? parseInt(hx, 16) : parseInt(dec, 10);
    if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd; else if (cp >= 0x80 && cp <= 0x9f) cp = WIN1252[cp - 0x80];
    return String.fromCodePoint(cp);
  });
}
// The tag that starts at h[i] === "<", read as the tokenizer reads it: its lower-case name, its attributes ({ name, start, end, vs, ve }:
// the attribute's span and its value's) and where it ends: after its `>`, or at the end of the text when it has none (`open`; the
// frame's own </body> then closes it, so it is still a tag).
const HTML_WS = "\t\n\f\r ";
function readTag(h, i) {
  const n = h.length, attrs = []; let j = i + 1; if (h[j] === "/") j++;
  const ns = j; while (j < n && !HTML_WS.includes(h[j]) && h[j] !== "/" && h[j] !== ">") j++;
  const name = h.slice(ns, j).toLowerCase();
  for (;;) {
    while (j < n && (HTML_WS.includes(h[j]) || h[j] === "/")) { if (h[j] === "/" && h[j + 1] === ">") return { name, attrs, end: j + 2, selfClose: true }; j++; }
    if (j >= n) return { name, attrs, end: n, open: true };
    if (h[j] === ">") return { name, attrs, end: j + 1 };
    const as = j++; while (j < n && !HTML_WS.includes(h[j]) && h[j] !== "/" && h[j] !== ">" && h[j] !== "=") j++;   // a first `=` is part of the name
    const at = { name: h.slice(as, j).toLowerCase(), start: as, end: j, vs: -1, ve: -1 }; attrs.push(at);
    let k = j; while (k < n && HTML_WS.includes(h[k])) k++;
    if (h[k] !== "=") continue;   // no value: the next attribute, a `/` or the `>` follows
    k++; while (k < n && HTML_WS.includes(h[k])) k++;
    if (h[k] === '"' || h[k] === "'") { const c = h.indexOf(h[k], k + 1); at.vs = k + 1; if (c < 0) { at.ve = at.end = n; return { name, attrs, end: n, open: true }; } at.ve = c; at.end = j = c + 1; }
    else { at.vs = k; while (k < n && !HTML_WS.includes(h[k]) && h[k] !== ">") k++; at.ve = at.end = j = k; }
  }
}
const RAW_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "textarea", "title"]), RAW_END = {};
const COMMENT_END = /--!?>/g, ASCII_ALPHA = /[A-Za-z]/;
function cleanMailTags(h) {
  h = String(h); const n = h.length, edits = []; let i = 0, foreign = 0;
  const val = (a) => a.vs < 0 ? "" : attrUnent(h.slice(a.vs, a.ve));
  const skipTo = (from) => { const g = h.indexOf(">", from); return g < 0 ? n : g + 1; };
  while (i < n) {
    const lt = h.indexOf("<", i); if (lt < 0) break;
    const c = h[lt + 1] || "";
    if (ASCII_ALPHA.test(c)) {
      const t = readTag(h, lt); i = t.end;
      if (t.name === "meta" && t.attrs.some((a) => a.name === "http-equiv" && /^\s*refresh\s*$/i.test(val(a)))) { edits.push([lt, t.end]); continue; }
      const link = t.name === "a" || t.name === "area", base = t.name === "base";
      for (const a of t.attrs) {
        if (a.name === "title" || a.name === "xlink:title" || ((link || base) && a.name === "target")) edits.push([a.start, a.end]);
        else if ((link || base) && (a.name === "href" || a.name === "xlink:href") && !linkOk(val(a), base)) edits.push([a.start, a.end]);
      }
      if ((t.name === "svg" || t.name === "math") && !t.selfClose) foreign++;
      else if (foreign && t.name === "title" && !t.selfClose && !t.open) {   // an SVG <title> is its parent's tooltip: it goes, text and all
        const re = RAW_END.title ||= new RegExp("</title[\\t\\n\\f\\r />]", "gi"); re.lastIndex = i; const m = re.exec(h);
        while (edits.length && edits[edits.length - 1][0] >= lt) edits.pop();   // its own attribute edits go with it
        if (m) { const e = readTag(h, m.index); edits.push([lt, e.end]); i = e.end; } else edits.push([lt, t.end]);
      }
      else if (!foreign && !t.open && RAW_TEXT.has(t.name)) { const re = RAW_END[t.name] ||= new RegExp("</" + t.name + "[\\t\\n\\f\\r />]", "gi"); re.lastIndex = i; const m = re.exec(h); i = m ? m.index : n; }
      continue;
    }
    if (c === "/") {
      if (ASCII_ALPHA.test(h[lt + 2] || "")) { const t = readTag(h, lt); if ((t.name === "svg" || t.name === "math") && foreign) foreign--; i = t.end; }
      else i = h[lt + 2] === ">" ? lt + 3 : skipTo(lt + 2);   // `</>` is nothing; any other `</` opens a bogus comment
      continue;
    }
    if (c === "!" && h.startsWith("<!--", lt)) {
      if (h[lt + 4] === ">") i = lt + 5; else if (h[lt + 4] === "-" && h[lt + 5] === ">") i = lt + 6;
      else { COMMENT_END.lastIndex = lt + 4; const m = COMMENT_END.exec(h); i = m ? m.index + m[0].length : n; }
      continue;
    }
    if (c === "!" || c === "?") { i = skipTo(lt + 2); continue; }   // a doctype, CDATA outside SVG, a processing instruction: up to the next `>`
    i = lt + 1;   // a `<` that starts nothing is text
  }
  if (!edits.length) return h;
  const out = []; let at = 0; for (const [a, b] of edits) { out.push(h.slice(at, a)); at = b; } out.push(h.slice(at)); return out.join("");
}
// The frame's document, as parsed, held to the same rule, and every web link labelled with where it goes. Runs inside writeFrame, after
// the parse and before anything can be hovered or clicked; idempotent. A relative href that resolves off the hub (`//evil.example/x`,
// or through the mail's own <base href>) is labelled like a full one; one that stays on the hub is left as it is.
const XLINK_NS = "http://www.w3.org/1999/xlink", SVG_NS = "http://www.w3.org/2000/svg", MATH_NS = "http://www.w3.org/1998/Math/MathML";
function cleanMailDom(d) {
  const b = d.body; if (!b) return;
  const dropAttrs = (el, local) => { for (const x of [...el.attributes]) if (x.localName === local) el.removeAttributeNode(x); };
  for (const m of [...d.querySelectorAll("meta")]) if (/^\s*refresh\s*$/i.test(m.getAttribute("http-equiv") || "")) m.remove();
  for (const x of b.querySelectorAll("base")) { x.removeAttribute("target"); for (const a of [...x.attributes]) if (a.localName === "href" && !linkOk(a.value, true)) x.removeAttributeNode(a); }
  for (const t of [...b.getElementsByTagNameNS(SVG_NS, "title")]) t.remove();   // an SVG element's tooltip is its <title> child
  for (const el of b.querySelectorAll("[title], [*|title]")) dropAttrs(el, "title");
  for (const el of [...b.getElementsByTagNameNS(MATH_NS, "*")]) dropAttrs(el, "href");   // WebKit follows a MathML href, in the frame itself
  for (const a of b.querySelectorAll("a, area")) {
    a.removeAttribute("target");
    for (const x of [...a.attributes]) if (x.localName === "href" && !linkOk(x.value)) a.removeAttributeNode(x);
    const hv = a.getAttribute("href") ?? a.getAttributeNS(XLINK_NS, "href"); if (hv == null) continue;
    let go = null;
    if (/^\s*https?:\/\//i.test(hv)) go = cleanLink(hv.trim());
    else { try { const u = new URL(hv, d.baseURI); if ((u.protocol === "https:" || u.protocol === "http:") && u.origin !== location.origin) go = cleanLink(u.href); } catch (_) {} }
    if (!go) continue;
    if (a.hasAttribute("href") && a.getAttribute("href") !== go) a.setAttribute("href", go);
    a.setAttribute("title", go);
    if (a.namespaceURI === SVG_NS) { const t = d.createElementNS(SVG_NS, "title"); t.textContent = go; a.insertBefore(t, a.firstChild); }
  }
}
// Each <style>…</style> in a mail, in one pass: what /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi matched, without rescanning the rest of
// the mail from every <style> that has no `>` or no `</style>` after it (no later one can have them either, so the search ends there).
function styleSpans(h) {
  const out = [], OPEN = /<style\b[^>]*(>|$)/gi, CLOSE = /<\/style\s*>/gi; let m;
  while ((m = OPEN.exec(h))) { if (!m[1]) break; CLOSE.lastIndex = OPEN.lastIndex; const c = CLOSE.exec(h); if (!c) break; out.push([m.index, OPEN.lastIndex, c.index, CLOSE.lastIndex]); OPEN.lastIndex = CLOSE.lastIndex; }
  return out;
}
const mapStyles = (h, fn) => { const sp = styleSpans(h); if (!sp.length) return h; const out = []; let at = 0; for (const [, b, c] of sp) { out.push(h.slice(at, b), fn(h.slice(b, c))); at = c; } out.push(h.slice(at)); return out.join(""); };
function proxyImages(h, atts, found = [], t = 0) {
  // Every <link> in a mail is made inert. WebKit (the Mac app's engine) honours a mail's <link rel="preconnect"> and
  // <link rel="dns-prefetch"> even under the frame's CSP: measured in October 2026 in a real WKWebView, preconnect opened a TCP connection
  // straight to the sender (their server sees my IP the moment the mail is opened) and dns-prefetch looked the sender's
  // hostname up; neither goes through /api/img, so no tracker rule ever saw them. A mail body has no use for <link> (stylesheets are
  // refused by the CSP anyway), and renaming the tag where the HTML tokenizer would start it leaves nothing for the parser to obey.
  h = h.replace(/<link(?=[\s/>])/gi, "<mh-link");
  h = blockSpyTrackers(h, found);
  const cid = (id) => { const a = (atts || []).find((x) => x.cid && x.cid.replace(/^<|>$/g, "") === id.replace(/^<|>$/g, "")); return a ? a.url || "" : ""; };
  // The value is read out of the HTML source, so it is still entity-encoded: `?width=100&amp;height=100` is what the sender wrote and
  // `?width=100&height=100` is the URL a browser would fetch. Encoding it raw sent the literal `amp;height` upstream, and Venmo's image
  // resizer answers that with a 502: the broken avatar on "You paid JORDAN LEE $20.00". Only the proxied URL is decoded:
  // a value that is written back as-is (data:, relative) keeps its entities, so a decoded quote can never close the attribute.
  const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (m0, e) => { if (e[0] !== "#") return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[e.toLowerCase()]; const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m0; });
  const px = (u) => { u = u.trim(); if (!u) return u; const d = unent(u); if (/^cid:/i.test(d)) return keyed(cid(d.slice(4))) || ""; if (/^data:/i.test(u)) return u.replace(/"/g, "&quot;"); if (/^https?:\/\//i.test(d)) return proxied(d, t); if (/^\/\//.test(d)) return proxied("https:" + d, t); return ""; };
  // (a relative image reference is dropped: a mail has no base URL of its own, so one can only resolve against the app's origin)
  // Attribute values may be quoted or bare (`src=https://…` is legal HTML and Google's account notices use it); a bare value runs to the
  // next whitespace or `>`; the name may follow the quote that closed the attribute before it (ATTR_AT). Anything left unrewritten is
  // blocked by the frame's CSP, which is what "missing pictures" looked like. (A data: value from single quotes may hold a `"`; it is
  // written back between double quotes, so the quote is spelled &quot; and cannot end the attribute early.) The search for the name
  // stops at the next `<` as well as the next `>` (F1): `[^>]*?` from every one of a run of unclosed `<img ` rescanned the
  // whole run, 823 ms for 40 KB of them.
  const VAL = TAG_VAL;
  const attr = (name, fn, tags = "img|td|th|table|body|div") => { h = h.replace(new RegExp("(<(?:" + tags + ")\\b[^<>]*?" + ATTR_AT + name + "\\s*=\\s*)" + VAL, "gi"), (m0, pre, q, a, b, c) => pre + '"' + fn(a !== undefined ? a : b !== undefined ? b : c) + '"'); };
  attr("src", (v) => px(v));
  attr("background", (v) => px(v));
  // Images below the fold load when scrolled to, so the text shows at once; the first two (a header, the hero) are asked for first,
  //  where every picture had been lazy.
  let nth = 0;
  h = h.replace(/<img\b(?![^<>]*\bloading=)/gi, () => (nth++ < 2 ? '<img loading="eager" fetchpriority="high" decoding="async"' : '<img loading="lazy" decoding="async"'));
  // <source srcset> too: inside <picture> the browser picks the source, and a source the CSP refuses is a broken image; it does not
  // fall back to the <img>.
  attr("srcset", (v) => srcsetCandidates(v).map((c) => px(c.url) + (c.desc ? " " + c.desc : "")).join(", ").replace(/"/g, "&quot;"), "img|source|td|th|table|body|div");
  // CSS url(): written unquoted with  ' escaped, because the old url("…") ended a style="…" attribute at its first quote and lost
  // the image and every declaration after it. Entities are decoded in an attribute (the HTML parser decodes them there, so
  // `&amp;` means `&`, the Venmo failure) but not in a <style> element, whose text the parser leaves as written.
  const cssUrl = (u, decode) => { const d = decode ? unent(u.trim()) : u.trim(); return "url(" + proxied(/^\/\//.test(d) ? "https:" + d : d, t).replace(/[()']/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase()) + ")"; };
  // (A URL stops at the next `url(`, as in blockSpyTrackers: a run of unclosed `url(//` was otherwise read from each one to its end.)
  const CSS_URL = /url\(\s*(['"]?)((?:https?:)?\/\/(?:(?!url\()[^)'"])+)\1\s*\)/gi;
  h = mapStyles(h, (css) => css.replace(CSS_URL, (m1, q, u) => cssUrl(u, false)));
  h = h.replace(CSS_URL, (m0, q, u) => cssUrl(u, true));
  // (no second pass over background=: attr("background") above already covers td, th, table, body and div, and running px over the
  // proxied value again now drops it as a relative URL)
  return h;
}
function renderFeed(rows, el) {
  const frag = document.createDocumentFragment(); const page = rows.slice(0, 30);
  for (const t of page) {
    const card = document.createElement("div"); card.className = "feed"; card.dataset.key = t.key;
    const who = rowPeer(t);
    card.innerHTML = `<div class="fh"><div class="av" style="background:${colorFor(who.key)}">${esc(who.initial.toUpperCase())}</div><div style="min-width:0;flex:1"><div class="who"><span style="overflow:hidden;text-overflow:ellipsis">${esc(who.label)}</span><span class="when">${when(t.date)}</span></div><div class="sub" style="font-weight:600">${esc(shownSubject(t))}</div></div><button data-fa="archive" title="Done (${esc(keyFor("archive"))})">Done</button>${t.unsub ? `<button data-fa="unsubscribe" class="ghost" title="Unsubscribe">Unsub</button>` : ""}<button data-fa="open" class="ghost" title="Open">Open</button></div><div class="fb"><div class="empty" style="padding:12px">Loading…</div></div>`;
    card.querySelectorAll("[data-fa]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const a = b.dataset.fa; if (a === "open") return openThread(t.key); if (a === "archive") { act(t, "archive"); card.remove(); return; } act(t, a); });
    frag.appendChild(card);
  }
  el.appendChild(frag); if (rows.length > page.length) { const more = document.createElement("div"); more.className = "empty"; more.textContent = `${rows.length - page.length} more — mark some as Done to see them`; el.appendChild(more); }
  const io = new IntersectionObserver((entries) => { for (const en of entries) { if (!en.isIntersecting) continue; io.unobserve(en.target); feedFill(en.target); } }, { root: el, rootMargin: "600px 0px" });
  el.querySelectorAll(".feed").forEach((c) => io.observe(c));
  scheduleIdle(() => prefetchBodies(page.slice(0, 8)));
}
async function feedFill(card) {
  const t = state.threads.get(card.dataset.key); if (!t) return; const fb = card.querySelector(".fb");
  try {
    let d = prerendered.get(t.key)?.d || await cachedThread(t); if (!d) { d = await adapterFor(t.account).thread(t.id); cacheThread(t, d); }
    const m = [...d.messages].reverse().find((x) => !x.out) || d.messages[d.messages.length - 1]; if (!m) return;
    fb.querySelectorAll("iframe").forEach((f) => { try { f._ro?.disconnect(); f._mo?.disconnect(); } catch (_) {} }); const docs = []; fb.innerHTML = messageHtml(m, 0, 1, docs, { noHead: true });
    mountBodies(fb, docs); fb.querySelectorAll(".qtog").forEach((b) => b.onclick = (e) => { e.stopPropagation(); toggleQuote(b, docs); }); wireTextLinks(fb);
    if (t.unread) { t.unread = false; localAct(t, "read", { quiet: true }); }
  } catch (e) { fb.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
// What an older, collapsed message says, in one line: its own words, not the conversation it quotes beneath them. Replies carry
// the whole thread quoted, so the preview stops at the first quote marker (a "> " line, "On … wrote:", an Outlook header block).
// The HTML is read with linear patterns only (F1): this runs for every collapsed message the prerender builds, before
// anything is opened. dropBlocks replaces /<(style|script|head)\b[\s\S]*?<\/\1>/gi, and a tag still open at the end of the mail is
// dropped to the end (`<[^>]+>` rescanned that tail from each `<` in it).
function dropBlocks(h, rep = " ") {
  const OPEN = /<(style|script|head)\b/gi, dead = new Set(), out = []; let at = 0, m;
  while ((m = OPEN.exec(h))) {
    const nm = m[1].toLowerCase(); if (dead.has(nm)) continue;
    const CLOSE = new RegExp("<\\/" + nm + ">", "gi"); CLOSE.lastIndex = OPEN.lastIndex; const c = CLOSE.exec(h);
    if (!c) { dead.add(nm); continue; }   // no close after this one: none after any later one either
    out.push(h.slice(at, m.index), rep); at = OPEN.lastIndex = c.index + c[0].length;
  }
  out.push(h.slice(at)); return out.join("");
}
const htmlAsText = (h) => dropBlocks(String(h)).replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+(?:>|$)/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
function messagePreview(m) {
  let t = m.text || "";
  if (!t.trim() && m.html) t = dropBlocks(String(m.html)).replace(/<blockquote\b[\s\S]*$/i, " ").replace(/<div class="gmail_quote[\s\S]*$/i, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+(?:>|$)/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const own = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (/^>/.test(l) || /^On .{4,200} wrote:?$/i.test(l) || /wrote:\s*$/i.test(l) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(l) || /^From:\s.+/i.test(l) && own.length) break;
    if (l) own.push(l);
  }
  return own.join(" ").replace(/\s+/g, " ").slice(0, 160);
}
// Quoted history folds behind "•••", as Gmail ("Show trimmed content") and Apple Mail ("See More") do: a plain-text
// Outlook reply showed the user's whole original, his signature and the sender's disclaimer as if the sender had written them. The
// body is cut at the first quote marker with the sender's own words above it; the rest is one tap away and reply quoting (plainOf)
// keeps the full text. Never folded: a forward (the quoted mail IS the message), a message with nothing of its own above the marker,
// and a quote with text after it, which is an inline answer. Outlook's own markers fold unconditionally: Outlook top-posts.
const FWD_SUBJECT = /^\s*fwd?\s*:/i;
function quoteSplitText(text) {
  const lines = String(text || "").split("\n"), L = (j) => (lines[j] ?? "").trim();
  // Whether every non-empty line from j on is quoted, and one is: read off two tables built from the end, because a loop from each
  // ">" line to the end of the mail was quadratic in its lines (F1: a body of 100,000 "> " lines).
  const nonQ = new Uint8Array(lines.length + 2), anyQ = new Uint8Array(lines.length + 2);
  for (let j = lines.length - 1; j >= 0; j--) { const l = L(j); nonQ[j] = nonQ[j + 1] || (l && !l.startsWith(">") ? 1 : 0); anyQ[j] = anyQ[j + 1] || (l.startsWith(">") ? 1 : 0); }
  const onlyQuoted = (j) => j < lines.length && !nonQ[j] && !!anyQ[j];
  const attrAt = (i) => /^On\s.{4,300}wrote:$/i.test(L(i)) ? 1 : /^On\s/i.test(L(i)) && /^On\s.{4,300}wrote:$/i.test(L(i) + " " + L(i + 1)) ? 2 : 0;
  let own = false, off = 0, skip = 0;   // an "On … wrote:" line is not the sender's own text, folded or not
  for (let i = 0; i < lines.length; off += lines[i].length + 1, i++) {
    const l = L(i), attr = attrAt(i);
    if (own) {
      if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(l)) return off;
      if (/^From:\s*\S/i.test(l)) {
        const next = lines.slice(i + 1, i + 6).map((x) => x.trim());
        if (next.some((x) => /^(Sent|Date):\s/i.test(x)) && next.some((x) => /^(To|Subject):\s/i.test(x))) {
          let j = i - 1; while (j >= 0 && !L(j)) j--;   // Outlook's "_____" divider above the block goes with it
          if (j >= 0 && /^_{8,}$/.test(L(j))) { let o = 0; for (let k = 0; k < j; k++) o += lines[k].length + 1; return o; }
          return off;
        }
      }
      if (attr && onlyQuoted(i + attr)) return off;
      if (l.startsWith(">") && onlyQuoted(i)) return off;
    }
    if (attr) skip = attr;
    if (skip) { skip--; continue; }
    if (l && !l.startsWith(">")) own = true;
  }
  return -1;
}
const QUOTE_SEL = ".gmail_quote, blockquote[type=cite], .moz-cite-prefix, .protonmail_quote, .yahoo_quoted, #divRplyFwdMsg";
const QUOTE_HINT = /gmail_quote|type=["']?cite|moz-cite-prefix|protonmail_quote|yahoo_quoted|divRplyFwdMsg/i;
const OUTLOOK_HDR = /^\s*From:[\s\S]{0,400}?(Sent|Date):[\s\S]{0,600}?Subject:/i;   // no \b: a <br> between lines adds no space to textContent ("BSubject:")
// The first n characters of an element's text after its leading whitespace, all OUTLOOK_HDR can read (5 + 400 + 5 + 600 + 8), without
// building the whole of its textContent, which for nested bordered divs was the whole mail once per div.
function textHead(el, n) {
  const w = el.ownerDocument.createTreeWalker(el, 4); let s = "", lead = true, t, seen = 0;
  while ((t = w.nextNode()) && ++seen < 5000) { let v = t.data; if (lead) { v = v.replace(/^\s+/, ""); if (!v) continue; lead = false; } s += v; if (s.length >= n) break; }
  return s.slice(0, n);
}
// /From:[\s\S]{0,400}?(Sent|Date):/i without trying 400 characters after every "From:": the nearest "Sent:" or "Date:" after each one.
function fromNearSent(h) {
  const F = /From:/gi, S = /Sent:|Date:/gi; let m, sm = null;
  while ((m = F.exec(h))) { const e = m.index + 5; if (!sm || sm.index < e) { S.lastIndex = e; sm = S.exec(h); if (!sm) return false; } if (sm.index - e <= 400) return true; }
  return false;
}
// How deep the HTML parser's stack of open elements gets for this mail, estimated in one pass, stopping once past `limit`. The parser
// walks that stack for most start tags (is a <p> open, in scope?), so a mail of 200,000 nested <div>s parses in quadratic time: 359 ms
// for 100 KB and 1.4 s for 200 KB in Chromium's DOMParser, and the frame's own parse is the same parser (F1). Chromium
// stops building the tree past 512 levels anyway. The estimate follows the parser where depth comes from: void elements never open,
// a block closes an open <p>, a <p>/<li>/<dd>/<dt>/<option> closes the one before it and a cell, row or row group the one before it in
// the same table, and an end tag closes back to its element unless a table, a cell or another scope edge is in between.
const VOID_TAGS = new Set("area base br col embed hr img input link meta param source track wbr keygen basefont bgsound frame image mh-link".split(" "));
const SCOPE_EDGE = new Set("applet caption table td th marquee object template svg math".split(" "));
const CLOSES_P = new Set("address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol p section summary ul h1 h2 h3 h4 h5 h6 pre listing form table hr xmp".split(" "));
const PAIR_ANY = new Set("p li dd dt option optgroup rp rt".split(" ")), PAIR_TABLE = new Set("td tr tbody".split(" "));
function htmlDepth(h, limit = 512) {
  // A tag runs to its `>` (`<a <a <a` is one tag with odd attributes, as in the browser); comments and raw text are stepped over.
  const TAG = /<!--|<(\/?)([A-Za-z][^\s/>]*)[^>]*>?/g, stack = [], at = new Map(), edges = [], tables = []; let m;
  const top = (a) => a.length ? a[a.length - 1] : -1, lastOf = (nm) => top(at.get(nm) || []);
  const popTo = (i) => { while (stack.length > i) { const x = stack.pop(); at.get(x).pop(); if (SCOPE_EDGE.has(x)) edges.pop(); if (x === "table") tables.pop(); } };
  while ((m = TAG.exec(h))) {
    if (m[0] === "<!--") { const e = h.indexOf("-->", TAG.lastIndex); if (e < 0) break; TAG.lastIndex = e + 3; continue; }
    let nm = m[2].toLowerCase(); if (nm === "th") nm = "td"; else if (nm === "thead" || nm === "tfoot") nm = "tbody";
    if (VOID_TAGS.has(nm)) continue;
    const i = lastOf(nm), edge = PAIR_TABLE.has(nm) ? top(tables) : top(edges);
    if (m[1]) { if (i >= 0 && i >= edge) popTo(i); continue; }
    if (RAW_TEXT.has(nm)) { const re = RAW_END[nm] ||= new RegExp("</" + nm + "[\\t\\n\\f\\r />]", "gi"); re.lastIndex = TAG.lastIndex; const e = re.exec(h); if (!e) break; TAG.lastIndex = e.index; continue; }
    if (CLOSES_P.has(nm)) { const p = lastOf("p"); if (p >= 0 && p >= top(edges)) popTo(p); }
    if ((PAIR_ANY.has(nm) || PAIR_TABLE.has(nm)) && i >= 0 && i >= edge) popTo(i);
    if (!at.has(nm)) at.set(nm, []); at.get(nm).push(stack.length); if (SCOPE_EDGE.has(nm)) edges.push(stack.length); if (nm === "table") tables.push(stack.length);
    stack.push(nm); if (stack.length > limit) return stack.length;
  }
  return stack.length;
}
const MAIL_MAX_DEPTH = 512;
// The shown copy of an HTML mail, without its quoted history, or null when nothing should fold. Parsed inert (DOMParser runs no script
// and loads no image); the cut is the marker and everything after it in document order, ancestors kept.
function quoteSplitHtml(html) {
  const h = String(html || "");
  if (!(QUOTE_HINT.test(h) || /border-top/i.test(h) && fromNearSent(h)) || typeof DOMParser === "undefined") return null;
  if (htmlDepth(h, MAIL_MAX_DEPTH) > MAIL_MAX_DEPTH) return null;   // see htmlDepth: the parse alone could take seconds
  // <link> is renamed first, as proxyImages does for the frame: an inert document should obey no preconnect, and this makes sure of it.
  let doc; try { doc = new DOMParser().parseFromString(h.replace(/<link(?=[\s/>])/gi, "<mh-link"), "text/html"); } catch (_) { return null; }
  const body = doc.body; if (!body) return null;
  const q = body.querySelector(QUOTE_SEL), o = [...body.querySelectorAll('div[style*="border-top"]')].find((d) => OUTLOOK_HDR.test(textHead(d, 1100))) || null;
  const m = q && o ? (q.compareDocumentPosition(o) & 2 ? o : q) : q || o; if (!m) return null;   // 2 = PRECEDING: the earlier one
  const outlook = m === o || m.id === "divRplyFwdMsg";
  let start = m, end = m;
  if (m.matches(".moz-cite-prefix")) { const n = m.nextElementSibling; if (n && n.tagName === "BLOCKQUOTE") end = n; }
  else if (m.tagName === "BLOCKQUOTE") { const p = m.previousElementSibling; if (p && (p.textContent || "").length < 400 && /wrote:\s*$/i.test(p.textContent || "")) start = p; }
  if (/Forwarded message|Begin forwarded message/i.test((start === m ? "" : start.textContent) + (m.textContent || "").slice(0, 300))) return null;
  if (outlook) for (let p = start.previousElementSibling; p && (p.tagName === "HR" || p.id === "appendonsend"); p = start.previousElementSibling) start = p;
  const r = doc.createRange();
  if (!outlook) { r.setStartAfter(end); r.setEnd(body, body.childNodes.length); if (r.toString().trim()) return null; }
  r.setStartBefore(start); r.setEnd(body, body.childNodes.length); r.deleteContents();
  if (!(body.textContent || "").trim() && !body.querySelector("img")) return null;
  return doc.documentElement.outerHTML;
}
// "•••" shows the folded quote and hides it again. A text mail toggles its tail; an HTML mail gets a fresh frame with the other copy,
// written and sized the way mountBodies does it (rewriting a live frame's document would strand fitFrame's observers on the old one).
// A link in a plain-text mail opens the way a link in an HTML mail does (fitFrame's onLink): cleaned, in the real browser, once.
function wireTextLinks(root) { root.querySelectorAll("a.tl").forEach((a) => a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openExternal(cleanLink(a.href)); }); }
function toggleQuote(btn, docs) {
  const open = btn.getAttribute("aria-expanded") !== "true";
  if (btn.dataset.full != null) {
    const fr = btn.parentElement?.querySelector("iframe[data-doc]"); if (!fr) return;
    const k = open ? btn.dataset.full : btn.dataset.trim;
    try { fr._ro?.disconnect(); fr._mo?.disconnect(); } catch (_) {}
    const t = document.createElement("template"); t.innerHTML = `<iframe ${FRAME_ATTRS} data-doc="${k}"${fr.dataset.dark ? ' data-dark="1"' : ""}></iframe>`;
    const nf = t.content.firstChild; fr.replaceWith(nf); nf._written = writeFrame(nf, docs[+k]); fitFrame(nf);
  } else { const tail = btn.nextElementSibling; if (tail) tail.hidden = !open; }
  const say = open ? "Hide quoted text" : "Show quoted text"; btn.setAttribute("aria-expanded", String(open)); btn.title = say; btn.setAttribute("aria-label", say);
}
const OPEN_NEWEST = 3;   // the three newest open, the older ones collapsed to a one-line preview, "Expand all" above
// Message bodies are WRITTEN into their frames, not loaded through srcdoc. An <iframe srcdoc> is a navigation: asynchronous, and in the
// Mac app each one also waits on the app's navigation-policy delegate, so the first frame after a tap showed an empty box and the mail
// came 14-54 ms later (real WKWebView). A frame created with its sandbox already set starts as about:blank synchronously,
// and a document written into it is parsed in the same task, so the mail is in, sized and painted in the first frame: what Proton
// (MessageBodyIframe) and Mailspring (email-frame) do. The sandbox is the same and is set before the frame exists: without
// allow-scripts nothing in the mail runs, whichever way it arrives (test/smoke.cjs proves scripts, handlers and refreshes stay dead).
// A collapsed message gets no frame at all until it is opened: every frame is a browsing context, even hidden.
// No scrolling="no": a zoomed mail pans sideways inside its frame, and that attribute stops the person scrolling the
// frame at all. The frame's own html,body{overflow:hidden} keeps an unzoomed mail still, as before; fitFrame opens overflow-x when zoomed.
const FRAME_ATTRS = 'sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"';
// The parsed mail is held to the link rule and labelled (cleanMailDom) in the same task as the write: nothing can be hovered or clicked
// in between.
function writeFrame(fr, doc) { try { const d = fr.contentDocument; if (!d || doc == null) return false; d.open(); d.write(doc); d.close(); try { cleanMailDom(d); } catch (_) {} try { applyImgDims(d); } catch (_) {} try { markLongRuns(d); } catch (_) {} return true; } catch (_) { return false; } }
// Only a long run with no space in it may break at any character. `overflow-wrap:anywhere` on the whole body
// (for a mail of 724-character links) also let every table cell shrink to one character when the table sized its columns
// (CSS Text 3: anywhere lowers min-content), so a cell beside a `width:100%` one was drawn a letter per line: a Stripe receipt's
// "$249.00" 10 px wide and 168 px tall, a gallery newsletter's titles two letters a line. Each run of MAIL_LONG_RUN or more
// non-space characters is wrapped in its own span that may break anywhere; the words around it, and every other word, break as sent.
const MAIL_LONG_RUN = 30;
function markLongRuns(d) {
  const b = d.body; if (!b) return; const re = new RegExp(`\\S{${MAIL_LONG_RUN},}`, "g"), hits = [];
  const w = d.createTreeWalker(b, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.data.length < MAIL_LONG_RUN || !new RegExp(re.source).test(n.data)) continue; const p = n.parentElement; if (!p || p.closest("style, script, textarea, title, [data-mh-wrap]")) continue; hits.push(n); }
  for (const n of hits) {
    const f = d.createDocumentFragment(); let at = 0;
    for (const m of n.data.matchAll(re)) { if (m.index > at) f.append(n.data.slice(at, m.index)); const s = d.createElement("span"); s.setAttribute("data-mh-wrap", ""); s.textContent = m[0]; f.append(s); at = m.index + m[0].length; }
    if (at < n.data.length) f.append(n.data.slice(at)); n.replaceWith(f);
  }
}
function mountBodies(root, docs) {
  for (const ph of root.querySelectorAll(".lazyb[data-doc]")) { if (ph.closest(".m.collapsed")) continue; const t = document.createElement("template"); t.innerHTML = `<iframe ${FRAME_ATTRS} data-doc="${ph.dataset.doc}"${ph.dataset.dark ? ' data-dark="1"' : ""}></iframe>`; ph.replaceWith(t.content.firstChild); }
  for (const fr of root.querySelectorAll("iframe[data-doc]")) { if (fr._written || fr.closest(".m.collapsed")) continue; fr._written = writeFrame(fr, docs[+fr.dataset.doc]); fitFrame(fr); }
}
// An attachment chip saves the file under its own name. A link (browser, Mac app) is a same-origin download that asks the hub for
// that name; it used to be a bare target=_blank link, and the hub's Gmail route sent no filename, so the Mac saved Gmail attachments
// as their attachment id with no extension. In the Android app a link leaves for Chrome, which has no session with the
// hub, so there every chip is a button that fetches the bytes in the app and hands them to the native save.
const attHref = (a) => a.url + (a.url.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(a.name || "attachment");
// The "real or fake" banner (trust.js): nothing at all on normal mail. A brand alarm names the domain its links go to,
// and fillTrustAges() adds how new that domain is once the banner is on screen.
// trust.js and search.js read mail HTML with /<[^>]+>/, /<img\b[^>]*?\bsrc…/, /<a\b[^>]*?\bhref…/ and /<(style|script|head)\b[\s\S]*?<\/\1>/,
// all quadratic on a mail built for it (F1). They are handed this copy instead, on which each is linear: a `<` with
// another `<` before its `>` (or no `>` at all) is text, and a <style>, <script> or <head> after the last matching close is text too.
// Nothing here is drawn; every `<` the browser would read as a tag up to its own `>` is left as it was.
function tagSafe(h) {
  let s = String(h || "").replace(/<(?=[^<>]*(?:<|$))/g, "&lt;");
  for (const nm of ["style", "script", "head"]) {
    const re = new RegExp("<\\/" + nm + ">", "gi"); let last = 0, m; while ((m = re.exec(s))) last = re.lastIndex;
    const tail = s.slice(last); if (new RegExp("<" + nm, "i").test(tail)) s = s.slice(0, last) + tail.replace(new RegExp("<(?=" + nm + ")", "gi"), "&lt;");
  }
  return s;
}
const tagSafeMsg = (m) => m && m.html && !m.text ? { ...m, html: tagSafe(m.html) } : m;
function trustBar(m) {
  let v = null; try { v = assessTrust(m ? { ...m, fromAddr: unbidi(m.fromAddr), ...(m.html ? { html: tagSafe(m.html) } : {}) } : m); } catch (_) { v = null; } if (!v) return "";
  return `<div class="trustbar ${v.level}" role="alert"${v.ageDomain ? ` data-age="${esc(v.ageDomain)}" data-at="${Number(v.date) || 0}"` : ""}><b>${v.level === "danger" ? "⚠ Probably fake" : "⚠ Not verified"} — ${esc(v.title)}</b><ul>${v.lines.map((l) => `<li>${esc(l)}</li>`).join("")}<li class="age" hidden></li></ul></div>`;
}
// An address lock kept this message out. Say whose address it is, and offer to let the sender's company in. A sender
// that could not be verified gets no button: its domain would come from a From line anyone can write.
function lockBar(m) {
  if (!m.lockKept || m.out) return "";
  const whose = m.lockClaim ? `${esc(m.identity)} is locked to ${esc(m.lockClaim)}` : `${esc(m.identity)} is locked`;
  const from = m.lockRoot ? `this came from ${esc(m.lockRoot)}` : "this sender could not be verified";
  return `<div class="trustbar warn lockbar" role="note"><b>Kept out by an address lock</b><ul><li>${whose}; ${from}.</li><li>It stayed out of the inbox and sent no notification.</li></ul>${m.lockRoot ? `<button class="primary" data-lockallow="${esc(m.identity)}" data-lockdom="${esc(m.lockRoot)}">Let ${esc(m.lockRoot)} in</button>` : ""}</div>`;
}
function wireLockBars(root) {
  root.querySelectorAll("[data-lockallow]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation(); b.disabled = true;
    try {
      const r = await api(`/api/locks/${encodeURIComponent(b.dataset.lockallow)}/allow`, { method: "POST", body: JSON.stringify({ domain: b.dataset.lockdom }) });
      // The hub has moved them; show it now rather than at the next sync.
      const moved = (r.threads || []).map((id) => state.threads.get(`hub|${id}`)).filter(Boolean);
      for (const t of moved) Object.assign(t, { state: "inbox", unread: true, labels: (t.labels || []).filter((l) => l !== "locked-out"), updatedAt: Date.now() });
      if (moved.length) idb.putAll("threads", moved);
      root.querySelectorAll(`.lockbar [data-lockdom="${CSS.escape(r.domain)}"]`).forEach((x) => x.closest(".lockbar").remove());
      toast(`${r.domain} can write to ${r.address} now. ${r.released} message${r.released === 1 ? "" : "s"} back in the inbox.`); render(); refresh({ silent: true }).catch(() => {});
    } catch (err) { b.disabled = false; toast("Couldn't let it in: " + err.message, 6000); }
  });
}
function fillTrustAges(root) {
  (root || document).querySelectorAll(".trustbar[data-age]").forEach(async (bar) => {
    if (bar.dataset.filled) return; bar.dataset.filled = "1";
    try { const r = await api("/api/domain-age?d=" + encodeURIComponent(bar.dataset.age)); if (!r.registered) return;
      const days = Math.floor(((Number(bar.dataset.at) || Date.now()) - Date.parse(r.registered)) / 864e5); if (!(days >= 0 && days <= 90)) return;   // an established domain says nothing
      const li = bar.querySelector(".age"); li.textContent = `${bar.dataset.age} was registered ${days === 0 ? "the same day" : days === 1 ? "1 day" : days + " days"} before this message arrived.`; li.hidden = false; } catch (_) {}
  });
}
// ---------- mail in dark mode (a Google Calendar invitation mixed light and dark content) ----------
// A message is drawn on white paper. Mail that DECLARES dark support (<meta name="color-scheme" content="light dark">, the older
// supported-color-schemes, or the same in its CSS) carries @media (prefers-color-scheme: dark) rules that recolour its text and expect
// the client to darken the background; on white paper in a dark app that text went near-white on white. Such mail is now drawn on the
// app's dark card when the app is dark, under its own dark rules. Any other mail with dark rules keeps the white paper and has them
// switched off, so no message can be half dark on white. A declaration without any dark rules stays on white: its colours were never
// adapted, and dark text would land on the dark card. Decided by media queries inside the frame, never by the theme at render time:
// rendered HTML is cached (prerender) and the theme can change while a message is open.
const MAIL_DARK_RULE = /prefers-color-scheme\s*:\s*dark/i;
// Every pattern here is linear on any mail (F1): the meta test's lookaheads stop at the next `<` as well as the next `>`
// (each `<meta` of an unclosed run rescanned the run), the style elements are found by styleSpans, and the CSS declaration is tested
// once per `;`/`}`-delimited piece from its first color-scheme (the rest of a piece is a suffix of what that one already read).
const MAIL_DARK_META = /<meta\b(?=[^<>]*\bname\s*=\s*["']?(?:color-scheme|supported-color-schemes)\b)(?=[^<>]*\bcontent\s*=\s*["'][^"']*\bdark\b)/i;
function cssDeclaresDark(css) {   // /(?:^|[;{\s])(?:color-scheme|supported-color-schemes)\s*:[^;}]*\bdark\b/i, one piece at a time
  const SEP = /[;}]/g; let at = 0, after = ";";
  for (;;) {
    const m = SEP.exec(css), piece = css.slice(at, m ? m.index : css.length);
    const r = (after === ";" ? /(?:^|[{\s])(?:color-scheme|supported-color-schemes)\s*:/i : /[{\s](?:color-scheme|supported-color-schemes)\s*:/i).exec(piece);
    if (r && /\bdark\b/i.test(piece.slice(r.index + r[0].length))) return true;
    if (!m) return false; after = m[0]; at = m.index + 1;
  }
}
function mailTheme(html) {
  const h = String(html || ""), css = styleSpans(h).map(([, b, c]) => h.slice(b, c)).join("\n");
  const media = [...h.matchAll(/\bmedia\s*=\s*["']([^"']*)["']/gi)].map((x) => x[1]).join("\n");
  if (!MAIL_DARK_RULE.test(css) && !MAIL_DARK_RULE.test(media)) return "light";
  const declared = MAIL_DARK_META.test(h) || cssDeclaresDark(css);
  return declared ? "dark" : "paper";
}
// Switches the dark rules off where they live (style elements and media="" attributes, e.g. a <picture>'s dark logo). An unknown
// value makes that query false in every engine (checked in Chromium and WebKit); other queries in the same list still apply.
const mailOnPaper = (html) => mapStyles(String(html), (css) => css.replace(/prefers-color-scheme\s*:\s*dark/gi, "prefers-color-scheme: x-off"))
  .replace(/(\bmedia\s*=\s*)(["'])([^"']*)\2/gi, (m0, pre, q, v) => pre + q + v.replace(/prefers-color-scheme\s*:\s*dark/gi, "prefers-color-scheme: x-off") + q);   // every query in the list
// The frame's own colours for the dark case are the app's dark --card and --fg (app.html); a frame cannot read the page's variables.
const MAIL_DARK_CSS = ":root{color-scheme:light dark}@media (prefers-color-scheme:dark){html,body{color:#ececf1;background:#1a1b20}}";
// ---------- attachments: a click previews, Download is its own action, nothing opens by itself ----------
// What the big clients do: Gmail, Outlook, Proton, Fastmail and Apple Mail all preview a file on click when it cannot run code, keep
// Download a separate action, and never open a file in another program by themselves. Gmail and Outlook refuse programs outright;
// the user receives vendor tools as.exe and.zip, so here a program is held behind a deliberate "Download anyway" instead.
// Invisible and bidi characters are removed first: "evil.exe" followed by U+200E otherwise read as having no extension at all.
//  Trailing dots and spaces go too, as Windows drops them when it saves.
const ATT_INVIS = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const extOf = (n) => { const m = /\.([a-z0-9_~-]{1,24})$/i.exec(String(n || "").replace(ATT_INVIS, "").trim().replace(/[.\s]+$/, "")); return m ? m[1].toLowerCase() : ""; };
// Programs, scripts, installers, shortcuts and disk images: the types Gmail blocks (support.google.com/mail/answer/6590), Outlook's
// additions (support.microsoft.com, "Blocked attachments in Outlook"), and the Mac executable types on Microsoft Defender's list.
// Ours on top: the Unix shell scripts (sh bash zsh csh ksh) and applescript.
const ATT_DANGER = new Set((
  "ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpkg dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib " +
  "lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll " +
  "app application appref-ms bas hlp htc inf library-ms mht mhtml msh msh1 msh2 mshxml msh1xml msh2xml msu pl ps1xml ps2 ps2xml psc1 psc2 " +
  "py pyc pyo pyw pyz pyzw reg scf search-ms settingcontent-ms url vhdx website wsb xbap " +
  "mad maf mag mam maq mar mas mat mau mav maw mda mdb mdt mdw mdz " +
  "pkg command terminal workflow scpt dylib kext macho plugin tool action caction " +
  "sh bash zsh csh ksh applescript " +
  // added: Windows gadgets, ActiveX and drivers, Office's.shs, Android app bundles, Apple
  // configuration profiles and location files (which open a URL or app when double-clicked).
  "gadget ocx drv shs xapk apkm apks mobileconfig webloc inetloc fileloc").split(/\s+/).filter(Boolean));
const ATT_ARCHIVE = new Set("zip 7z rar gz bz2 tgz tbz tbz2 xz z tar ace arj lha lzh zst".split(" "));
const ATT_MACRO = new Set("docm dotm xlsm xltm xlam xla xlsb pptm potm ppam ppa ppsm sldm".split(" "));
const ATT_ACTIVE = new Set("html htm xhtml shtml svg svgz xml xsl".split(" "));   // pages and vector files: never previewed (Outlook saves HTML only; Proton refuses SVG)
const attRisk = (name) => { const x = extOf(name); return ATT_DANGER.has(x) ? "danger" : ATT_ARCHIVE.has(x) ? "archive" : ATT_MACRO.has(x) ? "macro" : ATT_ACTIVE.has(x) ? "active" : ""; };
const ATT_NOTE = { archive: "An archive: what is inside it was not checked.", macro: "An Office file with macros: they can run code if you enable them.", active: "A web page or vector file: it is not opened here." };
// Bidirectional controls let "invoice‮fdp.exe" read as "invoiceexe.pdf"; they are dropped from what is shown, never from what is checked.
const shownName = (n) => String(n || "attachment").replace(ATT_INVIS, "");
const fmtSize = (b) => { b = Number(b) || 0; return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; };
const ATT_IMG = new Set("png jpg jpeg jpe jfif gif webp avif bmp".split(" ")), ATT_TEXT = new Set("txt text csv tsv log md markdown json ini cfg conf yaml yml".split(" "));
// The coloured type tile on a file card, by extension: PDF red, documents blue, sheets green, slides orange, images
// purple, archives grey, anything else slate.
const attKind = (x) => x === "pdf" ? "pdf" : /^(docx?|docm|dotx?|odt|rtf|pages)$/.test(x) ? "doc" : /^(xlsx?|xlsm|xlsb|csv|tsv|ods|numbers)$/.test(x) ? "xls" : /^(pptx?|pptm|ppsx?|odp|key)$/.test(x) ? "ppt" : ATT_IMG.has(x) || /^(heic|heif|tiff?|svg)$/.test(x) ? "img" : ATT_ARCHIVE.has(x) ? "zip" : "";
const ATT_MAX = { image: 30e6, pdf: 60e6, text: 2e6 };
// What the name and declared type say the file is: only a kind that cannot run code, and only if no risk class claims it.
const attExpect = (a) => {
  const x = extOf(a.name), mt = String(a.mime || "").toLowerCase();
  if (attRisk(a.name)) return "";
  if (ATT_IMG.has(x) || (!x && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(mt))) return "image";
  if (x === "pdf" || (!x && mt === "application/pdf")) return "pdf";
  if (ATT_TEXT.has(x) || (!x && /^text\/(plain|csv)$/.test(mt))) return "text";
  return "";
};
// What the bytes say it is. A preview needs the name and the bytes to agree, so a renamed file is never shown as something else.
const attSniff = (u8) => {
  const at = (o, str) => { if (o + str.length > u8.length) return false; for (let i = 0; i < str.length; i++) if (u8[o + i] !== str.charCodeAt(i)) return false; return true; };
  if (u8[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "image/png";
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "image/avif";
  if (at(0, "BM") && u8.length > 26) return "image/bmp";
  for (let o = 0; o <= Math.min(1024, u8.length - 5); o++) if (u8[o] === 0x25 && at(o, "%PDF-")) return "application/pdf";
  return "";
};
// Program signatures: Windows (MZ), Linux (ELF), macOS (Mach-O, fat binaries) and scripts (#!). A previewable name over these bytes is
// shown as the program warning, never as "no preview" with a plain Download.
const attExec = (u8) => (u8[0] === 0x4d && u8[1] === 0x5a) || (u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46) || (u8[0] === 0x23 && u8[1] === 0x21)
  || [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((m) => m.every((b, i) => u8[i] === b));
async function attBytes(t, a) {
  if (t.kind === "gmail" || !a.url) { const b = await adapterFor(t.account).attachment(a.msgId, a.id); return b instanceof Uint8Array ? b : new Uint8Array(b); }
  const r = await fetch(a.url, { credentials: "same-origin" });   // a hub attachment: its own URL
  if (!r.ok) throw new Error(`Couldn't get ${shownName(a.name)} (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
// pdf.js 6.3.289, legacy build (Apache-2.0, hub/public), fetched only when a PDF is opened. The legacy build because the modern one
// calls Map.prototype.getOrInsertComputed, which Chromium 140 lacks (WebView2 and Android are Chromium); the legacy build carries its
// own copy. It holds no eval and no Function built from data, the code path behind CVE-2024-4367 (GHSA-wgrm-67xf-hhpq); the one
// Function(in each file is core-js's constant Function("return this"), a last resort for finding the global object.
// It runs ISOLATED: in an iframe sandboxed with allow-scripts and no allow-same-origin, so its origin is
// opaque. A pdf.js bug there reaches no cookie, no storage, no app code, no native bridge (Android injects its bridge only into the
// hub's origin; the Mac's reveal handler takes only the hub's top frame), and its CSP allows no network at all. pdf.js and its worker
// are handed in as text and loaded from blob: URLs made inside the frame; the PDF arrives by postMessage. Pages are drawn to canvases
// with no annotation, form, text or link layer, only as they come near view, and released when far from it.
// Scanned PDFs: pdf.js 6 decodes CCITT fax and JBIG2 images (a copier's lettering) with jbig2.wasm, JPEG 2000 with
// openjpeg.wasm and ICC colour with qcms_bg.wasm; without them it skipped those images, so a scan showed its grey background and nothing
// else. They are pdf.js's own files, served from /pdfjs/<version>/ (hub/public), and pdf.js loads them as it does anywhere: `wasmUrl`,
// only when a PDF holds that kind of image. Safari cannot compile openjpeg.wasm (relaxed SIMD), so there pdf.js imports its JavaScript
// fallback from the same folder. The frame's CSP opens exactly that folder of this origin (script and connect; the frame's requests
// carry no cookie, its origin being opaque) and adds 'wasm-unsafe-eval', which allows compiling WebAssembly and nothing else:
// JavaScript built from strings (eval, Function) stays blocked (CSP3 §4.4.1 vs §4.5.1).
// pdf.js's worker: Chromium (Android, Windows) refuses a module worker from a blob: URL in the sandboxed frame, the only
// form pdf.js makes there, so pdf.js parsed on the frame's thread, which in Chromium is the app's: a big PDF held the app ~200 ms at
// phone speed. A module worker from a data: URL starts on every engine and keeps the frame's CSP, so the app builds that URL once a
// session and the frame starts the worker itself, waits for pdf.js's `ready`, and hands it over as `workerPort`. pdf.js takes a
// workerPort with no check of its own, so a worker that fails or stays silent for 10 s is dropped for the old path, which pdf.js runs
// or replaces with its main-thread fallback: a PDF never waits on a dead worker.
let pdfSrc = null;
const pdfSources = () => pdfSrc || (pdfSrc = Promise.all(["/pdf.min.mjs", "/pdf.worker.min.mjs"].map(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`PDF viewer unavailable (${r.status})`); return r.text(); })).then(([lib, worker]) => [lib, "data:text/javascript;charset=utf-8," + encodeURIComponent(worker)]).catch((e) => { pdfSrc = null; throw e; }));
// The shell's script nonce, for the one inline script the app writes: the PDF frame's, which inherits the shell's policy.
// Read once, while this file runs from its own script tag.
const CSP_NONCE = (typeof document !== "undefined" && document.currentScript?.nonce) || "";
const PDF_FRAME = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval' __HUB__/pdfjs/; connect-src __HUB__/pdfjs/; worker-src blob: data:; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:"><style>html,body{margin:0;background:transparent}body{padding:16px 12px;touch-action:pan-x pan-y}.pg{position:relative;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.4);margin:0 auto 12px}.pg canvas{display:block;width:100%;height:100%}.pg canvas.dt{position:absolute;left:0;top:0}</style></head><body><script nonce="__NONCE__">
__ZOOM__
(() => {
  const MAXPX = 4e6;   // device pixels per page: a full-page canvas is never more than about 16 MB
  let zi = null;       // the zoom inputs, once the pages are laid out; the page's + - 0 keys arrive as a "zoom" message
  addEventListener("keydown", (e) => { if (["Escape", "ArrowLeft", "ArrowRight"].includes(e.key)) parent.postMessage({ k: "key", key: e.key }, "*"); });
  addEventListener("message", async (e) => {
    if (e.source !== parent || !e.data) return;
    if (e.data.k === "zoom") { if (zi) zi.key(e.data.key); return; }
    if (e.data.k !== "pdf") return;
    const { lib, workerUrl, data, width, dpr, hub } = e.data;
    try {
      const pdfjs = await import(URL.createObjectURL(new Blob([lib], { type: "text/javascript" })));
      const started = await new Promise((ok) => {   // pdf.js's worker, from the data: URL, once it has said "ready"
        let w; try { w = new Worker(workerUrl, { type: "module" }); } catch (_) { return ok(null); }
        const done = (v) => { clearTimeout(t); w.removeEventListener("message", heard); w.removeEventListener("error", lost); ok(v); };
        const heard = (e) => { if (e.data && e.data.action === "ready" && e.data.sourceName === "worker" && e.data.targetName === "main") done(w); }, lost = () => { w.terminate(); done(null); }, t = setTimeout(lost, 10000);
        w.addEventListener("message", heard); w.addEventListener("error", lost);
      });
      if (started) pdfjs.GlobalWorkerOptions.workerPort = started;
      else pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([decodeURIComponent(workerUrl.slice(workerUrl.indexOf(",") + 1))], { type: "text/javascript" }));
      const doc = await pdfjs.getDocument({ data, enableXfa: false, disableAutoFetch: true, stopAtErrors: false, useWorkerFetch: false, wasmUrl: hub + "/pdfjs/" + pdfjs.version + "/" }).promise;
      const n = Math.min(doc.numPages, 500), pages = [], cssW = Math.min(width, 1100);
      for (let p = 1; p <= n; p++) {
        const page = await doc.getPage(p), base = page.getViewport({ scale: 1 }), scale = cssW / base.width;
        const box = document.createElement("div"); box.className = "pg";
        box.setAttribute("aria-label", "Page " + p + " of " + doc.numPages); document.body.appendChild(box); pages.push({ page, box, base, scale, c: null, cs: 0, task: null, d: null, dz: 1, dr: null, dtask: null });
      }
      // Zoom, as pdf.js's own viewer does it: a change resizes the page boxes at once (CSS; a drawn canvas stretches)
      // and moves the scroll so the point under the pointer stays on its page; 400 ms after the last change the near pages are drawn
      // again at the new size. A page whose full canvas would pass MAXPX keeps the capped one and gets a detail canvas over the part
      // of it on screen (plus a margin, within the same budget), drawn again 150 ms after a scroll leaves that part. zoom 1 = fit width.
      let zoom = 1, carry = 1, redrawT = 0, scrollT = 0;
      const MINZ = 0.5, MAXZ = 5, REDRAW_MS = 400;
      const vw = () => document.documentElement.clientWidth, vh = () => document.documentElement.clientHeight;
      const baseScale = (x) => { let s = x.scale * zoom * dpr; const px = x.base.width * x.base.height * s * s; return px > MAXPX ? s * Math.sqrt(MAXPX / px) : s; };
      const placeDetail = (x) => { const k = zoom / x.dz, a = x.dr, st = x.d.style; st.left = a.minX * k + "px"; st.top = a.minY * k + "px"; st.width = a.w * k + "px"; st.height = a.h * k + "px"; };
      const size = (x) => { x.box.style.width = cssW * zoom + "px"; x.box.style.height = Math.round(x.base.height * x.scale * zoom) + "px"; if (x.d) placeDetail(x); };
      for (const x of pages) size(x);
      const cancel = (x, k) => { if (!x[k]) return; try { x[k].cancel(); } catch (_) {} x[k] = null; };
      let drawn = 0;
      const draw = async (x, again) => {
        if (x.c && !again) return;
        cancel(x, "task");
        const s = baseScale(x), vp = x.page.getViewport({ scale: s }), c = document.createElement("canvas"); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        x.cs = s; if (!x.c) { x.c = c; x.box.prepend(c); }   // the first canvas goes on the page at once; a redraw replaces the old one only when complete
        const task = x.page.render({ canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE }); x.task = task;
        let ok = true; try { await task.promise; } catch (_) { ok = false; }
        if (x.task !== task) { if (x.c !== c) { c.width = 0; c.height = 0; } return; }   // cancelled, or a later draw owns the page
        x.task = null; if (!ok) return;
        if (x.c !== c) { const old = x.c; x.c = c; x.box.prepend(c); old.width = 0; old.height = 0; old.remove(); }
        drawn++; parent.postMessage({ k: "drawn", drawn, pages: n }, "*");
      };
      const dropDetail = (x) => { cancel(x, "dtask"); if (!x.d) return; x.d.width = 0; x.d.height = 0; x.d.remove(); x.d = null; x.dr = null; };
      const drop = (x) => { cancel(x, "task"); dropDetail(x); if (!x.c) return; x.c.width = 0; x.c.height = 0; x.c.remove(); x.c = null; x.cs = 0; };
      const detail = async (x) => {
        const r = x.box.getBoundingClientRect(), x0 = Math.max(0, -r.left), y0 = Math.max(0, -r.top), x1 = Math.min(r.width, vw() - r.left), y1 = Math.min(r.height, vh() - r.top);
        if (zoom <= 1 || x.scale * zoom * dpr <= baseScale(x) * 1.001 || x1 <= x0 || y1 <= y0) { dropDetail(x); return; }   // the page's canvas is sharp enough, or the page is off screen
        if (x.d && x.dz === zoom && x.dr.minX <= x0 + 1 && x.dr.minY <= y0 + 1 && x.dr.minX + x.dr.w >= x1 - 1 && x.dr.minY + x.dr.h >= y1 - 1) return;   // the part on screen is still covered
        // pdf.js's area: the visible part plus up to a whole visible width and height on each side, shrunk to keep within the budget
        const visW = x1 - x0, visH = y1 - y0, over = Math.max(0, Math.min(1, (Math.sqrt(MAXPX / (visW * visH * dpr * dpr)) - 1) / 2));
        const minX = Math.max(0, x0 - visW * over), minY = Math.max(0, y0 - visH * over), w = Math.min(r.width, x1 + visW * over) - minX, h = Math.min(r.height, y1 + visH * over) - minY;
        const k = dpr * Math.min(1, Math.sqrt(MAXPX / (w * h * dpr * dpr)));   // device pixels per CSS pixel, cut only when the visible part alone passes the budget
        cancel(x, "dtask");
        const c = document.createElement("canvas"); c.className = "dt"; c.width = Math.floor(w * k); c.height = Math.floor(h * k);
        const z = zoom, a = { minX, minY, w, h };
        const task = x.page.render({ canvas: c, viewport: x.page.getViewport({ scale: x.scale * z }), transform: [k, 0, 0, k, -minX * k, -minY * k], annotationMode: pdfjs.AnnotationMode.DISABLE }); x.dtask = task;
        let ok = true; try { await task.promise; } catch (_) { ok = false; }
        if (x.dtask !== task) { c.width = 0; c.height = 0; return; }
        x.dtask = null; if (!ok) return;
        if (x.d) { x.d.width = 0; x.d.height = 0; x.d.remove(); }
        x.d = c; x.dz = z; x.dr = a; x.box.appendChild(c); placeDetail(x);
        parent.postMessage({ k: "detail", page: pages.indexOf(x) + 1, w: c.width, h: c.height }, "*");
      };
      const redraw = () => { for (const x of pages) { if (x.c && Math.abs(baseScale(x) - x.cs) > 1e-6) draw(x, true); detail(x); } };
      const pageAt = (cy) => { let prev = null; for (const x of pages) { const r = x.box.getBoundingClientRect(); if (cy <= r.bottom) { if (cy >= r.top || !prev) return x; return cy - prev.box.getBoundingClientRect().bottom <= r.top - cy ? prev : x; } prev = x; } return prev; };
      const zoomTo = (z, cx, cy) => {
        z = Math.min(MAXZ, Math.max(MINZ, Math.round(z * 100) / 100)); if (z === zoom) return;
        const a = pageAt(cy), r = a.box.getBoundingClientRect(), fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;   // the point under the pointer, as a fraction of its page
        zoom = z; for (const x of pages) size(x);
        const r2 = a.box.getBoundingClientRect(); scrollBy(r2.left + fx * r2.width - cx, r2.top + fy * r2.height - cy);
        clearTimeout(redrawT); redrawT = setTimeout(redraw, REDRAW_MS);
        parent.postMessage({ k: "zoom", zoom }, "*");
      };
      const zoomBy = (f, cx, cy) => { if (f === 1) return; const t = Math.min(MAXZ, Math.max(MINZ, zoom * f * carry)), z = Math.round(t * 100) / 100; carry = t / z; zoomTo(z, cx, cy); };   // 0.01 steps, the remainder carried (pdf.js _accumulateFactor)
      addEventListener("scroll", () => { if (zoom <= 1) return; clearTimeout(scrollT); scrollT = setTimeout(() => { for (const x of pages) detail(x); }, 150); }, { passive: true });
      // root: document, because in a cross-origin frame the implicit root is the top window and rootMargin is ignored there.
      const io = new IntersectionObserver((es) => { for (const en of es) { const x = pages.find((y) => y.box === en.target); if (!x) continue; if (en.isIntersecting) draw(x); } }, { root: document, rootMargin: "1500px 0px" });
      const far = new IntersectionObserver((es) => { for (const en of es) { const x = pages.find((y) => y.box === en.target); if (x && !en.isIntersecting) drop(x); } }, { root: document, rootMargin: "6000px 0px" });
      for (const x of pages) { io.observe(x.box); far.observe(x.box); }
      zi = zoomInput(document, { by: zoomBy, toggle: (cx, cy) => zoomTo(zoom === 1 ? 2 : 1, cx, cy), reset: (cx, cy) => zoomTo(1, cx, cy), pan: (dx, dy) => scrollBy(dx, dy) }, { keys: true });
      parent.postMessage({ k: "ready", pages: n, total: doc.numPages }, "*");
    } catch (err) { parent.postMessage({ k: "error", message: String(err && err.message || err) }, "*"); }
  });
  parent.postMessage({ k: "hello" }, "*");
})();
<\/script></body></html>`;
// Every way a person zooms, wired on one element: a trackpad pinch (WebKit's gesture events, or the wheel events with ctrlKey that
// Chromium, Firefox and Safari send for one), Ctrl/Cmd + wheel ticks, two fingers on a touch screen, a double-click or double-tap, and
// the + = - 0 keys. on.by(factor, clientX, clientY) is a relative change about a point, on.toggle(clientX, clientY) a double tap,
// on.reset(clientX, clientY) the 0 key, on.pan(dx, dy) two fingers moving together, on.active() whether there is anything to zoom;
// dbl:false keeps a mouse double-click out of it (a mail's double-click selects a word). origin() gives el's offset on
// the screen, for an element that moves while it is pinched (a mail frame, which the conversation scrolls).
// The tests and thresholds are pdf.js's viewer's (web/app.js onWheel, src/display/touch_manager.js). Self-contained
// on purpose: its source is also injected into the PDF frame (PDF_FRAME's __ZOOM__), which shares nothing with this page, so it may
// use nothing defined outside it.
function zoomInput(el, on, { keys = false, dbl = true, win = window, doc = document, origin = null } = {}) {
  let ctrlDown = false, gesturing = false, gScale = 1, ticks = 0, pinch = null, one = null, tap = null, touched = 0, held = false;
  const pr = () => win.devicePixelRatio || 1, live = () => !on.active || on.active();
  const center = () => { if (el === doc || el === win) return [win.innerWidth / 2, win.innerHeight / 2]; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const key = (k, cx, cy) => { if (!live()) return false; if (cx == null) [cx, cy] = center(); if (k === "+" || k === "=") on.by(1.25, cx, cy); else if (k === "-") on.by(0.8, cx, cy); else if (k === "0") on.reset(cx, cy); else return false; return true; };
  // A Control key really held makes a wheel a mouse wheel with Ctrl, never a pinch (pdf.js _isCtrlKeyDown)
  doc.addEventListener("keydown", (e) => { if (e.key === "Control") ctrlDown = true; }, true);
  doc.addEventListener("keyup", (e) => { if (e.key === "Control") ctrlDown = false; }, true);
  win.addEventListener("blur", () => { ctrlDown = false; gesturing = false; pinch = null; });
  el.addEventListener("wheel", (e) => {
    const f = Math.exp(-e.deltaY / 100);   // a trackpad pinch arrives as ctrlKey + small pixel deltas; this is its factor (pdf.js, from Firefox's widget code)
    const pinched = e.ctrlKey && !ctrlDown && e.deltaMode === 0 && e.deltaX === 0 && e.deltaZ === 0 && Math.abs(f - 1) < 0.05;
    if (!live() || (!pinched && !e.ctrlKey && !e.metaKey)) return;   // a plain scroll
    e.preventDefault();   // the pages zoom, never the browser or the app (pdf.js issue 14725: Safari's own gesture ran on)
    if (gesturing) return;   // WebKit reports the same pinch as gesture events too; those drive it, this would count it twice
    if (pinched) { on.by(f, e.clientX, e.clientY); return; }
    ticks += e.deltaMode === 0 ? -e.deltaY / 30 : -Math.sign(e.deltaY);   // 30 px of wheel per step; a notched wheel is one step per click
    const t = Math.trunc(ticks); ticks -= t; if (t) on.by(Math.pow(1.1, t), e.clientX, e.clientY);
  }, { passive: false });
  el.addEventListener("gesturestart", (e) => { if (!live()) return; e.preventDefault(); gesturing = true; gScale = 1; });
  el.addEventListener("gesturechange", (e) => { if (!live()) return; e.preventDefault(); if (!gesturing) { gesturing = true; gScale = 1; } const s = e.scale || 1; if (s !== gScale) on.by(s / gScale, e.clientX, e.clientY); gScale = s; });
  el.addEventListener("gestureend", (e) => { if (!live()) return; e.preventDefault(); gesturing = false; });
  const span = (t) => Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY), mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  const smid = (t) => [(t[0].screenX + t[1].screenX) / 2, (t[0].screenY + t[1].screenY) / 2], sspan = (t) => Math.hypot(t[1].screenX - t[0].screenX, t[1].screenY - t[0].screenY);
  // A pinch begins (or begins again, when two fingers remain after a third came and went). On a real phone a touch's coordinates in the
  // frame are measured before the app's last move of the frame has landed (off by exactly that move, 138 vs 137, 202 vs
  // 202 px), while its place on the screen (screenX/Y) is true. So where screen and page agree on the fingers' spread (within 1 % on at
  // least 30 px: the same units), the pan is the fingers' own movement on the screen, and the point under them is that screen place
  // through k, where the page sits on the screen. k is measured again on every event that follows no move of the frame, where the frame's
  // coordinates are fresh (on the phone: 101 such events, k steady to 1 px), so a stale start or a change in the screen's mapping moves
  // the anchor for one such event at most and never pans. Without the same units the frame's coordinates are used when fresh, and right
  // after a move the fingers are held where they were, rather than reading the app's own move as theirs (that read, fed back, is what
  // shook the mail).
  const startPinch = (t, armed = false) => { const [mx, my] = mid(t), [ox, oy] = origin ? origin() : [0, 0], [qx, qy] = smid(t), s = span(t), ss = sspan(t);
    return { d: s, x: mx + ox, y: my + oy, q: [qx, qy], k: origin && s >= 30 && Math.abs(ss - s) <= s * 0.01 ? [qx - mx - ox, qy - my - oy] : null, moved: false, on: armed }; };
  el.addEventListener("touchstart", (e) => {
    touched = Date.now(); if (!live()) return;
    if (e.touches.length === 1) { const t = e.touches[0]; one = { x: t.clientX, y: t.clientY }; }
    else if (e.touches.length === 2) { e.preventDefault(); pinch = startPinch(e.touches); one = null; held = false; }
    else { held = held || !!(pinch && pinch.on); pinch = null; one = null; }   // a third finger: no pinch while it is down
  }, { passive: false });
  el.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = span(e.touches), [ox, oy] = origin ? origin() : [0, 0], [cx, cy] = mid(e.touches), [qx, qy] = smid(e.touches);
    let x = cx + ox, y = cy + oy;
    if (pinch.k) {
      if (!pinch.moved) pinch.k = [qx - x, qy - y];
      x = qx - pinch.k[0]; y = qy - pinch.k[1];
      if (on.pan && (qx !== pinch.q[0] || qy !== pinch.q[1])) on.pan(pinch.q[0] - qx, pinch.q[1] - qy);   // two fingers moving together
    } else {
      if (pinch.moved) { x = pinch.x; y = pinch.y; }
      if (on.pan && (x !== pinch.x || y !== pinch.y)) on.pan(pinch.x - x, pinch.y - y);
    }
    pinch.x = x; pinch.y = y; pinch.q = [qx, qy];
    const [ax, ay] = origin ? origin() : [0, 0], mx = x - ax, my = y - ay;   // the point under the fingers in the frame, after the pan
    // pdf.js: the span must change 35 CSS px before this is a pinch at all, then 4 device px per update; less is contact jitter
    if (Math.abs(d - pinch.d) > (pinch.on ? 4 : 35) / pr()) { if (pinch.on) on.by(d / pinch.d, mx, my); else pinch.on = true; pinch.d = d; }   // the step that starts the pinch is not applied (pdf.js)
    if (origin) { const [bx, by] = origin(); pinch.moved = bx !== ox || by !== oy; }   // this handler moved the frame: the next event's frame coordinates lag it
  }, { passive: false });
  const touchEnd = (e) => {
    if (e.touches.length === 2 && live()) { pinch = startPinch(e.touches, held); one = null; return; }   // a third finger lifted: the two left pinch on, as armed as before
    if (e.touches.length < 2) held = false;
    if (pinch) { if (e.touches.length < 2) pinch = null; one = null; return; }
    if (e.type !== "touchend" || !one || e.changedTouches.length !== 1 || e.touches.length) { one = null; return; }
    const t = e.changedTouches[0], now = Date.now(), moved = Math.hypot(t.clientX - one.x, t.clientY - one.y); one = null;
    if (moved > 10) { tap = null; return; }   // a scroll, not a tap
    if (tap && now - tap.t < 300 && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) < 30) { tap = null; e.preventDefault(); on.toggle(t.clientX, t.clientY); }
    else tap = { t: now, x: t.clientX, y: t.clientY };
  };
  el.addEventListener("touchend", touchEnd, { passive: false }); el.addEventListener("touchcancel", touchEnd, { passive: false });
  if (dbl) el.addEventListener("dblclick", (e) => { if (!live() || Date.now() - touched < 700) return; e.preventDefault(); on.toggle(e.clientX, e.clientY); });   // a double tap has already toggled; dbl:false leaves a mouse double-click to select a word (a mail)
  if (keys) doc.addEventListener("keydown", (e) => { const tg = e.target; if (e.altKey || (tg && tg.matches && (tg.matches("input,textarea,select") || tg.isContentEditable))) return; if (key(e.key) && (e.ctrlKey || e.metaKey)) e.preventDefault(); });
  return { key };
}
async function attPdf(body, u8, gen) {
  const [lib, workerUrl] = await pdfSources(); if (gen !== attView.gen) return;
  const fr = document.createElement("iframe");
  fr.className = "avframe"; fr.setAttribute("sandbox", "allow-scripts"); fr.setAttribute("referrerpolicy", "no-referrer"); fr.title = "PDF preview";
  const width = Math.max(320, Math.min(body.clientWidth || 900, 1100) - 24), dpr = Math.min(window.devicePixelRatio || 1, 2);
  await new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.source !== fr.contentWindow || !e.data || gen !== attView.gen) return;
      if (e.data.k === "hello") { const data = u8.slice().buffer; fr.contentWindow.postMessage({ k: "pdf", lib, workerUrl, data, width, dpr, hub: location.origin }, "*", [data]); }
      else if (e.data.k === "ready") { fr.dataset.pages = String(e.data.pages); resolve(); }
      else if (e.data.k === "drawn") fr.dataset.drawn = String(e.data.drawn);
      else if (e.data.k === "zoom") { fr.dataset.zoom = String(e.data.zoom); attZoomNote(e.data.zoom); }
      else if (e.data.k === "detail") fr.dataset.detail = `${e.data.page}:${e.data.w}x${e.data.h}`;
      else if (e.data.k === "key") { if (e.data.key === "Escape") dropLayer("attview"); else if (attView.files.length > 1) attShow(attView.i + (e.data.key === "ArrowLeft" ? -1 : 1)); }
      else if (e.data.k === "error") { removeEventListener("message", onMsg); reject(new Error(e.data.message || "This PDF could not be shown")); }
    };
    addEventListener("message", onMsg); attView.frameOff = () => removeEventListener("message", onMsg);
    fr.srcdoc = PDF_FRAME.replaceAll("__NONCE__", CSP_NONCE).replaceAll("__HUB__", location.origin).replace("__ZOOM__", () => zoomInput.toString()); attView.frame = fr; body.replaceChildren(fr);
  });
}
const attView = { t: null, files: [], i: 0, gen: 0, url: null, frameOff: null, frame: null, z: null, meta: "" };
function attRelease() { attView.gen++; attView.frame = attView.z = null; $("#avbody").classList.remove("zoomed"); if (attView.url) { URL.revokeObjectURL(attView.url); attView.url = null; } if (attView.frameOff) { attView.frameOff(); attView.frameOff = null; } }
// The header's line under the name, with the zoom after it when it is not 1x
function attZoomNote(z) { $("#avmeta").textContent = attView.meta + (z !== 1 ? ` · ${Math.round(z * 100)}%` : ""); }
// + = - 0 while the viewer is open: to the PDF frame as a message (its own script zooms), or to the picture's zoomer
function attZoomKey(key) {
  if (!["+", "=", "-", "0"].includes(key)) return false;
  if (attView.frame) { attView.frame.contentWindow.postMessage({ k: "zoom", key }, "*"); return true; }
  if (!attView.z) return false;
  const r = $("#avbody").getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (key === "0") attView.z.reset(cx, cy); else attView.z.by(key === "-" ? 0.8 : 1.25, cx, cy);
  return true;
}
// The picture viewer's zoom: the same inputs as the PDF frame's, on the <img>. Above 1x the viewer body is a block
// so a wide picture scrolls from its left edge; back at 1x the picture is fit again. 0.01 steps with the remainder carried, 0.5x to 8x.
function imgZoom(body, img) {
  let zoom = 1, carry = 1, fit = null;
  const zoomTo = (z, cx, cy) => {
    z = Math.min(8, Math.max(0.5, Math.round(z * 100) / 100)); if (z === zoom) return;
    const r = img.getBoundingClientRect(); if (zoom === 1) fit = [r.width, r.height];
    const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    zoom = z; body.classList.toggle("zoomed", z !== 1);
    if (z === 1) img.style.width = img.style.height = ""; else { img.style.width = fit[0] * z + "px"; img.style.height = fit[1] * z + "px"; }
    const r2 = img.getBoundingClientRect(); body.scrollBy(r2.left + fx * r2.width - cx, r2.top + fy * r2.height - cy);
    attZoomNote(zoom);
  };
  return { by: (f, cx, cy) => { if (f === 1) return; const t = Math.min(8, Math.max(0.5, zoom * f * carry)), z = Math.round(t * 100) / 100; carry = t / z; zoomTo(z, cx, cy); },
    toggle: (cx, cy) => zoomTo(zoom === 1 ? 2 : 1, cx, cy), reset: (cx, cy) => zoomTo(1, cx, cy) };
}
function attClose() { attRelease(); $("#avmodal").classList.remove("on"); $("#avbody").replaceChildren(); }
function attOpen(t, files, i) {
  attView.t = t; attView.files = files;
  const was = $("#avmodal").classList.contains("on");
  $("#avmodal").classList.add("on"); attShow(i);
  if (!was) { pushLayer("attview", attClose); $("#avclose").focus(); }
}
function attPanel(icon, title, lines, button) {
  const d = document.createElement("div"); d.className = "avpanel" + (icon === "warn" ? " danger" : "");
  d.innerHTML = `${ico(icon)}<div class="avpt"></div>${lines.map(() => `<p></p>`).join("")}${button ? `<button class="avgo"></button>` : ""}`;
  d.querySelector(".avpt").textContent = title; d.querySelectorAll("p").forEach((p, k) => (p.textContent = lines[k]));
  if (button) { const b = d.querySelector(".avgo"); b.textContent = button.label; b.onclick = button.run; }
  return d;
}
async function attShow(i) {
  const files = attView.files; if (!files.length) return;
  i = ((i % files.length) + files.length) % files.length; attView.i = i;
  attRelease(); const gen = attView.gen, a = files[i], t = attView.t, name = shownName(a.name), body = $("#avbody");
  $("#avname").textContent = name;
  attView.meta = [fmtSize(a.size), files.length > 1 ? `${i + 1} of ${files.length}` : ""].filter(Boolean).join(" · "); attZoomNote(1);
  $("#avprev").hidden = $("#avnext").hidden = files.length < 2;
  const risk = attRisk(a.name), kind = attExpect(a);
  $("#avdl").hidden = risk === "danger";   // the warning carries its own, deliberate button
  const warn = () => { $("#avdl").hidden = true; body.replaceChildren(attPanel("warn", "This is a program or script", [
      `${name} can run code on your computer. Mail like this is a common way to spread malware.`,
      "Download it only if you expected this file from this sender. It is not opened, here or after it is saved."],
      { label: "Download anyway", run: () => attDownload(t, a, { confirmed: true }) })); };
  if (risk === "danger") { warn(); return; }
  if (!kind || (Number(a.size) || 0) > ATT_MAX[kind]) {
    body.replaceChildren(attPanel("file", "No preview for this file", [ATT_NOTE[risk] || (kind ? "It is too large to preview." : "Download it to open it with an app you choose.")].filter(Boolean), { label: "Download", run: () => attDownload(t, a, { confirmed: true }) }));
    return;
  }
  body.replaceChildren(attPanel("attach", "Loading…", []));
  let u8; try { u8 = await attBytes(t, a); } catch (e) { if (gen === attView.gen) body.replaceChildren(attPanel("file", "Couldn't load this file", [e.message || String(e)], { label: "Try again", run: () => attShow(i) })); return; }
  if (gen !== attView.gen) return;
  if (attExec(u8)) { attView.files[i] = Object.assign({}, a, { program: true }); warn(); return; }
  if (u8.length > ATT_MAX[kind]) { body.replaceChildren(attPanel("file", "No preview for this file", ["It is too large to preview."], { label: "Download", run: () => attDownload(t, a, { confirmed: true }) })); return; }
  const real = attSniff(u8);
  try {
    if (kind === "image" && real.startsWith("image/")) {
      const url = URL.createObjectURL(new Blob([u8], { type: real })); attView.url = url;
      const img = document.createElement("img"); img.className = "avimg"; img.alt = name; img.src = url; body.replaceChildren(img); attView.z = imgZoom(body, img); return;
    }
    if (kind === "pdf" && real === "application/pdf") { await attPdf(body, u8, gen); return; }
    if (kind === "text" && !u8.subarray(0, 8192).includes(0)) {
      const pre = document.createElement("pre"); pre.className = "avtext"; pre.textContent = new TextDecoder("utf-8").decode(u8); body.replaceChildren(pre); return;
    }
  } catch (e) { if (gen === attView.gen) body.replaceChildren(attPanel("file", "Couldn't show this file", [e.message || String(e)], { label: "Download", run: () => attDownload(t, a, { confirmed: true }) })); return; }
  body.replaceChildren(attPanel("file", "No preview for this file", ["It is not what its name says it is, so it is not shown here."], { label: "Download", run: () => attDownload(t, a, { confirmed: true }) }));
}
// Download: its own action, never followed by opening the file. A program reaches here only through the warning's "Download anyway".
async function attDownload(t, a, { confirmed = false } = {}) {
  const risk = a.program ? "danger" : attRisk(a.name);
  // A program never downloads without its warning; a macro document or a page/vector file shows its caution first. Archives go
  // straight down, as in Gmail: vendors send them all the time.
  if (!confirmed && (risk === "danger" || risk === "macro" || risk === "active")) { attOpen(t, [a], 0); return; }
  const name = shownName(a.name);
  try {
    if (nativeBridge) {   // Android: the app writes it to Downloads; "Open" hands it to an app the person picks, never a program
      const u8 = await attBytes(t, a); let bin = ""; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      const uri = await nativeBridge.call("saveFile", { name: a.name || "attachment", mime: a.mime || "application/octet-stream", b64: btoa(bin) });
      const canOpen = typeof uri === "string" && uri.startsWith("content://") && !attRisk(a.name);
      toast("Saved to Downloads: " + name, 6000, canOpen ? () => nativeBridge.call("openFile", { uri, name: a.name || "", mime: a.mime || "" }).catch((e) => toast(e.message)) : null, "Open");
      return;
    }
    // The app's or browser's own download from the hub URL, named by ?name= (A Gmail PDF once saved on the Mac as its
    // attachment id). WebKit quarantines it and WebView2 marks it as from the internet, with this https URL as its source (a blob:
    // URL would leave only an origin).
    if (!a.url) throw new Error(`${name} has no download address`);   // never a blob: URL, which would lose the OS's download protection
    // The Mac app cancels an error answer itself and says so (measured, WKDownload: -999 after a 4xx). A browser or WebView2 would
    // save the error page as the file, so outside the Mac app the page asks first, reads only the status, and drops the body.
    const mac = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.reveal);
    if (!mac) { const ac = new AbortController(); const r = await fetch(a.url, { credentials: "same-origin", signal: ac.signal }); try { ac.abort(); } catch (_) {} if (!r.ok) throw new Error(`Couldn't download ${name} (${r.status})`); }
    const el = document.createElement("a"); el.href = attHref(a); el.download = a.name || "attachment"; el.rel = "noopener"; document.body.appendChild(el); el.click(); el.remove();
  } catch (e) { toast(e.message || `Couldn't download ${name}`); }
}
$("#avclose").onclick = () => dropLayer("attview");
$("#avprev").onclick = () => attShow(attView.i - 1);
$("#avnext").onclick = () => attShow(attView.i + 1);
$("#avdl").onclick = () => { const a = attView.files[attView.i]; if (a) attDownload(attView.t, a, { confirmed: !a.program && attRisk(a.name) !== "danger" }); };
document.addEventListener("keydown", (e) => {
  if (!$("#avmodal").classList.contains("on") || e.altKey) return;
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && attView.files.length > 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); attShow(attView.i + (e.key === "ArrowLeft" ? -1 : 1)); return; }
  if (attZoomKey(e.key)) { e.stopImmediatePropagation(); if (e.ctrlKey || e.metaKey) e.preventDefault(); }   // + = - 0: the preview zooms, not the app
});
zoomInput($("#avbody"), { active: () => !!attView.z, by: (f, x, y) => attView.z.by(f, x, y), toggle: (x, y) => attView.z.toggle(x, y), reset: (x, y) => attView.z.reset(x, y), pan: (dx, dy) => $("#avbody").scrollBy(dx, dy) });
// The Mac app calls this when WebKit has written a download, or failed to: otherwise a save there leaves no sign it happened.
window.mhDownloaded = (r) => { try {
  const name = shownName(r && r.name); const reveal = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.reveal;
  if (r && r.ok) toast("Saved to Downloads: " + name, 6000, r.id && reveal ? () => reveal.postMessage(String(r.id)) : null, "Show in Finder");
  else toast(`Couldn't save ${name}${r && r.error ? ": " + r.error : ""}`, 8000);
} catch (_) {} };
// A part the message body shows (its Content-ID appears as cid:… in the HTML) is part of the message, not a file. The same rule as the
// hub's has_att, so the list's paperclip and the header's count agree.
const bodyImage = (a, html) => { const c = String(a.cid || "").replace(/^[<\s]+|[>\s]+$/g, ""); return !!c && !!html && html.includes("cid:" + c); };
// The message header: the sender's initial, name and short date on one line, "to me · 10:32 AM"
// under it. The whole "Name <address>" used to be the header, and a long address ran off the card on a phone. Tapping the name or the
// "to" line of an open message shows the full addresses, word-wrapped, and the full date; tapping anywhere else still collapses it.
// A message we sent reads "Sam Owner (You) · sam@yourdomain.example": the name it went out
// under, then the address it went from, because the hub sends from six domains and "You" alone said neither. A send with no name
// reads "You · <address>". The suffix is muted and cut with "…" before it can push the date off a phone's card.
const senderName = (m) => { const f = unbidi(m.from).trim(), named = /<[^<>]+>\s*$/.test(f); return m.out ? (named && nameOf(f)) || "You" : named ? (nameOf(f) || addrOf(f)) : f; };
function toLine(m) {
  const me = new Set([String(m.identity || "").toLowerCase()].filter(Boolean)), all = [...splitAddrs(m.to), ...splitAddrs(m.cc)];
  if (!all.length) return "";
  const mine = all.findIndex((x) => me.has(addrOf(x))), first = mine >= 0 ? "me" : (/<[^<>]+>\s*$/.test(all[0]) ? nameOf(all[0]) : "") || addrOf(all[0]);
  return "to " + unbidi(first) + (all.length > 1 ? " +" + (all.length - 1) : "");
}
function messageHead(m, collapsed, nFiles, ct = null) {
  const nm = senderName(m), d = new Date(m.date), time = isNaN(d) ? "" : fmtFor().time.format(d), to = toLine(m);
  const mine = m.out ? (nm === "You" ? "" : " (You)") + (m.identity ? " · " + unbidi(m.identity) : "") : "";
  const flags = (m.gmailCopy === "none" ? " · <b>no Gmail copy</b>" : "") + (m.gmailCopy === "held" ? " · <b>held</b>" : "");
  const clip = nFiles ? `<span class="hasatt" role="img" aria-label="${nFiles} attachment${nFiles === 1 ? "" : "s"}" title="${nFiles} attachment${nFiles === 1 ? "" : "s"}">${ico("attach")}${nFiles > 1 ? nFiles : ""}</span>` : "";
  const row = (k, v) => v ? `<div><span>${k}</span><span>${esc(k === "date" ? v : unbidi(v))}</span></div>` : "";
  const full = isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const rt = m.replyTo && addrOf(m.replyTo) !== addrOf(m.from) ? m.replyTo : "";
  // the conversation comes from prerender, which builds the page before it is opened, so state.cur may still be another one
  const fa = lc(m.fromAddr || addrOf(m.from));
  return `<div class="h"><span class="hav${!m.out && isBiz(ct) && fa === lc(ct.fromAddr) ? " biz" : ""}" aria-hidden="true" style="--h:${hueFor(m.fromAddr || addrOf(m.from))}">${esc((nm || "?")[0].toUpperCase())}</span>`
    + `<div class="who2" title="Show details"><div class="l1"><span class="from">${esc(nm)}${mine ? `<span class="fid">${esc(mine)}</span>` : ""}</span><span class="when">${esc(when(m.date))}</span></div>`
    + `<div class="l2">${esc([to, time].filter(Boolean).join(" · "))}${flags}<span class="chev">${ico("chevron")}</span></div>`
    + (collapsed ? `<div class="l3">${clip}<span class="pv">${esc(messagePreview(m))}</span></div>` : "") + `</div></div>`
    + `<div class="hdet" hidden>${row("from", m.from)}${row("reply-to", rt)}${row("to", m.to)}${row("cc", m.cc)}${row("date", full)}</div>`;
}
// URLs in a plain-text mail are links: a sender's secure-share link was text that could not be tapped. Split on the
// raw text and escape every piece, so no quote or bracket in the mail can reach an attribute; trailing punctuation stays outside the
// link, and a closing ")" stays inside only when the URL opened one.
function linkText(t) {
  const s = String(t || ""); let out = "", at = 0;
  for (const mt of s.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    // (the brackets are counted once and the count kept as the end moves: counting them again for every character cut was quadratic
    // in a URL ending in a long run of ")", F1 2026-11-09)
    const w = mt[0]; let e = w.length, opens = 0, shuts = 0; for (let k = 0; k < w.length; k++) { if (w[k] === "(") opens++; else if (w[k] === ")") shuts++; }
    for (;;) { const c = w[e - 1]; if (/[.,;:!?\]}*]/.test(c)) e--; else if (c === ")" && opens < shuts) { e--; shuts--; } else break; }
    const u = w.slice(0, e);
    const go = cleanLink(u);   // where it goes: the href and the hover title; the text stays as written
    out += esc(s.slice(at, mt.index)) + `<a class="tl" href="${esc(go)}" title="${esc(go)}" rel="noopener noreferrer">${esc(u)}</a>`; at = mt.index + u.length;
  }
  return out + esc(s.slice(at));
}
function messageHtml(m, i, n, docs = [], opts = {}) {
  const collapsed = i >= OPEN_NEWEST ? " collapsed" : "";   // display order: index 0 is the NEWEST
  const atts = (m.attachments || []).map((a) => ({ ...a, url: a.url || null }));
  let body; const trackers = []; const fold = !FWD_SUBJECT.test(m.subject || "");
  const dots = (extra) => `<button type="button" class="qtog"${extra} aria-expanded="false" title="Show quoted text" aria-label="Show quoted text">•••</button>`;
  // Pictures keep the size their mail gives them while the mail fits the pane. `max-width:100%` on every picture made
  // one in an auto-width table cell count as zero wide when the table sized its columns (CSS Sizing 3, a replaced box's cyclic
  // percentage resolves against zero for its min-content), so the text beside it took its room: a newsletter's 100 px logos were drawn at 47-97 px
  // over their titles, and a Stripe invoice picture at 0 px. The shrink now applies only once fitFrame finds the mail wider than the
  // pane (html[data-mh-shrink]);:where() keeps the rule as weak as the old `img`, so a mail's own picture rules still win.
  // A long unbreakable run is not a fixed-width mail (a mail drawn far too small: three
  // Amazon links of up to 724 characters, whose longest hyphen-free run laid the body out 1461 px wide, so fitFrame scaled the mail to
  // 0.35). `overflow-wrap:anywhere` lets such a run break at any character AND counts those breaks in the width the fit measures (CSS
  // Text 3: anywhere affects min-content, break-word does not), so the mail reads at full size; a 600 px column or table still scales as
  // before. It is on the long runs alone (markLongRuns): on the whole body it shrank table cells to one letter.
  // A mail nested past MAIL_MAX_DEPTH is shown as its text: the browser's parse of that HTML alone takes seconds (htmlDepth).
  const deep = !!m.html && htmlDepth(m.html, MAIL_MAX_DEPTH) > MAIL_MAX_DEPTH;
  if (m.html && !deep) { const theme = mailTheme(m.html); const frameDoc = (h, trk) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${frameImgSrc()}; style-src 'unsafe-inline'; font-src data:; form-action 'none'; frame-src 'none'"><base target="_blank"><style>html,body{margin:0;padding:10px;color:#111;background:#fff;font:14px -apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;touch-action:pan-x pan-y}:where([data-mh-wrap]){overflow-wrap:anywhere}${theme === "dark" ? MAIL_DARK_CSS : ":root{color-scheme:light}"}img{height:auto}:where(html[data-mh-shrink]) img{max-width:100%}table{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:break-word}::highlight(mhfind){background:#ffe600;color:#111}::highlight(mhcur){background:#ff8a00;color:#111}</style></head><body>${cleanMailTags(proxyImages(theme === "paper" ? mailOnPaper(h) : h, atts, trk, m.out ? 0 : m.date))}</body></html>`; const k = docs.push(frameDoc(m.html, trackers)) - 1;
    const cut = fold ? quoteSplitHtml(m.html) : null; const kt = cut ? docs.push(frameDoc(cut, [])) - 1 : k;   // the trackers note speaks for the whole mail
    const dk = theme === "dark" ? " data-dark=\"1\"" : ""; body = collapsed ? `<div class="lazyb" data-doc="${kt}"${dk}></div>` : `<iframe ${FRAME_ATTRS} data-doc="${kt}"${dk}></iframe>`;
    if (cut) body += dots(` data-full="${k}" data-trim="${kt}"`); }
  else { const t = m.text || (deep ? htmlAsText(m.html) : ""), c = fold ? quoteSplitText(t) : -1; body = c < 0 ? `<pre>${linkText(t)}</pre>` : `<pre>${linkText(t.slice(0, c).replace(/\s+$/, ""))}</pre>${dots("")}<pre class="qtail" hidden>${linkText(t.slice(c))}</pre>`; }
  // Files are cards directly under the header (Outlook: "directly under the message header or subject"): a reply's text
  // used to bury them. Images the body shows stay in the small strip at the bottom, so a signature logo never becomes a card.
  const chip = (a, ai) => { const r = attRisk(a.name), nm = shownName(a.name); return `<span class="att${r === "danger" ? " risk" : ""}" data-att="${esc(String(a.id ?? ""))}" data-msg="${esc(String(m.id ?? ""))}"><button class="attopen" data-ai="${ai}" title="${r === "danger" ? "A program or script: open to see why it is held back" : "Preview"}">${ico(r === "danger" ? "warn" : "attach")}<span class="an">${esc(nm)}</span><span class="as">${esc(fmtSize(a.size))}</span></button><button class="attdl" data-ai="${ai}" title="Download" aria-label="Download ${esc(nm)}">${ico("download")}</button></span>`; };
  const card = (a, ai) => { const r = attRisk(a.name), nm = shownName(a.name), x = extOf(a.name); return `<span class="att card${r === "danger" ? " risk" : ""}" data-att="${esc(String(a.id ?? ""))}" data-msg="${esc(String(m.id ?? ""))}"><button class="attopen" data-ai="${ai}" title="${r === "danger" ? "A program or script: open to see why it is held back" : "Preview"}"><span class="ft ${r === "danger" ? "risk" : attKind(x)}">${r === "danger" ? ico("warn") : esc((x || "file").slice(0, 4).toUpperCase())}</span><span class="ainfo"><span class="an">${esc(nm)}</span><span class="as">${esc(fmtSize(a.size))}</span></span></button><button class="attdl" data-ai="${ai}" title="Download" aria-label="Download ${esc(nm)}">${ico("download")}</button></span>`; };
  const files = atts.map((a, ai) => [a, ai]).filter(([a]) => !bodyImage(a, m.html)), inl = atts.map((a, ai) => [a, ai]).filter(([a]) => bodyImage(a, m.html));
  const filesHtml = files.length ? `<div class="atts files">${files.map(([a, ai]) => card(a, ai)).join("")}</div>` : "";
  const inlHtml = inl.length ? `<div class="atts inl">${inl.map(([a, ai]) => chip(a, ai)).join("")}</div>` : "";
  if (opts.noHead) return `<div class="m${collapsed}">${filesHtml}<div class="b">${body}</div>${inlHtml}</div>`;   // the feed card: its own header
  return `<div class="m${collapsed}">${messageHead(m, collapsed, files.length, opts.thread)}${lockBar(m)}${trustBar(m)}${trackerNote(trackers)}${filesHtml}<div class="b">${body}</div>${inlHtml}</div>`;
}
// A mail may be zoomed to this many times its own size; the fit scale is the floor.
const MSG_ZOOM_MAX = 3;
function fitFrame(fr) {
  // The document's `load` waits for every proxied image, which can take seconds or never happen; the frame must follow the live
  // document from the first moment instead. Mail is written in synchronously now (writeFrame), so the first fit below already sees it;
  // the short poll stays for a frame whose document arrives later (a srcdoc frame skips its throw-away about:blank), and
  // ResizeObserver + MutationObserver + image events keep the height right for as long as the frame lives.
  let last = 0, lastStep = 0, lastScale = 1, natural = 0, forcedDoc = null, creep = 0, probedAt = 0, armedDoc = null, ticks = 0, freeAvail = 0, freeAt = 0;
  const imp = (el, prop, v) => { if (v === "") el.style.removeProperty(prop); else el.style.setProperty(prop, v, "important"); }; // inline !important outranks the mail's own !important rules
  const fit = () => { try { const d = fr.contentDocument; if (!d || !d.body) return; if (fr.srcdoc && d.URL === "about:blank") return; const de = d.documentElement, body = d.body; const forced = forcedDoc === d; // the frame's throw-away about:blank body is never styled: its document is replaced and the styles would be lost (the real body then kept only width and transform)
    // Fixed-width mail (600 px tables, nowrap headings, oversized images, html/body widths) is wider than a phone. Instead of clipping the
    // right edge the body is laid out at the mail's own width and scaled down to fit: `natural` is the content's overflow width (the
    // larger of the body's scrollWidth and the root's, less the body's left offset) measured while nothing is forced, the body then gets
    // that width with overflow visible (its own overflow:hidden would clip before the transform) and a scale of avail / natural, where
    // avail leaves the html padding and the body's margins unscaled around it. Content that grows later widens `natural`; while forced,
    // at most every 400 ms the width is released for one clean measurement, so content that grew (a late image) or shrank (a responsive
    // mail) re-derives the scale; between those the last scale stands, and overflow stays visible rather than clipping. The height is the body's own content height (scaled) plus the padding, never
    // the root's scrollHeight, which is at least the viewport and therefore grew the frame 4 px on every fit; content sized from the
    // viewport (100vh) would still grow it by a constant step each time, so three equal growth steps in a row end the growth.
    const g = d.defaultView.getComputedStyle(de), bs = d.defaultView.getComputedStyle(body);
    const padL = parseFloat(g.paddingLeft) || 0, padX = padL + (parseFloat(g.paddingRight) || 0), padY = (parseFloat(g.paddingTop) || 0) + (parseFloat(g.paddingBottom) || 0);
    const mL = parseFloat(bs.marginLeft) || 0, mX = mL + (parseFloat(bs.marginRight) || 0), left = padL + mL;
    // The room is measured from the FREE layout and kept while the body is forced. A mail whose body is `margin: 0 auto` (USPS Informed
    // Delivery) gets a NEGATIVE right margin from Chromium once its width is forced past the pane, so the room measured then
    // grew by exactly the overflow: the scale fell back to 1, the body was freed, the room shrank again; the mail flipped between two
    // sizes 6 times a second on my phone. While forced, only a change in the frame's own width moves it.
    if (!forced || !freeAt) { freeAvail = de.clientWidth - padX - mX; freeAt = de.clientWidth; }
    const avail = forced ? freeAvail + (de.clientWidth - freeAt) : freeAvail;
    const z = fr._zoom || 1;   // the person's zoom, 1 at fit
    const measure = () => { const w = Math.max(body.scrollWidth + left, de.scrollWidth); return w > de.clientWidth + 1 ? w - left : 0; }; // body.scrollWidth sees inside the body's own clip; de.scrollWidth sees an html/body width the mail forced
    // A mail is first measured as sent; the first time it is wider than the pane its pictures may shrink to their boxes, and it is measured
    // again. Never undone: a mail that needed it once is drawn as every mail was before, with no back and forth.
    if (!forced) { natural = measure(); if (avail > 0 && natural > avail + 1 && !de.hasAttribute("data-mh-shrink")) { de.setAttribute("data-mh-shrink", ""); natural = measure(); } }
    else if (z === 1 && lastScale <= 1 && Date.now() - probedAt > 400) { probedAt = Date.now(); imp(body, "width", ""); natural = measure(); if (natural) imp(body, "width", natural + "px"); } // re-measure from a clean layout: growing `natural` from a forced body feeds itself (its own overflow becomes the next width) and runs away. Not while zoomed, nor on the fit that brings the zoom back (the body still wears the zoomed-up transform, which widens the root's overflow the same way); measuring with the transform lifted instead read a different width (Chromium counted the body's end padding: 620 for a 600 px column that measured 610), so `natural` stands until the mail is back at fit
    // The fit scale, times the person's zoom (fr._zoom): never below the fit, at most MSG_ZOOM_MAX × the mail's own size. A
    // zoomed mail that fitted is laid out at the room it had (fw = avail) and scaled up from there, the way a shrunk one is laid out at its
    // own width and scaled down.
    const base = avail > 0 && natural > avail + 1 ? avail / natural : 1;
    const scale = Math.min(Math.max(base * z, base), Math.max(base, MSG_ZOOM_MAX)), fw = natural || avail;
    // A zoomed mail stays laid out at fw even when its scale passes through 1 (a shrunk column shown at its own size): released there, it
    // would be measured again in a different layout and come back a different width (620 for the 610 px column).
    const atFit = z === 1 && Math.abs(scale - 1) <= 0.001;
    if (!atFit) { if (!forced) { forcedDoc = d; imp(body, "box-sizing", "border-box"); imp(body, "overflow", "visible"); imp(body, "transform-origin", "0 0"); } if (body.style.width !== fw + "px") imp(body, "width", fw + "px"); }
    else if (forced) { forcedDoc = null; for (const p of ["box-sizing", "overflow", "transform-origin", "width", "transform"]) imp(body, p, ""); lastScale = 1; }
    if (Math.abs(scale - lastScale) > 0.0001 || (atFit !== (body.style.transform === ""))) { lastScale = scale; imp(body, "transform", atFit ? "" : `scale(${scale})`); }
    // Wider than the frame once zoomed: the frame scrolls sideways (one finger, a wheel's horizontal axis); vertical scrolling stays the
    // conversation's, since the frame is as tall as the mail. A classic horizontal scrollbar gets its own room under the mail.
    const wide = scale * fw + left > de.clientWidth + 1; imp(de, "overflow-x", wide ? "auto" : "");
    const sbH = wide ? Math.max(0, d.defaultView.innerHeight - de.clientHeight) : 0, top = (parseFloat(g.paddingTop) || 0) + (parseFloat(bs.marginTop) || 0);
    const h = Math.ceil(body.scrollHeight * scale + padY + (parseFloat(bs.marginTop) || 0) + (parseFloat(bs.marginBottom) || 0) + sbH) + 4;
    fr._fit = { natural, scale, base, zoom: z, left, top, forced: forcedDoc === d, avail, bodySW: body.scrollWidth, deSW: de.scrollWidth, h }; // last measurement, for tests and debugging
    if (Math.abs(h - last) > 1) { const step = h - last; if (last && step > 0 && Math.abs(step - lastStep) <= 1) { if (++creep > 3) return; } else creep = 0; lastStep = step; last = h; fr.style.height = h + "px"; } } catch (_) {} };
  // Zoom: two fingers, a trackpad pinch or Ctrl/Cmd + wheel zoom the mail from its fitted size to MSG_ZOOM_MAX × its own
  // size; a double tap shows a shrunk mail at its own size and a fitting one at 2x, and fits it again. The attachment viewer's inputs
  // (zoomInput), applied through fit(): the zoom multiplies the fit scale, the frame grows with the mail, the mail pans sideways inside
  // the frame and the conversation keeps scrolling vertically: Thunderbird for Android's shape (a wrap_content WebView with the
  // WebView's own pinch, MessageWebView.kt). The point under the fingers stays put: sideways by the frame's own scroll, vertically by
  // the conversation's scroller.
  const scroller = () => { let e = fr.parentElement; while (e && !/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement; return e || document.scrollingElement; };
  const zoomTo = (z, cx, cy) => { try { const d = fr.contentDocument, de = d.documentElement, f0 = fr._fit || {}, base = f0.base || 1, s0 = f0.scale || 1;
    z = Math.round(Math.min(Math.max(z, 1), Math.max(1, MSG_ZOOM_MAX / base)) * 1000) / 1000; if (z === (fr._zoom || 1)) return;
    const X = (cx + de.scrollLeft - (f0.left || 0)) / s0, Y = (cy - (f0.top || 0)) / s0;   // the point under the fingers, in the mail's own coordinates
    fr._zoom = z; creep = 0; fit(); const s1 = (fr._fit || {}).scale || s0;
    de.scrollLeft = Math.max(0, (f0.left || 0) + X * s1 - cx); const sc = scroller(); if (sc) sc.scrollTop += Y * (s1 - s0);
  } catch (_) {} };
  const zoomOn = { by: (f, cx, cy) => zoomTo((fr._zoom || 1) * f, cx, cy), reset: (cx, cy) => zoomTo(1, cx, cy),
    toggle: (cx, cy) => { const base = (fr._fit || {}).base || 1; zoomTo((fr._zoom || 1) > 1.001 ? 1 : base < 0.999 ? 1 / base : 2, cx, cy); },
    pan: (dx, dy) => { try { const sc = scroller(); rest = [scrollKeep(fr.contentDocument.documentElement, "scrollLeft", dx + rest[0]), sc ? scrollKeep(sc, "scrollTop", dy + rest[1]) : 0]; } catch (_) {} } };
  // A scroll lands on whole pixels: what it rounded away (under 1 px) is added to the next pan, and what an edge stopped is dropped
  const scrollKeep = (e, k, v) => { const t = e[k] + v; e[k] = t; const r = t - e[k]; return Math.abs(r) < 1 ? r : 0; };
  let rest = [0, 0];
  // An <area>, and an SVG <a> (its.href an SVGAnimatedString, which the test below read as "[object SVGAnimatedString]" and let
  // through), are links too; anything that is not http(s) or mailto goes nowhere.
  const onLink = (ev) => {
    const a = ev.target?.closest?.("a, area"); if (!a) return;
    const v = a.href; let href = typeof v === "string" ? v : (v && v.baseVal) || a.getAttribute("href") || a.getAttributeNS?.("http://www.w3.org/1999/xlink", "href") || "";
    if (!href) return; try { href = new URL(href, a.baseURI).href; } catch (_) { ev.preventDefault(); return; }
    if (/^mailto:/i.test(href)) return;
    ev.preventDefault(); if (/^https?:\/\//i.test(href)) openExternal(cleanLink(href));
  };
  const arm = () => { try { const d = fr.contentDocument; if (!d || !d.body || d === armedDoc) return; if (fr.srcdoc && d.URL === "about:blank") return; armedDoc = d; fr._ro?.disconnect(); fr._mo?.disconnect(); fit();
    if (typeof ResizeObserver !== "undefined") { const ro = new ResizeObserver(fit); ro.observe(d.documentElement); ro.observe(d.body); fr._ro = ro; }
    if (typeof MutationObserver !== "undefined") { const mo = new MutationObserver(() => requestAnimationFrame(fit)); mo.observe(d.documentElement, { childList: true, subtree: true, attributes: true }); fr._mo = mo; }
    for (const im of d.images) { im.addEventListener("load", fit); im.addEventListener("error", fit); }
    // Links open in a real browser tab, once. The handler is claimed on the document itself: `arm()` runs again on every
    // `load` and from the poll, and a second handler on one body opened every tapped link a second time.
    if (!d.__mhLinked) { d.__mhLinked = true; d.addEventListener("click", onLink, true); d.addEventListener("dragover", (e) => onFileDrag(e, fr)); d.addEventListener("drop", (e) => onFileDrop(e, fr));
      fr._zoom = 1; zoomInput(d, zoomOn, { win: d.defaultView, doc: d, dbl: false, origin: () => { const r = fr.getBoundingClientRect(); return [r.left, r.top]; } }); d.addEventListener("keydown", onFindKey);   // Cmd/Ctrl+F typed with the focus inside the mail (Chromium; WebKit runs nothing here, the Mac's Edit menu covers it) // a new document starts at fit
      // The press happens well before the release; warming there is free and lands before the tap completes.
    } } catch (_) {} };
  fr.addEventListener("load", () => { arm(); fit(); }); // arm() re-arms only a document it has not seen; `fit()` re-measures now the images are in
  const settled = () => { try { const d = fr.contentDocument; return !!armedDoc && d === armedDoc && d.readyState === "complete" && [...d.images].every((im) => im.complete); } catch (_) { return false; } };
  const tick = () => { if (!fr.isConnected && ticks > 3) return; arm(); fit(); ticks++; if (ticks < 120 && !(ticks > 5 && settled())) setTimeout(tick, ticks < 30 ? 100 : 500); }; // polling ends once the document has settled; the observers carry on
  tick();
}
// A hit the server search found is a real conversation that this device's window simply had not reached yet. It was rendered as a
// row (with a "server" badge) but lived only in state.serverSearch, and every path that acts on a row starts from state.threads, so
// clicking it, or selecting it and pressing Done, silently did nothing at all. Adopt it the first time something acts on it: it is an
// ordinary thread from then on, for opening, the action bar, the keyboard, bulk and the local store alike.
function adoptServerRow(key) {
  const t = state.serverSearch.get(key); if (!t) return null;
  delete t._server; state.threads.set(key, t); state.serverSearch.delete(key);
  idb.putAll("threads", [t]).catch(() => {});
  return t;
}
// a declaration, not a const: bulk() and the selection bar above call it, and neither should depend on where this sits in the file
function threadFor(key) { return state.threads.get(key) || adoptServerRow(key); } // only where the row is about to be acted on: it mutates
// `reload`: the conversation already on screen drawn again with fresh data (reloadOpenThread), given as `data`. It is not an open: no
// speed sample, no handled mark, no read action, no neighbour prefetch.
async function openThread(key, { reload = false, data = null } = {}) {
  const t = threadFor(key); if (!t) return;
  // `open-thread` below measures to the next animation frame with an EMPTY function, so it reports main-thread congestion at the
  // moment of the tap, not when the mail is actually on screen. On the phone it read p50 60 ms and nobody could tell from that
  // what the user was looking at. `open-thread:visible` is the honest one: tap until the messages are in the DOM and painted.
  const tTap = performance.now();
  if (!reload) perf.measure("open-thread", () => {});
  if (inUnread()) state.keep.add(key);
  if (!reload) draftLeaveReply(key);   // the reply being written stays with its conversation, saved now
  state.cur = key; setFocus(key); if (!reload) noteHandled([key]); $$(".t").forEach((d) => d.classList.toggle("sel", d.dataset.key === key)); $("#app").classList.add("viewing"); closeMenu(); closeReplySheet(); pushLayer("thread", closeThreadView, { under: "compose" });
  $("#vtitle").textContent = shownSubject(t); syncActionBar(t);
  const ms = $("#msgs");
  // From Trash, a live Gmail conversation opens on its trashed messages, fetched each time: the body cache, the push stash and the
  // prerendered page all hold the conversation as its other folders show it, and none of them is written from this view.
  const lens = !data && trashLens(t);
  let pre = data || lens ? null : prerendered.get(key); let d = data || pre?.d; const tFetch = performance.now();
  if (!pre) ms.innerHTML = "";   // never the previous conversation's body under this one's title while the cache is read
  if (!d && !lens) { d = await cachedThread(t); }
  if (!d && !lens) { d = await pushedThread(t); }   // the push already brought it down; no spinner, no network
  if (!d) { ms.innerHTML = '<div class="empty">Loading…</div>'; try { d = await adapterFor(t.account).thread(t.id, lens ? { binned: true } : undefined); } catch (e) { ms.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } if (!d.binnedView) cacheThread(t, d); requestAnimationFrame(() => perf.record("open-thread:body", performance.now() - tFetch)); }
  else if (!reload) requestAnimationFrame(() => perf.record(pre ? "open-thread:prerendered" : "open-thread:cached", performance.now() - tFetch));
  if (state.cur !== key) return;
  state.curThread = { key, ...d };
  if (!pre) { prerender(t, d); pre = prerendered.get(key); if (d.binnedView) prerendered.delete(key); }
  $$("#msgs iframe").forEach((f) => { try { f._ro?.disconnect(); f._mo?.disconnect(); } catch (_) {} }); ms.innerHTML = pre.html;
  if (d.binnedView) { const n = d.messages.length, o = d.others; ms.insertAdjacentHTML("afterbegin", `<div class="binnote">${n === 1 ? "This message is" : `These ${n} messages are`} in Trash. The conversation's other ${o === 1 ? "message is" : o + " messages are"} not, and ${o === 1 ? "shows" : "show"} in its other folders.</div>`); }
  if (!reload) requestAnimationFrame(() => perf.record("open-thread:visible", performance.now() - tTap)); // the number the user actually feels
  ms.querySelectorAll(".m").forEach((div, i) => {
    const m = d.messages[d.messages.length - 1 - i]; if (!m) return;   // the elements are newest-first (prerender)
    div.querySelector(".h").onclick = (e) => {   // an open message's name or "to" line shows its details; the rest of the header collapses it
      const det = div.querySelector(".hdet");
      if (det && !div.classList.contains("collapsed") && e.target.closest(".who2")) { det.hidden = !det.hidden; div.classList.toggle("det", !det.hidden); return; }
      div.classList.toggle("collapsed"); mountBodies(div, pre.docs);
    };
    div.querySelectorAll(".qtog").forEach((b) => b.onclick = (e) => { e.stopPropagation(); toggleQuote(b, pre.docs); });
    wireTextLinks(div);
    // Resolved by the chip's own attachment and message ids, never by position: a prerendered thread can be older than the data it is
    // wired to, and the wrong index would act on another file.
    div.querySelectorAll(".atts [data-ai]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation(); const chip = b.closest(".att"); if (!chip) return;
      const owner = d.messages.find((x) => String(x.id) === chip.dataset.msg && (x.attachments || []).some((y) => String(y.id) === chip.dataset.att));
      const files = owner ? owner.attachments : [], ai = files.findIndex((y) => String(y.id) === chip.dataset.att); if (ai < 0) return;
      if (b.classList.contains("attdl")) attDownload(t, files[ai]); else attOpen(t, files, ai);
    });
  });
  mountBodies(ms, pre.docs);   // the open messages' mail, parsed and sized before this task ends
  fillTrustAges(ms);   // only a banner that is showing asks anything of the network
  wireLockBars(ms);
  ms.querySelector(".expall")?.addEventListener("click", (e) => { ms.querySelectorAll(".m.collapsed").forEach((x) => x.classList.remove("collapsed")); e.currentTarget.remove(); mountBodies(ms, pre.docs); });
  ms.scrollTop = 0;   // the newest message is at the top
  if (!reload) { const rows = visibleThreads(); const i = rows.findIndex((x) => x.key === key); scheduleIdle(() => prefetchBodies([rows[i + 1], rows[i - 1]].filter(Boolean))); }
  const last = [...d.messages].reverse().find((m) => !m.out) || d.messages[d.messages.length - 1];
  // A conversation with no messages has nobody to reply to. This used to show the reply box BEFORE failing on `last.out`, so it kept the
  // previous conversation's recipient: a reply typed there would have gone to someone else.
  if (!last) { state.replyTo = null; $("#replybox").style.display = "none"; if (!ms.querySelector(".m")) ms.innerHTML = `<div class="empty" style="padding:24px">This conversation has no messages.</div>`; return; }
  state.replyTo = last;
  $("#replybox").style.display = "grid";
  const from = t.kind === "gmail" ? t.account : (last.out ? last.identity : (last.identity || state.me.identities[0]?.email || ""));
  $("#rfrom").value = from; $("#rname").value = nameFor(from); $("#rto").textContent = last.out ? last.to : (last.replyTo || last.fromAddr); $("#rall").checked = false; $("#rtext").value = sigFor(from); clearFiles($("#rfiles")); $("#rprev").style.display = "none"; syncBrand("#rfrom");
  if (!reload || editors.r.key !== key) draftEnterReply(key);   // and comes back when it is opened again, on any device
  if (t.unread && !reload) localAct(t, "read", { quiet: true });   // queued, retried and announced like any action
}
// A reply that went out shows in its conversation (a reply sent from an open conversation did not
// appear in it). The send only refreshed the list, so the open conversation kept its old messages until it was opened again. Now the
// conversation is fetched from where the mail went (the hub, or Gmail for a Gmail reply), kept in the body cache so the next open has it
// too, and redrawn if it is still the one on screen and nothing new is being written in its reply box. The box can still hold the text
// that was just sent: sendReply clears it only once queue.add has returned, which waits up to 3 s for a service worker; that is the sent
// reply, not a new one, and the redraw resets the box as resetReplyBox would.
// It draws what it fetched, not the body cache: a Gmail conversation with a message in Trash reads the cache through the list row's
// `shownIds`, which does not name the reply until the list itself is refreshed, so the reply stayed off (test/sentshows.py).
async function reloadOpenThread(key, sentText = "") {
  const t = state.threads.get(key); if (!t) return;
  let d; try { d = await adapterFor(t.account).thread(t.id); } catch (_) { return; }
  if (!d?.messages?.length) return;
  await cacheThread(t, d); prerendered.delete(key);
  const inBox = ($("#rtext").value || "").trim();
  if (state.cur !== key || (replyWork() && inBox !== String(sentText || "").trim())) return;
  await openThread(key, { reload: true, data: d });
}
// The open conversation follows its row. A notification tapped for a conversation the page already held drew the copy
// drawn before (its prerendered page, opened with no freshness check), and the push's download or the resume sync that brought the new
// reply landed a moment later, updated the row and redrew only the list: the reply stayed off screen until the conversation was left
// and opened again (A reply that arrived at 20:33 was still missing from the open conversation at 20:39). After each
// refresh, each claimed download and each resume, an open conversation whose row has a newest message the view lacks is redrawn, from
// a local copy that has it or else fetched. Not while a reply is being written, the reply sheet or find is open, or the view has been
// scrolled into (a redraw starts at the top, where the newest message is); tried once per newest message, so a row whose newest
// message the view never shows is not fetched again on every sync.
async function followOpenThread() {
  const key = state.cur, t = key && state.threads.get(key), cur = state.curThread;
  if (!t || !t.lastMsgId || !cur || cur.key !== key || cur.binnedView || !$("#app").classList.contains("viewing")) return;
  if ((cur.messages || []).some((m) => m.id === t.lastMsgId)) return;
  const stamp = key + "|" + t.lastMsgId; if (followOpenThread.done === stamp) return;
  if (replyWork() || $("#app").classList.contains("replying") || document.activeElement === $("#rtext") || find.on || $("#msgs").scrollTop > 40) return;
  followOpenThread.done = stamp;
  const has = (d) => (d && d.messages && d.messages.some((m) => m.id === t.lastMsgId) ? d : null);
  const d = has(prerendered.get(key)?.d) || has(await cachedThread(t)) || has(await pushedThread(t));
  if (state.cur !== key || state.curThread !== cur) return;   // another conversation was opened meanwhile
  if (d) return openThread(key, { reload: true, data: d });
  return reloadOpenThread(key);
}
function sigFor(addr) { const s = prefs().signatures[lc(addr)] || prefs().signatures["*"] || ""; return s ? "\n\n" + s : ""; }
function swapSig(ta, oldFrom, newFrom) { const o = sigFor(oldFrom), n = sigFor(newFrom); if (o && ta.value.endsWith(o)) ta.value = ta.value.slice(0, -o.length) + n; else if (!o && n && !ta.value.includes(n)) ta.value += n; }
async function cachedThread(t) { let rows = await idb.getByIndex("bodies", "threadKey", t.key).catch(() => []); if (t.kind === "gmail" && t.shownIds) { const shown = new Set(t.shownIds); rows = rows.filter((r) => shown.has(r.id)); } /* a body cached while its message was still live stays out once the message is trashed */ if (!rows.length) return null; const expected = t.kind === "gmail" ? t.count : null; if (expected && rows.length < expected) return null; if (t.lastMsgId && !rows.some((r) => r.id === t.lastMsgId)) return null; if (t.kind === "gmail" && !t.unsub && !t.unsubKnown && rows.some((r) => r.m && r.m.unsub === undefined)) return null; /* cached before the client kept List-Unsubscribe: fetch fresh so the row can learn it */ if (rows.some((r) => ((r.m && r.m.attachments) || []).some((a) => a && a.cid && !a.url))) return null; /* cached before attachments carried `url`: proxyImages() resolves a cid: reference THROUGH that url, so without it every inline image rendered with an empty src and the frame's CSP showed alt text instead. The USPS digest of 2026-09-18 was cached at 13:24Z, three hours before the fix deployed, and stayed broken because the cache was served back unchanged. */ if (rows.some((r) => r.m && r.m.out && /^You \(/.test(r.m.from || ""))) return null; /* cached before a sent message kept the name it went out under: it would read "You" in the header and "You (address)" in a quote */ return { thread: { id: t.id }, messages: rows.sort((a, b) => a.date - b.date).map((r) => r.m), cached: true }; }
// The service worker downloads a pushed conversation while the phone is still asleep and stashes the RAW payload under meta
// `pf:<key>` (see sw.js). This is where it is claimed: parsed with the account's own normalize(), written into the body cache, and
// removed. So tapping a notification renders from local bytes instead of showing "Loading…" and waiting on Gmail.
const PUSHED_MAX_AGE = 24 * 3600e3; // older than a day: the conversation has probably moved on, fetch it fresh
async function pushedThread(t) {
  const t0 = performance.now();   // a real elapsed time: this path reads IndexedDB, parses and writes the body cache; it is not free
  try {
    const row = await idb.get("meta", "pf:" + t.key); const v = row?.v?.raw ? row.v : memStash.get(t.key); if (!v?.raw) return null;
    const drop = () => { memStash.delete(t.key); idb.del("meta", "pf:" + t.key).catch(() => {}); };
    if (!v.at || Date.now() - v.at > PUSHED_MAX_AGE) { drop(); return null; }
    let d = null; try { d = adapterFor(t.account).normalize(v.raw); } catch (_) { drop(); return null; }
    if (!d?.messages?.length) { drop(); return null; }
    // THE SAME CURRENCY CHECKS cachedThread() APPLIES. Without them a stash taken at push time was rendered as final content and
    // promoted into the body cache, so a reply that landed between the prefetch and the tap simply would not be in the
    // conversation, and the row would look cached afterwards.
    // T.lastMsgId is the authority: if the stash
    // does not contain the newest message this row knows about, it is out of date and the network is the right answer.
    const expected = t.kind === "gmail" ? t.count : null;
    if (expected && d.messages.length < expected) { drop(); return null; }
    if (t.lastMsgId && !d.messages.some((m) => m.id === t.lastMsgId)) { drop(); return null; }
    await cacheThread(t, d);
    drop();                        // only now, once the body cache actually holds it: claim, cache, THEN delete
    perf.record("open-thread:pushed", performance.now() - t0);   // was hard-coded 0: a metric that always reports 0 flatters the panel it feeds
    return d;
  } catch (_) { return null; }
}
// Nothing else prunes `meta`, and a pf: row is otherwise removed only when its conversation is opened, so a device that ignores
// its notifications kept one full format=full Gmail thread per push, for ever.
//  The worker caps and ages them on write; this is the page's own sweep.
async function sweepPushStash() {
  try {
    const all = await idb.getAll("meta");
    const dead = all.filter((r) => String(r.k).startsWith("pf:") && (!r.v?.at || Date.now() - r.v.at > PUSHED_MAX_AGE)).map((r) => r.k);
    if (dead.length) await idb.delAll("meta", dead);
  } catch (_) {}
}
// A stash holds a whole conversation the service worker already paid for at push time, but until now only
// pushedThread() could read one, and that needs a thread ROW to exist already. So mail that arrived while the app was
// closed had no row, and the list could not show it until refresh() finished a network sync: refresh:phase:sync,
// measured at 895 ms on my phone. That is the whole of the wait on open: the shell is local (first
// paint 119 ms, zero bytes, 2026-09-18 trace), the MAIL is not.
// Deriving the row from the bytes we already hold puts it on screen at storeReady instead (221 ms in the same trace,
// a 102 ms gap) with no network at all. The service worker stays dumb (it keeps writing raw payloads and nothing
// else) because the page's own adapters are the one projection, and forking derivation into sw.js is what all three
function rowFromStash(v) {
  if (v.kind === "gmail") return adapterFor(v.account).norm(v.raw);   // norm() already reads a raw Gmail thread; format=full is a superset of the metadata it wants
  // hub/imap: /api/threads/:id answers the DETAIL shape {thread, messages}, while hub.norm() reads the LIST shape.
  // The list row is rebuilt from those same bytes rather than a second projection being written anywhere.
  const t = v.raw?.thread, ms = v.raw?.messages || [];
  if (!t || !ms.length) return null;
  return hub.norm({ ...t, last: ms[ms.length - 1], msg_ids: ms.map((m) => m.message_id).filter(Boolean), message_count: ms.length });
}
async function adoptPushStashes() {
  const out = { found: 0, adopted: 0 };
  try {
    const all = await idb.getAll("meta");
    const stashes = all.filter((r) => String(r.k).startsWith("pf:"));
    const inStore = new Set(stashes.map((r) => r.k));
    for (const [k, v] of memStash) if (!inStore.has("pf:" + k)) stashes.push({ k: "pf:" + k, v, mem: true });   // held only in memory: a stalled store
    out.found = stashes.length;
    if (!stashes.length) return out;
    const pend = pendingKeysNow();
    const rows = [], dead = [];
    for (const r of stashes) {
      const v = r.v;
      if (!v?.raw || !v.at || Date.now() - v.at > PUSHED_MAX_AGE) { dead.push(r.k); continue; }
      const key = `${v.account}|${v.id}`;
      if (pend.has(key)) continue;          // a queued local action is the newer truth; adopting would re-show a row already archived here
      let row = null; try { row = rowFromStash(v); } catch (_) { row = null; }
      if (!row || row.key !== key) continue;
      // Adopt ONLY what the push was about: a new message in the inbox. Any other derived state means the stash is
      // describing something this code cannot confirm offline, and `gmailAdapter.norm()` resolves "archived" vs
      // "snoozed" from `state.snoozedGmail`, which loadAccounts() has not filled yet, so a non-inbox row derived here
      // could be wrong AND durable. Refusing to adopt them removes it entirely.
      if (row.state !== "inbox") { continue; }
      row.updatedAt = v.at;                 // the sync path's own convention, so the snapshot rev guard and prerender invalidation behave identically
      row._pushed = 1;                      // provenance: derived from a push stash, not yet confirmed by any sync
      const cur = state.threads.get(key);
      // >=, not >: adoption sets updatedAt = v.at, so a strict > re-derived and re-wrote every unclaimed stash on
      // EVERY boot until it was tapped or expired: 24 hours of redundant IndexedDB writes.
      // Hub rows carry `syncedAt` (Gmail rows get updatedAt = now when derived): on a resume the sync runs alongside this, and a hub
      // row it wrote after the push already holds the newer truth: an archive done on another device must not be undone here.
      if (cur && Math.max(cur.updatedAt || 0, cur.syncedAt || 0) >= v.at) continue;   // never move a row backwards: the cached copy may be newer than the push that stashed this
      if (cur) Object.assign(cur, row); else state.threads.set(key, row);
      rows.push(state.threads.get(key)); out.adopted++;
    }
    // The stash is NOT deleted here. pushedThread() still claims it on open (claim, cache, THEN delete) so the body
    // is still local when the conversation is tapped. Adopting only borrows the row; expiry is still what removes it.
    if (rows.length) await idb.putAll("threads", rows);
    if (dead.length) { for (const k of dead) memStash.delete(k.slice(3)); await idb.delAll("meta", dead); }
    // rebuildHubMsgIds is required: it is derived state with no durable copy, and a new hub row must enter the
    // dedupe set. markSnapshotDirty is deliberately NOT called: the snapshot is what paints at the SYNCHRONOUS first
    // paint of the next boot, and an unconfirmed row has no business there. refresh() marks it dirty a second later
    // once the sync has actually seen the row, which is the point at which it has earned a place in the snapshot.
    if (rows.length) rebuildHubMsgIds();
  } catch (_) {}
  return out;
}
async function cacheThread(t, d) { try { fillSnip(t, d.messages); } catch (_) {} try { const rows = d.messages.map((m) => ({ key: `${t.account}|${m.id}`, threadKey: t.key, id: m.id, date: m.date, at: Date.now(), m })); await idb.putAll("bodies", rows); searchIndex.indexBodies(t, d.messages.map(tagSafeMsg)); scheduleIdle(evictBodies); } catch (_) {} }
// Body cache LRU: keep the newest BODY_MAX rows by cache time; checked on idle after each cache write (count first, scan only when over).
const BODY_MAX = 800;
async function evictBodies() { try { if (evictBodies.busy) return; evictBodies.busy = true; const n = await idb.count("bodies"); if (n <= BODY_MAX) return; const all = await idb.getAll("bodies"); all.sort((a, b) => (a.at || 0) - (b.at || 0)); const drop = all.slice(0, n - BODY_MAX + 100); await idb.delAll("bodies", drop.map((r) => r.key)); } catch (_) {} finally { evictBodies.busy = false; } }
function nameFor(addr) { const i = state.me.identities.find((x) => x.email === lc(addr)); if (i) return i.display_name || ""; const im = imapAccts().find((x) => x.email === lc(addr)); if (im) return im.label || ""; const g = state.gmail.find((x) => x.email === lc(addr)); return g ? (g.label || "") : (state.me.identities[0]?.display_name || ""); }
// ---------- the back stack (Android's back gesture) ----------
// Opening a conversation, Settings, the composer or the side menu only toggled a CSS class, so the installed PWA put NOTHING on the
// history stack. Android's back gesture then found nothing to pop and CLOSED THE APP; the user's report: a back swipe should
// go back, not close the app. Every dismissable layer now owns one history entry, so the gesture unwinds the UI the
// way it does in every other Android app, and only leaves the app when there is genuinely nothing left to go back to.
const layers = [];
// Every layer owns one history entry, and each entry carries its depth (history.state.mhDepth: 1 for the first layer, 2 for the one
// above it). The stack is reconciled to the depth of whatever entry the browser lands on, so it no longer matters who moved
// history: a back gesture, an in-app close, or both at once.
// An in-app close (the Back chevron, Escape, Cancel) closes its layer at once and must consume its entry too, or the next back
// gesture would appear to do nothing. That step back waits for the end of the task, because a close is often half of a swap (the drawer's gear closes the drawer and opens Settings in one tap)
// and Chromium turns a pushState made while a history.back()
// is pending into a REPLACE, after which the back lands beneath the app (Playwright trace). A layer opened in that
// task reuses the entry instead, and the step back is only taken for what nothing reused.
const histDepth = () => (history.state && history.state.mhDepth) || 0;
let syncTimer = null;
function syncHistory() { syncTimer = null; const n = histDepth() - layers.length; if (n > 0) { try { history.go(-n); } catch (_) {} } }
const scheduleHistorySync = () => { if (!syncTimer) syncTimer = setTimeout(syncHistory, 0); };
function pushLayer(name, close, { under = null } = {}) {
  const top = layers[layers.length - 1];
  if (top && top.name === name) return;   // re-opening the same layer (next/prev conversation) must not stack entries
  // `under`: a layer that belongs beneath one still open. A conversation a notification opens while a message is being written goes
  // under the composer, which stays on top; closing it shows the conversation. Stack and history need only the same
  // depth, so the new entry is still pushed at the top.
  if (under && top && top.name === under && !top.spent) {
    const below = layers[layers.length - 2]; if (below && below.name === name && !below.spent) return;
    layers.splice(layers.length - 1, 0, { name, close });
  } else layers.push({ name, close });
  const want = layers.length, d = histDepth(), mh = layers[want - 1].name;
  if (d >= want) { if (d === want) { try { history.replaceState({ mh, mhDepth: want }, ""); } catch (_) {} } else scheduleHistorySync(); return; }
  try { history.pushState({ mh, mhDepth: want }, ""); } catch (_) {}
}
function dropLayer(name) {
  // The topmost layer of that name that is still open. Looked up from the bottom, a closed ("spent") layer left
  // under others answered every lookup of its name and did nothing: after a notification opened a conversation over a PDF, back and
  // the Back chevron stayed dead until the app restarted. With none open it is false, and the caller closes directly.
  let i = layers.length - 1; while (i >= 0 && (layers[i].name !== name || layers[i].spent)) i--;
  if (i < 0) return false;
  if (i === layers.length - 1) { const l = layers.pop(); if (!l.spent) { try { l.close(); } catch (_) {} } scheduleHistorySync(); return true; }
  // Buried under another layer. It must NOT be spliced out: history would stay one entry deeper than `layers` for ever, and a
  // later back press would land on that orphan and appear to do nothing at all. Close it now, but leave it on the stack as spent,
  // so its history entry is still consumed when popstate eventually reaches it. Stack depth and history depth stay equal.
  const l = layers[i];
  if (!l.spent) { l.spent = true; try { l.close(); } catch (_) {} }
  return true;
}
addEventListener("popstate", () => { const d = histDepth(); while (layers.length > d) { const l = layers.pop(); if (!l.spent) { try { l.close(); } catch (_) {} } } });
// The Android app's back button asks this first (window.mh.back): true = a layer was closed here, false = nothing open, leave the app.
function backLayer() {
  if (cancelCard()) return true;   // a card (snooze times, a prompt) sits over every layer: back closes it, not the conversation under it
  while (layers.length && layers[layers.length - 1].spent) layers.pop();   // already closed: their entries go with the step back below
  const top = layers[layers.length - 1];
  if (!top) { scheduleHistorySync(); return false; }
  dropLayer(top.name); return true;
}
if (histDepth() > 0) scheduleHistorySync();   // a reload or a restored WebView can land on a layer entry with no layer open: step back to the base
const closeThreadView = () => { $("#app").classList.remove("viewing", "replying"); };
// On a phone the reply box is a sheet, closed until Reply (it took a third of the screen whether or not a reply was coming). It is a
// layer of its own, so back closes the sheet before the conversation. Elsewhere it is always open and this only focuses it.
function openReplySheet({ all } = {}) {
  if (!state.replyTo) return;   // a conversation with no message has no one to reply to
  if (all !== undefined) $("#rall").checked = all;   // Reply unticks a Reply all left from before (it stayed ticked;
  if (phoneUI() && !$("#app").classList.contains("replying")) { $("#app").classList.add("replying"); pushLayer("reply", () => $("#app").classList.remove("replying")); }
  $("#rtext").focus();
}
function closeReplySheet() { if ($("#app").classList.contains("replying") && !dropLayer("reply")) $("#app").classList.remove("replying"); }
$("#back").onclick = () => { closeReplySheet(); if (!dropLayer("thread")) closeThreadView(); };
$("#rclose").onclick = () => closeReplySheet();
$$("#actions button").forEach((b) => b.onclick = (e) => { const t = state.threads.get(state.cur); if (!t) return; let k = b.dataset.act; if (k === "restore" && t.state === "spam") k = "notspam"; if (k === "forward") return openCompose({ forward: true }); if (k === "replyall") return openReplySheet({ all: true }); if (k === "reply") return openReplySheet({ all: false }); if (k === "more") return openMenu(e, t); if (k === "find") return openFind(); actFlow(t, k); });
// "Don't notify me about mail like this". One card: the subject's words as chips to tap on and off, then this subject
// from this sender, or anything from this sender. A rule matches a subject holding every chosen word, in any order. Words with digits
// start off: Uber's sign-in mail is "Do not share: 1234" with a new code each time, and on a phone choosing part of the subject has to
// be a tap, not an edit . Venmo's resets come from the same address as its receipts, so a subject rule leads.
// The buttons a phone notification can carry (the hub's NOTIFY_BUTTONS; Notify.kt draws them).
const NOTIFY_BUTTON_CHOICES = [["", "No button"], ["done", "Done"], ["read", "Mark read"], ["trash", "Trash"], ["snooze", "Snooze (until 8 AM tomorrow)"], ["quiet", "Stop these (don't notify)"], ["reply", "Reply (typed into the notification; phone only)"]];
const notifyButtonsPref = () => Array.isArray(prefs().notifyButtons) ? prefs().notifyButtons : ["done", "read", "quiet"];
async function addQuiet(sender, subject) {
  const r = await api("/api/quiet-rules", { method: "POST", body: JSON.stringify({ sender, subject }) });
  state.quiet = [r.rule, ...(state.quiet || []).filter((x) => x.id !== r.rule.id)]; return r.rule;
}
const quietWordsOf = (s) => String(s || "").replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
function quietFor(t) {
  const sender = lc(t.fromAddr || ""), words = quietWordsOf(t.subject);
  if (!sender) return toast("This conversation has no sender address");
  const on = words.map((w) => !/\d/.test(w)); if (!on.some(Boolean)) on.fill(true);
  const chosen = () => words.filter((w, i) => on[i]);
  const finish = () => releaseModal(onCancel); const onCancel = () => finish(); claimModal(onCancel);
  const BTN = "width:100%;justify-content:flex-start;white-space:normal;text-align:left;margin-bottom:6px";
  $("#tcard").innerHTML = `<h3 style="font-size:15px;margin:0 0 4px">Don't notify me about…</h3><div style="color:var(--mut);font-size:13px;margin-bottom:10px">The mail still arrives. Only the notification is skipped, on every device.</div>`
    + (words.length ? `<div style="font-size:13px;color:var(--mut);margin-bottom:6px">Subject words to match — tap to choose</div><div class="qwords">${words.map((w, i) => `<button class="qw${on[i] ? " on" : ""}" data-w="${i}" aria-pressed="${on[i]}">${esc(w)}</button>`).join("")}</div>`
      + `<button class="primary" data-q="subject" style="${BTN}"></button>` : "")
    + `<button data-q="sender" style="${BTN}">Anything from ${esc(sender)}</button>`
    + `<div class="row" style="justify-content:flex-end"><button class="ghost" data-q="cancel">Cancel</button></div>`;
  const sub = $("#tcard [data-q=\"subject\"]");
  const draw = () => { if (!sub) return; const c = chosen(); sub.disabled = !c.length; sub.textContent = c.length ? `“${c.join(" ")}” from ${sender}` : "Choose at least one word"; };
  $("#tcard").querySelectorAll("[data-w]").forEach((b) => b.onclick = () => { const i = +b.dataset.w; on[i] = !on[i]; b.classList.toggle("on", on[i]); b.setAttribute("aria-pressed", String(on[i])); draw(); });
  draw(); $("#tmodal").classList.add("on");
  $("#tcard").querySelectorAll("[data-q]").forEach((b) => b.onclick = async () => { finish(); if (b.dataset.q === "cancel") return;
    try { const r = await addQuiet(sender, b.dataset.q === "subject" ? chosen().join(" ") : ""); toast(`No more notifications for ${r.subject ? `“${r.subject}” from ` : "anything from "}${r.sender}`); } catch (e) { toast(e.message); } });
  (sub || $("#tcard [data-q]"))?.focus?.();
}
// "Trash mail like this": the user's own rule, made from the conversation in front of him, for mail whose address keeps
// changing (the "Webmail" phish came from three domains in a month). The sender's name and the subject are word chips to tap on and off,
// matched as the hub matches them: every chosen word, in any order, both fields when both have words. Digits start off, as in Don't
// notify. Then where it applies: this address, every address at its domain, or every account. Saving trashes what matches on screen,
// with Undo; the hub trashes what arrives.
const trashRuleName = (t) => { const f = String(t.from || ""), i = f.lastIndexOf("<"); return i > 0 ? f.slice(0, i).replace(/"/g, "").trim() : ""; };
const trashRuleAcct = (t) => lc(t.kind === "hub" ? t.identity || "" : t.account || "");
const trashWordsOf = (s) => quietWordsOf(s).map(lc);
function trashRuleHits(r, t) {
  const acct = trashRuleAcct(t), dom = acct.split("@")[1] || "";
  if (!(r.scope === "*" || r.scope === acct || (r.scope.startsWith("*@") && r.scope.slice(2) === dom))) return false;
  if (!r.name && !r.subject) return false;
  if (r.name) { const w = new Set(trashWordsOf(trashRuleName(t))); if (!r.name.split(" ").every((x) => w.has(x))) return false; }
  if (r.subject) { const w = new Set(trashWordsOf(t.subject)); if (!r.subject.split(" ").every((x) => w.has(x))) return false; }
  return true;
}
const trashRuleRows = (r) => [...state.threads.values()].filter((x) => !x.out && !isHubCopy(x) && x.state === "inbox" && trashRuleHits(r, x));
const trashScopeLabel = (s) => s === "*" ? "every account" : s.startsWith("*@") ? "anything @" + s.slice(2) : s;
const trashRuleText = (r) => [r.name ? `sender named “${r.name}”` : "", r.subject ? `subject with “${r.subject}”` : ""].filter(Boolean).join(" and ");
async function addTrashRule(r) {
  const res = await api("/api/trash-rules", { method: "POST", body: JSON.stringify(r) });
  state.trashRules = [res.rule, ...(state.trashRules || []).filter((x) => x.id !== res.rule.id)]; return res.rule;
}
// Saves the rule, then trashes the matching conversations on screen as one bulk job, so the toast's Undo brings them back (the rule stays).
// The toast goes up before bulk() returns: bulk logs the job first thing (so Undo finds it at once), but it can wait up to 3 s for the
// service worker before returning. The card has already shown how many match (`shown`); Settings' form asks first when it is a lot.
async function saveTrashRule(r, { shown = false } = {}) {
  let rule; try { rule = await addTrashRule(r); } catch (e) { return toast(e.message); }
  const rows = trashRuleRows(rule), id = uuid4(), text = `Rule added: ${trashRuleText(rule)} goes to Trash`;
  if (!rows.length) { toast(text, 4000); return rule; }
  if (!shown && rows.length > 50 && !(await ask(`Also move the ${rows.length} conversations in your inbox that match to Trash? Undo stays available for 7 days.`, { ok: "Trash them", cancel: "Only new mail", danger: true }))) { toast(text, 4000); return rule; }
  const job = bulk("trash", rows, { quiet: true, id, inPlace: true, sure: true });
  toast(`${text} · ${rows.length} trashed now`, 6000, () => bulkUndo(id));
  await job; return rule;
}
function trashRuleFor(t) {
  const acct = trashRuleAcct(t), dom = acct.split("@")[1] || "";
  if (!acct) return toast("This conversation has no account address");
  const nameW = quietWordsOf(trashRuleName(t)), subjW = quietWordsOf(t.subject === "(no subject)" ? "" : t.subject);
  if (!nameW.length && !subjW.length) return toast("This conversation has no sender name or subject to match");
  const onN = nameW.map(() => true), onS = subjW.map((w) => !/\d/.test(w)); if (subjW.length && !onS.some(Boolean)) onS.fill(true);
  const scopes = [[acct, acct], ...(dom ? [["*@" + dom, "Anything @" + dom]] : []), ["*", "Every account"]];
  let scope = acct;
  const rule = () => ({ scope, name: nameW.filter((w, i) => onN[i]).join(" ").toLowerCase(), subject: subjW.filter((w, i) => onS[i]).join(" ").toLowerCase() });
  const finish = () => releaseModal(onCancel); const onCancel = () => finish(); claimModal(onCancel);
  const LBL = "font-size:13px;color:var(--mut);margin:10px 0 6px";
  const chips = (ws, on, k) => `<div class="qwords">${ws.map((w, i) => `<button class="qw${on[i] ? " on" : ""}" data-${k}="${i}" aria-pressed="${on[i]}">${esc(w)}</button>`).join("")}</div>`;
  $("#tcard").innerHTML = `<h3 style="font-size:15px;margin:0 0 4px">Trash mail like this</h3><div style="color:var(--mut);font-size:13px">From now on it goes straight to Trash, with no notification. Trash keeps it 30 days.</div>`
    + (nameW.length ? `<div style="${LBL}">Sender's name — tap to choose</div>${chips(nameW, onN, "n")}` : "")
    + (subjW.length ? `<div style="${LBL}">Subject — tap to choose</div>${chips(subjW, onS, "s")}` : "")
    + `<div style="${LBL}">Mail to</div><div class="qwords">${scopes.map(([v, l]) => `<button class="qw${v === scope ? " on" : ""}" data-sc="${esc(v)}" aria-pressed="${v === scope}">${esc(l)}</button>`).join("")}</div>`
    + `<div id="trwhat" style="font-size:13px;margin:12px 0 10px;overflow-wrap:anywhere"></div>`
    + `<div class="row" style="justify-content:flex-end;gap:8px"><button class="ghost" data-tr="cancel">Cancel</button><button class="primary" data-tr="save">Trash these</button></div>`;
  const save = $("#tcard [data-tr=\"save\"]");
  const draw = () => { const r = rule(), ok = !!(r.name || r.subject), n = ok ? trashRuleRows(r).length : 0; save.disabled = !ok;
    $("#trwhat").innerHTML = ok ? `${esc(trashRuleText(r)[0].toUpperCase() + trashRuleText(r).slice(1))}, to ${esc(trashScopeLabel(r.scope))}.<br><span style="color:var(--mut)">${n ? `${n} conversation${n === 1 ? "" : "s"} in your inbox now match${n === 1 ? "es" : ""}; ${n === 1 ? "it goes" : "they go"} to Trash too.` : "Nothing in your inbox matches now."}</span>` : `<span style="color:var(--mut)">Choose at least one word.</span>`; };
  const tap = (sel, on) => $("#tcard").querySelectorAll(`[data-${sel}]`).forEach((b) => b.onclick = () => { const i = +b.dataset[sel]; on[i] = !on[i]; b.classList.toggle("on", on[i]); b.setAttribute("aria-pressed", String(on[i])); draw(); });
  tap("n", onN); tap("s", onS);
  $("#tcard").querySelectorAll("[data-sc]").forEach((b) => b.onclick = () => { scope = b.dataset.sc; $("#tcard").querySelectorAll("[data-sc]").forEach((x) => { const on = x.dataset.sc === scope; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); }); draw(); });
  $("#tcard").querySelectorAll("[data-tr]").forEach((b) => b.onclick = async () => { const r = rule(); finish(); if (b.dataset.tr === "save") await saveTrashRule(r, { shown: true }); });
  draw(); $("#tmodal").classList.add("on"); save.focus();
}
// "Delete unless it mentions…" from a Gmail conversation (the rules, made where the mail is; rules should be added and
// removed from the mail itself). The sender is this address or anything at its organisation's domain (updates.events.example
// offers events.example, as the starter rules were written); a personal-mail domain is never offered, and the hub refuses one anyway.
// The words start as the rule this sender would replace, else as the account's latest rule (the starter rules all keep "SXSW, South by
// Southwest"). Rules that already cover this sender are listed with Remove. The same sender and account again replaces the words.
// Mail already here (one step to trash a sender's mail except what mentions the words): the conversations this device holds
// from the sender in that account, in an inbox or from the last 90 days (what Unread lists), never one you wrote in. The hub reads
// each as the rule reads new mail (/api/mention-rules/check) and names those that mention none of the words; with the box ticked, as
// it starts, they go to Trash when the rule is added, as one job with Undo.
const MENTION_CHECK_MAX = 100;   // index.js MENTION_CHECK_MAX: the newest this many are checked
// Mail at your own domains and the work mailbox: one scope, "hub" (index.js MENTION_HUB), decided as it arrives.
const MENTION_HUB_LABEL = "Your domains and work mailbox";
const mentionScopeLabel = (s) => s === "*" ? "Every Gmail account" : s === "hub" ? MENTION_HUB_LABEL : (state.gmail.find((g) => lc(g.email) === lc(s))?.label || s);
const MENTION_SUFFIX = /^(co|com|net|org|gov|edu|ac|or|ne|go|ltd|plc|nom|gob|mil)\.[a-z]{2}$/;   // index.js MENTION_DOMAIN_REFUSED, second half
const mentionCovers = (r, addr) => { const d = addr.split("@")[1] || "", p = r.pattern.slice(2); return r.pattern === addr || (r.pattern.startsWith("*@") && (d === p || d.endsWith("." + p))); };
const mentionWordsOf = (s) => { const seen = new Set(); return String(s || "").split(",").map((w) => w.replace(/\s+/g, " ").trim()).filter((w) => w && !seen.has(lc(w)) && seen.add(lc(w))); };   // the hub matches in any case
const mentionQuote = (ws) => ws.map((w) => `“${w}”`).join(" or ");
async function mentionRuleFor(t) {
  const gm = t.kind === "gmail", acct = gm ? lc(t.account || "") : "hub", addr = lc(t.fromAddr || ""), dom = addr.split("@")[1] || "";
  if (!acct) return toast("This conversation has no account");
  if (!dom.includes(".")) return toast("This conversation has no sender address");
  if (!state.mention) state.mention = await api("/api/mention-rules").catch(() => null);   // fetched with Settings; this may come first
  let root = typeof trustRoot === "function" ? trustRoot(dom) : dom; if (MENTION_SUFFIX.test(root)) root = dom;
  const senders = [[addr, "Only " + addr], ...(isPublicMailbox(addr) || MENTION_SUFFIX.test(root) ? [] : [["*@" + root, "Anything @" + root]])];
  const acctLabel = mentionScopeLabel(acct);
  const scopes = gm ? [[acct, acctLabel], ["*", "Every Gmail account"]] : [["hub", MENTION_HUB_LABEL]];
  const rules = () => state.mention?.rules || [];
  const inScope = (r) => r.scope === acct || (gm && r.scope === "*");
  const covering = () => rules().filter((r) => inScope(r) && mentionCovers(r, addr));
  const first = covering().find((r) => senders.some(([v]) => v === r.pattern));
  let sender = first?.pattern || senders[senders.length - 1][0], scope = first?.scope || acct, typed = false;
  const same = () => rules().find((r) => r.pattern === sender && r.scope === scope);
  const startWords = () => (same() || rules().find(inScope) || (gm ? null : rules()[0]))?.words || [];   // mail outside Gmail with no rule of its own yet: the latest rule's words
  let oldTimer = 0, sweep = true, old = { key: "", drop: [], n: 0, done: true, p: null, ws: [] };
  const finish = () => { clearTimeout(oldTimer); releaseModal(onCancel); }; const onCancel = () => finish(); claimModal(onCancel);
  const LBL = "font-size:13px;color:var(--mut);margin:10px 0 6px";
  const pick = (list, cur, k) => `<div class="qwords">${list.map(([v, l]) => `<button class="qw${v === cur ? " on" : ""}" data-${k}="${esc(v)}" aria-pressed="${v === cur}">${esc(l)}</button>`).join("")}</div>`;
  $("#tcard").innerHTML = `<h3 style="font-size:15px;margin:0 0 4px">Delete unless it mentions…</h3><div style="color:var(--mut);font-size:13px">New mail from this sender is read when it arrives. ${gm ? "If it mentions one of the words it stays, or leaves Spam, and notifies you. If not, it goes to Gmail's trash, which keeps it 30 days." : "If it mentions one of the words it stays and notifies you. If not, it goes to Trash, which keeps it 30 days."}</div>`
    + `<div id="mhave"></div>`
    + `<div style="${LBL}">From</div>${pick(senders, sender, "ms")}`
    + `<div style="${LBL}">Words that keep it, comma-separated</div><input class="f" id="mcwords" style="width:100%;box-sizing:border-box" aria-label="Words that keep the mail" placeholder="e.g. SXSW, South by Southwest">`
    + `<div style="${LBL}">In</div>${pick(scopes, scope, "mc")}`
    + `<div id="mwhat" style="font-size:13px;margin:12px 0 8px;overflow-wrap:anywhere"></div>`
    + `<div id="mold" style="font-size:13px;margin:0 0 10px;overflow-wrap:anywhere"></div>`
    + `<div class="row" style="justify-content:flex-end;gap:8px"><button class="ghost" data-mr="cancel">Cancel</button><button class="primary" data-mr="save">Add rule</button></div>`;
  const input = $("#mcwords"), save = $("#tcard [data-mr=\"save\"]");
  const heldNow = () => [...state.threads.values()].filter((x) => x.kind === (gm ? "gmail" : "hub") && !x.out && !x.hasOut && !(x.labels || []).includes("SENT") && x.state !== "trash" && x.state !== "spam" && x.fromAddr
    && (!gm || scope === "*" || lc(x.account) === scope) && mentionCovers({ pattern: sender }, lc(x.fromAddr)) && (x.state === "inbox" || (x.date || 0) >= Date.now() - SYNC.windowDays * 864e5))
    .sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, MENTION_CHECK_MAX);
  const many = (n, one, more) => n === 1 ? one : more;
  const drawOld = () => {
    const el = $("#mold"), ws = old.ws; if (!el || !input.isConnected) return;   // a check back after the card closed draws nothing
    if (!old.n || bad(mentionWordsOf(input.value))) { el.innerHTML = ""; return; }
    if (!old.done) { el.innerHTML = `<span style="color:var(--mut)">Checking the ${many(old.n, "conversation", old.n + " conversations")} from this sender already here…</span>`; return; }
    if (old.failed) { el.innerHTML = `<span style="color:var(--mut)">The mail already here could not be checked, so it stays where it is.</span>`; return; }
    const d = old.drop.length;
    if (!d) { el.innerHTML = `<span style="color:var(--mut)">Nothing already here goes: ${many(old.n, "the one from this sender here mentions", `the ${old.n} from this sender here mention`)} ${esc(mentionQuote(ws))}, or ${many(old.n, "is", "are")} too short to tell.</span>`; return; }
    el.innerHTML = `<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer"><input type="checkbox" id="moldbox"${sweep ? " checked" : ""} style="margin:2px 0 0"><span>Also trash ${many(d, "the one", "the " + d)} already here that ${many(d, "doesn't", "don't")} mention ${esc(mentionQuote(ws))}<span style="color:var(--mut)"> (of ${old.n} from this sender here)</span></span></label>`
      + `<div style="color:var(--mut);margin:4px 0 0 24px">${old.drop.slice(0, 4).map((x) => esc(x.subject || "(no subject)")).join("<br>")}${d > 4 ? `<br>and ${d - 4} more` : ""}</div>`;
    $("#moldbox").onchange = (ev) => { sweep = ev.target.checked; };
  };
  const checkOld = () => {
    const ws = mentionWordsOf(input.value); if (bad(ws)) return drawOld();
    const list = heldNow(), key = `${sender}|${scope}|${ws.map(lc).join(",")}|${list.map((x) => x.key).join(",")}`; if (key === old.key) return;
    const me = old = { key, drop: [], n: list.length, done: !list.length, p: null, ws }; drawOld(); if (!list.length) return;
    me.p = api("/api/mention-rules/check", { method: "POST", body: JSON.stringify({ words: ws, threads: list.map((x) => ({ account: x.account, thread: x.id })) }) })
      .then((r) => { const gone = new Set((r?.results || []).filter((x) => x && x.d === "drop").map((x) => lc(x.account) + "|" + x.thread)); me.drop = list.filter((x) => gone.has(lc(x.account) + "|" + x.id)); })
      .catch(() => { me.failed = true; })
      .finally(() => { me.done = true; if (old === me) drawOld(); });
  };
  input.value = startWords().join(", ");
  const bad = (ws) => !ws.length ? "Give at least one word." : ws.length > 10 ? "At most 10 words." : ws.some((w) => w.length < 2 || w.length > 60) ? "Each word is 2 to 60 characters." : "";
  const draw = () => {
    const ws = mentionWordsOf(input.value), why = bad(ws), prior = same(), from = sender.startsWith("*@") ? "anything @" + sender.slice(2) : sender;
    save.disabled = !!why; save.textContent = prior ? "Update rule" : "Add rule";
    $("#mwhat").innerHTML = why ? `<span style="color:var(--mut)">${esc(why)}</span>` : `New mail from ${esc(from)} in ${esc(scope === "*" ? "every Gmail account" : gm ? acctLabel : "your domains and work mailbox")} goes to ${gm ? "Gmail's trash" : "Trash"} unless it mentions ${esc(mentionQuote(ws))}.${prior ? `<br><span style="color:var(--mut)">This replaces the words of the rule for ${esc(from)}.</span>` : ""}`;
    clearTimeout(oldTimer); oldTimer = setTimeout(checkOld, typed ? 500 : 0); drawOld();
    const have = covering();
    $("#mhave").innerHTML = have.length ? `<div style="${LBL}">Already deleting this sender's mail</div>` + have.map((r) => `<div class="row" style="gap:8px;align-items:center;font-size:13px;margin-bottom:4px"><div style="flex:1;min-width:0;overflow-wrap:anywhere"><b>${esc(r.pattern)}</b> · ${esc(r.scope === "*" ? "every Gmail account" : acctLabel)} · ${esc(mentionQuote(r.words || []))}<br><span style="color:var(--mut)">kept ${r.kept || 0}, deleted ${r.dropped || 0}</span></div><button class="ghost" data-mdelc="${esc(r.id)}">Remove</button></div>`).join("") : "";
    $("#mhave").querySelectorAll("[data-mdelc]").forEach((b) => b.onclick = async () => {
      try { await api("/api/mention-rules/" + b.dataset.mdelc, { method: "DELETE" }); const r = rules().find((x) => x.id === b.dataset.mdelc); state.mention.rules = rules().filter((x) => x.id !== b.dataset.mdelc); toast(`Rule removed: mail from ${r?.pattern || "this sender"} is no longer deleted`); draw(); } catch (e) { toast(e.message); } });
  };
  const choose = (k, set) => $("#tcard").querySelectorAll(`[data-${k}]`).forEach((b) => b.onclick = () => { set(b.dataset[k]); $("#tcard").querySelectorAll(`[data-${k}]`).forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); }); if (!typed) input.value = startWords().join(", "); draw(); });
  choose("ms", (v) => { sender = v; }); choose("mc", (v) => { scope = v; });
  input.oninput = () => { typed = true; draw(); };
  input.onkeydown = (e) => { if (e.key === "Enter" && !save.disabled) { e.preventDefault(); save.click(); } };
  $("#tcard").querySelectorAll("[data-mr]").forEach((b) => b.onclick = async () => { const words = mentionWordsOf(input.value), pattern = sender, sc = scope, doOld = b.dataset.mr === "save" && sweep;
    if (doOld) checkOld(); const me = old; finish(); if (b.dataset.mr !== "save") return;   // a check not back yet is waited for: the box was ticked
    try { const r = await api("/api/mention-rules", { method: "POST", body: JSON.stringify({ pattern, words, scope: sc }) });
      state.mention = { recent: [], ...state.mention, rules: [r.rule, ...rules().filter((x) => x.id !== r.rule.id)] };
      const said = `Rule added: new mail from ${pattern.startsWith("*@") ? "anything @" + pattern.slice(2) : pattern} is deleted unless it mentions ${mentionQuote(r.rule.words || words)}`;
      if (doOld && me.p) await me.p;
      const drop = doOld && !me.failed ? me.drop.map((x) => state.threads.get(x.key)).filter((x) => x && x.state !== "trash" && x.state !== "spam") : [];
      if (!drop.length) return toast(said, 5000);
      const id = uuid4(); bulk("trash", drop, { quiet: true, id, sure: true });
      toast(`${said}. ${drop.length === 1 ? "The one" : "The " + drop.length} already here that ${drop.length === 1 ? "doesn't" : "don't"} went to Trash`, 7000, () => bulkUndo(id)); } catch (e) { toast(e.message); } });
  draw(); $("#tmodal").classList.add("on"); input.focus();
}
// The full menu for a conversation, grouped by what it acts on, the most used first: Spam and Delete unless it mentions…
// count most, the categories least. This sender (Spam, Delete unless it mentions…, Unsubscribe, Block, everything from the sender,
// Trash mail like this…), This conversation, then Sorting, small,
// its three categories folded into one row that opens them. On a phone it is a sheet from the bottom that scrolls, the bar's other
// conversation actions one row of tiles at its top: the 23-row menu it replaces could not scroll, ran about 900 px tall at phone size,
// and its last row, Report spam, sat below the screen (measured at 411 x 830).
function openMenu(e, t, at = null) {   // at: {x, y}, a right-click's point (More… in the quick menu)
  const p = prefs(), m = $("#menu"), cat = catOf(t), phone = phoneUI() && !at, gm = t.kind === "gmail", theirs = !t.out && !!t.fromAddr, n = senderThreads(t).length;
  const row = ([k, l, i]) => `<button data-m="${k}">${ico(i)}${esc(l)}${k === "catpick" ? `<span class="mchev">${ico("chevron")}</span>` : ""}</button>`;   // labels carry sender addresses: always escaped
  const group = (title, rows, cls = "") => rows.length ? `<div class="mh">${title}</div><div class="mg${cls}">${rows.map(row).join("")}</div>` : "";
  const tiles = phone ? `<div class="mtiles">${[["replyall", "Reply all", "replyall", "Reply all"], ["forward", "Forward", "forward", "Forward"], ["remind", "Remind", "remind", "Remind me"], ["star", t.starred ? "Unpin" : "Pin", "pin", t.starred ? "Unpin" : "Pin"], ["unread", "Unread", "unread", "Mark unread"], ["find", "Find", "search", "Find in this conversation"]].map(([k, l, i, full]) => `<button data-m="${k}" title="${full}" aria-label="${full}">${ico(i)}<span>${l}</span></button>`).join("")}</div>` : "";
  const sender = theirs ? [
    gm ? (t.state === "spam" ? ["notspam", "Not spam", "inbox"] : ["spam", "Report spam (Gmail)", "spam"]) : ["spam", "Spam: trash it and block the sender", "spam"],
    ["mentionrule", "Delete unless it mentions…", "filter"],
    ...(t.unsub ? [["unsubscribe", "Unsubscribe from " + t.fromAddr, "unsub"]] : []),
    ["block", "Block " + t.fromAddr, "block"],
    ["trashall", `Trash all from ${t.fromAddr} (${n} ${senderScope()})`, "trash"],
    ["doneall", `Done all from ${t.fromAddr} (${n} ${senderScope()})`, "done"],
    ["trashrule", "Trash mail like this…", "trash"]] : [];
  const convo = [["replylater", (p.replyLater.includes(t.key) ? "Remove from" : "Add to") + " Reply later", "replylater"], ["aside", (p.setAside.includes(t.key) ? "Remove from" : "Move to") + " Set aside", "aside"],
    ["mute", (p.muted.includes(t.key) ? "Unmute" : "Mute") + " this conversation", "mute"], ["prithread", (p.priorityThreads.includes(t.key) ? "Unmark" : "Mark") + " thread as priority", "star"],
    ["rename", "Rename subject (only for you)", "compose"], ...(t.state === "trash" && t.kind === "hub" ? [["purge", "Delete forever", "trash"]] : [])];
  const sorting = [["catpick", "Category: " + (CATS[cat] || "none"), CATS[cat] ? cat : "filter"], ...(t.fromAddr ? [["priority", "Priority sender: " + t.fromAddr, "star"]] : []), ["quiet", "Don't notify me about mail like this…", "notifications"]];
  m.innerHTML = tiles + group("This sender", sender) + group("This conversation", convo) + group("Sorting", sorting, " sm");
  const bind = () => m.querySelectorAll("[data-m]").forEach((b) => b.onclick = async (ev) => {
    const k = b.dataset.m;
    if (k === "catpick") {   // the categories open in place; the menu stays
      ev.stopPropagation(); const auto = !!senderRule(t.fromAddr, t.account)?.category;
      b.outerHTML = `<div class="mchips">${[...Object.entries(CATS), ...(auto ? [["auto", "Automatic"]] : [])].map(([c, l]) => `<button data-m="cat:${c}"${c === cat ? ' class="on" aria-pressed="true"' : ""}>${esc(l)}</button>`).join("")}</div>`;
      return bind();
    }
    m.classList.remove("on"); if (k === "quiet") return quietFor(t); if (k === "trashrule") return trashRuleFor(t); if (k === "mentionrule") return mentionRuleFor(t); if (k === "find") return openFind(); if (k === "forward") return openCompose({ forward: true }); if (k === "replyall") return openReplySheet({ all: true }); if (k === "purge" && !(await ask("Delete this conversation forever?", { ok: "Delete forever", danger: true }))) return; (ADVANCES.has(k) ? actFlow : act)(t, k); });   // spam/trash from the menu behave like the # key: gone, next one opens
  bind();
  m.onclick = (ev) => { if (!ev.target.closest("button")) ev.stopPropagation(); };   // a tap on a heading or between rows leaves it open
  m.classList.toggle("sheet", phone); m.classList.add("on"); m.scrollTop = 0;
  if (phone) { m.style.left = m.style.top = ""; }
  else {
    const r = at ? { left: at.x, top: at.y, bottom: at.y } : (e.target.closest("button") || e.target).getBoundingClientRect(); m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
    const h = m.offsetHeight; m.style.top = (r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";   // a button in a bottom bar opens it upward
  }
  setTimeout(() => document.addEventListener("click", () => m.classList.remove("on"), { once: true }), 0);
}
// Right-click (Ctrl-click on the Mac) on a row in the list: the ways to get rid of that mail, without opening it (
// a right-click should offer a few quick ways to get rid of a mail, spam among them, without opening it
// first). On a row in a selection of several, it acts on all of them. More… is the full menu. A
// touch long press still selects; this is for a mouse or a trackpad.
function openQuickMenu(e, t) {
  const m = $("#menu"), at = { x: e.clientX, y: e.clientY }; m.classList.remove("sheet");
  const sel = state.checked.has(t.key) && state.checked.size > 1 ? [...state.checked].map(threadFor).filter(Boolean) : null;
  let items;
  if (sel) {
    const gm = sel.filter(spamAble), senders = [...new Map(sel.filter((x) => !x.out && x.fromAddr).map((x) => [lc(x.fromAddr), x])).values()];
    items = [["trash", `Trash ${sel.length} conversations`, "trash"],
      ...(gm.length ? [["spam", `Spam: ${gm.length === sel.length ? gm.length : `${gm.length} of them`}`, "spam"]] : []),
      ...(senders.length ? [["block", senders.length === 1 ? "Block " + senders[0].fromAddr : `Block ${senders.length} senders`, "block"]] : [])];
    m.innerHTML = items.map(([k, l, i]) => `<button data-qm="${k}">${ico(i)}${esc(l)}</button>`).join("");
    m.querySelectorAll("[data-qm]").forEach((b) => b.onclick = async () => { close(); const k = b.dataset.qm;
      if (k === "trash") { clearSelection(); return bulk("trash", sel); }
      if (k === "spam") { clearSelection(); return spamMany(sel); }
      if (!(await ask(`Block ${senders.length === 1 ? senders[0].fromAddr : senders.length + " senders"}? Future mail from ${senders.length === 1 ? "this sender" : "them"} goes straight to trash in every account.`, { ok: "Block", danger: true }))) return;
      clearSelection(); let n = 0; for (const x of senders) if (await act(x, "block", { quiet: true })) n++;
      toast(`Blocked ${n} sender${n === 1 ? "" : "s"}`); });
  } else {
    const n = senderThreads(t).length, theirs = (x) => t.out ? [] : [x];   // sender actions: never on your own sent mail
    items = [...(t.state !== "trash" ? [["trash", "Trash", "trash"]] : t.kind === "hub" ? [["purge", "Delete forever", "trash"]] : []),
      ...(t.kind === "gmail" && t.state !== "spam" ? [["spam", "Report spam (Gmail)", "spam"]] : t.kind !== "gmail" ? theirs(["spam", "Spam: trash it and block the sender", "spam"]) : []),
      ...theirs(["mentionrule", "Delete unless it mentions…", "filter"]),
      ...(t.unsub && !t.out ? [["unsubscribe", "Unsubscribe from " + t.fromAddr, "unsub"]] : []),
      ...theirs(["block", "Block " + t.fromAddr, "block"]),
      ...theirs(["trashall", `Trash all from ${t.fromAddr} (${n} ${senderScope()})`, "trash"]),
      ...theirs(["trashrule", "Trash mail like this…", "trash"]),
      ["more", "More…", "more"]];
    m.innerHTML = items.map(([k, l, i]) => (k === "more" ? '<hr style="border:0;border-top:1px solid var(--line);margin:4px 0">' : "") + `<button data-qm="${k}">${ico(i)}${esc(l)}</button>`).join("");   // labels carry sender addresses: always escaped
    m.querySelectorAll("[data-qm]").forEach((b) => b.onclick = async (ev) => { ev.stopPropagation(); close(); const k = b.dataset.qm, lt = state.threads.get(t.key) || t;
      if (k === "more") return openMenu(ev, lt, at);
      if (k === "trashrule") return trashRuleFor(lt);
      if (k === "mentionrule") return mentionRuleFor(lt);
      if (k === "purge" && !(await ask("Delete this conversation forever?", { ok: "Delete forever", danger: true }))) return;
      return (ADVANCES.has(k) ? actFlow : act)(lt, k); });
  }
  m.classList.add("on"); m.style.left = Math.max(8, Math.min(at.x, window.innerWidth - m.offsetWidth - 8)) + "px";
  const h = m.offsetHeight; m.style.top = Math.max(8, at.y + h > window.innerHeight - 8 ? at.y - h : at.y) + "px";   // near the bottom it opens upward
  const onKey = (k) => { if (k.key === "Escape") { k.preventDefault(); k.stopPropagation(); close(); } };
  const onAway = (ev) => { if (!m.contains(ev.target)) close(); };
  function close() { m.classList.remove("on"); document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onAway, true); window.removeEventListener("blur", close); }
  setTimeout(() => { document.addEventListener("keydown", onKey, true); document.addEventListener("pointerdown", onAway, true); window.addEventListener("blur", close); }, 0);
}

// ---------- reply / compose / send ----------
function replyHeaders(m) { const refs = [m.refs, m.msgIdHdr ? `<${m.msgIdHdr}>` : ""].filter(Boolean).join(" "); return { inReplyTo: m.msgIdHdr, references: refs }; }
function splitAddrs(s) { return String(s || "").split(/[,;\r\n]/).map((x) => x.replace(/[\x00-\x1f\x7f]/g, "").trim()).filter(Boolean); }
// ---------- recipient suggestions (forwarding offered none of the usual addresses,
// which Gmail suggests) ----------
// Two sources, merged into one list under To / Cc / Bcc:
//  1. This app's own mail: every address on a synced Gmail message (sent-to from SENT records, heard-from otherwise) plus the hub's
//  /api/contacts, ranked by how often and how recently: people you SEND to weigh four times people who write to you. It is the
//  only source for domain mail: the hub sends through Cloudflare, so Google never learns those recipients.
//  2. Google's own contact lists (saved contacts and "Other contacts"), queried live for every Gmail account whose token carries
//  the read-only contacts permission. An account connected before that permission existed is simply skipped.
const NOREPLY_RE = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|bounces?|postmaster)([._+-]|@)/i;
function parseAddrList(s) {   // a To/Cc header: `"Stone, Mike" <m@x>, Andy <a@y>, b@z`; commas inside quotes are not separators
  const out = []; const re = /(?:"([^"]*)"|([^,<>"]*?))\s*<([^<>\s]+@[^<>\s]+)>|([^\s,<>";]+@[^\s,<>";]+)/g; let m;
  while ((m = re.exec(String(s || "")))) { const addr = lc(m[3] || m[4] || ""); if (addr) out.push({ addr, name: (m[1] ?? m[2] ?? "").trim() }); }
  return out;
}
const contactBook = { list: null, at: 0, building: null, warmed: new Set() };
async function buildContactBook() {
  const book = new Map();
  const add = (addr, name, kind, date, n = 1) => {
    addr = lc(addr || ""); if (!addr.includes("@") || NOREPLY_RE.test(addr) || isMine(addr)) return;
    const c = book.get(addr) || { addr, name: "", sent: 0, recv: 0, last: 0 };
    if (name && !/@/.test(name) && (!c.name || kind === "sent")) c.name = name;
    c[kind] += n; c.last = Math.max(c.last, date || 0); book.set(addr, c);
  };
  try {
    for (const r of await idb.getAll("messages")) {
      if ((r.labels || []).includes("SENT")) for (const a of parseAddrList(`${r.to || ""}, ${r.cc || ""}`)) add(a.addr, a.name, "sent", r.date);
      else if (r.from) add(addrOf(r.from), nameOf(r.from), "recv", r.date);
    }
  } catch (_) {}
  try {
    const j = await api("/api/contacts");
    for (const c of j.sent || []) add(c.addr, c.name, "sent", Date.parse(c.last) || 0, c.n || 1);
    for (const c of j.received || []) add(c.addr, c.name, "recv", Date.parse(c.last) || 0, c.n || 1);
  } catch (_) {}
  const now = Date.now();
  for (const c of book.values()) c.score = (4 * c.sent + c.recv) / (1 + Math.max(0, now - c.last) / (60 * 864e5));
  contactBook.list = [...book.values()].sort((a, b) => b.score - a.score); contactBook.at = now;
  return contactBook.list;
}
function contactsReady() {   // built once, rebuilt at most every ten minutes; never blocks typing
  if ((!contactBook.list || Date.now() - contactBook.at > 600_000) && !contactBook.building) contactBook.building = buildContactBook().finally(() => { contactBook.building = null; });
  return contactBook.list || [];
}
function matchContact(c, q) {
  if (c.addr.startsWith(q)) return true;
  const [local, dom] = c.addr.split("@");
  return local.split(/[._+-]/).some((p) => p.startsWith(q)) || (dom || "").startsWith(q) || lc(c.name || "").split(/[\s,.'"()-]+/).some((w) => w && w.startsWith(q)) || lc(c.name || "").startsWith(q);
}
const hasContactsScope = (email) => /contacts(\.other)?\.readonly/.test(gmailTokens.get(email)?.scope || "");
async function googleContacts(q) {
  const found = [];
  await Promise.all(state.gmail.filter((g) => g.status === "active").map(async (g) => {
    try {
      const at = await gtoken(g.email); if (!hasContactsScope(g.email)) return;
      const get = async (path) => { const r = await fetch("https://people.googleapis.com/v1/" + path, { headers: { authorization: "Bearer " + at } }); return r.ok ? r.json() : {}; };
      const both = ["otherContacts:search", "people:searchContacts"];
      // Google: "Before searching, clients should send a warmup request with an empty query to update the cache." Once per session.
      if (!contactBook.warmed.has(g.email)) { contactBook.warmed.add(g.email); await Promise.all(both.map((ep) => get(`${ep}?query=&readMask=names,emailAddresses`))); }
      for (const j of await Promise.all(both.map((ep) => get(`${ep}?query=${encodeURIComponent(q)}&readMask=names,emailAddresses&pageSize=10`))))
        for (const r of j.results || []) { const p = r.person || {}; const name = p.names?.[0]?.displayName || ""; for (const e of p.emailAddresses || []) if (e.value) found.push({ addr: lc(e.value), name, google: true }); }
    } catch (_) {}
  }));
  return found.filter((c) => !NOREPLY_RE.test(c.addr) && !isMine(c.addr));
}
function attachRecipientSuggest(input) {
  let box = null, items = [], sel = 0, timer = null, seq = 0;
  const token = () => { const v = input.value; const i = Math.max(v.lastIndexOf(","), v.lastIndexOf(";")); return { start: i + 1, q: lc(v.slice(i + 1).trim()) }; };
  const close = () => { if (box) box.remove(); box = null; items = []; };
  const already = () => new Set(splitAddrs(input.value).map(addrOf));
  const pick = (c) => { const { start } = token(); const head = input.value.slice(0, start); input.value = (head.trim() ? head.replace(/\s*$/, " ") : "") + c.addr + ", "; close(); input.focus(); input.dispatchEvent(new Event("change")); };
  const draw = () => {
    if (!items.length) return close();
    if (!box) { box = document.createElement("div"); box.className = "rsug"; document.body.appendChild(box); }
    const r = input.getBoundingClientRect(); Object.assign(box.style, { left: r.left + "px", top: r.bottom + 2 + "px", width: Math.max(r.width, 280) + "px" });
    box.innerHTML = items.map((c, i) => `<div class="rs${i === sel ? " on" : ""}" data-i="${i}"><b>${esc(c.name || c.addr)}</b><span>${esc(c.addr)}</span></div>`).join("");
    box.querySelectorAll(".rs").forEach((el) => el.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(items[+el.dataset.i]); }));
  };
  const update = () => {
    const { q } = token(); clearTimeout(timer); const mine = ++seq;
    if (!q) return close();
    const skip = already();
    const local = contactsReady().filter((c) => !skip.has(c.addr) && matchContact(c, q)).slice(0, 8);
    items = local; sel = 0; draw();
    timer = setTimeout(async () => {
      const g = await googleContacts(q); if (mine !== seq) return;
      const seen = new Set(items.map((c) => c.addr));
      items = [...items, ...g.filter((c) => !skip.has(c.addr) && !seen.has(c.addr) && seen.add(c.addr))].slice(0, 8); draw();
    }, 180);
  };
  input.setAttribute("autocomplete", "off");
  input.addEventListener("focus", () => { contactsReady(); });
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (!box || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; draw(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }   // closes the list, NOT the composer behind it
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
}
for (const id of ["#cto", "#ccc", "#cbcc"]) attachRecipientSuggest($(id));
// The From list, drawn like the To list instead of the engine's <datalist>: the HTML standard lets an engine filter a
// datalist by what is already in the box, and the box always holds the current address, so the user saw one choice, or none, drawn
// differently in each app. Here every address shows the moment the box is touched, grouped as the sidebar groups accounts, the one in
// use ticked; typing narrows it; arrows, Enter and Tab pick; Esc closes it without closing the window behind it. Any address on my
// domains can still be typed (the hub decides what may be sent from), and letters that are not an address are put back.
function senderList() {
  const out = [], seen = new Set();
  for (const a of sideAccounts()) for (const addr of a.addresses || []) { const x = lc(addr); if (!x || seen.has(x)) continue; seen.add(x);
    out.push({ addr: x, name: nameFor(x), tag: a.kind === "gmail" ? `Gmail · ${a.label}` : a.imap ? a.label : a.id === "hub" || lc(a.label) === domainOf(x) ? "" : a.label, color: a.color }); }   // a domain row's tag only when the domain was given a name: the address already shows it
  return out;
}
const sendableFrom = (v) => { const a = lc(String(v || "").trim()); return senderList().some((c) => c.addr === a) || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) && hubDomains().includes(domainOf(a))); };
function attachFromPicker(input, next) {
  let box = null, items = [], sel = 0, start = "", picked = false, fresh = false;
  const close = () => { if (box) box.remove(); box = null; items = []; };
  const pick = (c) => { picked = true; input.value = c.addr; close(); input.dispatchEvent(new Event("change")); const n = next(); if (n) n.focus(); };
  const draw = () => {
    if (!items.length) return close();
    if (!box) { box = document.createElement("div"); box.className = "rsug fromsug"; box.setAttribute("role", "listbox"); document.body.appendChild(box); }
    const r = input.getBoundingClientRect(); const below = innerHeight - r.bottom - 8;
    Object.assign(box.style, { left: Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 300) - 8)) + "px", width: Math.min(innerWidth - 16, Math.max(r.width, 300)) + "px", top: (below >= 200 || below >= r.top ? r.bottom + 2 : Math.max(8, r.top - 2 - Math.min(340, r.top - 8))) + "px", maxHeight: Math.min(340, Math.max(below, r.top - 8)) + "px" });
    box.innerHTML = items.map((c, i) => `<div class="rs fr${i === sel ? " on" : ""}${c.addr === lc(start) ? " cur" : ""}" role="option" data-i="${i}"><i class="fd" style="background:${esc(c.color || "var(--mut)")}"></i><div class="ft"><b>${esc(c.name || c.addr)}</b><span>${esc(c.addr)}</span></div><em>${esc(c.tag || "")}</em></div>`).join("");
    box.querySelectorAll(".rs").forEach((el) => el.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(items[+el.dataset.i]); }));
    box.querySelector(".rs.on")?.scrollIntoView({ block: "nearest" });
  };
  const update = (all) => {
    const q = lc(input.value.trim()); const list = senderList();
    items = all || !q || q === lc(start) ? list : list.filter((c) => [c.addr, c.name, c.tag].some((f) => lc(f || "").includes(q)));
    // A full address on one of my domains that is not on the list yet: offered as itself.
    if (!all && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) && !list.some((c) => c.addr === q) && hubDomains().includes(domainOf(q))) items = [...items, { addr: q, name: q, tag: `new on ${domainOf(q)}`, color: colorFor(domainOf(q)) }];
    sel = Math.max(0, items.findIndex((c) => c.addr === lc(start))); if (!all && q && q !== lc(start)) sel = 0; draw();
  };
  input.setAttribute("autocomplete", "off");
  input.addEventListener("focus", () => { start = input.value; picked = false; fresh = true; update(true); setTimeout(() => { if (document.activeElement === input) input.select(); }, 0); });
  input.addEventListener("mouseup", (e) => { if (fresh) { e.preventDefault(); input.select(); } fresh = false; });   // the click that focused it selects all, so typing replaces
  input.addEventListener("pointerdown", () => { if (document.activeElement === input && !box) update(true); });
  input.addEventListener("input", () => { fresh = false; update(false); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box) { e.preventDefault(); e.stopPropagation(); if (!sendableFrom(input.value)) input.value = start; close(); return; }   // closes the list, NOT the window behind it
    if (!box || !items.length) { if (e.key === "ArrowDown") { e.preventDefault(); update(true); } return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; draw(); }
    else if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && lc(input.value.trim()) !== lc(start))) { e.preventDefault(); pick(items[sel]); }
  });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement === input) return;   /* focused again within the wait: its new list stays */ close(); if (!picked && !sendableFrom(input.value)) input.value = start; }, 120));
}
attachFromPicker($("#cfrom"), () => ($("#cto").value.trim() ? $("#ctext") : $("#cto")));
attachFromPicker($("#rfrom"), () => $("#rtext"));
async function sendVia(fromAddr, draft, { threadRef = null } = {}) {
  const g = state.gmail.find((x) => x.email === lc(fromAddr) && x.status === "active");
  if (g) return gmailAdapter(g.email).send({ ...draft, from: g.email, threadId: threadRef });
  return hub.send(draft);
}
$("#rsend").onclick = () => { sendReply.archive = false; sendReply(false); }; $("#rlater").onclick = () => sendReply(true);
$("#rsendarch").onclick = () => { sendReply.archive = true; sendReply(false); };
// Sends go through the queue with a 5-second undo window; Undo removes the row before it can be persisted.
// A cancelled or failed send comes back where it was written: a reply reopens the reply box on its thread (threading headers are
// rebuilt at send time); anything else reopens the compose window with recipient and subject restored.
// Undo send, a send that failed for good, and "send anyway?" declined all put the draft back as it was, its files included: they were dropped, so sending it again
// went without them. A hub forward stays a forward, so the hub still attaches the original's files when it goes.
// A Gmail reply's draft text ends with the quoted message (sendReply adds it), so the box gets back only what was typed (`typed`):
// otherwise sending again quoted the original twice.
// A draft coming back never replaces one being written. A send that failed seconds later reopened over the reply or message the user
// had moved on to, and that one was lost. It waits instead, with Open on a toast, and is offered
// again when the reply or message in the way is sent or closed.
const replyWork = () => { const v = ($("#rtext").value || "").trim(); return (!!v && v !== sigFor($("#rfrom").value || "").trim()) || $("#rfiles").files.length > 0; };
function openUnsent() { const a = (state.unsent || []).shift(); if (a) reopenDraft(a); }
function offerUnsent() { const n = (state.unsent || []).length; if (n) toast(n === 1 ? "A message that was not sent is waiting" : `${n} messages that were not sent are waiting`, 12000, openUnsent, "Open"); }
async function reopenDraft(args) {
  const d = args.draft || {}; const t = args.threadKey ? state.threads.get(args.threadKey) : null;
  if (t && (args.replyTo || d.threadId) ? replyWork() : $("#cmodal").classList.contains("on") && composeWork()) { (state.unsent ||= []).push(args); draftFromArgs(args); toast(`"${d.subject || t?.subject || "A message"}" was not sent. It is in Drafts`, 12000, openUnsent, "Open"); return; }
  const files = (d.attachments || []).filter((a) => a && a.content && a.filename).map((a) => new File([Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))], a.filename, { type: a.type || "application/octet-stream" }));
  if (t && (args.replyTo || d.threadId)) { await openThread(t.key); $("#rfrom").value = d.from || $("#rfrom").value; $("#rname").value = d.from_name || $("#rname").value; $("#rall").checked = d.mode === "all" || (Array.isArray(d.cc) && d.cc.length > 0); $("#rtext").value = args.typed ?? d.text ?? ""; if (files.length) setFiles($("#rfiles"), files); openReplySheet(); if (args.draftId) { editors.r.id = args.draftId; editors.r.rev = 0; } editors.r.revive = true; editors.r.sig = ""; draftFlush("r"); return; }
  openCompose({ draftId: args.draftId || null, draft: { ...d, text: args.typed ?? d.text, to: d.to && (Array.isArray(d.to) ? d.to.length : d.to) ? d.to : (t ? [t.out ? (t.to || "").split(",")[0].trim() : t.fromAddr] : []), subject: d.subject || (t ? (/^re:/i.test(t.subject || "") ? t.subject : "Re: " + (t.subject || "")) : "") } });
  if (files.length) setFiles($("#cfiles"), files); else clearFiles($("#cfiles"));
  if (args.forwardOf) state.fwd = { t: { kind: "hub" }, m: { id: args.forwardOf } };
  editors.c.revive = true; editors.c.sig = ""; draftFlush("c");   // back in Drafts, under its own id
}
async function queueSend(args) {
  if (state.maybeSent && !(await ask("A message may already have gone out once (the server's answer was lost). Send this one anyway?", { ok: "Send anyway", danger: true }))) return null;   // the message stays where it is, unsent
  state.maybeSent = null;
  const row = await queue.add({ op: "send", account: args.gmail || "hub", threadKey: "send:" + uuid4(), notBefore: Date.now() + Q.undoMs, args });
  toast(navigator.onLine ? "Sending in 5 s" : "Queued - sends when this app is open and online", Q.undoMs, async () => { if (queue.mem.get(row.key)?.sending) return toast("Too late to undo: it is already sending", 5000); await queue.remove(row.key); toast("Send cancelled"); reopenDraft(args); });
  return row;
}
// After a reply goes (or is scheduled): its text, files, reply-all and preview start fresh. Reply-all stayed ticked, so the next reply in
// the conversation went to everyone; the preview of the sent text stayed under the empty box.
// Only the reply that was sent is cleared: queueSend returns after a durable write, and by then the user may have opened another
// conversation and started its reply, which this used to wipe (found in October 2026 by test/audit.py: 3 s on the test machine).
function resetReplyBox(key, sentText) {
  if (state.cur !== key || ($("#rtext").value || "").trim() !== String(sentText || "").trim()) return;
  $("#rtext").value = ""; clearFiles($("#rfiles")); $("#rall").checked = false; $("#rprev").style.display = "none"; setTimeout(offerUnsent, 5600);
}
async function sendReply(later) {
  const m = state.replyTo, t = state.threads.get(state.cur); if (!m || !t) return; const text = $("#rtext").value.trim();   // blank is allowed: Send sends
  // The reply box's draft, held from here: whatever the box holds after the awaits below may already be another conversation's.
  const dh = editors.r;
  const from = lc($("#rfrom").value), from_name = $("#rname").value; const all = $("#rall").checked; const attachments = await filesOf($("#rfiles"));
  try {
    $("#rsend").disabled = true;
    const isGmailFrom = t.kind === "gmail" && state.gmail.some((x) => x.email === from);
    if (isGmailFrom) {
      const to = m.out ? splitAddrs(m.to) : [m.replyTo || m.fromAddr]; const cc = all ? [...splitAddrs(m.to), ...splitAddrs(m.cc)].filter((a) => addrOf(a) !== from && !to.includes(a)) : [];
      const draft = withFormat({ from, from_name, to, cc, subject: /^re:/i.test(m.subject || "") ? m.subject : "Re: " + (m.subject || ""), text: text + quote(m), attachments, ...replyHeaders(m), threadId: t.id, messageId: `${uuid4()}@mail.gmail.com` }, $("#rmd").checked);
      if (later) return pickTime("Send at", async (due) => { await api("/api/schedule", { method: "POST", body: JSON.stringify({ kind: "send_later", account: from, due_at: due.toISOString(), draft: { raw: buildMime(draft), threadId: t.id, subject: draft.subject, to: draft.to.join(", ") } }) }); toast("Scheduled"); draftSent(dh); resetReplyBox(t.key, text); closeReplySheet(); });
      if (!(await queueSend({ gmail: from, draft, typed: text, threadKey: t.key, archiveKey: sendReply.archive ? t.key : null, draftId: dh.id || undefined }))) return; draftSent(dh); resetReplyBox(t.key, text); closeReplySheet(); focusAdvanceAfterSend(t.key); return;
    }
    const hubDraft = withFormat({ text, mode: all ? "all" : "one", from, from_name, attachments, plain: noLetterhead("#rfrom") }, $("#rmd").checked);
    // Send later builds the reply as Send now does: Markdown applied, and reply-all without your own addresses or the To people again
    // (it went out as raw markdown, Cc'd you, and doubled the To list into Cc on a reply to your own message;
    if (later) return pickTime("Send at", async (due) => { const to = m.out ? splitAddrs(m.to) : [m.replyTo || m.fromAddr]; const toSet = new Set(to.map(addrOf)); const cc = all ? [...new Set((m.out ? splitAddrs(m.cc) : [...splitAddrs(m.to), ...splitAddrs(m.cc)]).filter((a) => !toSet.has(addrOf(a)) && !isMine(addrOf(a))))] : []; const draft = withFormat({ from, from_name, to, cc, subject: /^re:/i.test(m.subject || "") ? m.subject : "Re: " + (m.subject || ""), text, in_reply_to: m.msgIdHdr, attachments, plain: noLetterhead("#rfrom") }, $("#rmd").checked); await api("/api/schedule", { method: "POST", body: JSON.stringify({ kind: "send_later", account: "hub", due_at: due.toISOString(), draft }) }); toast("Scheduled"); draftSent(dh); resetReplyBox(t.key, text); closeReplySheet(); });
    if (!(await queueSend({ replyTo: m.id, draft: hubDraft, threadKey: t.key, archiveKey: sendReply.archive ? t.key : null, draftId: dh.id || undefined }))) return; draftSent(dh); resetReplyBox(t.key, text); closeReplySheet(); focusAdvanceAfterSend(t.key);
  } catch (e) { toast(e.message); } finally { $("#rsend").disabled = false; }
}
const quote = (m) => `\n\nOn ${new Date(m.date).toLocaleString()}, ${m.from} wrote:\n` + plainOf(m).split("\n").map((l) => "> " + l).join("\n");
const FWD_MARK = "---------- Forwarded message ----------";
// A message's text for a quote or a forward. Mail sent as HTML only (common from Gmail senders) has no text part, so both came out
// empty. Parsed inert: DOMParser runs no scripts and loads nothing.
function plainOf(m) {
  if (m.text) return String(m.text);
  if (!m.html) return "";
  if (htmlDepth(m.html, MAIL_MAX_DEPTH) > MAIL_MAX_DEPTH) return htmlAsText(m.html);   // too deep to parse quickly (htmlDepth)
  try { const d = new DOMParser().parseFromString(String(m.html).replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*(?:>|$)/gi, "$&\n"), "text/html"); d.querySelectorAll("style,script,head,title").forEach((x) => x.remove()); return (d.body?.textContent || "").replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); } catch (_) { return ""; }
}
// A Gmail forward carries the original's files, as Gmail's own does; the hub attaches them itself for hub mail. Images with a
// Content-ID are left out: they are pictures inside the original's HTML, which a text forward does not carry.
async function attachOriginal(t, m) {
  const list = (m.attachments || []).filter((a) => a.id && !(a.cid && /^image\//i.test(a.mime || "")));
  if (!list.length) return;
  $("#csend").disabled = true; toast(`Adding ${list.length === 1 ? list[0].name || "a file" : list.length + " files"} from the original…`, 4000);
  try {
    const files = []; for (const a of list) { const bytes = await adapterFor(t.account).attachment(a.msgId || m.id, a.id); files.push(new File([bytes], a.name || "attachment", { type: a.mime || "application/octet-stream" })); }
    if (state.fwd?.m === m && $("#cmodal").classList.contains("on")) setFiles($("#cfiles"), [...$("#cfiles").files, ...files]);
  } catch (e) { toast("Couldn't add the original's files: " + (e?.message || e), 6000); }
  finally { $("#csend").disabled = false; }
}
function openCompose({ forward = false, draft = null, draftId = null, rev = 0 } = {}) {
  perf.measure("compose-open", () => {});
  if ($("#cmodal").classList.contains("on") && composeWork()) draftFlush("c");   // the message already open is kept as a draft, not written over
  editors.c = newHandle("c"); if (draftId) { editors.c.id = draftId; editors.c.rev = rev; } draftStat(editors.c, "");
  const t = state.threads.get(state.cur); const m = state.replyTo;
  if (draft) { $("#ctitle").textContent = "Draft"; $("#cmodal").classList.add("on"); $("#cfrom").value = draft.from || ""; $("#cname").value = draft.from_name || ""; syncBrand("#cfrom"); if (draft.plain && $("#cbrand")) $("#cbrand").checked = false; $("#cto").value = Array.isArray(draft.to) ? draft.to.join(", ") : (draft.to || ""); $("#ccc").value = Array.isArray(draft.cc) ? draft.cc.join(", ") : (draft.cc || ""); $("#cbcc").value = Array.isArray(draft.bcc) ? draft.bcc.join(", ") : (draft.bcc || ""); $("#csub").value = draft.subject || ""; $("#ctext").value = draft.text || ""; $("#cprev").style.display = "none"; pushLayer("compose", composeClosed); state.fwd = null; return; }
  $("#ctitle").textContent = forward ? "Forward" : "New message"; $("#cmodal").classList.add("on"); closeMenu(); pushLayer("compose", composeClosed);
  $("#cto").value = $("#ccc").value = $("#cbcc").value = ""; clearFiles($("#cfiles")); $("#cprev").style.display = "none";
  const def = state.me.identities[0]?.email || state.gmail[0]?.email || "";
  $("#cfrom").value = t ? (t.kind === "gmail" ? t.account : (t.identity || def)) : def; $("#cname").value = nameFor($("#cfrom").value); syncBrand("#cfrom");
  if (forward && m) { $("#csub").value = /^fwd?:/i.test(m.subject || "") ? m.subject : "Fwd: " + (m.subject || ""); $("#ctext").value = sigFor($("#cfrom").value) + `\n\n${FWD_MARK}\nFrom: ${m.from}\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\nTo: ${m.to}\n\n${plainOf(m)}`; state.fwd = { t, m }; if (t?.kind === "gmail") attachOriginal(t, m); }
  else { $("#csub").value = ""; $("#ctext").value = sigFor($("#cfrom").value); state.fwd = null; }
  $("#cto").focus();
}
$("#composeBtn").onclick = () => openCompose();
for (const [sel, ta] of [["#cfrom", "#ctext"], ["#rfrom", "#rtext"]]) { let prev = ""; $(sel).addEventListener("focus", () => (prev = $(sel).value)); $(sel).addEventListener("change", () => { if (!sendableFrom($(sel).value)) return;   /* letters typed to filter the From list, not an address to send from */ const nm = sel === "#cfrom" ? "#cname" : "#rname"; $(nm).value = nameFor($(sel).value); swapSig($(ta), prev, $(sel).value); syncBrand(sel); prev = $(sel).value; }); } $("#ccancel").onclick = () => { if (!dropLayer("compose")) composeClosed(); };
for (const [cb, ta, pv] of [["#cmd", "#ctext", "#cprev"], ["#rmd", "#rtext", "#rprev"]]) { $(cb).checked = composeMode() === "markdown"; $(cb).onchange = () => { setPref("compose", $(cb).checked ? "markdown" : "text"); $$("#cmd, #rmd").forEach((x) => (x.checked = $(cb).checked)); $(pv).style.display = "none"; }; $(pv + "btn").onclick = () => { const p = $(pv); if (p.style.display !== "none") { p.style.display = "none"; return; } p.innerHTML = `<iframe sandbox="" style="width:100%;border:0;min-height:120px" srcdoc="${esc(mdToHtml($(ta).value))}"></iframe>`; p.style.display = ""; const fr = p.querySelector("iframe"); fr.onload = () => { try { fr.style.height = Math.max(120, fr.contentDocument.documentElement.scrollHeight + 8) + "px"; } catch (_) {} }; }; }
$("#csend").onclick = () => sendCompose(false); $("#clater").onclick = () => sendCompose(true);
async function sendCompose(later) {
  const from = lc($("#cfrom").value), from_name = $("#cname").value, to = splitAddrs($("#cto").value), cc = splitAddrs($("#ccc").value), bcc = splitAddrs($("#cbcc").value), subject = $("#csub").value, text = $("#ctext").value;
  if (!from || !to.length) return toast("From and To are required");
  const dh = editors.c;   // this window's draft, held across the awaits below
  const attachments = await filesOf($("#cfiles"));
  const isGmail = state.gmail.some((x) => x.email === from && x.status === "active");
  // A hub forward: the hub adds the forwarded block and the original's files itself, so only the note above the block is sent (the
  // block went out twice). Bcc and the Markdown note go with it, and Send later schedules the same forward (it was a plain send
  // without the original's files).
  const hubFwd = state.fwd && state.fwd.t.kind === "hub" && !isGmail ? state.fwd.m.id : null;
  const cut = hubFwd ? text.indexOf(FWD_MARK) : -1; const body = cut >= 0 ? text.slice(0, cut).replace(/\s+$/, "") : text;
  try {
    $("#csend").disabled = true;
    if (later) return pickTime("Send at", async (due) => {
      const fd = withFormat({ from, from_name, to, cc, bcc, subject, text: body, attachments, plain: noLetterhead("#cfrom") }, $("#cmd").checked); const draft = isGmail ? { raw: buildMime(fd), subject, to: to.join(", ") } : hubFwd ? { ...fd, forward_of: hubFwd } : fd;
      await api("/api/schedule", { method: "POST", body: JSON.stringify({ kind: "send_later", account: isGmail ? from : "hub", due_at: due.toISOString(), draft }) }); toast("Scheduled"); const same = editors.c === dh; draftSent(dh); if (same) finishCompose(); offerUnsent();
    });
    const md = $("#cmd").checked;
    const draft = withFormat({ from, from_name, to, cc, bcc, subject, text: body, attachments, plain: noLetterhead("#cfrom"), messageId: isGmail ? `${uuid4()}@mail.gmail.com` : undefined }, md);
    const dId = dh.id || undefined;
    const row = hubFwd ? await queueSend({ forwardOf: hubFwd, draft, typed: text, draftId: dId }) : await queueSend({ gmail: isGmail ? from : null, draft, draftId: dId });
    if (!row) return;   // "send anyway?" declined: the message stays open as it was (it was emptied;
    // The queue holds the message now; undo or a failure puts it back in Drafts. The window is emptied only if it is still this one: one
    // closed meanwhile, and another opened, keeps what is being written in it.
    const same = editors.c === dh; draftSent(dh);
    api("/api/senders", { method: "POST", body: JSON.stringify({ addresses: [...to, ...cc].map(addrOf), status: "accepted" }) }).catch(() => {});
    if (same) finishCompose(); offerUnsent();
    refresh({ silent: true, accounts: [isGmail ? from : "hub"] });
  } catch (e) { toast(e.message); } finally { $("#csend").disabled = false; }
}
// The compose window after its message went (or was scheduled): emptied, then closed through its layer, so the next back press is not
// spent on a window that is already gone (it was only hidden;
function finishCompose() { clearTimeout(editors.c.timer); editors.c = newHandle("c"); draftStat(editors.c, ""); $("#cto").value = $("#ccc").value = $("#cbcc").value = $("#csub").value = $("#ctext").value = ""; clearFiles($("#cfiles")); $("#cprev").style.display = "none"; state.fwd = null; if (!dropLayer("compose")) $("#cmodal").classList.remove("on"); }
// Closing the compose window by hand (X, back, Esc) with a message in it keeps the message: the toast's Reopen puts it back as it
// was, files included. It was discarded with no way back.
const composeWork = () => ["#csub", "#cto", "#ccc", "#cbcc"].some((k) => ($(k).value || "").trim()) || (($("#ctext").value || "").trim() && $("#ctext").value.trim() !== sigFor($("#cfrom").value || "").trim()) || $("#cfiles").files.length > 0;
// Now it is saved to Drafts instead, at once, on every device; the toast offers Discard, which can be undone.
function composeClosed() {
  const was = $("#cmodal").classList.contains("on"); $("#cmodal").classList.remove("on");
  const h = editors.c; clearTimeout(h.timer); editors.c = newHandle("c");
  if (!was) return;
  const snap = draftSnapCompose();
  if (!snap.work) { if (h.id) draftSave(h, snap); offerUnsent(); return; }   // nothing written: no draft, and an empty one goes
  draftSave(h, snap);
  toast("Saved to Drafts", 6000, () => draftDiscard(h.id, { reopen: () => openComposeFromDraft({ id: h.id, rev: h.rev, content: snap.content }, { files: snap.files, save: true }) }), "Discard");
  offerUnsent();
}

// ---------- drafts ----------
// Everything the user writes is kept as he writes it: a new message, a forward, and a reply, which belongs to its conversation. It
// is saved 1.2 s after the last keystroke, and at once when the window closes, another conversation opens or the page hides; it is
// kept by the hub for every address, so it is on the Mac, the phone and the PC at their next refresh. Nothing empty is ever saved, and
// a draft emptied by hand goes. Sending takes the draft out (the send queue holds the message until it has gone); undo, a failed send
// and a message held back bring it back. A save from an old revision is refused by the hub (another device changed it): this device
// then keeps its own text as a second draft, so neither version is lost (no vendor documents this case; Mimestream once sent an older
// version of a draft by it). A copy of every draft is kept on this device too, files that could not go up included, so a draft
// written offline is not lost either.
// Each fix below names its finding.
const DRAFT_SAVE_MS = 1200;
// The hub's draft routes take a UUID; queue.js's uuid4 falls back to a shorter id where crypto.randomUUID is missing.
const draftUuid = () => { if (crypto.randomUUID) return crypto.randomUUID(); const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const draftDevice = () => /Android/i.test(navigator.userAgent) ? "android" : /Windows/i.test(navigator.userAgent) ? "windows" : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? "mac" : "web";
const draftHash = async (content) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content))))].map((b) => b.toString(16).padStart(2, "0")).join("");
function draftLive() { return [...draftStore.map.values()].filter((d) => !d.deleted).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))); }
function draftKeys() { return draftStore.keys; }
// This device's copy. A change that must outlive the page (a send's deletion, a save about to wait on uploads, the page hiding) is
// written at once; the rest 300 ms later, once.
function draftPersistNow() { clearTimeout(draftStore.persistT); draftStore.persistT = null; return idb.meta("drafts", { cursor: draftStore.cursor, list: [...draftStore.map.values()] }).catch(() => {}); }
function draftsChanged({ now = false } = {}) {
  const keys = new Set(draftLive().filter((d) => d.kind === "reply" && d.thread_key).map((d) => d.thread_key));
  const moved = keys.size !== draftStore.keys.size || [...keys].some((k) => !draftStore.keys.has(k)); draftStore.keys = keys;
  if (now) draftPersistNow(); else { clearTimeout(draftStore.persistT); draftStore.persistT = setTimeout(draftPersistNow, 300); }
  return moved;
}
async function draftLoad() { try { const v = await idb.meta("drafts"); if (v && Array.isArray(v.list)) { draftStore.cursor = v.cursor || 0; for (const d of v.list) if (d && d.id && !draftStore.map.has(d.id)) draftStore.map.set(d.id, d); } } catch (_) {} draftsChanged(); }
// What the list and the conversation rows show of a change; the open conversation and the reply box are not redrawn by it.
function draftViewRefresh(moved = true) { if (state.view.kind === "drafts") renderDrafts(); else if (moved) { render(); } else renderNav(); }
// revive: this handle brings its draft back on purpose (undo send, a failed send, Undo of a discard). Only such a handle may save over
// a tombstone under the same id; any other save that meets one keeps its text as a new draft, or drops it when it is exactly the
// content that was sent. filling: its draft is being put in the window, so the window's own change events
// do not save half of it.
function newHandle(kind, key = null) { return { kind, key, id: null, rev: 0, sig: "", up: new Map(), timer: null, closed: false, revive: false, filling: false, keep: [] }; }
const draftFileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
const draftBlobKey = (id, k) => `dfile:${id}:${k}`;
const draftSig = (h, content, files) => JSON.stringify([content, files.map((f) => { const u = h.up.get(draftFileKey(f)); return u && u.draftId === h.id ? "ref:" + u.ref.id : draftFileKey(f); }), (h.keep || []).map((r) => r.id)]);
function draftSnippet(text, from) {
  let t = String(text || ""); const sig = sigFor(from || "").trim(); if (sig && t.trim().endsWith(sig)) t = t.trim().slice(0, -sig.length);
  const cut = t.indexOf(FWD_MARK); if (cut >= 0) t = t.slice(0, cut);
  return t.replace(/^\s*>.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 140);
}
function draftCaptureCompose() {
  const f = state.fwd; const fwd = f && f.m?.id ? { key: f.t?.key || null, kind: f.t?.kind || null, msgId: f.m.id } : null;
  return { kind: fwd ? "forward" : "new", from: lc($("#cfrom").value.trim()), from_name: $("#cname").value, to: $("#cto").value, cc: $("#ccc").value, bcc: $("#cbcc").value, subject: $("#csub").value, text: $("#ctext").value, md: $("#cmd").checked, plain: !!noLetterhead("#cfrom"), fwd, title: $("#ctitle").textContent };
}
function draftCaptureReply(key) {
  const t = state.threads.get(key) || {}; const subj = t.subject || "";
  return { kind: "reply", key, from: lc($("#rfrom").value.trim()), from_name: $("#rname").value, all: $("#rall").checked, text: $("#rtext").value, md: $("#rmd").checked, plain: !!noLetterhead("#rfrom"), subject: /^re:/i.test(subj) ? subj : "Re: " + subj, to: $("#rto").textContent || "" };
}
const draftSnapCompose = () => ({ content: draftCaptureCompose(), files: [...$("#cfiles").files], work: composeWork() });
const draftSnapReply = (key = editors.r.key) => ({ content: draftCaptureReply(key), files: [...$("#rfiles").files], work: replyWork() });
const draftMeta = (content, nFiles) => ({ kind: content.kind, thread_key: content.kind === "reply" ? content.key : content.fwd?.key || null, from: content.from, to: content.to || "", subject: content.subject || "", snippet: draftSnippet(content.text, content.from), n_files: nFiles, device: draftDevice() });
function draftStat(h, text, bad = false) {
  if (h !== editors.c && h !== editors.r) return;
  const el = $(h === editors.c ? "#cdstat" : "#rdstat"); if (el) { el.textContent = text; el.classList.toggle("bad", !!bad); }
  if (h === editors.r) { const b = $("#rdiscard"); if (b) b.style.display = h.id && draftStore.map.get(h.id) && !draftStore.map.get(h.id).deleted ? "" : "none"; }
}
const draftRetrySoon = () => { clearTimeout(draftSave.retryT); draftSave.retryT = setTimeout(() => draftRetry(), 15_000); };
// One save at a time per draft, in order: a send's delete always lands after the save before it.
function draftChain(id, fn) { const prev = draftStore.chains.get(id) || Promise.resolve(); const next = prev.then(fn, fn).catch(() => {}); draftStore.chains.set(id, next); next.then(() => { if (draftStore.chains.get(id) === next) draftStore.chains.delete(id); }); return next; }
// Files go up once each, under the handle's draft. One that cannot go up now is kept on this device, its bytes in IndexedDB, and named
// as pending on the draft; the retry sends it and reopening the draft brings it back.
// One the hub refuses for good (over 18 MB a draft) is counted, not kept.
async function draftUpload(h, files) {
  const refs = [], pending = []; let refused = 0;
  for (const f of files) {
    const k = draftFileKey(f); let u = h.up.get(k);
    if (!u || u.draftId !== h.id) {
      try { u = { draftId: h.id, ref: await api(`/api/drafts/${h.id}/files`, { method: "POST", body: f, headers: { "content-type": f.type || "application/octet-stream", "x-file-name": encodeURIComponent(f.name) } }) }; h.up.set(k, u); idb.del("meta", draftBlobKey(h.id, k)).catch(() => {}); }
      catch (e) { if (e.status === 413) { refused++; continue; } pending.push({ k, name: f.name, type: f.type || "", size: f.size, lastModified: f.lastModified }); try { await idb.meta(draftBlobKey(h.id, k), { name: f.name, type: f.type || "", lastModified: f.lastModified, bytes: await f.arrayBuffer() }); } catch (_) {} continue; }   // bytes, not the File: WebKit refuses a Blob in IndexedDB (the put fails, logged only)
    }
    refs.push(u.ref);
  }
  return { refs, pending, refused };
}
async function draftFetchFile(id, ref) {
  try { const r = await fetch(`/api/drafts/${id}/files/${ref.id}`, { credentials: "same-origin" }); if (!r.ok) return null; return new File([await r.blob()], ref.name || "file", { type: ref.type || "application/octet-stream" }); } catch (_) { return null; }
}
async function draftPendingFiles(id, pending) {
  const out = []; for (const p of pending || []) { try { const b = await idb.meta(draftBlobKey(id, p.k)); if (b && b.bytes) out.push(new File([b.bytes], b.name || p.name, { type: b.type || p.type, lastModified: b.lastModified ?? p.lastModified })); } catch (_) {} } return out;
}
const draftDropBlobs = (id, d) => { for (const p of d?.pending || []) idb.del("meta", draftBlobKey(id, p.k)).catch(() => {}); };
function draftSave(h, snap) {
  if (!snap.work) { if (!h.id) return Promise.resolve(); const id = h.id; return draftChain(id, async () => { const d = draftStore.map.get(id); if (d && !d.deleted) await draftDelete(id); h.sig = ""; draftStat(h, ""); }); }
  if (h.closed) return Promise.resolve();
  h.id ||= draftUuid();
  return draftChain(h.id, async () => {
    if (h.closed) return;
    const sig = draftSig(h, snap.content, snap.files); if (sig === h.sig) return;
    draftStat(h, "Saving…");
    // This device's copy first, before any upload waits: a page that dies during an upload still has the text.
    const prior = draftStore.map.get(h.id); const was = prior?.content?.files || [];
    draftStore.map.set(h.id, { ...(prior || {}), ...draftMeta(snap.content, was.length), id: h.id, rev: h.rev, content: { ...snap.content, files: was }, deleted: false, updated_at: new Date().toISOString(), dirty: true, stuck: null, revive: !!(h.revive || prior?.revive) });
    draftViewRefresh(draftsChanged({ now: true }) || !prior);
    const { refs, pending, refused } = await draftUpload(h, snap.files);
    if (h.closed) return;   // sent or discarded while its files went up: the delete that follows in this chain settles it
    const content = { ...snap.content, files: [...refs, ...(h.keep || [])] };
    const meta = draftMeta(content, content.files.length + pending.length);
    const d = draftStore.map.get(h.id); if (d) { Object.assign(d, meta, { content, pending }); draftsChanged({ now: true }); }
    try {
      const r = await draftPut(h, meta, content, snap.files, pending);
      if (r === null) return;
      h.sig = pending.length || refused ? "" : draftSig(h, snap.content, snap.files);
      if (refused) draftStat(h, `Saved, but ${refused === 1 ? "a file is" : refused + " files are"} over the 18 MB a draft keeps`, true);
      else if (pending.length) { draftStat(h, `Saved on this device; ${pending.length === 1 ? "a file waits" : pending.length + " files wait"} to upload`); draftRetrySoon(); }
      else draftStat(h, "Saved");
    } catch (e) {
      // Refused for good (too large, malformed): kept on this device, said once, not retried every 15 s. A dropped connection is retried.
      if (e.status >= 400 && e.status < 500 && e.status !== 409) { const x = draftStore.map.get(h.id); if (x) x.stuck = e.message; draftStat(h, "Not saved: " + e.message, true); return; }
      draftStat(h, navigator.onLine ? "Not saved, retrying" : "Saved on this device", navigator.onLine);
      draftRetrySoon();
    }
  });
}
// A draft of its own for this text, files and all: those in the window go up again under it, and any the window does not hold are
// fetched from the draft it came from. Returns what to PUT.
async function draftFork(h, content, meta, files) {
  const from = h.id; h.id = draftUuid(); h.rev = 0; h.revive = false;
  const covered = new Set(files.map((f) => h.up.get(draftFileKey(f))?.ref?.id).filter(Boolean)); const extra = []; let lost = 0;
  for (const ref of content.files || []) if (!covered.has(ref.id)) { const f = await draftFetchFile(from, ref); if (f) extra.push(f); else lost++; }
  const up = await draftUpload(h, [...files, ...extra]);
  content = { ...content, files: up.refs }; meta = { ...meta, n_files: up.refs.length + up.pending.length };
  draftStore.map.set(h.id, { ...meta, id: h.id, rev: 0, content, pending: up.pending, deleted: false, updated_at: new Date().toISOString(), dirty: true });
  draftViewRefresh(draftsChanged({ now: true }));
  if (lost) toast(`${lost === 1 ? "A file" : lost + " files"} of that draft could not be kept with your copy`, 7000);
  return { content, meta };
}
// The draft this handle holds is gone elsewhere and what is here is exactly what went: nothing to keep.
function draftGone(h) {
  draftStore.map.delete(h.id); draftsChanged({ now: true }); h.closed = true;
  if (editors.c === h) finishCompose();
  else if (editors.r === h) { $("#rtext").value = sigFor($("#rfrom").value); clearFiles($("#rfiles")); editors.r = newHandle("r", h.key); draftStat(editors.r, ""); }
  draftViewRefresh(true); toast("That draft was sent or discarded on another device", 5000);
}
async function draftPut(h, meta, content, files, pending = []) {
  let told = false, forked = false;
  for (let i = 0; i < 4; i++) {
    // A handle closed while a fork's files went up (sent, discarded) puts nothing, and takes back the copy it made.
    if (h.closed) { if (forked) { draftStore.map.delete(h.id); draftsChanged({ now: true }); } return null; }
    try {
      const body = JSON.stringify({ base_rev: h.rev, ...meta, file_ids: (content.files || []).map((f) => f.id), content });
      const r = await api(`/api/drafts/${h.id}`, { method: "PUT", body, keepalive: body.length < 60_000 });
      h.rev = r.rev; h.revive = false;
      const d = draftStore.map.get(h.id); if (d) Object.assign(d, { rev: r.rev, seq: r.seq, updated_at: r.updated_at, dirty: pending.length > 0, revive: false, pending });
      draftsChanged({ now: true }); return r;
    } catch (e) {
      if (e.status !== 409) throw e;
      const cur = e.body?.current || null;
      if (h.closed) return null;   // sent or discarded here meanwhile: nothing to bring back
      if (!cur || cur.deleted) {
        if (h.revive) {   // brought back on purpose: under the same id, its files up again (the delete removed them; 69b10494b4)
          h.rev = cur ? cur.rev : 0; h.up = new Map();
          const up = await draftUpload(h, files); content = { ...content, files: up.refs }; meta = { ...meta, n_files: up.refs.length + up.pending.length }; pending = up.pending;
          continue;
        }
        if (cur && cur.gone_hash && cur.gone_hash === await draftHash(content)) { draftGone(h); return null; }
        // The text lives on in the new draft; the old id's copy here goes with its waiting files, or every later sync would retry it,
        // meet the tombstone again and fork one more copy (found by test/draftsaudit.py).
        const old = h.id, oldEntry = draftStore.map.get(old);
        ({ content, meta } = await draftFork(h, content, meta, files)); forked = true;
        draftStore.map.delete(old); draftDropBlobs(old, oldEntry); draftsChanged({ now: true });
        if (!told) { told = true; toast("That draft was sent or discarded on another device. What you wrote here is kept as a new draft.", 8000); }
        continue;
      }
      if (JSON.stringify(cur.content) === JSON.stringify(content)) { h.rev = cur.rev; draftStore.map.set(cur.id, { ...cur, dirty: false }); draftsChanged({ now: true }); return cur; }
      // Changed on another device since this one read it. Theirs stays as it is; this text becomes a draft of its own.
      draftStore.map.set(cur.id, { ...cur, dirty: false });
      ({ content, meta } = await draftFork(h, content, meta, files)); forked = true;
      if (!told) { told = true; toast("This draft was also changed on another device. Both versions are in Drafts.", 8000); }
    }
  }
  throw new Error("the draft could not be saved");
}
// Deletes the revision this device last saved, never a newer one another device wrote meanwhile: that one stays, and the hub says so.
//  Until the hub answers, the deletion is owed and kept on this device.
async function draftDelete(id) {
  const d = draftStore.map.get(id); if (d) { d.deleted = true; d.dirty = true; } draftViewRefresh(draftsChanged({ now: true }));
  const rev = d?.rev || 0;
  try { await api(`/api/drafts/${id}${rev ? "?rev=" + rev : ""}`, { method: "DELETE", keepalive: true }); draftDropBlobs(id, d); draftStore.map.delete(id); draftsChanged({ now: true }); }
  catch (e) {
    if (e.status === 409 && e.body?.current && !e.body.current.deleted) { draftStore.map.set(id, { ...e.body.current, dirty: false }); draftViewRefresh(draftsChanged({ now: true })); toast("That draft was changed on another device, so that version stays in Drafts", 7000); return; }
    draftRetrySoon();
  }
}
// The message went to the send queue (or Send later): its draft leaves now, after any save already on its way. The deletion is owed
// and written to this device's copy at once, so a page killed before the hub answers sends it on the next launch.
function draftSent(h) {
  clearTimeout(h.timer); h.closed = true;
  if (editors.r === h) editors.r = newHandle("r", h.key); if (editors.c === h) editors.c = newHandle("c"); draftStat(editors.r, "");
  if (!h.id) return; const id = h.id; const d = draftStore.map.get(id); if (d) { d.deleted = true; d.dirty = true; d.discardAt = null; }
  draftViewRefresh(draftsChanged({ now: true })); draftChain(id, () => draftDelete(id));
}
// Discard, with Undo: the draft is hidden at once and deleted on the hub when the toast has gone, so Undo brings it back whole. A sync
// meanwhile waits for that moment too.
function draftDiscard(id, { reopen = null } = {}) {
  if (!id) return;
  const d = draftStore.map.get(id); if (!d) return; d.deleted = true; d.dirty = true; d.discardAt = Date.now() + 6500; draftViewRefresh(draftsChanged({ now: true }));
  const t = setTimeout(() => draftChain(id, () => (draftStore.map.get(id)?.deleted ? draftDelete(id) : null)), 6500);
  toast("Draft discarded", 6000, () => { clearTimeout(t); const x = draftStore.map.get(id); if (x) { x.deleted = false; x.dirty = false; x.discardAt = null; } draftViewRefresh(draftsChanged({ now: true })); if (reopen) reopen(); }, "Undo");
}
async function draftRetry() {
  for (const d0 of [...draftStore.map.values()].filter((x) => x.dirty && !x.stuck)) {
    const owed = () => { const d = draftStore.map.get(d0.id); return d && d.dirty ? d : null; };   // re-read when its turn comes: a save or delete already on its way settles it
    if (d0.deleted) { if (d0.discardAt && d0.discardAt > Date.now()) continue; await draftChain(d0.id, () => (owed()?.deleted ? draftDelete(d0.id) : null)); continue; }
    // A draft open in a window is saved by that window, now, rather than waiting for the next keystroke.
    const w = editors.c.id === d0.id ? "c" : editors.r.id === d0.id ? "r" : null; if (w) { editors[w].sig = ""; draftFlush(w); continue; }
    await draftChain(d0.id, async () => {
      const d = owed(); if (!d || d.deleted) return;
      const h = newHandle(d.kind === "reply" ? "r" : "c", d.thread_key); h.id = d.id; h.rev = d.rev || 0; h.revive = !!d.revive;
      const files = await draftPendingFiles(d.id, d.pending); const up = await draftUpload(h, files);
      const content = { ...d.content, files: [...(d.content?.files || []), ...up.refs] }; const meta = draftMeta(content, content.files.length + up.pending.length);
      Object.assign(d, meta, { content, pending: up.pending });
      try { await draftPut(h, meta, content, files, up.pending); } catch (_) {}
    });
  }
}
// A full list (no cursor, or one older than the hub's prune) is read to its last page before this device drops a copy the hub no
// longer lists, and continues by seq (full=1), so a floor above the cursor cannot repeat page one.
async function syncDrafts() {
  if (draftStore.syncing) return draftStore.syncing;
  draftStore.syncing = (async () => {
    if (!draftStore.loaded) return;   // the boot has not read this device's copy yet: its refresh syncs after it
    await draftStore.loaded;
    await draftRetry();
    let moved = false, full = false, done = false; const seen = new Set(); let url = `/api/drafts?since=${draftStore.cursor || 0}`;
    for (let page = 0; page < 20; page++) {
      const r = await api(url);
      if (r.full) full = true;
      for (const d of r.drafts || []) { seen.add(d.id); if (await draftApply(d)) moved = true; }
      draftStore.cursor = r.cursor ?? draftStore.cursor;
      if (!r.more) { done = true; break; }
      url = `/api/drafts?since=${r.cursor}${full ? "&full=1" : ""}`;
    }
    if (full && done) for (const [id, d] of draftStore.map) if (!d.dirty && !seen.has(id)) { draftStore.map.delete(id); moved = true; }
    if (draftsChanged() || moved) draftViewRefresh(true); else renderNav();
  })().catch(() => {}).finally(() => { draftStore.syncing = null; });
  return draftStore.syncing;
}
// A change from another device. An editor holding this draft follows it when nothing was typed here since its last save; when
// something was, it is left alone and its next save meets the conflict above.
async function draftApply(d) {
  const mine = draftStore.map.get(d.id);
  if (mine?.dirty) return false;
  for (const w of ["c", "r"]) {
    const h = editors[w]; if (h.id !== d.id || (mine && d.rev <= h.rev)) continue;
    const snap = w === "c" ? draftSnapCompose() : draftSnapReply();
    if (draftSig(h, snap.content, snap.files) !== h.sig) continue;
    if (d.deleted) { h.closed = true; if (w === "c") { finishCompose(); } else { $("#rtext").value = sigFor($("#rfrom").value); clearFiles($("#rfiles")); editors.r = newHandle("r", h.key); draftStat(editors.r, ""); } toast("That draft was sent or discarded on another device", 5000); }
    else if (d.content) { h.rev = d.rev; if (w === "c") await draftFillCompose(h, d); else await draftFillReply(h, d); }
  }
  if (d.deleted) { draftStore.map.delete(d.id); return !!mine; }
  draftStore.map.set(d.id, { ...d, dirty: false }); return !mine || mine.kind !== d.kind || mine.thread_key !== d.thread_key;
}
// A draft's files into the window: those on the hub come down, those still waiting to go up come from this device. Files added while
// they came down stay, and a ref that could not come down stays on the draft instead of being dropped by the next save.
async function draftFilesInto(h, d, input) {
  const id = h.id, from = d.id; const files = [], keep = [];
  for (const ref of d.content?.files || []) { const f = await draftFetchFile(from, ref); if (f) { h.up.set(draftFileKey(f), { draftId: h.id, ref }); files.push(f); } else keep.push(ref); }
  files.push(...await draftPendingFiles(from, d.pending));
  if (h.id !== id || (editors.c !== h && editors.r !== h)) return null;   // the window moved on to another draft while these came down
  h.keep = keep; if (keep.length) toast(`${keep.length === 1 ? `"${keep[0].name}"` : keep.length + " files"} could not be brought back yet; ${keep.length === 1 ? "it stays" : "they stay"} on the draft`, 7000);
  if (files.length) setFiles(input, [...files, ...input.files]);
  return files;
}
// The signature is the draft as it was filled, taken before its files come down: whatever is typed or added meanwhile differs from it
// and is saved. The window's own change events while filling save nothing.
async function draftFillCompose(h, d) {
  const c = d.content || {}; h.filling = true;
  try {
    $("#cfrom").value = c.from || ""; $("#cname").value = c.from_name || ""; syncBrand("#cfrom"); if (c.plain && $("#cbrand")) $("#cbrand").checked = false;
    $("#cto").value = c.to || ""; $("#ccc").value = c.cc || ""; $("#cbcc").value = c.bcc || ""; $("#csub").value = c.subject || ""; $("#ctext").value = c.text || ""; $("#cmd").checked = !!c.md;
    $("#ctitle").textContent = c.fwd ? "Forward" : c.title && c.title !== "New message" ? c.title : "Draft";
    state.fwd = c.fwd && c.fwd.msgId ? { t: state.threads.get(c.fwd.key) || { kind: c.fwd.kind || "hub", key: c.fwd.key }, m: { id: c.fwd.msgId } } : null;
    if ($("#cfiles").files.length) clearFiles($("#cfiles"));
    const c0 = draftCaptureCompose();
    const files = await draftFilesInto(h, d, $("#cfiles")); if (!files) return;
    h.sig = (d.pending || []).length ? "" : draftSig(h, c0, files);
  } finally { h.filling = false; }
  if (editors.c === h && draftSig(h, draftCaptureCompose(), [...$("#cfiles").files]) !== h.sig) draftTouched("c");
}
async function draftFillReply(h, d) {
  const c = d.content || {}; h.filling = true;
  try {
    if (c.from) { $("#rfrom").value = c.from; $("#rname").value = c.from_name || nameFor(c.from); syncBrand("#rfrom"); }
    if (c.plain && $("#rbrand")) $("#rbrand").checked = false;
    $("#rall").checked = !!c.all; $("#rmd").checked = !!c.md; $("#rtext").value = c.text || "";
    const c0 = draftCaptureReply(h.key);
    const files = await draftFilesInto(h, d, $("#rfiles")); if (!files) return;
    h.sig = (d.pending || []).length ? "" : draftSig(h, c0, files); draftStat(h, "Draft");
  } finally { h.filling = false; }
  if (editors.r === h && draftSig(h, draftCaptureReply(h.key), [...$("#rfiles").files]) !== h.sig) draftTouched("r");
}
// A new message or forward from a draft; `files` are the File objects of a window just closed (Undo), else the draft's own come down.
async function openComposeFromDraft(d, { files = null, save = false } = {}) {
  openCompose({ draft: { from: d.content?.from }, draftId: d.id, rev: d.rev || 0 });
  const h = editors.c; if (save) h.revive = true;
  await draftFillCompose(h, files ? { ...d, content: { ...d.content, files: [] }, pending: [] } : d);
  if (files) setFiles($("#cfiles"), files);
  if (save) { h.sig = ""; draftFlush("c"); }
  $(($("#cto").value || "").trim() ? "#ctext" : "#cto").focus();
}
function draftTouched(w) {
  const h = editors[w];
  if (h.filling || (w === "c" ? !$("#cmodal").classList.contains("on") : !h.key)) return;
  clearTimeout(h.timer); h.timer = setTimeout(() => draftFlush(w), DRAFT_SAVE_MS);
}
function draftFlush(w) {
  const h = editors[w]; clearTimeout(h.timer); h.timer = null;
  if (h.filling || (w === "c" ? !$("#cmodal").classList.contains("on") : !h.key)) return Promise.resolve();
  return draftSave(h, w === "c" ? draftSnapCompose() : draftSnapReply());
}
// openThread: before the reply box is emptied for another conversation, what it holds is saved under its own conversation.
function draftLeaveReply(next) {
  const h = editors.r; if (!h.key || h.key === next) return;
  clearTimeout(h.timer); const snap = draftSnapReply(h.key); editors.r = newHandle("r", null);
  if (!h.filling) draftSave(h, snap);
}
// The reply draft of this conversation: the one picked in Drafts when it was, else the newest (two exist after a conflict).
function draftEnterReply(key) {
  const h = newHandle("r", key); editors.r = h;
  const want = draftStore.want && draftStore.map.get(draftStore.want); draftStore.want = null;
  const d = (want && !want.deleted && want.thread_key === key && want.content ? want : null) || draftLive().find((x) => x.kind === "reply" && x.thread_key === key && x.content);
  if (!d) { draftStat(h, ""); return; }
  h.id = d.id; h.rev = d.rev || 0; draftFillReply(h, d);
}
async function openDraft(id) {
  const d = draftStore.map.get(id); if (!d || d.deleted) return;
  // Unreadable here (its seal could not be opened): not opened, so closing a blank window cannot delete it.
  if (!d.content) return toast("This draft could not be opened. It is kept as it is.", 6000);
  if (d.kind === "reply" && d.thread_key) {
    const key = d.thread_key;
    if (!state.threads.has(key)) { const i = key.indexOf("|"); try { await ensureThreadLocal(key.slice(0, i), key.slice(i + 1)); } catch (_) {} }
    if (state.threads.has(key)) { draftStore.want = id; if (state.cur === key) { draftLeaveReply(null); draftEnterReply(key); } else await openThread(key); openReplySheet(); $("#rtext").focus(); return; }
    toast("That conversation is not on this device, so the reply opens as a new message", 7000);
    const c = d.content || {}; return openComposeFromDraft({ ...d, content: { ...c, kind: "new", title: "Draft" } });
  }
  openComposeFromDraft(d);
}
function renderDrafts() {
  renderNav(); syncTabbar(); $("#chips").innerHTML = "";
  const el = $("#threads"); const list = draftLive();
  el.innerHTML = list.length ? list.map((d) => {
    const acct = sideAccounts().find((a) => (a.addresses || []).map(lc).includes(lc(d.from || "")));
    const t = d.kind === "reply" ? state.threads.get(d.thread_key) : null;
    const who = unbidi(d.kind === "reply" ? (t ? rowPeer(t).label : d.to || "Reply") : (d.to ? d.to.split(",")[0].trim() : "(no recipients)"));
    const tag = d.kind === "reply" ? "Reply" : d.kind === "forward" ? "Forward" : "Draft";
    const snip = d.content ? d.snippet || "" : "This draft could not be opened";
    return `<div class="t drow" data-draft="${esc(d.id)}" style="grid-template-columns:1fr auto;cursor:pointer"><div class="who"><span class="drafttag">${tag}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(who)}</span>${d.n_files ? `<span class="hasatt" role="img" aria-label="Has files" title="${d.n_files} file${d.n_files > 1 ? "s" : ""}">${ico("attach")}</span>` : ""}</div><div class="when">${when(Date.parse(d.updated_at) || 0)}</div><div class="sub"><bdi>${esc(String(d.subject || "(no subject)").replace(BIDI_CTRL, ""))}</bdi>${acct ? ` <span class="badge" style="border-color:${acct.color};color:${acct.color}">${esc(acct.label)}</span>` : ""}</div><div class="snip" style="display:flex;gap:8px;align-items:center"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(snip) || "&#8203;"}</span><button class="ghost" data-ddel="${esc(d.id)}" style="padding:2px 8px;font-size:12px">Discard</button></div></div>`;
  }).join("") : '<div class="empty">No drafts. Anything you start writing is kept here until it is sent.</div>';
  el.querySelectorAll("[data-draft]").forEach((row) => row.onclick = (e) => { if (e.target.closest("[data-ddel]")) return; openDraft(row.dataset.draft); });
  el.querySelectorAll("[data-ddel]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); draftDiscard(b.dataset.ddel); });
}
for (const id of ["#cfrom", "#cname", "#cto", "#ccc", "#cbcc", "#csub", "#ctext"]) $(id).addEventListener("input", () => draftTouched("c"));
for (const id of ["#cfrom", "#cmd", "#cbrand", "#cfiles"]) $(id)?.addEventListener("change", () => draftTouched("c"));
for (const id of ["#rtext", "#rname"]) $(id).addEventListener("input", () => draftTouched("r"));
for (const id of ["#rfrom", "#rall", "#rmd", "#rbrand", "#rfiles"]) $(id)?.addEventListener("change", () => draftTouched("r"));
$("#cdiscard").onclick = () => {
  const h = editors.c; const snap = draftSnapCompose(); clearTimeout(h.timer); h.closed = true;
  const id = h.id; finishCompose();
  if (id) draftDiscard(id, { reopen: () => openComposeFromDraft({ id, rev: 0, content: snap.content }, { files: snap.files, save: true }) });
  else if (snap.work) toast("Message discarded", 6000, () => openComposeFromDraft({ id: draftUuid(), rev: 0, content: snap.content }, { files: snap.files, save: true }), "Undo");
};
$("#rdiscard").onclick = () => {
  const h = editors.r; if (!h.id || !h.key) return; const snap = draftSnapReply(); clearTimeout(h.timer); h.closed = true; const key = h.key, id = h.id;
  $("#rtext").value = sigFor($("#rfrom").value); clearFiles($("#rfiles")); $("#rall").checked = false; editors.r = newHandle("r", key); draftStat(editors.r, "");
  draftDiscard(id, { reopen: () => { if (state.cur !== key) return; const nh = newHandle("r", key); nh.id = id; nh.rev = h.rev; nh.revive = true; editors.r = nh; $("#rtext").value = snap.content.text; setFiles($("#rfiles"), snap.files); $("#rall").checked = !!snap.content.all; nh.sig = draftSig(nh, draftCaptureReply(key), [...$("#rfiles").files]); draftStat(nh, "Draft"); } });
};
addEventListener("visibilitychange", () => { if (document.hidden) { draftFlush("c"); draftFlush("r"); draftPersistNow(); } });
addEventListener("pagehide", () => { draftFlush("c"); draftFlush("r"); draftPersistNow(); });
// A message that could not be reopened yet (another one was being written) is put in Drafts at once, so it outlives a restart.
function draftFromArgs(args) {
  const d = args.draft || {}; const t = args.threadKey ? state.threads.get(args.threadKey) : null; const reply = !!(t && (args.replyTo || d.threadId));
  const files = (d.attachments || []).filter((a) => a && a.content && a.filename).map((a) => new File([Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))], a.filename, { type: a.type || "application/octet-stream" }));
  const list = (v) => Array.isArray(v) ? v.join(", ") : v || "";
  const content = reply
    ? { kind: "reply", key: t.key, from: lc(d.from || ""), from_name: d.from_name || "", all: d.mode === "all" || (Array.isArray(d.cc) && d.cc.length > 0), text: args.typed ?? d.text ?? "", md: !!d.html, plain: !!d.plain, subject: /^re:/i.test(t.subject || "") ? t.subject : "Re: " + (t.subject || ""), to: list(d.to) || (t.out ? t.to : t.fromAddr) || "" }
    : { kind: args.forwardOf ? "forward" : "new", from: lc(d.from || ""), from_name: d.from_name || "", to: list(d.to), cc: list(d.cc), bcc: list(d.bcc), subject: d.subject || "", text: args.typed ?? d.text ?? "", md: !!d.html, plain: !!d.plain, fwd: args.forwardOf ? { key: null, kind: "hub", msgId: args.forwardOf } : null, title: "Draft" };
  const h = newHandle(reply ? "r" : "c", reply ? t.key : null); h.id = args.draftId || draftUuid(); h.revive = true;
  return draftSave(h, { content, files, work: true });
}

// ---------- scheduled view ----------
async function renderScheduled() {
  const s = await api("/api/schedule?status=pending"); state.schedules = s.actions || [];
  $("#chips").innerHTML = ""; const el = $("#threads");
  el.innerHTML = state.schedules.length ? state.schedules.map((a) => `<div class="t" style="grid-template-columns:1fr auto"><div class="who">${esc(a.kind.replace("_", " "))} · ${esc(accountOf(a.account)?.label || a.account)}</div><div class="when">${esc(new Date(a.due_at).toLocaleString())}</div><div class="sub">${esc(a.payload?.subject || a.payload?.title || a.ref || "")}</div><div class="snip"><button data-cancel="${a.id}" style="padding:2px 8px;font-size:12px">Cancel</button></div></div>`).join("") : '<div class="empty">Nothing scheduled</div>';
  el.querySelectorAll("[data-cancel]").forEach((b) => b.onclick = async () => { const r = await api("/api/schedule/" + b.dataset.cancel, { method: "DELETE" }); if (r.kind === "snooze" && r.account !== "hub") { const k = `${r.account}|${r.ref}`, lt = state.threads.get(k); if (!lt || lt.state === "snoozed" || state.snoozedGmail.has(k)) { try { await gmailAdapter(r.account).act({ id: r.ref, state: "archived" }, "restore"); const id = await gmailLabel(r.account, "Snoozed (Mail)").catch(() => null); if (id) await gapi(r.account, `threads/${r.ref}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [], removeLabelIds: [id] }) }); } catch (_) {} } state.snoozedGmail.delete(k); } /* only a conversation still snoozed comes back */ toast("Cancelled"); renderScheduled(); });
}

// ---------- settings ----------
// Settings are written as one flat document of <h4> sections; this folds them into five tabs (all sections stay in the DOM so every
// handler below still finds its ids). The last tab is remembered per device.
// Settings, laid out like Spark's (better grouping, layout and dropdowns): on a wide screen a sidebar of
// sections beside the open one; on a phone a list to tap into, with back stepping out one level (its own history layer, so the
// Android back button does the same). Each section is boxed groups of rows (label and hint on the left, the control on the right)
// with switches for on/off and styled dropdowns. Every control keeps the id or data- attribute its handler in openSettings binds to.
const SETTINGS_NAV = [
  [["accounts", "Accounts", "accounts", "#8b5cf6"]],
  [["general", "General", "settings", "#3b82f6"], ["notifications", "Notifications", "notifications", "#ec4899"], ["inbox", "Inbox", "inbox", "#0ea5e9"], ["swipes", "Swipes", "swipes", "#10b981"], ["rules", "Sender rules", "filter", "#f59e0b"], ["unsubscribes", "Unsubscribes", "unsub", "#7c3aed"], ["trackers", "Trackers & ads", "block", "#dc2626"]],
  [["signatures", "Signatures", "compose", "#6366f1"], ["snippets", "Snippets", "newsletters", "#14b8a6"], ["shortcuts", "Shortcuts", "keyboard", "#22c55e"], ["search", "Search", "search", "#a855f7"]],
  [["data", "Storage & sync", "refresh", "#64748b"], ["speed", "Speed", "snoozed", "#ef4444"], ["about", "About", "more", "#94a3b8"]],
];
const SETTINGS_SECS = new Map(SETTINGS_NAV.flat().map((x) => [x[0], x]));
const settingsUI = { sec: null, inSec: false };   // the open section, and whether a phone is inside it (rather than on the list)
const settingsPhone = () => matchMedia(PHONE_MQ).matches;
const swipeColor = (a, right, long) => SWIPE_COLORS[a] || (long ? "var(--acc)" : right ? "var(--warn)" : "var(--ok)");   // exactly what attachSwipe paints
const ACTION_ICONS = { archive: "done", trash: "trash", snooze: "snoozed", spam: "spam", block: "block", unsubscribe: "unsub", star: "pin", read: "unread", unread: "all", none: "close" };
const SWIPE_SLOTS = [["swr", "right", "Swipe right", "short", true, false], ["swrl", "rightLong", "Swipe right", "long", true, true], ["swl", "left", "Swipe left", "short", false, false], ["swll", "leftLong", "Swipe left", "long", false, true]];
// A row seen from above: the coloured panel is what the swipe uncovers (a right swipe uncovers the left edge), wider for a long one.
const swipeGlyph = (right, long, c) => { const w = long ? 22 : 13, x = right ? 1 : 33 - w, cx = x + w / 2;
  return `<svg class="st-swg" viewBox="0 0 34 22" aria-hidden="true"><rect x="1" y="1" width="32" height="20" rx="5" style="fill:none;stroke:var(--mut);stroke-width:1.5;opacity:.55"/><rect x="${x}" y="1" width="${w}" height="20" rx="5" style="fill:${c}"/><path d="${right ? `M${cx - 4} 11h8m-3-3.5 3 3.5-3 3.5` : `M${cx + 4} 11h-8m3-3.5-3 3.5 3 3.5`}" style="fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"/></svg>`; };
const KEY_LABELS = { next: "Next conversation", prev: "Previous conversation", open: "Open", archive: "Done", trash: "Trash", star: "Pin", unread: "Mark unread", snooze: "Snooze", reply: "Reply", replyall: "Reply all", forward: "Forward", compose: "New message", search: "Search", select: "Select", palette: "Command palette", mute: "Mute", unsubscribe: "Unsubscribe", replylater: "Reply later", aside: "Set aside", back: "Back", readnext: "Mark read", selectall: "Select all shown", fromhere: "Select all from here" };
const sGroup = (title, body, { hint = "", action = "", cls = "" } = {}) => `<div class="st-grp">${title || action ? `<div class="st-gh"><div class="st-gt">${title}${hint ? `<div class="st-hint">${hint}</div>` : ""}</div>${action}</div>` : ""}<div class="st-box ${cls}">${body}</div></div>`;
// Settings → Sender rules → Address locks.
function lockSettingsHtml() {
  const locks = state.locks || [], doms = [...new Set((state.me.identities || []).map((i) => String(i.email || "").split("@")[1]).filter(Boolean))];
  const STATE = { active: "locked", closed: "closed", released: "released" };
  const rows = locks.map((l) => {
    const also = (l.allows || []).map((a) => a.domain).filter((d) => d !== l.claim);
    const hint = l.state === "released" ? "Not locked: mail arrives as it does at any address."
      : [l.state === "closed" ? "Everything is kept out" : l.claim ? `Belongs to ${esc(l.claim)}` : "Waiting for its first sender", also.length ? `also lets in ${also.map(esc).join(", ")}` : "", l.kept ? `${l.kept} kept out (in Held)` : ""].filter(Boolean).join(" · ");
    const btn = l.state === "active" ? `<button class="ghost" data-lkst="closed" data-lk="${esc(l.address)}">Close</button><button class="ghost" data-lkst="released" data-lk="${esc(l.address)}">Release</button>`
      : `<button class="ghost" data-lkst="active" data-lk="${esc(l.address)}">${l.state === "closed" ? "Reopen" : "Lock again"}</button>`;
    // Each domain or address let in besides the claimer, with a way to take it back out (a mistaken Let in, or a send that let in more
    // than it should).
    const chips = l.state === "released" || !also.length ? "" : `<div class="st-row"><div class="st-rl"><div class="st-hint">Also lets in</div></div><div class="st-rc" style="flex-wrap:wrap">${also.map((d) => `<button class="ghost" data-lkadel="${esc(l.address)}" data-lkadom="${esc(d)}" title="Stop letting ${esc(d)} in" aria-label="Stop letting ${esc(d)} in">${esc(d)} ✕</button>`).join("")}</div></div>`;
    return `<div class="st-row"><div class="st-rl"><div class="st-rt" style="overflow-wrap:anywhere">${esc(l.address)} <span class="badge">${STATE[l.state] || esc(l.state)}</span></div><div class="st-hint">${hint}</div></div><div class="st-rc">${btn}</div></div>${chips}`;
  });
  return sGroup("Address locks", rows.length ? rows.join("") : sRow("No locked addresses yet"), { hint: "An address that belongs to the company that first writes to it. Mail from anyone else waits in Held, with no notification, and is never bounced." })
    + sGroup("Lock a new address", `<div class="st-row"><input class="f" id="lkloc" placeholder="name, e.g. mybank" style="flex:1 1 140px;min-width:0" aria-label="Address name" autocapitalize="off" spellcheck="false"><div class="st-rc"><span aria-hidden="true">@</span><select class="f" id="lkdom" aria-label="Domain">${doms.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}</select><button id="lkadd" class="primary">Lock</button></div></div>`,
      { hint: "Or make one up anywhere, with no setup: an address that starts with x- (x-mybank@domain5.example) locks itself to its first sender." });
}
// Settings → Trackers & ads: what the hub blocks beyond the named spy trackers, and an Undo for any of it.
const TRK_SOURCE = { easylist: "EasyList", easyprivacy: "EasyPrivacy", learned: "learned from your mail", vendored: "MailTrackerBlocker rule" };
const TRK_STATE = { watch: "watching", on: "blocking", off: "turned itself off", wrong: "contradicted", veto: "allowed by you" };
function trackersSection() {
  const s = state.trk; if (!s) return sGroup("", sRow("The hub's tracker status could not be read just now"));
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
  const how = s.learner.mode === "on" ? "Learning from your mail is on: a new tracker is blocked on every device once two of its pixels have been seen."
    : `Learning from your mail is watching: it notes what it would block and blocks nothing yet. It starts by itself${s.on_at ? " on " + day(s.on_at) : ""} if nothing it learned is contradicted.`;
  const lists = s.lists.map((l) => sRow(esc(l.name), "", l.version ? `${l.cls === "ad" ? "Ads" : "Trackers"} · version ${esc(l.version)} · ${Number(l.rules || 0).toLocaleString()} rules${l.refused ? ` · ${l.refused} left out because they would hide real pictures` : ""}` : "Not fetched yet")).join("");
  const row = (title, badge, hint, btn) => `<div class="st-row"><div class="st-rl"><div class="st-rt" style="overflow-wrap:anywhere">${title}${badge ? ` <span class="badge">${badge}</span>` : ""}</div>${hint ? `<div class="st-hint">${hint}</div>` : ""}</div>${btn ? `<div class="st-rc">${btn}</div>` : ""}</div>`;
  const learned = s.rules.filter((r) => r.kind === "learned").map((r) => row(esc(r.pattern), TRK_STATE[r.state] || esc(r.state),
    [r.sender ? `mail from ${esc(r.sender)}` : "", `${r.tiny} pixels in ${r.mails} mails`, r.blocked ? `${r.blocked} blocked` : "", r.note ? esc(r.note) : ""].filter(Boolean).join(" · "),
    r.state === "on" || r.state === "watch" ? `<button class="ghost" data-trkveto="${esc(r.pattern)}" title="Show these pictures, and never learn this pattern again">Undo</button>` : "")).join("");
  const recent = s.recent.map((x) => row(esc(x.name), x.cls === "ad" ? "ad" : "tracker", `${esc(x.pattern)} · ${x.n} blocked · ${esc(TRK_SOURCE[x.source] || x.source)}`,
    `<button class="ghost" data-trkveto="${esc(x.pattern)}" title="Show these pictures from now on">Allow</button>`)).join("");
  const vetoes = s.rules.filter((r) => r.kind === "veto").map((r) => row(esc(r.pattern), "", `allowed ${day(r.changed_at)}`, `<button class="ghost" data-trkunveto="${esc(r.pattern)}">Block again</button>`)).join("");
  return sGroup("Spy trackers and ads", sRow(`Blocked in the last day: ${s.day.blocked || 0}`, "", how) + lists,
      { hint: "Beyond the named spy trackers, every picture is checked against two maintained lists, fetched each day, and against trackers learned from your own mail. A blocked picture is never fetched; a blocked ad is removed with its link." })
    + sGroup("Learned from your mail", learned || sRow("Nothing learned yet"), { hint: "A pattern is learned when it serves tiny invisible pictures, a new one in each mail, and never a real picture." })
    + sGroup("Blocked lately", recent || sRow("Nothing blocked in the last two weeks"), { hint: "Allow shows those pictures again, whichever list or rule blocked them." })
    + (vetoes ? sGroup("Allowed by you", vetoes) : "");
}
const sRow = (label, control = "", hint = "", cls = "") => `<div class="st-row ${cls}"><div class="st-rl"><div class="st-rt">${label}</div>${hint ? `<div class="st-hint">${hint}</div>` : ""}</div>${control ? `<div class="st-rc">${control}</div>` : ""}</div>`;
const sToggle = (id, on, label, hint = "") => `<div class="st-row"><label class="st-rl" for="${id}"><div class="st-rt">${label}</div>${hint ? `<div class="st-hint">${hint}</div>` : ""}</label><div class="st-rc"><input type="checkbox" class="tog" id="${id}" ${on ? "checked" : ""}></div></div>`;
const sAvatar = (txt, color) => `<span class="st-av" style="background:${color}">${esc(String(txt || "?")[0].toUpperCase())}</span>`;
// The work-mailbox form holds a typed password: it goes the moment the form is left; another section, back, close.
const clearImapForm = () => { const pw = document.getElementById("imPass"); if (pw) pw.value = ""; const sl = document.getElementById("imapformslot"); if (sl) sl.innerHTML = ""; };
function showSettingsSec(id, push = true) {
  if (!SETTINGS_SECS.has(id)) id = "accounts";
  if (id !== "accounts") clearImapForm();
  settingsUI.sec = id; try { localStorage.setItem("mh:ssec", id); } catch (_) {}
  $$("#scard [data-sec]").forEach((s) => (s.hidden = s.dataset.sec !== id));
  $$("#scard [data-sec-nav]").forEach((b) => b.classList.toggle("on", b.dataset.secNav === id));
  $("#sectitle").textContent = SETTINGS_SECS.get(id)[1]; $("#scard .st-body").scrollTop = 0;
  if (!settingsPhone()) return;
  $("#scard").classList.add("insec");
  if (!settingsUI.inSec) { settingsUI.inSec = true; if (push) pushLayer("settings-sec", () => { clearImapForm(); settingsUI.inSec = false; $("#scard").classList.remove("insec"); }); }
}
// Add a work mailbox, or give one its password. The servers the password will go to are found WITHOUT it and shown
// before Connect. The hub signs in to both servers with it before saving anything, then keeps it sealed; it never comes back to the
// page. The field is cleared the moment the hub says OK, and whenever the form is left.
function openImapForm(pre = {}) {
  const slot = $("#imapformslot"); if (!slot) return;
  const editing = !!pre.email;
  slot.innerHTML = sGroup(editing ? `${pre.ready ? "Change the password for" : "Add the password for"} ${esc(pre.email)}` : "Add a work account", `<div class="st-row stack">
      <input class="f" id="imEmail" type="email" autocomplete="username" spellcheck="false" placeholder="you@company.com" value="${esc(pre.email || "")}" ${editing ? 'readonly hidden' : ""} aria-label="Email address">
      <input class="f" id="imPass" type="password" autocomplete="current-password" placeholder="Mailbox password" aria-label="Mailbox password">
      ${editing ? "" : '<input class="f" id="imLabel" maxlength="40" placeholder="Label (optional), e.g. Work" aria-label="Label">'}
      <div class="st-hint" id="imSrv"></div>
      <div id="imAdv" style="display:none;gap:8px"><input class="f" id="imHost" spellcheck="false" placeholder="IMAP server, e.g. mail.company.com" aria-label="IMAP server"><input class="f" id="imSmtp" spellcheck="false" placeholder="SMTP server (sending), e.g. mail.company.com" aria-label="SMTP server"><input class="f" id="imUser" spellcheck="false" placeholder="Username (usually the email address)" aria-label="Username"></div>
      <div class="st-hint" id="imErr" role="alert" style="color:var(--danger)"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button id="imCancel" class="ghost">Cancel</button><button id="imGo" class="primary">Connect</button></div></div>`,
    { hint: "The hub signs in to the mail server with this password before saving anything, then keeps it encrypted. It is never shown again or sent anywhere else." });
  const adv = (on) => { $("#imAdv").style.display = on ? "grid" : "none"; };
  const show = () => { const h = $("#imHost").value.trim(), sm = $("#imSmtp").value.trim() || h;
    $("#imSrv").innerHTML = h ? `Signs in to <b>${esc(h)}</b> ${sm !== h ? `(IMAP 993) and <b>${esc(sm)}</b> (SMTP 465)` : "(IMAP 993, SMTP 465)"}, both encrypted${editing ? "" : ' · <a href="#" id="imEditSrv">change</a>'}` : "";   // an existing mailbox keeps its servers: moving one means removing it and adding it again
    const e = $("#imEditSrv"); if (e) e.onclick = (ev) => { ev.preventDefault(); adv(true); }; };
  if (pre.host) { $("#imHost").value = pre.host; $("#imSmtp").value = pre.smtp_host || pre.host; $("#imUser").value = pre.user || pre.email; show(); }
  let seq = 0;
  const discover = async () => { const email = $("#imEmail").value.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return; const my = ++seq; $("#imSrv").textContent = "Looking up the mail servers…";
    try { const d = await api("/api/imap/discover?email=" + encodeURIComponent(email)); if (my !== seq || !$("#imHost")) return;
      $("#imHost").value = d.host || ""; $("#imSmtp").value = d.smtp_host || ""; $("#imUser").value = d.username || email; show();
      if (!d.host) { adv(true); $("#imSrv").textContent = "Couldn't find the servers automatically. Enter them below."; } }
    catch (e) { if (my === seq && $("#imSrv")) { adv(true); $("#imSrv").textContent = e.message; } } };
  if (!editing) { let t = 0; $("#imEmail").oninput = () => { clearTimeout(t); t = setTimeout(discover, 450); }; $("#imEmail").onchange = discover; $("#imEmail").focus(); }
  else { if (!pre.host) discover(); $("#imPass").focus(); }
  $("#imHost").oninput = $("#imSmtp").oninput = show;
  $("#imCancel").onclick = clearImapForm;
  $("#imPass").onkeydown = (e) => { if (e.key === "Enter") $("#imGo").click(); };
  $("#imGo").onclick = async () => {
    const email = $("#imEmail").value.trim().toLowerCase(), password = $("#imPass").value, host = $("#imHost").value.trim().toLowerCase();
    if (!email || !password) return void ($("#imErr").textContent = "Enter the email address and its password");
    if (!host) { adv(true); return void ($("#imErr").textContent = "Enter the IMAP server"); }
    const go = $("#imGo"); go.disabled = true; go.textContent = "Checking the login…"; $("#imErr").textContent = "";
    try {
      const r = await api("/api/imap/accounts", { method: "POST", body: JSON.stringify({ email, password, host, smtp_host: $("#imSmtp").value.trim().toLowerCase() || host, username: $("#imUser").value.trim() || email, ...(editing ? {} : { label: $("#imLabel").value.trim() || null }) }) });
      clearImapForm();
      toast(`Connected ${email}${r.synced ? ` · ${r.synced} message${r.synced === 1 ? "" : "s"} loaded` : ""}`);
      await loadAccounts(); render(); refresh({ silent: true }); openSettings("accounts");
    } catch (e) { if ($("#imErr")) { $("#imErr").textContent = e.message; go.disabled = false; go.textContent = "Connect"; } }
  };
  slot.scrollIntoView({ block: "nearest" });
}
const closeSettings = () => { clearImapForm(); dropLayer("settings-sec"); if (!dropLayer("settings")) $("#smodal").classList.remove("on"); };
async function openSettings(want) {
  const already = $("#smodal").classList.contains("on");
  $("#smodal").classList.add("on"); closeMenu();
  // openSettings() also re-renders an open screen (after a rule is added, an account disconnected…): its layer is already there, and a
  // phone that is inside a section has that section's layer on top, which a second "settings" push would bury.
  if (!already) pushLayer("settings", () => { clearImapForm(); $("#smodal").classList.remove("on"); settingsUI.inSec = false; $("#scard").classList.remove("insec"); });
  const p = prefs(); const push = state.push;
  // Re-registering is worth one network round trip when you OPEN this screen to find out why push is quiet. It is not worth one
  // on every re-render: openSettings() is re-invoked after adding a rule, deleting a rule and disconnecting an account, and each
  // of those was blocking the repaint on a POST (and on a device where no worker ever activates, on the full 3 s ready race).
  if (!openSettings.synced) { openSettings.synced = true; await syncPushSubscription(); }
  const subs = await api("/api/push/subscriptions").catch(() => ({ subscriptions: [] }));
  state.quiet = (await api("/api/quiet-rules").catch(() => ({ rules: state.quiet || [] }))).rules || [];
  state.trashRules = (await api("/api/trash-rules").catch(() => ({ rules: state.trashRules || [] }))).rules || [];
  state.locks = (await api("/api/locks").catch(() => ({ locks: state.locks || [] }))).locks || [];
  state.mention = await api("/api/mention-rules").catch(() => state.mention || { rules: [], recent: [] });
  state.trk = await api("/api/trackers/status").catch(() => state.trk || null);
  await loadUnsubs();
  // The native apps have no Web Push at all (Android's WebView has no PushManager: reg.pushManager.getSubscription() threw here and
  // left Settings an empty card), and a browser's lookup may never settle, so neither may hold up this screen.
  const NATIVE = NATIVE_MAC || NATIVE_ANDROID || NATIVE_WINDOWS;
  const reg = NATIVE ? null : await Promise.race([navigator.serviceWorker?.getRegistration?.(), sleep(3000)]).catch(() => null);
  const sub = reg?.pushManager ? await Promise.race([reg.pushManager.getSubscription(), sleep(3000)]).catch(() => null) : null;
  const mineId = myPushId(); const mine = subs.subscriptions.find((x) => x.id === mineId) || null;
  const opt = (v, cur) => Object.entries(ACTIONS).map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${l}</option>`).join("");
  const sel = (id, pairs, cur, attrs = "") => `<select class="f" ${id ? `id="${id}"` : ""} ${attrs}>${pairs.map(([k, l]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const pending = queue.pending();
  const secs = {
    unsubscribes: unsubSection(),
    trackers: trackersSection(),
    accounts: `<div id="imapformslot"></div>` + sGroup("Sidebar", sideAccounts().map((a) => {
          const def = a.id === "hub" ? "Domains" : a.id.startsWith("hub:") ? a.domain : a.kind === "gmail" ? ((state.gmail.find((g) => g.email === a.id) || {}).label || a.id.split("@")[0].replace(/\./g, " ")) : ((imapAcctsAll().find((x) => x.email === a.id) || {}).label || a.id);
          const nd = (a.domains || hubDomains()).length, hint = a.id === "hub" ? `Your domains · ${nd} domain${nd === 1 ? "" : "s"}` : a.id.startsWith("hub:") ? "Your domain · " + a.addresses.map(esc).join(", ") : (a.kind === "gmail" ? "Gmail · " : "Work mailbox · ") + esc(a.id);
          return `<div class="st-row st-acct st-drag" data-side="${esc(a.id)}"><div class="st-rl"><button class="ghost icon st-grip" data-grip aria-label="Move ${esc(a.label)}: drag, or use the arrow keys" title="Drag to reorder">${ico("grip")}</button>${sAvatar(a.label, a.color)}<div style="min-width:0"><div class="st-rt">${esc(a.label)}</div><div class="st-hint">${hint}</div></div></div><div class="st-rc"><input type="color" class="st-color" data-scolor="${esc(a.id)}" value="${esc(hexOf(a.color))}" aria-label="Colour for ${esc(a.label)}"><input class="f" data-sname="${esc(a.id)}" value="${esc(acctNames()[a.id] || "")}" placeholder="${esc(def)}" maxlength="40" style="width:150px" aria-label="Name for ${esc(a.label)}"></div></div>`; }).join("")
        , { hint: "Drag to put the sidebar in your order. A name and a colour show in the sidebar and on each email; leave the name empty for the default." })
      // One switch per domain, where one switch split them all or none.
      + (hubDomains().length > 1 ? sGroup("Domains", hubDomains().map((d, i) => { const own = ownRowDomains().has(d);
          return `<div class="st-row"><label class="st-rl" for="ownrow${i}"><div class="st-rt">${esc(d)}</div><div class="st-hint">${own ? "Its own row in the sidebar" : "Under " + esc(acctNames().hub || "Domains")}</div></label><div class="st-rc"><input type="checkbox" class="tog" id="ownrow${i}" data-ownrow="${esc(d)}" ${own ? "checked" : ""} aria-label="Give ${esc(d)} its own row"></div></div>`; }).join(""),
        { hint: `Switch a domain on to give it its own row in the sidebar. The rest stay together under ${esc(acctNames().hub || "Domains")}, each email named by its domain.` }) : "")
      + sGroup("Email accounts",
        state.me.identities.map((i) => `<div class="st-row st-acct"><div class="st-rl">${sAvatar(i.email, "var(--acc)")}<div><div class="st-rt">${esc(i.email)}</div><div class="st-hint">Your domain${i.display_name ? " · sends as " + esc(i.display_name) : ""}</div></div></div></div>`).join("")
        + state.gmail.map((g) => `<div class="st-row st-acct"><div class="st-rl">${sAvatar(acctNames()[g.email] || g.label || g.email, acctColors()[g.email] || g.color || colorFor(g.email))}<div style="min-width:0"><div class="st-rt">${esc(g.email)}</div><div class="st-hint">Gmail${g.status !== "active" ? ` · <span style="color:var(--danger)">${esc(g.status)}</span>` : ""}</div></div></div><div class="st-rc"><button class="ghost st-danger" data-goff="${esc(g.email)}">Disconnect</button></div></div>`).join("")
        + imapAcctsAll().map((a) => `<div class="st-row st-acct"><div class="st-rl">${sAvatar(acctNames()[a.email] || a.label || a.email, acctColors()[a.email] || a.color || colorFor(a.email))}<div style="min-width:0"><div class="st-rt">${esc(a.email)}</div><div class="st-hint">Work mailbox${a.host ? " · " + esc(a.host) : ""} · ${imapStatusHtml(a)}</div></div></div><div class="st-rc"><button data-iedit="${esc(a.email)}"${a.ready ? "" : ' class="primary"'}>${a.ready ? "Change password" : "Add password"}</button>${a.source === "app" ? `<button class="ghost st-danger" data-idel="${esc(a.email)}">Remove</button>` : ""}</div></div>`).join(""),
        { hint: "The addresses this app reads and sends from. Names and colours are set under Sidebar.", action: `<span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${state.gmailConfigured ? '<a id="gmailConnect" href="/auth/gmail" style="text-decoration:none"><button class="primary">Connect Gmail</button></a>' : ""}<button id="imapAdd">Add work account</button></span>` })
      + (state.gmailConfigured ? "" : sGroup("", sRow("Gmail connect is not configured on the Worker")))
      + sGroup("Sign out", sRow("Sign out of this device", '<button id="signout">Sign out</button>', "Mail cached here is wiped.") + sRow("Sign out everywhere", '<button id="signoutall" class="st-danger">Sign out everywhere</button>', "Every browser and phone has to sign in again, and this device is wiped.")),
    general: sGroup("Writing", sRow("Compose in", sel("composemode", [["text", "Plain text"], ["markdown", "Markdown (sent as text + HTML)"]], composeMode()), "", "wide"))
      + sGroup("Links and duplicates", sToggle("chrome", p.openInChrome !== false, "Open links in Chrome", "Android: Chrome itself. Off: the in-app browser tab.") + sToggle("showdupes", !!p.showDupes, "Show Gmail copies of domain mail", "Normally hidden as duplicates.")),
    notifications: sGroup("This device",
        NATIVE ? sRow("Notifications", "", "Sent by the Sherit Mail app itself.") : !("Notification" in window) ? sRow("This browser has no notification support") :
        sRow("Notifications here", `<button id="penable" ${sub ? "" : 'class="primary"'}>${sub ? "Disable here" : "Enable"}</button><button id="ptest">Send test</button>`, `<span id="pstate">${!sub ? "Off" : mine ? "On" : "Subscribed here, but the hub has no record of it — tap Enable"}</span>`),
        { hint: NATIVE ? "" : "Install first for the best result: Android Chrome → menu → Add to Home screen. Mac Safari → File → Add to Dock. Then turn notifications on from inside the installed app." })
      + sGroup("Alerts", sRow("Notify me about", sel("notify", [["all", "All new mail"], ["smart", "Smart — people only (mutes automated senders and newsletters)"], ["priority", "Priority senders and threads only"], ["none", "Nothing"]], p.notify), "", "wide")
        + sRow("Notification shows", sel("notifyPreview", [["full", "Sender, subject and a line of the message"], ["subject", "Sender and subject"], ["sender", "Sender only"], ["none", "Only that new mail arrived"]], p.notifyPreview || "full"), "", "wide"))
      + sGroup("Buttons on notifications", [0, 1, 2].map((i) => sRow(["Left", "Middle", "Right"][i], sel("nb" + i, NOTIFY_BUTTON_CHOICES, notifyButtonsPref()[i] || ""), "", "wide")).join(""),
        { hint: "On the phone and in the Windows app, in this order; a change applies to the next notification. Reply is typed into the notification, which only the phone can do, so the PC leaves it out." })
      + sGroup("Don't notify me about", (state.quiet || []).map((r) => sRow(`<b style="overflow-wrap:anywhere">${esc(r.sender)}</b> · ${r.subject ? `“${esc(r.subject)}”` : "anything"}`, `<button class="ghost icon" data-qdel="${esc(r.id)}" title="Notify me about these again" aria-label="Remove this rule">${ico("close")}</button>`, r.hits ? `Stopped ${r.hits} notification${r.hits === 1 ? "" : "s"}${r.last_hit_at ? ", the last " + esc(String(r.last_hit_at).slice(0, 10)) : ""}` : "Nothing stopped yet")).join("")
        + `<div class="st-row"><input class="f" id="qsender" placeholder="address or *@domain" style="flex:1 1 180px;min-width:0" aria-label="Sender address or domain"><input class="f" id="qsubject" placeholder="words in the subject (optional)" style="flex:1 1 180px;min-width:0" aria-label="Words in the subject"><div class="st-rc"><button id="qadd">Add</button></div></div>`,
        { hint: "The mail still arrives; only its notification is skipped, on every device. Quickest: More → Don't notify… on a conversation, or Stop these on an Android notification." })
      + sGroup("Per account", accountsAll().map((a) => sRow(esc(a.label), sel("", [["", "Same as above"], ["all", "All new mail"], ["smart", "Smart"], ["priority", "Priority only"], ["none", "Nothing"]], (p.notifyByAccount || {})[a.id] || "", `data-notify="${esc(a.id)}" aria-label="Notifications for ${esc(a.label)}"`))).join(""), { hint: "Overrides the choice above for one account." })
      + (subs.subscriptions.length ? sGroup(`Registered devices (${subs.subscriptions.length})`, subs.subscriptions.map((x) => sRow(x.id === mineId ? "This device" : esc((x.ua || "Unknown device").slice(0, 60)), "", `${x.last_ok_at ? "Last push delivered " + esc(x.last_ok_at.slice(0, 16).replace("T", " ")) : "No push delivered yet"}${x.fail_count ? ` · <span style="color:var(--danger)">${x.fail_count} consecutive failures</span>` : ""}${x.last_error ? " · " + esc(String(x.last_error).slice(0, 60)) : ""}`)).join("")) : ""),
    inbox: sGroup("New senders", sToggle("gk", p.gatekeeper === "top", "Screen first-time senders", "They wait above the inbox until you accept them. Off: they arrive like normal mail with a “new” tag."))
      + sGroup("Grouping", sToggle("grp", !!p.groupSenders, "Group Notifications and Newsletters by sender")),
    swipes: sGroup("Swipe actions", SWIPE_SLOTS.map(([id, key, side, len, right, long]) => { const a = p.swipes[key]; const c = swipeColor(a, right, long);
        return `<div class="st-row"><div class="st-rl st-swl">${swipeGlyph(right, long, c)}<div class="st-rt">${side.replace("Swipe r", "R").replace("Swipe l", "L")} <span style="color:var(--mut)">·</span> ${len}</div></div><div class="st-rc"><label class="st-pick" style="--c:${c}">${ico(ACTION_ICONS[a] || "close")}<select class="f" id="${id}" aria-label="${side}, ${len}">${opt(id, a)}</select></label></div></div>`; }).join(""),
        { hint: "A short swipe, and a long one past about half the row. Each action shows its colour as you swipe." }),
    rules: sGroup("Rules", state.rules.length ? state.rules.map((r) => `<div class="st-row"><div class="st-rl" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${r.action ? `<span class="lbl ${r.action === "block" ? "scam" : r.action === "priority" ? "pri" : ""}">${esc(r.action)}</span>` : ""}<b style="overflow-wrap:anywhere">${esc(r.pattern)}</b>${r.category ? `<span class="badge">${esc(r.category)}</span>` : ""}<span class="badge">${r.scope === "*" ? "every account" : esc(r.scope)}</span></div><div class="st-rc"><button class="ghost" data-rdel="${r.id}">Remove</button></div></div>`).join("") : sRow("No rules yet", "", "Use Block sender or Priority sender on a message, or add one below."), { hint: "" })
      + sGroup("Add a rule", `<div class="st-row"><input class="f" id="rpat" placeholder="address or *@domain" style="flex:1 1 220px;min-width:0" aria-label="Address or domain"><div class="st-rc">${sel("ract", [["block", "Block"], ["priority", "Priority"], ["accept", "Accept"]], "block")}${sel("rscope", [["*", "Every account"], ...accountsAll().map((a) => [a.id, a.label])], "*")}<button id="radd" class="primary">Add</button></div></div>`,
        { hint: "An address rule beats a domain rule, and an account rule beats an every-account rule — so “block *@example.com” plus “accept alice@example.com” lets Alice through." })
      // Trash rules: what each has trashed, and a form to add one.
      + sGroup("Trash by sender name or subject", (state.trashRules || []).map((r) => sRow(`<b style="overflow-wrap:anywhere">${esc(trashRuleText(r))}</b>`, `<button class="ghost icon" data-trdel="${esc(r.id)}" title="Stop trashing this mail" aria-label="Remove this rule">${ico("close")}</button>`, `${esc(trashScopeLabel(r.scope))} · ${r.hits ? `trashed ${r.hits}${r.last_hit_at ? ", the last " + esc(String(r.last_hit_at).slice(0, 10)) : ""}` : "nothing trashed yet"}`)).join("")
        + `<div class="st-row"><input class="f" id="trname" placeholder="sender's name, e.g. Webmail" style="flex:1 1 160px;min-width:0" aria-label="Words of the sender's name"><input class="f" id="trsubject" placeholder="words in the subject" style="flex:1 1 160px;min-width:0" aria-label="Words in the subject"><div class="st-rc">${sel("trscope", [["*", "Every account"], ...hubDomains().map((d) => ["*@" + d, "Anything @" + d]), ...[...new Set([...state.me.identities.map((i) => lc(i.email)), ...imapAccts().map((a) => lc(a.email)), ...state.gmail.filter((g) => g.status === "active").map((g) => lc(g.email))])].map((e) => [e, e])], "*")}<button id="tradd">Add</button></div></div>`,
        { hint: "New mail whose sender's name or subject holds every one of the words goes straight to Trash, with no notification, whatever address it comes from. With both filled in, both must match. Quickest: More → Trash mail like this… on a conversation." })
      // "Delete unless it mentions": the rules with what each has done, the latest decisions, and a form to add one.
      + sGroup("Delete unless it mentions", (state.mention.rules || []).map((r) => sRow(`<b style="overflow-wrap:anywhere">${esc(r.pattern)}</b> · ${(r.words || []).map((w) => `“${esc(w)}”`).join(", ")}`, `<button class="ghost icon" data-mdel="${esc(r.id)}" title="Stop deleting this sender's mail" aria-label="Remove this rule">${ico("close")}</button>`, `${esc(mentionScopeLabel(r.scope))} · kept ${r.kept || 0}, deleted ${r.dropped || 0}${r.last_at ? ", the last " + esc(String(r.last_at).slice(0, 10)) : ""}`)).join("")
        + ((state.mention.recent || []).length ? `<div class="st-row stack"><div class="st-hint" style="margin:0">Latest: ${(state.mention.recent || []).slice(0, 8).map((d) => `${esc({ kept: "kept", rescued: "moved out of spam", dropped: "deleted", unread: "kept (not read in full)", failed: "left (Gmail refused)", claimed: "deciding" }[d.decision] || d.decision)} · ${esc(d.from_addr || "")} · ${esc(String(d.subject || "").slice(0, 70))}`).join("<br>")}</div></div>` : "")
        + `<div class="st-row"><input class="f" id="mpat" placeholder="address or *@domain" style="flex:1 1 180px;min-width:0" aria-label="Sender address or domain"><input class="f" id="mwords" placeholder="words, comma-separated" style="flex:1 1 180px;min-width:0" aria-label="Words that keep the mail"><div class="st-rc">${sel("mscope", [["*", "Every Gmail account"], ...state.gmail.filter((g) => g.status === "active").map((g) => [g.email, g.label || g.email]), ["hub", MENTION_HUB_LABEL]], "*")}<button id="madd">Add</button></div></div>`,
        { hint: "New mail from these senders is read when it arrives. If it mentions one of the words it stays, or leaves Spam, and notifies you. If not, it goes to the trash (Gmail's for Gmail mail; for your domains and work mailbox, Trash here), which keeps it 30 days. A domain covers its subdomains. Quickest: More → Delete unless it mentions… on a conversation, which also lists the rules covering its sender." })
      + lockSettingsHtml(),
    signatures: sGroup("Signatures", [["*", "Default"], ...state.me.identities.map((i) => [i.email, i.email]), ...state.gmail.filter((g) => g.status === "active").map((g) => [g.email, g.email])].map(([k, l]) => `<div class="st-row stack"><div class="st-rl"><div class="st-rt">${esc(l)}</div>${k === "*" ? '<div class="st-hint">Used when an account has no signature of its own.</div>' : ""}</div><textarea data-sig="${esc(k)}" style="min-height:64px" placeholder="${k === "*" ? "Default signature" : "Signature for this address"}" aria-label="Signature for ${esc(l)}">${esc(p.signatures[k] || "")}</textarea></div>`).join(""), { hint: "Added below what you write. Saved when you leave the box." }),
    snippets: sGroup("Your snippets", `<div id="snips">${p.snippets.length ? p.snippets.map((sn, i) => `<div class="st-row"><div class="st-rl"><div class="st-rt">${esc(sn.name)}</div><div class="st-hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((sn.text || "").slice(0, 120))}</div></div><div class="st-rc"><button data-snedit="${i}">Edit</button><button data-sndel="${i}" class="ghost st-danger">Remove</button></div></div>`).join("") : sRow("No snippets yet")}</div>`,
        { hint: "Insert one from the command palette (⌘K), or type <code>;name</code> then Tab in any message box." })
      + sGroup("Add or edit", `<div class="st-row stack"><input class="f" id="snname" placeholder="Name" aria-label="Snippet name"><textarea id="sntext" placeholder="Text — variables allowed" style="min-height:80px" aria-label="Snippet text"></textarea><div style="display:flex;justify-content:flex-end"><button id="snadd" class="primary">Save snippet</button></div></div>`,
        { hint: "Variables: <code>{{name}}</code> <code>{{first}}</code> <code>{{email}}</code> <code>{{date}}</code> <code>{{subject}}</code> <code>{{ask:label}}</code>" }),
    shortcuts: sGroup("Keyboard shortcuts", Object.keys(KEY_DEFAULTS).map((k) => sRow(esc(KEY_LABELS[k] || k), `<input class="f st-key" data-key="${k}" value="${esc(keyFor(k))}" aria-label="Key for ${esc(KEY_LABELS[k] || k)}">`)).join(""),
        { hint: "Type a key to change one; clear it to go back to the default.", action: '<button id="keysreset" class="ghost">Reset to defaults</button>', cls: "cols2" }),
    search: sGroup("Search index", sRow("Engine", '<button id="reindex">Rebuild index</button>', `${esc(searchIndex.status.mode === "opfs" ? "SQLite FTS5, kept on this device" : searchIndex.status.mode === "memory" ? "SQLite FTS5 in memory (rebuilt each open)" : "Substring scan (worker unavailable)")} · ${searchIndex.status.indexed} indexed${searchIndex.status.error ? ` · <span style="color:var(--danger)">${esc(searchIndex.status.error)}</span>` : ""}`))
      + sGroup("Operators", sRow("<code>from:</code> <code>to:</code> <code>subject:</code> <code>body:</code> <code>account:</code> <code>\"exact phrase\"</code> <code>-exclude</code>", "", "Words match prefixes; results rank by relevance.")),
    data: sGroup("This device", `<div class="st-row"><div id="syncstat" class="st-hint" style="flex:1 1 100%;margin:0"></div></div>`
        + sRow(`Pending actions: <b id="qstat">${pending.length}</b>${pending.filter((r) => r.attempts).length ? " · retrying" : ""}`, '<button id="qdrain">Send now</button>', "Changes made here that have not reached the server yet.")
        + (pending.length ? `<div class="st-row stack">${pending.slice(0, 30).map((r) => { const t = r.threadKey && state.threads.get(r.threadKey); const what = r.op === "bulk" ? `bulk ${esc(r.args?.action || "")} × ${(r.args?.keys || []).length}` : r.op === "send" ? "send: " + esc((r.args?.draft?.subject || "(no subject)").slice(0, 50)) : `${esc(r.args?.action || r.op)}: ${esc((t && shownSubject(t)) || r.threadKey || "").slice(0, 50)}`; const when = r.notBefore > Date.now() ? `next try in ${Math.ceil((r.notBefore - Date.now()) / 1000)} s` : "due now"; return `<div class="st-hint" style="display:flex;gap:8px;align-items:center"><span style="flex:1">${what} · ${esc(r.account || "")} · attempts ${r.attempts || 0} · ${when}${r.error ? " · " + esc(String(r.error).slice(0, 80)) : ""}</span><button class="ghost" data-qdiscard="${esc(r.key)}" title="Forget this action and put the row back the way it was">Discard</button></div>`; }).join("")}<div><button class="ghost st-danger" id="qdiscardall">Discard all pending</button></div></div>` : "")
        + sRow("Re-sync now", '<button id="resync">Re-sync</button>', "Fetch every account again."))
      + sGroup("Bulk actions", `<div id="bulklog">${state.bulkLog.length ? state.bulkLog.map((j) => `<div class="st-row"><div class="st-rl"><div class="st-rt">${esc(bulkWord[j.action] || j.action)} · ${j.count} conversation${j.count === 1 ? "" : "s"}</div><div class="st-hint">${esc(new Date(j.at).toLocaleString())} · ${esc(j.status)}</div></div><div class="st-rc">${["failed", "partial"].includes(j.status) ? `<button data-bretry="${esc(j.id)}">Retry the rest</button>` : ""}${j.status === "undo_failed" ? `<button data-bundo="${esc(j.id)}">Retry undo</button>` : ""}${["done", "partial", "queued"].includes(j.status) && Date.now() - j.at < 7 * 86400000 ? `<button data-bundo="${esc(j.id)}" class="ghost">Undo</button>` : ""}</div></div>`).join("") : sRow("No bulk actions yet", "", "Select rows (x, Shift+click, ⌘A) or use Done all / Trash all.")}</div>`)
      + sGroup("Reset", sRow("Wipe local data", '<button id="wipe" class="st-danger">Wipe</button>', "Clears all mail cached on this device and syncs again from scratch.")),
    speed: sGroup("Measured on this device", `<div class="st-row"><div id="speed" class="st-hint" style="flex:1 1 100%;margin:0;min-width:0"></div></div>`,
        { action: '<span style="display:flex;gap:6px;flex-wrap:wrap"><button id="speedRefresh">Refresh</button><button id="speedCopy">Copy JSON</button><button id="speedReset" class="ghost">Reset</button></span>' }),
    about: sGroup("Sherit Mail", sRow("Version", "", esc(VERSION)) + (NATIVE_ANDROID ? sRow(`Android app <span id="appver">${esc(ANDROID_VERSION || "")}</span>`, '<button id="appupd" hidden></button>', '<span id="appupdhint"></span>') : "") + sRow('<a href="/privacy">Privacy</a>')),
  };
  const card = $("#scard"); card.className = "card st";
  card.innerHTML = `<button id="sclose" class="ghost icon st-x" title="Close" aria-label="Close settings">${ico("close")}</button>
    <nav class="st-nav"><h3>Settings</h3>${SETTINGS_NAV.map((g) => `<div class="st-navg">${g.map(([id, label, icon, color]) => `<button class="st-nav-b" data-sec-nav="${id}"><span class="st-ic" style="--c:${color}">${ico(icon)}</span><span class="st-nl">${label}${id === "unsubscribes" && unsubNeedCount() ? ` <span class="lbl">${unsubNeedCount()}</span>` : ""}</span><svg class="i st-chev" aria-hidden="true"><use href="#i-back"/></svg></button>`).join("")}</div>`).join("")}</nav>
    <div class="st-main"><div class="st-head"><button id="sback" class="ghost icon" title="Back" aria-label="Back to settings">${ico("back")}</button><h2 id="sectitle"></h2></div>
    <div class="st-body">${Object.entries(secs).map(([id, html]) => `<section data-sec="${id}" hidden>${html}</section>`).join("")}</div></div>`;
  $$("#scard [data-sec-nav]").forEach((b) => b.onclick = () => showSettingsSec(b.dataset.secNav));
  $("#sback").onclick = () => dropLayer("settings-sec");
  let saved = null; try { saved = localStorage.getItem("mh:ssec"); } catch (_) {}
  const start = SETTINGS_SECS.has(want) ? want : settingsUI.sec || saved || "accounts";
  if (SETTINGS_SECS.has(want) || !settingsPhone() || settingsUI.inSec) { showSettingsSec(start); if (settingsUI.inSec && settingsPhone()) card.classList.add("insec"); }
  else { settingsUI.sec = start; $$("#scard [data-sec]").forEach((s) => (s.hidden = s.dataset.sec !== start)); $("#sectitle").textContent = SETTINGS_SECS.get(start)?.[1] || ""; }
  $("#sclose").onclick = closeSettings;
  const renderSync = async () => { const est = await (navigator.storage?.estimate?.() || Promise.resolve(null)); const states = (await idb.getAll("state")).filter((st) => !(typeof gmailViaHub === "function" && gmailViaHub(st.account))); const nT = await idb.count("threads"), nM = await idb.count("messages"), nB = await idb.count("bodies"); $("#syncstat").innerHTML = `<div>${nT} threads · ${nM} messages · ${nB} cached bodies · ${est ? Math.round((est.usage || 0) / 1048576) + " MB used of " + Math.round((est.quota || 0) / 1048576) + " MB" : "storage unknown"} · snapshot ${snapshot.read()?.threads?.length ?? 0} rows</div>` + states.map((st) => { const p = syncState.progress[st.account] || {}; return `<div><b>${esc(st.account)}</b>: ${st.filled ? "synced" : "filling"} ${p.phase && p.phase !== "idle" ? "(" + esc(p.phase) + (p.total ? " " + p.done + "/" + p.total : "") + (p.note ? ", " + esc(p.note) : "") + ")" : ""}${st.owed?.length ? ` · ${st.owed.length} to download` : ""} · history ${esc(String(st.historyId || "–"))} · last sync ${st.lastSyncAt ? esc(when(st.lastSyncAt)) : "–"}</div>`; }).join("") + viaHubLines(); };
  // An account synced through the hub no longer runs the direct sync, so its history and "last sync" above would be the
  // old direct path's and go stale (my phone: "last sync 04:04 PM" while the hub had read Gmail a minute before).
  // It gets its own line instead: when the hub last read Gmail for it, and anything the hub still owes. Accounts this device never synced
  // directly are listed too.
  const viaHubLines = () => { if (typeof gmailHub === "undefined" || !gmailHub.switched) return ""; return Object.keys(gmailHub.switched).sort().map((email) => { const s = (gmailHub.status || {})[email] || {}, p = syncState.progress[email] || {}; return `<div><b>${esc(email)}</b>: synced through the hub · the hub last read Gmail ${s.synced_at ? esc(when(Date.parse(s.synced_at))) : "–"}${s.owed ? ` · ${s.owed} still to fetch there` : ""}${p.behind ? " · updating" : ""}</div>`; }).join(""); };
  $("#reindex").onclick = () => { ensureSearch(); searchIndex.rebuild([...state.threads.values()]).then(() => backfillBodyIndex()).then((n) => toast(`Search index rebuilt${n ? ` · ${n} conversation bodies` : ""}`)); }; // rebuild() alone restores metadata only
  if (NATIVE_ANDROID) androidUpdateRow();
  $("#qdrain").onclick = () => queue.drain().then(() => { $("#qstat").textContent = queue.pending().length; });
  $$("[data-qdiscard]").forEach((b) => b.onclick = () => queue.discard(b.dataset.qdiscard).then(() => { toast("Action discarded"); openSettings(); }));
  const dall = $("#qdiscardall"); if (dall) dall.onclick = async () => { if (!(await ask("Discard every pending action? Rows go back to how they were before those actions.", { ok: "Discard all", danger: true }))) return; for (const r of queue.pending()) await queue.discard(r.key); toast("Pending actions discarded"); openSettings(); };
  renderSync(); $("#resync").onclick = () => refresh().then(renderSync); $("#wipe").onclick = async () => { if (!(await ask("Wipe all mail cached on this device and re-sync from scratch?", { ok: "Wipe", danger: true }))) return; await wipeDevice(); location.reload(); };
  $("#signoutall").onclick = async () => { if (!(await ask("Sign out on every device? Every browser and phone will need to sign in again, and this device's cache is wiped.", { ok: "Sign out everywhere", danger: true }))) return; await signOut(true); };
  $("#signout").onclick = async () => { if (!(await ask("Sign out? Mail cached on this device will be wiped.", { ok: "Sign out", danger: true }))) return; await signOut(false); };
  const renderSpeed = () => { const r = perf.report(); $("#speed").innerHTML = `<div style="margin-bottom:4px">Shell from service worker: <b style="color:${r.swControlled ? "var(--ok)" : "var(--danger)"}">${r.swControlled ? "yes" : "NO — every boot refetches the shell"}</b> · installed as <b>${esc(r.display)}</b>${r.conn.type ? ` · network <b>${esc(r.conn.type)}</b>${r.conn.rttMs != null ? ` (~${r.conn.rttMs} ms RTT)` : ""}` : ""}${r.nav ? ` · TTFB ${r.nav.ttfb} ms` : ""}</div><div>Boot: cached rows ${r.boot.cached ?? "–"} · push stashes found ${r.boot.stashes ?? "–"}, adopted <b>${r.boot.adopted ?? "–"}</b> · resumes ${r.boot.resumes ?? 0} (stashes found ${r.boot.resumeFound ?? 0}, adopted <b>${r.boot.resumeAdopted ?? 0}</b>) · store ready ${r.boot.storeReady ?? "–"} ms · first paint ${r.boot.firstPaint ?? "–"} ms · network done ${r.boot.networkDone ?? "–"} ms · last refresh ${perf.lastRefreshCalls ?? "–"} calls (${r.net.lists} lists / ${r.net.gets} gets / ${r.net.history} history since load, ${Math.round(r.net.bytes / 1024)} KB known)</div><table style="width:100%;border-collapse:collapse;margin-top:6px"><tr style="color:var(--mut)"><td>interaction</td><td>n</td><td>&lt;50</td><td>&lt;100</td><td>&lt;1000</td><td>p50</td><td>p95</td></tr>${r.rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.n}</td><td>${x.under50}%</td><td style="font-weight:${x.under100 >= 95 ? 700 : 400};color:${x.under100 >= 95 ? "var(--ok)" : x.under100 >= 80 ? "var(--warn)" : "var(--danger)"}">${x.under100}%</td><td>${x.under1000}%</td><td>${x.p50 ?? "–"}</td><td>${x.p95 ?? "–"}</td></tr>`).join("") || "<tr><td colspan=7>No interactions measured yet — use the app, then refresh</td></tr>"}</table><div style="color:var(--mut);margin-top:4px">Timed from the input event to the next frame; 100 ms is the ceiling, 50 ms the target; hidden-tab samples dropped.</div>`; };
  // What the service worker did with each recent push (sw.js notePush): the only view there is of whether this device downloads
  // mail in the background, which is what makes it already be there when the app opens.
  const renderPushLog = async () => { try { const log = (await idb.meta("pushlog")) || []; const el = $("#speed"); if (!el) return;
    const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    el.insertAdjacentHTML("beforeend", `<div style="margin-top:8px"><b>Recent pushes on this device</b> (${log.length})</div>` + (log.length ? `<table style="width:100%;border-collapse:collapse"><tr style="color:var(--mut)"><td>arrived</td><td>late by</td><td>windows / visible</td><td>background download</td></tr>${log.slice().reverse().slice(0, 12).map((e) => `<tr><td>${esc(t(e.at))}</td><td>${e.sentAt ? Math.round((e.at - e.sentAt) / 1000) + " s" : "–"}</td><td>${e.windows} / ${e.visible}</td><td style="color:${e.pf === "stashed" ? "var(--ok)" : e.pf === "n/a" ? "var(--mut)" : "var(--warn)"}">${esc(e.pf)}</td></tr>`).join("")}</table>` : `<div style="color:var(--mut)">None recorded since this build was installed.</div>`)); } catch (_) {} };
  const renderSpeedAll = () => { renderSpeed(); renderPushLog(); };
  renderSpeedAll(); $("#speedRefresh").onclick = renderSpeedAll; $("#speedReset").onclick = () => { perf.reset(); renderSpeedAll(); };
  // One tap to get the numbers OFF the phone. Clipboard is unreliable in an installed Android PWA, and the point of this button is
  // a device whose measurements cannot be taken any other way, so Web Share first, clipboard second, a selectable box last.
  $("#speedCopy").onclick = async () => {
    let pushlog = []; try { pushlog = (await idb.meta("pushlog")) || []; } catch (_) {}
    const j = JSON.stringify({ ...perf.report(), pushlog }, null, 1);
    const name = `mailhub-speed-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`;
    try { const f = new File([j], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: "mailhub speed" }); return; } } catch (_) {}
    try { if (navigator.share) { await navigator.share({ title: "mailhub speed", text: j }); return; } } catch (_) {}
    try { await navigator.clipboard.writeText(j); toast("Baseline copied"); return; } catch (_) {}
    askText("Baseline JSON (copy it)", j);
  };
  // The sidebar: names, the split, and the order; dragged by the grip (finger or mouse) or moved with the arrow keys.
  $$("[data-sname]").forEach((i) => i.onchange = () => { const names = { ...acctNames() }; const v = i.value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
    if (v) names[i.dataset.sname] = v; else delete names[i.dataset.sname]; setPref("acctNames", names).then(() => { render(); openSettings("accounts"); }); });
  $$("[data-scolor]").forEach((i) => i.onchange = () => { if (!/^#[0-9a-f]{6}$/i.test(i.value)) return; const colors = { ...acctColors(), [i.dataset.scolor]: i.value.toLowerCase() };
    setPref("acctColors", colors).then(() => { render(); openSettings("accounts"); }); });
  // A domain's own row on or off. The old all-or-nothing switch, if it was ever on, gives way to the list it stood for. A view of an entry
  // that is gone goes to every account; a chip for a domain that left the Domains entry is dropped.
  $$("[data-ownrow]").forEach((i) => i.onchange = async () => { const own = new Set(ownRowDomains()); if (i.checked) own.add(i.dataset.ownrow); else own.delete(i.dataset.ownrow);
    await setPref("ownRows", [...own].sort()); if (state.prefs.splitDomains) await setPref("splitDomains", false);
    const v = state.view; if (v.account && !sideAccounts().some((a) => a.id === v.account)) setView(v.kind, null); else if (v.dom) setView(v.kind, v.account, v.dom); else render(); openSettings("accounts"); });
  const sideRows = () => $$("#scard [data-side]");
  const saveOrder = () => setPref("acctOrder", sideRows().map((r) => r.dataset.side)).then(render);
  for (const g of $$("#scard [data-grip]")) {
    const row = g.closest("[data-side]");
    g.onkeydown = (e) => { if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return; e.preventDefault();
      const sib = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling; if (!sib || !sib.dataset || !sib.dataset.side) return;
      if (e.key === "ArrowUp") sib.before(row); else sib.after(row); g.focus(); saveOrder(); };
    g.onpointerdown = (e) => {
      // Listened for on the document, not the grip: moving the row moves the grip in the DOM, which drops a pointer capture, and the
      // release then never reached the grip (the order was never saved).
      if (e.button > 0) return; e.preventDefault(); const pid = e.pointerId; row.classList.add("dragging"); let moved = false;
      const move = (ev) => { if (ev.pointerId !== pid) return; const others = sideRows().filter((r) => r !== row); if (!others.length) return;
        const before = others.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
        if (before) { if (before.previousElementSibling !== row) { before.before(row); moved = true; } }
        else { const last = others[others.length - 1]; if (last.nextElementSibling !== row) { last.after(row); moved = true; } } };
      const up = (ev) => { if (ev.pointerId !== pid) return; document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up); row.classList.remove("dragging"); if (moved) { try { navigator.vibrate?.(6); } catch (_) {} saveOrder(); } };
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up); };
  }
  $$("[data-goff]").forEach((b) => b.onclick = async () => { if (!(await ask(`Disconnect ${b.dataset.goff}? The app loses access; Gmail itself is untouched.`, { ok: "Disconnect", danger: true }))) return; await api(`/api/gmail/accounts/${encodeURIComponent(b.dataset.goff)}`, { method: "DELETE" }); await loadAccounts(); openSettings(); refresh({ silent: true }); });
  // the row's glyph and the picker's icon follow the choice at once, in the colour that swipe will show
  const paintSwipeSlots = () => { for (const [id, , , , right, long] of SWIPE_SLOTS) { const el = $("#" + id); const a = el.value; const c = swipeColor(a, right, long); const row = el.closest(".st-row"); row.querySelector(".st-swg").outerHTML = swipeGlyph(right, long, c); const pick = el.closest(".st-pick"); pick.style.setProperty("--c", c); pick.querySelector("svg.i").outerHTML = ico(ACTION_ICONS[a] || "close"); } };
  if ($("#imapAdd")) $("#imapAdd").onclick = () => openImapForm();
  // Connect Gmail carries a one-time ticket: the native apps open it in the default browser, which has no hub session. Without a
  // ticket (the request failed) it is the plain link, which still works where the browser is signed in.
  if ($("#gmailConnect")) $("#gmailConnect").onclick = async (e) => {
    e.preventDefault(); let t = "";
    try { t = (await api("/api/gmail/ticket", { method: "POST" })).ticket || ""; } catch (_) {}
    gmailConnectWatch();
    location.href = "/auth/gmail" + (t ? "?ticket=" + encodeURIComponent(t) : "");
  };
  $$("[data-iedit]").forEach((b) => b.onclick = () => openImapForm(imapAcctsAll().find((a) => a.email === b.dataset.iedit) || { email: b.dataset.iedit }));
  $$("[data-idel]").forEach((b) => b.onclick = async () => { const em = b.dataset.idel; if (!(await ask(`Remove ${em}? Its mail stays in the app. The hub deletes the saved password and stops syncing it.`, { ok: "Remove", danger: true }))) return; try { await api(`/api/imap/accounts/${encodeURIComponent(em)}`, { method: "DELETE" }); await loadAccounts(); render(); toast("Removed " + em); openSettings("accounts"); } catch (e) { toast(e.message); } });
  $("#swr").onchange = $("#swl").onchange = $("#swrl").onchange = $("#swll").onchange = () => { paintSwipeSlots(); const sw = { right: $("#swr").value, rightLong: $("#swrl").value, left: $("#swl").value, leftLong: $("#swll").value }; api("/api/prefs", { method: "PUT", body: JSON.stringify({ swipes: sw }) }).then(() => { state.prefs.swipes = sw; render(); }); };
  $$("[data-notify]").forEach((sel) => sel.onchange = () => { const by = { ...(prefs().notifyByAccount || {}) }; if (sel.value) by[sel.dataset.notify] = sel.value; else delete by[sel.dataset.notify]; setPref("notifyByAccount", by); });
  $$("[data-bundo]").forEach((b) => b.onclick = () => bulkUndo(b.dataset.bundo).then(openSettings));
  $$("[data-bretry]").forEach((b) => b.onclick = async () => { const j = state.bulkLog.find((x) => x.id === b.dataset.bretry); if (!j) return; const rest = j.keys.filter((k) => !(j.done || []).includes(k)); const p = BULK_PATCH[j.action]; for (const k of rest) { const t = state.threads.get(k); if (t && p) Object.assign(t, p); } j.status = "queued"; await bulkLogSave(state.bulkLog); render(); await queue.add({ op: "bulk", account: "bulk", threadKey: "bulk:" + j.id, args: { id: j.id, action: j.action, keys: j.keys, done: j.done || [] } }); openSettings(); });
  $$("[data-sndel]").forEach((b) => b.onclick = () => setPref("snippets", prefs().snippets.filter((_, i) => i !== +b.dataset.sndel)).then(openSettings));
  $$("[data-snedit]").forEach((b) => b.onclick = () => { const sn = prefs().snippets[+b.dataset.snedit]; $("#snname").value = sn.name; $("#sntext").value = sn.text; });
  $("#snadd").onclick = () => { const name = $("#snname").value.trim(), text = $("#sntext").value; if (!name || !text) return; setPref("snippets", [...prefs().snippets.filter((s) => s.name !== name), { name, text }]).then(openSettings); };
  $$("[data-key]").forEach((i) => i.onchange = () => { const keys = { ...(prefs().keys || {}) }; if (i.value.trim()) keys[i.dataset.key] = i.value.trim(); else delete keys[i.dataset.key]; setPref("keys", keys); });
  $("#keysreset").onclick = () => setPref("keys", {}).then(openSettings);
  $("#composemode").onchange = () => { setPref("compose", $("#composemode").value); $$("#cmd, #rmd").forEach((x) => (x.checked = $("#composemode").value === "markdown")); };
  $("#notify").onchange = () => setPref("notify", $("#notify").value).then(() => toast("Notification policy: " + $("#notify").value));
  // The three slots are saved as one list, in order, without gaps or repeats.
  for (const i of [0, 1, 2]) if ($("#nb" + i)) $("#nb" + i).onchange = () => { const v = [...new Set([0, 1, 2].map((j) => $("#nb" + j).value).filter(Boolean))];
    setPref("notifyButtons", v).then(() => { toast(v.length ? "Notifications will show: " + v.map((x) => NOTIFY_BUTTON_CHOICES.find(([k]) => k === x)[1].replace(/ \(.*$/, "")).join(" · ") : "Notifications will show no buttons"); openSettings(); }); };
  $("#notifyPreview").onchange = () => setPref("notifyPreview", $("#notifyPreview").value).then(() => toast("Notifications will show: " + $("#notifyPreview").selectedOptions[0].textContent.toLowerCase()));
  $("#gk").onchange = () => setPref("gatekeeper", $("#gk").checked ? "top" : "off").then(render);
  $("#grp").onchange = () => setPref("groupSenders", $("#grp").checked).then(render);
  $("#chrome").onchange = () => setPref("openInChrome", $("#chrome").checked).then(() => toast($("#chrome").checked ? "Links open in Chrome" : "Links open in the in-app tab"));
  $$("[data-sig]").forEach((ta) => ta.onchange = () => setPref("signatures", { ...prefs().signatures, [ta.dataset.sig]: ta.value }));
  $("#showdupes").onchange = () => api("/api/prefs", { method: "PUT", body: JSON.stringify({ showDupes: $("#showdupes").checked }) }).then(() => { state.prefs.showDupes = $("#showdupes").checked; render(); });
  $$("[data-qdel]").forEach((b) => b.onclick = async () => { try { await api("/api/quiet-rules/" + b.dataset.qdel, { method: "DELETE" }); state.quiet = (state.quiet || []).filter((r) => r.id !== b.dataset.qdel); openSettings(); } catch (e) { toast(e.message); } });
  if ($("#qadd")) $("#qadd").onclick = async () => { try { await addQuiet($("#qsender").value, $("#qsubject").value); openSettings(); } catch (e) { toast(e.message); } };
  $$("[data-mdel]").forEach((b) => b.onclick = async () => { try { await api("/api/mention-rules/" + b.dataset.mdel, { method: "DELETE" }); state.mention.rules = state.mention.rules.filter((r) => r.id !== b.dataset.mdel); openSettings(); } catch (e) { toast(e.message); } });
  if ($("#madd")) $("#madd").onclick = async () => {
    const pattern = $("#mpat").value.trim(), words = $("#mwords").value.split(",").map((w) => w.trim()).filter(Boolean), scope = $("#mscope").value;
    if (!pattern || !words.length) return toast("Give a sender and at least one word");
    if (!(await ask(`Delete new mail from ${pattern}${scope === "*" ? "" : " in " + scope} unless it mentions ${words.map((w) => `“${w}”`).join(" or ")}?`, { ok: "Add rule", danger: true }))) return;
    try { const r = await api("/api/mention-rules", { method: "POST", body: JSON.stringify({ pattern, words, scope }) }); state.mention.rules = [r.rule, ...state.mention.rules.filter((x) => x.id !== r.rule.id)]; openSettings(); } catch (e) { toast(e.message); }
  };
  wireUnsubSection();
  $$("[data-trkveto]").forEach((b) => b.onclick = async () => {
    try { const r = await api("/api/trackers/veto", { method: "POST", body: JSON.stringify({ pattern: b.dataset.trkveto }) }); toast(`${b.dataset.trkveto} is allowed${r.withdrawn ? `; ${r.withdrawn} picture${r.withdrawn === 1 ? "" : "s"} will show again` : ""}.`, 5000); await syncTrackers({ force: true }); openSettings(); }
    catch (e) { toast(e.message, 6000); }
  });
  $$("[data-trkunveto]").forEach((b) => b.onclick = async () => { try { await api("/api/trackers/veto?pattern=" + encodeURIComponent(b.dataset.trkunveto), { method: "DELETE" }); openSettings(); } catch (e) { toast(e.message, 6000); } });
  if ($("#tradd")) $("#tradd").onclick = async () => {
    const name = $("#trname").value.trim(), subject = $("#trsubject").value.trim(), scope = $("#trscope").value;
    if (!name && !subject) return toast("Give words of the sender's name, the subject, or both");
    if (await saveTrashRule({ name, subject, scope })) openSettings();
  };
  $$("[data-trdel]").forEach((b) => b.onclick = async () => { try { await api("/api/trash-rules/" + b.dataset.trdel, { method: "DELETE" }); state.trashRules = (state.trashRules || []).filter((r) => r.id !== b.dataset.trdel); openSettings(); } catch (e) { toast(e.message); } });
  $$("[data-rdel]").forEach((b) => b.onclick = async () => { await api("/api/sender-rules/" + b.dataset.rdel, { method: "DELETE" }); state.rules = state.rules.filter((r) => r.id !== b.dataset.rdel); openSettings(); });
  $$("[data-lkst]").forEach((b) => b.onclick = async () => {
    const st = b.dataset.lkst, a = b.dataset.lk;
    if (st === "released" && !(await ask(`Release ${a}? Mail from anyone will reach the inbox again, as at any other address.`, { ok: "Release" }))) return;
    if (st === "closed" && !(await ask(`Close ${a}? Everything sent to it, from anyone, will be kept out of the inbox in Held.`, { ok: "Close" }))) return;
    try { await api("/api/locks/" + encodeURIComponent(a), { method: "PATCH", body: JSON.stringify({ state: st }) }); openSettings(); } catch (e) { toast(e.message, 6000); }
  });
  $$("[data-lkadel]").forEach((b) => b.onclick = async () => {
    try { await api(`/api/locks/${encodeURIComponent(b.dataset.lkadel)}/allow/${encodeURIComponent(b.dataset.lkadom)}`, { method: "DELETE" }); toast(`${b.dataset.lkadom} is kept out of ${b.dataset.lkadel} again.`); openSettings(); } catch (e) { toast(e.message, 6000); }
  });
  if ($("#lkadd")) $("#lkadd").onclick = async () => {
    const local = $("#lkloc").value.trim().toLowerCase(), dom = $("#lkdom").value; if (!local) return $("#lkloc").focus();
    try { const r = await api("/api/locks", { method: "POST", body: JSON.stringify({ address: `${local}@${dom}` }) }); toast(`${r.address} is locked. The first company to write to it claims it.`, 6000); openSettings(); } catch (e) { toast(e.message, 6000); }
  };
  $("#radd").onclick = async () => { try { const r = await api("/api/sender-rules", { method: "POST", body: JSON.stringify({ pattern: $("#rpat").value, action: $("#ract").value, scope: $("#rscope").value }) }); state.rules.push(r.rule); openSettings(); } catch (e) { toast(e.message); } };
  if ($("#penable")) $("#penable").onclick = () => togglePush(sub).then(openSettings).catch((e) => toast(e.message));
  if ($("#ptest")) $("#ptest").onclick = () => api("/api/push/test", { method: "POST" }).then((r) => toast(`Sent to ${r.sent} device(s)${r.failed ? ", " + r.failed + " failed" : ""}`)).catch((e) => toast(e.message));
}
$("#settingsBtn").onclick = () => openSettings(); $("#accountsBtn").onclick = () => openSettings("accounts");
// The hub deletes a subscription row the moment a push service answers 404/410, and a browser can hand this device a replacement
// subscription without the page ever knowing. Either way the device keeps a live subscription the hub has no record of, the Settings
// screen still says "enabled" because it only ever asked the browser, and no push arrives again. Re-registering what the device
// actually holds is one idempotent upsert (ON CONFLICT(endpoint) DO UPDATE), so doing it on every boot makes both cases self-healing.
async function syncPushSubscription() {
  try {
    // `serviceWorker.ready` never settles when no worker ever activates (registration refused, a locked-down browser), and Settings
    // awaits this before it renders, so it races a timeout rather than hanging the screen on a device that has no push anyway.
    // Gated here, not just around subscribe(): re-POSTing a subscription the device still holds is ALSO a re-registration, and
    // would silently undo an opt-out whose unsubscribe() had failed.
    if (pushOptOut()) return null;
    // Inside the native Mac and Windows apps there is no Web Push (WKWebView, WebView2): the app reads the hub's notification feed
    // itself and shows native notifications, so this page must not register a subscription of its own.
    if (NATIVE_MAC || NATIVE_ANDROID || NATIVE_WINDOWS) return null;
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
    let sub = reg && await reg.pushManager.getSubscription();
    // A 410 does not leave a subscription behind (it DESTROYS it) so a pruned device wakes up with getSubscription() === null and
    // there is nothing to "re-register". Giving up here is what kept my phone silent from 2026-09-13 until a manual tap
    // on 09-17. Permission is the only thing gating a fresh subscribe, and subscribe() needs no user gesture once
    // it is already "granted", so a device that said yes once now repairs itself on the next boot, with nobody touching it.
    // pushOptOut() is what keeps that from overriding a deliberate "Disable here": unsubscribing cannot revoke the permission, so
    // without it every boot would cheerfully re-subscribe someone who had just turned notifications off.
    if (!sub && reg && typeof Notification !== "undefined" && Notification.permission === "granted" && state.push?.public_key) {
      try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.decBytes(state.push.public_key) }); } catch (_) { return null; }
    }
    if (!sub) return null;
    noteEndpoint(sub);
    const r = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), ua: navigator.userAgent, caps: PUSH_CAPS }) });
    try { localStorage.setItem("mh_push_id", r.id); } catch (_) {}
    return r.id;
  } catch (_) { return null; } // offline or signed out: the next boot tries again
}
const myPushId = () => { try { return localStorage.getItem("mh_push_id"); } catch (_) { return null; } };
// An unexpired watch and a registered device say push is CONFIGURED. They do not say it is DELIVERING: Pub/Sub or the push
// service can fail silently while every one of those checks still passes, and then both sides trust it: this client backs its poll
// off to ten minutes and the Worker cron skips nine minutes in ten.
// So trust is EARNED and can be lost. The watchdog is evidence-based rather than a timeout: if a poll discovers mail that push
// should have delivered and did not, push is demonstrably not working, and the backoff is withdrawn until it proves itself again.
let pushDistrustUntil = 0;
const PUSH_DISTRUST_MS = 30 * 60_000;
function notePushDelivered() { state.lastPushAt = Date.now(); pushDistrustUntil = 0; }   // it delivered: trust is restored at once
function notePushMissed(why) {
  pushDistrustUntil = Date.now() + PUSH_DISTRUST_MS;
  try { perf.record("push:missed", 0); } catch (_) {}
  console.warn("push did not deliver (" + why + "); polling at full rate for 30 min");
}
function pushLive() {
  try {
    if (Date.now() < pushDistrustUntil) return false;          // it missed something recently; do not trust it yet
    if (!state.push?.configured || !myPushId()) return false;
    if (pushOptOut()) return false;                            // notifications switched off here: nothing will be delivered
    const gs = (state.gmail || []).filter((g) => g.status === "active");
    if (!gs.length) return false;
    return gs.every((g) => g.watch_expiration && Date.parse(g.watch_expiration) > Date.now());
  } catch (_) { return false; }
}
// Set when this device turns notifications OFF by hand. The browser keeps Notification.permission === "granted" after an
// unsubscribe, so this flag is the only record that the silence was asked for rather than a fault to be repaired.
const pushOptOut = () => { try { return localStorage.getItem("mh_push_off") === "1"; } catch (_) { return false; } };
// Mirrored into IndexedDB because the SERVICE WORKER cannot read localStorage, and its pushsubscriptionchange handler is a
// re-subscription path too;
async function setPushOptOut(on) {
  try { if (on) localStorage.setItem("mh_push_off", "1"); else localStorage.removeItem("mh_push_off"); } catch (_) {}
  try { await idb.meta("push_off", on ? 1 : 0); } catch (_) {}
}
async function togglePush(existing) {
  const reg = await navigator.serviceWorker.ready;
  if (existing) {
    // The flag is written BEFORE the two fallible calls. If either throws, the user asked for silence and gets it; the old order
    // set the flag only after unsubscribe() resolved, so a failed unsubscribe left a live subscription with no opt-out recorded
    // and the next boot re-registered it.
    await setPushOptOut(true);
    try { localStorage.removeItem("mh_push_id"); } catch (_) {}
    await api("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: existing.endpoint }) });
    await existing.unsubscribe();
    toast("Notifications off on this device"); return; }
  if (!state.push.public_key) throw new Error("Push is not configured on the Worker");
  const perm = await Notification.requestPermission(); if (perm !== "granted") throw new Error("Notification permission was not granted");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.decBytes(state.push.public_key) });
  const r = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), ua: navigator.userAgent, caps: PUSH_CAPS }) });
  try { localStorage.setItem("mh_push_id", r.id); } catch (_) {}
  await setPushOptOut(false);
  toast("Notifications enabled on this device");
}

// ---------- keyboard ----------
// ---------- find: Cmd/Ctrl+F, the way Chrome's bar works over Gmail  ----------
// Two scopes, by what is on screen. A conversation open (and, on a phone, showing) is searched: the headers, plain-text mails and
// each message frame's document, in reading order; a collapsed message's body, not mounted, is counted in its stored document's text
// and expanded when the walk reaches it. Otherwise the list: every conversation of the view by sender, subject and snippet, drawn or
// not (Gmail's page stops at its 50 rows); a match past the drawn rows draws up to it. Matches are painted by the engine's own CSS
// Custom Highlight API, so nothing in a mail's markup changes. A frame's ranges go to the FRAME window's registry: WebKit stops
// painting a frame's highlight that is also registered on the page (measured in October 2026, scratchpad find/hl3.py). One text node per
// match, as the browsers' own find: a word split across two elements is not found.
const find = { on: false, scope: "list", q: "", hits: [], i: -1, wins: new Set(), timer: null, mo: null };
const FIND_SKIP = "script,style,noscript,template,title,.findbar,.badge,.lbl,.quick,.swipe,.av,.chk,.hav";
function findScope() { return state.cur && (!matchMedia(PHONE_MQ).matches || $("#app").classList.contains("viewing")) ? "conv" : "list"; }
// visible, as the browsers' find counts it: laid out, and not in a part the row or the page uses for something else than its words
const findVisible = (el, memo) => { if (!el || el.nodeType !== 1) return false; let v = memo.get(el); if (v === undefined) { v = !el.closest(FIND_SKIP) && !!el.getClientRects().length; memo.set(el, v); } return v; };
function findInText(n, q, out, fr = null) { const s = n.nodeValue; if (!s || s.length < q.length) return; const ls = s.toLowerCase(); let i = ls.indexOf(q); const d = n.ownerDocument;
  while (i >= 0) { const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + q.length); out.push({ r, d, fr }); i = ls.indexOf(q, i + q.length); } }
function findInNode(root, q, out, memo, fr = null) { const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (findVisible(n.parentElement, memo)) findInText(n, q, out, fr); }
const countIn = (text, q) => { let n = 0, i = -1; const t = String(text || "").toLowerCase(); while ((i = t.indexOf(q, i + 1)) >= 0) { n++; i += q.length - 1; } return n; };
function findPaint(hits) {
  for (const w of find.wins) { try { w.CSS.highlights.delete("mhfind"); w.CSS.highlights.delete("mhcur"); } catch (_) {} } find.wins.clear();
  const byDoc = new Map(); for (const h of hits) if (h.r) { if (!byDoc.has(h.d)) byDoc.set(h.d, []); byDoc.get(h.d).push(h.r); }
  for (const [d, rs] of byDoc) { const w = d.defaultView; try { w.CSS.highlights.set("mhfind", new w.Highlight(...rs)); find.wins.add(w); } catch (_) {} }
}
// keep: the card or row key the current match must stay in after a rescan (a message just expanded, rows just drawn); hold: keep the index
function findScan({ keep = null, hold = false } = {}) {
  if (!find.on) return;
  const q = find.q = $("#findq").value.trim().toLowerCase(); const hits = [], memo = new Map();
  if (q && find.scope === "conv") {
    const docs = prerendered.get(state.cur)?.docs || []; const w = document.createTreeWalker($("#msgs"), NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) { if (findVisible(n.parentElement, memo)) findInText(n, q, hits); continue; }
      if (n.matches("iframe[data-doc]")) { const d = n.contentDocument; if (!d || !d.body) continue;
        if (findVisible(n, memo)) findInNode(d.body, q, hits, new Map(), n); else { const card = n.closest(".m.collapsed"), k = card ? countIn(d.body.textContent, q) : 0; if (k) hits.push({ card, n: k }); } continue; }
      if (n.matches(".lazyb[data-doc]")) { const card = n.closest(".m.collapsed"); if (!card) continue;   // no frame yet: its stored document's words
        const text = n._text ?? (n._text = new DOMParser().parseFromString(docs[+n.dataset.doc] || "", "text/html").body.textContent.replace(/\s+/g, " ")); const k = countIn(text, q); if (k) hits.push({ card, n: k }); }
    }
  } else if (q) {
    const drawn = new Map($$("#threads .t[data-key]").map((el) => [el.dataset.key, el]));
    for (const t of render.mainAll || visibleThreads()) { const el = drawn.get(t.key);
      if (el) findInNode(el, q, hits, memo); else { const k = countIn([rowPeer(t).label, shownSubject(t), (state.search && t._hit && t._hit.snip) || t.snippet].join("\n"), q); if (k) hits.push({ key: t.key, n: k }); } }
  }
  find.hits = hits; findPaint(hits);
  const inKeep = (h) => keep && h.r && (typeof keep === "string" ? h.r.startContainer.parentElement.closest(".t")?.dataset.key === keep : keep.contains(h.fr || h.r.startContainer));
  const j = keep ? hits.findIndex(inKeep) : -1;
  find.i = !hits.length ? -1 : j >= 0 ? j : hold ? Math.min(Math.max(find.i, 0), hits.length - 1) : 0;
  findShow(keep ? 1 : 0);
}
function findShow(depth = 0) {
  const h = find.hits[find.i], n = find.hits.reduce((a, x) => a + (x.n || 1), 0), at = find.hits.slice(0, find.i).reduce((a, x) => a + (x.n || 1), 0) + 1;   // a collapsed message's matches count, as Chrome's bar would
  $("#findn").textContent = find.q ? `${h ? at : 0}/${n}` : ""; $("#findn").classList.toggle("none", !!find.q && !n);
  for (const w of find.wins) { try { w.CSS.highlights.delete("mhcur"); } catch (_) {} }
  if (!h) return;
  if (h.key) { if (depth) return; const i = (render.mainAll || []).findIndex((t) => t.key === h.key); let guard = 0; while (render.mainCursor <= i && guard++ < 1000) appendRows(); return findScan({ keep: h.key }); }   // a row not drawn yet: draw up to it, look again
  if (h.card) { if (depth) return; h.card.classList.remove("collapsed"); mountBodies(h.card, prerendered.get(state.cur)?.docs || []); return requestAnimationFrame(() => findScan({ keep: h.card })); }   // a collapsed message: open it, look again
  const w = h.d.defaultView; try { w.CSS.highlights.set("mhcur", new w.Highlight(h.r)); find.wins.add(w); } catch (_) {}
  if (find.scope === "list") { h.r.startContainer.parentElement.closest(".t")?.scrollIntoView({ block: "center" }); return; }
  const ms = $("#msgs"), mr = ms.getBoundingClientRect(); let rc = h.r.getBoundingClientRect();
  if (h.fr) { const de = h.d.documentElement; if (rc.left < 0 || rc.right > de.clientWidth) { de.scrollLeft += rc.left - 20; rc = h.r.getBoundingClientRect(); }   // sideways inside a zoomed mail
    const fb = h.fr.getBoundingClientRect(); rc = { top: fb.top + rc.top, bottom: fb.top + rc.bottom }; }
  if (rc.top < mr.top + 8 || rc.bottom > mr.bottom - 8) ms.scrollTop += rc.top - mr.top - mr.height / 2;
}
function findStep(dir) { const n = find.hits.length; if (!find.on || !n) return; find.i = ((find.i < 0 ? (dir > 0 ? -1 : 0) : find.i) + dir + n) % n; findShow(); }
function openFind() {
  const scope = findScope(), inp = $("#findq");
  if (!find.on) { find.on = true; $("#findbar").hidden = false; find.i = -1; pushLayer("find", hideFind);
    // the conversation or the list redrawn under the bar (a message opened, mail arriving): the same words, found again
    find.mo = new MutationObserver(() => { clearTimeout(find.timer); find.timer = setTimeout(() => findScan({ hold: true }), 120); });
    find.mo.observe($("#msgs"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] }); find.mo.observe($("#threads"), { childList: true, subtree: true }); }
  if (scope !== find.scope) { find.scope = scope; find.i = -1; }
  inp.placeholder = scope === "conv" ? "Find in this conversation" : "Find in the list"; inp.focus(); inp.select();
  if (inp.value.trim()) findScan();
}
function hideFind() { if (!find.on) return; find.on = false; $("#findbar").hidden = true; findPaint([]); find.hits = []; find.i = -1; find.mo?.disconnect(); find.mo = null; clearTimeout(find.timer); $("#findn").textContent = ""; $("#findn").classList.remove("none"); if (document.activeElement === $("#findq")) $("#findq").blur(); }
function closeFind() { if (!dropLayer("find")) hideFind(); }
function onFindKey(e) { if (!(e.metaKey || e.ctrlKey) || e.altKey) return; const k = e.key.toLowerCase(); if (k === "f" && !e.shiftKey) { e.preventDefault(); openFind(); } else if (k === "g" && find.on) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } }
$("#findq").oninput = () => { clearTimeout(find.timer); find.timer = setTimeout(() => findScan(), 60); };
$("#findq").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); } };
$("#findnext").onclick = () => findStep(1); $("#findprev").onclick = () => findStep(-1); $("#findclose").onclick = () => closeFind();

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === keyFor("palette")) { e.preventDefault(); return openPalette(); }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "a" && !e.target.matches("input,textarea,select") && !$$(".modal.on").length) { e.preventDefault(); return selectAll(); }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && !$$(".modal.on").length) { e.preventDefault(); return openFind(); }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "g" && find.on) { e.preventDefault(); return findStep(e.shiftKey ? -1 : 1); }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Tab" && e.target.matches("textarea") && expandSnippetShortcut(e.target)) { e.preventDefault(); return; }
  const typing = e.target.matches("input,textarea,select"); const modal = $$(".modal.on").length;
  // An open card goes first, wherever the focus is: once a click left the palette's box, Escape closed the conversation under it
  if (e.key === "Escape" && cancelCard()) { e.preventDefault(); return; }
  if (e.key === "Escape" && e.target === $("#q")) { e.preventDefault(); if ($("#q").value || state.search) clearSearch(); else $("#q").blur(); return; }
  if (e.key === "Escape") { // unwinds through the same stack, so a keyboard close leaves no stranded history entry
    const top = layers[layers.length - 1];
    if (top) { dropLayer(top.name); return; }
    if (modal) { $$(".modal.on").forEach((m) => m.classList.remove("on")); return; }
    $("#app").classList.remove("viewing", "menu"); return; }
  if (typing || modal) return;
  const rows = visibleThreads(); const tk = (state.focus && state.threads.has(state.focus)) ? state.focus : state.cur; const i = rows.findIndex((t) => t.key === tk); const t = state.threads.get(tk);
  const flow = (action) => { if (t) actFlow(t, action); };
  // Its row stays in view: walking past the bottom of the list used to open conversations whose rows were scrolled off screen.
  const reveal = () => $(`.t[data-key="${cssEsc(state.cur)}"]`)?.scrollIntoView({ block: "nearest" });
  const actions = { next: () => { if (rows[i + 1]) { openThread(rows[i + 1].key); reveal(); scheduleIdle(() => prefetchBodies([rows[i + 2]])); } }, prev: () => { if (rows[i - 1]) { openThread(rows[i - 1].key); reveal(); scheduleIdle(() => prefetchBodies([rows[i - 2]])); } }, archive: () => flow("done"), trash: () => flow("trash"), star: () => t && act(t, "star"), unread: () => t && act(t, "unread"), readnext: () => flow("read"), selectall: () => selectAll(), fromhere: () => selectFromHere(tk), snooze: () => t && act(t, "snooze"), reply: () => { if (t) openReplySheet({ all: false }); }, replyall: () => { if (t) openReplySheet({ all: true }); }, forward: () => t && openCompose({ forward: true }), compose: () => openCompose(), search: () => $("#q").focus(), select: () => t && toggleCheck(t.key), open: () => rows[i + (i < 0 ? 1 : 0)] && openThread(rows[Math.max(i, 0)].key), mute: () => t && act(t, "mute"), unsubscribe: () => t && act(t, "unsubscribe"), replylater: () => t && act(t, "replylater"), aside: () => t && act(t, "aside"), palette: () => openPalette() };
  // ↓ / ↑ walk the list the way Apple Mail's does: the next or previous conversation opens in the reading pane ,
  // exactly as j / k. Typing fields, menus and dialogs never get here, and a message the reader clicked into keeps its own arrows for
  // scrolling: its frame receives those keys, not this page.
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); (e.key === "ArrowDown" ? actions.next : actions.prev)(); return; }
  for (const [name, fn] of Object.entries(actions)) { const k = keyFor(name); if (k && e.key === k) { e.preventDefault(); fn(); return; } }
});

// Wipe everything this device holds: IndexedDB (rows, bodies, queue), the localStorage first-paint snapshot, the search index in OPFS.
// Signing out also takes this device off the hub's notification lists: the Android app is named by its push id and a
// browser by its Web Push endpoint, and "everywhere" clears every device. The native apps have no Web Push and skip that lookup, whose
// serviceWorker.ready may never settle there and would hold the sign-out for 3 s. The Android app then drops its own copy of the session, the conversations it
// downloaded and the notifications it shows (1.9 on; an older app answers "unknown op").
async function signOut(everywhere) {
  const body = { everywhere };
  if (!everywhere) {
    body.device = await nativeDevice();
    if (!body.device && !(NATIVE_MAC || NATIVE_ANDROID || NATIVE_WINDOWS)) body.endpoint = pushEndpoint || await (async () => { try {
      const reg = await Promise.race([navigator.serviceWorker?.ready, sleep(3000)]);
      return (await reg?.pushManager?.getSubscription())?.endpoint || null;
    } catch (_) { return null; } })();
  }
  await fetch("/logout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (nativeBridge) await nativeBridge.call("signedOut").catch(() => {});
  await wipeDevice(); location.reload();
}
async function wipeDevice() { try { await idb.wipe(); } catch (_) {} try { localStorage.removeItem("mh:snapshot"); } catch (_) {} try { await searchIndex.call("clear"); } catch (_) {} try { for (const k of await caches.keys()) await caches.delete(k); } catch (_) {} }
// ---------- sidebar: locked (a column) or unlocked (slides in from the left edge / the menu button), Spark's lock idea ----------
// One way to close the side menu. It was pushed as a back-stack layer but dismissed from seven other places by setting the class
// directly, so the layer stayed on the stack and its history entry outlived it: the user then had to press back twice, the first
// press appearing to do nothing.
function closeMenu() { if (!dropLayer("menu")) $("#app").classList.remove("menu"); }   // by its layer even when the class is already gone, so no entry is stranded
function toggleMenu(on) { const app = $("#app"); const want = on === undefined ? !app.classList.contains("menu") : on;
  if (want) pushLayer("menu", () => app.classList.remove("menu"));
  else if (app.classList.contains("menu") && dropLayer("menu")) return;   // dropLayer runs the closer and consumes the history entry
  app.classList.toggle("menu", want); if (want) setTimeout(() => document.addEventListener("click", (e) => { if (!$("#side").contains(e.target)) closeMenu(); }, { once: true, capture: true }), 0); }
function applySide(mode) { $("#app").dataset.side = mode; closeMenu();   /* through its layer: the lock sits in the open drawer */ const b = $("#sidelock"); b.innerHTML = ico(mode === "locked" ? "lock" : "unlock"); b.title = mode === "locked" ? "Unlock the sidebar (it slides in from the left edge)" : "Lock the sidebar open"; try { localStorage.setItem("mh:side", mode); } catch (_) {} }
$("#sidelock").onclick = () => applySide($("#app").dataset.side === "locked" ? "unlocked" : "locked");
let edgeHover = false; $("#edge").addEventListener("mouseenter", () => { edgeHover = true; $("#app").classList.add("menu"); }); $("#side").addEventListener("mouseleave", () => { if (edgeHover) { edgeHover = false; $("#app").classList.remove("menu"); } });
try { applySide(localStorage.getItem("mh:side") === "unlocked" ? "unlocked" : "locked"); } catch (_) { applySide("locked"); }
// ---------- command palette (Cmd+K), snippets, splits ----------
function paletteCommands() {
  const t = state.threads.get(state.cur); const v = state.view; const cmds = [];
  const add = (label, run, key = null, group = "", quiet = false) => cmds.push({ label, run, key, group, quiet });   // quiet: listed only once something is typed
  for (const [k, l] of [["inbox", "Inbox"], ["unread", "Unread"], ["spam", "Spam"], ["personal", "Personal"], ["notifications", "Notifications"], ["newsletters", "Newsletters"], ["starred", "Pins"], ["aside", "Set aside"], ["replylater", "Reply later"], ["feed", "Feed"], ["snoozed", "Snoozed"], ["sent", "Sent"], ["drafts", "Drafts"], ["archived", "Archive"], ["held", "Held"], ["trash", "Trash"], ["all", "All mail"], ["scheduled", "Scheduled"]]) add("Go to " + l, () => setView(k), null, "Navigate");
  for (const a of sideAccounts()) add("Go to " + a.label + " inbox", () => setView("inbox", a.id), null, "Navigate");
  // every folder for each account: dozens of rows, so they wait for a query instead of pushing the conversation's commands off the list
  for (const k of SPLIT_FOLDERS) { const subs = folderAccounts(k); if (subs.length > 1) for (const a of subs) add(`Go to ${a.label} ${VIEW_TITLES[k]}`, () => setView(k, a.id), null, "Navigate", true); }
  for (const sp of prefs().splits) add("Split: " + sp.name, () => runSplit(sp), null, "Splits");
  if (t?.fromAddr) add("Don't notify me about mail like this", () => quietFor(t), null, "Conversation");
  if (t && !t.out) add("Trash mail like this", () => trashRuleFor(t), null, "Conversation");
  if (t && !t.out && t.fromAddr) add("Delete unless it mentions…", () => mentionRuleFor(t), null, "Conversation");
  add("Unsubscribes: what each list answered", () => openSettings("unsubscribes"), null, "Settings");
  add(findScope() === "conv" ? "Find in this conversation" : "Find in the list", () => openFind(), "⌘F", "Find");
  add("New message", () => openCompose(), keyFor("compose"), "Compose"); add("Select all shown", () => selectAll(), "⌘A", "Select"); add("Select all from here", () => selectFromHere(), keyFor("fromhere"), "Select"); if (state.checked.size) { add(`Done ${state.checked.size} selected`, () => $('#selbar [data-bulk="archive"]').click(), null, "Select"); add(`Trash ${state.checked.size} selected`, () => $('#selbar [data-bulk="trash"]').click(), null, "Select"); } add("Focus & Reply (walk the Reply later list)", () => focusReply(0), null, "Compose"); add("Search", () => $("#q").focus(), keyFor("search"), "Navigate"); add("Refresh", () => refresh(), null, "Navigate"); add("Settings", () => openSettings(), null, "Navigate");
  if (state.search) add("Save this search as a split", () => saveSplit(state.search), null, "Splits");
  if (t) {
    for (const [k, l] of [["archive", "Done"], ["trash", "Trash"], ["snooze", "Snooze"], ["remind", "Remind me"], ["star", t.starred ? "Unpin" : "Pin"], ["unread", "Mark unread"], ["read", "Mark read"], ["mute", prefs().muted.includes(t.key) ? "Unmute" : "Mute"], ["replylater", prefs().replyLater.includes(t.key) ? "Remove from Reply later" : "Reply later"], ["aside", prefs().setAside.includes(t.key) ? "Remove from Set aside" : "Set aside"], ["block", "Block sender"], ["priority", "Priority sender"], ["prithread", "Priority thread"], ["rename", "Rename subject"], ["cat:personal", "Category: Personal"], ["cat:notifications", "Category: Notifications"], ["cat:newsletters", "Category: Newsletters"], ...(t.unsub ? [["unsubscribe", "Unsubscribe"]] : []), ...(t.kind === "gmail" ? [["spam", "Report spam"]] : t.out ? [] : [["spam", "Spam: trash it and block the sender"]])]) add(l, () => act(t, k), keyFor(k), "This conversation");
    add("Reply", () => openReplySheet({ all: false }), keyFor("reply"), "This conversation"); add("Reply all", () => openReplySheet({ all: true }), keyFor("replyall"), "This conversation"); add("Forward", () => openCompose({ forward: true }), keyFor("forward"), "This conversation");
  }
  const ta = document.activeElement?.matches("textarea") ? document.activeElement : ($("#cmodal").classList.contains("on") ? $("#ctext") : ($("#replybox").style.display !== "none" ? $("#rtext") : null));
  if (ta) for (const sn of prefs().snippets) add("Snippet: " + sn.name, () => insertSnippet(ta, sn), null, "Snippets");
  add("Toggle group by sender", () => setPref("groupSenders", !prefs().groupSenders).then(render), null, "Inbox"); add("Notify: all", () => setPref("notify", "all"), null, "Notifications"); add("Notify: smart", () => setPref("notify", "smart"), null, "Notifications"); add("Notify: priority only", () => setPref("notify", "priority"), null, "Notifications"); add("Notify: none", () => setPref("notify", "none"), null, "Notifications");
  return cmds;
}
const fuzzy = (q, s) => { q = q.toLowerCase(); s = s.toLowerCase(); if (!q) return 1; let i = 0, score = 0, last = -1; for (const c of q) { const j = s.indexOf(c, i); if (j < 0) return 0; score += (j === last + 1 ? 3 : 1) + (j === 0 || /\W/.test(s[j - 1] || " ") ? 2 : 0); last = j; i = j + 1; } return score / (1 + s.length / 40); };
function openPalette() {
  ensureSearch();   // ⌘K is the other way people reach search
  const cmds = paletteCommands(), first = cmds.filter((c) => !c.quiet); const m = $("#tcard"); let sel = 0, list = first, q = ""; const onCancel = () => releaseModal(onCancel); claimModal(onCancel);
  m.innerHTML = `<input class="f" id="pq" placeholder="Type a command…" autocomplete="off" style="width:100%"><div id="plist" style="max-height:60vh;overflow:auto;margin-top:6px"></div>`;
  const inp = $("#pq"), pl = $("#plist");
  const run = (i) => { const c = list[i]; if (!c) return; releaseModal(onCancel); perf.measure("palette-run", () => { c.run(); }); };
  const drawList = () => { pl.innerHTML = list.slice(0, 40).map((c, i) => `<div data-i="${i}" class="row" style="padding:6px 8px;border-radius:6px;background:${i === sel ? "var(--sel)" : "transparent"};cursor:pointer"><span style="color:var(--mut);font-size:11px;width:110px;flex:none">${esc(c.group)}</span><b style="font-weight:500">${esc(c.label)}</b><span style="flex:1"></span>${c.key ? `<span class="badge">${esc(c.key)}</span>` : ""}</div>`).join(""); $$("#plist [data-i]").forEach((d) => d.onclick = () => run(+d.dataset.i)); pl.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); };
  inp.oninput = () => { q = inp.value; list = q ? cmds.map((c) => ({ c, s: fuzzy(q, c.group + " " + c.label) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c) : first; sel = 0; drawList(); };
  inp.onkeydown = (e) => { if (e.key === "ArrowDown") { sel = Math.min(sel + 1, Math.min(list.length, 40) - 1); e.preventDefault(); drawList(); } else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); e.preventDefault(); drawList(); } else if (e.key === "Enter") { e.preventDefault(); run(sel); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); releaseModal(onCancel); } };
  perf.measure("palette-open", () => { drawList(); $("#tmodal").classList.add("on"); inp.focus(); });
}
// A click on the dim backdrop around a card closes it (the Cmd+K card could not be escaped or
// clicked away). Only a press that starts on the backdrop counts, so a text selection dragged out of the card leaves it open.
{ const tm = $("#tmodal"); let downOn = null;
  tm.addEventListener("pointerdown", (e) => { downOn = e.target; });
  tm.addEventListener("click", (e) => { if (e.target === tm && downOn === tm) cancelCard(); downOn = null; }); }
async function fillVars(text, t) { const m = state.replyTo; const counterpart = t ? (t.out ? (t.to || "").split(",")[0] : t.fromName || t.fromAddr) : ""; const first = (counterpart || "").trim().split(/\s+/)[0] || ""; const vars = { name: counterpart || "", first, email: t ? (t.out ? addrOf((t.to || "").split(",")[0]) : t.fromAddr) : "", date: new Date().toLocaleDateString(), subject: t ? shownSubject(t) : "", me: state.me.identities[0]?.display_name || "" }; const asks = []; text.replace(/\{\{\s*ask(?::([^}]*))?\s*\}\}/g, (m0, def) => { asks.push(def || "Value"); return m0; }); const answers = []; for (const label of asks) answers.push((await askText(label, "")) || ""); let ai = 0;
  return text.replace(/\{\{\s*(\w+)(?::([^}]*))?\s*\}\}/g, (m0, k, def) => (k === "ask" ? answers[ai++] : (vars[k] ?? (def !== undefined ? def : "")))); }
async function insertSnippet(ta, sn) { const t = state.threads.get(state.cur); const text = await fillVars(sn.text || "", t); const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s; ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); ta.focus(); ta.setSelectionRange(s + text.length, s + text.length); if (sn.subject && ta.id === "ctext" && !$("#csub").value) $("#csub").value = await fillVars(sn.subject, t); }
function expandSnippetShortcut(ta) { const upto = ta.value.slice(0, ta.selectionStart); const m = upto.match(/(?:^|\s);([\w-]+)$/); if (!m) return false; const sn = prefs().snippets.find((x) => x.name.toLowerCase() === m[1].toLowerCase()); if (!sn) return false; const start = upto.length - m[1].length - 1; ta.value = ta.value.slice(0, start) + ta.value.slice(upto.length); ta.setSelectionRange(start, start); insertSnippet(ta, sn); return true; }
function focusReply(start = 0) {
  const keys = (prefs().replyLater || []).filter((k) => state.threads.has(k)); if (!keys.length) { state.frw = null; focusBar(); return toast("Reply later is empty"); }
  if (start >= keys.length) { state.frw = null; focusBar(); setView("inbox"); return toast("Reply later cleared — nice."); }
  state.frw = { keys, i: start }; openThread(keys[start]).then(() => { focusBar(); requestAnimationFrame(() => openReplySheet()); });
}
function focusBar() {
  let bar = $("#focusbar"); if (!state.frw) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "focusbar"; bar.className = "row"; bar.style.cssText = "padding:6px 12px;border-bottom:1px solid var(--line);background:var(--card);font-size:12px;gap:8px"; $("#msgs").before(bar); }
  bar.innerHTML = `<b>Focus &amp; Reply</b> ${state.frw.i + 1} of ${state.frw.keys.length}<span style="flex:1"></span><button data-fr="skip">Skip</button><button data-fr="done" class="ghost">Remove &amp; next</button><button data-fr="stop" class="ghost">Stop</button>`;
  bar.querySelectorAll("[data-fr]").forEach((b) => b.onclick = async () => { const a = b.dataset.fr; if (a === "stop") { state.frw = null; focusBar(); return; } if (a === "done") { const k = state.frw.keys[state.frw.i]; await setPref("replyLater", prefs().replyLater.filter((x) => x !== k)); } focusReply(state.frw.i + 1); });
}
// Focus & Reply moves on at once; the conversation leaves Reply later only when the reply has actually gone (the send's `after`), so an
// Undo or a failed send no longer drops it from the list.
async function focusAdvanceAfterSend(key) { if (!state.frw || state.frw.keys[state.frw.i] !== key) return; focusReply(state.frw.i + 1); }
// Idempotent, and deliberately cheap to call from every path that could lead to a search.
function ensureSearch() {
  if (state.searchBooted) return; state.searchBooted = true;
  scheduleIdle(async () => {
    searchIndex.start();
    const rows = [...state.threads.values()]; if (rows.length) searchIndex.indexThreads(rows); searchIndex.lastIndexedAt = Date.now();
    // Deferring the engine created a permanent hole: cacheThread() calls indexBodies(), which returns immediately when there is
    // no worker, so every conversation opened before search was first touched had its body stored and never indexed. refresh()'s
    // catch-up only re-indexes thread METADATA, and the "Rebuild index" button only calls indexThreads, so `body:` queries would
    // have missed those conversations for ever, not merely for the session. Backfill from the body store on first start.
    await backfillBodyIndex();
  });
}
// `rebuild()` in search.js only calls indexThreads, so the "Rebuild index" button had the same hole as the deferred start: it
// restored metadata and left every cached BODY unindexed. Both paths come here now.
async function backfillBodyIndex() {
  try {
    const bodies = await idb.getAll("bodies");
    if (!bodies.length) return 0;
    const byThread = new Map();
    for (const r of bodies) { if (!r.m) continue; const a = byThread.get(r.threadKey) || []; a.push(r.m); byThread.set(r.threadKey, a); }
    let n = 0;
    for (const [key, msgs] of byThread) {
      const t = state.threads.get(key); if (!t) continue;
      searchIndex.indexBodies(t, msgs.sort((a, b) => (a.date || 0) - (b.date || 0)).map(tagSafeMsg)); n++;
      await new Promise((r) => scheduleIdle(r));         // one thread per idle slice: never block the tap that started search
    }
    return n;
  } catch (_) { return 0; }
}
function runSplit(sp) { ensureSearch(); $("#q").value = sp.query; state.search = sp.query; state.searchFrom = null; state.searchHits = null; state.view = { kind: "inbox", account: null, split: sp.name }; render(); syncSearchUi(); localSearch(sp.query); }
// Clearing a search, the way other mail apps do (a quick way to clear it): an X inside the box that shows
// only while it has text (Material's search bar; the clear button WebKit and Blink draw in a search field), Esc (in the box: clear, then
// leave the box: the convention browsers give type=search; elsewhere it unwinds the open conversation first, then the search), and on
// Android the back gesture: a search in progress is one step of the back stack, so back from results lands on the list, as in Gmail.
function syncSearchUi() {
  $("#qClear").hidden = !$("#q").value;
  const on = !!state.search, held = layers.some((l) => l.name === "search" && !l.spent);
  if (on && !held) pushLayer("search", clearSearch); else if (!on && held) dropLayer("search");
}
function clearSearch() {
  state.searchFrom = undefined;   // the next search decides its folder afresh (typedQuery)
  if (state.search || $("#q").value || state.view.split) { $("#q").value = ""; state.search = ""; state.searchHits = null; state.serverSearch = new Map(); state.serverHitKeys = new Set(); state.view.split = null; render(); }
  syncSearchUi();   // a close that came FROM the layer finds it gone already, so this never runs twice
}
$("#qClear").onpointerdown = (e) => e.preventDefault();   // the box keeps its focus (and the phone its keyboard) only if it had it
$("#qClear").onclick = () => clearSearch();
// The keyboard's search key on a phone (enterkeyhint="search") puts the keyboard away so the results are in view.
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && matchMedia("(hover: none)").matches) { e.preventDefault(); $("#q").blur(); } });
async function saveSplit(query) { const name = await askText("Name this split", query); if (!name) return; await setPref("splits", [...prefs().splits.filter((s) => s.name !== name), { name, query }]); renderNav(); toast("Split saved: " + name); }
// Reaching for search is the signal (focusing the box, or opening the palette) and it lands well before anyone finishes typing,
// so the engine is warm by the time a query exists. This is the whole reason deferring it costs the user nothing.
$("#q").addEventListener("focus", ensureSearch);
// The servers are asked once two characters are typed; of what was typed, not of the in: a search begun in Trash carries (typedQuery).
$("#q").oninput = (() => { let t; return () => { const typed = $("#q").value.trim(), q = typedQuery(typed); perf.measure("search-keystroke", () => { state.search = q; state.searchHits = null; serverSearch.pending = typed.length >= 2; if (!q) state.serverSearch = new Map(); state.serverHitKeys = null; render(); }); syncSearchUi(); localSearch(q); clearTimeout(t); if (typed.length >= 2) t = setTimeout(() => serverSearch(q), 700); }; })();
// The index gets the query's words, never its operators (it read in:trash as the words "in" and "trash"); the rows it names are then
// filtered by them (searchPasses), so a scoped search asks for more of the newest. With no word to match (in:trash alone, or -word
// alone) FTS5 has no match-all: the row scan lists them, every row a candidate (matchesSearch).
async function localSearch(q) {
  if (!q) return; ensureSearch(); const s = searchOf(q); if (!searchTerms(s.text).length) return;
  const t0 = performance.now(); const rows = await searchIndex.query(s.text, { order: "date", limit: s.ops ? 1000 : 200 });   // the newest matches fill the limit
  if (state.search !== q) return;
  if (rows) { state.searchHits = new Map(rows.map((r) => [r.key, r])); perf.record("search:fts", performance.now() - t0); render(); }
}
// Server search, one page per account per call: the hub pages by date (`before`), Gmail by its own pageToken. The first page is
// small for speed; "more" pages are larger. Threads already in the cache are never re-fetched (their keys are marked as hits).
const SEARCH_PAGE = { first: 40, more: 60 };
// The servers get the query in Gmail's spelling with its dates as epoch seconds (serverQuery), worked out once per query
// so a relative date (newer_than:2d) is the same instant on every page of it.
const serverQ = (q) => (serverQ.q === q ? serverQ.v : ((serverQ.q = q), (serverQ.v = serverQuery(q))));
const searchKey = (a, q) => (a.id === "hub" ? `hub|all|${serverQ(q)}` : `${a.id}|search|${q}`); // hub key = what hub.list/hub.more use
function searchAccounts() { return accountsAll().filter((a) => !a.imap).filter((a) => !state.view.account || a.id === (sideOf(state.view.account)?.imap ? "hub" : dataAccount(state.view.account))); }
const searchHasMore = (q) => searchAccounts().some((a) => !!state.pageTokens[searchKey(a, q)]);
async function serverSearch(q, { more = false } = {}) {
  if (state.search !== q || (more && serverSearch.busy)) return; serverSearch.pending = false; serverSearch.busy = true;
  const want = searchAccounts(); const found = more ? new Map(state.serverSearch) : new Map(); const hitKeys = more ? new Set(state.serverHitKeys) : new Set();
  try {
    await Promise.all(want.map(async (a) => { try {
      if (a.id === "hub") { if (more && !state.pageTokens[searchKey(a, q)]) return; for (const t of more ? await hub.more("all", serverQ(q)) : await hub.list("all", serverQ(q))) { hitKeys.add(t.key); found.set(t.key, t); } }
      else {
        const pt = state.pageTokens[searchKey(a, q)]; if (more && !pt) return;
        // messages.list (5 units) + one messages.get per uncached thread (20 units) instead of threads.get (40 units): the row only
        // needs the newest matching message; opening the row fetches the whole thread as usual. Gmail quota table, 2026-09-10.
        const l = await gapi(a.id, `messages?maxResults=${more ? SEARCH_PAGE.more : SEARCH_PAGE.first}&q=${encodeURIComponent(serverQ(q))}${more ? "&pageToken=" + encodeURIComponent(pt.token) : ""}`);
        state.pageTokens[searchKey(a, q)] = l.nextPageToken ? { token: l.nextPageToken } : null;
        const seen = new Set(); const heads = (l.messages || []).filter((m) => !seen.has(m.threadId) && seen.add(m.threadId)); // newest message per thread
        heads.forEach((m) => hitKeys.add(`${a.id}|${m.threadId}`)); const need = heads.filter((m) => !state.threads.has(`${a.id}|${m.threadId}`)); const ad = gmailAdapter(a.id);
        for (let i = 0; i < need.length; i += 8) { const ms = await Promise.all(need.slice(i, i + 8).map((m) => gapi(a.id, `messages/${m.id}?${SYNC.META}`).catch(() => null))); for (const m of ms) { if (!m) continue; const t = ad.norm({ id: m.threadId, messages: [m] }); t._server = true; found.set(t.key, t); } }
      }
    } catch (e) { toast(`${a.label} search: ${e.message}`); } }));
  } finally { serverSearch.busy = false; }
  if (state.search !== q) return; state.serverSearch = found; state.serverHitKeys = hitKeys; render();
}
async function searchMore(more) { if (serverSearch.busy || !more.isConnected) return; more.textContent = "Searching the servers…"; await serverSearch(state.search, { more: true }); }   // render() keeps the visible rows in place when hits land above them
$("#refreshBtn").onclick = () => { loadMore.empty = 0; refresh(); }; $("#paletteBtn").onclick = () => openPalette(); $("#threads").addEventListener("pointerleave", () => { if (state.cur) setFocus(state.cur); });
$("#threads").addEventListener("scroll", () => { lastListScroll = performance.now(); for (const p of pressTimers) clearTimeout(p); pressTimers.clear(); }, { passive: true });
// The list keeps its place when its WIDTH changes. Opening a conversation on the desktop narrows the list from the full width to 430 px,
// each row wraps from one line to three, and the same scrollTop then shows rows twenty places earlier: the email just clicked fell
// 1,800 px below the fold and the list looked thrown back to the top (Mac app: a row clicked and deleted far down
// sent the list back to the top; a real WKWebView showed rows 39-53 before the click and 23-32 after it). Closing it did the reverse.
// So one anchor row is remembered with where it sat (the row pressed, which is the one being opened, or else the top visible row as
// the list scrolls) and put back where it was after any width change. A list going to or from zero width (hidden behind a
// conversation on a phone) is left exactly as it was.
const listAnchor = { key: null, off: 0, w: 0, pressed: false };
const noteListAnchor = (row) => {
  const el = $("#threads"); if (!el.clientWidth) return;
  const a = row ? { key: row.dataset.key, off: row.getBoundingClientRect().top - el.getBoundingClientRect().top } : topVisibleRow(el);
  if (a) { listAnchor.key = a.key; listAnchor.off = a.off; listAnchor.pressed = !!row; }
};
{ let queued = false; $("#threads").addEventListener("scroll", () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; noteListAnchor(); }); }, { passive: true }); }
$("#threads").addEventListener("pointerdown", (e) => { const row = e.target.closest && e.target.closest("#threads .t[data-key]"); if (row) noteListAnchor(row); }, { capture: true, passive: true });
if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => {
  const el = $("#threads"); const w = el.clientWidth, was = listAnchor.w; listAnchor.w = w;
  if (w && w !== was) syncRowEstimate(el);
  if (!w || !was || w === was || !listAnchor.key) return;
  // At the top the top is the place, as in render(): mail that arrived there never scrolled the list, so the remembered row may no
  // longer be the top one. A row just pressed is still kept where it was pressed.
  if (!listAnchor.pressed && el.scrollTop < 1) return;
  const row = [...el.children].find((d) => d.dataset.key === listAnchor.key); if (!row) return;
  const off = Math.min(listAnchor.off, el.clientHeight - row.offsetHeight);   // a row that grew taller stays wholly in view
  el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - off;
}).observe($("#threads"));
for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { for (const p of pressTimers) clearTimeout(p); pressTimers.clear(); }, { capture: true, passive: true }); // no press timer outlives its touch, whichever element got the release // keys target the open conversation again once the mouse leaves the list
$("#menuBtn").onclick = (e) => { e.stopPropagation(); toggleMenu(); };
// The phone header's ⋯: the list's actions that used to sit among the filter chips (Read all, Done all; the same buttons, clicked),
// and Refresh for when pulling is not convenient.
$("#pmore").onclick = (e) => { e.stopPropagation(); const m = $("#menu"); m.classList.remove("sheet");
  const items = [...$$("#chips [data-blanket]")].map((b) => [`chip:${b.dataset.blanket}`, b.textContent.trim(), b.dataset.blanket === "read" ? "unread" : "done", b.disabled]).concat([["refresh", "Refresh", "refresh", false]]);
  m.innerHTML = items.map(([k, l, i, dis]) => `<button data-pm="${k}"${dis ? " disabled" : ""}>${ico(i)}${esc(l)}</button>`).join("");
  const r = e.currentTarget.getBoundingClientRect(); m.classList.add("on"); m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + "px"; m.style.top = (r.bottom + 4) + "px";
  m.querySelectorAll("[data-pm]").forEach((b) => b.onclick = () => { m.classList.remove("on"); const k = b.dataset.pm; if (k === "refresh") return refresh(); $(`#chips [data-blanket="${k.slice(5)}"]`)?.click(); });
  setTimeout(() => document.addEventListener("click", () => m.classList.remove("on"), { once: true }), 0); };
$("#sideNew").onclick = () => openCompose();
// Pull down to refresh (phone list). Touch events, not pointer events: once the browser owns a vertical pan it cancels the
// pointer, and at the top of the list a downward pan is exactly that. The pull is claimed only when it starts at the top and is clearly
// downward, so row swipes (horizontal) and ordinary scrolling are untouched; a small buzz says the release will refresh.
(() => {
  const el = $("#threads"); if (!el) return; const ind = document.createElement("div"); ind.className = "ptr"; ind.innerHTML = ico("refresh"); document.body.appendChild(ind);
  const TH = 64, MAX = 120; let y0 = null, x0 = 0, pulling = false, armed = false, busy = false, d = 0, topY = 0;
  const paint = () => { ind.style.top = (topY + d - 46) + "px"; ind.style.opacity = String(Math.min(1, d / TH)); const i = ind.querySelector(".i"); if (i) i.style.transform = `rotate(${Math.round(d * 3)}deg)`; };
  el.addEventListener("touchstart", (e) => { y0 = null; if (busy || !phoneUI() || e.touches.length !== 1 || el.scrollTop > 0) return; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; pulling = false; armed = false; d = 0; topY = el.getBoundingClientRect().top; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (y0 == null) return; const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (!pulling) { if (dy > 10 && dy > 1.5 * Math.abs(dx) && el.scrollTop <= 0) pulling = true; else { if (Math.abs(dx) > 10 || dy < -6) y0 = null; return; } }
    if (e.cancelable) e.preventDefault(); d = Math.min(MAX, dy * 0.55);
    if ((d >= TH) !== armed) { armed = d >= TH; if (armed) { try { navigator.vibrate?.(8); } catch (_) {} } } paint();
  }, { passive: false });
  const end = () => {
    if (y0 == null) return; y0 = null; if (!pulling) return; pulling = false;
    if (!armed) { ind.style.transition = "top .18s, opacity .18s"; d = 0; paint(); setTimeout(() => { ind.style.transition = ""; }, 200); return; }
    busy = true; ind.style.transition = "top .15s"; d = TH; paint(); ind.classList.add("spin");
    Promise.resolve().then(() => refresh()).catch(() => {}).finally(() => { ind.classList.remove("spin"); ind.style.transition = "top .2s, opacity .2s"; d = 0; paint(); setTimeout(() => { ind.style.transition = ""; busy = false; }, 220); });
  };
  el.addEventListener("touchend", end, { passive: true }); el.addEventListener("touchcancel", end, { passive: true });
})();
// Drag files onto a draft to attach them. While the compose window is open it takes every drop;
// otherwise the reading pane takes it for the reply to the open conversation (on a phone that opens the reply sheet). A drop adds to
// the files already there. Anywhere else the drop is refused, never left to the browser: a file dropped on a page the page does not
// claim replaces the app with that file. Folders are skipped: they have no bytes to send.
// A mail body is a sandboxed frame without scripts, and WebKit (the Mac app) runs none of this page's listeners inside it: measured
// 2026-10-06, a click or dragover dispatched on a frame's body reached no listener in WebKit, while Chromium ran them. So while files
// are being dragged over the window the frames take no pointer events (.filedrag), and a drag over a mail lands on this page.
function dropTarget(el) {
  if ($("#cmodal").classList.contains("on")) return { zone: $("#cmodal .card"), input: $("#cfiles"), reply: false };
  if (state.replyTo && el instanceof Element && el.closest("section.view")) return { zone: $("section.view"), input: $("#rfiles"), reply: true };
  return null;
}
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
let dropLit = null, dropTimer = 0;
const dropUnlight = () => { dropLit?.classList.remove("dropping"); dropLit = null; };
const dropEnd = () => { dropUnlight(); document.documentElement.classList.remove("filedrag"); };
function onFileDrag(e, el = e.target) {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); document.documentElement.classList.add("filedrag"); const d = dropTarget(el); e.dataTransfer.dropEffect = d ? "copy" : "none";
  if (dropLit !== (d?.zone || null)) { dropUnlight(); if (d) { dropLit = d.zone; dropLit.classList.add("dropping"); } }
  clearTimeout(dropTimer); dropTimer = setTimeout(dropEnd, 250);   // dragover repeats while a drag is over the page; when it stops, the drag has left
}
function onFileDrop(e, el = e.target) {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); clearTimeout(dropTimer); dropEnd();
  const d = dropTarget(el); if (!d) return;
  const picked = [], items = [...(e.dataTransfer.items || [])].filter((it) => it.kind === "file"); let folders = 0;
  if (items.length) for (const it of items) { const f = it.getAsFile(); if (!f) continue; if (it.webkitGetAsEntry?.()?.isDirectory) folders++; else picked.push(f); }
  else picked.push(...e.dataTransfer.files);
  if (picked.length) {
    setFiles(d.input, [...d.input.files, ...picked]);
    if (d.reply) openReplySheet();
    toast(`Attached ${picked.length === 1 ? picked[0].name : picked.length + " files"}${folders ? " (folders can't be attached)" : ""}`);
  } else if (folders) toast("Folders can't be attached - drop the files inside");
}
window.addEventListener("dragenter", (e) => onFileDrag(e)); window.addEventListener("dragover", (e) => onFileDrag(e)); window.addEventListener("drop", (e) => onFileDrop(e));
for (const [inp, lbl] of [["#rfiles", "#rfilesn"], ["#cfiles", "#cfilesn"]]) $(inp).addEventListener("change", () => { const n = $(inp).files.length; $(lbl).textContent = n ? `${n} file${n > 1 ? "s" : ""}` : "Attach"; }); $("#scrim").onclick = () => closeMenu();
window.addEventListener("online", () => { document.body.classList.remove("is-offline"); refresh({ silent: true }); }); window.addEventListener("offline", () => document.body.classList.add("is-offline"));
// Swept twice: at once for what the page already knew, and again when the refresh has brought it up to date.
document.addEventListener("visibilitychange", () => { if (!document.hidden) { adoptOnResume(); refresh({ silent: true }).then(sweepNotifications, () => {}); sweepNotifications(); } });
// Field evidence for the hidden Mac window: macOS may SUSPEND a hidden WKWebView page (inactiveSchedulingPolicy defaults to suspend
// for apps built on recent SDKs) rather than throttle it, and a suspended page can neither take the mail the native side hands it nor
// be ready when the window comes back. A 1 s heartbeat tells them apart: after a suspension the longest gap between beats while hidden
// is about as long as the window was away; throttling leaves it at the throttle interval. Read in Settings -> Speed.
{ let beat = Date.now(), hiddenAt = 0, maxGap = 0;
  setInterval(() => { const now = Date.now(); if (hiddenAt) maxGap = Math.max(maxGap, now - beat); beat = now; }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); maxGap = 0; return; }
    if (!hiddenAt) return; const now = Date.now(); const away = now - hiddenAt; hiddenAt = 0;
    if (away > 5000) { perf.record("resume:away-ms", away); perf.record("resume:longest-frozen-ms", Math.max(maxGap, now - beat)); }
  });
}
// Coming back to the app is usually NOT a boot. Android keeps an installed PWA alive in the background, so most reopens on the phone
// are resumes, and adoption ran only at boot, so the stashes the worker wrote while the app was out of sight sat unread and new
// mail waited for refresh() to finish a network sync (reopening usually meant waiting for a load). A stash is exactly as
// local on a resume as on a cold start, so it is adopted here too, with the same guards. Before boot has loaded the store this does
// nothing: the boot sequence owns that first pass.
let bootStoreReady = false;
async function adoptOnResume() {
  if (!bootStoreReady) return;
  const t0 = performance.now();
  const native = await importNativeStashes();
  const r = await adoptPushStashes();
  if (native.length) primeStashes(native);
  const b = perf.boot; b.resumes = (b.resumes || 0) + 1; b.resumeFound = (b.resumeFound || 0) + r.found; b.resumeAdopted = (b.resumeAdopted || 0) + r.adopted;
  if (!r.adopted) return;
  dropStalePrerenders(); applyMuted(); render(); updateBadge();   // a prerender cached before the new message must not be what a tap opens
  followOpenThread().catch(() => {});   // nor what an open conversation keeps showing
  requestAnimationFrame(() => perf.record("resume:adopted-visible", performance.now() - t0));
}
function renderSignedOut() { $("#threads").innerHTML = `<div class="empty"><p>Signed out.</p><a href="/auth/google"><button class="primary">Sign in with Google</button></a></div>`; $("#nav").innerHTML = ""; }
// What sits over the conversation view when a notification opens one. The file preview, Settings, the side menu and a
// dialog (cancelled: its safe answer) close; they stayed on top of the new conversation (a PDF open when a
// notification is tapped stayed on top). A composer with a message in it stays, with the conversation opened beneath it
// (openThread's `under`); an empty one closes.
function clearForNotification() {
  if ($("#avmodal").classList.contains("on") && !dropLayer("attview")) attClose();
  if ($("#smodal").classList.contains("on")) closeSettings();
  closeMenu();
  cancelCard();
  if (ask.pending) ask.pending(false);
  if ($("#cmodal").classList.contains("on") && !composeWork() && !dropLayer("compose")) composeClosed();
}
// `local` = the early call at storeReady, which may only answer from the store. It must NOT reach the network: the boot
// sequence has not run loadAccounts() yet, so a refresh() started here would sync against an incomplete account list AND
// take `state.loading`, which refresh() guards on: silently turning the boot's own refresh into a no-op. So when the
// early call cannot satisfy the parameters it leaves them in the URL untouched and the post-refresh call handles them.
async function handleParams({ local = false } = {}) {
  const u = new URLSearchParams(location.search);
  // The early call answers ONE question: "is this notification's conversation already here?", and touches nothing
  // else. openSettings() and openCompose() read state that loadAccounts() has not filled yet, and the first draft ran
  // them anyway: with `?gmail=x&thread=y` the gmail branch fired against empty state, cleared the URL, and the thread
  // was then lost for ever because the later call had no parameters left to act on.
  //  Everything except the thread lookup belongs to the post-loadAccounts call.
  if (!local && u.get("gmail")) { toast("Gmail connected: " + u.get("gmail")); history.replaceState(history.state, "", "/"); openSettings(); }
  if (!local && u.get("compose")) {
    history.replaceState(history.state, "", "/"); openCompose();
    // A mailto: link handed over by the native Mac app (or any ?compose=1 link) can pre-fill the message.
    if (u.get("to")) $("#cto").value = u.get("to"); if (u.get("cc")) $("#ccc").value = u.get("cc"); if (u.get("bcc")) $("#cbcc").value = u.get("bcc");
    if (u.get("subject")) $("#csub").value = u.get("subject"); if (u.get("body")) $("#ctext").value = u.get("body") + $("#ctext").value;
  }
  if (u.get("account") || u.get("thread")) {
    const acc = u.get("account"), th = u.get("thread");
    const key = `${acc || "hub"}|${th}`;
    // Adopted from the push stash at boot, in which case the conversation opens from local bytes with no network at all.
    if (local && !(th && state.threads.has(key))) return;   // leave the URL intact for the post-refresh call
    history.replaceState(history.state, "", "/");
    clearForNotification();
    if (acc && acc !== "hub") setView("inbox", acc);
    if (!th) return;
    // The phone's own download of this push is taken first: the page may have been frozen since the push, so the
    // import the push asked for has not run, and the copy already here is the one from before the new message.
    if (state.cur === key || state.threads.has(key)) { try { await primeStashes(await importNativeStashes()); } catch (_) {} openThread(key); return; }
    // Not on this device yet, so it loads first, and the conversation that was open must not stay up meanwhile. Tapped with another
    // domain mail open, the old one stayed on screen for the whole load, and for good when the load failed (an email
    // open when the app was left stayed open after a notification tap). The list shows while it loads, as
    // the account switch above already does for Gmail.
    if (state.cur) { state.cur = null; state.curThread = null; if (!dropLayer("thread")) closeThreadView(); }
    const found = await ensureThreadLocal(acc || "hub", th);
    if (found) openThread(found); else toast("Couldn't open that conversation");
  }
}
// A notification tapped for mail this device has not seen yet: the common case, since new mail is what notifies. It used to
// fall back to one refresh(), which is a no-op while another refresh holds state.loading, and coming back to the app STARTS
// one (visibilitychange), so a tap that woke the app opened nothing and left the inbox on screen (on
// Android; the Mac app opens notifications the same way). In order: the copy the device already downloaded for this push,
// the sync that is already running, a sync of our own, and finally this one conversation fetched straight from its account.
async function ensureThreadLocal(acc, th) {
  const key = `${acc}|${th}`;
  const have = () => state.threads.has(key);
  try { await primeStashes(await importNativeStashes()); } catch (_) {}
  if (have()) return key;
  // One request for this one conversation beats waiting on a whole sync. It is kept as a push stash, so openThread() renders
  // from these same bytes (pushedThread) instead of fetching the conversation a second time.
  try {
    const kind = acc === "hub" ? "hub" : "gmail";
    const raw = kind === "hub" ? await api(`/api/threads/${encodeURIComponent(th)}`) : await gapi(acc, `threads/${encodeURIComponent(th)}?format=full`);
    const v = { kind, account: acc, id: th, raw, at: Date.now() };
    memStashPut(key, v);   // in memory too: with a stalled store this is the copy openThread() renders from
    await idb.meta(`pf:${key}`, v);
    await adoptPushStashes();
    if (!have()) {   // adoption takes inbox rows only; an archived or trashed conversation is still opened when tapped
      const row = rowFromStash({ kind, account: acc, raw });
      if (row && row.key === key) { row.updatedAt = Date.now(); state.threads.set(key, row); idb.putAll("threads", [row]).catch(() => {}); render(); }
    }
    if (have()) return key;
  } catch (_) {}
  // Offline or refused: whatever the syncs bring.
  for (let i = 0; i < 50 && state.loading; i++) await new Promise((r) => setTimeout(r, 100));
  if (have()) return key;
  await refresh({ silent: true });
  return have() ? key : null;
}
(async () => {
  if (!navigator.onLine) document.body.classList.add("is-offline");
  const snap = snapshot.read(); // synchronous first paint from the last snapshot
  if (snap) { for (const t of snap.threads) state.threads.set(t.key, t); state.gmail = (snap.accounts || []).map((e) => ({ email: e, status: "active" })); render(); requestAnimationFrame(() => { perf.boot.firstPaint = Math.round(performance.now()); }); }
  try { await idb.openWithRetry(); } catch (_) {} // a blocked upgrade is retried once; booting storeless loses the durable queue
  draftStore.loaded = draftLoad();   // this device's copy of the drafts, before the first sync can ask the hub for what changed since it
  loadImgDims();   // picture sizes, read in the background: a mail opened before they are in opens as it did before them
  loadTrackers();   // likewise the hub's blocks: until they are in, the hub's own image proxy still refuses what they block
  const snipFixed = await idb.meta("snipfix1");   // previews saved before gmailSnippet decoded &lt; and &gt; are repaired once (below)
  const cached = await idb.getAll("threads"); if (cached.length) { state.threads = new Map(); const fix = []; for (const t of cached) { if (!snipFixed && t.kind === "gmail" && /&(?:lt|gt);/.test(t.snippet || "")) { t.snippet = t.snippet.replace(/&lt;/g, "<").replace(/&gt;/g, ">"); fix.push(t); } if (t.kind === "gmail" && t.state !== "spam" && t.state !== "trash" && (t.labels || []).includes("SPAM")) { t.state = "spam"; fix.push(t); } state.threads.set(t.key, t); } if (fix.length) idb.putAll("threads", fix); }
  // The saved messages too, or the next rebuild of a conversation from them would bring the old preview back. Once, off the paint path.
  // In ONE readwrite transaction, record by record: reading them all and writing them back later could put a stale copy over a message
  // a sync had just updated (its labels) in between.
  if (!snipFixed) scheduleIdle(async () => { try { await idb.req("messages", "readwrite", (st) => { const c = st.openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return; const m = cur.value; if (/&(?:lt|gt);/.test(m.snippet || "")) { m.snippet = m.snippet.replace(/&lt;/g, "<").replace(/&gt;/g, ">"); cur.update(m); } cur.continue(); }; return c; }); await idb.meta("snipfix1", 1); } catch (_) {} });
  rebuildHubMsgIds(); // the dedupe set is derived from the cached rows; without this a boot whose first sync is a quiet delta shows every Gmail duplicate
  // The queue is loaded BEFORE adoption, not after: adoption must skip any key with an unsent local action, or a
  // conversation archived here while offline comes back the next time the app opens.
  await queue.load();
  await importNativeStashes();             // the Android app's downloads join the service worker's, then one adoption pass reads both
  const stash = await adoptPushStashes();   // mail that arrived while this was closed, from bytes already on the device
  perf.boot.storeReady = Math.round(performance.now()); perf.boot.cached = cached.length;
  perf.boot.stashes = stash.found; perf.boot.adopted = stash.adopted;   // the stash census both builder lanes asked for, taken on the device instead of guessed
  if (cached.length || stash.adopted) { render(); if (!perf.boot.firstPaint) requestAnimationFrame(() => { perf.boot.firstPaint = Math.round(performance.now()); }); }
  // A notification tapped while the app was closed can now be answered from the store, before any network. The later
  // call is kept as the fallback for what adoption could not cover (no stash, or a thread this device has never seen).
  handleParams({ local: true });
  perf.load(); try { navigator.storage?.persist?.(); } catch (_) {}
  // The FTS5 engine is 628 KB of sqlite3.mjs plus a wasm compile, and indexing the cached threads on top: on my phone
  // that was 1,497 of them. It used to run on every launch whether or not anyone searched, competing for the same main thread as
  // the interactions that measured act:trash 365 ms and open-thread:prerendered 65 ms. Both councils flagged it.
  //  It now starts the first time search is actually reached,
  // which is early enough: focusing the box or opening the palette happens before anyone finishes typing a query.
  bulkLogLoad();
  window.__ensureSearch = ensureSearch;   // NOT reset here: boot awaits IndexedDB first, and a search focused during that window has already started the engine
  if (queue.pending().length) { toast(`${queue.pending().length} pending action(s) resuming`); queue.kick(500); }   // loaded above, before adoption
  scheduleIdle(backfillUnsub); scheduleIdle(loadUnsubs);
  onBroadcast((m) => { // another window of this app: apply its local changes, pick up its queue rows, honour its recent persists
    if (m.type === "thread") { const t = state.threads.get(m.key); if (t && !((t.updatedAt || 0) > (m.patch.updatedAt || 0))) { Object.assign(t, m.patch); idb.putAll("threads", [t]); clearTimeout(onBroadcast._t); onBroadcast._t = setTimeout(() => { render(); updateBadge(); }, 60); } }
    else if (m.type === "queue") queue.load().then(() => queue.kick(200)).catch(() => {});
    else if (m.type === "recent") for (const k of m.keys || []) queue.recent.set(k, Date.now());
  });
  try { await loadAccounts(); } catch (e) { if (!state.signedOut) toast(e.message); return; }
  bootStoreReady = true;   // from here a return to the foreground adopts on its own (adoptOnResume): with prefs, mutes and snoozes loaded
  render();
  if (navigator.serviceWorker) { navigator.serviceWorker.register("/sw.js").catch(() => {}); scheduleIdle(() => syncPushSubscription()); navigator.serviceWorker.addEventListener("message", (e) => { const d = e.data || {}; if (d.type === "push") { notePushDelivered(); const acc = d.data?.account; refresh({ silent: true, accounts: acc && acc !== "hub" ? [acc] : ["hub"] }); if (d.data?.kind === "gmail") toast(d.data.title || "New mail"); } if (d.type === "open" && d.url) { const u = new URL(d.url); history.replaceState(history.state, "", u.search || "/"); handleParams(); } }); }
  await refresh({ silent: true });
  perf.boot.networkDone = Math.round(performance.now()); if (!perf.boot.firstPaint) requestAnimationFrame(() => { perf.boot.firstPaint = Math.round(performance.now()); });
  handleParams();
  // A 60-second poll cost 953 ms of mostly network every minute, measured on the phone (refresh:phase:sync 895 ms = 94% of it).
  // The Worker learned this exact lesson already: its cron skips the Gmail poll nine minutes in ten when a watch is live, because
  // push is what actually delivers. The client never did: it polled every minute regardless, while Gmail push was arriving in
  // seven seconds and its own service worker was waking the page. So when push really is live end to end (every active Gmail
  // account has an unexpired watch AND this device is registered with the hub for Web Push) the timer becomes what it always
  // should have been: a backstop. Anything less than that and it stays at a minute.
  const POLL_LIVE = 10 * 60_000, POLL_BACKSTOP = 60_000;
  let lastPoll = Date.now();
  setInterval(() => {
    if (document.hidden) return;
    if (Date.now() - lastPoll < (pushLive() ? POLL_LIVE : POLL_BACKSTOP)) return;
    lastPoll = Date.now(); refresh({ silent: true });
  }, 15000);
  // Backing the timer off makes this essential rather than merely nice: returning to the app must never show stale mail while a
  // ten-minute backstop runs down. Coming back into view is a signal, coalesced with the others.
  addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastPoll > 5000) { lastPoll = Date.now(); refresh({ silent: true }); } });
  // Checking for a new build used to ride along inside refresh(), so backing the poll off to ten minutes silently made updates up
  // to ten times slower to be NOTICED: on top of the stuck-queue bug that stopped them being applied at all. It has nothing to do
  // with mail sync: /api/version is a few bytes, and noticing a new build promptly is most of what "it just works" means when the
  // thing updates itself. It runs on its own short timer and whenever the app comes back to the foreground.
  setInterval(() => { if (!document.hidden) checkVersion(); }, 120_000);
  setTimeout(() => sendSpeedReport(), 60_000); setInterval(() => { if (!document.hidden) sendSpeedReport(); }, 3600_000);
  addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
  addEventListener("focus", () => checkVersion());
  // (online/offline are already handled above, where reconnecting triggers a refresh. A second pair here fired a refresh that
  //  refresh() then discarded on state.loading while still moving lastPoll: a poll credited but never performed.)
})();

// debug hook (also handy in the browser console)
window.mh = { warmPictures, syncDrafts, draftStore, editors, openDraft, draftFlush, idb, openThread, openCompose, openFind, closeFind, findStep, findState: find, actedElsewhere, imgDims, syncImgDims, applyImgDims, syncTrackers, urlHash, attOpen, attDownload, attRisk, attExpect, attSniff, attView, quoteSplitText, quoteSplitHtml, THREAD_ACTIONS, actionKey, gmailDelta, adapterFor, applyLocal, plainOf, openSettings, closeSettings, openImapForm, attHref, messageHtml, fillTrustAges, ensureThreadLocal, acceptStash, importNow, primeStashes, openUrl: (url) => { const u = new URL(url, location.origin); history.replaceState(history.state, "", u.pathname + u.search); return handleParams(); }, gmailTokens, contactBook, buildContactBook, parseAddrList, update, updateSafe, checkVersion, applyUpdate, sendSpeedReport, setImgPass, proxyImages, snapshot, idb, searchMore, serverSearch, applyLocal, queueSend, ask, askText, state, refresh, render, act, isHubCopy, mirrorHubCopies, catOf, prefs, visibleThreads, openThread, setView, perf, queue, localAct, prerendered, prefetchBodies, searchIndex, ensureSearch, backfillBodyIndex, openPalette, paletteCommands, fillVars, mdToHtml, buildMime, senderRule, focusReply, openMenuFor: (t) => openMenu({ target: document.body }, t), bootstrapAll, dropRowNode, writeSnapshotNow, markSnapshotDirty, pushLive, notePushMissed, notePushDelivered, pushLayer, dropLayer, closeMenu, layers, back: backLayer, bulk, bulkUndo, selectAll, selectFromHere, setFocus, counts, backfillUnsub, UNSUB_BACKFILL, refreshRowFromBodies, cachedThread, hub, syncHub, flushDeferredDeletes, threadFor, adoptServerRow, openExternal, chromeIntent, dismissNotifications, sweepNotifications, noteHandled, flushHandled, noteEndpoint, warmEndpoint, androidApp, syncPushSubscription, myPushId, pushOptOut, setPushOptOut, pushedThread, sweepPushStash, adoptPushStashes, rowFromStash };
