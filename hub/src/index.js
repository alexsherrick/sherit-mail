// mailhub: one inbox + sender for the user's custom domains.
// email(): catch-all inbound → forward to Gmail FIRST → raw to R2 → postal-mime → D1 rows (thread at ingest).
// fetch(): JSON API (bearer token) used by the UI and the CLI; outbound only through the send_email binding.
import PostalMime from "postal-mime";
import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";
import { connect } from "cloudflare:sockets";
import { AsyncLocalStorage } from "node:async_hooks";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import APP_HTML from "./client/app.html";
import APP_UI_JS from "./client/app.js";
import PERF_JS from "./client/perf.js";
import STORE_JS from "./client/store.js";
import SYNC_JS from "./client/sync.js";
import QUEUE_JS from "./client/queue.js";

// Spy trackers, by name: the same table as SPY_TRACKERS in client/app.js (test/smoke.cjs fails if the two ever differ). HEY's list
// (DHH's gist 360f4dc7ddbce786f8e82b97cdad9d20, "tracker_blocking.rb", 2020, MIT per its author) plus six from my mail.
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
const spyTrackerName = (u) => { for (const [name, rx] of SPY_TRACKERS) if (rx.test(u)) return name; return null; };
// ---------- remote images (the /api/img proxy, and the arrival-time prefetch) ----------
// One hardened fetch for both: the proxy answering an open, and the hub fetching a mail's images when it arrives. Hardened per
// Image/* only, declared-length precheck, streamed byte cap, redirects validated hop by hop, no IP-literal or
// localhost targets, DNS answers checked for private addresses.
// An image opened through /api/img may be 16 MiB; arrival prefetch keeps 8 MiB, since it buffers four images at once beside the raw
// message. 8 MiB refused a newsletter's 8,538,982-byte hero GIF from Klaviyo.
const IMG_MAX = 16 * 1024 * 1024, PREFETCH_IMG_MAX = 8 * 1024 * 1024;
// A picture fetched at a first open is kept only within the day allowance arrival prefetch draws on (prefetchAllowance, read at most once
// a minute per isolate and drawn down here), and only one picture over PREFETCH_IMG_MAX at a time per isolate. Keeping one costs about
// four copies while a slow device drains it, ~64 MiB at the 16 MiB cap, and the isolate also receives mail.
let openAllowance = null, bigKeepBusy = false;
async function openKeepAllowed(env, size) {
  if (!openAllowance || Date.now() - openAllowance.at > 60_000) openAllowance = { at: Date.now(), ...(await prefetchAllowance(env)) };
  if (openAllowance.images <= 0 || openAllowance.bytes < size) return false;
  openAllowance.images--; openAllowance.bytes -= size; return true;
}
const badHost = (h) => {
  h = (h || "").toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".")) return true;                                   // single-label names (localhost, intranet names)
  if (/(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet)$/.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[?[0-9a-f:]+\]?$/i.test(h) || /^0x/.test(h) || /^\d+$/.test(h)) return true; // IP literals
  return false;
};
const privateIp = (ip) => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|::ffff:|(0{1,4}:){5}ffff:|64:ff9b:|fe80:|fec0:|fc|fd)/i.test(String(ip || "").trim().toLowerCase().replace(/^\[|\]$/g, ""));
// The verdict is kept per host for a few minutes in the isolate: a newsletter's 30 images usually sit on one or two hosts, and asking
// DNS twice for every image spent two subrequests and a round trip each on an answer already known.
const dnsVerdicts = new Map();
const resolvesPrivate = async (host) => {
  const c = dnsVerdicts.get(host); if (c && c.until > Date.now()) return c.bad;
  // Pre-resolve over DNS-over-HTTPS and refuse names that answer with loopback, link-local or private addresses.
  let bad = false;
  try {
    const answers = await Promise.all(["A", "AAAA"].map(async (type) => (await (await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } })).json()).Answer || []));
    bad = answers.flat().some((a) => (a.type === 1 || a.type === 28) && privateIp(a.data));
  } catch (_) { bad = true; }
  if (dnsVerdicts.size > 500) dnsVerdicts.clear();
  dnsVerdicts.set(host, { bad, until: Date.now() + (bad ? 60_000 : 300_000) });
  return bad;
};
// An unsubscribe link with no one-click (no List-Unsubscribe-Post) is a page meant for a person. The app opened it in the browser, and a
// list that unsubscribes on the visit itself then showed its "you've been unsubscribed" page for nothing (A page nobody
// needs to see). The hub visits it instead, as a browser would: GET, redirects followed with every hop checked like the first, no
// cookies, 8 s in all. RFC 8058 section 1 says such lists "return landing pages with a confirmation step to finish the unsubscribe
// request", which a visit does not complete, so only a page that SAYS it is done counts as done, and one that also asks for a click does
// not. Anything else answers confirmed: false and the app opens the page for that click.
const UNSUB_DONE = /\b(?:you(?:'ve| have| are|'re)(?: now| been| successfully| already)* (?:been )?(?:unsubscribed|removed|opted[ -]out)|(?:has|have) been (?:successfully )?(?:unsubscribed|removed|opted[ -]out)|(?:successfully|now) (?:unsubscribed|opted[ -]out)|unsubscribed successfully|no longer subscribed|unsubscri(?:be|ption) (?:was |is )?(?:successful|complete)d?|(?:been |was )removed from (?:our|the|this|all)(?: \w+){0,2} (?:list|lists|mailings?)|unsubscribe request (?:has been|was) (?:processed|completed))\b/i;
const UNSUB_ASKS = /\bare you sure\b|\bconfirm (?:your |that you (?:want to )?)?unsubscri|\b(?:click|tap|press|select)\b.{0,60}?\b(?:to|and) (?:unsubscribe|confirm|complete|finish)\b/i;
// Linear stand-ins for `<!--[\s\S]*?-->` and `<(a|b)\b[\s\S]*?<\/\1\s*>`. Those regexes, and a bare `<[^>]*>`, are
// quadratic on an opener with no closer (every start rescans to the end) and the sender writes the HTML they run over: 100 KB of
// "<" took htmlText 3.5 s, 400 KB would take about 55 s, past the 30 s CPU a cron or a mail's invocation has, and the minute cron
// retried it for ever. Tag patterns here therefore read `[^<>]` (a scan stops at the next "<"), and these two keep the regexes' output:
// a block with no closer stays as it is. `rep` is a string, or a function given the text between the opening tag and the closer.
function dropComments(s, rep = " ") {
  s = String(s ?? ""); let out = "", at = 0;
  for (;;) { const i = s.indexOf("<!--", at); if (i < 0) break; const j = s.indexOf("-->", i + 4); if (j < 0) break; out += s.slice(at, i) + rep; at = j + 3; }
  return at ? out + s.slice(at) : s;
}
function dropBlocks(s, names, rep = " ") {
  s = String(s ?? ""); const lower = s.toLowerCase(), re = new RegExp("<(" + names + ")\\b", "gi"), dead = new Set(); let out = "", at = 0, m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase(); if (dead.has(name)) continue;
    let j = m.index + m[0].length, end = -1, close = -1;
    for (;;) { const k = lower.indexOf("</" + name, j); if (k < 0) break; let e = k + 2 + name.length; while (e < s.length && /\s/.test(s[e])) e++; if (s[e] === ">") { close = k; end = e + 1; break; } j = k + 1; }
    if (end < 0) { dead.add(name); continue; }   // no closer after here means none after any later opener either
    let open = s.indexOf(">", m.index); if (open < 0 || open >= close) open = close - 1;
    out += s.slice(at, m.index) + (typeof rep === "function" ? rep(s.slice(open + 1, close), s.slice(m.index, open + 1)) : rep); at = end; re.lastIndex = end;
  }
  return at ? out + s.slice(at) : s;
}
const pageText = (html) => dropBlocks(dropComments(html, " "), "script|style|noscript|template", " ").replace(/<[^<>]*>/g, " ").replace(/&(?:rsquo|apos|#0*39|#x0*27|#0*8217|#x0*2019);/gi, "'").replace(/[‘’]/g, "'").replace(/&(?:nbsp|#0*160);/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ");
const unsubConfirmed = (html) => { const t = pageText(html); return UNSUB_DONE.test(t) && !UNSUB_ASKS.test(t); };
const UNSUB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
// One page, fetched as a browser would: redirects followed with every hop checked like the first (at most 5), no cookies, 8 s in all,
// the first 256 KB read (where a page says it is done; the rest of a large page is never downloaded). A form sent by POST that is
// answered 301, 302 or 303 is followed with a GET, as a browser does. Answers { status, host, url, html }; html is "" for an error
// status or a redirect it would not follow.
async function unsubFetch(u, { method = "GET", body = null } = {}) {
  const signal = AbortSignal.timeout(8_000); let cur = u, r, m = method, b = body;
  for (let hops = 0; ; hops++) {
    r = await fetch(cur.href, { method: m, redirect: "manual", signal, headers: { "User-Agent": UNSUB_UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", ...(b ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, ...(b ? { body: b } : {}) });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    r.body?.cancel().catch(() => {});
    let nx; try { nx = new URL(r.headers.get("location") || "", cur); } catch (_) { return { status: r.status, host: cur.hostname, url: cur.href, html: "" }; }
    // https on every hop: a redirect to plain http would carry the visit, or a 307/308's form body, in the clear.
    if (hops >= 5 || nx.protocol !== "https:" || nx.username || nx.password || badHost(nx.hostname) || (await resolvesPrivate(nx.hostname))) return { status: r.status, host: cur.hostname, url: cur.href, html: "" };
    if (r.status === 303 || (m === "POST" && (r.status === 301 || r.status === 302))) { m = "GET"; b = null; }
    cur = nx;
  }
  if (!r.ok || !r.body) { r.body?.cancel().catch(() => {}); return { status: r.status, host: cur.hostname, url: cur.href, html: "" }; }
  const reader = r.body.getReader(), dec = new TextDecoder(); let html = "";
  while (html.length < 262_144) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); }
  reader.cancel().catch(() => {});
  return { status: r.status, host: cur.hostname, url: cur.href, html };
}
async function visitUnsubPage(u) { const v = await unsubFetch(u); return { status: v.status, host: v.host, confirmed: !!v.html && unsubConfirmed(v.html) }; }
// The page's one simple form, read as Inbox Zero reads it (inspectUnsubscribeHtml in apps/web/utils/unsubscribe, github.com/elie222/
// inbox-zero, read 2026-10-21): exactly one form, GET or POST, at most 12 controls, at most one submit control, only hidden, email,
// text, submit and button inputs, no select or textarea, no password, file, iframe or CAPTCHA anywhere on the page, and an empty email
// field filled with the address the mail came to. Inbox Zero then asks a model whether the page is already done. This hub has no model,
// so it reads the submit control's own words instead and sends only a form whose one button says unsubscribe, opt out, remove, confirm,
// yes or stop, and never resubscribe, keep, stay, undo, cancel, update, save, manage or no: a page that has already unsubscribed and
// offers to undo it must never be answered with its own form. Anything else is left to the user ("needs you").
// Tightened:
//  the button must say unsubscribe, opt out or remove, or else "yes"/"confirm" on a page that asks
// whether to unsubscribe; and nothing in the form, its button or any field's name or value, may speak of subscribing (other than
// unsubscribing), keeping, staying, undoing, cancelling, updating, saving, managing or preferences.
const UNSUB_GO = /\b(?:unsubscri\w*|opt[- ]?out|remove(?: me)?)\b/i, UNSUB_YES = /\b(?:yes|confirm\w*)\b/i;
const UNSUB_NOT = /(?<!un)subscri|\b(?:keep|stay|resume|undo|cancel|update|save|manage|preferences?|back|no|continue)\b/i;
const attrDecode = (v) => String(v).replace(/&(?:quot|#0*34);/gi, '"').replace(/&(?:apos|#0*39);/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/gi, "&");
function tagAttrs(s) { const o = {}; for (const m of String(s).matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) { const k = m[1].toLowerCase(); if (!(k in o)) o[k] = attrDecode(m[2] ?? m[3] ?? m[4] ?? ""); } return o; }
function unsubForm(html, pageUrl, recipient) {
  const h = dropBlocks(dropComments(html, " "), "script|style|noscript|template", " ");
  if (/<iframe\b/i.test(h) || /\b(?:g-recaptcha|h-captcha|cf-turnstile)\b/i.test(h)) return null;
  const tags = [...h.matchAll(/<(\/?)(form|input|button|select|textarea)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi)].map((t) => ({ close: !!t[1], tag: t[2].toLowerCase(), a: t[1] ? {} : tagAttrs(t[3]), at: t.index, end: t.index + t[0].length }));
  if (tags.some((t) => t.tag === "input" && /^(?:password|file)$/i.test(t.a.type || ""))) return null;
  const opens = tags.filter((t) => !t.close && t.tag === "form"); if (opens.length !== 1) return null;
  const f = opens[0], stop = tags.find((t) => t.close && t.tag === "form" && t.at > f.at)?.at ?? h.length;
  const method = (f.a.method || "GET").toUpperCase(); if (method !== "GET" && method !== "POST") return null;
  let action; try { action = new URL(f.a.action || pageUrl, pageUrl); } catch (_) { return null; }
  if (action.protocol !== "https:") return null;
  const controls = tags.filter((t) => !t.close && t.tag !== "form" && t.at > f.at && t.at < stop);
  if (controls.length > 12) return null;
  const fields = [], labels = [];
  for (const t of controls) {
    if (t.tag === "select" || t.tag === "textarea") return null;
    const type = (t.a.type || (t.tag === "button" ? "submit" : "text")).toLowerCase();
    if (t.tag === "input" && !["hidden", "email", "text", "submit", "button"].includes(type)) return null;
    if (type === "button" || type === "reset") continue;
    if (type === "submit") { const rest = h.slice(t.end, t.end + 2000); const e = rest.search(/<\/button\s*>/i); labels.push(t.tag === "button" ? (pageText(e >= 0 ? rest.slice(0, e) : "").trim() || t.a.value || t.a["aria-label"] || "") : (t.a.value || "Submit")); }
    if (!t.a.name) continue;
    const value = t.a.value || "";
    if ((type === "email" || (type === "text" && /e-?mail/i.test(t.a.name))) && !value) { if (!recipient) return null; fields.push([t.a.name, recipient]); continue; }
    fields.push([t.a.name, value]);
  }
  if (labels.length !== 1) return null;   // none: a script sends it (the user's click); more than one: a choice this hub cannot make
  const label = labels[0].replace(/\s+/g, " ").trim().slice(0, 80);
  if (!(UNSUB_GO.test(label) || (UNSUB_YES.test(label) && UNSUB_ASKS.test(pageText(h))))) return null;
  if (UNSUB_NOT.test(label) || fields.some(([n, v]) => UNSUB_NOT.test(n) || UNSUB_NOT.test(v))) return null;
  if (method === "GET") action.search = new URLSearchParams(fields).toString();   // a GET form's fields replace the action's query
  return { method, action, body: method === "POST" ? new URLSearchParams(fields).toString() : null, label };
}
// DKIM checked by the hub itself, for mail that came with no receiving server's verdict: a work mailbox read over IMAP (its server,
// the host's Exim, writes no Authentication-Results; two stored list mails read 2026-10-21) and the hub's oldest stored mail. RFC
// 6376: the selector's key comes from DNS (over HTTPS), the signed headers are canonicalized (relaxed or simple) and the signature is
// checked with WebCrypto (rsa-sha256 only), its body hash included: RFC 8058 section 4 asks for "a valid DKIM signature", and a valid
// one hashes the body too.
// The stored bytes as a string of one character per byte, so canonicalization and hashing see exactly what was signed (8-bit headers
// and bodies included), with bare LF line ends put back to the CRLF the signer hashed.
function rawBinary(raw) {
  const u8 = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
  let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s.replace(/\r?\n/g, "\r\n");
}
const binBytes = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
function rawHeaderFields(text) {
  const end = text.indexOf("\r\n\r\n"); const head = end < 0 ? text : text.slice(0, end);
  const out = []; for (const line of head.split("\r\n")) { if (/^[ \t]/.test(line) && out.length) out[out.length - 1].raw += "\r\n" + line; else if (line.includes(":")) out.push({ raw: line }); }
  for (const f of out) { const i = f.raw.indexOf(":"); f.name = f.raw.slice(0, i); f.value = f.raw.slice(i + 1); }
  return { fields: out, body: end < 0 ? "" : text.slice(end + 4) };
}
// RFC 6376 sections 3.4.3 and 3.4.4: the body as the signer hashed it.
function dkimBody(body, relaxed, l) {
  let b = relaxed ? body.split("\r\n").map((x) => x.replace(/[ \t]+/g, " ").replace(/ $/, "")).join("\r\n") : body;
  b = b.replace(/(?:\r\n)*$/, ""); b = b.length || !relaxed ? b + "\r\n" : "";
  return l != null && /^\d+$/.test(String(l).trim()) ? b.slice(0, Number(l)) : b;
}
const dkimRelaxed = (name, value) => `${name.trim().toLowerCase()}:${value.replace(/\r\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim()}`;
const dkimKeys = new Map();   // per isolate: "<s>._domainkey.<d>" -> { key, until }
async function dkimKey(name) {
  const c = dkimKeys.get(name); if (c && c.until > Date.now()) return c.key;
  let key = null;
  try {
    const j = await (await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) })).json();
    const txt = (j.Answer || []).filter((a) => a.type === 16).map((a) => String(a.data || "").replace(/"\s*"/g, "").replace(/^"|"$/g, "")).find((t) => /(?:^|;)\s*p=/.test(t)) || "";
    const tags = Object.fromEntries(txt.split(";").map((x) => x.trim().split("=")).filter((x) => x[0]).map(([k, ...v]) => [k.trim(), v.join("=").replace(/\s+/g, "")]));
    if (tags.p && (tags.k || "rsa") === "rsa") key = await crypto.subtle.importKey("spki", unb64(tags.p), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch (_) {}
  if (dkimKeys.size > 200) dkimKeys.clear();
  dkimKeys.set(name, { key, until: Date.now() + (key ? 3600_000 : 300_000) });
  return key;
}
async function dkimHeadersVerified(raw) {
  const { fields, body } = rawHeaderFields(rawBinary(raw));
  for (const sig of fields.filter((f) => lc(f.name.trim()) === "dkim-signature").slice(0, 3)) {
    const tags = {}; for (const part of sig.value.split(";")) { const i = part.indexOf("="); if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1); }
    const h = (tags.h || "").replace(/\s+/g, "").toLowerCase().split(":").filter(Boolean), d = (tags.d || "").trim().toLowerCase(), sel = (tags.s || "").trim().toLowerCase();
    if ((tags.v || "").trim() !== "1" || (tags.a || "").trim().toLowerCase() !== "rsa-sha256" || !d || !sel || !h.includes("from") || !h.includes("list-unsubscribe") || !h.includes("list-unsubscribe-post")) continue;
    const [hc, bc] = (tags.c || "simple").trim().toLowerCase().split("/"); const relaxed = hc === "relaxed";
    // A valid signature (RFC 8058 section 4 asks for one) includes its body hash: the body as signed must hash to bh=.
    const bh = (tags.bh || "").replace(/\s+/g, "");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", binBytes(dkimBody(body, bc === "relaxed", tags.l))));
    if (!bh || btoa(String.fromCharCode(...digest)) !== bh) continue;
    const canon = (f, value = f.value) => relaxed ? dkimRelaxed(f.name, value) : `${f.name}:${value}`;
    const used = new Set(); let data = "";
    for (const name of h) { for (let i = fields.length - 1; i >= 0; i--) { const f = fields[i]; if (used.has(i) || lc(f.name.trim()) !== name) continue; used.add(i); data += canon(f) + "\r\n"; break; } }
    data += canon(sig, sig.value.replace(/(^|;)(\s*b\s*=)[^;]*/i, "$1$2"));
    const key = await dkimKey(`${sel}._domainkey.${d}`); if (!key) continue;
    let b; try { b = unb64((tags.b || "").replace(/\s+/g, "")); } catch (_) { continue; }
    try { if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b, binBytes(data))) return true; } catch (_) {}
  }
  return false;
}
// ---------- Unsubscribe jobs ----------
// One tap in the app and the mail is gone; the hub does the rest once the 5 s Undo has passed. It reads the mail's own List-Unsubscribe
// headers (it never takes a URL from the device), tries the list's one-click, then its email address, then its page, records what the
// list answered, and trashes the sender's other promotions in every account. The aim: rolling through a list of
// senders quickly, without a 5-15 s wait on each.
//
// What the sweep may trash. The rule, the same day: an order's own mail stays when its seller also lists the buyer; only the
// promotions go. Measured on my Gmail that day: of 292 mails Gmail filed under Purchases in a year,
// 286 carry no List-Unsubscribe and none of the other 6 sits in Promotions; Etsy and DoorDash send their order, shipping and cancellation
// mail from the same address as their promotions, without List-Unsubscribe and filed under Updates. So a mail is swept only when it is
// list mail (List-Unsubscribe), Gmail filed it under Promotions and not Purchases, and its subject does not read like an order, a
// receipt, a delivery, a ticket, a booking or a payment. Mail on the hub's own domains has no Gmail category: there the header and the
// subject decide. Of 350 Promotions mails with List-Unsubscribe the subject test keeps 17 (4.9%): a promotion left behind costs a swipe,
// an order thrown away costs the order. app.js carries the same test for the rows it takes off the screen (UNSUB_TXN there).
const UNSUB_TXN = /\b(orders?|ordered|receipts?|invoices?|purchased?|shipped|shipping|shipments?|delivered|delivery|deliveries|tracking|track|refunds?|refunded|returns?|reservations?|booking|booked|itinerary|tickets?|confirmation|confirmed|payments?|paid|statements?|renewal|renews?|autoship|bills?|billing)\b/i;
const UNSUB_SWEEP_FETCHES = 16;   // Gmail calls one run spends on the sweep (list, read, trash); the rest waits for the next minute
const UNSUB_STALE_MS = 2 * 60_000; // a job still queued or running after this was cut off (waitUntil ends at 30 s): the cron takes it
function unsubLinks(hdr) {
  const links = [...String(hdr || "").matchAll(/<([^<>]+)>/g)].map((m) => m[1].trim());
  const mailto = links.find((l) => /^mailto:/i.test(l)) || null;
  const https = links.find((l) => { try { const u = new URL(l); return u.protocol === "https:" && !/^\[?[\d.:]+\]?$/.test(u.hostname); } catch (_) { return false; } }) || null;   // https only, never an IP literal
  return { mailto, https };
}
// Every value of a header in the stored bytes, unfolded (rawHeaderFirst gives only the first).
function rawHeaderAll(raw, name) {
  const u8 = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
  const head = new TextDecoder().decode(u8.subarray(0, 262144)).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const want = name.toLowerCase() + ":";
  return head.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(want)).map((l) => l.slice(want.length).trim());
}
// RFC 8058 section 4: "If the message does not have the required DKIM signature, the mail receiver SHOULD NOT offer a one-click
// unsubscribe", and the signature must cover List-Unsubscribe and List-Unsubscribe-Post. The hub does no crypto of its own. The
// receiving server (Gmail's mx.google.com, Cloudflare's mx.cloudflare.net) verified the signatures and wrote in its
// Authentication-Results which passed, naming each by the start of its b= value (header.b); the signature lists in h= the headers it
// covers. Every verdict passed in must name the signature (Cloudflare's Authentication-Results and its ARC copy, as lockAuth reads them).
// Measured 2026-10-21 on my Gmail: 107 of 108 one-click senders pass this; the other failed DKIM outright.
// Does the receiving server's DMARC verdict prove this From address's domain: `dmarc=pass` with header.from EXACTLY that domain, in the
// stamp of the server named? What an unsubscribe's block, Newsletters filing and sweep of the sender's other mail need.
function dmarcProves(ar, server, addr) {
  const a = String(ar || "").replace(/\s+/g, " ").trim().toLowerCase(), dom = (String(addr || "").toLowerCase().split("@")[1] || "");
  return a.startsWith(server + ";") && dmarcPassFor(a, dom);
}
// The receiving server's OWN DMARC verdict: the clause that starts "dmarc=". Matching "dmarc=pass" anywhere took it from
// the spf clause, which prints the envelope sender as written: `MAIL FROM:<dmarc=pass@attacker.example>` made any spoofed From
// "authenticated" (rules, the unsubscribe block, Newsletters filing). Clauses are split on ";" outside quotes and (comments), so a quoted
// local part carrying "; dmarc=pass header.from=bank.example" stays inside its own clause: Gmail writes its dmarc clause after spf.
function arClauses(stamp) {
  const s = String(stamp || ""), out = []; let cur = "", depth = 0, q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === "\\") cur += s[++i] ?? ""; else if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === "(") depth++; else if (c === ")" && depth) depth--;
    else if (c === ";" && !depth) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim()); return out;
}
// Exactly one, or none counts: if a receiver ever printed a quoted local part without its quotes, a sender
// of `"x);dmarc=pass header.from=bank.example;y"@attacker` would close the comment and add a top-level clause of its own, and Gmail
// writes its real dmarc clause last. A sender can add clauses but cannot remove the receiver's, so two of them is a forgery.
function dmarcClause(stamp) { const d = arClauses(stamp).filter((c) => /^dmarc=/i.test(c)); return d.length === 1 ? d[0] : ""; }
function dmarcPassFor(stamp, dom) { const c = dmarcClause(stamp); return !!dom && /^dmarc=pass\b/i.test(c) && ((/(?:^|\s)header\.from=([^\s;]+)/i.exec(c) || [])[1] || "").toLowerCase() === String(dom).toLowerCase(); }
function dkimCovers(verdicts, sigs) {
  const passed = (v) => [...String(v || "").matchAll(/\bdkim=pass\b[^;]*?\bheader\.b="?([A-Za-z0-9+/=]{6,})/gi)].map((m) => m[1]);
  const lists = verdicts.map(passed); if (!lists.length || lists.some((l) => !l.length)) return false;
  return sigs.some((s) => {
    const v = String(s).replace(/\s+/g, ""); const b = (v.match(/(?:^|;)b=([^;]*)/) || [])[1] || "";
    const h = ((v.match(/(?:^|;)h=([^;]*)/) || [])[1] || "").toLowerCase().split(":");
    return !!b && lists.every((l) => l.some((p) => b.startsWith(p))) && h.includes("list-unsubscribe") && h.includes("list-unsubscribe-post");
  });
}
// The mail the user unsubscribed from, read by the hub: the newest incoming message of the conversation that carries
// List-Unsubscribe, its sender, and `covered`: whether a passing DKIM signature covers the unsubscribe headers (the receiving server's
// verdict where there is one, the hub's own check of the stored bytes where there is none). null when the conversation is gone.
async function unsubSource(env, job) {
  const db = env.DB;
  if (job.account === "hub") {
    const m = await db.prepare("SELECT m.from_addr, m.identity, m.list_unsubscribe, m.list_unsubscribe_post, m.raw_key, m.ingest_source, m.size_bytes, m.auth_results, t.state FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.thread_id = ? AND m.direction = 'in' ORDER BY (m.list_unsubscribe IS NOT NULL) DESC, m.created_at DESC LIMIT 1").bind(job.thread_id).first();
    if (!m) return null;
    let covered = false, dupes = false;
    // Mail Cloudflare received carries its two stamps, which name the signatures that passed. Mail read over IMAP (a work mailbox) and the
    // hub's oldest stored mail carry none: there the hub checks the signature itself.
    if (m.list_unsubscribe && /one-click/i.test(m.list_unsubscribe_post || "") && m.raw_key) {
      // The whole message for the hub's own check (its body hash), up to 2 MB; Cloudflare's stamps need only the headers.
      const whole = (m.size_bytes || 0) <= 2_097_152;
      const o = await env.STORE.get(m.raw_key, whole ? {} : { range: { offset: 0, length: 131_072 } }).catch(() => null);
      if (o) {
        const raw = new Uint8Array(await o.arrayBuffer());
        // RFC 8058 section 3.1: "one List-Unsubscribe header field and one List-Unsubscribe-Post header field". A second one, written above
        // a signed pair, is what the stored row would carry while the signature vouched for the other.
        dupes = rawHeaderAll(raw, "list-unsubscribe").length > 1 || rawHeaderAll(raw, "list-unsubscribe-post").length > 1;
        const ar = rawHeaderFirst(raw, "authentication-results").replace(/\s+/g, " ").trim(), arc = rawHeaderFirst(raw, "arc-authentication-results").replace(/\s+/g, " ").replace(/^i=\d+;\s*/, "").trim();
        const stamped = m.ingest_source !== "imap" && /^mx\.cloudflare\.net;/i.test(ar) && /^mx\.cloudflare\.net;/i.test(arc);
        covered = !dupes && (stamped ? dkimCovers([ar, arc], rawHeaderAll(raw, "dkim-signature")) : whole && (await dkimHeadersVerified(raw)));
      }
    }
    const fromProven = !/^imap/.test(m.ingest_source || "") && dmarcProves(m.auth_results, "mx.cloudflare.net", m.from_addr);   // Cloudflare's own stamp only
    return { from: lc(m.from_addr), identity: lc(m.identity || ""), lu: m.list_unsubscribe || "", lup: m.list_unsubscribe_post || "", covered, dupes, spam: m.state === "spam", fromProven };
  }
  const tok = await gmailCachedToken(env, job.account);
  let th; try { th = await gmailApi(tok, `threads/${encodeURIComponent(job.thread_id)}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=Authentication-Results&metadataHeaders=DKIM-Signature`); }
  catch (e) { if (e.status === 404) return null; throw e; }
  const msgs = (th.messages || []).filter((x) => !(x.labelIds || []).includes("SENT"));
  const m = [...msgs].reverse().find((x) => hdrVal(x, "List-Unsubscribe")) || msgs[msgs.length - 1]; if (!m) return null;
  const hs = (m.payload || {}).headers || [];
  const ar = (hs.find((h) => lc(h.name) === "authentication-results")?.value || "").replace(/\s+/g, " ").trim();   // the topmost one is Gmail's own
  const dupes = hs.filter((h) => lc(h.name) === "list-unsubscribe").length > 1 || hs.filter((h) => lc(h.name) === "list-unsubscribe-post").length > 1;
  return { fromProven: dmarcProves(ar, "mx.google.com", addrOnly(hdrVal(m, "From"))), from: addrOnly(hdrVal(m, "From")), identity: lc(job.account), lu: hdrVal(m, "List-Unsubscribe"), lup: hdrVal(m, "List-Unsubscribe-Post"), covered: !dupes && /^mx\.google\.com;/i.test(ar) && dkimCovers([ar], hs.filter((h) => lc(h.name) === "dkim-signature").map((h) => h.value)), dupes, spam: (m.labelIds || []).includes("SPAM") };
}
// The ladder, each result recorded as what actually happened: an accepted one-click is "the list answered 200", an email is "sent",
// and only a page that says so is "done": the page itself, or what it answers once its simple form ("Yes, I'm sure") is sent. `step` is written before each contact, so a run cut off mid-way never sends the email twice.
async function unsubLadder(env, job, src) {
  const db = env.DB;
  if (src.spam) return { outcome: "spam", method: "none", answer: "in Spam: the sender was not contacted" };
  const { mailto, https } = unsubLinks(src.lu);
  if (!mailto && !https) return { outcome: "no_link", method: "none", answer: "no unsubscribe link this hub can use" };
  // Two List-Unsubscribe (or -Post) headers: which one the sender wrote cannot be told, so nothing is contacted, not even a page.
  if (src.dupes) return { outcome: "needs_you", method: "none", answer: "the mail carries more than one unsubscribe header (RFC 8058 allows one of each), so the hub contacted nothing: open the mail to unsubscribe" };
  const step = (s) => db.prepare("UPDATE unsubscribes SET step = ? WHERE id = ?").bind(s, job.id).run();
  const notes = [];
  let oneClickGone = null, emailTried = false;   // what the https contacts answered: null = one-click not tried; true = 404/410
  const target = async (s) => { let u; try { u = new URL(s); } catch (_) { return null; } return u.protocol !== "https:" || u.username || u.password || badHost(u.hostname) || (await resolvesPrivate(u.hostname)) ? null : u; };
  if (https && /one-click/i.test(src.lup)) {
    const u = await target(https);
    if (!u) notes.push("one-click link refused (not a public https address)");
    else if (!src.covered) notes.push(src.dupes ? "no one-click: the mail carries more than one unsubscribe header (RFC 8058 allows one of each)" : "no one-click: no passing DKIM signature covers the unsubscribe headers");
    else {
      await step("one-click");
      let r = null; try { r = await fetch(u.href, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", signal: AbortSignal.timeout(10_000) }); r.body?.cancel().catch(() => {}); } catch (_) {}
      // RFC 8058 section 3.1: "The mail sender MUST NOT return an HTTPS redirect". A redirect is recorded as one, not followed.
      if (r && r.status < 400) return { outcome: "accepted", method: "one-click", answer: `${u.hostname} answered ${r.status}${r.status >= 300 ? " (a redirect, which a list must not send)" : ""}` };
      notes.push(r ? `one-click refused by ${u.hostname} (${r.status})` : `${u.hostname} unreachable for one-click`);
      oneClickGone = !!r && (r.status === 404 || r.status === 410);
    }
  }
  if (mailto) {
    let mu = null, to = ""; try { mu = new URL(mailto); to = decodeURIComponent(mu.pathname).trim(); } catch (_) {}
    if (!/^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(to)) notes.push("the unsubscribe address is not a plain email address");
    else {
      // An unsubscribe COMMAND, never a message. The mailto's own subject and body went out as they were: 200 and 2,000
      // characters the sender wrote, sent from my address to any address the sender named. A list's command ("unsubscribe",
      // "signoff LIST", "remove", ONE token after it) is kept; anything else is sent as the word "unsubscribe". One token, never a sentence:
      //  "cancel domain domain2.example and delete all DNS records" passed the first version, from my address.
      const cmd = (v) => { const s = String(v || "").replace(/[\x00-\x1f\x7f]+/g, " ").trim(); return /^(?:un-?subscribe|signoff|sign-off|leave|remove|stop|opt-?out)(?: [\w.+=@:#\/-]{1,64})?$/i.test(s) ? s : "unsubscribe"; };
      const subject = cmd(mu.searchParams.get("subject")), text = cmd(mu.searchParams.get("body"));
      // Exactly once, through send_claims (the same reservation sendMail makes): a run cut off around the send is answered "may have
      // gone" by the next one, never sent again, and one that was cut off BEFORE sending sends it (the old `step`
      // guard reported "sent" for an email that never left).
      const key = "unsub-" + job.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
      await step("email"); emailTried = true;
      try {
        if (job.account === "hub") await sendMail(env, { from: src.identity, to: [to], subject, text, idempotency_key: key, plain: true, unsubscribe: true });   // no letterhead; not a lock's note (sendMail)
        else {
          const c = await db.prepare("INSERT INTO send_claims (key, state, at) VALUES (?, 'sending', ?) ON CONFLICT(key) DO UPDATE SET state = 'sending', at = excluded.at WHERE send_claims.state = 'failed'").bind(key, now()).run();
          if (!c.meta?.changes) { const prev = await db.prepare("SELECT state FROM send_claims WHERE key = ?").bind(key).first(); return { outcome: "email_sent", method: "email", answer: prev?.state === "sent" ? `email sent to ${to}` : `an earlier try may have sent the email to ${to}; it is not sent again` }; }
          const mm = createMimeMessage(); mm.setSender(job.account); mm.setTo(to); mm.setSubject(subject); mm.addMessage({ contentType: "text/plain", data: text });
          const bytes = new TextEncoder().encode(mm.asRaw()); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          let sentNow = null;
          try { sentNow = await gmailApi(await gmailCachedToken(env, job.account), "messages/send", { method: "POST", body: JSON.stringify({ raw: btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }) }); }
          catch (e) { if (e.status && e.status < 500 && e.status !== 429) await db.prepare("UPDATE send_claims SET state = 'failed', at = ? WHERE key = ?").bind(now(), key).run().catch(() => {}); throw e; }   // a refusal frees it; a timeout or 5xx may have sent it
          await db.prepare("UPDATE send_claims SET state = 'sent', platform_id = ?, at = ? WHERE key = ?").bind(sentNow?.id || null, now(), key).run().catch(() => {});
        }
        return { outcome: "email_sent", method: "email", answer: `email sent to ${to}` };
      } catch (e) {
        if (e?.code === "ambiguous_send") return { outcome: "email_sent", method: "email", answer: `an earlier try may have sent the email to ${to}; it is not sent again` };
        notes.push(`the email to ${to} failed: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  if (https) {
    const u = await target(https);
    if (u) {
      await step("page");
      let v = null; try { v = await unsubFetch(u); } catch (_) {}
      // A page that already says it is done is done: its form is never sent. On such a page the one form is most often the offer to
      // undo it, and a "Yes" there resubscribes.
      if (v?.html && unsubConfirmed(v.html)) return { outcome: "confirmed", method: "page", answer: `${v.host}'s page says you are unsubscribed`, heavy: true };
      const form = v?.html ? unsubForm(v.html, v.url, src.identity) : null;
      const fu = form && (await target(form.action.href));
      if (fu) {
        await step("form");
        let w = null; try { w = await unsubFetch(fu, { method: form.method, body: form.body }); } catch (_) {}
        if (w?.html && unsubConfirmed(w.html)) return { outcome: "confirmed", method: "form", answer: `${w.host}'s page says you are unsubscribed, after its "${form.label}" button`, heavy: true };
        notes.push(w ? `${v.host}'s "${form.label}" button was pressed (${w.status}); the answer does not say it is done` : `${v.host}'s "${form.label}" button could not be pressed`);
      } else {
        if (form) notes.push("the page's form goes to an address this hub will not send to");
        notes.push(v ? `${v.host}'s page (${v.status}) does not say it is done` : `${u.hostname}'s page unreachable`);
      }
      // A link that does not exist is not a list to leave (a scam from a throwaway Gmail address carried
      // Nike's unsubscribe URL, and the one-click and the page both answered 404). When every https answer was 404 or 410, no form was
      // found and no email was sent, the job closes itself and unsubWork blocks the sender, instead of asking the user to click a
      // page that is not there. A refusal (403, 500), a timeout or a page that exists still needs the user.
      if (!form && v && (v.status === 404 || v.status === 410) && oneClickGone !== false && !emailTried) return { outcome: "nothing_there", method: "page", answer: notes.join("; ") + "; nothing to unsubscribe from: the mail's link does not exist, so the sender is blocked instead", url: https, heavy: true };
      return { outcome: "needs_you", method: "page", answer: notes.join("; "), url: https, heavy: true };
    }
  }
  return { outcome: "needs_you", method: https ? "page" : "none", answer: notes.join("; ") || "nothing worked", url: https };
}
// The sender's other mail. Hub mail: every inbox conversation that is only list mail from that address, in one update. Gmail: every
// connected account, Gmail's own search narrowing it to Promotions in the inbox, each hit read and judged, at most UNSUB_SWEEP_FETCHES
// calls a run. Answers true when nothing is left to look at.
async function unsubSweep(env, job, left) {
  const db = env.DB, a = job.sender;
  if (!left.hubDone) {
    const { results } = await db.prepare("SELECT t.id, (SELECT group_concat(m.subject, ' | ') FROM messages m WHERE m.thread_id = t.id) AS subjects FROM threads t WHERE t.state = 'inbox' AND t.id != ? AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.direction = 'in' AND lower(m.from_addr) = ?) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND (m.direction != 'in' OR lower(m.from_addr) != ? OR m.list_unsubscribe IS NULL)) LIMIT 200").bind(job.account === "hub" ? job.thread_id : "", a, a).all();
    const go = results.filter((r) => !UNSUB_TXN.test(r.subjects || "")); left.kept += results.length - go.length;
    // One thread at a time, its work-mailbox move queued BEFORE it leaves the inbox: a run cut off in between finds it still in the inbox
    // and does both again, where updating all of them first left their moves unqueued for good.
    for (const r of go) { await imapQueueForThread(env, r.id, { state: "trash" }); await db.prepare("UPDATE threads SET state = 'trash' WHERE state = 'inbox' AND id = ?").bind(r.id).run(); }
    if (go.length) { const e = await addHandled(env, go.map((r) => `hub|${r.id}`)); if (e.length) ctxWaitUntil(sendDismissPush(env, e, "unsubscribe").catch(() => {})); }
    left.swept += go.length; left.hubDone = true;
  }
  let budget = UNSUB_SWEEP_FETCHES;
  while (left.accts.length && budget > 0) {
    const acct = left.accts[0]; let tok;
    try { tok = await gmailCachedToken(env, acct); } catch (_) { left.accts.shift(); continue; }   // an account that cannot be reached now is skipped, not retried for ever
    budget--; const q = `from:(${a}) in:inbox category:promotions -category:purchases`;
    // A refusal for one account (revoked, no permission) skips that account; a busy or failing Gmail waits for the next run.
    const pt = (left.pt || {})[acct];
    let found; try { found = await gmailApi(tok, `messages?maxResults=20&q=${encodeURIComponent(q)}${pt ? "&pageToken=" + encodeURIComponent(pt) : ""}`); } catch (e) { if (e.status === 429 || !e.status || e.status >= 500) throw e; left.accts.shift(); continue; }
    // Whole conversations, never a message on its own: one trashed alone inside a conversation shows in no Sherit view,
    // and a promotion swept by mistake has to be findable in Trash. A conversation goes only when every message in it is this sender's
    // promotion and every one of them is in this page of Gmail's answer (so none of them was left out as Purchases), and one is in the inbox.
    const listed = new Set((found.messages || []).map((x) => x.id));
    const tids = [...new Set((found.messages || []).map((x) => x.threadId))].filter((t) => !left.judged.includes(t) && !(acct === job.account && t === job.thread_id));
    // Everything on this page was judged already (all kept): the next page, at most ten deep; then the account is done.
    if (!tids.length) { left.pages = (left.pages || 0) + 1; if (found.nextPageToken && left.pages <= 10) { (left.pt ||= {})[acct] = found.nextPageToken; continue; } left.accts.shift(); left.pages = 0; continue; }
    const trashed = [];
    const promo = (m) => { const lb = m.labelIds || []; return addrOnly(hdrVal(m, "From")) === a && lb.includes("CATEGORY_PROMOTIONS") && !!hdrVal(m, "List-Unsubscribe") && !UNSUB_TXN.test(hdrVal(m, "Subject")); };
    for (const tid of tids) {
      if (budget < 2) break;
      budget--; left.judged.push(tid);
      const th = await gmailApi(tok, `threads/${encodeURIComponent(tid)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`).catch(() => null);
      const msgs = th?.messages || [];
      if (!msgs.length || !msgs.some((m) => (m.labelIds || []).includes("INBOX")) || !msgs.every((m) => promo(m) && listed.has(m.id))) { left.kept++; continue; }
      budget--; await gmailApi(tok, `threads/${encodeURIComponent(tid)}/trash`, { method: "POST", body: "{}" }).then(() => { left.swept++; trashed.push(`${acct}|${tid}`); }, () => {});
    }
    if (trashed.length) { const e = await addHandled(env, trashed); if (e.length) ctxWaitUntil(sendDismissPush(env, e, "unsubscribe").catch(() => {})); if (left.pt) delete left.pt[acct]; }   // trashed mail leaves the results: start from the top again
    left.judged = left.judged.slice(-400);
  }
  return !left.accts.length;
}
// One job, start to finish or as far as this run gets. Claimed by a conditional update, so the request's waitUntil and the cron never
// work the same job at once.
async function unsubWork(env, id) {
  const db = env.DB, stale = new Date(Date.now() - UNSUB_STALE_MS).toISOString();
  const claim = await db.prepare("UPDATE unsubscribes SET status = CASE WHEN status = 'sweeping' THEN 'sweeping' ELSE 'running' END, claimed_at = ? WHERE id = ? AND (status = 'queued' OR (status IN ('running', 'sweeping') AND (claimed_at IS NULL OR claimed_at < ?)))").bind(now(), id, stale).run();
  if (!claim.meta?.changes) return;
  const job = await db.prepare("SELECT * FROM unsubscribes WHERE id = ?").bind(id).first(); if (!job) return;
  try {
    if (job.status !== "sweeping") {
      const src = await unsubSource(env, job);
      const r = !src ? { outcome: "gone", method: "none", answer: "the conversation is gone" } : src.from !== job.sender ? { outcome: "gone", method: "none", answer: `the conversation's mail is from ${src.from}, not ${job.sender}` } : await unsubLadder(env, job, src);
      // Nothing there: the sender is blocked (the same two statements as POST /api/senders) and the job is done; no sweep, no
      // Newsletters filing, because a mail whose unsubscribe link does not exist is not a list.
      // Only for a proven From: a forged "alerts@yourbank" with a dead link, unsubscribed from, blocked the real address.
      if (r.outcome === "nothing_there" && src.fromProven) {
        await db.prepare("INSERT INTO known_senders (address, status, first_seen_at, last_seen_at, first_account, seen_count) VALUES (?, 'blocked', ?, ?, ?, 0) ON CONFLICT(address) DO UPDATE SET status = 'blocked'").bind(job.sender, now(), now(), job.account === "hub" ? null : job.account).run();
        await db.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES (?, ?, 'block', '*', ?) ON CONFLICT(pattern, scope) DO UPDATE SET action = 'block'").bind(uuid(), job.sender, now()).run();
        await logEvent(db, "gatekeeper", null, `blocked 1 ${job.sender} (unsubscribe: its link does not exist)`);
      }
      const reached = ["accepted", "email_sent", "confirmed", "needs_you"].includes(r.outcome);
      // The sender's other mail is filed and swept only when its From is proven; otherwise the unsubscribe stands alone.
      const tidy = reached && !!src.fromProven;
      if (reached && !tidy) r.answer = `${r.answer || ""} — its other mail was left as it is: the From is not proven (no DMARC pass for ${job.sender.split("@")[1] || "its domain"})`;
      if (r.outcome === "nothing_there" && !src.fromProven) r.answer = String(r.answer || "").replace(/, so the sender is blocked instead$/, "") + `; the sender is NOT blocked: its From is not proven (no DMARC pass for ${job.sender.split("@")[1] || "its domain"})`;
      const accts = tidy ? ((await db.prepare("SELECT email FROM gmail_accounts WHERE status = 'active' ORDER BY email").all()).results || []).map((x) => x.email) : [];
      const left = { accts, hubDone: !tidy, judged: [], swept: 0, kept: 0 };
      await db.prepare("UPDATE unsubscribes SET status = ?, outcome = ?, method = ?, answer = ?, url = ?, sweep_left = ?, claimed_at = ? WHERE id = ?").bind(tidy ? "sweeping" : "done", r.outcome, r.method, String(r.answer || "").slice(0, 500), r.url || null, JSON.stringify(left), now(), id).run();
      await logEvent(db, ["accepted", "email_sent", "confirmed", "nothing_there"].includes(r.outcome) ? "unsubscribe" : "unsubscribe_fail", null, `${r.outcome} ${job.sender}: ${String(r.answer || "").slice(0, 200)}`);
      // Filed under Newsletters as a category only, with no address-level accept: a block of the whole
      // domain later still reaches this address.
      if (tidy) {
        await db.prepare("INSERT INTO sender_rules (id, pattern, action, scope, category, created_at) VALUES (?, ?, NULL, '*', 'newsletters', ?) ON CONFLICT(pattern, scope) DO UPDATE SET category = 'newsletters'").bind(uuid(), job.sender, now()).run();
        await db.prepare("UPDATE threads SET category = 'newsletters' WHERE category IS NOT NULL AND id IN (SELECT thread_id FROM messages WHERE lower(from_addr) = ? AND direction = 'in')").bind(job.sender).run();
      }
      if (!tidy) return;
      // A run that read pages (up to six hops each, with their DNS) has spent much of its 50 outside calls and its 30 s: the sweep is left
      // to the next minute's cron, which has its own.
      if (r.heavy) { await db.prepare("UPDATE unsubscribes SET claimed_at = NULL WHERE id = ?").bind(id).run(); return; }
      job.status = "sweeping"; job.sweep_left = JSON.stringify(left);
    }
    const left = parseJsonOr(job.sweep_left, null) || { accts: [], hubDone: true, judged: [], swept: 0, kept: 0 };
    const done = await unsubSweep(env, job, left);
    await db.prepare("UPDATE unsubscribes SET status = ?, swept = ?, kept = ?, sweep_left = ?, done_at = CASE WHEN ? THEN ? ELSE done_at END, claimed_at = NULL WHERE id = ?").bind(done ? "done" : "sweeping", left.swept, left.kept, done ? null : JSON.stringify(left), done ? 1 : 0, now(), id).run();
  } catch (e) {
    // A failure leaves the job where it was for the cron to take up again, four failures in all (a long sweep's runs are not failures).
    const last = (job.tries || 0) + 1 >= 4;
    await db.prepare("UPDATE unsubscribes SET tries = tries + 1, status = CASE WHEN ? THEN 'done' ELSE status END, outcome = CASE WHEN ? THEN COALESCE(outcome, 'error') ELSE outcome END, answer = CASE WHEN ? AND outcome IS NULL THEN ? ELSE answer END, claimed_at = NULL WHERE id = ?").bind(last ? 1 : 0, last ? 1 : 0, last ? 1 : 0, String(e?.message || e).slice(0, 300), id).run().catch(() => {});
    await logEvent(db, "unsubscribe_fail", null, `job ${id} ${job.sender}: ${String(e?.message || e).slice(0, 200)}`).catch(() => {});
  }
}
// The cron's share: one job a minute, the oldest left behind by a run that was cut off or a sweep with more to do. Its 10 ms of CPU are
// shared with the Gmail poll, so one job is the cap; the job's own request does nearly all of the work.
async function unsubCron(env) {
  const stale = new Date(Date.now() - UNSUB_STALE_MS).toISOString();
  const j = await env.DB.prepare("SELECT id FROM unsubscribes WHERE (status = 'queued' AND created_at < ?) OR (status IN ('running', 'sweeping') AND (claimed_at IS NULL OR claimed_at < ?)) ORDER BY created_at LIMIT 1").bind(stale, stale).first();
  if (j) await unsubWork(env, j.id);
}
// Point 7, the backstop. The FTC: "You must honor a recipient's opt-out request within 10 business days." Mail from an address the hub
// unsubscribed from that arrives after the 10th business day (Monday to Friday; public holidays are not known here, so a week with one
// can mark a sender a day early) is noted on its job, and the Unsubscribes list offers Block, with a word about receipts. Nothing is
// blocked on its own (option D, rejected for the receipts). Two runs that see the same message count it once (by its id).
const UNSUB_REACHED = ["accepted", "email_sent", "confirmed", "handled"];
function businessDaysAfter(iso, n) { const d = new Date(iso); let k = 0; while (k < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k++; } return d; }
function unsubJobsLoader(db) { let p = null; return () => (p ??= db.prepare(`SELECT id, sender, created_at FROM unsubscribes WHERE outcome IN (${UNSUB_REACHED.map(() => "?").join(",")}) AND dismissed_at IS NULL`).bind(...UNSUB_REACHED).all().then((r) => { const m = new Map(); for (const x of r.results || []) (m.get(x.sender) || m.set(x.sender, []).get(x.sender)).push(x); return m; }).catch(() => new Map())); }
async function unsubNoteArrival(db, jobs, addr, subject, atMs, ref) {
  const a = lc(addr || ""); if (!a) return;
  const list = (await jobs()).get(a); if (!list) return;
  const at = new Date(atMs).toISOString();
  for (const j of list) if (atMs > businessDaysAfter(j.created_at, 10).getTime())
    await db.prepare("UPDATE unsubscribes SET still_count = still_count + 1, still_at = ?, still_subject = ?, still_ref = ? WHERE id = ? AND (still_ref IS NULL OR still_ref != ?)").bind(at, String(subject || "").slice(0, 200), String(ref || at), j.id, String(ref || at)).run().catch(() => {});
}
// `u` is a URL whose target the caller has already checked. Answers { ok, ct, body } (body a stream that errors past `max` bytes or
// if its first bytes are not an image) or { ok: false, status, msg }.
// Each hop of a picture fetch, body included, ends after 20 s: a sender that drips its bytes held an arrival or the cron's drain past its
// own budget, which is checked only between pictures.
const IMG_FETCH_MS = 20_000;
async function fetchImageSafely(u, max = IMG_MAX) {
  let up, hops = 0, cur = u;
  while (true) {
    try {
      // `*/*` last, as every browser sends it: HubSpot's CTA images (hsctaimages.net) answer 406 to an Accept without it and redirect to
      // the PNG with it. What comes back must still be an image: the content type and first bytes are checked below.
      up = await fetch(cur.href, { redirect: "manual", signal: AbortSignal.timeout(IMG_FETCH_MS), headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5" } });
    } catch (e) { return { ok: false, status: 502, msg: "upstream error" }; }
    if ([301, 302, 303, 307, 308].includes(up.status)) {
      if (++hops > 3) return { ok: false, status: 502, msg: "too many redirects" };
      let nx; try { nx = new URL(up.headers.get("location") || "", cur); } catch (_) { return { ok: false, status: 502, msg: "bad redirect" }; }
      if (!/^https?:$/.test(nx.protocol) || badHost(nx.hostname) || (await resolvesPrivate(nx.hostname))) return { ok: false, status: 502, msg: "bad redirect target" };
      cur = nx; continue;
    }
    break;
  }
  if (!up.ok) return { ok: false, status: 502, msg: "upstream " + up.status };
  let ct = (up.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Any type but one of these is not believed either way: the magic number decides, and the picture is served as what its bytes are.
  // Some hosts send no type (one sender's image host), and some the wrong one: a school district's mail host serves its PNG
  // logo as application/x-www-form-urlencoded and a clinic's CDN as "undefined", which browsers draw and the hub refused.
  // An SVG, a font, a page or a stylesheet still has no image magic number, and is still "not an image".
  const generic = !/^image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(ct);
  const declared = parseInt(up.headers.get("content-length") || "0", 10);
  if (declared > max) return { ok: false, status: 413, msg: "too large" };
  // Stream through a counting transform: nothing is buffered, the stream is aborted past `max`, and the first bytes must
  // look like an image (magic numbers) regardless of the declared type.
  // One strict classifier for both declared and untyped bodies: the MIME type from the magic number, or null. RIFF must carry WEBP
  // (a WAVE is not an image) and an ISO-BMFF `ftyp` must carry an AVIF brand (an MP4 is not an image).
  const sniffImage = (b) => (b.byteLength >= 12 && (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? "image/png" :
    b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg" :
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 ? "image/gif" :
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? "image/webp" :
    b[0] === 0x42 && b[1] === 0x4d ? "image/bmp" :
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && /^(avif|avis|mif1|miaf)$/.test(String.fromCharCode(b[8], b[9], b[10], b[11])) ? "image/avif" :
    b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 ? "image/x-icon" : null)) || null;
  let body = up.body;
  if (generic) { // no usable declared type: read the first bytes, decide from the magic number, and put them back in front of the stream
    const reader = up.body.getReader(); let head0 = new Uint8Array(0);
    while (head0.byteLength < 12) { const { value, done } = await reader.read(); if (done) break; const m = new Uint8Array(head0.byteLength + value.byteLength); m.set(head0, 0); m.set(value, head0.byteLength); head0 = m; }
    const sniffed = sniffImage(head0); if (!sniffed) { try { await reader.cancel(); } catch (_) {} return { ok: false, status: 415, msg: "not an image" }; }
    ct = sniffed;
    body = new ReadableStream({ start(c) { c.enqueue(head0); }, async pull(c) { const { value, done } = await reader.read(); if (done) c.close(); else c.enqueue(value); }, cancel() { try { reader.cancel(); } catch (_) {} } });
  }
  let total = 0, head = new Uint8Array(0), checked = false;
  const counter = new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) { controller.error(new Error("too large")); return; }
      if (!checked) {
        const merged = new Uint8Array(head.byteLength + chunk.byteLength); merged.set(head, 0); merged.set(chunk, head.byteLength); head = merged;
        if (head.byteLength < 12) return;               // keep accumulating until the magic number is decidable
        checked = true;
        if (!sniffImage(head)) { controller.error(new Error("not an image")); return; }
        controller.enqueue(head); return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) { if (!checked) { if (head.byteLength && !sniffImage(head)) controller.error(new Error("not an image")); else if (head.byteLength) controller.enqueue(head); } },
  });
  return { ok: true, ct, len: declared, body: body.pipeThrough(counter) };
}
const imgKey = async (href) => "img/" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(href)))].map((b) => b.toString(16).padStart(2, "0")).join("");
// ---------- picture sizes ----------
// The width and height a browser lays a picture out at, read from its header without decoding it, or null: PNG's IHDR, GIF's logical
// screen, WebP's VP8 / VP8L / VP8X header, JPEG's first frame header (turned a quarter when its EXIF orientation is 5-8, which browsers
// apply), AVIF's largest 'ispe' (a grid's tiles and an alpha plane carry smaller ones) turned by 'irot'. The app uses only the ratio,
// as `aspect-ratio: auto w / h`, which defers to the picture's own ratio once it has loaded: a wrong answer costs a step, never a
// different-looking picture.
export function imgSize(b) {
  if (!b || b.length < 26) return null;
  const be16 = (i) => (b[i] << 8) | b[i + 1], le16 = (i) => b[i] | (b[i + 1] << 8), le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const be32 = (i) => b[i] * 16777216 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]), tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  const ok = (w, h, turned) => (w > 0 && h > 0 && w < 65536 && h < 65536 ? (turned ? { w: h, h: w } : { w, h }) : null);
  if (b[0] === 0x89 && tag(1) === "PNG\r" && tag(12) === "IHDR") return ok(be32(16), be32(20));
  if (tag(0) === "GIF8") return ok(le16(6), le16(8));
  if (tag(0) === "RIFF" && tag(8) === "WEBP") {
    const c = tag(12);
    if (c === "VP8X") return ok(le24(24) + 1, le24(27) + 1);
    if (c === "VP8L" && b[20] === 0x2f) { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
    if (c === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a && b.length >= 30) return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const exifTurned = (t, end) => { // TIFF header at t: byte order, 42, offset of IFD0; tag 0x0112 is the orientation
      end = Math.min(end, b.length); if (t + 8 > end) return false; const le = b[t] === 0x49;
      const r16 = (i) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]), r32 = (i) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 16777216 : be32(i));
      const ifd = t + r32(t + 4); if (ifd + 2 > end) return false;
      for (let k = 0, n = r16(ifd); k < n; k++) { const e = ifd + 2 + k * 12; if (e + 12 > end) return false; if (r16(e) === 0x0112) { const o = r16(e + 8); return o >= 5 && o <= 8; } }
      return false;
    };
    let i = 2, turned = false;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }                                   // fill byte
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }      // markers with no length
      if (m === 0xd9 || m === 0xda) return null;                            // the image ended, or its data began, before a frame header
      const len = be16(i + 2);
      if (m === 0xe1 && tag(i + 4) === "Exif") turned = exifTurned(i + 10, i + 2 + len);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(be16(i + 7), be16(i + 5), turned);
      i += 2 + len;
    }
    return null;
  }
  if (tag(4) === "ftyp" && /^(avif|avis|mif1|miaf)$/.test(tag(8))) {
    let best = null, rot = 0; const end = Math.min(b.length - 5, 65536);   // irot needs 5 bytes from its tag, ispe 16
    for (let i = 8; i <= end; i++) {
      if (b[i] !== 0x69) continue;                                          // "i" of ispe / irot
      const t = tag(i);
      if (t === "ispe" && i + 16 <= b.length) { const w = be32(i + 8), h = be32(i + 12); if (!best || w * h > best.w * best.h) best = { w, h }; } else if (t === "irot") rot = b[i + 4] & 3;
    }
    return best ? ok(best.w, best.h, rot === 1 || rot === 3) : null;
  }
  return null;
}
// A 53-bit hash of a picture's URL as /api/img keys it (new URL(u).href): the key the app finds a size by. cyrb53 (bryc, public
// domain). client/app.js carries the same function character for character; test/imgdims.mjs fails if the copies differ.
function urlHash(s) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); }
// A kept picture: when it was stored (img_seen, for the sweep that keeps a picture 90 days from the last time it was
// shown), and, when it is wider than the phone size or 500 KB and over, a row for the mailhub-img Worker, which writes its 1600 and
// 1080 px WebP sizes with our own WebAssembly shrinker (hub/img/) and drops the original once the desktop size covers it. The container
// old container shrinker read img_shrink, which nothing fills any more.
// A PNG is queued from 20 KB, whatever its width: on a week of kept pictures PNGs of 50-500 KB fell to 21 % as WebP (12 of 12) and
// 20-50 KB ones to 50 %, where JPEGs under 500 KB fell only to 87 % (8 of 12 not a fifth smaller) and WebPs are kept as sent. Known by
// its bytes, not the type the sender gave it.
const IMG_WORK_MIN = 500_000, IMG_WORK_PNG = 20_000, PHONE_W = 1080, IMG_WIDTHS = [1600, 1080];
const isPngBytes = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
// `org`: the sender whose share the picture spent; the shrinker gives that share back what it saves.
function imgKeptRows(db, key, buf, ct, org = null) {
  const b = new Uint8Array(buf), s = imgSize(b) || { w: 0, h: 0 }, t = now();
  const rows = [db.prepare("INSERT INTO img_seen (sha, stored_at) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING").bind(key.slice(4), t)];
  if (buf.byteLength >= IMG_WORK_MIN || s.w > PHONE_W || (buf.byteLength >= IMG_WORK_PNG && isPngBytes(b))) rows.push(db.prepare("INSERT OR IGNORE INTO img_work (key, bytes, ct, w, h, state, at, dom) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").bind(key, buf.byteLength, ct || null, s.w || null, s.h || null, t, org && org !== "-" && org !== "+requeue" ? org : null));
  return rows;
}
// Whether the hub holds a picture: its original (img/<sha>) or its desktop size (imgv/<sha>-1600), which replaces the original.
const imgHeld = async (env, key) => !!((await env.STORE.head(key).catch(() => null)) || (await env.STORE.head(`imgv/${key.slice(4)}-1600`).catch(() => null)));
// The statement that keeps one picture's size. A header that says nothing usable is kept as 0 x 0, so a picture whose size cannot be
// read is not read again each time it comes by; GET /api/imgdims never sends those rows.
const imgDimsRow = (db, href, bytes) => { const s = imgSize(new Uint8Array(bytes)) || { w: 0, h: 0 }; return db.prepare("INSERT OR IGNORE INTO img_dims (hk, w, h, at) VALUES (?, ?, ?, ?)").bind(urlHash(href), s.w, s.h, now()); };
// The browser may keep an image for 30 days: the picture the hub holds for a URL never changes (R2 is written once per URL). Its BYTES can:
// the shrinker replaces a big one with a smaller WebP of the same picture, so a browser or edge copy of the original stays
// right, only larger, until it expires. The edge cache
// gets its own copy marked public: Cloudflare refuses to store a response marked private ("must not be stored by a shared cache like
// Cloudflare", cache-control docs), so with `private` on the stored copy the edge cache had never held a single image and every open
// went back to the sender, now to R2 (~100 ms an image, measured in October 2026). The cache key is internal to this Worker and every
// request still passes the session check before it is read.
// A written size (imgv/) never changes under its key, so a device may keep it a year; an original may yet be replaced by its sizes, so
// a device asks again after 5 minutes and gets the small one.
const IMG_CC_SIZED = "private, max-age=31536000, immutable", IMG_CC_ORIGINAL = "private, max-age=300";
// A picture fetched from its sender at an open and kept nowhere (past the day's allowance, or while a big one is being kept): the device
// keeps it 30 days, as every picture was before the sizes, so a re-open does not ask the sender again.
const IMG_CC_UNKEPT = "private, max-age=2592000, immutable";
// A held picture shown: its last-shown day, at most one write a day per picture, none for one this isolate already
// wrote today. The daily sweep keeps a picture 90 days from that day.
const seenToday = new Map();
function imgSeen(env, sha) {
  const day = now().slice(0, 10); if (seenToday.get(sha) === day) return;
  if (seenToday.size > 5000) seenToday.clear(); seenToday.set(sha, day);
  try { ctxWaitUntil(env.DB.prepare("INSERT INTO img_seen (sha, stored_at, seen_at) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET seen_at = excluded.seen_at WHERE img_seen.seen_at IS NULL OR img_seen.seen_at < ?")
    .bind(sha, now(), now(), day).run().catch(() => {})); } catch (_) {}
}
const imgResponse = (body, ct, via, cc = IMG_CC_ORIGINAL) => new Response(body, { headers: { "content-type": ct, "cache-control": cc, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "x-img-source": via } });
const edgeCopy = (res) => { const r = new Response(res.body, res); r.headers.set("cache-control", "public, max-age=86400"); return r; };
// ---------- arrival-time image prefetch ----------
// When mail arrives the hub fetches the images the client would ask /api/img for and keeps them in R2, so an open never reaches the
// sender: Apple's Mail Privacy Protection downloads remote content "when you receive a message (instead of when you view it)" and
// Proton pre-loads it through a proxy, and so opening is served from R2 instead of waiting on a cold sender server. Trackers are
// never fetched: the block below is client/app.js's tracker code, copied verbatim (test/smoke.cjs fails if the copies differ), and
// prefetchImageUrls() collects exactly the URLs proxyImages() rewrites. Bounded so it stays far inside Cloudflare's limits: at most
// PREFETCH_MAX_IMAGES and PREFETCH_MAX_BYTES per mail, four fetches at a time, nothing new started after PREFETCH_BUDGET_MS (waitUntil
// allows 30 s). Nothing is prefetched for mail that is held, blocked, rate-limited or spam: its images would tell its sender the address
// is live. Best effort by design: a prefetch that does not happen leaves that mail exactly as before (fetched on first open, then kept).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
const PREFETCH_MAX_IMAGES = 60, PREFETCH_MAX_BYTES = 25 * 1024 * 1024, PREFETCH_BUDGET_MS = 20_000;
// Everything inbound mail can make the hub store in a day. Gmail mail is not behind the hub's inbound burst and byte limits, so without
// this a flood of image-heavy mail was an uncapped R2 cost. It was 60 MB, sized for ~10 MB a day of use
// and for an open fetching what the cap left; now an open never fetches a queued picture, so past the cap pictures
// stayed blank for hours, and use had grown to 60 MB and 232 pictures a day (A Gem mail's 23 of 27 withheld). At 250 MB
// every day for the 90-day img/ lifecycle, storage is 22.5 GB, $0.19 a month past R2's free 10 GB; 1,000 puts a day is 3% of the
// free Class A operations. Each sender's share (PREFETCH_DOMAIN_*) still stops one domain's flood.
const PREFETCH_DAY_IMAGES = 1000, PREFETCH_DAY_BYTES = 250 * 1024 * 1024;
// One sender's share of that day, by the From's domain: five mails of 200 pictures each spent the whole day, and every
// other mail's pictures were withheld (404) until the window moved on. A flood from one domain now stops at its share.
const PREFETCH_DOMAIN_IMAGES = 250, PREFETCH_DOMAIN_BYTES = 15 * 1024 * 1024;
async function prefetchDomainLeft(env, dom) {
  let images = 0, bytes = 0;
  try {
    const [{ results }, back] = await Promise.all([env.DB.prepare("SELECT detail FROM events WHERE at > datetime('now','-1 day') AND kind = 'img_prefetch' AND detail LIKE ?").bind(`% from=${dom} %`).all(), imgShrunkBack(env.DB, dom)]);
    for (const row of results || []) { images += +(/\bstored=(\d+)/.exec(row.detail || "")?.[1] || 0); bytes += +(/\bbytes=(\d+)/.exec(row.detail || "")?.[1] || 0); }
    bytes -= back;
  } catch (_) {}
  return { images: PREFETCH_DOMAIN_IMAGES - images, bytes: PREFETCH_DOMAIN_BYTES - bytes };
}
// What the shrinker saved on the pictures stored in the last 24 hours, for one sender or (dom undefined) for the day:
// a picture counts at the size the hub keeps of it, both WebP sizes and the original when it stays, not at the size it was fetched.
// A newsletter's four PNGs were 13.8 MB fetched and 0.71 MB kept; counted at 13.8 they spent a 15 MB share and withheld its last two.
async function imgShrunkBack(db, dom) {
  const since = isoIn(-86400e3);
  const r = dom === undefined ? await db.prepare("SELECT COALESCE(SUM(bytes - kept), 0) b FROM img_work WHERE state = 'done' AND at > ? AND kept IS NOT NULL AND kept < bytes").bind(since).first()
    : await db.prepare("SELECT COALESCE(SUM(bytes - kept), 0) b FROM img_work WHERE state = 'done' AND at > ? AND dom = ? AND kept IS NOT NULL AND kept < bytes").bind(since, dom).first();
  return Number(r?.b) || 0;
}
// What may still be stored today: the last 24 hours of prefetches, read back from their own img_prefetch events. Fails open: each
// mail is still bounded by the per-mail caps above.
export async function prefetchAllowance(env) {
  let images = 0, bytes = 0;
  try {
    const [{ results }, back] = await Promise.all([env.DB.prepare("SELECT detail FROM events WHERE at > datetime('now','-1 day') AND kind IN ('img_prefetch', 'img_open_kept')").all(), imgShrunkBack(env.DB)]);
    for (const row of results || []) { images += +(/\bstored=(\d+)/.exec(row.detail || "")?.[1] || 0); bytes += +(/\bbytes=(\d+)/.exec(row.detail || "")?.[1] || 0); }
    bytes -= back;   // at the size kept
  } catch (_) {}
  return { images: PREFETCH_DAY_IMAGES - images, bytes: PREFETCH_DAY_BYTES - bytes };
}
// The URLs client/app.js proxyImages() turns into /api/img requests, after its trackers are disarmed: src / background on img, td, th,
// table, body and div, srcset on those and <source> (entity-decoded, protocol-relative made https), plus CSS url() (decoded in an
// attribute, as written in a <style> element) each in the form /api/img keys R2 by: new URL(…).href, so "HTTPS://CDN.X.COM" stored at
// arrival is the object found at open.
// `hits`, when given, collects each picture a list or a learned pattern blocked ({ href, name, cls, rule }), for the apps.
export function prefetchImageUrls(html, hits = null) {
  const prev = trackerVerdict;
  if (hits) trackerVerdict = (u, box) => { const v = trkVerdict(u, box); if (v) hits.push({ href: u, ...v }); return v; };
  try { return prefetchUrlsOf(blockSpyTrackers(String(html || ""), [])); } finally { trackerVerdict = prev; }
}
function prefetchUrlsOf(h) {
  const out = new Set();
  const add = (d) => { if (String(d).length > 2048) return; try { const u = new URL(/^\/\//.test(d) ? "https:" + d : d); if (/^https?:$/.test(u.protocol) && u.href.length <= 2048) out.add(u.href); } catch (_) {} };   // no queue row for a 100 KB "URL"
  const px = (v) => { v = String(v || "").trim(); if (!v) return; const d = htmlUnent(v); if (/^(https?:)?\/\//i.test(d)) add(d); };
  const VAL = TAG_VAL;
  const attr = (name, fn, tags = "img|td|th|table|body|div") => { for (const m of h.matchAll(new RegExp("(<(?:" + tags + ")\\b[^<>]*?" + ATTR_AT + name + "\\s*=\\s*)" + VAL, "gi"))) fn(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]); };
  attr("src", px); attr("background", px);
  attr("srcset", (v) => { for (const c of srcsetCandidates(v)) px(c.url); }, "img|source|td|th|table|body|div");
  // A URL stops at the next `url(`: a run of unclosed `url(//` was read from each one to its end (1 MB: 155 s).
  const CSS_URL = /url\(\s*(['"]?)((?:https?:)?\/\/(?:(?!url\()[^)'"])+)\1\s*\)/gi;
  const rest = dropBlocks(h, "style", (css) => { for (const m of css.matchAll(CSS_URL)) add(m[2].trim()); return " "; });
  for (const m of rest.matchAll(CSS_URL)) add(htmlUnent(m[2].trim()));
  return [...out];
}
// `o.deadline` (epoch ms) ends this mail's fetching early when it shares a waitUntil with others (prefetchGmail); `o.left` is the day's
// remaining allowance (prefetchAllowance), shared and drawn down across a batch.
// ---------- the picture queue (migration 0048) ----------
// Every picture of an arriving mail gets a row before its fetch starts, and loses it once the picture is in R2. A row left behind (a failed fetch, the day's allowance spent, the arrival cut off or its invocation lost)
// is retried by the minute cron at times the
// arrival set, and /api/img answers an open of it without asking the sender.
// After a failed fetch: over the arrival cap → again at the open cap a minute later; not an image, or over the open cap → given up;
// anything else → 15 min, 2 h and 12 h later. The fourth failed attempt gives up. A given-up row still keeps the open from the sender.
const IMG_QUEUE_PER_MAIL = 200, IMG_RETRY_MS = [15 * 60e3, 2 * 3600e3, 12 * 3600e3], IMG_OVER_WAIT_MS = 3600e3;
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
// `org` is the sending organisation whose share of the day the picture spends when the cron fetches it;
// null for a picture queued again by an Undo or a learned pattern turned off, which no sender chose.
// `fill` marks a picture queued to catch up old mail: the mirror's picture fill, or a backfill. The drain takes it only
// after the pictures new mail is waiting for, and only while more than half of the day and of its sender's share is left. New mail
// wanting the same picture makes it new mail's (MIN).
const imgQueueAhead = (db, href, fetchingUntil, org = null, fill = 0) => db.prepare("INSERT INTO img_queue (hk, url, state, kind, tries, next_at, fetching_until, at, dom, fill) VALUES (?, ?, 'pending', 'new', 0, ?, ?, ?, ?, ?) ON CONFLICT(hk) DO UPDATE SET state = 'pending', fetching_until = excluded.fetching_until, next_at = MAX(next_at, excluded.next_at), dom = COALESCE(excluded.dom, img_queue.dom), at = excluded.at, fill = MIN(img_queue.fill, excluded.fill)")
  .bind(urlHash(href), href, isoIn(fetchingUntil ? 120e3 : 0), fetchingUntil, now(), org, fill ? 1 : 0);
// A held picture that comes in again with new mail starts its 90 days again: the sweep counts from the later of the last showing and the
// storing (COALESCE(seen_at, stored_at)), and a picture stored three months ago and never shown was swept, so the NEW mail's open fetched
// it from its sender. Arriving again counts as a showing.
const imgTouchRow = (db, key) => db.prepare("INSERT INTO img_seen (sha, stored_at, seen_at) VALUES (?, ?, ?) ON CONFLICT(sha) DO UPDATE SET seen_at = excluded.seen_at").bind(key.slice(4), now(), now());
const imgQueueDone = (db, href) => db.prepare("DELETE FROM img_queue WHERE hk = ?").bind(urlHash(href));
const imgQueueLater = (db, href, kind, ms) => db.prepare("UPDATE img_queue SET kind = ?, next_at = ?, fetching_until = NULL, last_at = ? WHERE hk = ?").bind(kind, isoIn(ms), now(), urlHash(href));
// Fetched and found not to fit what is left: its size is kept, so the drain asks the sender for it again only once it
// fits. It had downloaded it every hour to find out, 7 MB an hour for a newsletter's last two pictures. The shrinker makes the sender's
// waiting pictures due as soon as it gives the share back, and the hour stays as the fallback.
const imgQueueOver = (db, href, size) => db.prepare("UPDATE img_queue SET kind = 'over', size = ?, next_at = ?, fetching_until = NULL, last_at = ? WHERE hk = ?").bind(size, isoIn(IMG_OVER_WAIT_MS), now(), urlHash(href));
function imgQueueFailed(db, href, { big = false, permanent = false, note = "" } = {}) {
  return db.prepare("UPDATE img_queue SET kind = ?, tries = tries + 1, state = CASE WHEN ? = 1 OR tries + 1 >= 4 THEN 'dead' ELSE 'pending' END, next_at = CASE WHEN ? = 1 THEN ? WHEN tries + 1 = 1 THEN ? WHEN tries + 1 = 2 THEN ? ELSE ? END, fetching_until = NULL, note = ?, last_at = ? WHERE hk = ?")
    .bind(big ? "big" : "fail", permanent ? 1 : 0, big ? 1 : 0, isoIn(60e3), isoIn(IMG_RETRY_MS[0]), isoIn(IMG_RETRY_MS[1]), isoIn(IMG_RETRY_MS[2]), String(note || "failed").slice(0, 80), now(), urlHash(href));
}
export async function prefetchImages(env, html, tag, o = {}) {
  await trkLoad(env).catch(() => {});
  const hits = [], all = prefetchImageUrls(html, hits).slice(0, IMG_QUEUE_PER_MAIL), urls = all.slice(0, PREFETCH_MAX_IMAGES);
  // What a list or a learned pattern blocked is kept for the apps, so the mail they render hides the same pictures.
  if (hits.length) { try { await env.DB.batch(hits.slice(0, 200).map((x) => trkVerdictRow(env.DB, x))); } catch (_) {} }
  if (!urls.length) return { n: 0, blocked: hits.length };
  const t0 = Date.now(), until = Math.min(t0 + PREFETCH_BUDGET_MS, o.deadline || Infinity);
  // Written ahead, in one batch: the pictures fetched now are marked as being fetched, so an open in the meantime waits for them; the
  // ones past the per-mail cap are left for the cron. If the batch fails the mail is prefetched as before, with nothing to fall back on.
  const busy = new Date(until + 10e3).toISOString();
  // The share is the sender's ORGANISATION's: by exact domain, s1…s5.attacker.example each had their own and spent the day.
  // A From whose domain cannot be read had no share at all; every such sender now shares one, "-".
  const dom = /^[a-z0-9.-]+$/.test(String(o.from || "").toLowerCase().split("@")[1] || "") ? lockRoot(String(o.from).toLowerCase().split("@")[1]) : "";
  const org = dom || "-";
  // Queued only (o.queueOnly: the mirror's picture fill, gmailPicFill): every row is due now and the cron's drain fetches it, under the
  // same allowance and shares; nothing is fetched here.
  if (o.queueOnly) { try { await env.DB.batch(all.map((h) => imgQueueAhead(env.DB, h, null, org, 1))); } catch (_) { return { n: 0, queued: 0, blocked: hits.length }; } return { n: all.length, queued: all.length, blocked: hits.length }; }
  try { await env.DB.batch(all.map((h, i) => imgQueueAhead(env.DB, h, i < urls.length ? busy : null, org))); } catch (_) {}
  const left = o.left || (await prefetchAllowance(env));
  const mine = await prefetchDomainLeft(env, org);   // this sender's share left today
  if (left.images <= 0 || left.bytes <= 0 || mine.images <= 0 || mine.bytes <= 0) { try { await env.DB.batch(urls.map((h) => imgQueueLater(env.DB, h, "over", IMG_OVER_WAIT_MS))); } catch (_) {} await logEvent(env.DB, "img_prefetch_over_budget", null, `${tag} n=${urls.length}`); return { n: urls.length, stored: 0, over: true }; }
  const r = { n: urls.length, stored: 0, had: 0, failed: 0, over: 0, bytes: 0, sized: 0 }; let next = 0; const queue = [];
  // Each picture's size is kept with it. One kept before sizes existed (a sender's logo in every newsletter) is measured
  // from the head of its stored copy the next time it comes by; `sized` stays null if the lookup fails, and then nothing is re-read.
  const dims = []; let sized = null;
  try { const hks = urls.map(urlHash); sized = new Map(((await env.DB.prepare(`SELECT hk, w, h FROM img_dims WHERE hk IN (${hks.map(() => "?").join(", ")})`).bind(...hks).all()).results || []).map((x) => [x.hk, x])); } catch (_) {}
  const db = env.DB, fail = (href, o2) => { r.failed++; queue.push(imgQueueFailed(db, href, o2)); };
  // Every picture's measured size, by URL, with this mail as its sighting: what the learner reads.
  const obs = [], seenAs = (href, s) => { if (s && s.w > 0) obs.push(trkObsRow(db, href, s.w, s.h, dom, tag)); };
  const one = async (href) => {
    const key = await imgKey(href);
    if (await imgHeld(env, key)) {
      r.had++; queue.push(imgQueueDone(db, href), imgTouchRow(db, key));
      if (sized && !sized.has(urlHash(href))) { const o2 = await env.STORE.get(key, { range: { offset: 0, length: 65536 } }).catch(() => null); const head = o2 && (await o2.arrayBuffer().catch(() => null)); const row = head && imgDimsRow(env.DB, href, head); if (row) dims.push(row); if (head) seenAs(href, imgSize(new Uint8Array(head))); }
      else if (sized) seenAs(href, sized.get(urlHash(href)));
      return;
    }
    if (left.images <= 0 || left.bytes <= 0 || mine.images <= 0 || mine.bytes <= 0) { r.over++; queue.push(imgQueueLater(db, href, "over", IMG_OVER_WAIT_MS)); return; }
    // What /api/img itself refuses (a named tracker, a bad or private host) is never fetched at an open either: no row is needed.
    let u; try { u = new URL(href); } catch (_) { r.failed++; queue.push(imgQueueDone(db, href)); return; }
    if (!/^https?:$/.test(u.protocol) || spyTrackerName(u.href) || badHost(u.hostname) || (await resolvesPrivate(u.hostname))) { r.failed++; queue.push(imgQueueDone(db, href)); return; }
    const got = await fetchImageSafely(u, PREFETCH_IMG_MAX); if (!got.ok) return fail(href, { big: got.msg === "too large", permanent: got.status === 415, note: got.msg });
    const buf = await new Response(got.body).arrayBuffer().catch(() => null); if (!buf) return fail(href, { big: true, note: "stream over the arrival cap or cut" });
    if (r.bytes + buf.byteLength > PREFETCH_MAX_BYTES) { r.failed++; queue.push(imgQueueLater(db, href, "new", 0)); return; }   // the mail's own byte cap: the cron keeps it
    if (left.images <= 0 || buf.byteLength > left.bytes || mine.images <= 0 || buf.byteLength > mine.bytes) { r.over++; queue.push(imgQueueOver(db, href, buf.byteLength)); return; }
    left.images--; left.bytes -= buf.byteLength; mine.images--; mine.bytes -= buf.byteLength; r.bytes += buf.byteLength;
    await env.STORE.put(key, buf, { httpMetadata: { contentType: got.ct }, customMetadata: { at: now(), via: "arrival" } }); r.stored++; queue.push(imgQueueDone(db, href));
    const row = imgDimsRow(env.DB, href, buf); if (row) dims.push(row); seenAs(href, imgSize(new Uint8Array(buf)));
    queue.push(...imgKeptRows(env.DB, key, buf, got.ct, org));   // not in dims: r.sized counts measured pictures
  };
  const lane = async () => { while (next < urls.length && Date.now() < until) { const href = urls[next++]; await one(href).catch((e) => fail(href, { note: "error " + String(e?.message || e) })); } };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, lane));
  for (const href of urls.slice(next)) queue.push(imgQueueLater(db, href, "new", 0));   // cut off by the deadline: the cron takes them next
  if (dims.length) { try { await env.DB.batch(dims); r.sized = dims.length; } catch (_) {} }
  if (obs.length) { try { await env.DB.batch(obs); } catch (_) {} }
  if (queue.length) { try { await env.DB.batch(queue); } catch (_) {} }   // lost: the rows stay as written ahead, and the cron takes them once the fetch window has passed
  r.ms = Date.now() - t0; r.skipped = urls.length - r.stored - r.had - r.failed - r.over;
  try { await logEvent(env.DB, "img_prefetch", null, `${tag} from=${org} n=${r.n} stored=${r.stored} had=${r.had} failed=${r.failed} over=${r.over} skipped=${r.skipped} sized=${r.sized} bytes=${r.bytes} ms=${r.ms}`); } catch (_) {}
  return r;
}
// The minute cron's turn at the picture queue: the rows that are due and not being fetched by an arrival, a dozen at most, two at a
// time, each at the open cap and within the day's allowance and its sender's share. What it keeps is logged as img_prefetch events like
// an arrival's, one per sending organisation (from=…) and one for the rest, so the allowance and each share count it exactly once; it
// had counted only the allowance, and one sender's queued pictures took all 250 MB. Nothing here is
// started by an open, so nothing it asks of a sender says when a mail was read.
// A picture that catches up old mail (fill) comes after every picture new mail is waiting for, and keeps half of the day
// and half of its sender's share for new mail: a backfill on 2026-11-24 spent google.com's whole share in four minutes, and the next
// morning's mail from Google had 8 of its 21 pictures withheld until that spending was 24 hours old.
const IMG_FILL_KEEP = { images: PREFETCH_DAY_IMAGES / 2, bytes: PREFETCH_DAY_BYTES / 2 }, IMG_FILL_KEEP_DOM = { images: PREFETCH_DOMAIN_IMAGES / 2, bytes: PREFETCH_DOMAIN_BYTES / 2 };
export async function drainImgQueue(env, { max = 12, budgetMs = 15_000 } = {}) {
  const db = env.DB, t0 = Date.now(), at = now(); let rows;
  try { rows = (await db.prepare("SELECT hk, url, dom, fill, size FROM img_queue WHERE state = 'pending' AND next_at <= ? AND (fetching_until IS NULL OR fetching_until < ?) ORDER BY fill, next_at LIMIT ?").bind(at, at, max).all()).results || []; } catch (_) { return { n: 0 }; }
  if (!rows.length) return { n: 0 };
  await trkLoad(env).catch(() => {});
  const left = await prefetchAllowance(env), r = { n: rows.length, stored: 0, had: 0, failed: 0, over: 0, dropped: 0, bytes: 0 }, writes = []; let next = 0;
  const shares = new Map(), kept = new Map();   // each organisation's share left today, read once a run; what was kept for it
  const shareOf = (org) => { if (!shares.has(org)) shares.set(org, prefetchDomainLeft(env, org)); return shares.get(org); };
  const one = async ({ url: href, dom: org, fill, size }) => {
    const key = await imgKey(href);
    if (await imgHeld(env, key)) { r.had++; writes.push(imgQueueDone(db, href), imgTouchRow(db, key)); return; }
    const mine = org ? await shareOf(org) : null;
    const kd = fill ? IMG_FILL_KEEP : { images: 0, bytes: 0 }, km = fill ? IMG_FILL_KEEP_DOM : { images: 0, bytes: 0 };   // what this picture must leave
    if (left.images <= kd.images || left.bytes <= kd.bytes || (mine && (mine.images <= km.images || mine.bytes <= km.bytes))) { r.over++; writes.push(imgQueueLater(db, href, "over", IMG_OVER_WAIT_MS)); return; }
    // known not to fit what is left: not fetched to find out again
    if (size > 0 && (size > left.bytes - kd.bytes || (mine && size > mine.bytes - km.bytes))) { r.over++; writes.push(imgQueueOver(db, href, size)); return; }
    let u; try { u = new URL(href); } catch (_) { u = null; }
    // a list or a learned pattern may have come to block it since its mail arrived
    const v = u && trkVerdict(u.href, null); if (v) { r.dropped++; writes.push(imgQueueDone(db, href), trkVerdictRow(db, { href: u.href, ...v })); return; }
    if (!u || !/^https?:$/.test(u.protocol) || spyTrackerName(u.href) || badHost(u.hostname) || (await resolvesPrivate(u.hostname))) { r.dropped++; writes.push(imgQueueDone(db, href)); return; }
    const got = await fetchImageSafely(u, IMG_MAX);
    if (!got.ok) { r.failed++; writes.push(imgQueueFailed(db, href, { permanent: got.status === 415 || got.status === 413, note: got.msg })); return; }
    const buf = await new Response(got.body).arrayBuffer().catch(() => null);
    if (!buf) { r.failed++; writes.push(imgQueueFailed(db, href, { note: "stream over the open cap or cut" })); return; }
    if (left.images <= kd.images || buf.byteLength > left.bytes - kd.bytes || (mine && (mine.images <= km.images || buf.byteLength > mine.bytes - km.bytes))) { r.over++; writes.push(imgQueueOver(db, href, buf.byteLength)); return; }
    left.images--; left.bytes -= buf.byteLength; if (mine) { mine.images--; mine.bytes -= buf.byteLength; }
    await env.STORE.put(key, buf, { httpMetadata: { contentType: got.ct }, customMetadata: { at: now(), via: "queue" } }); r.stored++; r.bytes += buf.byteLength; writes.push(imgQueueDone(db, href));
    if (mine) { const k = kept.get(org) || { stored: 0, bytes: 0 }; k.stored++; k.bytes += buf.byteLength; kept.set(org, k); }   // counted once stored
    const d = imgDimsRow(db, href, buf); if (d) writes.push(d);
    const s = imgSize(new Uint8Array(buf)); if (s) writes.push(trkObsRow(db, href, s.w, s.h, null, null));   // a size, no new sighting
    writes.push(...imgKeptRows(db, key, buf, got.ct, org));
  };
  const lane = async () => { while (next < rows.length && Date.now() - t0 < budgetMs) { const row = rows[next++]; await one(row).catch((e) => { r.failed++; writes.push(imgQueueFailed(db, row.url, { note: "error " + String(e?.message || e) })); }); } };
  await Promise.all([lane(), lane()]);
  if (writes.length) { try { await db.batch(writes); } catch (_) {} }
  r.ms = Date.now() - t0;
  let own = { stored: 0, bytes: 0 };
  for (const [org, k] of kept) { own.stored += k.stored; own.bytes += k.bytes; try { await logEvent(db, "img_prefetch", null, `queue from=${org} stored=${k.stored} bytes=${k.bytes}`); } catch (_) {} }
  try { await logEvent(db, "img_prefetch", null, `queue n=${r.n} stored=${r.stored - own.stored} had=${r.had} failed=${r.failed} over=${r.over} dropped=${r.dropped} bytes=${r.bytes - own.bytes} ms=${r.ms}${own.stored ? ` (+${own.stored} by sender)` : ""}`); } catch (_) {}
  return r;
}
// Daily: a row still waiting after a week is given up; a given-up row goes after 90 days, when the img/ prefix's own lifecycle has
// removed whatever its mail's other pictures were, and an open of that mail would fetch them again anyway.
export async function pruneImgQueue(env) {
  try { await env.DB.batch([env.DB.prepare("UPDATE img_queue SET state = 'dead', note = COALESCE(note, '') || ' (a week waiting)' WHERE state = 'pending' AND at < ?").bind(isoIn(-7 * 86400e3)), env.DB.prepare("DELETE FROM img_queue WHERE state = 'dead' AND at < ?").bind(isoIn(-90 * 86400e3))]); } catch (_) {}
}
// Daily: a kept picture is kept 90 days from the last time it was shown, or from when it was stored if it never was; the
// rest goes, original, sizes and rows. Opening its mail after that fetches it again, shrinks it and keeps it (re-download on revisit
// ). Pictures stored before img_seen existed are given a row first, dated by their upload, from the bucket listing,
// up to 20 pages of 1,000 a day until every one has one (the cursor in prefs, server-only); the R2 lifecycle rule that deleted every
// img/ object 90 days after its upload, shown or not, is removed once the listing is done.
const IMG_KEEP_MS = 90 * 86400e3;
const IMG_OPEN_SINCE = Date.parse("2026-11-08T00:00:00Z");   // every mail received since has its pictures' rows (live 2026-11-07)
export async function sweepImgs(env, { max = 3000, pages = 20 } = {}) {
  const db = env.DB, r = { listed: 0, backfilled: 0, swept: 0, listing: "done" };
  const at = await db.prepare("SELECT value FROM prefs WHERE key = 'imgsweep:cursor'").first().catch(() => null);
  let cursor = at ? JSON.parse(at.value) : "";
  if (cursor !== "done") {
    for (let p = 0; p < pages; p++) {
      const page = await env.STORE.list({ prefix: "img/", limit: 1000, ...(cursor ? { cursor } : {}) });
      const rows = (page.objects || []).filter((o) => /^img\/[0-9a-f]{64}$/.test(o.key)).map((o) => db.prepare("INSERT INTO img_seen (sha, stored_at) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING").bind(o.key.slice(4), new Date(o.uploaded).toISOString()));
      for (let i = 0; i < rows.length; i += 500) await db.batch(rows.slice(i, i + 500));   // a batch is one query against the 1,000 a run may make
      r.listed += (page.objects || []).length; r.backfilled += rows.length;
      cursor = page.truncated ? page.cursor : "done"; if (cursor === "done") break;
    }
    await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('imgsweep:cursor', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(cursor), now()).run();
    r.listing = cursor === "done" ? "done" : "continues";
  }
  const cutoff = new Date(Date.now() - IMG_KEEP_MS).toISOString();
  const old = (await db.prepare("SELECT sha FROM img_seen WHERE COALESCE(seen_at, stored_at) < ? LIMIT ?").bind(cutoff, max).all()).results || [];
  // The rows go first, each only if it is still past the cutoff (a picture shown or stored again since the select keeps everything), and
  // only what was deleted leaves R2.
  for (let i = 0; i < old.length; i += 300) {
    const res = await db.batch(old.slice(i, i + 300).map((x) => db.prepare("DELETE FROM img_seen WHERE sha = ? AND COALESCE(seen_at, stored_at) < ? RETURNING sha").bind(x.sha, cutoff)));
    const shas = res.flatMap((x) => (x.results || []).map((y) => y.sha)); if (!shas.length) continue;
    await db.batch(shas.map((h) => db.prepare("DELETE FROM img_work WHERE key = ?").bind("img/" + h)));
    await env.STORE.delete(shas.flatMap((h) => [`img/${h}`, ...IMG_WIDTHS.map((w) => `imgv/${h}-${w}`)]));
    r.swept += shas.length;
  }
  await logEvent(db, "img_sweep", null, `listed=${r.listed} backfilled=${r.backfilled} swept=${r.swept} listing=${r.listing}`).catch(() => {});
  return r;
}
// ---------- spy trackers and email ads beyond the named list (migration 0050) ----------
// Three sources, all data, none needing a code change per tracker; a picture they block is never fetched, and the apps hide it too:
//  1. Maintained lists, EasyList (ads) and EasyPrivacy (trackers), fetched by the cron each day (each says it expires in 4 days) and
//  kept in R2 as fetched. A rule that would block any picture of a frozen, labelled set of real pictures and spacers from this
//  mailbox (R2 trk/corpus.jsonl) is refused; a version that would block fewer of that set's trackers and ads than the one in use is
//  refused whole, and the one in use stays.
//  2. Two rules from MailTrackerBlocker (BSD-3-Clause, hub/NOTICE.md): Jeeng's sponsored stripes and Sailthru's open pixel on a
//  sender's own domain, both missed by the lists.
//  3. Patterns learned from arriving mail. The arrival prefetch measures every picture it fetches. A pattern (host and up to 4 path
//  segments, token-like ones as *, an 8-hex first host label as *) that served 2 or more different pictures of at most 2x2 pixels,
//  in 2 or more different mails, none of them in two mails and no bigger picture ever, is a tracker. A pixel's URL is new in every
//  mail; a spacer's repeats, and a sender's picture host also serves real pictures. For the first 14 days the learner only watches
//  (it records, and blocks nothing); if no watched pattern is contradicted in that time it starts blocking by itself.
// A learned pattern corrects itself. A picture under it that declares a real box (10 px or more each way) is let through once and
// measured; a daily sample of what it blocked is fetched and measured (each day for its first 14 days, then weekly, 16 a day at most);
// either finding a real picture turns the pattern off and fetches what it blocked. A user's Undo (Settings > Trackers & ads) is a
// veto that wins over all three sources. Measured on 15 days of this mailbox (3,731 pictures): lists and learner together blocked
// 93 of 93 tracker pixels and all 125 LiveIntent pictures, and none of 3,497 real pictures or 16 spacers (the learner's half in-sample).
const TRK_LISTS = [
  { key: "easylist", name: "EasyList", cls: "ad", url: "https://easylist.to/easylist/easylist.txt" },
  { key: "easyprivacy", name: "EasyPrivacy", cls: "tracker", url: "https://easylist.to/easylist/easyprivacy.txt" },
];
const TRK_VENDORED = [
  { name: "Jeeng", cls: "ad", rule: "vendored:jeeng", test: (u) => u.includes("/stripe/image?cs_") },
  { name: "Sailthru", cls: "tracker", rule: "vendored:sailthru", test: (u) => /\/img\/[a-z0-9_.]+\/[a-z0-9_]{8}\.gif/.test(u) },
];
const TRK_WATCH_MS = 14 * 86400e3, TRK_KEEP_MS = 60 * 86400e3, TRK_CANARIES = 16;
// --- filter lists, as text, never as regular expressions ---
// A rule is literal segments joined by `*`, with `^` as the separator class (Adblock Plus syntax), matched leftmost-first, so a URL
// costs O(URL x rule) whatever it contains: a 2,048-character hostile URL takes under 2 ms against both lists.
// /regex/ rules, rules tied to a page (domain=), and rules for other request types are left out: a mail is not a web page.
const ABP_SKIP = new Set(["popup", "csp", "removeparam", "redirect", "redirect-rule", "document", "doc", "elemhide", "ehide", "generichide", "ghide",
  "specifichide", "shide", "first-party", "1p", "~third-party", "~3p", "rewrite", "header", "permissions", "urltransform", "replace", "badfilter", "match-case"]);
const ABP_TYPES = new Set(["script", "image", "stylesheet", "css", "object", "xmlhttprequest", "xhr", "subdocument", "frame", "ping", "websocket", "webrtc",
  "font", "media", "other", "beacon", "popup", "document", "doc"]);
function abpRule(line) {
  let l = line.trim();
  if (!l || l[0] === "!" || l[0] === "[" || /#[@?$%]?#|#\+js\(/.test(l)) return null;
  const allow = l.startsWith("@@"); if (allow) l = l.slice(2);
  if (l.startsWith("/") && /\/(\$[^/]*)?$/.test(l) && l.length > 2) return null;
  let opts = ""; const d = l.lastIndexOf("$");
  if (d > 0 && !/[/^*|]$/.test(l.slice(d + 1, d + 2)) && /^[\w~,=.|*-]+$/.test(l.slice(d + 1))) { opts = l.slice(d + 1); l = l.slice(0, d); }
  const o = opts ? opts.toLowerCase().split(",") : [];
  if (o.some((x) => ABP_SKIP.has(x.split("=")[0]))) return null;
  if (o.some((x) => x.startsWith("domain=") || x.startsWith("from=") || x.startsWith("to="))) return null;
  const types = o.filter((x) => ABP_TYPES.has(x.replace(/^~/, "")));
  if (types.some((x) => !x.startsWith("~")) && !types.includes("image")) return null;
  if (types.includes("~image")) return null;
  let start = "", end = false;
  if (l.startsWith("||")) { start = "host"; l = l.slice(2); } else if (l.startsWith("|")) { start = "url"; l = l.slice(1); }
  if (l.endsWith("|")) { end = true; l = l.slice(0, -1); }
  l = l.toLowerCase().replace(/\*+/g, "*");
  if (l.startsWith("*")) { l = l.slice(1); if (start === "host") start = ""; }
  if (l.endsWith("*")) l = l.slice(0, -1);
  if (!l || l.replace(/[*^]/g, "").length < 3) return null;
  const segs = l.split("*");
  return { allow, start, end, segs, host: start === "host" ? (/^[a-z0-9.-]+/.exec(segs[0]) || [""])[0] : "" };
}
const abpSep = (c) => !(c >= "a" && c <= "z") && !(c >= "0" && c <= "9") && c !== "_" && c !== "-" && c !== "." && c !== "%";
function abpSegAt(u, p, s) {   // the end of segment s matched at p in u, or -1; `^` is one separator character, or the end of u
  let i = p;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "^") { if (i === u.length) return k === s.length - 1 ? i : -1; if (!abpSep(u[i])) return -1; i++; continue; }
    if (u[i] !== s[k]) return -1; i++;
  }
  return i;
}
function abpSegFind(u, from, s) {
  const lit = s.replace(/\^.*$/, "");
  for (let p = lit ? u.indexOf(lit, from) : from; p !== -1 && p <= u.length; p = lit ? u.indexOf(lit, p + 1) : p + 1) {
    const e = abpSegAt(u, p, s); if (e >= 0) return e;
    if (!lit && p >= u.length) break;
  }
  return -1;
}
function abpMatch(r, u, hs, he) {   // u lowercased; its host runs from hs to he
  let pos = -1;
  if (r.start === "host") { for (let p = hs; p < he; p++) { if (p !== hs && u[p - 1] !== ".") continue; const e = abpSegAt(u, p, r.segs[0]); if (e >= 0) { pos = e; break; } } }
  else if (r.start === "url") pos = abpSegAt(u, 0, r.segs[0]);
  else pos = abpSegFind(u, 0, r.segs[0]);
  if (pos < 0) return false;
  for (let k = 1; k < r.segs.length; k++) {
    const s = r.segs[k];
    if (r.end && k === r.segs.length - 1) { const p = u.length - s.replace(/\^$/, "").length; return p >= pos && abpSegAt(u, p, s) === u.length; }
    pos = abpSegFind(u, pos, s); if (pos < 0) return false;
  }
  return r.end ? pos === u.length : true;
}
// A rule that is only `||host^` (most of EasyList: ad servers) is a host name in a Set: 96,000 rule objects were 85 MB, against a
// Worker's 128 MB; as names, both lists compile to 14 MB in about 55 ms.
const abpHostOnly = (r) => r.start === "host" && !r.end && r.segs.length === 1 && /^[a-z0-9.-]+\^?$/.test(r.segs[0]) && r.host.includes(".");
export function abpCompile(text) {
  const mk = () => ({ hosts: new Set(), byHost: new Map(), rest: [] }); const block = mk(), allow = mk(); let n = 0;
  for (const line of String(text).split("\n")) {
    const r = abpRule(line); if (!r) continue;
    n++; const t = r.allow ? allow : block;
    if (abpHostOnly(r)) { t.hosts.add(r.host); continue; }
    if (r.host && r.host.includes(".")) { const a = t.byHost.get(r.host) || []; a.push(r); t.byHost.set(r.host, a); }
    else { r.lit = r.segs.flatMap((s) => s.split("^")).sort((a, b) => b.length - a.length)[0]; t.rest.push(r); }
  }
  return { block, allow, n };
}
const abpText = (r) => (r.start === "host" ? "||" : r.start === "url" ? "|" : "") + r.segs.join("*") + (r.end ? "|" : "");
function abpFirst(t, u, host, hs, he) {
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) { const h = parts.slice(i).join("."); if (t.hosts.has(h)) return "||" + h + "^"; }
  for (let i = 0; i < parts.length - 1; i++) { const a = t.byHost.get(parts.slice(i).join(".")); if (a) for (const r of a) if (abpMatch(r, u, hs, he)) return abpText(r); }
  for (const r of t.rest) if (u.includes(r.lit) && abpMatch(r, u, hs, he)) return abpText(r);
  return null;
}
// The rule (as text) that blocks this URL, or null.
export function abpVerdict(ix, url) {
  let x; try { x = new URL(url); } catch (_) { return null; }
  const u = x.href.toLowerCase(), host = x.hostname.toLowerCase(), hs = u.indexOf("//") + 2, he = hs + host.length;
  // No DNS name is longer than 253 characters, so such a picture can never load; walking the suffixes of an 80 KB host of 40,000 labels
  // took 8 s a list on every arriving mail, and four such pictures ran a whole Gmail batch past its CPU.
  if (host.length > 253) return null;
  const hit = abpFirst(ix.block, u, host, hs, he);
  return hit && !abpFirst(ix.allow, u, host, hs, he) ? hit : null;
}
function abpDrop(ix, texts) {   // the rules the corpus check refused, taken back out of a compiled list
  const gone = new Set(texts);
  for (const t of [ix.block, ix.allow]) {
    for (const x of gone) if (x.startsWith("||") && x.endsWith("^")) t.hosts.delete(x.slice(2, -1));
    for (const [k, a] of t.byHost) t.byHost.set(k, a.filter((r) => !gone.has(abpText(r))));
    t.rest = t.rest.filter((r) => !gone.has(abpText(r)));
  }
}
// --- learned patterns ---
const trkTokenish = (s) => s.length >= 16 || (/\d/.test(s) && /[a-z]/i.test(s) && s.length >= 8) || /^\d{5,}$/.test(s) || /^[A-Za-z0-9_-]{12,}$/.test(s);
export function trkPattern(href) {
  let x; try { x = new URL(href); } catch (_) { return ""; }
  return x.hostname.toLowerCase().replace(/^[0-9a-f]{8}\./, "*.") + "/" + x.pathname.split("/").filter(Boolean).slice(0, 4).map((s) => (trkTokenish(s) ? "*" : s)).join("/");
}
const trkName = (host, href = "") => (/^sli\./.test(host) && /\/imp\b/.test(href) ? "LiveIntent" : lockRoot(host));
// The hub's state: the compiled lists, the learned patterns and the vetoes, read again at most once a minute.
const TRK = { at: 0, lists: new Map(), learned: new Map(), veto: new Set(), learner: { mode: "watch", since: null }, loading: null };
async function trkLoad(env, { fresh = false } = {}) {
  if (!fresh && Date.now() - TRK.at < 60_000) return TRK;
  if (TRK.loading) return TRK.loading;
  TRK.loading = (async () => {
    try {
      const [meta, rules] = await Promise.all([env.DB.prepare("SELECT k, v FROM trk_meta").all(), env.DB.prepare("SELECT pattern, kind, state FROM trk_rules WHERE state IN ('watch', 'on', 'veto')").all()]);
      const m = new Map((meta.results || []).map((r) => [r.k, JSON.parse(r.v)]));
      TRK.learner = m.get("learner") || { mode: "watch", since: null };
      const learned = new Map(), veto = new Set();
      for (const r of rules.results || []) (r.kind === "veto" ? veto.add(r.pattern) : learned.set(r.pattern, r.state));
      TRK.learned = learned; TRK.veto = veto;
      for (const L of TRK_LISTS) {
        const lm = m.get("list:" + L.key); if (!lm) { TRK.lists.delete(L.key); continue; }
        if (TRK.lists.get(L.key)?.version === lm.version) continue;
        const obj = await env.STORE.get(lm.r2key).catch(() => null); if (!obj) continue;
        const ix = abpCompile(await obj.text()); abpDrop(ix, lm.dropped || []);
        TRK.lists.set(L.key, { version: lm.version, ix });
      }
      TRK.at = Date.now();
    } catch (e) { console.log("trackers: load failed", e?.message); TRK.at = Date.now() - 50_000; }   // tried again in about 10 s
    finally { TRK.loading = null; }
    return TRK;
  })();
  return TRK.loading;
}
// { name, cls, rule } for a picture the vetoes, learned patterns, vendored rules or lists block, or null. `box` is what its tag declares.
function trkVerdict(href, box) {
  let host; try { host = new URL(href).hostname; } catch (_) { return null; }
  if (host.length > 253) return null;   // no DNS name is longer: never fetched, and its pattern would be as long
  const pat = trkPattern(href); if (!pat || TRK.veto.has(pat)) return null;
  if (TRK.learned.get(pat) === "on" && !(box && box.w >= 10 && box.h >= 10)) return { name: trkName(host), cls: "tracker", rule: "learned:" + pat };
  const u = href.toLowerCase();
  for (const v of TRK_VENDORED) if (v.test(u)) return { name: v.name, cls: v.cls, rule: v.rule };
  for (const L of TRK_LISTS) { const l = TRK.lists.get(L.key), hit = l && abpVerdict(l.ix, href); if (hit) return { name: trkName(host, u), cls: L.cls, rule: L.key + ":" + hit }; }
  return null;
}
trackerVerdict = trkVerdict;   // the shared tracker block above asks it
export const trkForget = () => { TRK.at = 0; };   // test/trackers.mjs: read the tables again on the next call
// A block for the apps. A live row is left as it is (its seq, which the apps sync by, does not move); a new or withdrawn one is written
// with a new seq. gone = 1 withdraws it.
// A block as kept for the apps. The URL is kept to 2,048 characters, the longest the hub ever fetches: a list-blocked URL of 60 KB was kept
// whole, 200 a mail, and Settings, the report and Undo read thousands back. A longer one is kept as its
// first 2,049, so its length says it was cut; one of exactly 2,048 is whole and is fetched again when withdrawn.
//  `hk` is always the FULL URL's (what the apps look up), so a withdrawal passes the row's own hk; `pat` is its pattern (at most
// 512 characters: finding 5), which Undo looks up.
const TRK_URL_MAX = 2048;
const trkVerdictRow = (db, x, gone = 0) => {
  const hk = x.hk ?? urlHash(x.href), url = String(x.url ?? x.href).slice(0, TRK_URL_MAX + 1), pat = String(x.pat || trkPattern(x.href)).slice(0, 512);
  return gone
    ? db.prepare("INSERT OR REPLACE INTO trk_verdict (hk, url, name, cls, rule, gone, at, pat) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(hk, url, x.name, x.cls, x.rule, now(), pat)
    : db.prepare("INSERT OR REPLACE INTO trk_verdict (hk, url, name, cls, rule, gone, at, pat) SELECT ?, ?, ?, ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM trk_verdict WHERE hk = ? AND gone = 0)").bind(hk, url, x.name, x.cls, x.rule, now(), pat, hk);
};
// A withdrawn block's picture is queued for the cron, unless its URL was cut (no picture is fetched past 2,048 characters). It spends the
// share of "+requeue", one shared by every withdrawal: a sender who can turn a learned pattern off must not get its pictures fetched past
// its own share. No From maps to it: an organisation is [a-z0-9.-].
const trkRequeue = (db, x) => (String(x.url).length <= TRK_URL_MAX ? [imgQueueAhead(db, x.url, null, "+requeue")] : []);
// Every live block under a pattern, withdrawn in batches of 200 until none is left (at most 10,000 a call): a withdrawal that stopped at
// 500 left the rest live in the apps after the pattern was vetoed or turned off.
async function trkWithdraw(db, where, ...bind) {
  let n = 0;
  for (let i = 0; i < 50; i++) {
    const rows = (await db.prepare(`SELECT hk, url, name, cls, rule, pat FROM trk_verdict WHERE gone = 0 AND ${where} LIMIT 200`).bind(...bind).all()).results || [];
    if (!rows.length) break;
    await db.batch(rows.flatMap((x) => [trkVerdictRow(db, { href: x.url, ...x }, 1), ...trkRequeue(db, x)]));
    n += rows.length; if (rows.length < 200) break;
  }
  return n;
}
// One sighting of a measured picture. `tag` names the mail; a sighting in another mail adds one to `mails`, the same mail twice does
// not, and a size with no mail (the queue) adds none.
const trkObsRow = (db, href, w, h, sender, tag) => db.prepare("INSERT INTO trk_obs (hk, url, pattern, w, h, sender, first_tag, last_tag, mails, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(hk) DO UPDATE SET mails = trk_obs.mails + (CASE WHEN excluded.last_tag IS NULL OR trk_obs.last_tag IS excluded.last_tag THEN 0 ELSE 1 END), last_tag = COALESCE(excluded.last_tag, trk_obs.last_tag), last_at = excluded.last_at, w = excluded.w, h = excluded.h")
  .bind(urlHash(href), href, trkPattern(href), w, h, sender || null, tag || null, tag || null, now(), now());
async function trkMetaGet(db, k) { try { const r = await db.prepare("SELECT v FROM trk_meta WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null; } catch (_) { return null; } }
const trkMetaSet = (db, k, v) => db.prepare("INSERT OR REPLACE INTO trk_meta (k, v, at) VALUES (?, ?, ?)").bind(k, JSON.stringify(v), now());
// Turns a learned pattern off: its blocks are withdrawn from the apps and its pictures queued for the cron to fetch.
async function trkTurnOff(env, pattern, note) {
  const db = env.DB;
  await db.prepare("UPDATE trk_rules SET state = 'off', note = ?, changed_at = ? WHERE pattern = ? AND kind = 'learned'").bind(String(note).slice(0, 200), now(), pattern).run();
  const n = await trkWithdraw(db, "rule = ?", "learned:" + pattern);
  TRK.at = 0;
  await logEvent(db, "trk_rule_off", null, `${pattern} ${note} withdrawn=${n}`);
}
// The user's Undo: a veto on the pattern. Every block under it is withdrawn and its pictures fetched; a learned row becomes the veto.
export async function trkVeto(env, pattern) {
  const db = env.DB, t = now();
  // By the pattern each row keeps.
  await db.prepare("INSERT OR REPLACE INTO trk_rules (pattern, kind, state, note, created_at, changed_at) VALUES (?, 'veto', 'veto', 'undone in Settings', ?, ?)").bind(pattern, t, t).run();
  const n = await trkWithdraw(db, "pat = ?", pattern);
  TRK.at = 0;
  await logEvent(db, "trk_veto", null, `${pattern} withdrawn=${n}`);
  return n;
}
// The learner, hourly: patterns that meet the rule are added (watched, or blocking once the learner is on); a watched one that is
// contradicted becomes `wrong` for good; a blocking one that is contradicted (by a picture let through by its box, or a sample) goes off.
export async function trkLearn(env) {
  const db = env.DB, t = now();
  let learner = await trkMetaGet(db, "learner");
  if (!learner) { learner = { mode: "watch", since: t }; await trkMetaSet(db, "learner", learner).run(); }
  const rows = (await db.prepare("SELECT pattern, SUM(CASE WHEN w <= 2 AND h <= 2 THEN 1 ELSE 0 END) AS tiny, SUM(CASE WHEN w > 2 OR h > 2 THEN 1 ELSE 0 END) AS big, SUM(CASE WHEN w <= 2 AND h <= 2 AND mails >= 2 THEN 1 ELSE 0 END) AS reused, COUNT(DISTINCT CASE WHEN w <= 2 AND h <= 2 THEN first_tag END) AS tmails, MAX(sender) AS sender FROM trk_obs WHERE w > 0 AND last_at > ? GROUP BY pattern HAVING tiny >= 1").bind(isoIn(-TRK_KEEP_MS)).all()).results || [];
  const have = new Map(((await db.prepare("SELECT pattern, kind, state FROM trk_rules").all()).results || []).map((r) => [r.pattern, r]));
  const writes = [], off = [], out = { added: 0, wrong: 0, off: 0 };
  for (const r of rows) {
    const ok = r.tiny >= 2 && r.big === 0 && r.reused === 0 && r.tmails >= 2, bad = r.big > 0 || r.reused > 0, h = have.get(r.pattern);
    if (!h) {
      if (!ok) continue;
      const on = learner.mode === "on"; out.added++;
      writes.push(db.prepare("INSERT INTO trk_rules (pattern, kind, state, tiny, mails, sender, created_at, changed_at, on_at) VALUES (?, 'learned', ?, ?, ?, ?, ?, ?, ?)").bind(r.pattern, on ? "on" : "watch", r.tiny, r.tmails, r.sender, t, t, on ? t : null));
      continue;
    }
    if (h.kind !== "learned" || h.state === "wrong" || h.state === "off") continue;
    if (bad && h.state === "watch") { out.wrong++; writes.push(db.prepare("UPDATE trk_rules SET state = 'wrong', note = ?, changed_at = ? WHERE pattern = ?").bind(`contradicted while watched: ${r.big} bigger, ${r.reused} in two mails`, t, r.pattern)); }
    else if (bad && h.state === "on") off.push([r.pattern, `a bigger picture (${r.big}) or one in two mails (${r.reused})`]);
    else writes.push(db.prepare("UPDATE trk_rules SET tiny = ?, mails = ? WHERE pattern = ?").bind(r.tiny, r.tmails, r.pattern));
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  for (const [p, note] of off) { out.off++; await trkTurnOff(env, p, note); }
  // The watch: 14 days with no watched pattern contradicted, and learning starts blocking by itself; a contradiction restarts it.
  if (learner.mode === "watch" && Date.now() - Date.parse(learner.since) >= TRK_WATCH_MS) {
    const wrong = (await db.prepare("SELECT COUNT(*) n FROM trk_rules WHERE kind = 'learned' AND state = 'wrong' AND changed_at >= ?").bind(learner.since).first()).n;
    if (!wrong) { await db.batch([trkMetaSet(db, "learner", { mode: "on", since: t, watched_from: learner.since }), db.prepare("UPDATE trk_rules SET state = 'on', on_at = ?, changed_at = ? WHERE kind = 'learned' AND state = 'watch'").bind(t, t)]); out.on = true; await logEvent(db, "trk_learner_on", null, `watched from ${learner.since}`); }
    else { await trkMetaSet(db, "learner", { mode: "watch", since: t, again: (learner.again || 0) + 1, last_wrong: wrong }).run(); out.again = wrong; await logEvent(db, "trk_learner_watch_again", null, `${wrong} contradicted`); }
  }
  if (writes.length || off.length || out.on || out.again) TRK.at = 0;
  return out;
}
// What a picture measures, read from the first 64 KB of it; a picture that declares more than the open cap is not a pixel.
async function trkMeasure(href) {
  let u; try { u = new URL(href); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol) || badHost(u.hostname) || (await resolvesPrivate(u.hostname))) return null;
  const got = await fetchImageSafely(u, IMG_MAX);
  if (!got.ok) return got.status === 413 ? { w: 9999, h: 9999 } : null;
  const reader = got.body.getReader(); let head = new Uint8Array(0);
  try {
    while (head.byteLength < 65536) { const { value, done } = await reader.read(); if (done) break; const m = new Uint8Array(head.byteLength + value.byteLength); m.set(head, 0); m.set(value, head.byteLength); head = m; const s = imgSize(head); if (s) return s; }
  } catch (_) { return null; } finally { try { await reader.cancel(); } catch (_) {} }
  return imgSize(head);
}
// The daily samples: one picture a blocking pattern blocked, fetched by the cron (never by an open) and measured.
export async function trkCanaries(env, { max = TRK_CANARIES } = {}) {
  const db = env.DB, t = Date.now(), out = { looked: 0, off: 0 };
  const rules = ((await db.prepare("SELECT pattern, on_at, canary_at FROM trk_rules WHERE kind = 'learned' AND state = 'on'").all()).results || [])
    .filter((r) => { const last = r.canary_at ? t - Date.parse(r.canary_at) : Infinity; return t - Date.parse(r.on_at || 0) < TRK_WATCH_MS ? last >= 20 * 3600e3 : last >= 7 * 86400e3; }).slice(0, max);
  for (const r of rules) {
    await db.prepare("UPDATE trk_rules SET canary_at = ? WHERE pattern = ?").bind(now(), r.pattern).run();
    const v = await db.prepare("SELECT url FROM trk_verdict WHERE rule = ? AND gone = 0 ORDER BY seq DESC LIMIT 1").bind("learned:" + r.pattern).first();
    if (!v) continue;
    out.looked++; const s = await trkMeasure(v.url);
    if (s && (s.w > 2 || s.h > 2)) { await trkObsRow(db, v.url, s.w, s.h, null, null).run(); out.off++; await trkTurnOff(env, r.pattern, `a sample measured ${s.w}x${s.h}`); }
  }
  return out;
}
// The frozen check set: one JSON line per picture, { u, k } with k "real", "spacer", "tracker" or "ad".
async function trkCorpus(env) {
  const o = await env.STORE.get("trk/corpus.jsonl").catch(() => null); if (!o) return [];
  return (await o.text()).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((x) => x && x.u && x.k);
}
// Each list, fetched when it changed, checked against the corpus, and kept in R2 for every Worker to compile.
export async function trkRefreshLists(env, { force = false } = {}) {
  const db = env.DB, out = []; let corpus = null;
  for (const L of TRK_LISTS) {
    const prev = await trkMetaGet(db, "list:" + L.key);
    try {
      const headers = { "user-agent": "Mozilla/5.0 (compatible; mailhub list refresh)" };
      if (!force && prev?.etag) headers["if-none-match"] = prev.etag;
      if (!force && prev?.lastmod) headers["if-modified-since"] = prev.lastmod;
      const res = await fetch(L.url, { headers });
      if (res.status === 304) { out.push(`${L.name} ${prev?.version || "?"}: unchanged`); continue; }
      if (!res.ok) { out.push(`${L.name}: HTTP ${res.status}, kept ${prev?.version || "none"}`); continue; }
      const text = await res.text();
      if (text.length > 12e6 || !/^\[Adblock Plus/.test(text)) { out.push(`${L.name}: not a filter list, kept ${prev?.version || "none"}`); continue; }
      const version = (/^! Version: *(\S+)/m.exec(text) || [])[1] || t2v(now());
      if (!force && prev?.version === version) { await trkMetaSet(db, "list:" + L.key, { ...prev, etag: res.headers.get("etag") || "", lastmod: res.headers.get("last-modified") || "", at: now() }).run(); out.push(`${L.name} ${version}: unchanged`); continue; }
      corpus ||= await trkCorpus(env);
      const ix = abpCompile(text), dropped = [];
      for (const c of corpus) if (c.k === "real" || c.k === "spacer") for (let i = 0; i < 20; i++) { const hit = abpVerdict(ix, c.u); if (!hit) break; dropped.push(hit); abpDrop(ix, [hit]); }
      const should = corpus.filter((c) => c.k === "tracker" || c.k === "ad"), blocked = should.filter((c) => abpVerdict(ix, c.u)).length;
      if (prev && corpus.length && blocked < (prev.blocked || 0)) { out.push(`${L.name} ${version}: REFUSED, blocks ${blocked} of the check set's ${should.length} trackers and ads against ${prev.blocked}; kept ${prev.version}`); await logEvent(db, "trk_list_refused", null, out[out.length - 1]); continue; }
      const r2key = `trk/lists/${L.key}/${version}.txt`;
      await env.STORE.put(r2key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      await trkMetaSet(db, "list:" + L.key, { version, r2key, etag: res.headers.get("etag") || "", lastmod: res.headers.get("last-modified") || "", rules: ix.n, dropped: [...new Set(dropped)], blocked, of: should.length, checked: corpus.length, at: now() }).run();
      if (prev?.r2key && prev.r2key !== r2key) await env.STORE.delete(prev.r2key).catch(() => {});
      out.push(`${L.name} ${version}: ${ix.n} rules, ${new Set(dropped).size} refused by the check, blocks ${blocked} of ${should.length}${corpus.length ? "" : " (NO CHECK SET: unchecked)"}`);
    } catch (e) { out.push(`${L.name}: ${String(e?.message || e).slice(0, 120)}, kept ${prev?.version || "none"}`); }
  }
  TRK.at = 0;
  await logEvent(db, "trk_lists", null, out.join("; "));
  return out;
}
const t2v = (iso) => iso.replace(/\D/g, "").slice(0, 12);
export async function trkPrune(env) {
  // A watched or blocking pattern whose sightings have all aged out goes too: every one of them is read into every isolate each minute,
  // and a sender could add ~500 a day that were never deleted.
  //  One seen again is learned again by the same rule. Off, wrong and veto rows are kept.
  try { await env.DB.batch([env.DB.prepare("DELETE FROM trk_obs WHERE last_at < ?").bind(isoIn(-TRK_KEEP_MS)), env.DB.prepare("DELETE FROM trk_verdict WHERE at < ?").bind(isoIn(-TRK_KEEP_MS)),
    env.DB.prepare("DELETE FROM trk_rules WHERE kind = 'learned' AND state IN ('watch', 'on') AND created_at < ? AND NOT EXISTS (SELECT 1 FROM trk_obs o WHERE o.pattern = trk_rules.pattern)").bind(isoIn(-TRK_KEEP_MS))]); } catch (_) {}
}
// For Settings and the daily report.
// Its reads go out at once: one after another they were the slowest part of opening Settings, 0.39 s of 1.0.
export async function trkStatus(env) {
  const db = env.DB, q = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results || [];
  const [learnerRow, rules, perRows, recentRows, metas, dayRows] = await Promise.all([
    trkMetaGet(db, "learner"),
    q("SELECT pattern, kind, state, tiny, mails, sender, note, created_at, changed_at, on_at FROM trk_rules ORDER BY changed_at DESC LIMIT 300"),
    q("SELECT rule, COUNT(*) n FROM trk_verdict WHERE gone = 0 GROUP BY rule"),
    q("SELECT url, name, cls, rule, pat FROM trk_verdict WHERE gone = 0 AND at > ? ORDER BY seq DESC LIMIT 3000", isoIn(-14 * 86400e3)),
    Promise.all(TRK_LISTS.map((L) => trkMetaGet(db, "list:" + L.key))),
    q("SELECT (SELECT COUNT(*) FROM trk_verdict WHERE gone = 0 AND at > ?) blocked, (SELECT COUNT(*) FROM trk_obs WHERE w BETWEEN 1 AND 2 AND h BETWEEN 1 AND 2 AND first_at > ?) slipped", isoIn(-86400e3), isoIn(-86400e3)),
  ]);
  const learner = learnerRow || { mode: "watch", since: null };
  const per = new Map(perRows.map((r) => [r.rule, r.n]));
  for (const r of rules) r.blocked = per.get("learned:" + r.pattern) || 0;
  const recent = new Map();
  for (const x of recentRows) {
    const p = x.pat || trkPattern(x.url), e = recent.get(p) || { pattern: p, name: x.name, cls: x.cls, source: x.rule.split(":")[0], n: 0 }; e.n++; recent.set(p, e);
  }
  const lists = [];
  for (const [i, L] of TRK_LISTS.entries()) { const m = metas[i]; lists.push({ name: L.name, cls: L.cls, version: m?.version || null, rules: m?.rules || 0, refused: (m?.dropped || []).length, blocked: m?.blocked ?? null, of: m?.of ?? null, checked: m?.checked ?? 0, at: m?.at || null }); }
  const day = dayRows[0] || {};
  return { learner, on_at: learner.mode === "watch" && learner.since ? new Date(Date.parse(learner.since) + TRK_WATCH_MS).toISOString() : null, rules, recent: [...recent.values()].sort((a, b) => b.n - a.n).slice(0, 40), lists, day };
}
// A Gmail message's HTML body, from messages.get format=full: the first text/html part, base64url-decoded.
function gmailHtmlPart(part) {
  if (!part) return "";
  if (part.mimeType === "text/html" && part.body?.data) { try { return new TextDecoder().decode(unb64(part.body.data.replace(/-/g, "+").replace(/_/g, "/"))); } catch (_) { return ""; } }
  for (const c of part.parts || []) { const h = gmailHtmlPart(c); if (h) return h; }
  return "";
}
// One deadline for the whole batch: it runs inside a single waitUntil, which an HTTP-triggered invocation (Gmail push) extends by at
// most 30 s, and each mail taking its own 20 s budget in turn meant the later mails of a burst were cut off unfetched.
//  The day's allowance is read once and drawn down across the batch.
async function prefetchGmail(env, at, account, ids) {
  const deadline = Date.now() + 25_000; const left = await prefetchAllowance(env);
  for (const id of ids.slice(0, 20)) {   // 20 quota units each; a burst of 20 is 400 of the 6,000 a user may spend per minute
    if (Date.now() > deadline - 2_000 || left.images <= 0 || left.bytes <= 0) break;
    try {
      const m = await gmailApi(at, `messages/${id}?format=full`);
      if ((m.labelIds || []).some((l) => l === "SPAM" || l === "TRASH" || l === "SENT")) continue;   // spam and trash never signal; our own mail needs nothing
      const html = gmailHtmlPart(m.payload); if (html) await prefetchImages(env, html, `gmail:${account}:${id}`, { deadline, left, from: addrOnly(hdrVal(m, "From")) });
    } catch (_) {}
  }
}

import SEARCH_JS from "./client/search.js";
import TRUST_JS from "./client/trust.js";
const APP_JS = [PERF_JS, STORE_JS, SYNC_JS, QUEUE_JS, SEARCH_JS, TRUST_JS, APP_UI_JS].join("\n"); // served as one file: /app.js
import SW_JS from "./client/sw.js";
import MANIFEST from "./client/manifest.webmanifest";
import LOGIN_HTML from "./login.html";

const OUT_MAX_BYTES = 5 * 1024 * 1024; // platform ceiling incl. attachments
const BODY_CAP = 900_000;              // per-column cap; the raw MIME in R2 is the source of truth
const FALLBACK_WINDOW_DAYS = 30;
const INBOUND_PARSE_MAX = 15 * 1024 * 1024; // above this: store raw, skip parsing (Cloudflare rejects > 25 MiB anyway)
// postal-mime 2.7.6 takes time quadratic in the number of MIME parts: 5,000 parts 0.4 s, 10,000 parts 1.6 s, and about 0.4 MB of empty
// parts ran a mail's projection past its 30 s of CPU, with the minute cron retrying it, and dying, every minute after.
// Lines, headers, nesting and encoded words stay linear (measured). Past MIME_PARTS_MAX delimiter lines only the header block is
// parsed, with a note in place of the body; the bytes stay in R2 as received. Every parse of inbound mail goes through parseMail.
const MIME_PARTS_MAX = 2000;
const rawBytes = (raw) => (raw instanceof Uint8Array ? raw : typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw));
function mimeDelimiterLines(b, max) { let n = 0; for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, i + 1)) if (b[i + 1] === 0x2d && b[i + 2] === 0x2d && ++n > max) break; return n; }
async function parseMail(raw) {
  const b = rawBytes(raw);
  if (mimeDelimiterLines(b, MIME_PARTS_MAX) <= MIME_PARTS_MAX) return PostalMime.parse(raw);
  // Parts need a multipart type: a plain-text mail with that many lines starting "--" parses in linear time, so it is read in full.
  //  Decoded only past the count, so ordinary mail pays nothing for this.
  if (!/multipart\s*\//i.test(new TextDecoder("latin1").decode(b))) return PostalMime.parse(raw);
  let end = -1; for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, i + 1)) if (b[i + 1] === 0x0a || (b[i + 1] === 0x0d && b[i + 2] === 0x0a)) { end = i + 1; break; }
  const head = b.subarray(0, end < 0 ? Math.min(b.length, 256 * 1024) : end), u = new Uint8Array(head.length + 4); u.set(head); u.set([13, 10, 13, 10], head.length);
  const p = await PostalMime.parse(u);
  return { ...p, text: `[This message has more than ${MIME_PARTS_MAX} MIME parts, too many to open safely. It is kept as it was received.]`, html: undefined, attachments: [], tooManyParts: true };
}
const ATTACHMENT_MAX_COUNT = 32;
const INBOUND_BURST_PER_HOUR = 60;              // per sender organisation (envelope OR header From root); beyond: no parse, no attachments
const INBOUND_ROOT_BYTES_PER_HOUR = 100 * 1024 * 1024; // the same organisation's raw bytes in the last hour; beyond: the same
const INBOUND_BYTES_PER_HOUR = 512 * 1024 * 1024; // hub-wide raw budget per hour; beyond: Gmail copy only, no raw/R2 write
const SWEEP_PAGE_MAX = 40;                        // R2 list pages (200 objects each) one sweep run may walk before saving its cursor
const SWEEP_MONTHS = 4;                           // calendar months of R2 the daily orphan sweep walks back over; see sweepUnindexedRaw
const STORAGE_SOFT_CAP = 8 * 1024 * 1024 * 1024;  // hub-wide stored bytes. ALERT ONLY: it used to suppress the raw/R2 write for
                                                  // messages > 1 MiB, i.e. a cap that answered "too much mail" by discarding the only
                                                  // durable copy. Reported by the storage stats; it no longer gates any write.
const TRASH_RETENTION_DAYS = 30;

// Every time the Worker writes is this ISO form, "2026-10-09T02:13:15.613Z"; SQLite's datetime() writes "2026-10-09 09:02:51". Compared as
// text the "T" sorts after the space, so `created_at > datetime('now','-7 days')` let in the window's whole first day and `due_at <=
// datetime('now')` missed everything due earlier the same day: the 2026-10-16 report raised an ALERT for a message 7 days 7 hours old.
//  A window on a column written here uses strftime('%Y-%m-%dT%H:%M:%fZ','now',...). Only events.at (and the
// created_at of threads and identities, which nothing compares) keeps SQLite's default form; test/report.mjs holds every
// datetime('now' in this file to events.at.
const now = () => new Date().toISOString();
// D1 binds at most 100 values per statement ("Maximum bound parameters per query | 100", developers.cloudflare.com/d1/platform/limits).
// A list that can grow past that is queried in slices; 90 leaves room for the statement's other values. A refresh behind
// the import of 160 older work emails asked for 500 changes touching more than 100 conversations, and D1 answered "too many SQL
// variables"; a conversation of 164 messages could not be opened for the same reason (its attachments query).
const D1_IN_MAX = 90;
async function inSlices(ids, fn) { const out = []; for (let i = 0; i < ids.length; i += D1_IN_MAX) out.push(...await fn(ids.slice(i, i + D1_IN_MAX))); return out; }
const qmarks = (xs) => xs.map(() => "?").join(",");
const uuid = () => crypto.randomUUID();
const lc = (s) => (s || "").toString().trim().toLowerCase();
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private", ...extra } });

function normSubject(s) {
  let x = (s || "").trim(), prev;
  do { prev = x; x = x.replace(/^\s*(?:(?:re|fwd?|fw|aw|sv|tr|wg)\s*(?:\[\d+\])?\s*:\s*)+/i, ""); } while (x !== prev);
  return x.replace(/\s+/g, " ").trim().toLowerCase();
}
// An id is <…> with no space, line break or second "<" inside: `<[^>]+>` took "<a\r\nReply-To: x>" whole, and a reply
// wrote it into its References: a sender's own header, and the text after a blank line the start of the user's reply.
// Prefs rows the server alone owns: the session generation ("sign out everywhere"; a client that could write it brought
// every revoked cookie back) and the native apps' sign-in codes, readable mid-sign-in. Never sent to a client, never written by one.
const PREF_SERVER_ONLY = (k) => k === "session_gen" || k === "revisit" || k === "handled" || k.startsWith("applogin:") || k.startsWith("appcb:") || k.startsWith("gmailticket:") || k.startsWith("imaptry:") || k.startsWith("imgsweep:");
function parseIdList(h) { return ((h || "").toString().match(/<[^<>\s]+>/g) || []).map((x) => x.trim()); }
// One header id (Message-ID, In-Reply-To's first) as it may go into a header: no space or control character at all. An encoded word
// that decodes to CR/LF (postal-mime decodes message-id, in-reply-to and references) is how a mail carried one.
const hdrId = (v) => { const s = String(v ?? "").replace(/[\x00-\x20\x7f]+/g, ""); return (/^<[^<>]+>/.exec(s) || [])[0] || s; };   // the first <id> when there is one
// A header's value on one line: line breaks and other control characters become a space.
const oneHdr = (v) => String(v ?? "").replace(/[\x00-\x08\x0a-\x1f\x7f]+/g, " ");
function addrList(v) { // postal-mime address objects → [{address,name}]
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const a of arr) {
    if (!a) continue;
    if (a.group) out.push(...addrList(a.group));
    else if (a.address) out.push({ address: lc(a.address), name: a.name || "" });
  }
  return out;
}
function toAddrObjs(v) { // API input: string | {email,name} | array → array for the binding
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr.map((x) => (typeof x === "string" ? x.trim() : x)).filter(Boolean);
}
function addrOnly(x) { return lc(typeof x === "string" ? x.replace(/^.*<([^<>]+)>.*$/, "$1") : x?.email); }
// What a reader of an HTML body sees, for a preview or a plain-text copy. Stripping tags alone kept the contents of <style>, <title> and
// Outlook's conditional comments, so an HTML-only newsletter previewed as "96 *{box-sizing:border-box}body{margin:0…" (my Mac,
// The 96 is <o:PixelsPerInch> inside <!--[if mso]>). Entities are decoded; the client escapes what it shows.
const HTML_ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "", zwj: "", shy: "" };
// Block, cell, list, heading, line-break and image tags become a space; every other tag joins its neighbours, as a browser draws them:
// One shop's newsletter splits a word across spans ("<span>Blue Widge</span><span>t</span>") and read "Blue Widge t".
const HTML_BLOCK = /<\/?(?:address|article|aside|blockquote|br|caption|center|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|img|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^<>]*>/gi;
function htmlText(html) {
  return dropBlocks(dropComments(html, " "), "head|style|script|title", " ").replace(HTML_BLOCK, " ").replace(/<[^<>]+>/g, "")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, h, n) => { if (n) return HTML_ENT[n.toLowerCase()] ?? m; const c = d ? +d : parseInt(h, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m; })
    .replace(/[\u034f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0]/g, "");   /* the invisible padding newsletters put after a preheader (Resend's is LRM + RLM); emoji variation selectors stay */
}
// An inbound message's list preview reads the way the message does: from its HTML when there is one. The plain-text
// part can be anything: Mailchimp writes every link into it as "Text (https://…?mc_cid=…)", others "[Text](URL)" or a stub ("text
// version of this email is not supported"). Gmail's own preview of the same newsletter is built from the HTML.
function previewOf(text, html) { const h = html ? htmlText(html).replace(/\s+/g, " ").trim() : ""; return (h || String(text || "").replace(/\s+/g, " ").trim()).slice(0, 200); }
function safeName(n) { return (n || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120); }
async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a || "")), crypto.subtle.digest("SHA-256", enc.encode(b || ""))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 && (a || "").length === (b || "").length;
}

function globMatch(glob, s) { const re = new RegExp("^" + glob.toLowerCase().split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"); return re.test((s || "").toLowerCase()); }
// The Gmail safety copy of domain mail. On unless GMAIL_COPY = "off" in wrangler.toml. With it off
// a message still goes to Gmail when its rule says "forward" (USPTO correspondence), and the emergency copy below still runs whenever
// the bytes could not be stored. Undo: GMAIL_COPY = "on" and deploy.
const gmailCopyOn = (env) => String(env?.GMAIL_COPY || "on").trim().toLowerCase() !== "off";
// The emergency copy, sent when the bytes could not be stored. Cloudflare's send binding takes neither the inbound
// message as it came ("From: header does not match mail from") nor that message re-addressed ("invalid headers set": its allowlist
// refuses Received, DKIM-Signature, ARC-*, Return-Path and the other hop headers every inbound message carries, and one bad header fails
// the whole send: developers.cloudflare.com/email-service/reference/headers). Both were found by the failure test of 2026-10-09; the
// path had never fired before. So the copy is a NEW message, built exactly the way the hub's own sends with attachments are (mimetext,
// proven in production): from the hub's address, the original's subject, a note saying who sent it and the readable text, and the
// original attached byte for byte as original.eml.
const EMERGENCY_FROM = "mailhub@yourdomain.example";
// The largest original the copy carries. Email Service takes 25 MiB in all for a verified destination
// ("Total message size | 25 MiB | For verified destination addresses only", developers.cloudflare.com/email-service/platform/limits)
// and base64 makes the attachment 4/3 of the original, so about 18.7 MiB is the ceiling on paper. Building the copy also holds the
// original, a byte string of it, its base64 and mimetext's message at once, against 128 MB of Worker memory. 10 MiB keeps both well
// clear. Larger mail whose R2 write failed gets a temporary failure instead, and the sender retries.
const EMERGENCY_MAX_BYTES = 10 * 1024 * 1024;
// One line, no control characters, at most n characters (code points). The subject is capped hard: mimetext writes it as ONE
// unfolded =?utf-8?B?…?= word, and a 2,000-character subject made a 2,713-character Subject line, past Email Service's 998-character
// subject limit, so the copy would have been refused.
const oneLine = (v, n) => Array.from(String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, n).join("");
async function emergencyCopy(raw, { to, rcpt, envFrom, hdrFrom, subjectHdr, at }) {
  let p = null; try { p = await parseMail(raw); } catch (_) {}
  const sender = oneLine(p?.from?.address ? (p.from.name ? `${p.from.name} <${p.from.address}>` : p.from.address) : (hdrFrom || envFrom || "(unknown)"), 300);
  const subject = oneLine(p?.subject ?? subjectHdr ?? "", 150);
  let text = ""; try { text = (p?.text || (p?.html ? htmlText(p.html).replace(/[ \t]+/g, " ") : "")).slice(0, 20_000); } catch (_) {}   // the excerpt is a convenience; the attachment is the copy
  const mm = createMimeMessage();
  mm.setSender({ name: "mailhub (emergency copy)", addr: EMERGENCY_FROM });
  mm.setTo(to);
  mm.setSubject(`[emergency copy] ${subject || "(no subject)"}`);
  mm.addMessage({ contentType: "text/plain", data: [
    "The hub could not store this message, so this copy is the only one. The original is attached exactly as it arrived (original.eml).",
    "", `From: ${sender}`, `To: ${oneLine(rcpt, 300)}`, `Envelope sender: ${oneLine(envFrom, 300) || "(none)"}`, `Subject: ${subject || "(no subject)"}`, `Received by the hub: ${at}`,
    "", "----------", "", text || "(no readable text; open original.eml)"].join("\n") });
  const u8 = new Uint8Array(raw); let b = ""; for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  mm.addAttachment({ filename: "original.eml", contentType: "application/octet-stream", data: btoa(b) });
  return mm.asRaw();
}
// A delivery the hub could not keep and could not copy anywhere. Thrown out of email() it reaches the sender as a TEMPORARY failure, so
// the sender retries later (three probes thrown before storage were retried for up to 1 h 46 min and all
// delivered once the handler stopped throwing). setReject is the other answer, and Cloudflare documents it as permanent: a bounce.
class TempFail extends Error { constructor(m) { super(m); this.name = "TempFail"; } }
async function matchRule(db, rcpt, sender) {
  const { results } = await db.prepare("SELECT * FROM rules WHERE enabled = 1 ORDER BY priority ASC, id ASC").all();
  for (const r of results) if (globMatch(r.rcpt_glob, rcpt) && globMatch(r.sender_glob, sender)) return r;
  return null;
}
function addLabel(json, label) { const a = new Set(JSON.parse(json || "[]")); if (label) a.add(label); return a.size ? JSON.stringify([...a]) : null; }
// The letterhead: wrangler.toml [vars] BRANDS is a JSON object keyed by domain, each {name, logo, color, site, footer}.
// A send from an address on a listed domain goes out with its HTML part wrapped in that frame, built from the client's HTML (Markdown)
// or the escaped text, and a reply quotes the message it answers; `plain` in the body skips it. Every other domain's bytes are untouched,
// and the plain-text part is always what was written. Brandseven's admin-inbox template is where the frame comes from.
// The frame has no dark-mode rule: the template's `@media (prefers-color-scheme: dark)` rule painted the logo white
// (brightness(0) invert(1)) while the card stayed #ffffff, so the logo vanished in every client that applies such rules, Sherit in dark
// mode among them (The logo was missing). The logo is yellow and red on a transparent background and reads
// on the white card in either mode, so nothing replaces the rule; the card and its text colours are fixed and the two color-scheme
// metas stay, which tells Apple Mail and Outlook the design already handles dark mode and is not to be recoloured.
function brandsCfg(env) { let o = {}; try { o = JSON.parse(env?.BRANDS || "{}"); } catch (_) { o = {}; } const out = {}; for (const [d, b] of Object.entries(o && typeof o === "object" ? o : {})) if (b && typeof b === "object" && typeof b.name === "string" && b.name) out[lc(d)] = b; return out; }
const textHtml = (t) => esc(t || "").replace(/\r?\n/g, "<br>");
// The letter's own plain text into the frame with its web addresses as links. A branded send written as plain text carries its
// links as plain text too (an App Store address, a download page): Gmail and Apple Mail link those on their own, the hub's reader
// and some other clients do not. Each piece between addresses is escaped exactly as textHtml does; trailing punctuation stays
// outside the link; a bare domain is linked only with a path after it, and gets https://. Quoted originals keep textHtml, so the
// quote rules are unchanged.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'*]|(?<![@\w.\/-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|dev|co\.uk|com\.au|ie|eu)\/[^\s<>"]*[^\s<>".,;:!?)\]'*]/gi;
const linkTextHtml = (t) => {
  const s = String(t || ""); let out = "", at = 0;
  for (const m of s.matchAll(URL_IN_TEXT)) {
    const href = /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`;
    out += esc(s.slice(at, m.index)) + `<a href="${esc(href)}">${esc(m[0])}</a>`; at = m.index + m[0].length;
  }
  return (out + esc(s.slice(at))).replace(/\r?\n/g, "<br>");
};
// The quoted original as light HTML: what the mail's HTML part says, with its links, emphasis, paragraphs, breaks,
// lists and table cells, and nothing else of its markup. A tag not in QUOTE_KEEP goes and its text stays; style, script, head, svg,
// iframe, form, img and the like go with their contents (an img is a remote picture or a tracking pixel, and a quote must not call the
// sender's server); every attribute goes but a link's href, kept only when it is http(s) or mailto. A stray closing tag is dropped and
// whatever is still open is closed at the end, so an unbalanced original can never close the letterhead's own table around it. Before
// this the quote was the text part escaped, where Gmail writes a link as `LinkedIn <https://…>` and bold as `*Jordan Lee*`
// (The quote had lost the customer's link).
const QUOTE_KEEP = new Set(["a", "b", "strong", "i", "em", "u", "s", "br", "p", "div", "span", "blockquote", "ul", "ol", "li", "table", "tbody", "thead", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "hr"]);
const QUOTE_DROP = /^(style|script|head|title|svg|iframe|object|embed|form|img|picture|source|video|audio|noscript|template|select|textarea|button)$/;
function quoteHtml(html) {
  const s = dropComments(html, "");
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g; let out = "", at = 0, m, skip = null; const open = [];
  while ((m = re.exec(s))) {
    const close = m[0][1] === "/", name = m[1].toLowerCase();
    if (skip) { if (close && name === skip) skip = null; at = re.lastIndex; continue; }   // inside a dropped element: none of it
    out += s.slice(at, m.index).replace(/</g, "&lt;"); at = re.lastIndex;
    if (QUOTE_DROP.test(name)) { if (!close && !/^(img|source|embed)$/.test(name) && !/\/\s*$/.test(m[2])) skip = name; continue; }
    if (!QUOTE_KEEP.has(name)) continue;   // the tag goes, its text stays
    if (name === "br" || name === "hr") { if (!close) out += `<${name}>`; continue; }
    if (close) { const k = open.lastIndexOf(name); if (k < 0) continue; while (open.length > k) out += `</${open.pop()}>`; continue; }
    let attrs = "";
    if (name === "a") { const href = String(tagAttrs(m[2]).href || "").trim(); if (/^(https?:\/\/|mailto:)/i.test(href)) attrs = ` href="${esc(href)}"`; }
    out += `<${name}${attrs}>`; if (!/\/\s*$/.test(m[2])) open.push(name);
  }
  // Text between tags, and after the last, with its "<" escaped: an unfinished `<img src=x onerror=…` at the end of a
  // customer's mail (or where the 200,000-character cut fell) went raw into the user's branded reply.
  out += s.slice(at).replace(/</g, "&lt;"); while (open.length) out += `</${open.pop()}>`;
  return out;
}
function brandFrame(b, { inner, parent }) {
  const color = /^#[0-9a-fA-F]{3,8}$/.test(b.color || "") ? b.color : "#f97316";
  const site = typeof b.site === "string" && /^https:\/\/[^\s"<>]+$/.test(b.site) ? b.site : "";
  const logo = typeof b.logo === "string" && /^https:\/\/[^\s"<>]+$/.test(b.logo) ? b.logo : "";
  let quote = "";
  if (parent && (String(parent.body_html || "").trim() || String(parent.body_text || "").trim())) {
    const who = parent.direction === "out" ? (parent.from_name || parent.identity || "") : (parent.from_name || parent.from_addr || "");
    const d = new Date(parent.date_hdr || parent.created_at || ""); const when = isNaN(d) ? "" : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
    const lead = when ? `On ${when}${who ? ", " + who : ""} wrote:` : `${who || "They"} wrote:`;
    // the HTML part when it has words in it (a text-only mail, or one whose HTML is all pictures, falls back to the text part escaped)
    const light = parent.body_html ? quoteHtml(String(parent.body_html).slice(0, 200000)) : "";
    const quoted = /\S/.test(light.replace(/<[^<>]*>/g, "")) ? light : textHtml(String(parent.body_text || "").slice(0, 20000));
    quote = `<tr><td style="padding:0 32px 28px"><div style="padding-top:20px;border-top:1px solid #e5e7eb"><p style="color:#6b7280;font-size:13px;margin:0 0 10px">${esc(lead)}</p><div style="margin-left:4px;padding-left:12px;border-left:3px solid #d1d5db;color:#6b7280;font-size:14px;line-height:1.6">${quoted}</div></div></td></tr>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>`
    + `<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,Arial,sans-serif;background-color:#f9fafb"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f9fafb"><tr><td align="center" style="padding:32px 16px">`
    + `<table cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1);overflow:hidden">`
    + `<tr><td style="padding:20px 32px;border-bottom:3px solid ${color}"><table cellpadding="0" cellspacing="0" border="0"><tr>${logo ? `<td width="40" style="width:40px"><img src="${esc(logo)}" alt="${esc(b.name)}" width="40" height="40" style="width:40px;height:40px;display:block"></td>` : ""}<td style="padding-left:${logo ? 8 : 0}px"><span style="color:${color};font-size:18px;font-weight:700">${esc(b.name)}</span></td></tr></table></td></tr>`
    + `<tr><td style="padding:28px 32px;color:#374151;font-size:15px;line-height:1.7">${inner}</td></tr>${quote}`
    + `<tr><td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb">${typeof b.footer === "string" && b.footer ? `<p style="color:#6b7280;font-size:13px;line-height:1.5;margin:0 0 8px">${esc(b.footer)}</p>` : ""}<p style="color:#9ca3af;font-size:12px;margin:0">&copy; ${new Date().getUTCFullYear()} ${esc(b.name)}${site ? ` &bull; <a href="${esc(site)}" style="color:#9ca3af;text-decoration:none">${esc(site.replace(/^https:\/\//, "").replace(/\/$/, ""))}</a>` : ""}</p></td></tr>`
    + `</table></td></tr></table></body></html>`;
}
// Onboarded-domain authority lives in wrangler.toml [vars] DOMAINS (a deploy-time config, not writable through the API).
async function ownDomains(db, env) {
  const cfg = (env?.DOMAINS || "").split(",").map(lc).filter(Boolean);
  // Only CONFIG mailboxes make their domain ours (a deploy-time act). A mailbox added in the app authorizes its own address and
  // nothing else: one verified login must never let the hub send as every address at that domain.
  const imapDoms = imapConfigAccounts(env || {}).map((a) => a.email.split("@")[1]).filter(Boolean);
  if (cfg.length) return new Set([...cfg, ...imapDoms]);
  const { results } = await db.prepare("SELECT DISTINCT domain FROM identities WHERE is_active = 1").all();
  return new Set(results.map((r) => lc(r.domain)));
}
function externalParticipants(addrs, own) {
  const ext = [...new Set(addrs.map(lc).filter((a) => a && !own.has(a.split("@")[1])))].sort();
  return JSON.stringify(ext.length ? ext : [...new Set(addrs.map(lc))].sort());
}
async function logEvent(db, kind, messageId, detail) {
  try { await db.prepare("INSERT INTO events (kind, message_id, detail) VALUES (?, ?, ?)").bind(kind, messageId || null, detail ? String(detail).slice(0, 2000) : null).run(); } catch (_) {}
}

// Threading: In-Reply-To → References (newest first) → same normalised subject + external participants within the window → new.
// The subject match never joins a conversation in Trash. It used to, and the new message inherited the Trash with it: a daily
// digest whose last issue was deleted put every later issue straight into Trash, where nothing showed it .
// Gmail starts the new message off in the inbox and keeps the deleted ones deleted, which a fresh conversation does here.
async function resolveThread(db, { inReplyTo, references, subjectNorm, participants }) {
  const ids = [];
  for (const id of parseIdList(inReplyTo)) if (!ids.includes(id)) ids.push(id);
  for (const id of parseIdList(references).reverse()) if (!ids.includes(id)) ids.push(id);
  // My own copy first. With no order, the unique index (message_id, direction, identity) gave an INBOUND row
  // before the outbound one, so anyone who had received a mail could send one back under its Message-ID, from any name, and the real
  // replies to it were filed into the sender's conversation instead of the user's.
  for (const id of ids) {
    const row = await db.prepare("SELECT thread_id FROM messages WHERE message_id = ? ORDER BY direction = 'out' DESC, created_at ASC LIMIT 1").bind(id).first();
    if (row) return row.thread_id;
  }
  if (subjectNorm) {
    const row = await db
      .prepare(`SELECT id FROM threads WHERE subject_norm = ? AND participants = ? AND state != 'trash' AND last_message_at > strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY last_message_at DESC LIMIT 1`)
      .bind(subjectNorm, participants, `-${FALLBACK_WINDOW_DAYS} days`).first();
    if (row) return row.id;
  }
  return null;
}
// `newState` applies only when a thread is CREATED. A conversation the user starts holds nothing but the user's own
// mail, and the column default ('inbox', migration 0003) put every one of them in the inbox (A sent message
// belongs in the 'sent' folder only). Senders create it 'archived'; the first reply moves it to the inbox through
// the inbound path's existing `CASE WHEN state IN ('archived', 'trash') THEN 'inbox'`, which is exactly when it belongs there.
// The conversation's write, NOT yet run, so it can go in one batch (one transaction, D1's batch()) with the message that justifies it.
// Run on its own, then the message insert failing (a duplicate Message-ID, a retried delivery), left a conversation counting a message
// it does not have: 3,591 such shells were in the inbox on 2026-10-05, and one surfaced as an empty "(no subject)" conversation.
function threadWrite(db, threadId, { subjectNorm, participants, at, newState = "inbox" }) {
  if (threadId) return { id: threadId, stmt: db.prepare("UPDATE threads SET last_message_at = MAX(COALESCE(last_message_at, ''), ?), message_count = message_count + 1 WHERE id = ?").bind(at, threadId) };
  const id = uuid();
  return { id, stmt: db.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state) VALUES (?, ?, ?, ?, 1, ?)").bind(id, subjectNorm, participants, at, newState) };
}

// ---------- inbound ----------
// R2-FIRST. The raw MIME is made durable in R2 before D1 is read at all, and the message is accepted on the strength of
// that one write. Everything after it - dedup, rules, containment, parsing, metadata, the gatekeeper, push - is a
// PROJECTION that may fail and be replayed from the stored object, so a failure there is a visibility outage and never
// message loss.
//
// It used to run the other way round: five D1 reads (dup lookup, rule match, burst count, hour bytes, stored bytes)
// gated every message and only then did ingestRaw put the bytes in R2, so any D1 error threw before the message existed
// anywhere. `storeErr` was assigned and never read, which is how a failed store could be answered with "delivered".
// Three reviewers converged on this ordering;
// And that hard stop is not abolished on Paid so much as one failed card charge away, on an account whose
// allowances are shared with two other projects.
//
// setReject is NOT a retry. Cloudflare documents it as "a permanent SMTP error", so every internal failure answered
// with it was a hard bounce wearing the words "temporary failure, please retry". It survives on exactly one path: the
// bytes could not be made durable anywhere, which is the only case where refusing the message is honest.
async function handleInbound(message, env) {
  const db = env.DB;
  const id = uuid();
  const at = now();
  const rcpt = lc(message.to);
  const envFrom = lc(message.from);
  const subjectHdr = message.headers.get("subject") || "";
  const msgIdHdr = (message.headers.get("message-id") || "").trim() || null;
  // The visible From header is spoofable, so it may satisfy a rule only when Cloudflare's Authentication-Results says
  // dmarc=pass for it; otherwise only the SMTP envelope sender is consulted. Headers.get() joins
  // repeated headers with ", " in message order and Cloudflare prepends its own at receipt, so only the FIRST value
  // counts and it must carry Cloudflare's authserv-id.
  // The address is the LAST <…> in From, and Cloudflare's header.from must be exactly its domain: the first <…> and
  // a substring test took `"<x@uspto.gov>" <y@uspto.gov.evil.example>`, DMARC-signed by the lookalike, as uspto.gov's own.
  const fromAngles = [...(message.headers.get("from") || "").matchAll(/<([^<>]+)>/g)];
  const hdrFrom = lc((fromAngles.length ? fromAngles[fromAngles.length - 1][1] : "") || message.headers.get("from") || envFrom);
  const authFirst = ((message.headers.get("authentication-results") || "").split(/,\s*(?=[a-z0-9.-]+;)/i)[0] || "").trim().toLowerCase();
  const hdrFromDomain = hdrFrom.split("@")[1] || "";
  const hdrAuth = !!hdrFromDomain && authFirst.startsWith("mx.cloudflare.net;") && dmarcPassFor(authFirst, hdrFromDomain);

  // 0. The hold rule decides whether an address may reach Gmail at all (the USPTO correspondence addresses). It is a D1
  //  read, and D1 is precisely what may be unavailable, so this FAILS CLOSED: unknown means "do not forward", because
  //  forwarding held mail leaks it while not forwarding costs nothing once R2 is the record.
  //  The duplicate pre-check rides in the SAME block: dedup used to happen before the forward, and moving it after it
  //  meant every redelivery of a message we already hold sent a SECOND copy to Gmail.
  //  Both statements are advisory - if either throws we simply do not forward - so neither can gate durability.
  let rule = null, ruleKnown = true, seenBefore = false;
  try { rule = (hdrAuth ? await matchRule(db, rcpt, hdrFrom) : null) || (await matchRule(db, rcpt, envFrom)); }
  catch (e) { ruleKnown = false; }
  // SEPARATE try. Sharing one with the rule lookup meant a failure of THIS query alone set ruleKnown = false and
  // suppressed the Gmail safety copy for mail whose rule had been read perfectly well.
  //  And it is scoped to the RECIPIENT: the same Message-ID addressed to two of the user's own
  // addresses is two deliveries, and a recipient-global check skipped the safety copy for the second one.
  try {
    // pending_ingest is consulted too: a redelivery arriving while the first copy is still waiting to be projected is
    // not in `messages` yet, so checking only that table re-fired the Gmail copy.
    if (msgIdHdr) seenBefore = !!(await db.prepare(
      "SELECT 1 x FROM messages WHERE message_id = ? AND direction = 'in' AND identity = ? UNION ALL SELECT 1 x FROM pending_ingest WHERE message_id = ? AND rcpt = ? LIMIT 1")
      .bind(msgIdHdr, rcpt, msgIdHdr, rcpt).first());
  } catch (e) { seenBefore = false; }
  const hold = !ruleKnown || rule?.action === "hold";
  const label = rule?.label || null;
  // The failure test R51 was gated on: each probe acts only on mail to the one random address its secret names, and
  // nothing changes while the secret is unset. FAULT_PROBE_R2 refuses the R2 put and takes no routine copy, as if the copy were off,
  // so the emergency copy is what must reach Gmail. FAULT_PROBE_PROJECT makes the projection throw after the put, so the cron's
  // replay is what must index it (the replay does not consult the probe).
  const probeR2 = !!env.FAULT_PROBE_R2 && rcpt === lc(env.FAULT_PROBE_R2);
  const probeProject = !!env.FAULT_PROBE_PROJECT && rcpt === lc(env.FAULT_PROBE_PROJECT);
  const copyWanted = !probeR2 && (gmailCopyOn(env) || rule?.action === "forward");

  // 1. The Gmail safety copy, still taken first because forward() must run before the raw stream is consumed. It is on
  //  its way out (the user no longer needs these Gmail copies) but it comes off LAST, after this ordering has
  //  been fault-injection verified - all three reviewers were explicit that it is the only backstop standing until
  //  then. It touches no D1, so a database failure cannot stop it.
  let forwardedAt = null, fwdErr = null;
  if (!hold && !seenBefore && copyWanted) {
    try { const h = new Headers(); h.set("X-Mailhub-Id", id); await message.forward(env.FORWARD_TO, h); forwardedAt = now(); }
    // Same rule as the rawSize mismatch below: this is a D1 WRITE, so it cannot happen before the bytes are durable.
    catch (e) { fwdErr = e?.message || "forward failed"; }
  }

  // 2. THE COMMIT POINT. Read the stream once and put it in R2 under a CONTENT-ADDRESSED key, so a sender retry of the
  //  same bytes re-uses the same object instead of accumulating duplicates. Nothing above here touched D1 for
  //  durability, and nothing below here may refuse the message.
  let raw, rawKey, sizeMismatch = null, readOk = false;
  try {
    raw = await new Response(message.raw).arrayBuffer();
    // A stream that ends early does NOT throw: it just yields fewer bytes. Hashing and storing that as if it were the
    // whole message is silent corruption, so the length is checked against what Cloudflare said it was sending.
    // A strict equality test here rests on the exact semantics of `rawSize`, which Cloudflare's documented API surface
    // does not pin down. If it differs from the stream length by even one byte in production, this would PERMANENTLY
    // BOUNCE every held message and push everything else onto Gmail alone - a fix with a worse failure mode than the
    // defect. It is watched against real traffic before it is enforced.
    // So: an EMPTY read is refused outright, because zero bytes is unambiguous and storing it would be corruption. Any
    // other mismatch is recorded and watched, and only enforced once INBOUND_STRICT_RAWSIZE says real traffic agrees.
    if (!raw.byteLength) throw new Error("empty read: the stream yielded no bytes");
    // NOTE the deliberate absence of a logEvent here. Recording the mismatch at this point was a D1 WRITE before the
    // bytes were durable - precisely what this ordering exists to forbid - and the invariant test missed it because it
    // only ever ran the happy path. It is held in a local and written
    // once the message is safe.
    if (typeof message.rawSize === "number" && message.rawSize > 0 && raw.byteLength !== message.rawSize) {
      sizeMismatch = `read ${raw.byteLength} of declared ${message.rawSize}`;
      if (String(env.INBOUND_STRICT_RAWSIZE || "") === "1" && raw.byteLength < message.rawSize)
        throw new Error(`short read: ${raw.byteLength} of ${message.rawSize} bytes`);
    }
    // The key is content-addressed over the RECIPIENT AND the bytes. Bytes alone would collapse the same message
    // delivered to two of my own addresses into one object, leaving the second delivery accepted and never
    // indexed. Same recipient + same bytes is still a re-use, which is the point.
    readOk = true;   // the bytes are the whole message: only now may anything be sent on as a copy of it
    const keyed = new Uint8Array(new TextEncoder().encode(rcpt + "\n").length + raw.byteLength);
    const pre = new TextEncoder().encode(rcpt + "\n");
    keyed.set(pre, 0); keyed.set(new Uint8Array(raw), pre.length);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", keyed))].map((b) => b.toString(16).padStart(2, "0")).join("");
    rawKey = `raw/${at.slice(0, 4)}/${at.slice(5, 7)}/${digest}.eml`;
    // Retry the put before giving up. The alternative to a successful write is an emergency copy or, failing that, a temporary
    // failure the sender has to retry, so a single transient R2 blip must not be allowed to decide it.
    let putErr = null;
    if (probeR2) { console.log(`fault probe: R2 put refused on purpose for ${envFrom} -> ${rcpt}`); throw new Error("fault probe: R2 put refused on purpose"); }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await env.STORE.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { rcpt, envFrom, at, source: "cloudflare", msgid: msgIdHdr || "", fwd: forwardedAt || "", ...(ruleKnown ? { copy: copyWanted ? "1" : "0" } : {}) } }); putErr = null; break; }
      catch (e) { putErr = e; if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1))); }
    }
    if (putErr) throw putErr;
  } catch (e) {
    // The bytes are nowhere. Before asking the sender to retry, try the Gmail copy even for mail the hold
    // rule kept out of Gmail. Hold exists to keep junk out of my Gmail (only *@uspto.gov reaches it, the rest
    // is held here), which is a visibility preference, not secrecy. "Gmail is the backstop" cannot
    // hold for held mail precisely because held mail had none; one unwanted message in Gmail
    // beats a bounced one, so the preference yields in the single case where the alternative is losing it.
    // NOT message.forward(). By this point `message.raw` has been consumed, and step 1's own comment says forward()
    // must run before that, so calling it here would have been a no-op dressed up as a safety net, which four
    // Env.EMAIL.send takes the bytes we already hold and does not touch the
    // stream. If the read itself failed there are no bytes and nothing can be sent, which is the honest bounce.
    let emErr = null;   // why the emergency copy failed. It was swallowed, so the failure test of 2026-10-09 logged
                        // r2_write_fail and a 555 bounce with no reason for the copy not going.
    // Only a COMPLETE read is copied. An empty or short read lands here too, with `raw` holding what was read (an empty ArrayBuffer
    // is still truthy), and copying that would accept the message with a truncated or empty copy while the whole of it exists
    // nowhere: reachable only once the routine copy was off. Those reads, and an
    // original over EMERGENCY_MAX_BYTES, get no copy; the sender is asked to retry below.
    const tooBig = readOk && raw.byteLength > EMERGENCY_MAX_BYTES;
    if (!forwardedAt && readOk && !tooBig) {
      try {
        // A NEW message, not the inbound one: Cloudflare refused the inbound bytes resent as they came and re-addressed (see
        // emergencyCopy). mimetext returns a string, as on the hub's own sends; the original rides base64-encoded, so 8-bit and
        // binary parts are safe.
        await env.EMAIL.send(new EmailMessage(EMERGENCY_FROM, env.FORWARD_TO, await emergencyCopy(raw, { to: env.FORWARD_TO, rcpt, envFrom, hdrFrom, subjectHdr, at }))); forwardedAt = now();
        await logEvent(db, "emergency_forward", id, `${rcpt} after R2 failure${hold ? " (held mail: preference yielded rather than lose it)" : ""}`);
      } catch (e2) { if (!forwardedAt) emErr = String(e2?.message || e2).slice(0, 400); }
    }
    // fwdErr rides along. It is only ever logged in step 3, which this path never reaches, so a delivery where BOTH the
    // Gmail forward and the R2 put failed recorded the storage error and swallowed the forwarding one: the half that
    // says why there is no copy anywhere.
    const noCopy = forwardedAt ? "" : !readOk ? " | no emergency copy: the read was not complete" : tooBig ? ` | no emergency copy: ${raw.byteLength} bytes is over ${EMERGENCY_MAX_BYTES}` : "";
    try { await logEvent(db, forwardedAt ? "store_fail_forwarded" : "r2_write_fail", id, `${e?.message}${fwdErr ? ` | forward also failed: ${fwdErr}` : ""}${emErr ? ` | emergency copy failed: ${emErr}` : ""}${noCopy}${forwardedAt ? "" : " | sender told to retry"}`); } catch (_) {}
    // No copy anywhere: ask the sender to retry rather than bounce. setReject is permanent; a thrown handler is
    // a temporary failure. A retry of the same bytes lands on the same content-addressed R2 key, so it cannot pile up.
    if (!forwardedAt) throw new TempFail(`not stored and not copied: ${e?.message}`);
    return;
  }

  // 3. From here down it is only the D1 projection, and it is allowed to fail. pending_ingest lets the cron find this
  //  object again; if even that write fails, the daily sweep still finds it by comparing R2 against messages.raw_key.
  if (fwdErr) { try { await logEvent(db, "forward_fail", id, fwdErr); } catch (_) {} }
  if (sizeMismatch) { try { await logEvent(db, "rawsize_mismatch", id, sizeMismatch); } catch (_) {} }
  try {
    await db.prepare("INSERT OR IGNORE INTO pending_ingest (raw_key, rcpt, env_from, message_id, at) VALUES (?, ?, ?, ?, ?)")
      .bind(rawKey, rcpt, envFrom, msgIdHdr, at).run();
  } catch (_) {}

  try {
    if (probeProject) throw new Error("fault probe: projection refused on purpose");
    await projectInbound(env, raw, { id, at, rcpt, envFrom, hdrFrom, hdrFromDomain, hdrAuth, subjectHdr, msgIdHdr, rawKey, hold, label, forwardedAt, copyWanted, ruleKnown,
      // ingestRaw falls back to these when PostalMime cannot parse (oversized or rate-limited mail, where it never runs).
      // The rewrite dropped them, which silently lost threading and the sent date for exactly that class - caught by
      inReplyToHdr: message.headers.get("in-reply-to"), refsHdr: message.headers.get("references"), dateHdr: message.headers.get("date") });
    try { await db.prepare("DELETE FROM pending_ingest WHERE raw_key = ?").bind(rawKey).run(); } catch (_) {}
  } catch (e) {
    // This is what `storeErr` should always have done. The message is durable, so say 250, record why the index is
    // behind, and let the reconciler replay it. Refusing here would bounce mail we are holding.
    try { await logEvent(db, "project_fail", id, `${rawKey} ${e?.message}`); } catch (_) {}
    try { await db.prepare("UPDATE pending_ingest SET attempts = attempts + 1, error = ? WHERE raw_key = ?").bind(String(e?.message || e).slice(0, 300), rawKey).run(); } catch (_) {}
  }
}

// The D1 half of an inbound message, split out of handleInbound so the reconciler can re-run exactly the same code from
// the stored R2 object. It must be idempotent: replaying a message already indexed is a no-op, not a second row.
// Dispositions are read through here so a MISSING TABLE degrades instead of taking inbound down. If migration 0025 has
// not been applied when this code goes live, an unguarded read throws inside projectInbound and sweepUnindexedRaw and
// every message stops being indexed: six of seven adversarial lanes named that deploy-order hazard
// as fatal. Unknown therefore means "not disposed", which is exactly the behaviour before this table existed, and the
// read failure is logged so a mis-ordered deploy is loud rather than silent.
async function isDisposed(db, { rawKey = null, msgId = null, identity = null }) {
  try {
    if (rawKey && (await db.prepare("SELECT 1 x FROM purged_keys WHERE raw_key = ? LIMIT 1").bind(rawKey).first())) return true;
    // Identity arm is inbound-only and purge-only: a deliberate removal of a message the user received. It must not
    // be widened to their own sent mail, whose Message-ID an inbound reply can legitimately carry.
    if (msgId && identity && (await db.prepare("SELECT 1 x FROM purged_keys WHERE message_id = ? AND identity = ? AND direction = 'in' AND reason = 'purged' LIMIT 1").bind(msgId, identity).first())) return true;
    return false;
  } catch (e) { try { await logEvent(db, "purged_keys_read_fail", null, String(e?.message || e).slice(0, 200)); } catch (_) {} return false; }
}

// ---------- Address locks ----------
// An address that belongs to the company that first writes to it (Clova.Email's one-sender address). Only an address with an
// address_locks row is locked: one made in the app, or one of the reserved shape below, which locks itself on its first mail so it can
// be made up aloud at a counter. Mail a lock refuses is KEPT, never bounced: setReject is permanent, and the likeliest wrong refusal is
// the claimer writing from a second domain (one vendor mails the user from both vendor.example and vendor-mail.example).
// "x-" or "x_", then a letter or digit. No address the hub has ever received mail at starts that way, and nobody guessing support@ or
// info@ types it.
const LOCK_PATTERN = /^x[-_][a-z0-9][a-z0-9._-]{0,61}$/;
// The organizational domain, as the app's trust.js trustRoot() computes it (test/addrlock.mjs holds the two to the same answers). Not a
// public suffix list, so an unlisted two-label suffix makes a claim wider than the company, never narrower: it can let extra mail in,
// it cannot keep wanted mail out.
const LOCK_SUFFIX2 = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "co.in", "com.br", "com.mx", "co.za", "com.sg", "com.hk", "com.tr", "com.cn", "com.tw", "co.kr", "com.ar", "co.il", "com.my", "com.ph"]);
export function lockRoot(host) { const h = String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\./, ""); const p = h.split("."); if (p.length <= 2) return h; return LOCK_SUFFIX2.has(p.slice(-2).join(".")) ? p.slice(-3).join(".") : p.slice(-2).join("."); }
// The first value of a header in the stored bytes, unfolded. Read from the bytes, not from PostalMime, so mail too large to parse is
// judged the same way, and the arrival and the reconciler's replay of the same object always see the same answer.
function rawHeaderFirst(raw, name) {
  const u8 = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
  const head = new TextDecoder().decode(u8.subarray(0, 262144)).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const want = name.toLowerCase() + ":"; const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(want));
  return line ? line.slice(want.length).trim() : "";
}
// Personal mail providers (trust.js TRUST_FREEMAIL): their domain is millions of people, not one company, so there a lock compares
// the exact address. DMARC authenticates the domain, not the mailbox; the address is as narrow as the provider's own rule on what an
// account may send as, and it is never wider than the domain. A send to one gmail.com friend let every gmail.com sender in before
// this.
const LOCK_FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "comcast.net", "att.net", "verizon.net"]);
// What a lock compares and stores (claim, allow list, messages.lock_root): the organizational domain, or the address at a provider above.
export function lockKey(addr, root) { return LOCK_FREEMAIL.has(root) ? lc(addr) : root; }
// Locks exist only on the domains whose mail reaches the hub through Cloudflare (DOMAINS), the one path that runs addressLock. A
// work mailbox's domain counts as the user's for sending, but its mail arrives over IMAP, which never reaches this check, so a lock
// there would be a lock in name only.
function lockDomains(env) { return new Set((env?.DOMAINS || "").split(",").map(lc).filter(Boolean)); }
// The From address in the stored bytes: the first <addr> (a quoted local part with spaces is fine), else the first bare one. "" when
// there is none. Only its domain is authenticated; at a personal provider the whole address is the key.
function rawFromAddr(raw) {
  const v = rawHeaderFirst(raw, "from");
  const a = lc((v.match(/<([^<>]*@[^<>\s]+)>/) || [])[1] || (v.match(/[^\s<>"(),;:]+@[^\s<>"(),;:]+/) || [])[0] || "").trim();
  return /^[^@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(a) ? a : "";
}
// One stamp's verdict on the sender, as a lock key or null. The From counts when DMARC passed for exactly its domain. The envelope counts
// only when SPF passed for that exact envelope sender AND it is the same organization as the From (at a personal provider, the same
// address): a sending service's bounce domain (wixemails.com, mcsv.net, hubspotemail.net, pphosted.com in my mail) is shared
// by all of its customers.
function lockVerdict(stamp, from, envFrom) {
  const fromDom = from.split("@")[1] || ""; if (!fromDom) return null;
  const fromRoot = lockRoot(fromDom), clauses = stamp.split(";").map((c) => c.trim());
  if (dmarcPassFor(stamp, fromDom)) return lockKey(from, fromRoot);   // Cloudflare's own dmarc clause only
  const env = lc(envFrom), envDom = (env.match(/@([a-z0-9.-]+)$/) || [])[1] || "";
  const sameSender = LOCK_FREEMAIL.has(fromRoot) ? env === from : !!envDom && lockRoot(envDom) === fromRoot;
  if (sameSender && clauses.some((c) => /^spf=pass\b/.test(c) && (c.match(/\bsmtp\.mailfrom=([^\s;]+)/) || [])[1] === env)) return lockKey(from, fromRoot);
  return null;
}
// Who really sent it, as a lock key, or null; `bad` says why Cloudflare's stamps could not be trusted. Read from the stored bytes, so the
// arrival and the reconciler's replay decide alike, and a message with no From is unauthenticated: it never falls back to the
// envelope.
// Cloudflare prepends a block to every message it delivers: its own Received ("by cloudflare-email.net"), an ARC set whose
// ARC-Authentication-Results carries the same results, Received-SPF, then Authentication-Results (six stored messages read from R2;
//  Cloudflare's sits above every sender-written one). Receivers prepend, so the FIRST Authentication-Results and the FIRST
// ARC-Authentication-Results are Cloudflare's, and both must say mx.cloudflare.net and reach the same verdict. A sender who writes a
// lookalike Authentication-Results can only make it first if Cloudflare dropped its own, and Cloudflare's ARC result, still there,
// then disagrees: the message is unauthenticated and the mismatch is logged. Forging past that would need
// Cloudflare to drop both of its stamps, which no stored message has shown. That residual is recorded.
function lockAuth(raw, envFrom) {
  const norm = (h) => rawHeaderFirst(raw, h).replace(/\s+/g, " ").toLowerCase().trim();
  const ar = norm("authentication-results"), arc = norm("arc-authentication-results").replace(/^i=\d+;\s*/, "");
  if (!ar.startsWith("mx.cloudflare.net;")) return { key: null, bad: ar ? "the first Authentication-Results is not Cloudflare's" : "no Authentication-Results" };
  if (!arc.startsWith("mx.cloudflare.net;")) return { key: null, bad: arc ? "the first ARC-Authentication-Results is not Cloudflare's" : "no ARC-Authentication-Results" };
  const from = rawFromAddr(raw); if (!from) return { key: null, bad: null };
  const k1 = lockVerdict(ar, from, envFrom), k2 = lockVerdict(arc, from, envFrom);
  if (k1 !== k2) return { key: null, bad: `Cloudflare's two stamps disagree (${k1 || "none"} / ${k2 || "none"})` };
  return { key: k1, bad: null };
}
// Is this address already in use, so that a lock appearing on it now would keep out people who write to it today? A sending
// identity, or any message to or from it. Only an unused address may lock itself (the app's POST /api/locks refuses the same).
async function lockAddressInUse(db, address) {
  return !!(await db.prepare("SELECT 1 x FROM identities WHERE email = ?").bind(address).first()) || !!(await db.prepare("SELECT 1 x FROM messages WHERE identity = ? LIMIT 1").bind(address).first());
}
// → null when no lock applies, else { kept, root, why }; `root` is the sender's lock key (lockKey). Runs in projectInbound, after the
// R2 commit point, so it can only file mail, never refuse it; the caller treats a throw as "no lock" (fail open), which is how the hub
// filed this mail before locks existed.
async function addressLock(env, { rcpt, raw, envFrom, inReplyTo, refs }) {
  const db = env.DB, [local, dom] = rcpt.split("@"), read = () => db.prepare("SELECT address, state, claim FROM address_locks WHERE address = ?").bind(rcpt).first();
  let row = await read();
  if (!row) {
    if (!LOCK_PATTERN.test(local || "") || !lockDomains(env).has(dom)) return null;
    // An x- address the user already sends from or receives at is in use: it is not armed by a stranger's mail.
    //  One the user SENDS from first is armed by lockNoteSent, for the people written to.
    if (await lockAddressInUse(db, rcpt)) return null;
    await db.prepare("INSERT OR IGNORE INTO address_locks (address, state, source, created_at) VALUES (?, 'active', 'pattern', ?)").bind(rcpt, now()).run();
    row = await read(); await logEvent(db, "lock_armed", null, rcpt);
  }
  if (!row || row.state === "released") return null;
  const { key: root, bad } = lockAuth(raw, envFrom);
  // Never seen (73 of 73 delivered messages carry both of Cloudflare's stamps, in agreement), and everything here rests on it.
  if (bad) await logEvent(db, "lock_cf_stamp_fail", null, `${rcpt}: ${bad}; treated as unauthenticated`);
  if (row.state === "active" && !row.claim) {
    // The first AUTHENTICATED sender claims it. Unauthenticated first mail is delivered as it always was and the address stays
    // unclaimed: holding it could hide the sign-up mail the address was given out for, and letting it claim would let a forged From win.
    if (!root) return { kept: false, root: null, why: "unclaimed" };
    await db.prepare("UPDATE address_locks SET claim = ?, claimed_at = ? WHERE address = ? AND claim IS NULL").bind(root, now(), rcpt).run();
    row = await read();   // conditional: two projections racing for the first claim leave exactly one winner
    if (row?.claim === root) { await logEvent(db, "lock_claimed", null, `${rcpt} by ${root}`); return { kept: false, root, why: "claimed" }; }
  }
  if (row.state === "active") {
    if (root && root === row.claim) return { kept: false, root, why: "claimer" };
    if (root && (await lockAllowed(db, rcpt, root))) return { kept: false, root, why: "allowed" };
    // A reply to mail the user sent FROM this address, from an authenticated sender (a forged From cannot use it). Those Message-IDs
    // are assigned by the send platform, 36 random characters, so only someone who received that mail, or was shown it, can cite one.
    // It lets this message in and adds no one to the allow list. In-Reply-To, then the NEWEST References: a long thread lists the
    // oldest first, and the user's last message is at the end.
    const ids = [...new Set([...parseIdList(inReplyTo), ...parseIdList(refs).slice(-49)])].slice(0, 50);
    if (root && ids.length && (await db.prepare(`SELECT 1 x FROM messages WHERE direction = 'out' AND identity = ? AND message_id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`).bind(rcpt, ...ids).first())) return { kept: false, root, why: "reply" };
  }
  return { kept: true, root, why: row.state === "closed" ? "closed" : "not the claimer" };
}
const lockAllowed = async (db, address, key) => !!(await db.prepare("SELECT 1 x FROM address_lock_allows WHERE address = ? AND domain = ?").bind(address, key).first());
// Bring kept-out messages back: each loses lock_kept and its label, and its thread (it has one of its own) goes to the inbox, unread.
// One batch, one transaction: one statement at a time, a failure between a message and its thread left the message let in and the
// thread archived, where nothing could find it again.
async function lockRelease(db, rows, extra = []) {
  const drop = (j) => { const a = JSON.parse(j || "[]").filter((l) => l !== "locked-out"); return a.length ? JSON.stringify(a) : null; };
  const stmts = [...extra]; const threads = [...new Set(rows.map((r) => r.thread_id))];
  for (const r of rows) stmts.push(db.prepare("UPDATE messages SET lock_kept = 0, labels = ? WHERE id = ?").bind(drop(r.labels), r.id));
  for (const t of threads) { const th = await db.prepare("SELECT labels FROM threads WHERE id = ?").bind(t).first(); stmts.push(db.prepare("UPDATE threads SET state = 'inbox', unread = 1, labels = ? WHERE id = ?").bind(drop(th?.labels), t)); }
  if (stmts.length) await db.batch(stmts);
  return threads;
}
// Mail the user sends from a locked address lets its recipients write back to it: their organizations, or at a personal mail
// provider the recipient's own address. Sending FIRST from an unused x- address gives it out: it is locked then, and belongs to the
// first person written to, so a stranger writing to it before they reply cannot claim it.
async function lockNoteSent(db, env, from, rcpts) {
  const addr = lc(from), [local, dom] = addr.split("@"); let row = await db.prepare("SELECT state, claim FROM address_locks WHERE address = ?").bind(addr).first();
  const own = await ownDomains(db, env);
  const keys = [...new Set(rcpts.map((a) => lc(addrOnly(a))).filter((a) => /^[^@\s]+@[^@\s]+$/.test(a) && !own.has(a.split("@")[1])).map((a) => lockKey(a, lockRoot(a.split("@")[1]))))];
  if (!row) {
    // The send has just been recorded, so "in use" here means a sending identity or mail this address has RECEIVED.
    if (!LOCK_PATTERN.test(local || "") || !lockDomains(env).has(dom) || (await db.prepare("SELECT 1 x FROM identities WHERE email = ?").bind(addr).first())
      || (await db.prepare("SELECT 1 x FROM messages WHERE identity = ? AND direction = 'in' LIMIT 1").bind(addr).first())) return;
    await db.prepare("INSERT OR IGNORE INTO address_locks (address, state, claim, source, created_at, claimed_at) VALUES (?, 'active', ?, 'pattern', ?, ?)").bind(addr, keys[0] || null, now(), keys[0] ? now() : null).run();
    await logEvent(db, "lock_armed", null, `${addr} (sent first${keys[0] ? `, claimed for ${keys[0]}` : ""})`);
    row = await db.prepare("SELECT state, claim FROM address_locks WHERE address = ?").bind(addr).first();
  }
  if (!row || row.state === "released") return;
  for (const k of keys) if (k !== row.claim) await db.prepare("INSERT OR IGNORE INTO address_lock_allows (address, domain, source, added_at) VALUES (?, ?, 'sent', ?)").bind(addr, k, now()).run();
}
async function projectInbound(env, raw, o) {
  const db = env.DB;
  const { id, at, rcpt, envFrom, hdrFrom, hdrFromDomain, subjectHdr, rawKey, forwardedAt } = o;
  let { hold, label } = o, copyWanted = o.copyWanted ?? true;   // copyWanted false: no Gmail copy by policy, which is "off", not a failure
  // The arrival could not read the rules, so it failed closed: held, no forward. The forward is gone with the
  // stream, but the record need not stay wrong: read the rule now. Mail that is not held gets its notification and label, and a
  // forward rule's missed copy is recorded as "none" (wanted, not sent) which the daily report flags.
  if (o.ruleKnown === false) {
    try { const r = (o.hdrAuth ? await matchRule(db, rcpt, hdrFrom) : null) || (await matchRule(db, rcpt, envFrom)); hold = r?.action === "hold"; label = r?.label || null; copyWanted = gmailCopyOn(env) || r?.action === "forward"; }
    catch (_) {}   // still unreadable: keep the fail-closed answer
  }

  // ONE identity, resolved once, used by every layer below it. The unique index is (message_id, direction, identity),
  // so that tuple - not raw_key - is what "is this message already stored?" means, and all three builder lanes
  //  named the three-different-keys split as the defect rather than any one of its symptoms.
  // The queue row may carry NO Message-ID: sweepUnindexedRaw builds it from R2 list() metadata, and objects written by
  // ingestRaw's own put never had a `msgid` key to carry. A NULL here skipped the precheck entirely, let the insert
  // collide on the Message-ID that ingestRaw parses out of the bytes, and left the row retrying for ever - 57 rows at
  // 154 attempts each on 2026-09-19. So resolve it from the bytes when the caller has none.
  // ONE parse, ONE identity, used by the precheck, the INSERT and the post-failure fact-check alike. Resolving it
  // twice is the defect three adversarial lanes named: ingestRaw stores
  // `(p?.messageId || o.msgIdHdr || fallback).trim()` from its OWN parse, so any independent resolution here that
  // disagrees on the same bytes (a different precedence, an untrimmed value, a header PostalMime normalises) makes
  // the precheck query a string the INSERT never wrote, and rebuilds the 154-attempt loop on the drain path.
  // The precedence below is ingestRaw's, character for character, and the parsed object is handed down so ingestRaw
  // does not parse again. That also removes a double parse the reconcile path was already paying.
  let parsed = o.parsed || null;
  if (!parsed && raw.byteLength <= INBOUND_PARSE_MAX) { try { parsed = await parseMail(raw); } catch (_) { parsed = null; } }
  const msgIdHdr = ((parsed?.messageId || o.msgIdHdr || "")).trim() || null;
  // An empty identity is not an identity. The unique index is partial on message_id and scoped by `identity`, so a row
  // inserted with identity '' is caught by nothing and filed under no account. handleInbound always has the envelope
  // recipient; reconcileInbound recovers it from R2 customMetadata. If BOTH are empty there is nothing to file this
  // under, and staying queued and visible in the daily report beats becoming a row nobody can find. Before the fix
  // above this branch was unreachable only by accident - the insert happened to collide first.
  // Named with "fail" deliberately: the daily report's failure line filters events on /fail/, so a kind without it is
  // invisible, and an invisible permanently-retrying row is the exact shape of the defect this record is fixing.
  // (The stuck row is also printed by integrityLines with its error text, which is how the original 57 were found.)
  if (!rcpt) { await logEvent(db, "project_fail_no_recipient", id, rawKey); throw new Error(`no recipient resolved for ${rawKey}`); }

  // Already indexed? A sender retry or a replay must never insert the message twice.
  const identityRow = async () => (msgIdHdr
    ? await db.prepare("SELECT id FROM messages WHERE message_id = ? AND direction = 'in' AND identity = ? LIMIT 1").bind(msgIdHdr, rcpt).first()
    : null);
  const dup = await identityRow();
  if (dup) { await logEvent(db, "duplicate_ignored", dup.id, msgIdHdr); return; }
  // Deliberately deleted, by IDENTITY rather than by key: purge can only delete the copy it knows about, and a message
  // may have had a second object holding its bytes (importResend wrote two until 2026-09-20). Asking about the key
  // alone let that twin refile a purged message as if it were newly accepted mail. Re-delivery of a Message-ID the user
  //  purged is the same message arriving again, and it stays gone.
  if (await isDisposed(db, { msgId: msgIdHdr, identity: rcpt })) {
    await logEvent(db, "purged_not_reprojected", id, `${rawKey} ${msgIdHdr || "-"}`); return;
  }
  const already = await db.prepare("SELECT id FROM messages WHERE raw_key = ? LIMIT 1").bind(rawKey).first();
  if (already) { await logEvent(db, "duplicate_ignored", already.id, rawKey); return; }
  // The SELECT above is a precheck, not a guarantee: two projections can both pass it before either inserts, which is
  // why ux_messages_raw_key exists. But a constraint violation there means the OTHER one won - the message IS indexed -
  // so it must be treated as dedup succeeding. Rethrowing left the queue row retrying a conflict that can never clear,
  // which is the attempts-cap failure mode relocated one layer down (four reviewers).
  // Deciding "this was just a duplicate" by matching /UNIQUE|constraint/ against an error STRING classified any
  // FK, CHECK or NOT NULL failure (or anything merely mentioning those words) as success, draining the queue row
  // while the message stayed unindexed (four reviewers; a defect the previous round's fix
  // introduced). So the question is answered with a FACT instead: after a failed insert, is the row actually there?
  // ..and the FACT it checks must be about the IDENTITY that collided, not about the key this particular replay
  // happened to carry. Asking only about raw_key could say yes only for a row this same key had already written, so a
  // replay from a SECOND copy of the same bytes - exactly what importResend used to create - rethrew for ever on a
  // conflict that was, in truth, dedup succeeding. The raw_key arm stays: ux_messages_raw_key is what guards the
  // insert-race for mail with no Message-ID at all, which the tuple index (partial on message_id) cannot cover.
  const indexedAlready = async () => !!(await identityRow()) || !!(await db.prepare("SELECT 1 x FROM messages WHERE raw_key = ? LIMIT 1").bind(rawKey).first());

  // Address locks, decided before ingestRaw can thread or file the message, by the same code on arrival and on the
  // reconciler's replay. Fails open: an error is logged and the message is filed as it was before locks existed.
  let lock = null;
  try { lock = await addressLock(env, { rcpt, raw, envFrom, inReplyTo: parsed?.inReplyTo || o.inReplyToHdr, refs: parsed?.references || o.refsHdr }); }
  catch (e) { lock = null; try { await logEvent(db, "lock_fail_open", id, `${rcpt} ${String(e?.message || e).slice(0, 200)}`); } catch (_) {} }
  const kept = lock?.kept ? { root: lock.root, why: lock.why } : null;

  // Containment is ADVISORY now. It used to decide whether the bytes were stored at all, and a cap that suppressed the
  // only durable copy was the defect. The bytes are already in R2, so all this can do is skip parsing and label the
  // message. The per-message `SELECT SUM(size_bytes) FROM messages` full scan went with it: rows read counts rows
  // SCANNED, so that query cost one row per stored message on every single delivery and grew without bound. The storage
  // cap it fed is a reporting concern and belongs in the daily report, where one scan a day is affordable.
  const envDomain = envFrom.split("@")[1] || envFrom;
  // Per ORGANISATION, not per exact domain, and in bytes as well as mails: a fresh subdomain for every mail
  // (s1.attacker.example, s2…) was a new sender each time, and at up to 900k characters of text and of HTML per parsed mail one sender
  // could add about half a GB of D1 an hour. Past either limit a mail is stored as received and not parsed, as before.
  // The From side counts only when DMARC proves it: a forged "From: …@gmail.com" (p=none, so delivered) spent
  // the budget every real gmail.com sender shares. Unproven, the mail counts toward its envelope sender, which SPF or DKIM vouched for.
  const envRoot = lockRoot(envDomain), fromRoot = (o.hdrAuth && lockRoot(hdrFromDomain)) || envRoot;
  const burst = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM messages WHERE direction='in' AND ingest_source='cloudflare' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')
      AND (env_from LIKE ? OR env_from LIKE ? OR from_addr LIKE ? OR from_addr LIKE ? OR env_from LIKE ? OR env_from LIKE ? OR from_addr LIKE ? OR from_addr LIKE ?)`)
    .bind(`%@${envRoot}`, `%.${envRoot}`, `%@${envRoot}`, `%.${envRoot}`, `%@${fromRoot}`, `%.${fromRoot}`, `%@${fromRoot}`, `%.${fromRoot}`).first();
  const hourBytes = (await db.prepare("SELECT COALESCE(SUM(size_bytes),0) b FROM messages WHERE direction='in' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").first()).b;
  const rateLimited = burst.n >= INBOUND_BURST_PER_HOUR || burst.b + raw.byteLength > INBOUND_ROOT_BYTES_PER_HOUR;
  const overBudget = hourBytes + raw.byteLength > INBOUND_BYTES_PER_HOUR;
  if (rateLimited) await logEvent(db, "inbound_rate_limited", id, `${envDomain}/${hdrFromDomain} (${envRoot}/${fromRoot}) ${burst.n}/h ${burst.b}B/h`);
  if (overBudget) await logEvent(db, "inbound_over_budget", id, `hour=${hourBytes} size=${raw.byteLength}`);

  let ingested = null;
  try {
  ingested = await ingestRaw(env, raw, { id, at, rcpt, envFrom, source: "cloudflare", rawKey, gmailForwardedAt: forwardedAt, gmailCopy: hold ? "held" : (forwardedAt ? "hub" : (copyWanted ? "none" : "off")), label: kept ? "locked-out" : rateLimited ? "rate-limited" : (overBudget ? "over-budget" : label), kept, trashRules: trashRulesLoader(db), mentionRules: mentionRulesLoader(db), impostorKnown: () => impostorKnown(env), subjectHdr, msgIdHdr, parsed, storeOnly: raw.byteLength > INBOUND_PARSE_MAX || rateLimited || overBudget });
  } catch (e) {
    // Only a genuinely present row means the other side won. Anything else is a real failure and must stay queued.
    if (!(await indexedAlready())) throw e;
    await logEvent(db, "duplicate_ignored", id, `${rawKey} (lost the insert race)`);
    return;
  }
  await logEvent(db, hold ? "inbound_held" : (forwardedAt || !copyWanted ? "inbound_ok" : "inbound_stored_forward_failed"), id, `${rcpt} <- ${envFrom}${label ? " [" + label + "]" : ""}`);

  // Kept out by an address lock: filed on its own thread, archived and read (ingestRaw), with no push. The gatekeeper does not run
  // either: its block trashes the whole thread, and the 30-day purge would then delete mail that may be wanted.
  if (kept) {
    await logEvent(db, "lock_kept_out", id, `${rcpt} <- ${addrOnly(hdrFrom || envFrom)} [${kept.root || "unauthenticated"}] ${kept.why}`);
    // The user may have let this sender in while it was being filed (the allow route read the kept messages before this one existed).
    // Checked now that it is stored, so one of the two sides always sees the other.
    try { if (kept.root && (await lockAllowed(db, rcpt, kept.root))) { const r = await db.prepare("SELECT id, thread_id, labels FROM messages WHERE id = ? AND lock_kept = 1").bind(id).first(); if (r) { await lockRelease(db, [r]); await logEvent(db, "lock_allowed_late", id, `${rcpt} + ${kept.root}`); } } } catch (_) {}
    return;
  }
  // Trashed by one of the user's rules: filed in Trash on a conversation of its own (ingestRaw), with no push, no gatekeeper and no
  // still-mailing note. The rule counts it.
  if (ingested?.trashRule) { await trashHit(db, ingested.trashRule, `${rcpt} <- ${addrOnly(hdrFrom || envFrom)}`, id); return; }
  if (ingested?.mentionDrop) return;   // a "Delete unless it mentions…" rule filed it in Trash: no push, no gatekeeper
  // An impostor: filed in Spam (ingestRaw), no push, and no gatekeeper, so its sender is not recorded.
  if (ingested?.impostor) { await logEvent(db, "impostor_spam", id, `${rcpt} <- ${addrOnly(hdrFrom || envFrom)}: ${impostorWhy(ingested.impostor)} | ${String(subjectHdr || "").slice(0, 120)}`); return; }

  // Gatekeeper + push (content stays in the hub's own store; the push carries only the account, sender and subject)
  try {
    const { results: rules } = await db.prepare("SELECT pattern, action, scope, category FROM sender_rules").all();
    const rule = matchSender(rules, addrOnly(hdrFrom || envFrom), rcpt);
    const senderStatus = await touchSender(db, addrOnly(hdrFrom || envFrom), rcpt, rules);
    if (rule?.action !== "block") await unsubNoteArrival(db, unsubJobsLoader(db), addrOnly(hdrFrom || envFrom), subjectHdr, Date.now(), id);   // still mailing after an unsubscribe?
    // The stored row carries the parsed (decoded) subject and display name. The raw header is RFC 2047-encoded when the subject is not
    // plain ASCII ("=?utf-8?Q?Blue=20Widget...?="), so it is only the fallback for a message that has no row.
    const th = await db.prepare("SELECT thread_id, category, subject, from_name, from_addr, snippet FROM messages WHERE id = ?").bind(id).first();
    const subj = th ? th.subject ?? "" : subjectHdr, fromShown = th?.from_name ? `${th.from_name} <${th.from_addr || addrOnly(hdrFrom || envFrom)}>` : hdrFrom || envFrom;
    if (rule?.action === "block" && senderStatus !== "accepted" && th) { await db.prepare("UPDATE threads SET state = 'trash', labels = ? WHERE id = ?").bind(addLabel((await db.prepare("SELECT labels FROM threads WHERE id = ?").bind(th.thread_id).first())?.labels, "blocked"), th.thread_id).run(); await logEvent(db, "gatekeeper_blocked", id, `${rcpt} <- ${addrOnly(hdrFrom || envFrom)}`); }
    else if (!hold && shouldNotify(await notifyPolicy(env), { category: th?.category || "personal", rule, fromAddr: addrOnly(hdrFrom || envFrom), senderStatus, account: rcpt })
      && !(await (async () => { const q = quietMatch(await quietRules(env), addrOnly(hdrFrom || envFrom), subj); if (q) await quietHit(env, q, `hub ${addrOnly(hdrFrom || envFrom)}`); return q; })())) ctxWaitUntil((async () => sendPush(env, mailPush(await notifyPreview(env), { kind: "hub", account: "hub", label: rcpt, thread: th?.thread_id, from: fromShown, subject: subj, snippet: th?.snippet, priority: rule?.action === "priority" }), { urgency: rule?.action === "priority" ? "high" : "normal" }))());
  } catch (e) { await logEvent(db, "push_fail", id, e?.message); }
}

// Replay the D1 projection for objects whose first attempt failed. Accepting a message we could not index is only honest
// because THIS runs: the bytes are the record, and this is what turns a D1 outage into a delay instead of an inbox that
// silently misses mail. Bounded per minute so a backlog drains steadily without crowding the rest of the cron.
const RECONCILE_TRIES = 3;   // tries in the minute cron; after that a row is retried once an hour, last in the cron (`stuck`)
export async function reconcileInbound(env, limit = 5, { stuck = false } = {}) {
  const db = env.DB;
  // NO terminal state. `WHERE attempts < 8` put a row into a terminal state that the sweep then skipped as well (it
  // declines any key already in pending_ingest), so a deterministically failing projection left the message accepted
  // with a 250, durable in R2, and invisible forever. Five of seven reviewers found that independently.
  //  A row that fails RECONCILE_TRIES times moves to the hourly retry instead, and the daily report
  // calls out anything that keeps failing.
  // The try is counted BEFORE the work. Counted only in the catch, a projection killed for CPU (which
  // runs no catch) stayed at attempts 0, sorted first, and was retried and killed every minute, taking every step after
  // this one in the cron with it.
  const { results } = await db.prepare(`SELECT raw_key, rcpt, env_from, message_id, at, attempts FROM pending_ingest WHERE attempts ${stuck ? ">=" : "<"} ? ORDER BY attempts ASC, at ASC LIMIT ?`).bind(RECONCILE_TRIES, limit).all();
  let done = 0;
  for (const row of results) {
    try {
      await db.prepare("UPDATE pending_ingest SET attempts = attempts + 1 WHERE raw_key = ?").bind(row.raw_key).run();
      // A purge can land while this row is already queued; replaying it would put the message back. Drop the row, do
      // not record a loss - the bytes going away is the point of a purge, not an accident.
      if (await isDisposed(db, { rawKey: row.raw_key })) {
        await db.prepare("DELETE FROM pending_ingest WHERE raw_key = ?").bind(row.raw_key).run();
        continue;
      }
      const obj = await env.STORE.get(row.raw_key);
      if (!obj) { // Accepted mail whose bytes are gone. Nothing can be replayed, but deleting the row quietly erased the
        // only evidence it was ever owed, so this is recorded as a loss and surfaced by the daily report instead.
        // Log FIRST, delete second. The other order meant a D1 failure between the two erased the only record that this
        // message was ever owed - restoring the exact silence this branch exists to break.
        await logEvent(db, "LOST_accepted_but_no_object", null, `${row.raw_key} rcpt=${row.rcpt} msgid=${row.message_id || "-"}`);
        await db.prepare("DELETE FROM pending_ingest WHERE raw_key = ?").bind(row.raw_key).run();
        continue;
      }
      const raw = await obj.arrayBuffer();
      const meta = obj.customMetadata || {};
      const p = await parseMail(raw).catch(() => null);
      const rcpt = lc(row.rcpt || meta.rcpt || "");
      const envFrom = lc(row.env_from || meta.envFrom || "");
      const hdrFrom = lc(addrList(p?.from)[0]?.address || envFrom);
      let rule = null; try { rule = (await matchRule(db, rcpt, hdrFrom)) || (await matchRule(db, rcpt, envFrom)); } catch (_) {}
      await projectInbound(env, raw, {
        id: uuid(), at: meta.at || row.at || now(), rcpt, envFrom, hdrFrom,
        hdrFromDomain: hdrFrom.split("@")[1] || "", subjectHdr: p?.subject || "",
        // `p` is already parsed three lines up, so the Message-ID costs nothing to pass and is the only place the
        // identity survives for an object whose customMetadata never carried one (everything ingestRaw put there).
        msgIdHdr: row.message_id || meta.msgid || p?.messageId || null, rawKey: row.raw_key, parsed: p,
        hold: rule?.action === "hold", label: rule?.label || null, forwardedAt: meta.fwd || null,
        // the arrival's decision when the object carries it; the current policy only for objects written before it did
        copyWanted: meta.copy === "1" ? true : meta.copy === "0" ? false : (gmailCopyOn(env) || rule?.action === "forward"),
        inReplyToHdr: p?.inReplyTo || null, refsHdr: p?.references || null, dateHdr: p?.date || null,
      });
      await db.prepare("DELETE FROM pending_ingest WHERE raw_key = ?").bind(row.raw_key).run();
      // If the message turned out to be already indexed under a DIFFERENT key, this object is a duplicate copy and
      // nothing references it. Retiring the queue row alone leaves it for the next FULL sweep to re-enqueue and this
      // drain to re-retire, weekly, for ever. Recording the disposition ends that loop without deleting any bytes:
      // deletion is irreversible and stays a separate, manually approved step.
      if (!(await db.prepare("SELECT 1 x FROM messages WHERE raw_key = ? LIMIT 1").bind(row.raw_key).first())) {
        try { await db.prepare("INSERT OR IGNORE INTO purged_keys (raw_key, reason, at) VALUES (?, 'duplicate', ?)").bind(row.raw_key, now()).run(); } catch (_) {}
      }
      await logEvent(db, "reconciled", null, row.raw_key);
      done++;
    } catch (e) {
      await db.prepare("UPDATE pending_ingest SET error = ? WHERE raw_key = ?").bind(String(e?.message || e).slice(0, 300), row.raw_key).run();
    }
  }
  return done;
}

// The safety net UNDER pending_ingest. That row is written to D1, so a D1 outage bad enough to break the projection can
// also lose the note saying the projection is owed. Once a day, walk this month's and last month's raw objects and
// enqueue any that have no message row. Bounded by the month prefix, and cheap because ix_messages_raw_key exists.
export async function sweepUnindexedRaw(env, full = false) {
  const db = env.DB;
  // "this month and last month" by the CALENDAR, not by subtracting 15 days - which from the 16th onward resolved to
  // the current month twice and silently stopped covering the previous one (four reviewers).
  const mk = (d) => `raw/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/`;
  // SWEEP_MONTHS is the recovery horizon: an object older than this with no pending_ingest row is never looked at
  // again.
  const nowD = new Date();
  // `full` walks the WHOLE bucket instead of recent months. SWEEP_MONTHS is a horizon, and a horizon is a loss bound:
  // an outage longer than it leaves accepted, durable, permanently unindexed mail.
  // Running the unbounded version weekly makes the real bound seven days rather than four months.
  // `resend/` joins the full walk. importResend now puts the bytes there BEFORE ingestRaw, so an ingestRaw failure
  // leaves a durable object under a prefix nothing swept: "durable in R2 and invisible for ever", the one state this
  // whole path exists to prevent. Objects that ARE referenced by
  // messages.raw_key are skipped by the check below, so this adds no work for the 57 healthy imports.
  const prefixes = full ? ["raw/", "resend/"] : [...new Set(Array.from({ length: SWEEP_MONTHS }, (_, i) => mk(new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - i, 1)))))];
  // The full walk is UNBOUNDED, serial and ran inside one cron invocation, so a timeout mid-listing left no record and
  // no completion, which made the claimed seven-day bound unprovable. It is resumable now: at
  // most SWEEP_PAGE_MAX pages per run, with the cursor persisted, so a long bucket is finished across successive runs
  // instead of restarting from the beginning and never reaching the tail.
  let found = 0, pages = 0, exhausted = true;
  const cursorKey = full ? "raw_sweep_cursor_full" : null;
  let resume = cursorKey ? (await db.prepare("SELECT value FROM prefs WHERE key = ?").bind(cursorKey).first().catch(() => null))?.value || undefined : undefined;
  for (const prefix of prefixes) {
    let cursor = resume; resume = undefined;
    do {
      if (++pages > SWEEP_PAGE_MAX) { exhausted = false; break; }
      // `include` is REQUIRED for customMetadata: Cloudflare's Workers API reference says a list() is treated as
      // include: ['httpMetadata','customMetadata'] only when the compatibility date is BEFORE 2022-08-04, and this
      // Worker is on 2026-09-01. So every row this sweep enqueued carried rcpt '', env_from '' and `at` = the sweep's
      // own clock, which is exactly the shape of the 57 rows found stuck on 2026-09-19. The drain recovers the
      // recipient from STORE.get(), which does return it - but the queue row should carry the truth in the first place.
      const list = await env.STORE.list({ prefix, limit: 200, cursor, include: ["customMetadata"] });
      cursor = list.truncated ? list.cursor : undefined;
      for (const o of list.objects) {
        if (await db.prepare("SELECT 1 x FROM messages WHERE raw_key = ? LIMIT 1").bind(o.key).first()) continue;
        if (await db.prepare("SELECT 1 x FROM pending_ingest WHERE raw_key = ? LIMIT 1").bind(o.key).first()) continue;
        // Deliberately deleted, or already retired as a duplicate copy: neither is "never indexed", and the key
        // alone cannot tell any of the three apart.
        if (await isDisposed(db, { rawKey: o.key })) continue;
        const m = o.customMetadata || {};
        await db.prepare("INSERT OR IGNORE INTO pending_ingest (raw_key, rcpt, env_from, message_id, at) VALUES (?, ?, ?, ?, ?)")
          .bind(o.key, m.rcpt || "", m.envFrom || "", m.msgid || null, m.at || now()).run();
        await logEvent(db, "sweep_unindexed", null, o.key);
        found++;
      }
    } while (cursor);
    if (!exhausted) { if (cursorKey) { try { await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(cursorKey, String(cursor || ""), now()).run(); } catch (_) {} } break; }
  }
  if (cursorKey && exhausted) { try { await db.prepare("DELETE FROM prefs WHERE key = ?").bind(cursorKey).run(); } catch (_) {} }
  // A silently dead sweep turns the horizon into the real loss bound, so each run records itself and the daily report
  // prints it. The full run gets its OWN key: sharing one meant the daily recent run overwrote it, and a full sweep
  // that had not completed for months looked healthy.
  try { await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(full ? "last_raw_sweep_full" : "last_raw_sweep_recent", `${now()} found=${found} ${exhausted ? "complete" : "PARTIAL, will resume"}`, now()).run(); } catch (_) {}
  return found;
}

// Store one raw RFC 822 message: R2 raw, postal-mime parse, D1 rows, thread at ingest. Returns the message id.
async function ingestRaw(env, raw, o) {
  const db = env.DB;
  const id = o.id || uuid();
  const at = o.at || now();
  const rcpt = lc(o.rcpt);
  // A copy read from a work mailbox's Sent folder is my own mail: stored as sent, under out/ where the R2
  // sweep never replays it as inbound mail, and it neither marks its conversation unread nor brings it back to the inbox.
  const out = o.direction === "out";
  // handleInbound writes the R2 object BEFORE any D1 work and passes its key down; a replay from the reconciler must not
  // write those bytes a second time. Only a caller with no key of its own (the Resend importer) stores here.
  const rawKey = o.rawKey || `${out ? "out" : "raw"}/${at.slice(0, 4)}/${at.slice(5, 7)}/${id}.eml`;
  if (!o.rawKey) await env.STORE.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { rcpt, envFrom: o.envFrom || "", at, source: o.source || "" } });

  let p = null;
  if (o.storeOnly) await logEvent(db, "store_only_oversize", id, String(raw.byteLength));
  // `o.parsed` is projectInbound's parse of these same bytes. Reusing it is what makes the Message-ID this function
  // stores identical to the one the caller deduplicated on: two parses meant two chances to disagree.
  else { p = o.parsed || null; if (!p) { try { p = await parseMail(raw); } catch (e) { await logEvent(db, "parse_fail", id, e?.message); } } }

  const from = p ? addrList(p.from)[0] : null;
  const tos = p ? addrList(p.to) : [];
  const ccs = p ? addrList(p.cc) : [];
  const replyTo = p ? addrList(p.replyTo)[0]?.address || null : null;
  // Kept on one line: these four go back out in the user's replies, and a decoded CR/LF in them was a header and a
  // body the sender wrote into that reply (a subject's made every reply to the mail fail with "subject contains a line break").
  const subject = oneHdr(p?.subject ?? (o.subjectHdr || ""));
  const text = p?.text || "";
  const html = p?.html || "";
  const inReplyTo = oneHdr(p?.inReplyTo || o.inReplyToHdr || "").trim() || null;
  const refs = oneHdr(p?.references || o.refsHdr || "").trim() || null;
  const messageId = hdrId(p?.messageId || o.msgIdHdr) || `<mailhub-${id}@${rcpt.split("@")[1] || "mailhub"}>`;
  const dateHdr = p?.date || o.dateHdr || null;
  const snippet = previewOf(text, html);

  const own = await ownDomains(db, env);
  const participantsAll = [from?.address || o.envFrom, ...tos.map((a) => a.address), ...ccs.map((a) => a.address), rcpt].filter(Boolean);
  const participants = externalParticipants(participantsAll, own);
  const subjectNorm = normSubject(subject);
  // Trash rules, for the callers that pass them (Cloudflare and the work mailbox): decided on the parsed sender name and
  // subject before the message is threaded. Fails open: rules that cannot be read file the message as before.
  let trashRule = null;
  if (!o.kept && o.trashRules) { try { trashRule = trashMatch(await o.trashRules(), { name: from?.name || "", subject, account: rcpt }); } catch (_) { trashRule = null; } }
  // An impostor, for the caller that asks (Cloudflare): filed in Spam on a conversation of its own, unannounced.
  let impostor = null;
  if (!o.kept && !trashRule && !out && o.impostorKnown) { try { impostor = impostorOf(from?.name || "", from?.address || o.envFrom || "", await o.impostorKnown()); } catch (_) { impostor = null; } }
  // "Delete unless it mentions…" on mail at your own domains and the work mailbox: a rule scoped "hub" covering the
  // sender, decided on the parsed text as mentionDecide decides a Gmail message. A word keeps it (and it is announced as usual); almost
  // no text of its own keeps it; a reply in a conversation you wrote in is left; otherwise it is filed in Trash on a conversation of its
  // own, as a trash rule's match is, unannounced. Fails open: rules that cannot be read file the message as before.
  let mention = null;
  if (!o.kept && !trashRule && !impostor && !out && p && o.mentionRules) {
    try {
      const rules = (await o.mentionRules()).filter((r) => r.scope === MENTION_HUB), sender = from?.address || o.envFrom || "";
      const r = rules.length ? matchMention(rules, sender, MENTION_HUB) : null;
      if (r) {
        const scan = mentionScan({ subject, plain: text ? [text] : [], html: html ? [html] : [] }, r.words, await ownAddresses(env));
        let decision = scan.hit ? "kept" : scan.chars < MENTION_MIN_TEXT ? "unread" : "dropped";
        if (decision === "dropped") { const prior = await resolveThread(db, { inReplyTo, references: refs, subjectNorm, participants }); if (prior && (await db.prepare("SELECT 1 x FROM messages WHERE thread_id = ? AND direction = 'out' LIMIT 1").bind(prior).first())) decision = "left"; }
        mention = { rule: r, decision, sender };
      }
    } catch (_) { mention = null; }
  }
  const mentionDrop = mention?.decision === "dropped";
  const label = trashRule ? "trash-rule" : mentionDrop ? "mention-rule" : impostor ? "impostor" : o.label;
  // Mail an address lock kept out gets a thread of its own, created archived: it never joins, revives or moves a
  // conversation that holds wanted mail, and archived is out of the inbox without being purged as trash is after 30 days.
  // Mail a trash rule matched gets one too, created in Trash: it never joins, revives or trashes a wanted conversation.
  const tw = o.kept ? threadWrite(db, null, { subjectNorm, participants, at, newState: "archived" })
    : trashRule || mentionDrop ? threadWrite(db, null, { subjectNorm, participants, at, newState: "trash" })
    : impostor ? threadWrite(db, null, { subjectNorm, participants, at, newState: "spam" })
    : threadWrite(db, await resolveThread(db, { inReplyTo, references: refs, subjectNorm, participants }), { subjectNorm, participants, at, newState: out ? "archived" : "inbox" }); const threadId = tw.id;

  const gmailCopy = o.gmailCopy || (o.gmailForwardedAt ? "hub" : "none");
  const labels = label ? JSON.stringify([label]) : null;
  await db.batch([tw.stmt, db.prepare(`INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, env_from, reply_to, to_addrs, cc_addrs, subject, message_id, in_reply_to, refs, body_text, body_html, snippet, raw_key, size_bytes, status, ingest_source, gmail_forwarded_at, gmail_copy, labels, date_hdr, created_at, lock_kept, lock_root)
    VALUES (?, ?, '${out ? "out" : "in"}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${out ? "sent" : "received"}', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, threadId, rcpt, from?.address || o.envFrom || "", from?.name || "", lc(o.envFrom || ""), replyTo, JSON.stringify(tos), JSON.stringify(ccs), subject, messageId, inReplyTo, refs, text.slice(0, BODY_CAP), html.slice(0, BODY_CAP), snippet, rawKey, raw.byteLength, o.source || "cloudflare", o.gmailForwardedAt || null, gmailCopy, labels, dateHdr, at, o.kept ? 1 : 0, o.kept?.root || null)])   /* the conversation and its message land together or not at all */;
  // A new inbound message marks the thread unread, adds its label, and pulls an archived or trashed thread back to the inbox. Trash
  // used to stay trash, so a reply to a conversation the user had deleted was stored and never shown anywhere but Trash; Gmail
  // brings that conversation back, and so does this . A blocked sender's mail is unaffected: the gatekeeper
  // runs after this projection and trashes the thread again. Images are still not prefetched for it (the check below reads `th`,
  // the state BEFORE this update), so a reply that revives a trashed thread tells its sender nothing until it is opened.
  const th = await db.prepare("SELECT labels, state, last_message_at FROM threads WHERE id = ?").bind(threadId).first();
  // Only the NEWEST message of a conversation marks it unread and brings it back from Archive or Trash. An older one (a backfill of
  // a work mailbox, a late copy) joins it quietly: importing 160 old messages must not resurrect what was put away.
  const newest = !th?.last_message_at || String(at) >= String(th.last_message_at);
  const lift = newest && !o.kept && !trashRule && !mentionDrop && !impostor && !out;   // kept-out, rule-trashed and sent mail neither marks its thread unread nor brings it to the inbox
  const hdrs = {}; try { for (const hh of (p?.headers || [])) hdrs[lc(hh.key)] = hh.value; } catch (_) {}
  const { results: catRules } = await db.prepare("SELECT pattern, action, scope, category FROM sender_rules WHERE category IS NOT NULL").all();
  const category = categorizeHeaders(hdrs, from?.address || o.envFrom || "", matchSender(catRules, from?.address || o.envFrom || "", rcpt));
  // The receiving server's own sender verdict: the FIRST Authentication-Results Cloudflare stamped. Receivers prepend,
  // so a header the sender wrote further down can never be the first one carrying mx.cloudflare.net's name.
  // Only on mail Cloudflare received: a work mailbox read over IMAP stamps none, so the first "mx.cloudflare.net" stamp
  // there was one the SENDER wrote: a forged dmarc=pass the trust panel believed.
  let authTop = null; if (!/^imap/.test(o.source || "")) try { authTop = (p?.headers || []).find((hh) => lc(hh.key) === "authentication-results" && /^\s*mx\.cloudflare\.net\b/i.test(String(hh.value || "")))?.value || null; } catch (_) {}
  await db.prepare("UPDATE messages SET category = ?, list_unsubscribe = ?, list_unsubscribe_post = ?, auth_results = ? WHERE id = ?").bind(category, (hdrs["list-unsubscribe"] || "").slice(0, 500) || null, (hdrs["list-unsubscribe-post"] || "").slice(0, 100) || null, authTop ? String(authTop).slice(0, 2000) : null, id).run();
  await db.prepare("UPDATE threads SET unread = CASE WHEN ? THEN 1 ELSE unread END, labels = ?, category = CASE WHEN ? THEN ? ELSE category END, state = CASE WHEN ? AND state IN ('archived', 'trash') THEN 'inbox' ELSE state END WHERE id = ?").bind(lift ? 1 : 0, addLabel(th?.labels, label), newest && !out ? 1 : 0, category, lift ? 1 : 0, threadId).run();   // a sent copy leaves the category to the mail it answers

  if (p?.attachments?.length) {
    let n = 0;
    if (p.attachments.length > ATTACHMENT_MAX_COUNT) await logEvent(db, "attachments_capped", id, String(p.attachments.length));
    for (const a of p.attachments.slice(0, ATTACHMENT_MAX_COUNT)) {
      n += 1;
      const key = `att/${id}/${n}-${safeName(a.filename)}`;
      const bytes = a.content instanceof ArrayBuffer ? a.content : new TextEncoder().encode(String(a.content || ""));
      await env.STORE.put(key, bytes, { httpMetadata: { contentType: a.mimeType || "application/octet-stream" } });
      await db.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(uuid(), id, a.filename || `${a.disposition === "inline" ? "inline" : "attachment"}-${n}${({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf" })[(a.mimeType || "").toLowerCase()] || ""}`, a.mimeType || null, bytes.byteLength, key, a.contentId || null, a.disposition || null).run();
    }
  }
  // The images of mail that reaches the inbox are fetched now, while nobody is reading it; never for held, blocked,
  // rate-limited, over-budget or unparsed mail, or a thread already in trash or spam.
  if (html && !out && !o.storeOnly && o.gmailCopy !== "held" && !["trademark-scam", "blocked", "rate-limited", "over-budget", "locked-out", "trash-rule", "mention-rule", "impostor"].includes(label) && !["trash", "spam"].includes(th?.state)) ctxWaitUntil(prefetchImages(env, html, `hub:${id}`, { from: from?.address }));
  if (mention) {
    try { await db.batch([db.prepare("INSERT INTO mention_decisions (account, id, rule_id, decision, from_addr, subject, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, id) DO NOTHING").bind(MENTION_HUB, id, mention.rule.id, mention.decision, lc(mention.sender), String(subject || "").slice(0, 300), now()),
      db.prepare(`UPDATE mention_rules SET ${mentionDrop ? "dropped = dropped + 1" : "kept = kept + 1"}, last_at = ? WHERE id = ?`).bind(now(), mention.rule.id)]); }
    catch (e) { await logEvent(db, "mention_record_fail", id, `hub ${mention.decision}: ${String(e?.message || e).slice(0, 120)}`); }
    await logEvent(db, "mention_" + mention.decision, id, `${rcpt} <- ${lc(mention.sender)} | ${String(subject || "").slice(0, 120)}`);
  }
  return { id, threadId, messageId, trashRule, mentionDrop, impostor };
}

// Bridge/backfill from a Resend Receiving account: pull every received email not already held (by Message-ID),
// download the original.eml through Resend's signed URL and ingest it. Gmail copies for these were (or were not)
// made by the legacy webhook Workers; we do not forward again.
export async function importResend(env, account, opts = {}) {   // exported so test/ingest.mjs can execute the root cause, not just its symptom
  const key = account === "domain2" ? env.RESEND_KEY_DOMAIN2 : account === "domain3" ? env.RESEND_KEY_DOMAIN3 : null;
  if (!key) throw new Error("unknown account or key not set: " + account);
  const H = { Authorization: `Bearer ${key}` };
  const list = await (await fetch(`https://api.resend.com/emails/receiving?limit=${opts.limit || 100}`, { headers: H })).json();
  const items = list.data || [];
  const out = { account, listed: items.length, imported: 0, skipped: 0, failed: 0, ids: [] };
  for (const it of items) {
    try {
      const seen = await env.DB.prepare("SELECT id FROM messages WHERE ingest_source = 'resend' AND raw_key LIKE ? LIMIT 1").bind(`%/${it.id}.eml`).first();
      if (seen) { out.skipped++; continue; }
      const d = await (await fetch(`https://api.resend.com/emails/receiving/${it.id}`, { headers: H })).json();
      const dupById = d.message_id ? await env.DB.prepare("SELECT id FROM messages WHERE message_id = ? AND direction = 'in' LIMIT 1").bind(d.message_id).first() : null;
      if (dupById) { out.skipped++; continue; }
      const url = d.raw?.download_url;
      if (!url) throw new Error("no raw download_url for " + it.id);
      const raw = await (await fetch(url)).arrayBuffer();
      const rcpt = lc((d.to && d.to[0]) || (it.to && it.to[0]) || "");
      const at = new Date(d.created_at || it.created_at || Date.now()).toISOString();
      const id = `resend-${it.id}`.slice(0, 36); // keep uuid-shaped ids for the API routes
      const fromAddr = lc(addrOnly(d.from || it.from || ""));
      const legacyCopy = rcpt.startsWith("sam@") || (rcpt.startsWith("trademark@") && fromAddr.includes("uspto.gov"));
      // ONE object, written BEFORE the D1 insert, and its key handed to ingestRaw so ingestRaw skips its own put.
      // This used to be three statements: ingestRaw put `raw/YYYY/MM/<uuid>.eml` and pointed the row at it, a second
      // put copied the same bytes to `resend/...`, and an UPDATE repointed the row - orphaning the first object, which
      // referenced nothing and therefore looked to sweepUnindexedRaw exactly like accepted-but-unindexed mail. 57
      // imports left 57 orphans, and the drain could never retire them because the message was already stored under
      // the other key. R2-first ordering is preserved: the bytes are durable before any D1 write.
      const rawKey = `resend/${account}/${it.id}.eml`;
      await env.STORE.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { rcpt, envFrom: fromAddr, at, source: "resend", msgid: d.message_id || "" } });
      const r = await ingestRaw(env, raw, { id: uuid(), at, rcpt, envFrom: fromAddr, source: "resend", rawKey, gmailForwardedAt: null, gmailCopy: legacyCopy ? "legacy" : "none", subjectHdr: d.subject || it.subject || "" });
      out.imported++; out.ids.push(r.id);
      await logEvent(env.DB, "resend_import", r.id, `${account} ${it.id} ${rcpt} <- ${d.from || it.from}`);
    } catch (e) { out.failed++; await logEvent(env.DB, "resend_import_fail", null, `${account} ${it.id} ${e?.message}`); }
  }
  return out;
}

async function storageStats(db) {
  const m = await db.prepare("SELECT COALESCE(SUM(size_bytes),0) b, COUNT(*) n FROM messages").first();
  const a = await db.prepare("SELECT COALESCE(SUM(size_bytes),0) b, COUNT(*) n FROM attachments").first();
  const h = await db.prepare("SELECT COALESCE(SUM(size_bytes),0) b, COUNT(*) n FROM messages WHERE direction='in' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").first();
  const tr = await db.prepare("SELECT COUNT(*) n FROM threads WHERE state='trash'").first();
  return { raw_bytes: m.b, messages: m.n, attachment_bytes: a.b, attachments: a.n, last_hour_bytes: h.b, last_hour_messages: h.n, trash_threads: tr.n, soft_cap_bytes: STORAGE_SOFT_CAP, hour_budget_bytes: INBOUND_BYTES_PER_HOUR };
}
// Drafts. A draft as a device reads it: its list fields, and its content opened; a tombstone carries no content. A
// content that cannot be opened (a key changed) is reported, never dropped silently.
// What a send takes in the end: sendMail refuses a message over 25 MiB, and base64 makes a file 4/3 its size in the message, so 18 MiB
// of files (24 MiB encoded) leaves room for the text (3acf00f1a3; it was 25 MiB of raw files, ~33 MiB as MIME).
const DRAFT_FILES_MAX = 18 * 1048576;
// The next change's seq, in the statement that writes it: above every row AND above the prune floor, so a pruned tombstone's seq is
// never handed out again to a device whose cursor already passed it.
const DRAFT_NEXT_SEQ = "(SELECT MAX(COALESCE((SELECT MAX(seq) FROM drafts), 0), COALESCE((SELECT CAST(value AS INTEGER) FROM prefs WHERE key = 'drafts_pruned_seq'), 0)) + 1)";
const sha256Hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function draftOut(env, r) {
  if (!r) return null;
  const out = { id: r.id, rev: r.rev, seq: r.seq, kind: r.kind, thread_key: r.thread_key, from: r.from_addr, to: r.to_addrs, subject: r.subject, snippet: r.snippet, n_files: r.n_files, device: r.device, deleted: !!r.deleted, gone_hash: r.gone_hash || null, created_at: r.created_at, updated_at: r.updated_at, content: null };
  if (!r.deleted && r.enc) { try { out.content = JSON.parse(await openToken(env, r.enc, r.iv, `draft|${r.id}`, "drafts")); } catch (e) { out.error = "this draft could not be opened"; } }
  return out;
}
// A draft's files, all of them, or (keep given) those not in keep and older than two minutes. A row goes only with its object: an R2
// delete that fails leaves the row, so the next cleanup or the daily prune tries again instead of the object being lost track of.
async function draftFilesDrop(env, draftId, keep = null) {
  const { results } = await env.DB.prepare("SELECT id, r2_key, created_at FROM draft_files WHERE draft_id = ?").bind(draftId).all();
  const cut = new Date(Date.now() - 120_000).toISOString(); let n = 0;
  for (const f of results) {
    if (keep && (keep.includes(f.id) || String(f.created_at) > cut)) continue;
    try { await env.STORE.delete(f.r2_key); } catch (_) { continue; }
    await env.DB.prepare("DELETE FROM draft_files WHERE id = ?").bind(f.id).run(); n++;
  }
  return n;
}
// Events are an operational log, not a record: 30 days is what the daily report and any incident review ever read. Without this the
// table grows forever and every scan over it (the report's own queries) grows with it.
export async function purgeEvents(env, days = 30) {   // exported so test/drafts.mjs can run the drafts prune
  const r = await env.DB.prepare("DELETE FROM events WHERE at < datetime('now', ?)").bind(`-${days} day`).run();
  await env.DB.prepare("DELETE FROM thread_changes WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)").bind(`-${days} day`).run(); // a client whose cursor is older than this is told to mirror in full
  const n = r.meta?.changes || 0; if (n) await logEvent(env.DB, "events_pruned", null, `${n} older than ${days} days`);
  // A mention decision only has to outlive the poll's catch-up window and the user's chance to restore a mail.
  await env.DB.prepare("DELETE FROM mention_decisions WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run().catch(() => {});
  // A send's reservation only has to outlive the app's retries of it, which stop within minutes; the old send_idem events lived 30 days.
  await env.DB.prepare("DELETE FROM send_claims WHERE state != 'sending' AND at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)").bind(`-${days} day`).run().catch(() => {});
  await env.DB.prepare("DELETE FROM send_claims WHERE state = 'sending' AND at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days')").run().catch(() => {});   // a held send outlives any retry of it
  // Drafts: a sent or discarded draft's tombstone outlives a device that was away for 30 days; a device whose cursor is
  // older than what was pruned is told to take the full list. Files whose draft is gone, or never came, go after a day.
  try {
    const cut30 = new Date(Date.now() - days * 864e5).toISOString(), cut1 = new Date(Date.now() - 864e5).toISOString();
    const mx = (await env.DB.prepare("SELECT MAX(seq) s FROM drafts WHERE deleted = 1 AND updated_at < ?").bind(cut30).first())?.s;
    if (mx) {
      await env.DB.prepare("DELETE FROM drafts WHERE deleted = 1 AND updated_at < ?").bind(cut30).run();
      await env.DB.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('drafts_pruned_seq', ?, ?) ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(prefs.value AS INTEGER), CAST(excluded.value AS INTEGER)), updated_at = excluded.updated_at").bind(String(mx), now()).run();
    }
    const { results: stray } = await env.DB.prepare("SELECT f.id, f.r2_key FROM draft_files f LEFT JOIN drafts d ON d.id = f.draft_id AND d.deleted = 0 WHERE d.id IS NULL AND f.created_at < ? LIMIT 200").bind(cut1).all();
    for (const f of stray) { try { await env.STORE.delete(f.r2_key); } catch (_) { continue; } await env.DB.prepare("DELETE FROM draft_files WHERE id = ?").bind(f.id).run(); }
  } catch (_) {}
  return n;
}
export async function purgeTrash(env) {   // exported so test/ingest.mjs can prove the tombstone is written, not just honoured
  const db = env.DB;
  const { results } = await db.prepare("SELECT id FROM threads WHERE state='trash' AND last_message_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)").bind(`-${TRASH_RETENTION_DAYS} days`).all();
  let n = 0;
  for (const t of results) {
    const { results: msgs } = await db.prepare("SELECT id, raw_key, message_id, identity, direction FROM messages WHERE thread_id = ?").bind(t.id).all();
    for (const mm of msgs) {
      const { results: atts } = await db.prepare("SELECT r2_key FROM attachments WHERE message_id = ?").bind(mm.id).all();
      for (const a of atts) if (a.r2_key && !a.r2_key.startsWith("out/")) await env.STORE.delete(a.r2_key).catch(() => {});
      // Tombstone BEFORE the delete: the sweep cannot tell "never indexed" from "deliberately deleted" by key alone,
      // and the object may outlive the row (a second copy, or a delete that quietly failed under.catch). Written
      // first so a crash between the two leaves a tombstone with no object - harmless - rather than an object with
      // no tombstone, which is the pair that resurrected two August messages on 2026-09-19.
      // The tombstone is written FIRST and its failure ABORTS this message's purge. Swallowing it with catch(_){} and
      // deleting anyway produces the one pair that cannot be recovered from: an R2 object with no tombstone and no row,
      // which is precisely what resurrected two August messages on 2026-09-19. Leaving the message in place is the safe
      // failure: nothing is lost and the user can purge again.
      try {
        await db.prepare("INSERT OR IGNORE INTO purged_keys (raw_key, message_id, identity, direction, reason, at) VALUES (?, ?, ?, ?, 'purged', ?)")
          .bind(mm.raw_key || `purged:${mm.id}`, mm.message_id || null, mm.identity || null, mm.direction || null, now()).run();
      } catch (e) {
        try { await logEvent(db, "purge_fail_tombstone", mm.id, String(e?.message || e).slice(0, 200)); } catch (_) {}
        continue;   // leave the row and the bytes exactly as they are
      }
      if (mm.raw_key) await env.STORE.delete(mm.raw_key).catch(() => {});
      await db.prepare("DELETE FROM attachments WHERE message_id = ?").bind(mm.id).run();
    }
    await db.prepare("DELETE FROM messages WHERE thread_id = ?").bind(t.id).run();
    await db.prepare("DELETE FROM threads WHERE id = ?").bind(t.id).run();
    n += 1;
  }
  if (n) await logEvent(db, "trash_purged", null, `${n} threads older than ${TRASH_RETENTION_DAYS} days`);
  return n;
}
// ---------- Revisit list: decisions we chose to leave alone for now, each with a date or trigger to look again ----------
// Stored as one JSON array under prefs.revisit; surfaced in the daily report (overdue + due within 7 days always, the whole open
// list every Monday) so nothing parked is forgotten. CLI: mail revisit.
async function revisitLoad(db) { try { const r = await db.prepare("SELECT value FROM prefs WHERE key = 'revisit'").first(); const v = r ? JSON.parse(r.value) : []; const items = Array.isArray(v) ? v : []; Object.defineProperty(items, "_raw", { value: r ? r.value : null }); return items; } catch (_) { return []; } }
// Compare-and-swap on the blob that was read: a concurrent CLI/UI write makes this fail with code "conflict" so the caller re-reads and re-applies.
async function revisitSave(db, items) {
  const val = JSON.stringify(items), raw = items._raw ?? null;
  const r = raw === null ? await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('revisit', ?, ?) ON CONFLICT(key) DO NOTHING").bind(val, now()).run()
    : await db.prepare("UPDATE prefs SET value = ?, updated_at = ? WHERE key = 'revisit' AND value = ?").bind(val, now(), raw).run();
  if (!(r.meta?.changes)) throw Object.assign(new Error("revisit list changed underneath; retry"), { code: "conflict" });
}
function revisitLines(items, today = new Date()) {
  const d0 = today.toISOString().slice(0, 10); const soon = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const open = items.filter((i) => i.status !== "done").sort((a, b) => (a.when || "9999").localeCompare(b.when || "9999"));
  const due = open.filter((i) => i.when && i.when <= soon); const monday = today.getUTCDay() === 1;
  const fmt = (i) => `  - [${i.id}] ${i.when ? (i.when < d0 ? "OVERDUE " + i.when : "due " + i.when) : "on trigger"}: ${i.title}${i.trigger ? " (trigger: " + i.trigger + ")" : ""}`;
  const lines = [``, `revisit list: ${open.length} open, ${due.length} due within 7 days${due.length ? " <-- LOOK" : ""}`];
  if (due.length) lines.push(...due.map(fmt));
  if (monday && open.length) { lines.push(`  Monday full list:`); lines.push(...open.filter((i) => !due.includes(i)).map(fmt)); }
  else if (open.length > due.length) { const next = open.find((i) => !due.includes(i)); if (next) lines.push(`  next: ${fmt(next).trim().slice(2)}`); }
  lines.push(`  (mail revisit | mail revisit done ID | mail revisit add "title" YYYY-MM-DD)`);
  return lines;
}
// The daily report said what ARRIVED. It could not say whether anything was STUCK, or how close the free tier was to the hard
// stop that would silence the report itself. A mail-loss receipt comes first, because for a mailbox this size the
// question is no longer speed or cost, it is whether the thing can be trusted as someone's only mail client.
// Every query below is either an indexed range or a COUNT over a table of known small size; the whole block is a few dozen rows.
// How notifications actually reach the devices. Counting only Web Push subscriptions (which the native apps replaced, and which were
// deleted on purpose on 2026-10-03) printed "push devices: 0... NEVER <-- CHECK" every morning while the phone's
// FCM pushes and the Mac/Windows feed worked: an alarm that is always on is one nobody reads. The Android app is FCM; the Mac and
// Windows apps poll notify_feed; browsers are Web Push. CHECK when nothing is registered, a device is erroring, or one never succeeded.
export async function pushSummary(db) {
  const row = async (sql) => (await db.prepare(sql).all()).results[0] || {};
  const fcm = await row("SELECT COUNT(*) n, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) bad, MAX(last_ok_at) ok, MAX(demoted_at) demoted FROM fcm_devices");
  const web = await row("SELECT COUNT(*) n, SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) bad, MAX(last_ok_at) ok FROM push_subscriptions");
  const feed = await row("SELECT MAX(at) at FROM notify_feed");
  const part = (label, r) => `${label} ${r.n || 0}${r.bad ? ` (${r.bad} erroring)` : ""}${r.n ? `, last delivered ${r.ok ? String(r.ok).slice(0, 16) : "NEVER"}` : ""}`;
  // A demoted HIGH delivery turns HIGH dismissals off for 7 days; while that holds the report says so.
  const demoted = fcm.demoted && Date.now() - Date.parse(fcm.demoted) < 7 * 86_400_000;
  const check = !(fcm.n || web.n) || fcm.bad || web.bad || (fcm.n && !fcm.ok) || (web.n && !web.ok) || demoted;
  return `push: ${part("Android app (FCM)", fcm)}${demoted ? ` — Firebase demoted a push ${String(fcm.demoted).slice(0, 16)}; dismissals NORMAL until ${new Date(Date.parse(fcm.demoted) + 7 * 86_400_000).toISOString().slice(0, 10)}` : ""}; ${part("browsers (Web Push)", web)}; Mac/Windows feed last item ${feed.at ? String(feed.at).slice(0, 16) : "none in 3 days"}${check ? "  <-- CHECK" : ""}`;
}

// The day's failures, grouped: each kind with its count and span, then its distinct messages, most frequent first. The list used to be
// the 20 newest failure rows out of the newest 400 events of any kind: on 2026-10-07 it printed 20 identical work-mailbox lines, its
// count read "20" for 142, and any other failure (a scheduled send, a push) would have been pushed off the report.
export async function failureLines(db) {
  const rows = (await db.prepare("SELECT at, kind, detail FROM events WHERE at > datetime('now','-1 day') ORDER BY at DESC LIMIT 5000").all()).results || [];
  const by = new Map();
  for (const e of rows) {
    if (!/fail/.test(e.kind)) continue;
    const g = by.get(e.kind) || { kind: e.kind, n: 0, first: e.at, last: e.at, details: new Map() }; by.set(e.kind, g);
    g.n += 1; g.first = e.at;   // rows come newest first
    const d = String(e.detail || "").slice(0, 120); g.details.set(d, (g.details.get(d) || 0) + 1);
  }
  const total = [...by.values()].reduce((s, g) => s + g.n, 0);
  const capped = rows.length >= 5000 ? " (at least: the day's newest 5,000 events were read)" : "";
  const out = [`failure events last 24h: ${total}${by.size ? ` in ${by.size} kind${by.size === 1 ? "" : "s"}` : ""}${capped}${total ? " <-- CHECK" : ""}`];
  for (const g of [...by.values()].sort((a, b) => b.n - a.n)) {
    out.push(`  - ${g.kind} ×${g.n}${g.n > 1 ? `, ${g.first.slice(0, 16)} → ${g.last.slice(0, 16)}` : `, ${g.last.slice(0, 16)}`}`);
    const ds = [...g.details.entries()].sort((a, b) => b[1] - a[1]);
    for (const [d, n] of ds.slice(0, 3)) out.push(`      ${n}× ${d || "(no detail)"}`);
    if (ds.length > 3) out.push(`      … and ${ds.length - 3} other message${ds.length - 3 === 1 ? "" : "s"}`);
  }
  out.total = total;
  return out;
}
export async function integrityLines(db, imapAccountsForReport = []) {
  // A SWALLOWED query is a report line that reads clean for the wrong reason. `catch (_) { return [] }` meant a query
  // naming a column that does not exist produced an empty result and an all-clear line, with nothing anywhere saying the
  // check had not run: the exact shape of the defect this whole report exists to catch.
  //  Failures are still non-fatal, because a broken query must not take the daily report down with
  // it, but they are COUNTED and printed, so "no rows" and "did not run" can never print the same.
  const qfail = [];
  const one = async (sql, ...b) => { try { return await db.prepare(sql).bind(...b).first(); } catch (e) { qfail.push(`${String(e?.message || e).slice(0, 120)} :: ${sql.replace(/\s+/g, " ").trim().slice(0, 80)}`); return null; } };
  const all = async (sql, ...b) => { try { return (await db.prepare(sql).bind(...b).all()).results; } catch (e) { qfail.push(`${String(e?.message || e).slice(0, 120)} :: ${sql.replace(/\s+/g, " ").trim().slice(0, 80)}`); return []; } };
  const out = ["integrity:"];

  // 0. Mail that was ACCEPTED but is not in the inbox. The ingest path answers 250 as soon as the raw MIME is durable in
  //  R2 and leaves the D1 projection to the reconciler, which is only honest while someone is watching the queue. The
  //  reconciler no longer abandons a row after N attempts (that terminal state was the worst finding
  // ), so a permanently failing message now retries forever instead of vanishing - and forever is
  //  only visible if it is reported. LOST_accepted_but_no_object means the bytes themselves went missing: real loss.
  const pend = await one("SELECT COUNT(*) n, MIN(at) oldest, MAX(attempts) worst FROM pending_ingest");
  if (pend?.n) out.push(`  accepted but NOT YET INDEXED: ${pend.n} (oldest ${pend.oldest}, most attempts ${pend.worst})${pend.worst >= 8 ? " <-- STUCK, a projection keeps failing" : ""}`);
  const stuckIngest = await all("SELECT raw_key, rcpt, attempts, substr(COALESCE(error,''),1,90) err FROM pending_ingest WHERE attempts >= 8 ORDER BY attempts DESC LIMIT 5");
  // A second copy of mail that IS in the inbox (a sync cut off between storing the bytes and indexing them, then repeated): the
  // drain retires it as a duplicate and keeps the bytes. Worth a line, not an alarm: nothing is missing.
  const dupes = await one("SELECT COUNT(*) n FROM purged_keys WHERE reason = 'duplicate' AND at > ?", new Date(Date.now() - 86_400_000).toISOString());
  if (dupes?.n) out.push(`  duplicate copies retired last 24h: ${dupes.n} (the same mail was already indexed; nothing missing)`);
  for (const r of stuckIngest) out.push(`    stuck x${r.attempts}: ${r.rcpt} ${r.raw_key} — ${r.err || "no error recorded"}`);
  // `detail`, not `note` - the column this table has actually had since migration 0001. The wrong name made the query
  // throw, and all() swallows a throw into [], so the loudest alert in this report could never have fired. Found by
  // running a real message through the deployed path rather than by reading the code again.
  const lost = await all("SELECT at, detail FROM events WHERE kind = 'LOST_accepted_but_no_object' AND at > datetime('now','-7 day') ORDER BY at DESC LIMIT 5");
  for (const r of lost) out.push(`  *** ACCEPTED MAIL WHOSE BYTES ARE GONE: ${r.at} ${r.detail}`);
  // The two ingest failures the report was silent about. store_fail_forwarded is the sharp one: the bytes never reached
  // R2 but the Gmail copy did, so the message is accepted, lives ONLY in Gmail, and no layer here can ever index it -
  // which also means it does not survive removing the Gmail copy. r2_write_fail is the permanent-bounce path.
  const swR = await one("SELECT value FROM prefs WHERE key = 'last_raw_sweep_recent'");
  const swF = await one("SELECT value FROM prefs WHERE key = 'last_raw_sweep_full'");
  out.push(`  orphan sweep (recent ${SWEEP_MONTHS}mo): ${swR?.value || "NEVER RUN — the recovery horizon is not being walked"}`);
  out.push(`  orphan sweep (full bucket): ${swF?.value || "NEVER COMPLETED — the loss bound is the horizon, not a week"}`);
  const ing = await all("SELECT kind, COUNT(*) n, MAX(at) last FROM events WHERE kind IN ('r2_write_fail','store_fail_forwarded','rawsize_mismatch','emergency_forward') AND at > datetime('now','-1 day') GROUP BY kind");
  for (const r of ing) out.push(`  ${r.kind === "store_fail_forwarded" ? "*** IN GMAIL ONLY, never stored here" : r.kind === "r2_write_fail" ? "*** REFUSED, stored nowhere" : r.kind === "emergency_forward" ? "emergency Gmail forward after R2 failure" : "rawsize mismatch (observing, not enforced)"}: ${r.n} in 24h, last ${r.last}`);

  // 1. Anything STUCK. A queued action that never drains is how mail silently fails to move.
  const ops = await one("SELECT COUNT(*) n, MIN(created_at) oldest FROM imap_ops WHERE status = 'pending'");
  const defd = await one("SELECT COUNT(*) n, MIN(created_at) oldest FROM imap_ops WHERE status = 'deferred'");
  // Three piles the runner cannot see, all of which mean the mailbox never learned about something the user did. A row that has
  // exhausted its attempts is invisible to `attempts < 6`; a superseded row was deliberately dropped; an orphaned one belongs to a
  // mailbox that no longer exists. All three. Counting them is what stops them being silent.
  // NOT `status='pending' AND attempts>=6`: the failure path already flips a row to 'failed' on its sixth attempt, so that query
  // would always have returned zero. It does not,
  // and following that premise would have produced a line on this report that could never fire.
  const dead = await one("SELECT COUNT(*) n, MIN(created_at) oldest FROM imap_ops WHERE status = 'failed'");
  const sup = await one("SELECT COUNT(*) n FROM imap_ops WHERE status = 'superseded' AND done_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')");
  const orph = await one("SELECT COUNT(*) n FROM imap_ops WHERE status = 'orphaned'");
  // An op can also sit at pending or running for an account that no longer exists: it failed once, returned to pending, and the
  // mailbox was removed afterwards. Nothing selected it and nothing counted it. `runImapOps` skips accounts it cannot resolve, so
  // these are invisible work, which is precisely the pile this report exists to end.
  const strayRows = await all("SELECT DISTINCT account FROM imap_ops WHERE status IN ('pending','running')");
  const configured = new Set(imapAccountsForReport.map((e) => e.toLowerCase()));
  const stray = strayRows.filter((r) => !configured.has(String(r.account || "").toLowerCase())).map((r) => r.account);
  const sch = await one("SELECT COUNT(*) n, MIN(due_at) oldest FROM scheduled_actions WHERE status = 'pending' AND due_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const run = await one("SELECT COUNT(*) n FROM scheduled_actions WHERE status = 'running'");
  const stuck = (ops?.n || 0) + (sch?.n || 0);
  out.push(`  stuck work: ${ops?.n || 0} imap op(s)${ops?.oldest ? " oldest " + String(ops.oldest).slice(0, 16) : ""}, ` +
    `${sch?.n || 0} overdue scheduled${sch?.oldest ? " oldest " + String(sch.oldest).slice(0, 16) : ""}, ${run?.n || 0} running` +
    (stuck ? "   <-- CHECK" : ""));
  // Parked work is not lost work, but it IS work the mailbox has not seen: it must be visible, or deferring is just a slower drop.
  if (defd?.n) out.push(`  parked for an unconfigured mailbox: ${defd.n} op(s) since ${String(defd.oldest || "").slice(0, 16)} — released automatically once its password is set   <-- CHECK`);
  if (dead?.n) out.push(`  GAVE UP after 6 attempts: ${dead.n} op(s) since ${String(dead.oldest || "").slice(0, 16)} — the mailbox never learned about these   <-- CHECK`);
  if (orph?.n) out.push(`  retired, mailbox absent over 7 days: ${orph.n} op(s) — reclaimed automatically if it is configured again`);
  if (stray.length) out.push(`  UNRUNNABLE: pending op(s) for ${stray.join(", ")}, which is not in IMAP_ACCOUNTS — no runner will ever select these   <-- CHECK`);
  if (sup?.n) out.push(`  superseded by a later action in the last 24h: ${sup.n} op(s) (expected when a mailbox comes back online)`);

  // 2. The IMAP path. R24 measured about half of the Worker's connections to the work mailbox timing out; this makes that a number
  //  on the page every morning instead of a memory.
  const imap = await all("SELECT account, folder, last_sync_at, last_error FROM imap_folders WHERE role = 'inbox'");
  for (const f of imap) {
    // last_sync_at is written by now() and already ends in "Z". Appending another made Date.parse return NaN, which printed
    // "synced NaN min ago" and, worse, made `age > 120` false for ever: the stale-sync alarm could not fire (2026-10-06 report).
    // A zone-less value (older rows) is still read as UTC.
    const age = f.last_sync_at ? Math.round((Date.now() - Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(f.last_sync_at) ? f.last_sync_at : f.last_sync_at + "Z")) / 60000) : null;
    out.push(`  imap ${f.account}: synced ${age == null ? "NEVER" : age + " min ago"}${f.last_error ? " ERR " + String(f.last_error).slice(0, 60) : ""}` +
      (age == null || age > 120 ? "   <-- CHECK" : ""));
  }

  // 3. Gmail push health, per account: a watch that lapses degrades to polling silently, and the client now BACKS OFF when it
  //  believes push is live, so a lapsed watch costs more than it used to.
  //  Silence alone is not the fault: the watch covers INBOX only, and a mailbox that receives nothing sends nothing
  //  (sam.third read "<-- CHECK" every morning with no mail since 10-07). The fault is inbox mail that came after the
  //  last push, read from the mirror while it is current; without a current mirror, silence over 48 h again.
  const gw = await all("SELECT email, watch_expiration, last_push_at, mirror_state, mirror_synced_at FROM gmail_accounts WHERE status = 'active'");
  for (const g of gw) {
    const exp = g.watch_expiration ? Date.parse(g.watch_expiration) : 0;
    const hrs = exp ? Math.round((exp - Date.now()) / 3600000) : 0;
    const quiet = g.last_push_at ? Math.round((Date.now() - Date.parse(g.last_push_at)) / 3600000) : null;
    const live = g.mirror_state === "ready" && Date.now() - (Date.parse(g.mirror_synced_at) || 0) < 3600_000;
    const newest = live ? (await one(`SELECT internal_date d FROM gmail_messages WHERE account = ? AND labels LIKE '%"INBOX"%' ORDER BY internal_date DESC LIMIT 1`, g.email))?.d ?? null : null;
    const unpushed = newest != null && quiet != null && newest > Date.parse(g.last_push_at) + 30 * 60_000;
    out.push(`  gmail ${g.email}: watch ${exp > Date.now() ? hrs + "h left" : "EXPIRED"}, last push ${quiet == null ? "NEVER" : quiet + "h ago"}` +
      (live ? `, newest inbox mail ${newest == null ? "none" : Math.round((Date.now() - newest) / 3600000) + "h ago"}${unpushed ? " — it came after the last push" : ""}` : ", mirror not current") +
      (exp <= Date.now() || quiet == null || (live ? unpushed : quiet > 48) ? "   <-- CHECK" : ""));
  }

  // 4. Free-tier headroom. Not the bill; the HARD STOP: D1 answers errors until midnight UTC once the daily limit is crossed,
  //  and the 10 ms CPU ceiling is per invocation, so it cannot be smoothed by spreading load. These are the drivers that grow.
  const rules = await one("SELECT COUNT(*) n FROM sender_rules");
  const senders = await one("SELECT COUNT(*) n FROM known_senders");
  const evd = await one("SELECT COUNT(*) n FROM events WHERE at > datetime('now','-1 day')");
  const cronRows = 1296 * 1 + 144 * (1 + (rules?.n || 0));      // measured shape: budget.mjs, idle minute vs backstop minute
  const pct = Math.round((cronRows / 5e6) * 1000) / 10;
  out.push(`  free tier: cron ~${cronRows.toLocaleString()} D1 rows/day (${pct}% of 5,000,000 — queries FAIL past it), ` +
    `~${(1440 + (evd?.n || 0)).toLocaleString()} worker req/day of 100,000` + (pct > 50 ? "   <-- CHECK" : ""));
  out.push(`  growth drivers: ${rules?.n || 0} sender rules (the per-message scan is R35; ~3,400 would spend the day alone), ${senders?.n || 0} known senders`);
  // Printed LAST so it cannot be missed, and unconditionally when non-empty: a check that could not run is not a
  // check that passed.
  if (qfail.length) { out.push(`  *** ${qfail.length} INTEGRITY QUERY(S) FAILED — the lines above are incomplete <-- ALERT`);
    for (const f of qfail.slice(0, 5)) out.push(`      ${f}`); }
  return out;
}
// The Gmail mirror can stop advancing without one failure event: a cursor no run moves. What shows it is how long ago
// each account's mirror last read Gmail to the end. The real state is shown, not what devices are told in shadow mode.
async function gmailMirrorReportLine(db, env) {
  const mode = env.GMAIL_MIRROR || "on";
  if (mode === "off") return "Gmail mirror: off (devices sync Gmail directly)";
  const st = await gmailMirrorStatus(db, { ...env, GMAIL_MIRROR: "on" });
  let rows = {}; try { rows = Object.fromEntries(((await db.prepare("SELECT account, COUNT(*) n FROM gmail_messages WHERE meta IS NOT NULL GROUP BY account").all()).results || []).map((r) => [r.account, r.n])); } catch (_) {}
  const parts = Object.entries(st).map(([email, x]) => {
    const age = x.synced_at ? Math.round((Date.now() - Date.parse(x.synced_at)) / 60000) : null, bad = x.state !== "ready" || age === null || age > 30;
    return `${email}=${x.state || "not started"} ${rows[email] || 0} msgs${age !== null ? `, read Gmail ${age} min ago` : ""}${x.owed ? `, owes ${x.owed}` : ""}${bad ? " <-- CHECK" : ""}`;
  });
  return `Gmail mirror (${mode}): ${parts.join("; ") || "no accounts"}`;
}
export async function dailyReport(env, pollResults) {
  const db = env.DB;
  const q = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
  const in24 = await q("SELECT ingest_source, COUNT(*) n FROM messages WHERE direction='in' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') GROUP BY ingest_source");
  const out24 = (await db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='out' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").first()).n;
  // An alarm that has been true since August is not an alarm - it is a line the reader learns to skip, which is what
  // an unbounded window bought: two 2026-08-11/14 rows reported as "<-- ALERT" every day for a gap nobody can now act
  // on. The ALERT is what is still actionable (7 days); the older count stays visible on the same line so a genuine
  // old gap is not silently dropped, which is the risk both builder lanes named against windowing it at all.
  const missing = await q("SELECT id, identity, from_addr, subject, created_at FROM messages WHERE direction='in' AND ingest_source='cloudflare' AND gmail_copy='none' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') ORDER BY created_at DESC LIMIT 20");
  const missingOld = (await q("SELECT COUNT(*) n FROM messages WHERE direction='in' AND ingest_source='cloudflare' AND gmail_copy='none' AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"))[0]?.n ?? 0;
  // `kind LIKE '%fail%'` cannot use an index and scanned the whole table (841 rows for 4 hits, measured in September 2026); `at` is indexed,
  // so the window is read through the index and the kind is matched here.
  const recentEvents = await q("SELECT at, kind, detail FROM events WHERE at > datetime('now','-1 day') ORDER BY at DESC LIMIT 400");
  const purgedRefused = recentEvents.filter((e) => e.kind === "purged_not_reprojected").length;
  const failLines = await failureLines(db);
  const gm = await q("SELECT email, status, last_minted_at, last_error, watch_expiration, last_push_at FROM gmail_accounts ORDER BY email");
  const lastPoll = (await db.prepare("SELECT MAX(at) at FROM events WHERE kind='resend_poll_ok'").first()).at; // MEASURED 1 row read; an ORDER BY at DESC LIMIT 1 "optimisation" reads 1,127: do not "fix" this
  const resendRows = await q("SELECT COUNT(*) n FROM messages WHERE ingest_source='resend'");
  const uspto = await q("SELECT identity, from_addr, subject, created_at FROM messages WHERE labels LIKE '%USPTO%' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') ORDER BY created_at DESC");
  const held = (await db.prepare("SELECT COUNT(*) n FROM messages WHERE gmail_copy='held' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").first()).n;
  // Address locks: kept-out mail sends no push, so this line is where it is seen without opening Held.
  let lockLine;
  try { const l = await db.prepare("SELECT (SELECT COUNT(*) FROM address_locks WHERE state != 'released') n, (SELECT COUNT(*) FROM messages WHERE lock_kept = 1) waiting").first();
    lockLine = `address locks: ${l.n}; kept out last 24h: ${recentEvents.filter((e) => e.kind === "lock_kept_out").length}; kept out, not let in: ${l.waiting}${l.waiting ? " (Held)" : ""}`; }
  catch (e) { lockLine = `address locks: unreadable (${String(e?.message || e).slice(0, 80)}) <-- CHECK`; }
  // Picture shrinking: what the container did in the last day, what waits, and its running time this month against the
  // 5-hour cap (hub/shrink/src/index.js SHRINK.monthCapS) that keeps it far under the plan's included container hours. "Left as sent" is a
  // picture that came out no smaller or that the container refused (too many pixels): served as the sender sent it, so no
  // CHECK. "Failed" is the container misbehaving, after three tries.
  let shrinkLine;
  try { const mb = (b) => (b / 1e6).toFixed(1) + " MB";
    // The mailhub-img Worker's queue (img_work) and the keep-while-shown sweep, in place of the container's.
    const sh = await db.prepare("SELECT (SELECT COUNT(*) FROM img_work WHERE state = 'done' AND done_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) n, (SELECT COALESCE(SUM(bytes), 0) FROM img_work WHERE state = 'done' AND done_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) b0, (SELECT COALESCE(SUM(out_bytes), 0) FROM img_work WHERE state = 'done' AND done_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) b1, (SELECT COUNT(*) FROM img_work WHERE state = 'skipped' AND done_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) kept, (SELECT COUNT(*) FROM img_work WHERE state IN ('pending', 'working')) waiting, (SELECT COUNT(*) FROM img_work WHERE state = 'failed' AND done_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) failed, (SELECT COUNT(*) FROM img_seen) held").first();
    shrinkLine = `pictures shrunk last 24h: ${sh.n} (${mb(sh.b0)} -> ${mb(sh.b1)}, both sizes); left as sent ${sh.kept}; waiting ${sh.waiting}${sh.waiting > 50 ? " <-- CHECK" : ""}; failed ${sh.failed}${sh.failed ? " <-- CHECK" : ""}; pictures kept ${sh.held}`; }
  catch (e) { shrinkLine = `pictures shrunk: unreadable (${String(e?.message || e).slice(0, 80)}) <-- CHECK`; }
  // Spy trackers and ads beyond the named list: what was blocked; what slipped through (a picture measured at most 2x2
  // and not blocked, the number this exists to bring down); the learner; each list's version and its check. A learned pattern that went
  // off has already been handled (its pictures are fetched again); only a list that stopped refreshing needs anyone.
  let trackerLine;
  try { const s = await trkStatus(env), c = (st) => s.rules.filter((r) => r.kind === "learned" && r.state === st).length;
    const today = s.rules.filter((r) => r.kind === "learned" && (r.state === "off" || r.state === "wrong") && Date.parse(r.changed_at) > Date.now() - 86400e3);
    const stale = s.lists.filter((l) => !l.version || Date.now() - Date.parse(l.at || 0) > 7 * 86400e3);
    trackerLine = `trackers and ads beyond the named list: blocked last 24h ${s.day.blocked ?? 0}; tiny pictures fetched and not blocked ${s.day.slipped ?? 0}; learning ${s.learner.mode === "on" ? "on" : `watching (blocks by itself from ${String(s.on_at || "").slice(0, 10)} if nothing is contradicted)`}: ${c("on")} blocking, ${c("watch")} watched, ${c("off")} off, ${c("wrong")} contradicted; ${s.lists.map((l) => `${l.name} ${l.version || "none"}${l.refused ? ` (${l.refused} rules refused by the check)` : ""}${l.version && !l.checked ? " UNCHECKED" : ""}`).join(", ")}${today.length ? `; turned off or contradicted today, handled: ${today.map((r) => r.pattern).join(", ")}` : ""}${stale.length ? `; not refreshed in a week: ${stale.map((l) => l.name).join(", ")} <-- CHECK` : ""}`; }
  catch (e) { trackerLine = `trackers and ads: unreadable (${String(e?.message || e).slice(0, 80)}) <-- CHECK`; }
  // "Delete unless it mentions": what the rules did in the last day, and each mail they deleted, so a wrong call is seen
  // while Gmail's trash still holds it (30 days). Counted by the database, so a busy day is not undercounted. "dropping" is a move to the
  // trash that was asked for but never confirmed (the run stopped, or Gmail's answer was lost): it may have happened, so it is listed with
  // the deleted. Not finished, with a CHECK: those, "rescuing", a claim older than ten minutes (a run that stopped before reading the
  // mail: nothing was done), and "failed" (Gmail refused: the mail is where it was).
  let mentionLines = [];
  try {
    const nr = (await db.prepare("SELECT COUNT(*) n FROM mention_rules").first()).n;
    const counts = Object.fromEntries((await q("SELECT decision, COUNT(*) n FROM mention_decisions WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') GROUP BY decision")).map((r) => [r.decision, r.n]));
    const c = (k) => counts[k] || 0, any = Object.values(counts).some(Boolean);
    const stale = (await db.prepare("SELECT COUNT(*) n FROM mention_decisions WHERE decision IN ('claimed','dropping','rescuing') AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AND at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')").first()).n;
    const stuck = stale + c("failed"), gone = await q("SELECT decision, account, from_addr, subject FROM mention_decisions WHERE decision IN ('dropped','dropping') AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') ORDER BY at DESC LIMIT 15");
    if (nr || any) mentionLines = [`delete-unless-it-mentions rules: ${nr}; last 24h kept ${c("kept")}, moved out of spam ${c("rescued")}, deleted ${c("dropped")}, kept unread ${c("unread")}, left ${c("left")}${stuck ? `, not finished ${stuck} <-- CHECK` : ""}`,
      ...gone.map((x) => `  - ${x.decision === "dropping" ? "maybe deleted <-- CHECK" : "deleted"} ${x.account} <- ${x.from_addr} | ${x.subject}`), ...(c("dropped") + c("dropping") > 15 ? [`  - and ${c("dropped") + c("dropping") - 15} more`] : [])];
  } catch (e) { mentionLines = [`delete-unless-it-mentions rules: unreadable (${String(e?.message || e).slice(0, 80)}) <-- CHECK`]; }
  const st = await storageStats(db);
  const gb = (b) => (b / 1073741824).toFixed(2) + " GB";
  const budget = await q("SELECT kind, COUNT(*) n FROM events WHERE kind IN ('inbound_rate_limited','inbound_over_budget','store_only_oversize','attachments_capped','img_prefetch_over_budget') AND at > datetime('now','-1 day') GROUP BY kind");
  const lines = [
    `mailhub daily report ${new Date().toISOString().slice(0, 16)}Z`,
    `storage: raw ${gb(st.raw_bytes)} in ${st.messages} messages + attachments ${gb(st.attachment_bytes)} (${st.attachments}); soft cap ${gb(st.soft_cap_bytes)}${st.raw_bytes + st.attachment_bytes > st.soft_cap_bytes ? " <-- OVER CAP" : ""}; trash threads ${st.trash_threads} (purged after ${TRASH_RETENTION_DAYS} days)`,
    ...(budget.length ? [`containment events last 24h: ${budget.map((b) => `${b.kind}=${b.n}`).join(", ")} <-- CHECK`] : []),
    ...(uspto.length ? [``, `USPTO correspondence last 24h: ${uspto.length} <-- READ`, ...uspto.map((u) => `  - ${u.created_at} ${u.identity} <- ${u.from_addr} | ${u.subject}`)] : []),
    `held (trademark solicitations etc.) last 24h: ${held}`,
    lockLine,
    shrinkLine,
    trackerLine,
    ...mentionLines,
    ``,
    `inbound last 24h: ${in24.map((r) => `${r.ingest_source}=${r.n}`).join(", ") || "0"}; outbound last 24h: ${out24}`,
    // The Resend bridge runs only while a key is set; once the keys are gone there is nothing to report.
    ...(env.RESEND_KEY_DOMAIN2 || env.RESEND_KEY_DOMAIN3 ? [`Resend bridge: last clean poll ${lastPoll || "NEVER"}; imported rows total ${resendRows[0].n}; this run: ${JSON.stringify(pollResults.map((r) => ({ a: r.account, listed: r.listed, imported: r.imported, failed: r.failed, error: r.error })))}`] : []),
    // gmail_copy 'none' is a copy that was WANTED and failed; with the copy off mail that needs none is 'off'.
    ...(gmailCopyOn(env) ? [] : [`Gmail safety copy: OFF (GMAIL_COPY) — only "forward" rules (USPTO) and the emergency copy after a storage failure reach Gmail`]),
    `Cloudflare-routed inbound WITHOUT a ${gmailCopyOn(env) ? "" : "wanted "}Gmail copy: ${missing.length} in the last 7d${missing.length ? " <-- ALERT" : ""}${missingOld ? ` (+${missingOld} older, known)` : ""}`,
    ...missing.map((m) => `  - ${m.created_at} ${m.identity} <- ${m.from_addr} | ${m.subject}`),
    `IMAP: ${(await q("SELECT account, folder, highwater, exists_count, last_sync_at, last_error FROM imap_folders WHERE role = 'inbox'")).map((f) => `${f.account}: uid≤${f.highwater} of ${f.exists_count ?? "?"} synced ${(f.last_sync_at || "never").slice(0, 16)}${f.last_error ? " ERR " + f.last_error.slice(0, 80) : ""}`).join("; ") || "none configured"}; pending ops ${(await q("SELECT COUNT(*) n FROM imap_ops WHERE status = 'pending'"))[0]?.n ?? 0}`,
    // A count alone hid the failure mode this report exists to catch: a device can stay registered and simply stop being delivered to
    // (a rotated subscription, a pruned row). The newest successful delivery is the number that shows it.
    `${await pushSummary(db)}; scheduled pending: ${(await q("SELECT COUNT(*) n FROM scheduled_actions WHERE status = 'pending'"))[0]?.n ?? 0}`,
    await gmailMirrorReportLine(db, env),
    `Gmail accounts: ${gm.map((g) => `${g.email}=${g.status}${g.last_minted_at ? " minted " + g.last_minted_at.slice(0, 16) : ""}${g.watch_expiration ? (Date.parse(g.watch_expiration) > Date.now() ? " push until " + g.watch_expiration.slice(0, 16) : " PUSH EXPIRED " + g.watch_expiration.slice(0, 16)) : " polling"}${g.last_push_at ? " last push " + g.last_push_at.slice(0, 16) : ""}${g.last_error ? " ERR " + g.last_error : ""}`).join("; ") || "none"}`,
    ``,
    ...(await integrityLines(db, (await imapAccounts(env, { fresh: true })).map((a) => a.email))),
    ...revisitLines(await revisitLoad(db)),
    ``,
    // Refused-on-purpose outcomes get their own line. Neither matches the /fail/ filter above and neither should (they
    // are the system working) but a silent refusal is indistinguishable from lost mail, and three adversarial lanes
    //  called that out as the standing requirement's exact prohibition. If this line is ever
    // non-zero without the user having purged something, the identity tombstone is refusing live mail.
    `refused as already-purged last 24h: ${purgedRefused}${purgedRefused ? " <-- CHECK: a re-sent Message-ID you purged is being declined" : ""}`,
    ...failLines,
    ``,
    `UI: https://mail.yourdomain.example  CLI: mail stats / mail events`,
  ];
  try {
    await env.EMAIL.send({ from: { email: "mailhub@yourdomain.example", name: "mailhub" }, to: env.FORWARD_TO, subject: `[mailhub] daily: ${missing.length ? "ALERT" : "ok"} — ${in24.reduce((s, r) => s + r.n, 0)} in / ${out24} out`, text: lines.join("\n") });
    await logEvent(db, "daily_report_sent", null, `${missing.length} missing, ${failLines.total} fails`);
  } catch (e) { await logEvent(db, "daily_report_fail", null, e?.message); }
}

// ---------- outbound ----------
// A reply may say nothing, and a message may be only its attachments (A reply with an empty
// body must be sendable). Either goes out with a plain-text body of one line break, so both send paths (the Email binding
// and the MIME builder) still carry a body part. A new message with no body and nothing attached is still refused.
function bodyText(body) {
  const text = body.text ?? null;
  if (text || body.html) return text;
  return body.reply_to_id || body.in_reply_to || (Array.isArray(body.attachments) && body.attachments.length) ? "\n" : text;
}
// The message a send answers. A reply sent now names its row (reply_to_id). A scheduled reply carries the Message-ID it answers
// instead (in_reply_to: the client's msgIdHdr, without angle brackets), and nothing read it: a scheduled reply went out with no
// In-Reply-To and was filed by subject alone. One Message-ID can be held by several rows, one per identity, so
// the copy in the sender's own mailbox wins. A message gone by the time the send falls due sends unthreaded rather than not at all.
async function replyParent(db, body, from) {
  if (body.reply_to_id) return db.prepare("SELECT * FROM messages WHERE id = ?").bind(body.reply_to_id).first();
  const mid = String(body.in_reply_to || "").trim().replace(/^<|>$/g, "");
  if (!mid) return null;
  return db.prepare("SELECT * FROM messages WHERE message_id = ? ORDER BY (identity = ?) DESC, created_at DESC LIMIT 1").bind(`<${mid}>`, from).first();
}
function assertHeaderSafe(body) { const bad = (v) => /[\r\n\0]/.test(String(v ?? "")); for (const k of ["from", "from_name", "subject", "reply_to", "in_reply_to"]) if (bad(body[k])) throw Object.assign(new Error(`${k} contains a line break`), { code: "bad_header" }); for (const k of ["to", "cc", "bcc"]) for (const a of [].concat(body[k] || [])) if (bad(typeof a === "string" ? a : a?.address)) throw Object.assign(new Error(`${k} contains a line break`), { code: "bad_header" }); for (const a of body.attachments || []) if (bad(a?.filename)) throw Object.assign(new Error("attachment name contains a line break"), { code: "bad_header" }); }
const sendErr = (e) => json({ error: e.message, code: e.code, message_id: e.message_id }, e.status === 409 ? 409 : 400); // a 409 (ambiguous work-mail send) must reach the client as a 409
// What a send would do, without doing it: the From, To, Cc, Bcc and Subject the send resolved (a reply's To after Reply-To), and each
// file's name, type and decoded size. `mail reply --dry-run`. Only the /reply/preview route sets opts.dryRun, never a
// request body, so nothing a client sends to /api/send can turn a send into a preview or a preview into a send.
function sendView({ via, from, name, to, cc, bcc, subject, inReplyTo, files }) {
  const box = (x) => (typeof x === "string" ? x : x.name ? `${x.name} <${x.email}>` : x.email);
  return { dry_run: true, via, from: name ? `${name} <${from}>` : from, to: to.map(box), cc: cc.map(box), bcc: bcc.map(box), subject, in_reply_to: inReplyTo || null, attachments: files };
}
async function sendMail(env, body, opts = {}) {
  assertHeaderSafe(body);
  const db = env.DB;
  if (!opts.dryRun && body.idempotency_key && /^[A-Za-z0-9_-]{8,80}$/.test(body.idempotency_key)) { // a retried send must never go out twice
    const prev = await db.prepare("SELECT message_id FROM events WHERE kind = 'send_idem' AND detail LIKE ? LIMIT 1").bind(body.idempotency_key + " %").first();
    if (prev) { const m = await db.prepare("SELECT id, thread_id, message_id FROM messages WHERE id = ?").bind(prev.message_id).first(); if (m) return { id: m.id, thread_id: m.thread_id, message_id: m.message_id, dedup: true }; }
  }
  let fromRaw = body.from, fromName = body.from_name;
  if (fromRaw && typeof fromRaw === "object") { fromName = fromName ?? fromRaw.name; fromRaw = fromRaw.email; }
  if (typeof fromRaw === "string" && /<[^<>]+>/.test(fromRaw)) { const mm = fromRaw.match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/); if (mm) { fromName = fromName ?? mm[1].trim(); fromRaw = mm[2]; } }
  const from = lc(fromRaw);
  if (!from || !from.includes("@")) throw new Error("from is required");
  const imapAcct = await imapAccountFor(env, from, { fresh: true });
  if (imapAcct && opts.dryRun) {
    const parent = await replyParent(db, body, imapAcct.email);
    const files = (body.attachments || []).map((a) => { let bytes = 0; try { bytes = atob(String(a?.content || "").replace(/\s+/g, "")).length; } catch (_) { throw new Error(`attachment ${a?.filename}: content must be base64`); } return { filename: a?.filename, type: a?.type || "application/octet-stream", bytes }; });
    return sendView({ via: "smtp", from: imapAcct.email, name: (fromName ?? body.from_name) || imapAcct.label || "", to: toAddrObjs(body.to), cc: toAddrObjs(body.cc), bcc: toAddrObjs(body.bcc), subject: String(body.subject || ""), inReplyTo: parent?.message_id, files });
  }
  if (imapAcct) return sendViaImapAccount(env, { ...body, from_name: fromName ?? body.from_name }, imapAcct);
  const to = toAddrObjs(body.to), cc = toAddrObjs(body.cc), bcc = toAddrObjs(body.bcc);
  if (!to.length) throw new Error("to is required");
  if (to.length + cc.length + bcc.length > 50) throw new Error("too many recipients (max 50)");
  const subject = (body.subject || "").toString();
  const text = bodyText(body), html = body.html ?? null;
  if (!text && !html) throw new Error("text or html is required");

  const parent = await replyParent(db, body, from);
  if (body.reply_to_id && !parent) throw new Error("reply_to_id not found");
  const own = await ownDomains(db, env);
  const identRow = await db.prepare("SELECT email, display_name, is_active FROM identities WHERE email = ?").bind(from).first();
  const fromDomain = from.split("@")[1];
  if (identRow && !identRow.is_active) throw new Error(`sender disabled: ${from}`);
  if (!identRow && !own.has(fromDomain)) throw new Error(`sender not allowed: ${from} (domain not onboarded)`);
  const ident = identRow ? { ...identRow, display_name: fromName ?? identRow.display_name } : { email: from, display_name: fromName ?? "" };

  const headers = {};
  if (hdrId(parent?.message_id)) {   // cleaned here too: a parent stored earlier may carry a line break
    const pid = hdrId(parent.message_id);
    headers["In-Reply-To"] = pid;
    const refs = parseIdList(parent.refs);
    if (!refs.includes(pid)) refs.push(pid);
    headers["References"] = refs.join(" ");
  }
  for (const [k, v] of Object.entries(body.headers || {})) if (/^X-[A-Za-z0-9_-]+$/.test(k)) headers[k] = String(v);

  const attachments = [];
  let attBytes = 0;
  const inlineImgs = [];
  for (const a of body.attachments || []) {
    if (!a?.content || !a?.filename) throw new Error("attachment needs filename and base64 content");
    attBytes += Math.floor((a.content.length * 3) / 4);
    const isImg = /^image\//i.test(a.type || "");
    const inline = (a.disposition === "inline" || (body.inline_images && isImg)) && isImg;
    // Stored Content-IDs keep their angle brackets (postal-mime gives "<id>"), and the header below adds its own: a forwarded inline
    // image went out as Content-ID: <<id>> and never matched its cid: reference.
    const bare = a.contentId ? String(a.contentId).trim().replace(/^<|>$/g, "") : "";
    const cid = inline ? (bare || `${uuid()}@mailhub`) : bare || undefined;
    // The binding sends a string `content` as literal text (measured in September 2026: a base64 string arrived as base64 characters), so decode to bytes here.
    let bytes;
    try { const bin = atob(a.content.replace(/\s+/g, "")); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    catch (_) { throw new Error(`attachment ${a.filename}: content must be base64`); }
    attachments.push({ content: bytes, filename: a.filename, type: a.type || "application/octet-stream", disposition: inline ? "inline" : "attachment", ...(cid ? { contentId: cid } : {}) });
    if (inline) inlineImgs.push({ cid, name: a.filename });
  }
  let htmlBody = html;
  if (inlineImgs.length && !htmlBody) {
    const escd = (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    htmlBody = `<div style="font:14px -apple-system,BlinkMacSystemFont,sans-serif;white-space:pre-wrap">${escd}</div>` + inlineImgs.map((i) => `<div style="margin-top:12px"><img src="cid:${i.cid}" alt="${i.name.replace(/"/g, "")}" style="max-width:100%"></div>`).join("");
  }
  // The letterhead: a From on a branded domain wraps the HTML part; `plain` in the body skips it.
  const brand = body.plain ? null : brandsCfg(env)[fromDomain];
  if (brand) htmlBody = brandFrame(brand, { inner: htmlBody || linkTextHtml(text), parent });
  const approxSize = attBytes + (text?.length || 0) + (htmlBody?.length || 0);
  if (approxSize > OUT_MAX_BYTES) throw new Error("message exceeds the 5 MiB limit");
  if (opts.dryRun) return sendView({ via: "hub", from, name: ident?.display_name, to, cc, bcc, subject, inReplyTo: headers["In-Reply-To"],
    files: attachments.map((a) => ({ filename: a.filename, type: a.type, bytes: a.content.length, ...(a.disposition === "inline" ? { inline: true } : {}) })) });

  const msg = {
    from: ident?.display_name ? { email: from, name: ident.display_name } : from,
    to, subject, ...(text ? { text } : {}), ...(htmlBody ? { html: htmlBody } : {}),
    ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}),
    ...(body.replyTo ? { replyTo: body.replyTo } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  const id = uuid();
  const at = now();
  // Exactly once: the idempotency key is RESERVED before the mail goes, not written after it (findings bf1d496443, 9071a5e189,
  // a0a3a82192 and 6e56f01724).
  // `send_idem` was written only after the copy, the D1 rows, the files and the events, so a retry of the same row that arrived while
  // the first run was still storing its copy, or after Cloudflare cut that run off once the mail had gone, found nothing and sent it
  // again. Now the first run holds the key: a second one with the same key is answered with the mail already sent, or, while the first
  // has not finished (or was cut off), 409 "may already be on its way", which the app shows as "Not confirmed" and never retries. Only
  // a send that went to nobody frees the key for a retry.
  const claimKey = body.idempotency_key && /^[A-Za-z0-9_-]{8,80}$/.test(body.idempotency_key) ? body.idempotency_key : null;
  if (claimKey) {
    const c = await db.prepare("INSERT INTO send_claims (key, state, at) VALUES (?, 'sending', ?) ON CONFLICT(key) DO UPDATE SET state = 'sending', at = excluded.at WHERE send_claims.state = 'failed'").bind(claimKey, at).run();
    if (!c.meta?.changes) {
      const prev = await db.prepare("SELECT state, message_id FROM send_claims WHERE key = ?").bind(claimKey).first();
      const m = prev?.state === "sent" && prev.message_id ? await db.prepare("SELECT id, thread_id, message_id FROM messages WHERE id = ?").bind(prev.message_id).first() : null;
      if (m) return { id: m.id, thread_id: m.thread_id, message_id: m.message_id, dedup: true };
      throw Object.assign(new Error("This message may already be on its way: an earlier try of the same send has not finished. It was not sent again."), { code: "ambiguous_send", status: 409 });
    }
  }
  const unclaim = () => claimKey ? db.prepare("UPDATE send_claims SET state = 'failed', at = ? WHERE key = ? AND state = 'sending'").bind(now(), claimKey).run().catch(() => {}) : null;
  // Freed only when nothing was handed to the binding. A send that threw AFTER it was handed over may still have gone (a timeout, a
  // lost answer), so its key stays held and a retry is told "may already be on its way".
  let dispatched = false;
  // Message-ID is platform-assigned; never set it ourselves. With attachments we build the MIME ourselves: the builder
  // base64-encodes binary parts but labels them quoted-printable (measured in September 2026), which corrupts every attachment.
  let r, raw = null;
  try {
  if (attachments.length) {
    const mm = createMimeMessage();
    mm.setSender(ident?.display_name ? { name: ident.display_name, addr: from } : from);
    const asBox = (x) => (typeof x === "string" ? x : { name: x.name || "", addr: x.email });
    mm.setTo(to.map(asBox));
    if (cc.length) mm.setCc(cc.map(asBox));
    mm.setSubject(subject);
    for (const [k, v] of Object.entries(headers)) mm.setHeader(k, oneHdr(v));   // mimetext writes a custom header's value as it is given
    if (body.replyTo) mm.setHeader("Reply-To", oneHdr(typeof body.replyTo === "string" ? body.replyTo : body.replyTo.email));
    if (text) mm.addMessage({ contentType: "text/plain", data: text });
    if (htmlBody) mm.addMessage({ contentType: "text/html", data: htmlBody });
    for (const a of attachments) {
      let s = ""; for (let i = 0; i < a.content.length; i += 0x8000) s += String.fromCharCode.apply(null, a.content.subarray(i, i + 0x8000));
      mm.addAttachment({ filename: a.filename, contentType: a.type, data: btoa(s), inline: a.disposition === "inline", ...(a.contentId ? { headers: { "Content-ID": `<${a.contentId}>` } } : {}) });
    }
    raw = mm.asRaw();
    const rcpts = [...to, ...cc, ...bcc].map(addrOnly).filter(Boolean);
    const ids = [], undelivered = [];
    // One envelope per recipient: once one has gone, a later failure is reported with the mail, not as "not sent" (sending again
    // would reach the first recipients twice).
    for (const rcpt of rcpts) {
      try { dispatched = true; const res = await env.EMAIL.send(new EmailMessage(from, rcpt, raw)); ids.push(res.messageId); }
      catch (e) { if (!ids.length) throw e; undelivered.push(rcpt); }
    }
    r = { messageId: ids[0], undelivered };
    if (ids.length > 1) await logEvent(db, "sent_multi_envelope", id, ids.join(" "));
  } else {
    dispatched = true; r = await env.EMAIL.send(msg);
  }
  } catch (e) { if (!dispatched) await unclaim(); throw e; }   // nothing was handed over: the key is free for a retry
  if (claimKey) await db.prepare("UPDATE send_claims SET state = 'sent', message_id = ?, platform_id = ?, at = ? WHERE key = ?").bind(id, r.messageId || null, now(), claimKey).run().catch(() => {});
  // The mail has gone. From here a failure must not answer "not sent": the client would offer it as a draft to send again, and the
  // idempotency key below would not have been written.
  const missed = r.undelivered?.length ? `it was not delivered to ${r.undelivered.join(", ")}` : null;
  try {
  const toAddrs = to.map((x) => ({ address: addrOnly(x), name: typeof x === "string" ? "" : x.name || "" }));
  const ccAddrs = cc.map((x) => ({ address: addrOnly(x), name: typeof x === "string" ? "" : x.name || "" }));
  const subjectNorm = normSubject(subject);
  const participants = externalParticipants([from, ...toAddrs.map((a) => a.address), ...ccAddrs.map((a) => a.address)], own);
  const tw = parent
    ? threadWrite(db, parent.thread_id, { subjectNorm, participants, at })
    : threadWrite(db, await resolveThread(db, { inReplyTo: null, references: null, subjectNorm, participants }), { subjectNorm, participants, at, newState: "archived" });
  const threadId = tw.id;

  // The copy under Sent is what went out: the MIME the hub built, and each file's own bytes under att/, the layout received mail uses.
  // It was a JSON summary, and every sent file's row pointed at it, so opening a sent attachment downloaded that ~1 KB record under the
  // file's name, `mail raw` returned JSON, and the sizes were the base64 formula applied to bytes already decoded: 75% of the file.
  //  A send with no files goes through the binding's own builder, which returns no MIME; it keeps the summary.
  const copyKey = `out/${at.slice(0, 4)}/${at.slice(5, 7)}/${id}.${raw ? "eml" : "json"}`;
  if (raw) await env.STORE.put(copyKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
  else await env.STORE.put(copyKey, JSON.stringify({ ...msg, messageId: r.messageId, sent_at: at }), { httpMetadata: { contentType: "application/json" } });
  const fileKeys = [];
  for (const [i, a] of attachments.entries()) {
    const key = `att/${id}/${i + 1}-${safeName(a.filename)}`;
    await env.STORE.put(key, a.content, { httpMetadata: { contentType: a.type } });
    fileKeys.push(key);
  }
  await db.batch([tw.stmt, db.prepare(`INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, to_addrs, cc_addrs, subject, message_id, in_reply_to, refs, body_text, body_html, snippet, raw_key, size_bytes, status, ingest_source, date_hdr, created_at)
    VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 'mailhub', ?, ?)`)
    .bind(id, threadId, from, from, ident?.display_name || "", JSON.stringify(toAddrs), JSON.stringify(ccAddrs), subject, r.messageId, headers["In-Reply-To"] || null, headers["References"] || null,
      (text || "").slice(0, BODY_CAP), (htmlBody || "").slice(0, BODY_CAP), (text || htmlText(htmlBody)).replace(/\s+/g, " ").trim().slice(0, 200), copyKey, approxSize, at, at)])   /* the conversation and its message land together or not at all */;
  for (const [i, a] of attachments.entries()) {
    await db.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), id, a.filename, a.type, a.content.length, fileKeys[i], a.contentId || null, a.disposition).run();
  }
  await logEvent(db, "sent", id, `${from} -> ${toAddrs.map((a) => a.address).join(",")} ${r.messageId}`);
  // An unsubscribe's email is to the address the LIST named, not someone the user wrote to: it never opens a lock.
  if (!body.unsubscribe) try { await lockNoteSent(db, env, from, [...to, ...cc, ...bcc]); } catch (e) { await logEvent(db, "lock_note_sent_fail", id, `${from} ${String(e?.message || e).slice(0, 200)}`); }
  if (body.idempotency_key) await logEvent(db, "send_idem", id, `${body.idempotency_key} ${r.messageId}`);
  if (missed) await logEvent(db, "send_partial_fail", id, missed);
  return { id, thread_id: threadId, message_id: r.messageId, ...(missed ? { warning: missed } : {}) };
  } catch (e) {
    try { await logEvent(db, "send_record_fail", id, `${from} ${r.messageId} ${e?.message}`); } catch (_) {}
    return { id: null, thread_id: null, message_id: r.messageId, warning: [missed, `it was not saved to Sent here (${e?.message})`].filter(Boolean).join("; ") };
  }
}

// Forward a hub message: the note the user wrote, then the original (its HTML when it has one) and the original's files from R2.
// One function for Send now and Send later: a scheduled forward was a plain send and went without the original's files. The note
// is what the user typed above the forwarded block (the client sends only that: the block was sent twice, once from the compose box
// and once from here). Bcc, the subject as edited and the Markdown note now reach the mail; all three were dropped.
async function forwardMessage(env, id, body) {
  const db = env.DB;
  const p = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
  if (!p) throw Object.assign(new Error("message to forward not found"), { code: "not_found" });
  const from = lc(body.from || (p.direction === "in" ? p.identity : p.from_addr));
  const esc = (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const hdr = `---------- Forwarded message ----------\nFrom: ${p.from_name ? p.from_name + " <" + p.from_addr + ">" : p.from_addr}\nDate: ${p.date_hdr || p.created_at}\nSubject: ${p.subject || ""}\nTo: ${JSON.parse(p.to_addrs || "[]").map((a) => a.address).join(", ")}\n\n`;
  const note = body.text ? body.text + "\n\n" : "";
  const text = note + hdr + (p.body_text || htmlText(p.body_html));
  const noteHtml = body.html || (body.text ? `<div>${esc(body.text).replace(/\n/g, "<br>")}</div>` : "");
  const html = p.body_html || body.html ? `${noteHtml}<br><div style="color:#666">${esc(hdr).replace(/\n/g, "<br>")}</div><blockquote style="border-left:2px solid #ccc;padding-left:10px;margin:0">${p.body_html || `<div style="white-space:pre-wrap">${esc(p.body_text)}</div>`}</blockquote>` : null;
  const { results: atts } = await db.prepare("SELECT * FROM attachments WHERE message_id = ?").bind(p.id).all();
  const attachments = [];
  for (const a of atts) {
    if (!a.r2_key || a.r2_key.startsWith("out/")) continue;
    const obj = await env.STORE.get(a.r2_key); if (!obj) continue;
    const buf = new Uint8Array(await obj.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    attachments.push({ filename: a.filename, type: a.content_type || "application/octet-stream", content: btoa(s), disposition: a.disposition === "inline" ? "inline" : "attachment", contentId: a.content_id || undefined });
  }
  const subject = String(body.subject || "").trim() ? String(body.subject) : /^\s*fwd?\s*:/i.test(p.subject || "") ? p.subject : `Fwd: ${p.subject || ""}`;
  return sendMail(env, { from, from_name: body.from_name, to: body.to, cc: body.cc, bcc: body.bcc, subject, text, html, attachments: [...attachments, ...(body.attachments || [])], plain: body.plain, idempotency_key: body.idempotency_key });
}
// A reply to a message you sent goes to the people it went to. It used to go to parent.from_addr, which for your own message is you:
// a follow-up in a conversation holding only your mail was delivered to yourself.
function replyDefaults(parent, own, mode) {
  const addrs = (j) => JSON.parse(j || "[]").map((a) => a.address).filter(Boolean);
  const out = parent.direction === "out";
  const toList = out ? addrs(parent.to_addrs) : [parent.reply_to || parent.from_addr];
  const to = out ? toList : toList[0];
  let cc = [];
  if (mode === "all") {
    const others = (out ? addrs(parent.cc_addrs) : [...addrs(parent.to_addrs), ...addrs(parent.cc_addrs)])
      .filter((a) => !toList.includes(a) && !own.has(a.split("@")[1]));
    cc = [...new Set(others)];
  }
  const subject = /^\s*re\s*:/i.test(parent.subject || "") ? parent.subject : `Re: ${parent.subject || ""}`;
  const from = parent.direction === "in" ? parent.identity : parent.from_addr;
  return { to, cc, subject, from };
}

// ---------- API ----------
// Background work goes to the context of the invocation that started it. This was one module-level function that every scheduled(),
// email() and fetch() call reassigned, so with two invocations in flight in one isolate the first one's work could be handed to the
// second's ctx (and dropped or cut short with it). AsyncLocalStorage carries each invocation's ctx
// through its own awaits; outside any handler (tests calling functions directly) the work simply runs.
const ctxStore = new AsyncLocalStorage();
const ctxWaitUntil = (p) => { const q = p.catch(() => {}); const ctx = ctxStore.getStore(); if (ctx) { try { ctx.waitUntil(q); } catch (_) {} } };
async function api(request, env, url) {
  const db = env.DB;
  const path = url.pathname;
  const m = (re) => path.match(re);
  let x;

  // ONE round trip for what the client needs before it can render. loadAccounts() fired these seven in a Promise.all, which is
  // parallel on the client but still seven request/response pairs over the air: measured at 2.1 x RTT on the critical path, so
  // roughly 0.7 s of a cold boot on a 300 ms mobile link.
  // Each field is computed independently and a failure is reported per-field rather than failing the boot: the client falls back
  // to the individual endpoints for whatever is missing, so this can never be worse than what it replaces.
  if (request.method === "GET" && path === "/api/bootstrap") {
    const part = async (fn) => { try { return await fn(); } catch (e) { return { __error: String(e?.message || e) }; } };
    const [me, gmail, prefs, push, rules, schedule, senders] = await Promise.all([
      part(async () => { const { results } = await db.prepare("SELECT email, display_name, domain FROM identities WHERE is_active = 1 ORDER BY email").all();
        return { identities: results, forward_to: env.FORWARD_TO, imap_accounts: await imapPublicAll(env), img_key: await imgSessionKey(request, env), brands: Object.keys(brandsCfg(env)) }; }),
      part(async () => { const { results } = await db.prepare("SELECT email, status, scope, history_id, poll_history_id, last_poll_at, label, color, created_at, last_minted_at, last_error, watch_expiration FROM gmail_accounts ORDER BY email").all();
        return { accounts: results, configured: gmailConfigured(env) }; }),
      part(async () => {
        const { results } = await db.prepare("SELECT key, value FROM prefs").all(); const o = {};
        for (const r of results) { if (PREF_SERVER_ONLY(r.key)) continue; try { o[r.key] = JSON.parse(r.value); } catch (_) { o[r.key] = r.value; } }
        return { prefs: o }; }),
      part(async () => ({ configured: pushConfigured(env), public_key: env.VAPID_PUBLIC_KEY || null })),
      part(async () => { const { results } = await db.prepare("SELECT * FROM sender_rules ORDER BY created_at DESC").all(); return { rules: results }; }),
      part(async () => { const { results } = await db.prepare("SELECT id, kind, account, ref, due_at, status, created_at, done_at, error, CASE WHEN kind = 'send_later' THEN json_object('subject', json_extract(payload, '$.subject'), 'to', json_extract(payload, '$.to')) ELSE payload END AS payload FROM scheduled_actions WHERE status = 'pending' ORDER BY due_at LIMIT 200").all();
        return { actions: results.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) }; }),
      part(async () => { const { results } = await db.prepare("SELECT * FROM known_senders WHERE status = 'pending' ORDER BY last_seen_at DESC LIMIT 500").all();
        const counts = await db.prepare("SELECT status, COUNT(*) n FROM known_senders GROUP BY status").all();
        return { senders: results, counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])) }; }),
    ]);
    return json({ me, gmail, prefs, push, rules, schedule, senders, version: await appVersion() }); // folds /api/version in too: the eighth round trip
  }
  // Settings' data in ONE round trip. The screen awaited seven GETs one after another before it drew anything: 1.0 s
  // from my Mac on 2026-11-25, more on a phone. Each part is answered by the very route it replaces, through this function,
  // all at once, so the payloads cannot drift apart; a part that fails comes back as { __error } and the app keeps what it had for it.
  if (request.method === "GET" && path === "/api/settings") {
    const parts = { push: "/api/push/subscriptions", quiet: "/api/quiet-rules", trash: "/api/trash-rules", locks: "/api/locks", mention: "/api/mention-rules", trackers: "/api/trackers/status", unsubs: "/api/unsubscribes" };
    const out = {};
    await Promise.all(Object.entries(parts).map(async ([k, p]) => {
      try { const u = new URL(p, url.origin), r = await api(new Request(u, { headers: request.headers }), env, u); out[k] = r.ok ? await r.json() : { __error: String(r.status) }; }
      catch (e) { out[k] = { __error: String(e?.message || e) }; }
    }));
    return json(out, 200, { "cache-control": "no-store" });
  }
  if (request.method === "GET" && path === "/api/me") {
    const { results } = await db.prepare("SELECT email, display_name, domain FROM identities WHERE is_active = 1 ORDER BY email").all();
    return json({ identities: results, forward_to: env.FORWARD_TO, imap_accounts: await imapPublicAll(env), img_key: await imgSessionKey(request, env), brands: Object.keys(brandsCfg(env)) });
  }
  if (request.method === "GET" && path === "/api/threads") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 500);
    const before = url.searchParams.get("before");
    const q = url.searchParams.get("q");
    const box = url.searchParams.get("box") || "inbox";
    // `since_seq` = delta mode: the ordered change feed the triggers write, paged by seq. A seq is exact where a millisecond timestamp
    // was not.
    //  Updates and deletions travel in ONE page, so they cannot overtake each other. A cursor older
    // than what retention kept gets reset_required and the client mirrors in full. Measured: 2 rows read when nothing changed.
    const sinceSeq = url.searchParams.get("since_seq");
    // has_att is the list's paperclip (a vendor's PDF showed no sign of itself in the inbox, because hub rows
    // hard-coded hasAtt false). A part is a FILE unless the message body shows it: its Content-ID appears as cid:… in the HTML. The
    // disposition header cannot decide it. Measured 2026-10-09: of 60 parts with no disposition but a
    // Content-ID the body showed 45, so 15 were files; 3 of 69 marked inline were not shown either. client app.js bodyImage() is the
    // same rule for the message header's count. No rows beyond the thread's own messages and their attachments are read.
    let sql = `SELECT t.id, t.subject_norm, t.participants, t.last_message_at, t.message_count, t.state, t.starred, t.unread, t.labels, t.category, t.updated_at,
      (SELECT json_object('id', m.id, 'direction', m.direction, 'from_addr', m.from_addr, 'from_name', m.from_name, 'identity', m.identity, 'subject', m.subject, 'snippet', m.snippet, 'created_at', m.created_at, 'message_id', m.message_id, 'to_addrs', m.to_addrs, 'list_unsubscribe', m.list_unsubscribe, 'list_unsubscribe_post', m.list_unsubscribe_post)
         FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last,
      (SELECT json_object('list_unsubscribe', m3.list_unsubscribe, 'list_unsubscribe_post', m3.list_unsubscribe_post) FROM messages m3 WHERE m3.thread_id = t.id AND m3.direction = 'in' AND m3.list_unsubscribe IS NOT NULL ORDER BY m3.created_at DESC LIMIT 1) AS unsub,
      (SELECT json_group_array(m2.message_id) FROM messages m2 WHERE m2.thread_id = t.id AND m2.message_id IS NOT NULL) AS msg_ids,
      EXISTS (SELECT 1 FROM messages mi WHERE mi.thread_id = t.id AND mi.direction = 'in') AS has_in,
      EXISTS (SELECT 1 FROM messages mo WHERE mo.thread_id = t.id AND mo.direction = 'out') AS has_out,
      ${HAS_ATT_SQL} AS has_att
      FROM threads t`;
    const binds = [];
    const where = [];
    // A query's in: decides the folder and the box's is not applied: the device searches with box=all, which leaves
    // Trash out, as Gmail's search does when no in: says otherwise. Hub mail has no Spam folder, so in:spam lists none of it.
    const ops = q ? searchQuery(q) : null, SENT_SQL = "EXISTS (SELECT 1 FROM messages ms WHERE ms.thread_id = t.id AND ms.direction = 'out')";
    if (ops && (ops.in.length || ops.notIn.length)) {
      const IN = { inbox: "t.state = 'inbox'", archived: "t.state = 'archived'", trash: "t.state = 'trash'", spam: "0", snoozed: "t.state = 'snoozed'", sent: SENT_SQL, anywhere: "1" };
      for (const v of ops.in) where.push(IN[v]); for (const v of ops.notIn) where.push(`NOT (${IN[v]})`);
      if (!ops.in.some((v) => v === "trash" || v === "spam" || v === "anywhere")) where.push("t.state != 'trash'");
    }
    else if (box === "inbox") where.push("t.state = 'inbox'");
    else if (box === "archived") where.push("t.state = 'archived'");
    else if (box === "trash") where.push("t.state = 'trash'");
    else if (box === "snoozed") where.push("t.state = 'snoozed'");
    else if (box === "starred") { where.push("t.starred = 1 AND t.state != 'trash'"); }
    else if (box === "unread") { where.push("t.unread = 1 AND t.state != 'trash'"); }
    else if (box === "held") { where.push("(t.labels LIKE '%trademark-scam%' OR t.labels LIKE '%locked-out%')"); }
    else if (box === "all") { where.push("t.state != 'trash'"); }
    // Sent is every conversation holding a message the user sent, as Gmail's is, not only those where he wrote last.
    else if (box === "sent") { where.push("t.state != 'trash' AND " + SENT_SQL); }
    if (before) { where.push("t.last_message_at < ?"); binds.push(before); }
    // is:, has:attachment and the dates. The dates are Gmail's, message by message: some one message of the conversation on or after
    // after: and before before: (one range lookup on ix_messages_thread a conversation). has:attachment is the paperclip rule (has_att above).
    if (ops) {
      for (const w of ops.want) where.push({ unread: "t.unread = 1", read: "t.unread = 0", starred: "t.starred = 1", unstarred: "t.starred = 0", att: HAS_ATT_SQL, noatt: `NOT ${HAS_ATT_SQL}` }[w]);
      const when = [];
      if (ops.after != null) { when.push("md.created_at >= ?"); binds.push(new Date(ops.after).toISOString()); }
      if (ops.before != null) { when.push("md.created_at < ?"); binds.push(new Date(ops.before).toISOString()); }
      if (when.length) where.push(`EXISTS (SELECT 1 FROM messages md WHERE md.thread_id = t.id AND ${when.join(" AND ")})`);
    }
    // Every term of the query must appear in the subject, the sender's name or address, or the text of some message of the thread:
    //  a "quoted phrase" is one term, kept whole and in order, as the device's index and Gmail read it. Before this
    // the whole query, quote marks included, was one LIKE pattern, so a quoted phrase found nothing and the sender's name was never read.
    if (q) for (const term of searchTerms(ops.text)) { where.push("t.id IN (SELECT thread_id FROM messages WHERE subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\')"); const like = "%" + term.replace(/[\\%_]/g, "\\$&") + "%"; binds.push(like, like, like, like); }
    const baseSql = sql; // captured before the box/date/query filter is appended: delta mode needs rows in EVERY state
    if (where.length) sql += " WHERE " + where.join(" AND ");
    // `allStates` is the delta's shape. The change feed reports a thread in WHATEVER state it now holds, but these rows used to run
    // through the SAME filter as a normal listing, and `box` defaults to "inbox" (the client's delta call sends no box). So a thread
    // trashed or archived on another device matched no row, fell out of `alive`, and was handed to the client as DELETED. The client
    // then erased its local copy, which took that thread's Message-IDs out of the Gmail-copy dedupe set and unhid the forwarded
    // duplicate in the inbox; 2026-09-18: a mail removed on the phone still showed on the desktop.
    // syncHubDelta's comment already promised "Rows arrive whatever their state"; this is the code finally keeping that promise.
    const rowsOf = async (extraWhere, extraBinds, allStates) => {
      const head = allStates ? baseSql : sql;
      const pre = allStates ? [] : binds;
      const q2 = head + (extraWhere ? (!allStates && where.length ? " AND " : " WHERE ") + extraWhere : "") + " ORDER BY t.last_message_at DESC LIMIT ?";
      const { results } = await db.prepare(q2).bind(...pre, ...extraBinds, limit).all();
      return results.map((r) => ({ ...r, last: r.last ? JSON.parse(r.last) : null, msg_ids: r.msg_ids ? JSON.parse(r.msg_ids) : [] }));
    };
    if (sinceSeq !== null && sinceSeq !== undefined && sinceSeq !== "") {
      const from = parseInt(sinceSeq, 10); if (!Number.isFinite(from) || from < 0) return json({ error: "bad since_seq" }, 400);
      // Two single-aggregate subqueries, one statement: SQLite answers each MIN or MAX on the rowid with one lookup, but MIN and MAX
      // together in one SELECT scanned the whole table, 22,169 rows on every device poll and 98 % of the hub's D1 reads.
      const head = await db.prepare("SELECT (SELECT MIN(seq) FROM thread_changes) mn, (SELECT MAX(seq) FROM thread_changes) mx").first();
      const mx = head?.mx || 0, mn = head?.mn || 0;
      const gmail_status = await gmailMirrorStatus(db, env);                                                  // lets a device know when it can sync Gmail from here
      if (from > mx) return json({ threads: [], deleted: [], cursor: mx, more: false, gmail_status });   // nothing new (or a cursor from before a reset)
      if (mn && from < mn - 1) return json({ reset_required: true, cursor: mx, gmail_status });          // older than retention: mirror in full
      const { results: evs } = await db.prepare("SELECT seq, thread_id, op FROM thread_changes WHERE seq > ? ORDER BY seq LIMIT ?").bind(from, limit).all();
      if (!evs.length) return json({ threads: [], deleted: [], cursor: mx, more: false, gmail_status });
      const lastOp = new Map(); for (const e of evs) lastOp.set(e.thread_id, e.op);                      // within a page the last event for a thread wins
      // Gmail mirror events ('g|<account>|<id>') never reach `threads` or `deleted`, so a client that predates the
      // mirror never sees one. Only an explicit 'd' deletes: a 'u' whose row has gone was pruned, and a pruned message
      // still exists in Gmail, so it is dropped rather than reported deleted.
      const keys = [...lastOp.keys()], hubKeys = keys.filter((k) => !k.startsWith("g|")), gKeys = keys.filter((k) => k.startsWith("g|"));
      const ids = hubKeys.filter((id) => lastOp.get(id) === "u");
      const rows = (await inSlices(ids, (s) => rowsOf(`t.id IN (${qmarks(s)})`, s, true))).sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
      const alive = new Set(rows.map((r) => r.id));
      const deleted = hubKeys.filter((id) => !alive.has(id));                                            // 'd', or 'u' for a row that has since gone
      const gmail = [], gmail_deleted = [], byAcct = new Map();
      for (const k of gKeys) { const i = k.indexOf("|", 2), acct = k.slice(2, i), id = k.slice(i + 1); if (lastOp.get(k) === "d") gmail_deleted.push({ account: acct, id }); else { if (!byAcct.has(acct)) byAcct.set(acct, []); byAcct.get(acct).push(id); } }
      for (const [acct, list] of byAcct) for (let i = 0; i < list.length; i += 100) {
        const { results } = await db.prepare("SELECT account, id, thread_id, labels, internal_date, meta, history_id FROM gmail_messages WHERE account = ? AND id IN (SELECT value FROM json_each(?))").bind(acct, JSON.stringify(list.slice(i, i + 100))).all();
        gmail.push(...results);
      }
      return json({ threads: rows, deleted, ...(gKeys.length ? { gmail, gmail_deleted } : {}), cursor: evs[evs.length - 1].seq, more: evs.length === limit, gmail_status });
    }
    const threads = await rowsOf("", []);
    return json({ threads, cursor: (await db.prepare("SELECT MAX(seq) mx FROM thread_changes").first())?.mx || 0, gmail_status: await gmailMirrorStatus(db, env) });
  }
  // Bulk state change: one request for up to 2,000 threads (D1 batches of 80 UPDATEs), per-target receipt, IMAP write-back per changed thread.
  if (request.method === "POST" && path === "/api/threads/bulk") {
    const b = await request.json().catch(() => ({}));
    const ids = [...new Set((b.ids || []).filter((v) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)))].slice(0, 2000);
    if (!ids.length) return json({ error: "ids required" }, 400);
    const sets = [], binds = [];
    if (b.state !== undefined) { if (!["inbox", "archived", "trash", "snoozed"].includes(b.state)) return json({ error: "bad state" }, 400); sets.push("state = ?"); binds.push(b.state); }
    if (b.starred !== undefined) { sets.push("starred = ?"); binds.push(b.starred ? 1 : 0); }
    if (b.unread !== undefined) { sets.push("unread = ?"); binds.push(b.unread ? 1 : 0); }
    if (!sets.length) return json({ error: "nothing to change" }, 400);
    const changed = [], missing = [];
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const res = await db.batch(chunk.map((id) => db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id)));
      res.forEach((r, j) => ((r.meta?.changes || 0) > 0 ? changed : missing).push(chunk[j]));
    }
    let imapOps = 0; const imapFailed = [];
    for (const id of changed) { try { const q = await imapQueueForThread(env, id, b); imapOps += Array.isArray(q) ? q.length : (q ? 1 : 0); } catch (e) { imapFailed.push(id); } }
    await logEvent(db, "bulk", null, `${sets.join(",")} ${changed.length} changed, ${missing.length} missing, ${imapFailed.length} imap failed`);
    return json({ changed: changed.length, changed_ids: changed, missing, imap_ops: imapOps, imap_failed: imapFailed });
  }
  if (request.method === "PATCH" && (x = m(/^\/api\/threads\/([0-9a-f-]{36})$/))) {
    const b = await request.json();
    const sets = [], binds = [];
    if (b.state !== undefined) { if (!["inbox", "archived", "trash", "snoozed"].includes(b.state)) return json({ error: "bad state" }, 400); sets.push("state = ?"); binds.push(b.state); }
    if (b.starred !== undefined) { sets.push("starred = ?"); binds.push(b.starred ? 1 : 0); }
    if (b.unread !== undefined) { sets.push("unread = ?"); binds.push(b.unread ? 1 : 0); }
    if (!sets.length) return json({ error: "nothing to change" }, 400);
    binds.push(x[1]);
    await db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    const queued = await imapQueueForThread(env, x[1], b);
    const t = await db.prepare("SELECT id, state, starred, unread, labels FROM threads WHERE id = ?").bind(x[1]).first();
    return json({ thread: t, imap_ops: queued });
  }
  if (request.method === "DELETE" && (x = m(/^\/api\/threads\/([0-9a-f-]{36})$/))) {
    // Permanent: only from trash. Removes rows and the R2 objects.
    const t = await db.prepare("SELECT state FROM threads WHERE id = ?").bind(x[1]).first();
    if (!t) return json({ error: "not found" }, 404);
    if (t.state !== "trash") return json({ error: "move to trash first" }, 400);
    const { results: msgs } = await db.prepare("SELECT id, raw_key, message_id, identity, direction FROM messages WHERE thread_id = ?").bind(x[1]).all();
    for (const mm of msgs) {
      const { results: atts } = await db.prepare("SELECT r2_key FROM attachments WHERE message_id = ?").bind(mm.id).all();
      for (const a of atts) if (a.r2_key && !a.r2_key.startsWith("out/")) await env.STORE.delete(a.r2_key).catch(() => {});
      // Tombstone BEFORE the delete: the sweep cannot tell "never indexed" from "deliberately deleted" by key alone,
      // and the object may outlive the row (a second copy, or a delete that quietly failed under.catch). Written
      // first so a crash between the two leaves a tombstone with no object - harmless - rather than an object with
      // no tombstone, which is the pair that resurrected two August messages on 2026-09-19.
      // The tombstone is written FIRST and its failure ABORTS this message's purge. Swallowing it with catch(_){} and
      // deleting anyway produces the one pair that cannot be recovered from: an R2 object with no tombstone and no row,
      // which is precisely what resurrected two August messages on 2026-09-19. Leaving the message in place is the safe
      // failure: nothing is lost and the user can purge again.
      try {
        await db.prepare("INSERT OR IGNORE INTO purged_keys (raw_key, message_id, identity, direction, reason, at) VALUES (?, ?, ?, ?, 'purged', ?)")
          .bind(mm.raw_key || `purged:${mm.id}`, mm.message_id || null, mm.identity || null, mm.direction || null, now()).run();
      } catch (e) {
        try { await logEvent(db, "purge_fail_tombstone", mm.id, String(e?.message || e).slice(0, 200)); } catch (_) {}
        continue;   // leave the row and the bytes exactly as they are
      }
      if (mm.raw_key) await env.STORE.delete(mm.raw_key).catch(() => {});
      await db.prepare("DELETE FROM attachments WHERE message_id = ?").bind(mm.id).run();
    }
    await db.prepare("DELETE FROM messages WHERE thread_id = ?").bind(x[1]).run();
    await db.prepare("DELETE FROM threads WHERE id = ?").bind(x[1]).run();
    await logEvent(db, "thread_deleted", null, `${x[1]} (${msgs.length} messages)`);
    return json({ ok: true, deleted: msgs.length });
  }
  if (request.method === "GET" && (x = m(/^\/api\/threads\/([0-9a-f-]{36})$/))) {
    const t = await db.prepare("SELECT * FROM threads WHERE id = ?").bind(x[1]).first();
    if (!t) return json({ error: "not found" }, 404);
    if (t.unread && url.searchParams.get("keep_unread") !== "1") await db.prepare("UPDATE threads SET unread = 0 WHERE id = ?").bind(x[1]).run();
    const { results } = await db.prepare("SELECT id, thread_id, direction, identity, from_addr, from_name, reply_to, to_addrs, cc_addrs, subject, message_id, in_reply_to, body_text, body_html, snippet, size_bytes, status, ingest_source, gmail_forwarded_at, gmail_copy, labels, date_hdr, created_at, auth_results, lock_kept, lock_root, CASE WHEN lock_kept = 1 THEN (SELECT claim FROM address_locks WHERE address = messages.identity) END AS lock_claim FROM messages WHERE thread_id = ? ORDER BY created_at ASC").bind(x[1]).all();
    const ids = results.map((r) => r.id);
    let atts = [];
    if (ids.length) {
      atts = await inSlices(ids, async (s) => (await db.prepare(`SELECT id, message_id, filename, content_type, size_bytes, content_id, disposition FROM attachments WHERE message_id IN (${qmarks(s)})`).bind(...s).all()).results);
    }
    return json({ thread: t, messages: results.map((r) => ({ ...r, to_addrs: JSON.parse(r.to_addrs || "[]"), cc_addrs: JSON.parse(r.cc_addrs || "[]"), attachments: atts.filter((a) => a.message_id === r.id) })) });
  }
  if (request.method === "GET" && (x = m(/^\/api\/messages\/([0-9a-f-]{36})$/))) {
    const r = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(x[1]).first();
    if (!r) return json({ error: "not found" }, 404);
    const { results: atts } = await db.prepare("SELECT id, filename, content_type, size_bytes, content_id, disposition FROM attachments WHERE message_id = ?").bind(x[1]).all();
    return json({ message: { ...r, to_addrs: JSON.parse(r.to_addrs || "[]"), cc_addrs: JSON.parse(r.cc_addrs || "[]"), attachments: atts } });
  }
  if (request.method === "GET" && path === "/api/imgdims") {
    // Picture sizes for the app: the rows after `since`, grouped by the day each was measured, so the app keeps and
    // drops them a day at a time. A first sync (since=0) takes the last two weeks; the app asks again while `more` is true.
    const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0), LIMIT = 5000;
    const rows = (await (since ? db.prepare("SELECT seq, hk, w, h, at FROM img_dims WHERE seq > ? ORDER BY seq LIMIT ?").bind(since, LIMIT)
      : db.prepare("SELECT seq, hk, w, h, at FROM img_dims WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now', '-14 days') ORDER BY seq LIMIT ?").bind(LIMIT)).all()).results || [];
    // seq still advances past a 0 x 0 row (a size that could not be read); the row itself is not sent.
    const days = {}; for (const x of rows) if (x.w > 0 && x.h > 0) (days[String(x.at).slice(0, 10)] ||= []).push([x.hk, x.w, x.h]);
    return json({ seq: rows.length ? rows[rows.length - 1].seq : since, days, more: rows.length === LIMIT });
  }
  // The pictures the hub blocked beyond the named list, so the app hides the same ones: the rows after `since` as
  // [hk, name, cls, gone]; a first sync takes the live ones of the last two weeks and the newest seq.
  if (request.method === "GET" && path === "/api/trackers") {
    const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0), LIMIT = 5000;
    let rows = [], top = since;
    try {
      rows = (await (since ? db.prepare("SELECT seq, hk, name, cls, gone FROM trk_verdict WHERE seq > ? ORDER BY seq LIMIT ?").bind(since, LIMIT)
        : db.prepare("SELECT seq, hk, name, cls, gone FROM trk_verdict WHERE gone = 0 AND at > ? ORDER BY seq LIMIT ?").bind(isoIn(-14 * 86400e3), LIMIT)).all()).results || [];
      top = rows.length ? rows[rows.length - 1].seq : since;
      if (!since && rows.length < LIMIT) top = (await db.prepare("SELECT COALESCE(MAX(seq), 0) s FROM trk_verdict").first()).s;
    } catch (_) {}
    return json({ seq: top, rows: rows.map((r) => [r.hk, r.name, r.cls, r.gone]), more: rows.length === LIMIT });
  }
  if (request.method === "GET" && path === "/api/trackers/status") return json(await trkStatus(env));
  // Undo (a veto on the pattern), and taking an Undo back.
  if (request.method === "POST" && path === "/api/trackers/veto") {
    const b = await request.json().catch(() => ({}));
    const pattern = String(b.pattern || (b.url ? trkPattern(String(b.url)) : "")).slice(0, 400);
    if (!/^[*a-z0-9.-]+\.[a-z0-9-]+\/\S*$/i.test(pattern)) return json({ error: "a pattern is a host and a path" }, 400);
    return json({ ok: true, pattern, withdrawn: await trkVeto(env, pattern) });
  }
  if (request.method === "DELETE" && path === "/api/trackers/veto") {
    await db.prepare("DELETE FROM trk_rules WHERE pattern = ? AND kind = 'veto'").bind(String(url.searchParams.get("pattern") || "")).run(); TRK.at = 0;
    return json({ ok: true });
  }
  // The lists fetched and checked now, and the learner run, instead of at the cron's hour.
  if (request.method === "POST" && path === "/api/trackers/refresh") {
    const b = await request.json().catch(() => ({}));
    const lists = await trkRefreshLists(env, { force: !!b.force });
    return json({ lists, learned: await trkLearn(env) });
  }
  if (request.method === "GET" && path === "/api/img") {
    // A named spy tracker is never fetched, whoever asks: the client already disarms them (app.js blockSpyTrackers), and this is the
    // backstop for any path that did not: answered empty, with the vendor's name, the way Proton's proxy reports one.
    { let t = null; try { t = spyTrackerName(new URL(url.searchParams.get("u") || "").href); } catch (_) {} if (t) return new Response(null, { status: 204, headers: { "x-tracker": t, "cache-control": "private, max-age=86400" } }); }
    // Server-side image proxy: remote mail images often carry Cross-Origin-Resource-Policy: same-origin (many sites do),
    // which makes browsers refuse to embed them from any other page. Fetching here, like Gmail's proxy, sidesteps that and
    // keeps my IP out of tracking pixels. Hardened: image/* only, declared-length precheck,
    // streamed byte cap, redirects validated hop by hop, no IP-literal or localhost targets.
    let u; try { u = new URL(url.searchParams.get("u") || ""); } catch (_) { return new Response("bad url", { status: 400 }); }
    if (!/^https?:$/.test(u.protocol) || badHost(u.hostname)) return new Response("bad target", { status: 400 });
    // An address the hub would never fetch at arrival (past 2,048 characters, or a host longer than any DNS name) is not fetched at an
    // open either.
    if (u.href.length > 2048 || u.hostname.length > 253) return new Response("bad target", { status: 400 });
    // The size asked for: w=1080 from a phone, 1600 otherwise (and from an app older than the sizes, which sends no w).
    // A warm-up (x-warm: 1, the app filling its cache for the mails it is about to show) is answered only from what the hub holds: it
    // never reaches a sender and never waits for an arrival fetch.
    const want = url.searchParams.get("w") === "1080" ? 1080 : 1600, warm = request.headers.get("x-warm") === "1";
    const key = await imgKey(u.href), sha = key.slice(4);
    const cache = caches.default;
    const ck = new Request(`https://mailhub-img-cache/w${want}/` + encodeURIComponent(u.href));
    const hit = await cache.match(ck);
    if (hit) { const r = new Response(hit.body, hit); r.headers.set("cache-control", IMG_CC_SIZED); r.headers.set("x-img-source", "edge"); imgSeen(env, sha); return r; }
    // An image the hub already holds is served from R2, fetched when its mail arrived (prefetchImages) or the first time it was
    // opened, so the sender's server is not asked again and learns nothing about this open; R2 also answers faster than a
    // cold upstream. Only an image the hub has never seen is fetched now, and then kept. The phone's size, else the
    // desktop size, else the original; only a written size goes to the edge cache, since an original may yet be replaced.
    for (const k of want === 1080 ? [`imgv/${sha}-1080`, `imgv/${sha}-1600`] : [`imgv/${sha}-1600`]) {
      const v = await env.STORE.get(k).catch(() => null); if (!v) continue;
      // The size asked for is final. The desktop size standing in for the phone's is final only when it is no wider than the phone's
      // (then no phone size is ever written); otherwise it is kept 5 minutes and not edge-cached, or the phone would keep it a year.
      const final = !k.endsWith(`-${IMG_WIDTHS[0]}`) || want === IMG_WIDTHS[0] || (+(v.customMetadata?.w || 0) > 0 && +v.customMetadata.w <= PHONE_W);
      const res = imgResponse(v.body, v.httpMetadata?.contentType || "image/webp", "r2-" + k.slice(-4), final ? IMG_CC_SIZED : IMG_CC_ORIGINAL);
      if (final) { try { ctxWaitUntil(cache.put(ck, edgeCopy(res.clone()))); } catch (_) {} }
      imgSeen(env, sha); return res;
    }
    const kept = await env.STORE.get(key).catch(() => null);
    if (kept) { imgSeen(env, sha); console.log("img r2"); return imgResponse(kept.body, kept.httpMetadata?.contentType || "application/octet-stream", "r2"); }
    // The img Worker deletes an original only after writing its desktop size, so an original gone between the two reads above has a
    // size now: serve it rather than fall through to the queue or the sender.
    { const late = await env.STORE.get(`imgv/${sha}-1600`).catch(() => null);
      if (late) { imgSeen(env, sha); return imgResponse(late.body, late.httpMetadata?.contentType || "image/webp", "r2-1600", IMG_CC_ORIGINAL); } }
    if (warm) return new Response(null, { status: 204, headers: { "x-img-source": "not-held", "cache-control": "no-store" } });
    // A picture with a queue row is never asked of its sender at an open: an arrival fetch under way is waited for, up
    // to 8 s; otherwise the open is answered 404 "withheld", and the cron's retries, timed by the arrival, keep trying. A failed arrival
    // fetch, forced by the sender or not, so no longer turns the open into the fetch that tells them.
    const hk = urlHash(u.href); let qrow = null;
    try { qrow = await db.prepare("SELECT url, fetching_until FROM img_queue WHERE hk = ?").bind(hk).first(); } catch (_) {}
    if (qrow && qrow.url === u.href) {
      const waitUntil = qrow.fetching_until ? Math.min(Date.now() + 8000, Date.parse(qrow.fetching_until) || 0) : 0;
      while (Date.now() < waitUntil) {
        await new Promise((res) => setTimeout(res, 400));
        const late = await env.STORE.get(key).catch(() => null);
        if (late) { imgSeen(env, sha); console.log("img r2 after waiting for arrival"); return imgResponse(late.body, late.httpMetadata?.contentType || "application/octet-stream", "r2"); }   // an original: not edge-cached
      }
      try { ctxWaitUntil(db.prepare("UPDATE img_queue SET opens = opens + 1 WHERE hk = ?").bind(hk).run().catch(() => {})); } catch (_) {}
      return new Response(null, { status: 404, headers: { "x-img-source": "withheld", "cache-control": "no-store" } });
    }
    // A picture of mail received since the picture queue began and less than 90 days ago is never fetched from its sender at an open:
    // the hub fetched what it could when the mail arrived, and one it did not keep (past a mail's 200, behind a lost write, swept in a
    // race with a new arrival) stays blank rather than tell the sender when the mail was read.
    //  `t` is the mail's arrival as the hub or Gmail received it, which the app sends for received mail only. Older mail, mail
    // from before the queue, and an app that sends no `t` are fetched at the open as before: re-download on revisit.
    { const t = +url.searchParams.get("t") || 0;
      if (t >= IMG_OPEN_SINCE && Date.now() - t < IMG_KEEP_MS) return new Response(null, { status: 404, headers: { "x-img-source": "not-kept", "cache-control": "no-store" } }); }
    // A list or a learned pattern is asked only here, before the sender would be: a picture already held, or queued, costs it nothing.
    { await trkLoad(env).catch(() => {}); const v = trkVerdict(u.href, null); if (v) return new Response(null, { status: 204, headers: { "x-tracker": v.name, "cache-control": "private, max-age=86400" } }); }
    // The DNS check (two DNS-over-HTTPS lookups) guards a fetch, so it runs only now: an image already held was checked when it was
    // fetched, and making every R2 or edge-cache hit wait on DNS cost ~100 ms an image for nothing.
    if (await resolvesPrivate(u.hostname)) return new Response("bad target", { status: 400 });
    // An open of a picture with no row (its mail came before the queue, or was never prefetched) is
    // counted, so the queue's effect is read from the hub's own events.
    try { ctxWaitUntil(logEvent(db, "img_open_upstream", null, u.hostname).catch(() => {})); } catch (_) {}
    const got = await fetchImageSafely(u);
    if (!got.ok) return new Response(got.msg, { status: got.status });
    const res = imgResponse(got.body, got.ct, "upstream"); console.log("img upstream", u.hostname);
    // Past the day allowance, or while another big picture is being kept, it is streamed to the device alone, kept nowhere, and fetched
    // again on its next open. Nothing fetched here goes to the edge cache: it is an original, which its sizes will replace.
    const size = got.len || IMG_MAX, big = size > PREFETCH_IMG_MAX;
    // The big-picture slot is taken before anything is awaited, so two opens arriving together cannot both take it.
    if (big && bigKeepBusy) { console.log("img not kept: a big picture is already being kept", size); res.headers.set("cache-control", IMG_CC_UNKEPT); return res; }
    if (big) bigKeepBusy = true;
    if (!(await openKeepAllowed(env, size).catch(() => false))) { if (big) bigKeepBusy = false; console.log("img not kept: day allowance", size); res.headers.set("cache-control", IMG_CC_UNKEPT); return res; }
    try {
      const copy = res.clone();
      ctxWaitUntil(copy.arrayBuffer().then(async (buf) => {
        await env.STORE.put(key, buf, { httpMetadata: { contentType: got.ct }, customMetadata: { at: now(), via: "open" } });
        await imgDimsRow(db, u.href, buf)?.run().catch(() => {}); for (const st of imgKeptRows(db, key, buf, got.ct)) await st.run().catch(() => {});
        await logEvent(db, "img_open_kept", null, `stored=1 bytes=${buf.byteLength}`);
      }).finally(() => { if (big) bigKeepBusy = false; }));
    } catch (_) { if (big) bigKeepBusy = false; }
    return res;
  }
  if (request.method === "GET" && (x = m(/^\/api\/raw\/([0-9a-f-]{36})$/))) {
    const r = await db.prepare("SELECT raw_key FROM messages WHERE id = ?").bind(x[1]).first();
    if (!r?.raw_key) return json({ error: "not found" }, 404);
    const obj = await env.STORE.get(r.raw_key);
    if (!obj) return json({ error: "object missing" }, 404);
    return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "message/rfc822", "content-disposition": `attachment; filename="${x[1]}.eml"`, "cache-control": "no-store, private", "x-content-type-options": "nosniff" } });
  }
  // Inline images in GMAIL mail had no way to load. proxyImages() resolves a `cid:` reference by looking the attachment up and
  // using its `url`: the hub adapter supplies one (`/api/att/<id>`), the Gmail adapter supplied none, so `cid()` returned "" and
  // every inline image rendered with an empty src. Found 2026-09-18 on a USPS Informed Delivery digest, whose mail-piece scans are
  // all `cid:` parts; it affected every Gmail message with inline images, which is most newsletters with a logo.
  // A blob: URL would not have worked either (the message frame's CSP is `img-src 'self' data:`) so this serves the bytes from
  // the Worker, same-origin, exactly as the hub's own attachments are served.
  if (request.method === "GET" && (x = m(/^\/api\/gmail\/att\/([^/]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/))) {
    const email = lc(decodeURIComponent(x[1]));
    const acct = await db.prepare("SELECT email FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(email).first();
    if (!acct) return json({ error: "unknown account" }, 404);
    let bytes;
    try {
      const tok = await gmailAccessToken(env, email);
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${x[2]}/attachments/${x[3]}`, { headers: { authorization: "Bearer " + tok.access_token } });
      if (!r.ok) return json({ error: `gmail ${r.status}` }, r.status === 404 ? 404 : 502);
      const j = await r.json();
      bytes = Uint8Array.from(atob(String(j.data || "").replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    } catch (e) { return json({ error: e?.message || "fetch failed" }, 502); }
    // The caller says what it expects, but it is never trusted: only real image types are served as themselves, and anything else
    // is an octet-stream download. That keeps an attacker-supplied part from being rendered as html or svg inside the frame.
    const want = lc(url.searchParams.get("mime") || "");
    const ct = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(want) ? want : "application/octet-stream";
    // The file's own name, so a download is "Q3 Update.pdf" and not the attachment id with no extension (A
    // PDF saved on the Mac under its attachment id, 99,487 correct bytes that nothing would open). filename= carries an
    // ASCII-safe copy for old clients; filename*= (RFC 6266 / 5987) the real UTF-8 name, percent-encoded so no quote or CR/LF survives.
    const name = String(url.searchParams.get("name") || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    const disp = (ct === "application/octet-stream" ? "attachment" : "inline") + (name ? `; filename="${safeName(name)}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}` : "");
    return new Response(bytes, { headers: {
      "content-type": ct,
      "content-disposition": disp,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    } });
  }
  if (request.method === "GET" && (x = m(/^\/api\/att\/([0-9a-f-]{36})$/))) {
    const a = await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(x[1]).first();
    if (!a) return json({ error: "not found" }, 404);
    // A file sent before 2026-10-12 was never kept: its row points at the send's JSON summary, which is not the file.
    // Say so, rather than hand the summary over under the file's name.
    if (/^out\/.*\.json$/.test(a.r2_key || "")) return json({ error: "this sent file was not kept (sent before 2026-10-12); only its name is on record" }, 410);
    const obj = await env.STORE.get(a.r2_key);
    if (!obj) return json({ error: "object missing" }, 404);
    const ct = (a.content_type || "application/octet-stream").toLowerCase();
    // Served as itself only when it is a picture, like /api/gmail/att above. The old list of types to refuse missed
    // text/ecmascript, application/ecmascript, text/jscript, text/livescript and text/x-ecmascript, which a <script src> on this origin
    // runs under the shell's `script-src 'self'`. The app reads attachment bytes and sniffs them; it never relies on this header.
    const active = !/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(ct.split(";")[0].trim());
    const inlineOk = a.disposition === "inline" && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(ct);
    return new Response(obj.body, { headers: {
      "content-type": active ? "application/octet-stream" : ct,
      "content-disposition": `${inlineOk ? "inline" : "attachment"}; filename="${safeName(a.filename)}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "no-store, private",
    } });
  }
  if (request.method === "POST" && path === "/api/send") {
    const body = await request.json();
    try { return json(await sendMail(env, body)); } catch (e) { return sendErr(e); }
  }
  // /reply/preview resolves the same reply and sends nothing (`mail reply --dry-run`). It is its own path, not a flag
  // in the body, so a hub that predates it answers 404 instead of sending.
  if (request.method === "POST" && (x = m(/^\/api\/messages\/([0-9a-f-]{36})\/reply(\/preview)?$/))) {
    const body = await request.json();
    const parent = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(x[1]).first();
    if (!parent) return json({ error: "not found" }, 404);
    const own = await ownDomains(db, env);
    const d = replyDefaults(parent, own, body.mode === "all" ? "all" : "one");
    try {
      return json(await sendMail(env, { from: body.from || d.from, from_name: body.from_name, to: body.to || d.to, cc: body.cc ?? d.cc, subject: body.subject || d.subject, text: body.text, html: body.html, plain: body.plain, reply_to_id: parent.id, attachments: body.attachments, inline_images: body.inline_images, idempotency_key: body.idempotency_key }, { dryRun: !!x[2] }));
    } catch (e) { return sendErr(e); }
  }
  if (request.method === "POST" && (x = m(/^\/api\/messages\/([0-9a-f-]{36})\/forward$/))) {
    const body = await request.json();
    if (!body.to) return json({ error: "to is required" }, 400);
    try { return json(await forwardMessage(env, x[1], body)); }
    catch (e) { return e.code === "not_found" ? json({ error: "not found" }, 404) : sendErr(e); }
  }
  if (request.method === "GET" && path === "/api/rules") {
    const { results } = await db.prepare("SELECT * FROM rules ORDER BY priority, id").all();
    return json({ rules: results });
  }
  // ---- Push subscriptions (each installed device registers once; the Worker is the only sender) ----
  if (request.method === "GET" && path === "/api/push/config") return json({ configured: pushConfigured(env), public_key: env.VAPID_PUBLIC_KEY || null });
  if (request.method === "GET" && path === "/api/push/subscriptions") { const { results } = await db.prepare("SELECT id, ua, created_at, last_ok_at, last_error, fail_count FROM push_subscriptions ORDER BY created_at").all(); return json({ subscriptions: results }); }
  // The Android app registers its FCM token here (and again whenever Firebase rotates it).
  if (path === "/api/push/fcm" && (request.method === "POST" || request.method === "DELETE")) {
    const b = await request.json().catch(() => ({}));
    const token = String(b.token || "");
    if (!/^[A-Za-z0-9_:\-]{20,4096}$/.test(token)) return json({ error: "bad token" }, 400);
    if (request.method === "DELETE") { await db.prepare("DELETE FROM fcm_devices WHERE token = ?").bind(token).run(); return json({ ok: true }); }
    // A rotated token is the same phone: its row moves to the new token, keeping what it is showing, what it is owed and any
    // demotion, instead of a second row that the phone's new id does not match.
    const prev = String(b.previous || "");
    if (prev && prev !== token && /^[A-Za-z0-9_:\-]{20,4096}$/.test(prev)) {
      const moved = await db.prepare("UPDATE fcm_devices SET token = ? WHERE token = ? AND NOT EXISTS (SELECT 1 FROM fcm_devices WHERE token = ?)").bind(token, prev, token).run();
      if (!moved.meta?.changes) await db.prepare("DELETE FROM fcm_devices WHERE token = ?").bind(prev).run();
    }
    // The phone's push key: 32 random bytes, base64url. Sent with every registration, so a row that lost it, or a phone
    // that made a new one (its data cleared), is put right at the next launch. An app without one (1.12 and older) stores NULL.
    const pushKey = /^[A-Za-z0-9_-]{43}$/.test(String(b.key || "")) ? String(b.key) : null;
    await db.prepare("INSERT INTO fcm_devices (token, ua, push_key) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET ua = excluded.ua, push_key = excluded.push_key").bind(token, String(b.ua || request.headers.get("user-agent") || "").slice(0, 300), pushKey).run();
    await logEvent(db, "fcm_registered", null, String(b.ua || "").slice(0, 120));
    return json({ ok: true, configured: !!env.FCM_SERVICE_ACCOUNT, sealed: !!pushKey });
  }
  // The app's own corrections to what the hub thinks it is showing: a notification swiped away, or a new-mail push
  // that arrived with the app in front (the list updated itself; nothing was posted). Either way, no HIGH dismissal for it later.
  if (request.method === "POST" && path === "/api/push/fcm/gone") {
    const b = await request.json().catch(() => ({}));
    const d = await fcmDeviceById(db, b.device); if (!d) return json({ error: "unknown device" }, 404);
    // As many as the client's own handled report carries: a sweep of a full shade must not leave a tail believed on screen.
    const gone = new Set((Array.isArray(b.keys) ? b.keys : []).filter((k) => typeof k === "string" && k.length <= 200).slice(0, 200));
    await fcmUpdateTags(db, d.token, (live, pend) => [live.filter((k) => !gone.has(k)), pend.filter((e) => !gone.has(e.k))]);
    return json({ ok: true });
  }
  // The app saw one of our HIGH messages delivered at NORMAL (getPriority() below getOriginalPriority()): Firebase has started to
  // demote this app. Dismissals go NORMAL for the next 7 days, so they can never be what keeps new mail slow. Only that pair is
  // accepted (RemoteMessage PRIORITY_HIGH = 1): a malformed report must not hold dismissals at NORMAL.
  if (request.method === "POST" && path === "/api/push/fcm/demoted") {
    const b = await request.json().catch(() => ({}));
    const d = await fcmDeviceById(db, b.device); if (!d) return json({ error: "unknown device" }, 404);
    if (Number(b.original) !== 1 || !(Number(b.priority) >= 0) || Number(b.priority) === 1) return json({ error: "not a demotion: sent HIGH (1), delivered lower" }, 400);
    await db.prepare("UPDATE fcm_devices SET demoted_at = ? WHERE token = ?").bind(now(), d.token).run();
    await logEvent(db, "fcm_demoted", null, `${String(b.kind || "?").slice(0, 20)} delivered at ${Number(b.priority)}, sent ${Number(b.original)}`);
    return json({ ok: true, until: new Date(Date.now() + FCM_DEMOTED_MS).toISOString() });
  }
  // FCM told the app it discarded the messages it was holding (onDeletedMessages: over 100 stored). Mail notifications may be lost
  // with them; logged as a failure so the daily report shows it.
  if (request.method === "POST" && path === "/api/push/fcm/overflow") {
    const b = await request.json().catch(() => ({}));
    const d = await fcmDeviceById(db, b.device); if (!d) return json({ error: "unknown device" }, 404);
    await logEvent(db, "fcm_overflow_fail", null, "FCM discarded this device's stored messages (onDeletedMessages)");
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/api/push/subscribe") {
    const b = await request.json().catch(() => ({}));
    const s = b.subscription || b;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth || !/^https:\/\//.test(s.endpoint)) return json({ error: "subscription with endpoint + keys required" }, 400);
    { let host = ""; try { host = new URL(s.endpoint).hostname.toLowerCase(); } catch (_) {} // only real browser push services receive our (encrypted) pushes
      const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.samsungosp\.com|jpush\.cn)$/;
      if (!PUSH_HOSTS.test(host)) return json({ error: `push endpoint host ${host} is not a known push service` }, 400); }
    const id = uuid();
    const caps = JSON.stringify((Array.isArray(b.caps) ? b.caps : []).filter((c) => typeof c === "string" && /^[a-z0-9_-]{1,32}$/.test(c)).slice(0, 16));
    await db.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, ua, created_at, caps) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, caps = excluded.caps, last_error = NULL, fail_count = 0").bind(id, s.endpoint, s.keys.p256dh, s.keys.auth, (b.ua || request.headers.get("user-agent") || "").slice(0, 200), now(), caps).run();
    const row = await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").bind(s.endpoint).first();
    await logEvent(db, "push_subscribed", null, `${row.id} ${(b.ua || request.headers.get("user-agent") || "").slice(0, 80)}`);
    return json({ ok: true, id: row.id });
  }
  if (request.method === "DELETE" && path === "/api/push/subscribe") {
    const b = await request.json().catch(() => ({}));
    const r = await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(b.endpoint || "").run();
    return json({ ok: true, removed: r.meta?.changes ?? 0 });
  }
  if (request.method === "POST" && path === "/api/gmail/watch") { // set up or renew the Gmail push watch by hand (the daily job does it too)
    if (!gmailPushConfigured(env)) return json({ error: "Gmail push is not configured", need: { GMAIL_PUBSUB_TOPIC: !!env.GMAIL_PUBSUB_TOPIC, GMAIL_PUSH_SA: !!env.GMAIL_PUSH_SA, GMAIL_PUSH_AUDIENCE: !!env.GMAIL_PUSH_AUDIENCE, GMAIL_PUSH_SECRET: !!env.GMAIL_PUSH_SECRET }, hint: "topic, service account and audience go in wrangler.toml [vars]; the secret is `wrangler secret put GMAIL_PUSH_SECRET`" }, 400);
    return json({ watches: await gmailWatchAll(env) });
  }
  // The native app's notification feed (migration 0026). Called without `since` it answers only the current cursor, so a
  // freshly launched app starts from now instead of replaying three days of notifications.
  if (request.method === "GET" && path === "/api/notify/feed") {
    const since = url.searchParams.get("since");
    const head = await db.prepare("SELECT COALESCE(MAX(seq), 0) mx FROM notify_feed").first();
    if (since === null || since === "") return json({ cursor: head.mx, items: [] });
    const from = parseInt(since, 10); if (!Number.isFinite(from) || from < 0) return json({ error: "bad since" }, 400);
    const { results } = await db.prepare("SELECT seq, kind, payload FROM notify_feed WHERE seq > ? ORDER BY seq LIMIT 200").bind(from).all();
    const items = results.map((r) => { let p = {}; try { p = JSON.parse(r.payload); } catch (_) {} return { seq: r.seq, kind: r.kind, ...p }; });
    // The user's notification buttons (Settings → Buttons on notifications), read now rather than stored with each row, so the
    // Windows app's toasts show what the phone's do and a change applies to the next one. Read only when there is mail to show.
    const mail = items.some((it) => it.thread && ["gmail", "hub", "imap"].includes(it.kind));
    return json({ cursor: items.length ? items[items.length - 1].seq : Math.max(from, 0) > head.mx ? head.mx : from, items, ...(mail ? { acts: await notifyButtons(env) } : {}) });
  }
  if (request.method === "POST" && path === "/api/notify/handled") { // one debounced call per burst of actions; the dismissal now leaves WITH it
    const b = await request.json().catch(() => ({}));
    // Which device is reporting. It has already closed its own notifications (layer (a)), so it is excluded from the dismissal
    // that follows, otherwise the device that did the work gets woken to close nothing, with an empty shade, which is the one
    // case that costs push budget.
    // The Android app names itself (`fcm:<id>`, Hub.kt deviceId): it has no Web Push endpoint, and without this the hub woke it
    // to close notifications it had closed itself.
    const by = (FCM_DEVICE_RE.test(String(b.device || "")) ? b.device : null) || await actorId(db, b.endpoint);
    // `age`: how long ago the client acted (ms, its own clock against itself), so the handled time is the action's, not this arrival's.
    const age = Math.min(Math.max(Number(b.age) || 0, 0), 120_000);
    const entries = await addHandled(env, Array.isArray(b.keys) ? b.keys : [], by, age ? Date.now() - age : null);
    if (entries.length) ctxWaitUntil(sendDismissPush(env, entries, "client").catch(() => {}));   // not awaited: the client is waiting on this request
    return json({ ok: true, recorded: entries.length });
  }
  // Don't-notify rules: listed in Settings, added from a conversation's menu or a notification's "Stop these" button.
  if (request.method === "GET" && path === "/api/quiet-rules") { const { results } = await db.prepare("SELECT * FROM quiet_rules ORDER BY created_at DESC").all(); return json({ rules: results }); }
  if (request.method === "POST" && path === "/api/quiet-rules") {
    const b = await request.json().catch(() => ({}));
    const r = await addQuietRule(env, b.sender, b.subject); if (!r) return json({ error: "sender must be an address or *@domain" }, 400);
    await logEvent(db, "quiet_rule_added", null, `${r.sender}${r.subject ? ` "${r.subject}"` : ""} (settings or menu)`); return json({ rule: r });
  }
  if ((x = m(/^\/api\/quiet-rules\/([0-9a-f-]{36})$/)) && request.method === "DELETE") { const r = await db.prepare("DELETE FROM quiet_rules WHERE id = ?").bind(x[1]).run(); return json({ ok: true, removed: r.meta?.changes ?? 0 }); }
  // Trash rules: listed in Settings → Sender rules, added there or from a conversation's "Trash mail like this…".
  if (request.method === "GET" && path === "/api/trash-rules") { const { results } = await db.prepare("SELECT * FROM trash_rules ORDER BY created_at DESC").all(); return json({ rules: results }); }
  if (request.method === "POST" && path === "/api/trash-rules") {
    const b = await request.json().catch(() => ({}));
    const scope = trashScope(b.scope), name = trashWords(b.name), subject = trashWords(b.subject);
    if (!scope) return json({ error: "scope must be an address, *@domain or *" }, 400);
    if (!name && !subject) return json({ error: "a rule needs words of the sender's name or of the subject" }, 400);
    await db.prepare("INSERT INTO trash_rules (id, scope, name, subject, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, name, subject) DO NOTHING").bind(uuid(), scope, name, subject, now()).run();
    const rule = await db.prepare("SELECT * FROM trash_rules WHERE scope = ? AND name = ? AND subject = ?").bind(scope, name, subject).first();
    await logEvent(db, "trash_rule_added", null, `${scope}${name ? ` name "${name}"` : ""}${subject ? ` subject "${subject}"` : ""}`);
    return json({ rule });
  }
  if ((x = m(/^\/api\/trash-rules\/([0-9a-f-]{36})$/)) && request.method === "DELETE") {
    const r = await db.prepare("DELETE FROM trash_rules WHERE id = ?").bind(x[1]).run();
    if (r.meta?.changes) await logEvent(db, "trash_rule_removed", null, x[1]);
    return json({ ok: true, removed: r.meta?.changes ?? 0 });
  }
  // "Delete unless it mentions" rules, listed, added and removed in Settings, with what they decided lately.
  if (request.method === "GET" && path === "/api/mention-rules") {
    const { results } = await db.prepare("SELECT * FROM mention_rules ORDER BY created_at DESC").all();
    const recent = (await db.prepare("SELECT account, decision, from_addr, subject, at FROM mention_decisions ORDER BY at DESC LIMIT 20").all()).results;
    return json({ rules: results.map((r) => ({ ...r, words: parseJsonOr(r.words, []) })), recent });
  }
  if (request.method === "POST" && path === "/api/mention-rules") {
    const b = await request.json().catch(() => ({}));
    const pattern = lc(b.pattern), scope = lc(b.scope || "*") || "*", dom = pattern.split("@")[1] || "";
    if (pattern.length > 254 || !/^(\*|[^\s@*<>"(),;:\\]{1,64})@[^\s@*<>"(),;:\\]{1,253}$/.test(pattern) || !dom.includes(".")) return json({ error: "pattern must be an address or *@domain" }, 400);
    if (pattern.startsWith("*@") && MENTION_DOMAIN_REFUSED.test(dom)) return json({ error: `${dom} is shared by many senders; name an address there instead` }, 400);
    if (scope !== "*" && scope !== MENTION_HUB && !(await db.prepare("SELECT 1 x FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(scope).first())) return json({ error: "scope must be *, hub or a connected Gmail account" }, 400);
    const words = [...new Set((Array.isArray(b.words) ? b.words : String(b.words || "").split(",")).map((w) => String(w).replace(/\s+/g, " ").trim()).filter(Boolean))];
    if (!words.length || words.length > MENTION_WORDS_MAX || words.some((w) => w.length < 2 || w.length > 60)) return json({ error: `words: 1 to ${MENTION_WORDS_MAX}, each 2 to 60 characters` }, 400);
    await db.prepare("INSERT INTO mention_rules (id, pattern, scope, words, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pattern, scope) DO UPDATE SET words = excluded.words").bind(uuid(), pattern, scope, JSON.stringify(words), now()).run();
    const row = await db.prepare("SELECT * FROM mention_rules WHERE pattern = ? AND scope = ?").bind(pattern, scope).first();
    await logEvent(db, "mention_rule", null, `${pattern} scope=${scope} words=${words.join(" | ")}`);
    return json({ ok: true, rule: { ...row, words } });
  }
  // Which conversations already here a rule would have deleted (one step to trash a sender's mail except what mentions
  // the words). The client names the conversations it holds from the sender; each is read as the rule reads a new message
  // (mentionThreadVerdict). Nothing moves here: the client trashes the ones the user confirms, through its own queue, with Undo.
  if (request.method === "POST" && path === "/api/mention-rules/check") {
    const b = await request.json().catch(() => ({}));
    const words = [...new Set((Array.isArray(b.words) ? b.words : String(b.words || "").split(",")).map((w) => String(w).replace(/\s+/g, " ").trim()).filter(Boolean))];
    if (!words.length || words.length > MENTION_WORDS_MAX || words.some((w) => w.length < 2 || w.length > 60)) return json({ error: `words: 1 to ${MENTION_WORDS_MAX}, each 2 to 60 characters` }, 400);
    const live = new Set((await db.prepare("SELECT email FROM gmail_accounts WHERE status = 'active'").all()).results.map((r) => lc(r.email)));
    const asked = Array.isArray(b.threads) ? b.threads : [], seen = new Set(), list = [];
    for (const t of asked) {
      const account = lc(t?.account), thread = String(t?.thread || "");
      if (!(account === MENTION_HUB ? /^[0-9a-f-]{36}$/i.test(thread) : live.has(account) && /^[0-9a-f]{6,32}$/i.test(thread)) || seen.has(account + "|" + thread)) continue;
      seen.add(account + "|" + thread); list.push({ account, thread }); if (list.length >= MENTION_CHECK_MAX) break;
    }
    const own = await ownAddresses(env), toks = new Map(), results = [];
    const one = async ({ account, thread }) => {
      try {
        if (account === MENTION_HUB) {   // mail at your own domains and the work mailbox: its stored text
          const rows = (await db.prepare("SELECT direction, subject, body_text, body_html FROM messages WHERE thread_id = ?").bind(thread).all()).results || [];
          return results.push({ account, thread, d: mentionHubVerdict(rows, words, own) });
        }
        if (!toks.has(account)) toks.set(account, gmailCachedToken(env, account));
        const th = await gmailApi(await toks.get(account), `threads/${encodeURIComponent(thread)}?format=full`);
        results.push({ account, thread, d: mentionThreadVerdict(th.messages || [], words, own) });
      } catch (_) { results.push({ account, thread, d: "unsure" }); }   // not read: never trashed
    };
    for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map(one));
    return json({ results, checked: list.length, capped: asked.length > list.length });
  }
  if ((x = m(/^\/api\/mention-rules\/([0-9a-f-]{36})$/)) && request.method === "DELETE") {
    const r = await db.prepare("DELETE FROM mention_rules WHERE id = ?").bind(x[1]).run();
    if (r.meta?.changes) await logEvent(db, "mention_rule_removed", null, x[1]);
    return json({ ok: true, removed: r.meta?.changes ?? 0 });
  }
  // "Stop these" on a notification: the newest incoming message of that conversation names the sender and the subject. Nothing about the
  // mail itself changes; its notification is already closed on the device that asked.
  if (request.method === "POST" && path === "/api/notify/act" && (await request.clone().json().catch(() => ({}))).action === "quiet") {
    const b = await request.json().catch(() => ({})); let from = "", subject = "";
    if (!b.account || b.account === "hub") {
      if (!/^[0-9a-f-]{36}$/.test(String(b.thread || ""))) return json({ error: "bad thread" }, 400);
      const mm = await db.prepare("SELECT from_addr, subject FROM messages WHERE thread_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1").bind(b.thread).first();
      if (!mm) return json({ error: "not found" }, 404); from = mm.from_addr; subject = mm.subject;
    } else {
      const gm = await db.prepare("SELECT email FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(lc(b.account)).first(); if (!gm) return json({ error: "unknown account" }, 404);
      if (!/^[0-9a-f]{6,32}$/i.test(String(b.thread || ""))) return json({ error: "bad thread" }, 400);
      const tok = await gmailAccessToken(env, gm.email);
      const th = await gmailApi(tok.access_token, `threads/${encodeURIComponent(b.thread)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const last = (th.messages || []).filter((x) => !(x.labelIds || []).includes("SENT")).pop(); const hv = (n) => (last?.payload?.headers || []).find((h) => lc(h.name) === n)?.value || "";
      if (!last) return json({ error: "not found" }, 404); from = addrOnly(hv("from")); subject = hv("subject");
    }
    const r = await addQuietRule(env, from, quietGeneral(subject)); if (!r) return json({ error: "no sender address on that conversation" }, 422);
    await logEvent(db, "quiet_rule_added", null, `${r.sender}${r.subject ? ` "${r.subject}"` : ""} (from a notification)`); return json({ ok: true, rule: r });
  }
  if (request.method === "POST" && path === "/api/notify/act") { // Done / Mark read from a notification button (Android Chrome shows them)
    const b = await request.json().catch(() => ({})); const action = ["done", "read", "trash", "snooze"].includes(b.action) ? b.action : null; if (!action || !b.thread) return json({ error: "thread and action (done | read | trash | snooze) required" }, 400);
    // Snooze from a notification: the phone says until when, in its own time zone (tomorrow 8 AM), as an ISO instant.
    const until = action === "snooze" ? new Date(b.until || "") : null;
    if (until && (isNaN(until) || until.getTime() < Date.now() + 60_000 || until.getTime() > Date.now() + 60 * 86_400_000)) return json({ error: "until must be a time between a minute and 60 days from now" }, 400);
    const snoozeRow = (account, ref, payload) => db.prepare("INSERT INTO scheduled_actions (id, kind, account, ref, due_at, payload, status, created_at) VALUES (?, 'snooze', ?, ?, ?, ?, 'pending', ?)").bind(uuid(), account, ref, until.toISOString(), JSON.stringify(payload), now()).run();
    if (!b.account || b.account === "hub") {
      if (!/^[0-9a-f-]{36}$/.test(String(b.thread))) return json({ error: "bad thread" }, 400);
      const sql = { done: "UPDATE threads SET state = 'archived', unread = 0 WHERE id = ?", read: "UPDATE threads SET unread = 0 WHERE id = ?", trash: "UPDATE threads SET state = 'trash' WHERE id = ?", snooze: "UPDATE threads SET state = 'snoozed' WHERE id = ? AND state IN ('inbox','archived')" }[action];
      const r = await db.prepare(sql).bind(b.thread).run();
      if (!(r.meta?.changes)) return json({ error: "not found" }, 404);
      if (action === "snooze") { const mm = await db.prepare("SELECT subject FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1").bind(b.thread).first(); await snoozeRow("hub", b.thread, { subject: mm?.subject || "" }); }
      const queued = await imapQueueForThread(env, b.thread, { done: { state: "archived", unread: false }, read: { unread: false }, trash: { state: "trash" }, snooze: { state: "snoozed" } }[action]);   // Trash leaves read state alone, as in the app and on Gmail
      const e1 = await addHandled(env, [`hub|${b.thread}`], (FCM_DEVICE_RE.test(String(b.device || "")) ? b.device : null) || await actorId(db, b.endpoint));
      if (e1.length) ctxWaitUntil(sendDismissPush(env, e1, "notify-act").catch(() => {}));
      await logEvent(db, "notify_act", null, `hub ${action} ${b.thread}`); return json({ ok: true, imap_ops: queued });
    }
    const gm = await db.prepare("SELECT email FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(lc(b.account)).first(); if (!gm) return json({ error: "unknown account" }, 404);
    if (!/^[0-9a-f]{6,32}$/i.test(String(b.thread))) return json({ error: "bad thread" }, 400);
    const tok = await gmailAccessToken(env, gm.email);
    if (action === "trash") await gmailApi(tok.access_token, `threads/${encodeURIComponent(b.thread)}/trash`, { method: "POST", body: "{}" });
    else await gmailApi(tok.access_token, `threads/${encodeURIComponent(b.thread)}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: action === "done" ? ["INBOX", "UNREAD"] : action === "snooze" ? ["INBOX"] : ["UNREAD"] }) });
    if (action === "snooze") await snoozeRow(gm.email, b.thread, { labelId: null });   // the scheduler puts INBOX and UNREAD back when it is due
    const e2 = await addHandled(env, [`${gm.email}|${b.thread}`], (FCM_DEVICE_RE.test(String(b.device || "")) ? b.device : null) || await actorId(db, b.endpoint));
    if (e2.length) ctxWaitUntil(sendDismissPush(env, e2, "notify-act").catch(() => {}));
    await logEvent(db, "notify_act", null, `${gm.email} ${action} ${b.thread}`); return json({ ok: true });
  }
  // Reply from a notification. The phone sends what was typed into the notification; the hub sends it as
  // Reply in the app would, to the conversation's newest message from someone else (else its newest), from the address that mail came
  // to, and marks the conversation read here and on the other devices. No quote: a reply typed into a notification is a short one.
  if (request.method === "POST" && path === "/api/notify/reply") {
    const b = await request.json().catch(() => ({})); const text = String(b.text || "").trim();
    if (!b.thread || !text) return json({ error: "thread and text required" }, 400);
    if (text.length > 20_000) return json({ error: "reply too long for a notification (20,000 characters)" }, 400);
    const device = (FCM_DEVICE_RE.test(String(b.device || "")) ? b.device : null) || await actorId(db, b.endpoint);
    if (!b.account || b.account === "hub") {
      if (!/^[0-9a-f-]{36}$/.test(String(b.thread))) return json({ error: "bad thread" }, 400);
      const parent = await db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY (direction = 'in') DESC, created_at DESC LIMIT 1").bind(b.thread).first();
      if (!parent) return json({ error: "not found" }, 404);
      const d = replyDefaults(parent, await ownDomains(db, env), "one");
      let r; try { r = await sendMail(env, { from: d.from, to: d.to, cc: d.cc, subject: d.subject, text, reply_to_id: parent.id, idempotency_key: b.idempotency_key }); } catch (e) { return sendErr(e); }
      await db.prepare("UPDATE threads SET unread = 0 WHERE id = ?").bind(b.thread).run(); await imapQueueForThread(env, b.thread, { unread: false });
      const e1 = await addHandled(env, [`hub|${b.thread}`], device); if (e1.length) ctxWaitUntil(sendDismissPush(env, e1, "notify-reply").catch(() => {}));
      await logEvent(db, "notify_reply", r.id, `hub ${b.thread}`); return json({ ok: true, id: r.id, ...(r.warning ? { warning: r.warning } : {}) });
    }
    const gm = await db.prepare("SELECT email, label FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(lc(b.account)).first(); if (!gm) return json({ error: "unknown account" }, 404);
    if (!/^[0-9a-f]{6,32}$/i.test(String(b.thread))) return json({ error: "bad thread" }, 400);
    const tok = await gmailAccessToken(env, gm.email);
    const th = await gmailApi(tok.access_token, `threads/${encodeURIComponent(b.thread)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    const msgs = th.messages || []; const mine = (m) => (m.labelIds || []).includes("SENT");
    const last = [...msgs].reverse().find((m) => !mine(m)) || msgs[msgs.length - 1]; if (!last) return json({ error: "not found" }, 404);
    // One line, and only plain addresses: the recipients come from the sender's own headers, and mimetext writes a CR/LF
    // in a recipient's name or address straight into the message as a header of the sender's choosing (a Bcc, say).
    const to = oneHdr(mine(last) ? hdrVal(last, "To") : (hdrVal(last, "Reply-To") || hdrVal(last, "From")));
    const rcpts = toAddrObjs(to).map((x) => (typeof x === "string" ? addrOnly(x) : { name: oneHdr(x.name || ""), addr: x.email })).filter((x) => /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+$/.test(typeof x === "string" ? x : x.addr || ""));
    if (!rcpts.length) return json({ error: "no address to reply to" }, 400);
    const subj = oneHdr(hdrVal(last, "Subject")); const mid = hdrId(hdrVal(last, "Message-ID")); const refs = [...parseIdList(hdrVal(last, "References")), mid].filter(Boolean).join(" ");   // one line each
    const name = gm.label || (await db.prepare("SELECT display_name FROM identities WHERE display_name IS NOT NULL AND display_name != '' ORDER BY rowid LIMIT 1").first())?.display_name || "";
    const mm = createMimeMessage(); mm.setSender(name ? { name, addr: gm.email } : gm.email);
    mm.setTo(rcpts);
    mm.setSubject(/^\s*re\s*:/i.test(subj) ? subj : `Re: ${subj}`);
    if (mid) { mm.setHeader("In-Reply-To", mid); mm.setHeader("References", refs); }
    mm.addMessage({ contentType: "text/plain", data: text });
    const bytes = new TextEncoder().encode(mm.asRaw()); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const raw = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    let sent; try { sent = await gmailApi(tok.access_token, "messages/send", { method: "POST", body: JSON.stringify({ raw, threadId: b.thread }) }); } catch (e) { return json({ error: `Gmail refused the reply: ${e?.message || e}` }, 502); }
    try { await gmailApi(tok.access_token, `threads/${encodeURIComponent(b.thread)}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) }); } catch (_) {}   // sent; reading it is secondary
    const e2 = await addHandled(env, [`${gm.email}|${b.thread}`], device); if (e2.length) ctxWaitUntil(sendDismissPush(env, e2, "notify-reply").catch(() => {}));
    await logEvent(db, "notify_reply", null, `${gm.email} ${b.thread} ${sent?.id || ""}`); return json({ ok: true, id: sent?.id || null });
  }
  if (request.method === "POST" && path === "/api/push/test") return json(await sendPush(env, { kind: "test", title: "mailhub", body: "Push notifications work on this device", url: "/" }, { urgency: "high" }));

  // ---- Drafts: one store for every account, synced to every device ----
  // GET ?since=<seq> answers what changed after the device's cursor, tombstones included; no cursor (or one older than what the prune
  // kept) answers every live draft and full: true, and the device replaces its copy. PUT carries the revision the device started
  // from: a save over a newer one is refused with the current draft (409), and the device decides; nothing is overwritten unseen.
  if (request.method === "GET" && path === "/api/drafts") {
    const since = Math.max(0, Math.floor(Number(url.searchParams.get("since") || 0)) || 0);
    const floor = Number((await db.prepare("SELECT value FROM prefs WHERE key = 'drafts_pruned_seq'").first())?.value || 0);
    // full=1 continues a full list from the last seq it returned; a cursor older than the prune floor starts one from the beginning.
    // The watermark is read FIRST and the rows are taken at or below it: a draft written between the two reads is above the
    // watermark, so the next delta returns it.
    const cont = url.searchParams.get("full") === "1", full = cont || !since || since < floor;
    const top = (await db.prepare("SELECT COALESCE(MAX(seq), 0) s FROM drafts").first())?.s || 0;
    const { results } = full ? await db.prepare("SELECT * FROM drafts WHERE deleted = 0 AND seq > ? AND seq <= ? ORDER BY seq LIMIT 500").bind(cont ? since : 0, top).all() : await db.prepare("SELECT * FROM drafts WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 500").bind(since, top).all();
    const more = results.length === 500;
    const cursor = more ? results[results.length - 1].seq : full ? top : (results.length ? results[results.length - 1].seq : since);
    const drafts = []; for (const r of results) drafts.push(await draftOut(env, r));
    return json({ drafts, cursor, full, more });
  }
  if ((x = m(/^\/api\/drafts\/([0-9a-f-]{36})$/)) && request.method === "PUT") {
    const b = await request.json().catch(() => null);
    if (!b || !b.content || typeof b.content !== "object") return json({ error: "content required" }, 400);
    const id = x[1], base = Math.floor(Number(b.base_rev || 0)) || 0;
    const content = JSON.stringify(b.content); if (content.length > 1_000_000) return json({ error: "this draft's text is over 1 MB" }, 413);
    const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
    const kind = ["new", "reply", "forward"].includes(b.kind) ? b.kind : "new";
    const meta = [kind, cut(b.thread_key, 300), cut(lc(b.from || ""), 320), cut(b.to, 1000), cut(b.subject, 500), cut(b.snippet, 300), Math.max(0, Math.min(99, Math.floor(Number(b.n_files) || 0))), cut(b.device, 80)];
    const sealed = await sealToken(env, content, `draft|${id}`, "drafts"); const at = now();
    const conflict = async () => json({ error: "conflict", current: await draftOut(env, await db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first()) }, 409);
    const cur = await db.prepare("SELECT rev FROM drafts WHERE id = ?").bind(id).first();
    let r;
    if (!cur) {
      if (base) return json({ error: "conflict", current: null }, 409);   // the device had a revision of a draft the hub no longer holds
      r = await db.prepare(`INSERT INTO drafts (id, rev, seq, kind, thread_key, from_addr, to_addrs, subject, snippet, n_files, enc, iv, device, deleted, created_at, updated_at) VALUES (?, 1, ${DRAFT_NEXT_SEQ}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING rev, seq, updated_at`)
        .bind(id, ...meta.slice(0, 7), sealed.enc, sealed.iv, meta[7], at, at).first();
    } else {
      if (cur.rev !== base) return conflict();
      r = await db.prepare(`UPDATE drafts SET rev = rev + 1, seq = ${DRAFT_NEXT_SEQ}, kind = ?, thread_key = ?, from_addr = ?, to_addrs = ?, subject = ?, snippet = ?, n_files = ?, enc = ?, iv = ?, device = ?, deleted = 0, gone_hash = NULL, updated_at = ? WHERE id = ? AND rev = ? RETURNING rev, seq, updated_at`)
        .bind(...meta.slice(0, 7), sealed.enc, sealed.iv, meta[7], at, id, base).first();
    }
    // RETURNING: the revision THIS write made. A separate SELECT could read another device's newer one and let this device's next
    // save overwrite it unseen.
    if (!r) return conflict();   // another save landed between the read and the write
    // The files this revision holds: any other file of the draft, older than two minutes (an upload whose save is on its way is
    // younger), was removed from it and goes, so a removed file stops counting against the draft.
    if (Array.isArray(b.file_ids)) { try { await draftFilesDrop(env, id, b.file_ids.map(String).slice(0, 100)); } catch (_) {} }
    return json({ id, rev: r.rev, seq: r.seq, updated_at: r.updated_at });
  }
  if ((x = m(/^\/api\/drafts\/([0-9a-f-]{36})$/)) && request.method === "DELETE") {
    // With ?rev=N only that revision is deleted: a device that sends or discards revision N never deletes N+1 written meanwhile on
    // another device; it is told instead (409 with the current draft). Without rev (the CLI) any revision.
    const id = x[1], rq = url.searchParams.get("rev"), rev = rq == null ? null : Math.floor(Number(rq)) || 0;
    const cur = await db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first();
    if (!cur || cur.deleted) return json({ ok: true, deleted: 0 });
    if (rev != null && cur.rev !== rev) return json({ error: "conflict", current: await draftOut(env, cur) }, 409);
    let gone = null; try { if (cur.enc) gone = await sha256Hex(await openToken(env, cur.enc, cur.iv, `draft|${id}`, "drafts")); } catch (_) {}
    const r = await db.prepare(`UPDATE drafts SET deleted = 1, rev = rev + 1, seq = ${DRAFT_NEXT_SEQ}, enc = NULL, iv = NULL, snippet = NULL, n_files = 0, gone_hash = ?, updated_at = ? WHERE id = ? AND deleted = 0 AND rev = ?`).bind(gone, now(), id, cur.rev).run();
    if (!r.meta?.changes) return json({ error: "conflict", current: await draftOut(env, await db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first()) }, 409);
    await draftFilesDrop(env, id);
    return json({ ok: true, deleted: 1 });
  }
  if ((x = m(/^\/api\/drafts\/([0-9a-f-]{36})\/files$/)) && request.method === "POST") {
    const draftId = x[1]; const bytes = await request.arrayBuffer(); const size = bytes.byteLength;
    if (!size) return json({ error: "empty file" }, 400);
    const held = (await db.prepare("SELECT COALESCE(SUM(size), 0) n FROM draft_files WHERE draft_id = ?").bind(draftId).first())?.n || 0;
    if (held + size > DRAFT_FILES_MAX) return json({ error: `a draft keeps up to ${DRAFT_FILES_MAX / 1048576} MB of files` }, 413);
    let name = "file"; try { name = decodeURIComponent(request.headers.get("x-file-name") || "file").slice(0, 200) || "file"; } catch (_) {}
    const type = (request.headers.get("content-type") || "application/octet-stream").slice(0, 120);
    const fid = uuid(), key = `drafts/${draftId}/${fid}`;
    await env.STORE.put(key, bytes, { httpMetadata: { contentType: type } });
    try { await db.prepare("INSERT INTO draft_files (id, draft_id, name, type, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(fid, draftId, name, type, size, key, now()).run(); }
    catch (e) { try { await env.STORE.delete(key); } catch (_) {} throw e; }   // no object without its row
    return json({ id: fid, name, type, size });
  }
  if ((x = m(/^\/api\/drafts\/([0-9a-f-]{36})\/files\/([0-9a-f-]{36})$/)) && request.method === "GET") {
    const f = await db.prepare("SELECT * FROM draft_files WHERE id = ? AND draft_id = ?").bind(x[2], x[1]).first();
    const obj = f ? await env.STORE.get(f.r2_key) : null;
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${safeName(f.name)}"`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "no-store, private" } });
  }

  // ---- Scheduler: snooze / send later / reminders ----
  if (request.method === "GET" && path === "/api/schedule") {
    const status = url.searchParams.get("status") || "pending";
    const { results } = await db.prepare("SELECT id, kind, account, ref, due_at, status, created_at, done_at, error, CASE WHEN kind = 'send_later' THEN json_object('subject', json_extract(payload, '$.subject'), 'to', json_extract(payload, '$.to')) ELSE payload END AS payload FROM scheduled_actions WHERE status = ? ORDER BY due_at LIMIT 200").bind(status).all();
    return json({ actions: results.map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })) });
  }
  if (request.method === "POST" && path === "/api/schedule") {
    const b = await request.json().catch(() => ({}));
    if (!["snooze", "send_later", "reminder"].includes(b.kind)) return json({ error: "kind must be snooze | send_later | reminder" }, 400);
    const due = new Date(b.due_at || ""); if (isNaN(due) || due.getTime() < Date.now() - 60_000) return json({ error: "due_at must be a future ISO timestamp" }, 400);
    const account = lc(b.account || "hub"); const id = uuid();
    let payload = b.payload || {};
    if (account !== "hub") { // Gmail: the hub keeps no subject or sender text for Gmail mail, only the thread id and what the scheduler needs
      const gm = await db.prepare("SELECT status FROM gmail_accounts WHERE email = ?").bind(account).first();
      if (!gm || gm.status !== "active") return json({ error: "unknown or inactive Gmail account" }, 404);
      payload = b.kind === "snooze" ? { labelId: payload.labelId || null } : b.kind === "reminder" ? { title: "Follow up", count: payload.count || null } : payload;
    }
    if (b.kind === "snooze") {
      if (!b.ref) return json({ error: "ref (thread id) required" }, 400);
      if (account === "hub") { const r = await db.prepare("UPDATE threads SET state = 'snoozed' WHERE id = ? AND state IN ('inbox','archived')").bind(b.ref).run(); if (!(r.meta?.changes)) return json({ error: "hub thread not found or not snoozable" }, 404); await imapQueueForThread(env, b.ref, { state: "snoozed" }); }
      // Gmail: the client removes INBOX itself (it holds the token); the Worker only brings it back at due time.
    }
    if (b.kind === "send_later") {
      // A hub draft is checked by the same rules Send now applies, here rather than at the due time: a subject is optional (Send now
      // never required one), and a message with no body, not a reply and with nothing attached is refused now instead of failing later.
      //  A forward (forward_of) gets its body and files from the original.
      const draft = b.draft || {}; if (account === "hub" ? !(draft.from && toAddrObjs(draft.to).length) : !draft.raw) return json({ error: account === "hub" ? "draft needs from and to" : "draft.raw (base64url RFC 822) required" }, 400);
      if (account === "hub" && !draft.forward_of && !bodyText(draft) && !draft.html) return json({ error: "text or html is required" }, 400);
      if (account === "hub" && draft.forward_of && !(await db.prepare("SELECT 1 x FROM messages WHERE id = ?").bind(String(draft.forward_of)).first())) return json({ error: "message to forward not found" }, 400);
      if (account === "hub") { // validate the sender now, not at send time
        const from = addrOnly(typeof draft.from === "string" ? draft.from : draft.from?.email); const own = await ownDomains(db, env);
        const ident = await db.prepare("SELECT is_active FROM identities WHERE email = ?").bind(from).first();
        if (!from || (ident && !ident.is_active) || (!ident && !own.has(from.split("@")[1]) && !(await imapAccountFor(env, from)))) return json({ error: `sender not allowed: ${from}` }, 400);
      } else {
        let head = ""; try { head = new TextDecoder().decode(unb64(String(draft.raw).replace(/-/g, "+").replace(/_/g, "/").slice(0, 12000))); } catch (_) { return json({ error: "draft.raw is not base64url" }, 400); }
        const fm = head.match(/^From:\s*([^\r\n]*)/im); const fromAddr = addrOnly(fm ? fm[1] : "");
        if (fromAddr !== account) return json({ error: `draft From (${fromAddr || "missing"}) must be the Gmail account ${account}` }, 400);
      }
      const sealed = await sealToken(env, JSON.stringify(draft), id, "drafts");
      payload = { enc: sealed.enc, iv: sealed.iv, subject: draft.subject || "", to: draft.to || "" };
    }
    await db.prepare("INSERT INTO scheduled_actions (id, kind, account, ref, due_at, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)").bind(id, b.kind, account, b.ref || null, due.toISOString(), JSON.stringify(payload), now()).run();
    await logEvent(db, "scheduled", null, `${b.kind} ${account} ${b.ref || ""} due ${due.toISOString()}`);
    return json({ ok: true, id, due_at: due.toISOString() });
  }
  if ((x = m(/^\/api\/schedule\/([0-9a-f-]{36})$/)) && request.method === "DELETE") {
    const a = await db.prepare("SELECT * FROM scheduled_actions WHERE id = ?").bind(x[1]).first();
    if (!a) return json({ error: "not found" }, 404);
    // Cancelling a snooze brings the conversation back, unless the client is cancelling it because the user acted on it (Done, Trash,
    // Spam, Restore: ?keep=1), when that action decides where it goes. Either way the work mailbox is told only when the conversation
    // really moved: it was told "inbox" even when the action had already archived it.
    if (a.kind === "snooze" && a.account === "hub" && a.status === "pending" && url.searchParams.get("keep") !== "1") { const back = await db.prepare("UPDATE threads SET state = 'inbox' WHERE id = ? AND state = 'snoozed'").bind(a.ref).run(); if (back.meta?.changes) await imapQueueForThread(env, a.ref, { state: "inbox" }); }
    await db.prepare("UPDATE scheduled_actions SET status = 'cancelled', done_at = ? WHERE id = ?").bind(now(), x[1]).run();
    return json({ ok: true, kind: a.kind, account: a.account, ref: a.ref });
  }

  // ---- Gatekeeper sender state ----
  // Everyone the hub has mail FROM and everyone it has SENT mail to, with how often and how recently: the domain half of the
  // composer's recipient suggestions. Google never sees mail the hub sends, so this is the only place those recipients exist.
  if (request.method === "GET" && path === "/api/contacts") {
    const addr = "CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.address') ELSE j.value END";
    const nm = "CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.name') ELSE NULL END";
    const sentFrom = (col) => `SELECT lower(${addr}) addr, MAX(${nm}) name, COUNT(*) n, MAX(m.created_at) last FROM messages m, json_each(CASE WHEN json_valid(m.${col}) THEN m.${col} ELSE '[]' END) j WHERE m.direction = 'out' GROUP BY 1`;
    const received = (await db.prepare("SELECT lower(from_addr) addr, MAX(from_name) name, COUNT(*) n, MAX(created_at) last FROM messages WHERE direction = 'in' AND from_addr LIKE '%@%' GROUP BY lower(from_addr) LIMIT 5000").all()).results;
    const sent = (await db.prepare(`${sentFrom("to_addrs")} UNION ALL ${sentFrom("cc_addrs")} LIMIT 5000`).all()).results.filter((r) => r.addr && r.addr.includes("@"));
    return json({ received, sent });
  }
  // The domains that have written to the user, for the app's impostor banner: read once a session.
  if (request.method === "GET" && path === "/api/senders/orgs") return json({ orgs: await impostorOrgs(env) });
  if (request.method === "GET" && path === "/api/senders") {
    const status = url.searchParams.get("status") || "pending";
    const { results } = await db.prepare("SELECT * FROM known_senders WHERE status = ? ORDER BY last_seen_at DESC LIMIT 500").bind(status).all();
    const counts = await db.prepare("SELECT status, COUNT(*) n FROM known_senders GROUP BY status").all();
    return json({ senders: results, counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])) });
  }
  if (request.method === "POST" && path === "/api/senders") {
    const b = await request.json().catch(() => ({}));
    const addrs = (Array.isArray(b.addresses) ? b.addresses : [b.address]).map(lc).filter((a) => a && a.includes("@")).slice(0, 2000);
    const status = b.status; if (!["accepted", "blocked", "pending"].includes(status)) return json({ error: "status must be accepted | blocked | pending" }, 400);
    for (const a of addrs) {
      await db.prepare("INSERT INTO known_senders (address, status, first_seen_at, last_seen_at, first_account, seen_count) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(address) DO UPDATE SET status = excluded.status").bind(a, status, now(), now(), b.account || null).run();
      if (status === "blocked") await db.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES (?, ?, 'block', '*', ?) ON CONFLICT(pattern, scope) DO UPDATE SET action = 'block'").bind(uuid(), a, now()).run();
      if (status === "accepted") await db.prepare("DELETE FROM sender_rules WHERE pattern = ? AND scope = '*' AND action = 'block'").bind(a).run();
    }
    if (addrs.length && status !== "pending") await logEvent(db, "gatekeeper", null, `${status} ${addrs.length}${addrs.length === 1 ? " " + addrs[0] : ""}`);
    return json({ ok: true, updated: addrs.length });
  }
  if (request.method === "POST" && path === "/api/senders/bootstrap") {
    // First run: everyone who already wrote to the hub counts as accepted (Spark's semantics start at enrollment).
    const r = await db.prepare("INSERT OR IGNORE INTO known_senders (address, status, first_seen_at, last_seen_at, first_account, seen_count) SELECT DISTINCT lower(from_addr), 'accepted', MIN(created_at), MAX(created_at), identity, COUNT(*) FROM messages WHERE direction = 'in' AND from_addr LIKE '%@%' GROUP BY lower(from_addr)").run();
    const r2 = await db.prepare("INSERT OR IGNORE INTO known_senders (address, status, first_seen_at, last_seen_at, first_account, seen_count) SELECT DISTINCT lower(json_extract(value, '$.address')), 'accepted', ?, ?, 'hub', 0 FROM messages, json_each(messages.to_addrs) WHERE direction = 'out' AND json_extract(value, '$.address') LIKE '%@%'").bind(now(), now()).run();
    return json({ ok: true, from_inbound: r.meta?.changes ?? null, from_outbound: r2.meta?.changes ?? null });
  }
  // ---- Address locks: list, make one, close / reopen / release it, let a domain in ----
  if (request.method === "GET" && path === "/api/locks") {
    const { results: locks } = await db.prepare("SELECT address, state, claim, source, created_at, claimed_at FROM address_locks ORDER BY created_at DESC").all();
    const { results: allows } = await db.prepare("SELECT address, domain, source FROM address_lock_allows ORDER BY added_at").all();
    const { results: kept } = await db.prepare("SELECT identity AS address, COUNT(*) n FROM messages WHERE lock_kept = 1 GROUP BY identity").all();
    const k = new Map(kept.map((r) => [r.address, r.n]));
    return json({ locks: locks.map((l) => ({ ...l, allows: allows.filter((a) => a.address === l.address).map((a) => ({ domain: a.domain, source: a.source })), kept: k.get(l.address) || 0 })) });
  }
  if (request.method === "POST" && path === "/api/locks") {
    const b = await request.json().catch(() => ({})); const address = lc(String(b.address || "").trim()); const [local, dom] = address.split("@");
    if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(local || "") || !dom || address.split("@").length !== 2) return json({ error: "That isn't an address" }, 400);
    if (!lockDomains(env).has(dom)) return json({ error: `${dom} is not one of your domains that mail reaches through the hub` }, 400);
    // Never one that already gets mail: sam@ and trademark@ have senders the user wants, and a lock would keep all but one out.
    if (await db.prepare("SELECT 1 x FROM identities WHERE email = ?").bind(address).first()) return json({ error: `${address} is one of your sending addresses; it can't be locked` }, 409);
    if (await db.prepare("SELECT 1 x FROM messages WHERE identity = ? LIMIT 1").bind(address).first()) return json({ error: `${address} already has mail; only a new address can be locked` }, 409);
    const r = await db.prepare("INSERT OR IGNORE INTO address_locks (address, state, source, created_at) VALUES (?, 'active', 'app', ?)").bind(address, now()).run();
    if (!r.meta?.changes) return json({ error: `${address} is already locked` }, 409);
    await logEvent(db, "lock_armed", null, `${address} (app)`);
    return json({ ok: true, address });
  }
  if ((x = m(/^\/api\/locks\/([^/]+)$/)) && request.method === "PATCH") {
    const address = lc(decodeURIComponent(x[1])); const b = await request.json().catch(() => ({}));
    if (!["active", "closed", "released"].includes(b.state)) return json({ error: "state must be active | closed | released" }, 400);
    const r = await db.prepare("UPDATE address_locks SET state = ? WHERE address = ?").bind(b.state, address).run();
    if (!r.meta?.changes) return json({ error: "no such lock" }, 404);
    await logEvent(db, "lock_state", null, `${address} ${b.state}`);
    return json({ ok: true, address, state: b.state });
  }
  // Let a sender in: its lock key (an organizational domain, or an address at a personal mail provider) joins the allow list, and every
  // message the lock kept out from it comes back to the inbox, in one transaction (lockRelease). A message that was being filed while
  // this ran is caught twice: by the second pass here, and by projectInbound's own re-check after it files a kept message.
  //  Only on an active lock: closed means everything stays out. Only an authenticated sender has a key; mail whose
  // sender could not be verified is not let in this way.
  if ((x = m(/^\/api\/locks\/([^/]+)\/allow$/)) && request.method === "POST") {
    const address = lc(decodeURIComponent(x[1])); const b = await request.json().catch(() => ({})); const v = lc(String(b.domain || "").trim());
    const key = v.includes("@") ? v : lockRoot(v), host = key.split("@").pop();
    if (!HOST_RE.test(host) || badHost(host) || (key.includes("@") && !/^[^@\s"<>]+@[^@\s]+$/.test(key))) return json({ error: "not a domain or an address" }, 400);
    if (LOCK_FREEMAIL.has(key)) return json({ error: `${key} is a personal mail provider: let in one address at it, not all of it` }, 400);
    const lk = await db.prepare("SELECT state FROM address_locks WHERE address = ?").bind(address).first();
    if (!lk) return json({ error: "no such lock" }, 404);
    if (lk.state !== "active") return json({ error: `${address} is ${lk.state}: reopen it first` }, 409);
    const pick = async () => (await db.prepare("SELECT id, thread_id, labels FROM messages WHERE identity = ? AND lock_kept = 1 AND lock_root = ?").bind(address, key).all()).results;
    let rows = await pick();
    const threads = await lockRelease(db, rows, [db.prepare("INSERT INTO address_lock_allows (address, domain, source, added_at) VALUES (?, ?, 'manual', ?) ON CONFLICT(address, domain) DO UPDATE SET source = 'manual'").bind(address, key, now())]);
    let released = rows.length;
    rows = await pick(); if (rows.length) { threads.push(...(await lockRelease(db, rows))); released += rows.length; }
    await logEvent(db, "lock_allowed", null, `${address} + ${key} (${released} let in)`);
    return json({ ok: true, address, domain: key, released, threads: [...new Set(threads)] });
  }
  // Stop letting a sender in (a mistaken Let in, or a send that let in more than it should).
  if ((x = m(/^\/api\/locks\/([^/]+)\/allow\/([^/]+)$/)) && request.method === "DELETE") {
    const address = lc(decodeURIComponent(x[1])), key = lc(decodeURIComponent(x[2]));
    const r = await db.prepare("DELETE FROM address_lock_allows WHERE address = ? AND domain = ?").bind(address, key).run();
    if (r.meta?.changes) await logEvent(db, "lock_allow_removed", null, `${address} - ${key}`);
    return json({ ok: true, address, domain: key, removed: r.meta?.changes || 0 });
  }
  // ---- Gatekeeper rules ----
  if (request.method === "GET" && path === "/api/sender-rules") { const { results } = await db.prepare("SELECT * FROM sender_rules ORDER BY created_at DESC").all(); return json({ rules: results }); }
  if (request.method === "POST" && path === "/api/sender-rules") {
    const b = await request.json().catch(() => ({}));
    const pattern = lc(b.pattern); const scope = lc(b.scope || "*") || "*"; const category = b.category === null ? null : (b.category || undefined);
    // A category alone is stored with no action. It used to be stored as "accept", and an address-level accept
    // outranks a domain-level block in matchSender, so every sender filed under Newsletters (each unsubscribe did it) escaped a later
    // block of its whole domain.
    const action = b.action || null;
    if (pattern.length > 254 || !/^(\*|[^\s@*<>"(),;:\\]{1,64})@[^\s@*<>"(),;:\\]{1,253}$/.test(pattern) || !/\./.test(pattern.split("@")[1]) ) return json({ error: "pattern must be an address or *@domain" }, 400);
    if (action !== null && !["block", "accept", "priority"].includes(action)) return json({ error: "action must be block | accept | priority" }, 400);
    if (category !== undefined && category !== null && !["personal", "notifications", "newsletters"].includes(category)) return json({ error: "category must be personal | notifications | newsletters" }, 400);
    const id = uuid();
    const existing = await db.prepare("SELECT action FROM sender_rules WHERE pattern = ? AND scope = ?").bind(pattern, scope).first();
    const keepAction = existing && b.action === undefined ? existing.action : action; // a category-only update keeps an existing block/priority
    // "Category: back to automatic" on a rule that only held a category leaves nothing to keep; with no rule there, nothing to do.
    if (!keepAction && category === undefined) return json({ error: "action or category required" }, 400);
    if (!keepAction && category === null) {
      if (existing) { await db.prepare("DELETE FROM sender_rules WHERE pattern = ? AND scope = ?").bind(pattern, scope).run(); await logEvent(db, "sender_rule", null, `removed ${pattern} scope=${scope}`); }
      return json({ ok: true, rule: null });
    }
    if (category === undefined) await db.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pattern, scope) DO UPDATE SET action = excluded.action").bind(id, pattern, keepAction, scope, now()).run();
    else await db.prepare("INSERT INTO sender_rules (id, pattern, action, scope, category, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pattern, scope) DO UPDATE SET category = excluded.category, action = ?").bind(id, pattern, keepAction, scope, category, now(), keepAction).run();
    if (category !== undefined) await db.prepare("UPDATE threads SET category = ? WHERE category IS NOT NULL AND id IN (SELECT thread_id FROM messages WHERE lower(from_addr) = ? AND direction = 'in') AND ? IS NOT NULL").bind(category, pattern, category).run();
    const row = await db.prepare("SELECT * FROM sender_rules WHERE pattern = ? AND scope = ?").bind(pattern, scope).first();
    await logEvent(db, "sender_rule", null, `${keepAction || "category"}${category ? " category=" + category : ""} ${pattern} scope=${scope}`);
    return json({ ok: true, rule: row });
  }
  if ((x = m(/^\/api\/sender-rules\/([0-9a-f-]{36})$/)) && request.method === "DELETE") { const r = await db.prepare("DELETE FROM sender_rules WHERE id = ?").bind(x[1]).run(); return json({ ok: true, removed: r.meta?.changes ?? 0 }); }
  // The old "POST this URL" endpoint (the blocked-host fallback; page mode), retired: the app
  // now sends a job naming the conversation, and the hub reads the headers itself, so it never sends to a URL a client hands it. An app
  // from before 2026-10-21 still calling it is told to reload, and the call is logged so an old copy somewhere shows up.
  if (request.method === "POST" && path === "/api/unsubscribe") {
    await logEvent(db, "unsubscribe_legacy", null, "an app from before 2026-10-21 called the retired endpoint");
    return json({ error: "This app is out of date: reload it, then unsubscribe again." }, 410);
  }
  // An unsubscribe job: the app sends which conversation and which sender once its 5 s Undo has passed, and the hub does
  // the rest after answering. The id is the app's own, so a retried request is the same job.
  if (request.method === "POST" && path === "/api/unsubscribe/job") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || ""), account = lc(b.account || ""), thread = String(b.thread || ""), sender = lc(b.sender || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json({ error: "bad job id" }, 400);
    if (!/^[^\s@<>"(),;:\\]{1,64}@[^\s@<>"(),;:\\]{1,253}\.[^\s@<>"(),;:\\]+$/.test(sender)) return json({ error: "sender must be an address" }, 400);
    if (account === "hub") { if (!/^[0-9a-f-]{36}$/.test(thread)) return json({ error: "bad thread" }, 400); }
    else { if (!/^[0-9a-f]{6,32}$/i.test(thread)) return json({ error: "bad thread" }, 400); if (!(await db.prepare("SELECT 1 x FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(account).first())) return json({ error: "unknown account" }, 404); }
    await db.prepare("INSERT INTO unsubscribes (id, created_at, account, thread_id, sender, status) VALUES (?, ?, ?, ?, ?, 'queued') ON CONFLICT(id) DO NOTHING").bind(id, now(), account, thread, sender).run();
    ctxWaitUntil(unsubWork(env, id));
    return json({ ok: true, id });
  }
  if (request.method === "GET" && path === "/api/unsubscribes") {   // what each list answered, newest first (the Unsubscribes list)
    const { results } = await db.prepare("SELECT id, created_at, account, thread_id, sender, status, outcome, method, answer, url, swept, kept, done_at, still_count, still_at, still_subject, dismissed_at FROM unsubscribes ORDER BY created_at DESC LIMIT 200").all();
    return json({ unsubscribes: results });
  }
  // The user answers a row: "done" on one that needed the page (finished there by hand), or "keep" on a sender still mailing
  // (the mail is wanted after all). Either takes the row off the "needs you" count; nothing is sent anywhere.
  if ((x = m(/^\/api\/unsubscribes\/([A-Za-z0-9_-]{8,64})$/)) && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!["done", "keep"].includes(b.answer)) return json({ error: "answer must be done | keep" }, 400);
    const r = await db.prepare(`UPDATE unsubscribes SET dismissed_at = ?, outcome = CASE WHEN ? = 'done' AND outcome = 'needs_you' THEN 'handled' ELSE outcome END, answer = CASE WHEN ? = 'done' AND outcome = 'needs_you' THEN COALESCE(answer, '') || '; finished on the page by hand' ELSE answer END WHERE id = ?`).bind(now(), b.answer, b.answer, x[1]).run();
    if (!r.meta?.changes) return json({ error: "not found" }, 404);
    await logEvent(db, "unsubscribe_answer", null, `${b.answer} ${x[1]}`);
    return json({ ok: true });
  }

  // ---- Client preferences (swipes, categories, layout, signatures): tiny JSON values keyed by name ----
  if (path === "/api/revisit") {
    let items = await revisitLoad(db); let added = null;
    if (request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      for (let attempt = 0; ; attempt++) { if (attempt) items = await revisitLoad(db); const op = b.op || "add"; const t = (v, n) => String(v ?? "").replace(/[\r\n]/g, " ").trim().slice(0, n);
      const okDate = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (op === "add") { if (!t(b.title, 200)) return json({ error: "title required" }, 400); if (!okDate(b.when)) return json({ error: "when must be YYYY-MM-DD" }, 400); const id = "R" + (items.reduce((m, i) => Math.max(m, parseInt(String(i.id).slice(1), 10) || 0), 0) + 1); added = { id, title: t(b.title, 200), why: t(b.why, 600), when: b.when || null, trigger: t(b.trigger, 300), status: "open", created_at: now() }; items.push(added); }
      else { const it = items.find((i) => i.id === b.id); if (!it) return json({ error: "no such item" }, 404);
        if (op === "done") { it.status = "done"; it.done_at = now(); it.note = t(b.note, 600); }
        else if (op === "reopen") { it.status = "open"; delete it.done_at; }
        else if (op === "snooze") { if (!okDate(b.when) || !b.when) return json({ error: "when must be YYYY-MM-DD" }, 400); it.when = b.when; }
        else if (op === "edit") { for (const k of ["title", "why", "trigger"]) if (b[k] !== undefined) it[k] = t(b[k], k === "title" ? 200 : 600); if (b.when !== undefined) { if (!okDate(b.when)) return json({ error: "when must be YYYY-MM-DD" }, 400); it.when = b.when || null; } }
        else return json({ error: "op must be add | done | reopen | snooze | edit" }, 400); }
      if (items.length > 500) return json({ error: "revisit list is full" }, 400);
      try { await revisitSave(db, items); } catch (e) { if (e.code === "conflict" && attempt < 3) continue; throw e; }
      await logEvent(db, "revisit", null, `${op} ${b.id || items[items.length - 1].id}`); break; }
    }
    if (url.searchParams.get("report") === "1") return new Response(revisitLines(items).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ items: items.sort((a, b) => (a.status === "done") - (b.status === "done") || (a.when || "9999").localeCompare(b.when || "9999")), ...(added ? { added } : {}) });
  }
  if (request.method === "GET" && path === "/api/prefs") {
    // Server-only rows are not sent: `revisit` alone was 12.5 KB of the 13.7 KB this returned on every app boot, and the client has
    // never read either of them (measured in September 2026). `mail revisit` and the daily report read them straight from D1.
    const { results } = await db.prepare("SELECT key, value FROM prefs").all(); const o = {};
    for (const r of results) { if (PREF_SERVER_ONLY(r.key)) continue; try { o[r.key] = JSON.parse(r.value); } catch (_) { o[r.key] = r.value; } }
    return json({ prefs: o });
  }
  if (request.method === "PUT" && path === "/api/prefs") {
    const b = await request.json().catch(() => ({}));
    const entries = Object.entries(b || {}).filter(([k]) => /^[a-z0-9_.-]{1,64}$/i.test(k) && !PREF_SERVER_ONLY(k)).slice(0, 50);
    for (const [k, v] of entries) { const val = JSON.stringify(v); if (val.length > 20_000) return json({ error: `pref ${k} too large` }, 400); await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(k, val, now()).run(); }
    return json({ ok: true, updated: entries.map(([k]) => k) });
  }
  if ((x = m(/^\/api\/gmail\/accounts\/([^/]+)$/)) && request.method === "PATCH") {
    const b = await request.json().catch(() => ({}));
    const sets = [], binds = [];
    if (b.label !== undefined) { sets.push("label = ?"); binds.push(String(b.label || "").slice(0, 40)); }
    if (b.color !== undefined) { sets.push("color = ?"); binds.push(/^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : null); }
    if (!sets.length) return json({ error: "nothing to change" }, 400);
    binds.push(lc(decodeURIComponent(x[1])));
    const r = await db.prepare(`UPDATE gmail_accounts SET ${sets.join(", ")} WHERE email = ?`).bind(...binds).run();
    return json({ ok: true, updated: r.meta?.changes ?? 0 });
  }
  // ---- Gmail accounts: list, mint an access token, report the client's cursor, disconnect ----
  if (request.method === "POST" && path === "/api/admin/backfill-categories") {
    const { results } = await db.prepare("SELECT id, thread_id, from_addr FROM messages WHERE category IS NULL").all();
    for (const r of results) { const c = categorizeHeaders({}, r.from_addr); await db.prepare("UPDATE messages SET category = ? WHERE id = ?").bind(c, r.id).run(); }
    await db.prepare("UPDATE threads SET category = (SELECT m.category FROM messages m WHERE m.thread_id = threads.id ORDER BY m.created_at DESC LIMIT 1) WHERE category IS NULL").run();
    return json({ ok: true, messages: results.length });
  }
  if (request.method === "GET" && path === "/api/imap/status") {
    const { results: folders } = await db.prepare("SELECT * FROM imap_folders ORDER BY account, folder").all();
    const pend = await db.prepare("SELECT status, COUNT(*) n FROM imap_ops GROUP BY status").all();
    return json({ accounts: (await imapAccounts(env, { fresh: true })).map((a) => ({ ...imapPublic(a), smtp: `${a.smtp_host}:${a.smtp_port}`, password_set: a.ready, secret: a.secret })), folders, ops: pend.results });
  }
  if (request.method === "POST" && path === "/api/imap/sync") {
    const b = await request.json().catch(() => ({}));
    return json({ results: await imapSyncAll(env, { backfill: Number(b.backfill || 0), sweep: !!b.sweep, initialWindow: Number(b.initial_window || 100) }), ops_done: await runImapOps(env) });
  }
  if (request.method === "GET" && path === "/api/imap/probe") {
    const host = lc((url.searchParams.get("host") || "").trim());
    const allowed = new Set((await imapAccounts(env)).flatMap((a) => [lc(a.host), lc(a.smtp_host)]));
    if (!host || !allowed.has(host)) return json({ error: "host must be one of the configured IMAP accounts' hosts", allowed: [...allowed] }, 400);
    const port = Number(url.searchParams.get("port") || 993); if (![993, 143, 465, 587].includes(port)) return json({ error: "port must be 993, 143, 465 or 587" }, 400);
    try { return json(await imapProbe(host, port)); } catch (e) { return json({ error: e.message }, 502); }
  }
  // ---- How new a domain is. Asked only after a brand alarm has already fired, so normal mail never comes here;
  // answered from D1 (30 days for a date, 1 day for a failed lookup), from the domain's own registry otherwise. Never more than 60
  // lookups per 15 minutes. The registry is found in IANA's RDAP directory: the rdap.org relay answers Cloudflare's servers with a
  // 403 page (measured from a Worker), while the registries answer them directly (.info in 86 ms,.com in 135 ms).
  if (request.method === "GET" && path === "/api/domain-age") {
    const raw = lc(url.searchParams.get("d")).replace(/^www\./, ""); const parts = raw.split(".");
    const domain = parts.length > 2 && /^(co|com|net|org|ac|gov|ne|or)\.[a-z]{2}$/.test(parts.slice(-2).join(".")) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
    if (!HOST_RE.test(domain) || badHost(domain)) return json({ error: "not a domain" }, 400);
    const hit = await db.prepare("SELECT registered, checked_at FROM domain_ages WHERE domain = ?").bind(domain).first();
    if (hit && Date.now() - Date.parse(hit.checked_at) < (hit.registered ? 30 : 1) * 86400e3) return json({ domain, registered: hit.registered, cached: true });
    if (!(await reserveSlot(db, "rdap", 60, domain))) return json({ domain, registered: null, limited: true });
    let registered = null;
    try { const base = await rdapBase(domain.split(".").pop());
      if (base) { const r = await fetch(`${base.replace(/\/?$/, "/")}domain/${domain}`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(5000) });
        if (r.ok) { const j = await r.json(); registered = (j.events || []).find((e) => e.eventAction === "registration")?.eventDate || null; } } } catch (_) {}
    await db.prepare("INSERT INTO domain_ages (domain, registered, checked_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET registered = excluded.registered, checked_at = excluded.checked_at").bind(domain, registered, now()).run();
    return json({ domain, registered });
  }
  // ---- Work (IMAP) mailboxes added from Settings ----
  // The password arrives once, in the body of POST /api/imap/accounts, over HTTPS from a signed-in same-origin page (or the CLI). It
  // is used to log in to both servers; only if both accept it is it sealed and stored. No route returns it, and no log line holds it.
  if (request.method === "GET" && path === "/api/imap/discover") {
    const email = lc(url.searchParams.get("email"));
    if (!/^[^\s@<>"(),;:\\]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/.test(email)) return json({ error: "That isn't an email address" }, 400);
    if (!(await reserveSlot(db, "imap_discover", 30, email))) return json({ error: "Too many lookups. Try again in 15 minutes." }, 429);   // each lookup opens up to 6 TLS sockets
    return json(await imapDiscover(env, email));
  }
  if (request.method === "POST" && path === "/api/imap/accounts") {
    const b = await request.json().catch(() => ({}));
    const password = typeof b.password === "string" ? b.password : "";
    if (!password || password.length > 1024 || password.includes("\u0000")) return json({ error: "Enter the mailbox password" }, 400);
    if (unb64(env.GMAIL_TOKEN_KEY || "").length !== 32) return json({ error: "The hub has no key to keep a password with (GMAIL_TOKEN_KEY)" }, 503);   // before any login is attempted
    const f = await imapAccountFields(b); if (f.error) return json({ error: f.error }, 400);
    // A mailbox in the app may never take over an address the hub already sends as some other way.
    const dom = f.email.split("@")[1], hubDoms = new Set((env.DOMAINS || "").split(",").map(lc).filter(Boolean));
    const [gm, ident] = await Promise.all([db.prepare("SELECT 1 FROM gmail_accounts WHERE email = ?").bind(f.email).first(), db.prepare("SELECT 1 FROM identities WHERE email = ? OR domain = ? LIMIT 1").bind(f.email, dom).first()]);
    if (gm || ident || hubDoms.has(dom)) return json({ error: `${f.email} already arrives another way (one of your domains or a Gmail account)` }, 409);
    // An existing mailbox keeps its servers: a configured one only ever takes a password for the servers
    // and username in the configuration, and one added here cannot be moved in place: remove it, then add it again, and both steps
    // are announced. Otherwise a stolen session could re-point future work mail at its own server with no password of the owner's.
    const sameServers = (a) => lc(a.host) === f.host && +a.port === f.port && lc(a.smtp_host) === f.smtp_host && +a.smtp_port === f.smtp_port && (a.user ?? a.username) === f.username;
    const cfgAcct = imapConfigAccounts(env).find((a) => a.email === f.email);
    if (cfgAcct && !sameServers(cfgAcct)) return json({ error: `${f.email} is set up in the hub's configuration to use ${cfgAcct.host} as ${cfgAcct.user}; only its password can be added here` }, 409);
    const existing = await db.prepare("SELECT host, port, username, smtp_host, smtp_port FROM imap_accounts WHERE email = ?").bind(f.email).first();
    if (existing && !sameServers(existing)) return json({ error: `To move ${f.email} to other servers, remove it first, then add it again` }, 409);
    if (!existing) { const n = await db.prepare("SELECT COUNT(*) n FROM imap_accounts").first(); if ((n?.n || 0) >= 5) return json({ error: "At most 5 work mailboxes" }, 409); }   // bounds the per-minute cron work
    // Not a password-guessing service: 10 checks per 15 minutes, the slot claimed atomically before any login.
    if (!(await reserveSlot(db, "imap_verify", 10, `${f.email} ${f.host}:${f.port} ${f.smtp_host}:${f.smtp_port}`))) return json({ error: "Too many login attempts. Try again in 15 minutes." }, 429);
    const v = await imapVerifyLogin(f, password);
    if (!v.ok) { await logEvent(db, "imap_verify_fail", null, `${f.email}: ${v.error}`); return json({ error: v.error }, 422); }
    const row = { email: f.email, username: f.username, host: f.host, port: f.port, smtp_host: f.smtp_host, smtp_port: f.smtp_port };
    const sealed = await sealToken(env, password, imapAad(row), "imap-password"); const at = now();
    const prior = await db.prepare("SELECT 1 FROM imap_accounts WHERE email = ?").bind(f.email).first();
    await db.prepare(`INSERT INTO imap_accounts (email, label, color, host, port, username, smtp_host, smtp_port, pass_enc, pass_iv, key_version, created_at, updated_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET label = COALESCE(excluded.label, imap_accounts.label), color = COALESCE(excluded.color, imap_accounts.color),
      host = excluded.host, port = excluded.port, username = excluded.username, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, pass_enc = excluded.pass_enc, pass_iv = excluded.pass_iv,
      key_version = excluded.key_version, updated_at = excluded.updated_at, verified_at = excluded.verified_at`)
      .bind(f.email, f.label, f.color, f.host, f.port, f.username, f.smtp_host, f.smtp_port, sealed.enc, sealed.iv, at, at, at).run();
    imapCache.at = 0;
    await imapSigninOk(db, f.email);   // the password was just verified: no sign-in backoff carries over to it
    await logEvent(db, prior ? "imap_password_changed" : "imap_account_added", null, `${f.email} ${f.host}:${f.port} ${f.smtp_host}:${f.smtp_port}`);
    await imapSecurityAlert(env, request, prior ? "Work mailbox password changed" : "Work mailbox added", `${f.email} now syncs through ${f.host}.`);
    const acct = await imapAccountFor(env, f.email, { fresh: true });
    // The newest mail is fetched before answering, so the app shows it the moment this returns; a slow mailbox finishes in the
    // background (the cron would pick it up within a minute regardless). Parked actions for the address are released after.
    const first = (async () => { const r = await imapSyncAccount(env, acct, {}); await runImapOps(env, f.email); return r; })(); ctxWaitUntil(first);
    let synced = null; try { const r = await withTimeout(first, 8000, "first sync"); synced = r?.fetched ?? null; } catch (_) {}
    return json({ ok: true, account: imapPublic(acct), synced });
  }
  if ((x = m(/^\/api\/imap\/accounts\/([^/]+)$/)) && (request.method === "PATCH" || request.method === "DELETE")) {
    const email = lc(decodeURIComponent(x[1]));
    if (request.method === "DELETE") {
      const r = await db.prepare("DELETE FROM imap_accounts WHERE email = ?").bind(email).run(); imapCache.at = 0;
      await db.prepare("DELETE FROM imap_folders WHERE account = ?").bind(email).run();   // re-adding it, on any server, starts clean
      if (r.meta?.changes) { await logEvent(db, "imap_account_removed", null, email); await imapSecurityAlert(env, request, "Work mailbox removed", `${email} was removed and its saved password deleted.`); }
      return json({ ok: true, removed: r.meta?.changes ?? 0 });   // its mail stays in the hub; only the password and the link are gone
    }
    const b = await request.json().catch(() => ({}));
    if (["host", "port", "smtp_host", "smtp_port", "username", "email", "password"].some((k) => k in b)) return json({ error: "Changing a server, the username or the password means signing in again: use Add work account" }, 400);
    const label = b.label == null ? null : String(b.label).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || null;
    if (b.color != null && !/^#[0-9a-f]{6}$/i.test(String(b.color))) return json({ error: "Colour must look like #3b5bdb" }, 400);
    const r = await db.prepare("UPDATE imap_accounts SET label = COALESCE(?, label), color = COALESCE(?, color), updated_at = ? WHERE email = ?").bind(label, b.color ? String(b.color).toLowerCase() : null, now(), email).run();
    imapCache.at = 0;
    if (!r.meta?.changes) return json({ error: "Only a mailbox added in the app can be renamed here" }, 404);
    return json({ ok: true, account: imapPublic(await imapAccountFor(env, email, { fresh: true })) });
  }
  if (request.method === "GET" && path === "/api/gmail/mirror") {
    // One account's whole mirror, for a device switching to it or coming back after the feed forgot its cursor. It
    // returns rows with metadata, stubs (labels for messages outside the mirror that changed lately), the ids still owed, and whether
    // the mirror is complete enough to REPLACE a device's copy. `cursor` is read BEFORE any row, on the first page only:
    // every change after it reaches the device through the feed, whichever page it touched.
    const acct = lc(url.searchParams.get("account") || ""), after = url.searchParams.get("after") || "";
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "500", 10) || 500));
    const cursor = after ? null : ((await db.prepare("SELECT MAX(seq) mx FROM thread_changes").first())?.mx || 0);
    const { results } = await db.prepare("SELECT id, thread_id, labels, internal_date, meta, history_id FROM gmail_messages WHERE account = ? AND id > ? ORDER BY id LIMIT ?").bind(acct, after, limit).all();
    const head = { rows: results, next: results.length === limit ? results[results.length - 1].id : null };
    if (after) return json(head);
    const status = (await gmailMirrorStatus(db, env))[acct] || null;
    const p = parseJsonOr((await db.prepare("SELECT mirror_progress FROM gmail_accounts WHERE email = ?").bind(acct).first())?.mirror_progress, {});
    return json({ ...head, cursor, at: now(), status, owed: [...(p.owed || []).map((o) => o.id), ...(p.todo || [])], complete: !!status && status.state === "ready" && status.owed === 0 });
  }
  // A one-time ticket that starts Gmail connect in a browser with no hub session: the Mac and Android apps send /auth/gmail
  // to the default browser, since Google refuses OAuth in an embedded web view, and that browser was usually never signed in to the hub,
  // so connect stopped at "Sign in to the hub first". The ticket only starts a connect; it signs nothing in. Single use, 2 minutes.
  if (request.method === "POST" && path === "/api/gmail/ticket") {
    if (!gmailConfigured(env)) return json({ error: "Gmail connect is not configured" }, 503);
    const ticket = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare("DELETE FROM prefs WHERE key LIKE 'gmailticket:%' AND updated_at < ?").bind(new Date(Date.now() - 600_000).toISOString()).run();
    await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)").bind(`gmailticket:${ticket}`, JSON.stringify({ exp: Date.now() + 120_000 }), now()).run();
    return json({ ticket });
  }
  if (request.method === "GET" && path === "/api/gmail/accounts") {
    const { results } = await db.prepare("SELECT email, status, scope, history_id, poll_history_id, last_poll_at, label, color, created_at, last_minted_at, last_error, watch_expiration FROM gmail_accounts ORDER BY email").all();
    return json({ accounts: results, configured: gmailConfigured(env) });
  }
  if ((x = m(/^\/api\/gmail\/accounts\/([^/]+)\/token$/)) && request.method === "POST") {
    const viaBearer = (request.headers.get("Authorization") || "").startsWith("Bearer ");
    if (viaBearer && env.CLI_GMAIL_ACCESS !== "1") return json({ error: "Gmail tokens for the CLI are switched off (CLI_GMAIL_ACCESS in wrangler.toml)" }, 403);
    try { const tok = await gmailAccessToken(env, decodeURIComponent(x[1])); if (tokenLogDue(tok.email, viaBearer)) await logEvent(db, viaBearer ? "gmail_token_cli" : "gmail_token_ui", null, `${tok.email} ${request.headers.get("cf-connecting-ip") || ""}`); return json(tok); } catch (e) { return json({ error: e.message }, e.status || 500); }
  }
  if ((x = m(/^\/api\/gmail\/accounts\/([^/]+)\/history$/)) && request.method === "PATCH") {
    const b = await request.json().catch(() => ({}));
    const r = await db.prepare("UPDATE gmail_accounts SET history_id = ? WHERE email = ?").bind(String(b.history_id || ""), lc(decodeURIComponent(x[1]))).run();
    return json({ ok: true, updated: r.meta?.changes ?? null });
  }
  if ((x = m(/^\/api\/gmail\/accounts\/([^/]+)$/)) && request.method === "DELETE") {
    const email = lc(decodeURIComponent(x[1]));
    const row = await db.prepare("SELECT * FROM gmail_accounts WHERE email = ?").bind(email).first();
    if (!row) return json({ error: "not found" }, 404);
    let googleRevoked = false;
    try {
      const rt = await openToken(env, row.refresh_token_enc, row.refresh_iv, row.email);
      const r = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rt }) });
      googleRevoked = r.ok;
    } catch (_) {}
    await db.prepare("DELETE FROM gmail_accounts WHERE email = ?").bind(email).run();
    await logEvent(db, "gmail_disconnected", null, `${email} google_revoked=${googleRevoked}`);
    return json({ ok: true, google_revoked: googleRevoked });
  }
  if (request.method === "GET" && path === "/api/identities") {
    const { results } = await db.prepare("SELECT * FROM identities ORDER BY email").all();
    return json({ identities: results });
  }
  if (request.method === "POST" && path === "/api/identities") {
    const b = await request.json();
    const email = lc(b.email);
    if (!email.includes("@")) return json({ error: "email required" }, 400);
    if (!(await ownDomains(db, env)).has(email.split("@")[1])) return json({ error: "domain not onboarded" }, 400);
    await db.prepare("INSERT INTO identities (email, display_name, domain, is_active) VALUES (?, ?, ?, 1) ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, is_active = 1").bind(email, b.display_name || "", email.split("@")[1]).run();
    return json({ ok: true, email });
  }
  if (request.method === "POST" && (x = m(/^\/api\/import\/resend\/(domain2|domain3)$/))) {
    try { return json(await importResend(env, x[1], { limit: parseInt(url.searchParams.get("limit") || "100", 10) })); } catch (e) { return json({ error: e.message }, 400); }
  }
  if (request.method === "POST" && path === "/api/report/daily") {
    await dailyReport(env, []);
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/api/events") {
    const { results } = await db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all();
    return json({ events: results });
  }
  // Each app reports its own field timers (perf.report(): timings, counts, boot phases, device; no mail content), at most every six
  // hours, so the Mac's and Android's speed can be read without a hand export.
  //  One R2 object per device per day, overwritten through the day, plus `latest`.
  if (request.method === "POST" && path === "/api/perf") {
    const body = await request.text(); if (body.length > 200_000) return json({ error: "report too large" }, 413);
    let r; try { r = JSON.parse(body); } catch (_) { return json({ error: "not JSON" }, 400); }
    if (!r || !Array.isArray(r.rows)) return json({ error: "not a speed report" }, 400);
    const ua = String(r.ua || request.headers.get("user-agent") || ""); const device = /\bSheritWindows\//.test(ua) ? "windows" : /Android/.test(ua) ? "android" : /Macintosh/.test(ua) ? "mac" : "web";
    const day = new Date().toISOString().slice(0, 10), meta = { httpMetadata: { contentType: "application/json" } };
    await Promise.all([env.STORE.put(`perf/${device}/${day}.json`, body, meta), env.STORE.put(`perf/${device}/latest.json`, body, meta)]);
    return json({ ok: true, device, day });
  }
  if (request.method === "GET" && path === "/api/perf") {
    const out = {};
    for (const device of ["mac", "android", "windows", "web"]) { const o = await env.STORE.get(`perf/${device}/latest.json`).catch(() => null); if (o) { try { out[device] = JSON.parse(await o.text()); } catch (_) {} } }
    return json(out);
  }
  // A native app's log tail and machine facts (windows/src-tauri/src/notifier.rs report(): versions, notification keys, feed and
  // update statuses; no mail content). Its log file sits on a PC nobody can open from where the app is maintained, so a toast
  // that never showed or an update that never landed is read here, with the CLI token. One R2 object per device, overwritten.
  if (request.method === "POST" && path === "/api/applog") {
    const body = await request.text(); if (body.length > 100_000) return json({ error: "report too large" }, 413);
    let r; try { r = JSON.parse(body); } catch (_) { return json({ error: "not JSON" }, 400); }
    if (!r || !["windows", "mac", "android"].includes(r.device)) return json({ error: "device must be windows | mac | android" }, 400);
    await env.STORE.put(`applog/${r.device}/latest.json`, JSON.stringify({ ...r, received: now() }), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/api/applog") {
    const device = url.searchParams.get("device") || "windows"; if (!["windows", "mac", "android"].includes(device)) return json({ error: "device must be windows | mac | android" }, 400);
    const o = await env.STORE.get(`applog/${device}/latest.json`);
    return o ? new Response(o.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } }) : json({ error: "no report yet" }, 404);
  }
  if (request.method === "GET" && path === "/api/stats") {
    const a = await db.prepare("SELECT direction, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM messages GROUP BY direction").all();
    const b = await db.prepare("SELECT ingest_source, COALESCE(gmail_copy,'-') gmail_copy, COUNT(*) n FROM messages WHERE direction='in' GROUP BY ingest_source, gmail_copy").all();
    const c = await db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in' AND ingest_source='cloudflare' AND gmail_copy='none'").first();
    const last = await db.prepare("SELECT MAX(at) at FROM events WHERE kind='resend_poll_ok'").first();
    const st = await storageStats(db);
    return json({ messages: a.results, gmail_copy: b.results, cloudflare_inbound_without_gmail_copy: c.n, last_resend_poll_ok: last.at, storage: st });
  }
  return json({ error: "not found" }, 404);
}

// ---------- UI session auth (cookie = exp.hmac) ----------
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
// Sessions carry a generation number; bumping it (Settings → Sign out everywhere) invalidates every cookie ever issued.
// The generation is read from D1 at most every SESSION_GEN_TTL_MS per isolate, not on every check: a D1 round trip is a median 16 ms
// inside the Worker (13-26 ms, n=12, /health), paid by every cookie-authenticated request, so it is cached.
// The price: "sign out everywhere" reaches other isolates within the TTL instead of at
// once (the isolate that bumps updates its own copy immediately). Keyed by the D1 binding object, so two databases (tests) never share a
// value; if the runtime hands each request a fresh binding the cache simply never hits. A D1 failure answers with the last good value.
const SESSION_GEN_TTL_MS = 5000; const sessionGenCache = new WeakMap();
async function readSessionGen(env) { const r = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'session_gen'").first(); const v = parseInt(r?.value || "0", 10) || 0; sessionGenCache.set(env.DB, { v, at: Date.now() }); console.log("session gen: d1"); return v; }
async function sessionGen(env) {
  const c = env.DB ? sessionGenCache.get(env.DB) : null;
  if (c && Date.now() - c.at < SESSION_GEN_TTL_MS) return c.v;
  // Unreadable and nothing cached: no answer, never 0. 0 brought back every cookie a "sign out everywhere" had ended.
  try { return await readSessionGen(env); } catch (e) { if (c) return c.v; throw Object.assign(new Error("session check unavailable"), { code: "session_unavailable" }); }
}
async function bumpSessionGen(env) { const v = (await readSessionGen(env)) + 1;   /* unreadable: the sign-out fails, it never writes 1 over a higher generation */ /* fresh from D1, never the cached copy */ await env.DB.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('session_gen', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(v), now()).run(); sessionGenCache.set(env.DB, { v, at: Date.now() }); return v; }
async function makeSession(env) { const exp = Date.now() + 30 * 86400 * 1000; const gen = await sessionGen(env); return `${exp}.${gen}.${await hmac(env.SESSION_SECRET, `${exp}.${gen}`)}`; }
// The key the app adds to every /api/img URL it writes (client proxyImages). A message frame is same-origin with the app and its CSP
// allows img-src 'self', so a mail's own relative <img src="/api/img?u=…"> (or an svg <image>, a poster, a CSS url()) carries the
// session cookie: without this the hub would fetch any URL the sender chose at the moment the mail is opened; an open signal that
// skips the tracker rules and the arrival-time fetch. Bound to the session generation, so "sign out
// everywhere" changes it, and read from the cookie's own generation, which sessionValid has already checked: no second D1 read.
const imgKeys = new Map();
async function imgSessionKey(request, env) {
  const c = (request.headers.get("Cookie") || "").split(";").map((x) => x.trim()).find((x) => x.startsWith("mh="));
  if (!c || !env.SESSION_SECRET) return null;
  const parts = c.slice(3).split("."); const g = parts.length === 3 ? String(parseInt(parts[1], 10) || 0) : "0";
  const id = env.SESSION_SECRET + "|" + g;
  if (!imgKeys.has(id)) { if (imgKeys.size > 8) imgKeys.clear(); imgKeys.set(id, (await hmac(env.SESSION_SECRET, `img.${g}`)).slice(0, 22)); }
  return imgKeys.get(id);
}
async function sessionValid(request, env) {
  if (!env.SESSION_SECRET) return false;
  const c = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("mh="));
  if (!c) return false;
  const parts = c.slice(3).split("."); const gen = await sessionGen(env);
  // Digits only, the generation exactly as written. parseInt read "0db4275a-…" as 0, so a Google sign-in state, `${exp}.${uuid}.${hmac(exp.uuid)}`, the same shape under the same key, handed to anyone by GET /auth/google,
  // passed as a session
  // about one time in forty. The state is now signed under its own label as well (googleStart).
  if (parts.length === 3) { const [exp, g, sig] = parts; if (!/^\d{13}$/.test(exp) || g !== String(gen) || !sig || Number(exp) < Date.now()) return false; return constantTimeEqual(sig, await hmac(env.SESSION_SECRET, `${exp}.${g}`)); }
  const [exp, sig] = parts; // legacy two-part cookie: valid only while no "sign out everywhere" has ever happened
  if (gen !== 0 || !/^\d{13}$/.test(exp || "") || !sig || Number(exp) < Date.now()) return false;
  return constantTimeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}
async function googleStart(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return html("<p>Google sign-in is not configured yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>", 503);
  const nonce = uuid();
  const exp = Date.now() + 10 * 60 * 1000;
  const state = `${exp}.${nonce}.${await hmac(env.SESSION_SECRET, `gstate.${exp}.${nonce}`)}`;   // its own label: never a session's signature (sessionValid)
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/google/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    prompt: "select_account",
  });
  const h = new Headers({ location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, "cache-control": "no-store" });
  h.append("set-cookie", `mh_oauth=${state}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  // The native Mac app cannot sign in inside its own web view, Google refuses OAuth in embedded browsers (disallowed_useragent,
  // since 2021), so it runs this same flow in Apple's ASWebAuthenticationSession and is handed a one-time code at the end.
  // `challenge` is the base64url SHA-256 of a secret only the app holds; the code is worthless without that secret.
  const challenge = url.searchParams.get("challenge") || "";
  if (url.searchParams.get("app") === "1" && /^[A-Za-z0-9_-]{43}$/.test(challenge)) h.append("set-cookie", `mh_oauth_app=${challenge}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  // A web sign-in clears one: a link to /auth/google?app=1&challenge=<someone else's> left it for ten minutes, and the user
  // 's next web sign-in became an app sign-in bound to that challenge.
  else h.append("set-cookie", "mh_oauth_app=; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return new Response(null, { status: 302, headers: h });
}
// The page a Windows browser lands on once the app has its sign-in code (see appRedirect in googleCallback). `target` is
// sheritmail://auth?code=<base64url>, escaped anyway for both places it is written.
const appSignedInPage = (target) => {
  const attr = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Signed in · Sherit Mail</title>
<style>:root{--bg:#fff;--fg:#15161a;--mut:#6b6f7c;--acc:#3b5bdb}@media(prefers-color-scheme:dark){:root{--bg:#121316;--fg:#ececf1;--mut:#9aa0ab;--acc:#7c93ff}}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{min-height:100%;display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box}img{border-radius:14px;margin-bottom:14px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 20px;color:var(--mut)}a{display:inline-block;padding:10px 20px;border-radius:10px;background:var(--acc);color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><main><div><img src="/icons/icon-192.png?v=ghost1" width="64" height="64" alt=""><h1>You're signed in</h1><p>Sherit Mail is opening. You can close this tab.</p>
<a href="${attr}">Open Sherit Mail</a></div></main><script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});</script></body></html>`;
};
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function googleCallback(request, env, url) {
  // Logged through reserveSlot: at most 20 a quarter-hour, since anyone can call this URL and each log was a D1 write.
  const fail = (why, status = 400) => { reserveSlot(env.DB, "google_login_fail", 20, String(why).slice(0, 300)).catch(() => {}); return html(`<p>Sign-in failed: ${esc(why)}. <a href="/">Back</a></p>`, status, NO_SCRIPT); };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail("not configured", 503);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
  const cookie = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("mh_oauth="));
  if (!code || !state || !cookie || cookie.slice(9) !== state) return fail("state mismatch");
  const [exp, nonce, sig] = state.split(".");
  if (!exp || !nonce || !sig || Number(exp) < Date.now() || !(await constantTimeEqual(sig, await hmac(env.SESSION_SECRET, `gstate.${exp}.${nonce}`)))) return fail("state invalid or expired");
  // Native-app sign-in must survive a DUPLICATE callback. Android's Auth Tab loads each step of the flow twice (measured
  // /auth/google x2 at 03:00:54, the callback x2 at 03:00:57); the first redeemed Google's code and redirected to
  // the app from a navigation nobody saw, the second was refused by Google (invalid_grant) and that error page is what the user
  //  saw. So the first success is remembered against this flow's state nonce, and any repeat is answered with the
  // SAME one-time app code -- even one that raced the first and lost at Google, which waits briefly for the winner's record.
  const appCookie = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("mh_oauth_app="));
  // The Windows app signs in through the user's ordinary browser, not an auth sheet that closes itself on the callback
  // scheme (the Mac's ASWebAuthenticationSession, Android's Auth Tab). There a bare 302 to sheritmail: launched the app and
  // signed it in, but committed no page, so the tab kept showing Google's account chooser with its progress bar running for
  // ever (The Google page stayed up with its progress bar running). A Windows browser
  // gets a page instead: it says sign-in is done, opens the app itself, and carries a button for when the browser asks first.
  // The Mac and Android keep the 302 they were built and measured on (test/ingest.mjs).
  const windowsBrowser = /\bWindows NT\b/.test(request.headers.get("user-agent") || "");
  const appRedirect = (appCode) => {
    const target = `sheritmail://auth?code=${encodeURIComponent(appCode)}`;
    const ah = new Headers({ "cache-control": "no-store" });
    ah.append("set-cookie", "mh_oauth=; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    ah.append("set-cookie", "mh_oauth_app=; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    if (!windowsBrowser) { ah.set("location", target); return new Response(null, { status: 302, headers: ah }); }
    ah.set("content-type", "text/html; charset=utf-8");
    return new Response(appSignedInPage(target), { status: 200, headers: ah });
  };
  const priorApp = async () => { const r = await env.DB.prepare("SELECT value FROM prefs WHERE key = ?").bind(`appcb:${nonce}`).first(); try { return r ? JSON.parse(r.value).code : null; } catch (_) { return null; } };
  if (appCookie) { const again = await priorApp(); if (again) return appRedirect(again); }
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/google/callback`, grant_type: "authorization_code" }) });
  const tj = await tok.json().catch(() => ({}));
  if (!tok.ok || !tj.id_token) {
    if (appCookie && tj.error === "invalid_grant") for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 400)); const won = await priorApp(); if (won) return appRedirect(won); }
    return fail("token exchange failed" + (tj.error ? ` (${tj.error})` : ""));
  }
  // Let Google validate the signature and expiry; we check audience, issuer, nonce and the allowed email.
  const info = await (await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tj.id_token)}`)).json().catch(() => ({}));
  if (info.aud !== env.GOOGLE_CLIENT_ID) return fail("audience mismatch");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(info.iss)) return fail("issuer mismatch");
  if (info.nonce !== nonce) return fail("nonce mismatch");
  if (String(info.email_verified) !== "true") return fail("email not verified");
  const allowed = (env.ALLOWED_GOOGLE_EMAIL || "").split(",").map(lc).filter(Boolean);
  if (!allowed.includes(lc(info.email))) return fail(`account ${info.email} is not allowed`, 403);
  if (appCookie) {
    // Native app sign-in: no session cookie in this (system) browser -- a single-use code for the app, valid two minutes,
    // remembered against the flow's nonce so a duplicate callback (see above) is handed the same one.
    const challenge = appCookie.slice("mh_oauth_app=".length);
    const appCode = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("DELETE FROM prefs WHERE (key LIKE 'applogin:%' OR key LIKE 'appcb:%') AND updated_at < ?").bind(new Date(Date.now() - 600_000).toISOString()).run();
    await env.DB.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)").bind(`applogin:${appCode}`, JSON.stringify({ challenge, exp: Date.now() + 120_000 }), now()).run();
    await env.DB.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").bind(`appcb:${nonce}`, JSON.stringify({ code: appCode }), now()).run();
    await logEvent(env.DB, "login_ok", null, `google-app:${lc(info.email)} ${request.headers.get("cf-connecting-ip") || ""}`);
    return appRedirect((await priorApp()) || appCode);
  }
  await logEvent(env.DB, "login_ok", null, `google:${lc(info.email)} ${request.headers.get("cf-connecting-ip") || ""}`);
  const h = new Headers({ location: "/", "cache-control": "no-store" });
  h.append("set-cookie", `mh=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`);
  h.append("set-cookie", "mh_oauth=; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return new Response(null, { status: 302, headers: h });
}
// ---------- Gmail accounts ----------
// OAuth code flow with a SEPARATE Google client (GMAIL_CLIENT_ID/SECRET); the Worker keeps one AES-GCM-encrypted refresh
// token per account and mints short-lived access tokens for the browser/CLI, which call gmail.googleapis.com directly.
// The Worker keeps no Gmail message content. It does READ some: when Gmail push reports a new message it fetches it once
// (messages.get format=full, prefetchGmail) to fetch that message's remote images into R2 at arrival, so a sender cannot see the
// open; and it fetches an attachment or inline image on request at /api/gmail/att, passing the bytes on to the
// client without storing them. What it stores from Gmail is those images, never a body, a header or an attachment.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
// Read-only contacts, asked for alongside Gmail so the composer can suggest recipients the way Gmail does: the people saved in
// Google Contacts and the "Other contacts" Google records for everyone the account has emailed . Optional by
// construction: the callback still requires only GMAIL_SCOPE, so an account connected without them keeps working and the client
// simply does not query Google for it.
const CONTACTS_SCOPES = "https://www.googleapis.com/auth/contacts.other.readonly https://www.googleapis.com/auth/contacts.readonly";
const b64u8 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const gmailConfigured = (env) => !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_TOKEN_KEY);
// Imported / derived keys are kept per isolate (non-extractable CryptoKey objects): the import and the HKDF derivation were paid on
// every seal and every unlock, and a sync a minute unlocks a mailbox password each time. Keyed by the secret itself, so a rotated
// secret (a new deploy, a test with another key) never reuses a key derived from the old one.
const cryptoKeys = new Map();
function gmailKey(env, purpose = "tokens") {
  const ck = purpose + "|" + (env.GMAIL_TOKEN_KEY || "");
  let k = cryptoKeys.get(ck); if (!k) { k = gmailKeyUncached(env, purpose); cryptoKeys.set(ck, k); k.catch(() => cryptoKeys.delete(ck)); }
  return k;
}
async function gmailKeyUncached(env, purpose = "tokens") {
  const raw = unb64(env.GMAIL_TOKEN_KEY || "");
  if (raw.length !== 32) throw new Error("GMAIL_TOKEN_KEY must be 32 random bytes, base64");
  if (purpose === "tokens") return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  // Other purposes (scheduled drafts) get their own key derived with HKDF so the token key is never reused directly.
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("mailhub"), info: new TextEncoder().encode("purpose:" + purpose) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealToken(env, plain, aad, purpose = "tokens") {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await gmailKey(env, purpose), new TextEncoder().encode(plain));
  return { enc: b64u8(new Uint8Array(ct)), iv: b64u8(iv) };
}
async function openToken(env, enc, iv, aad, purpose = "tokens") {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, await gmailKey(env, purpose), unb64(enc));
  return new TextDecoder().decode(pt);
}
const cookieValue = (request, name) => { const c = (request.headers.get("Cookie") || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "=")); return c ? c.slice(name.length + 1) : ""; };
// The pages a browser lands on around Connect Gmail: connected, cancelled, expired, failed, or not signed in. They are often the
// only part of the app a default browser ever shows (the native apps hand connect to it), so they carry the app's look: the ghost,
// a badge for how it went, the app's colours light and dark. Still no script runs: the CSP allows this one stylesheet by its hash and
// the hub's own images, nothing else, and every piece of text is escaped (an `error` from the link is whatever the link says).
const CONNECT_CSS = ':root{color-scheme:light dark;--bg:#eef0f6;--card:#fff;--fg:#15161a;--mut:#6b6f7c;--line:#e3e5ec;--acc:#3b5bdb;--ok:#1f9d55;--no:#e8710a}'
  + '@media(prefers-color-scheme:dark){:root{--bg:#0c0f1d;--card:#151a2c;--fg:#ececf1;--mut:#9aa0ab;--line:#252b42;--acc:#7c93ff;--ok:#34c77b;--no:#ff9f43}}'
  + '*{box-sizing:border-box}html,body{height:100%}'
  + 'body{margin:0;display:grid;place-items:center;padding:24px 16px;color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;'
  + 'background:radial-gradient(900px 520px at 50% -8%,color-mix(in srgb,var(--acc) 24%,transparent),transparent 62%),var(--bg)}'
  + '.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:40px 28px 30px;text-align:center;box-shadow:0 24px 70px rgba(8,12,40,.22)}'
  + '.art{position:relative;width:112px;height:112px;margin:0 auto 22px;animation:float 3.4s ease-in-out infinite}'
  + '.art img{display:block;width:112px;height:112px;border-radius:26px;image-rendering:pixelated;box-shadow:0 12px 34px color-mix(in srgb,var(--acc) 40%,transparent)}'
  + '.badge{position:absolute;right:-10px;bottom:-10px;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;border:4px solid var(--card);animation:pop .5s cubic-bezier(.2,1.6,.4,1) .2s both}'
  + '.ok .badge{background:var(--ok)}.no .badge{background:var(--no)}.badge svg{width:20px;height:20px}'
  + '.ok .art::before,.ok .art::after{content:"";position:absolute;width:6px;height:6px;animation:twinkle 1.9s ease-in-out infinite}'
  + '.ok .art::before{left:-24px;top:16px;background:var(--acc);box-shadow:0 -6px var(--acc),0 6px var(--acc),-6px 0 var(--acc),6px 0 var(--acc)}'
  + '.ok .art::after{right:-20px;top:-8px;animation-delay:.95s;background:var(--ok);box-shadow:0 -6px var(--ok),0 6px var(--ok),-6px 0 var(--ok),6px 0 var(--ok)}'
  + 'h1{margin:0 0 10px;font-size:23px;line-height:1.25;letter-spacing:-.01em}p{margin:0 0 14px;color:var(--mut)}'
  + '.pill{display:inline-block;max-width:100%;margin:0 0 16px;padding:6px 14px;border-radius:999px;background:color-mix(in srgb,var(--acc) 13%,transparent);color:var(--fg);font-weight:600;overflow-wrap:anywhere}'
  + '.btn{display:inline-block;margin-top:6px;padding:10px 20px;border-radius:11px;background:var(--acc);color:#fff;text-decoration:none;font-weight:600}'
  + '.note{margin:20px 0 0;font-size:13px}'
  + '@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}@keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}'
  + '@keyframes twinkle{0%,100%{opacity:0;transform:scale(.5)}50%{opacity:1;transform:scale(1)}}'
  + '@media(prefers-reduced-motion:reduce){.art,.badge,.ok .art::before,.ok .art::after{animation:none}}';
const CONNECT_BADGE = {
  ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v7" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/><circle cx="10" cy="15.2" r="1.7" fill="#fff"/></svg>',
};
let connectCspP = null;
const connectCsp = () => (connectCspP ||= crypto.subtle.digest("SHA-256", new TextEncoder().encode(CONNECT_CSS))
  .then((d) => `default-src 'none'; style-src 'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'; img-src 'self'; base-uri 'none'; form-action 'none'`));
// `ok` picks the badge; `pill` is shown highlighted (the address connected); every string is plain text, escaped here.
async function connectPage({ ok = false, title, pill = "", text = "", note = "", link = null }, status = 200, extra = {}) {
  const body = `<main class="card ${ok ? "ok" : "no"}"><div class="art"><img src="/icons/icon-512.png" alt="" width="112" height="112"><span class="badge">${CONNECT_BADGE[ok ? "ok" : "no"]}</span></div>`
    + `<h1>${esc(title)}</h1>${pill ? `<p class="pill">${esc(pill)}</p>` : ""}${text ? `<p>${esc(text)}</p>` : ""}`
    + `${link ? `<a class="btn" href="${esc(link.href)}">${esc(link.text)}</a>` : ""}${note ? `<p class="note">${esc(note)}</p>` : ""}</main>`;
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Sherit Mail</title><style>${CONNECT_CSS}</style></head><body>${body}</body></html>`,
    status, { "content-security-policy": await connectCsp(), ...extra });
}
// A ticket from /api/gmail/ticket, taken (deleted) whatever happens next: true only for one that existed and had not expired.
async function takeGmailTicket(env, ticket) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(ticket)) return false;
  const row = await env.DB.prepare("DELETE FROM prefs WHERE key = ? RETURNING value").bind(`gmailticket:${ticket}`).first().catch(() => null);
  let rec = null; try { rec = JSON.parse(row?.value || "null"); } catch (_) {}
  return !!rec && rec.exp > Date.now();
}
async function gmailStart(request, env, url) {
  const ticket = url.searchParams.get("ticket") || "";
  const ok = (await sessionValid(request, env)) || (ticket && (await takeGmailTicket(env, ticket)));
  if (!ok) return connectPage(ticket
    ? { title: "This link has expired", text: "A Connect Gmail link works once, for two minutes. Go back to Sherit Mail and click Connect Gmail again." }
    : { title: "Sign in to the hub first", text: "Connect Gmail from Settings in Sherit Mail, or sign in here first.", link: { href: "/", text: "Sign in" } }, 401);
  if (!gmailConfigured(env)) return connectPage({ title: "Gmail connect isn't set up", text: "The hub needs the secrets GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_TOKEN_KEY." }, 503);
  const nonce = uuid();
  const exp = Date.now() + 10 * 60 * 1000;
  const state = `${exp}.${nonce}.${await hmac(env.SESSION_SECRET, `gmail.${exp}.${nonce}`)}`;
  const params = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/gmail/callback`,
    response_type: "code",
    scope: `openid email ${GMAIL_SCOPE} ${CONTACTS_SCOPES}`,
    access_type: "offline",          // refresh token
    prompt: "consent select_account", // consent every time so Google always returns a refresh token
    include_granted_scopes: "false",
    state,
    nonce,
  });
  return new Response(null, { status: 302, headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, "set-cookie": `mh_gmail=${state}; Path=/auth/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=600`, "cache-control": "no-store" } });
}
async function gmailCallback(request, env, url) {
  // Escaped, and no script runs on the page: Google's `error` parameter is whatever the link says, and this page is
  // on the hub's origin with the session: "?error=<img src=x onerror=…>" ran as the user.
  const fail = async (why, status = 400) => {
    await reserveSlot(env.DB, "gmail_connect_fail", 20, String(why).slice(0, 300)).catch(() => {});
    if (why === "Google returned access_denied") return connectPage({ title: "Connect cancelled", text: "Nothing was connected. Go back to Sherit Mail to try again, or close this tab." }, status);
    const w = String(why);
    return connectPage({ title: "Couldn't connect Gmail", text: w.charAt(0).toUpperCase() + w.slice(1) + ".", note: "Go back to Sherit Mail and click Connect Gmail again." }, status);
  };
  // No session is asked for here: the state below is the proof. Only gmailStart sets the mh_gmail cookie it must match, signed with
  // the session secret, for 10 minutes, and gmailStart sets it only for a signed-in browser or a one-time ticket from a signed-in app.
  const signedIn = await sessionValid(request, env).catch(() => false);
  if (!gmailConfigured(env)) return fail("not configured", 503);
  if (url.searchParams.get("error")) return fail(`Google returned ${url.searchParams.get("error")}`);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
  if (!code || !state || cookieValue(request, "mh_gmail") !== state) return fail("state mismatch");
  const [exp, nonce, sig] = state.split(".");
  if (!exp || !nonce || !sig || Number(exp) < Date.now() || !(await constantTimeEqual(sig, await hmac(env.SESSION_SECRET, `gmail.${exp}.${nonce}`)))) return fail("state invalid or expired");
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/gmail/callback`, grant_type: "authorization_code" }) });
  const tj = await tok.json().catch(() => ({}));
  if (!tok.ok || !tj.id_token) return fail("token exchange failed" + (tj.error ? ` (${tj.error})` : ""));
  if (!tj.refresh_token) return fail("Google returned no refresh token; remove the app at myaccount.google.com/permissions and connect again");
  if (!(tj.scope || "").split(" ").includes(GMAIL_SCOPE)) return fail(`the Gmail permission (gmail.modify) was not granted — Google granted only: ${(tj.scope || "(none)").replace(/https:\/\/www\.googleapis\.com\/auth\//g, "")}. On Google's consent screen, tick the checkbox for "Read, compose, and send emails from your Gmail account" before clicking Continue`);
  const info = await (await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tj.id_token)}`)).json().catch(() => ({}));
  if (info.aud !== env.GMAIL_CLIENT_ID) return fail("audience mismatch");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(info.iss)) return fail("issuer mismatch");
  if (info.nonce !== nonce) return fail("nonce mismatch");
  if (String(info.email_verified) !== "true") return fail("email not verified");
  const email = lc(info.email);
  const { enc, iv } = await sealToken(env, tj.refresh_token, email);
  await env.DB.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at) VALUES (?, ?, ?, ?, 'active', ?) ON CONFLICT(email) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, refresh_iv = excluded.refresh_iv, scope = excluded.scope, status = 'active', last_error = NULL").bind(email, enc, iv, tj.scope || "", now()).run();
  await logEvent(env.DB, "gmail_connected", null, `${email} ${request.headers.get("cf-connecting-ip") || ""}`);
  const clear = "mh_gmail=; Path=/auth/gmail; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  // A browser that came by ticket has no session: the hub's page there would only ask it to sign in, so it is told to go back to the app.
  if (!signedIn) return connectPage({ ok: true, title: "Gmail connected", pill: email, text: "Head back to Sherit Mail. Its mail shows up there in a minute or two.", note: "You can close this tab." }, 200, { "set-cookie": clear });
  const h = new Headers({ location: `/?gmail=${encodeURIComponent(email)}`, "cache-control": "no-store" });
  h.append("set-cookie", clear);
  return new Response(null, { status: 302, headers: h });
}
// Daily: mint one access token per active Gmail account. A failure is logged as gmail_refresh_fail (the report flags it),
// and a success on/after day 8 is the standing receipt that production status ended Google's 7-day Testing expiry.
// The client re-mints an access token about once an hour per account, and every mint wrote an events row (28 of the last 100 events).
// The mint itself is not news; one row every six hours per account is enough to see that the account is alive. CLI mints are rarer and
// security-relevant, so they are always logged. Per isolate, so a recycled isolate logs one extra row: harmless.
const tokenLogAt = new Map();
function tokenLogDue(email, viaBearer) {
  if (viaBearer) return true;
  const k = email || "?"; const last = tokenLogAt.get(k) || 0; if (Date.now() - last < 6 * 3600_000) return false;
  tokenLogAt.set(k, Date.now()); return true;
}
async function gmailDailyCheck(env) {
  if (!gmailConfigured(env)) return;
  const { results } = await env.DB.prepare("SELECT email FROM gmail_accounts WHERE status = 'active'").all();
  for (const r of results) { try { await gmailAccessToken(env, r.email); await logEvent(env.DB, "gmail_daily_mint_ok", null, r.email); } catch (e) { /* logged inside */ } }
}
async function gmailAccessToken(env, email) {
  if (!gmailConfigured(env)) throw Object.assign(new Error("Gmail connect is not configured"), { status: 503 });
  const row = await env.DB.prepare("SELECT * FROM gmail_accounts WHERE email = ?").bind(lc(email)).first();
  if (!row) throw Object.assign(new Error("Gmail account not connected"), { status: 404 });
  if (row.status !== "active") throw Object.assign(new Error(`Gmail account is ${row.status}; connect it again`), { status: 409 });
  const rt = await openToken(env, row.refresh_token_enc, row.refresh_iv, row.email);
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const why = j.error ? `${j.error}${j.error_description ? ": " + j.error_description : ""}` : `http ${r.status}`;
    await env.DB.prepare("UPDATE gmail_accounts SET last_error = ?, status = CASE WHEN ? = 'invalid_grant' THEN 'revoked' ELSE status END WHERE email = ?").bind(why, j.error || "", row.email).run();
    await logEvent(env.DB, "gmail_refresh_fail", null, `${row.email} ${why}`);
    throw Object.assign(new Error(`token refresh failed (${why})`), { status: 502 });
  }
  await env.DB.prepare("UPDATE gmail_accounts SET last_minted_at = ?, last_error = NULL WHERE email = ?").bind(now(), row.email).run();
  return { email: row.email, access_token: j.access_token, expires_in: j.expires_in, expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), scope: j.scope || row.scope };
}

// Public pages Google's OAuth consent configuration requires (homepage = the hub itself; privacy policy below). No login.
const PRIVACY_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sherit Mail — Privacy</title>
<style>body{max-width:720px;margin:40px auto;padding:0 20px;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111;background:#fff}@media(prefers-color-scheme:dark){body{color:#ececf1;background:#121316}}h1{font-size:24px}h2{font-size:18px;margin-top:28px}</style></head><body>
<h1>Sherit Mail — privacy policy</h1>
<p>Sherit Mail is a personal, single-user email client operated by its owner for the owner's own mailboxes. It is not offered to the public and has no users other than its owner.</p>
<h2>What it accesses</h2>
<p>With the owner's consent, the app reads, labels, archives, sends and moves messages in the owner's own Google accounts through the Gmail API, and does the same for the owner's other mailboxes over IMAP and for mail on the owner's own domains.</p>
<h2>What it stores</h2>
<p>For Google accounts the service stores only an encrypted OAuth refresh token, a sync cursor and account status. It does not copy, store or index Gmail message content. Mail on the owner's own domains and IMAP mailboxes is stored on the owner's own infrastructure.</p>
<h2>What it shares</h2>
<p>Nothing. No data is sold, shared with third parties, or used for advertising, analytics or AI training. Google user data is used only to display and manage the owner's own mail, in line with the Google API Services User Data Policy, including the Limited Use requirements.</p>
<h2>Revoking access</h2>
<p>Access can be withdrawn at any time from the app's account settings or from the owner's Google Account permissions page, which invalidates the stored token.</p>
<h2>Contact</h2>
<p>sam@yourdomain.example</p>
</body></html>`;
// ---------- IMAP ----------
// Opening a socket from the Worker to the work mail host fails roughly half the time with a silent timeout (measured in September 2026:
// 3 of 6 probes, while every port answers instantly from my Mac): most likely the host's firewall disliking some of
// Cloudflare's egress addresses. The open has a short timeout and reports its attempt count.
// Measured after adding retries: a blocked invocation fails all three attempts (18 s) and a good one succeeds first time; the block is
// per egress address, so cross-invocation retries (next cron tick, queue retry) are what help; in-request retries only add latency.
async function openTls(hostname, port, { attempts = 1, timeoutMs = 6000, label = "open" } = {}) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    const socket = connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });
    try { await Promise.race([socket.opened, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: tcp/tls open timeout`)), timeoutMs))]); socket.openAttempts = i; return socket; }
    catch (e) { lastErr = e; try { socket.close(); } catch (_) {} }
  }
  throw new Error(`open failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
}
// Pre-auth probe: proves the Worker can open an implicit-TLS socket to an IMAP host and speak the protocol. No credentials.
async function imapProbe(host, port = 993) {
  const started = Date.now();
  let socket; try { socket = await openTls(host, port, { label: "probe" }); } catch (e) { throw e; }
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const readUntil = async (pred, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!pred(buf)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("imap read timeout");
      const { value, done, timeout } = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ done: true, timeout: true }), left))]);
      if (timeout) throw new Error(`imap read timeout after ${ms} ms (got ${buf.length} bytes)`);
      if (done) { if (!pred(buf)) throw new Error(`imap connection closed by peer (got ${buf.length} bytes)`); break; }
      buf += dec.decode(value, { stream: true });
    }
  };
  const send = async (line) => { await writer.write(new TextEncoder().encode(line + "\r\n")); };
  try {
    await readUntil((b) => b.includes("\r\n"));
    const greeting = buf.split("\r\n")[0]; buf = "";
    await send("a1 CAPABILITY");
    await readUntil((b) => /\r\na1 (OK|NO|BAD)/.test("\r\n" + b));
    const capLines = buf.split("\r\n").filter(Boolean); buf = "";
    await send("a2 LOGOUT");
    await readUntil((b) => /a2 (OK|NO|BAD)/.test(b), 3000).catch(() => {});
    return { host, port, tls: "implicit", open_attempts: socket.openAttempts || 1, greeting, capability: capLines, ms: Date.now() - started };
  } finally { try { await writer.close(); } catch (_) {} try { socket.close(); } catch (_) {} }
}
// ---------- IMAP accounts ----------
// Two sources, merged by address. "config": IMAP_ACCOUNTS in wrangler.toml, its password in the named Worker secret. "app": added
// from Settings, stored in D1 (imap_accounts) with the password sealed. An app entry overrides a config entry for the same address,
// which is how a configured mailbox gets its password from the form. NO account object carries a password: imapPassword() produces
// it at the moment of a login, from a fresh read of its row, and the caller drops it when that login is over.
const IMAP_PORT = 993, SMTP_PORT = 465;   // implicit TLS only: no plaintext, and no STARTTLS for a network to strip
function imapConfigAccounts(env) {
  let list = []; try { list = JSON.parse(env.IMAP_ACCOUNTS || "[]"); } catch (_) { list = []; }
  return list.map((a) => ({ source: "config", email: lc(a.email), label: a.label || a.email, color: a.color || null, host: a.host, port: a.port || 993, user: a.user || a.email, ready: !!env[a.secret || "WORK_IMAP_PASSWORD"], secret: a.secret || "WORK_IMAP_PASSWORD", smtp_host: a.smtp_host || a.host, smtp_port: a.smtp_port || 465 }));
}
// App accounts' metadata (never the ciphertext) cached per isolate. A stale entry can only show or list an account; it cannot
// log in, because imapPassword() re-reads the row and refuses one whose servers no longer match.
const imapCache = { at: 0, rows: [] };
async function imapAccounts(env, { fresh = false } = {}) {
  if (env.DB && (fresh || Date.now() - imapCache.at > 60_000)) {
    try { const { results } = await env.DB.prepare("SELECT email, label, color, host, port, username, smtp_host, smtp_port, verified_at FROM imap_accounts ORDER BY email").all(); imapCache.rows = results || []; imapCache.at = Date.now(); }
    catch (_) { /* before migration 0028: config accounts only */ }
  }
  const byEmail = new Map(imapConfigAccounts(env).map((a) => [a.email, a]));
  for (const r of imapCache.rows) byEmail.set(lc(r.email), { source: "app", email: lc(r.email), label: r.label || r.email, color: r.color || null, host: r.host, port: r.port, user: r.username, ready: true, secret: null, smtp_host: r.smtp_host, smtp_port: r.smtp_port, verified_at: r.verified_at });
  return [...byEmail.values()];
}
const imapAccountFor = async (env, email, opts) => (await imapAccounts(env, opts)).find((a) => a.email === lc(email));
// What the client may know about a mailbox. Never the password, never the ciphertext.
// What the app shows about each work mailbox: the account, plus whether its server is refusing the password or cannot be reached
// right now. Settings said "connected" whenever a password was saved, through 11 hours of refused sign-ins.
async function imapPublicAll(env) {
  const accts = await imapAccounts(env); let rows = [];
  try { rows = (await env.DB.prepare("SELECT account, auth_failures, auth_retry_at, last_error, last_sync_at FROM imap_folders WHERE folder = 'INBOX'").all()).results || []; } catch (_) {}
  const by = new Map(rows.map((r) => [lc(r.account), r]));
  return accts.map((a) => { const r = by.get(a.email); return { ...imapPublic(a), signin_refused: !!(r?.auth_failures > 0), retry_at: r?.auth_retry_at ? new Date(r.auth_retry_at).toISOString() : null, last_error: r?.last_error || null, last_sync_at: r?.last_sync_at || null }; });
}
const imapPublic = (a) => ({ email: a.email, label: a.label, color: a.color, ready: a.ready, source: a.source, host: a.host, port: a.port, user: a.user, smtp_host: a.smtp_host, smtp_port: a.smtp_port, verified_at: a.verified_at || null });
// The additional data binds the ciphertext to everything that decides where the password goes. Edit any of these columns in D1 and
// the password stops decrypting: the Worker refuses instead of carrying it to a server it was never entered for.
const imapAad = (r) => `imap-password|v1|${lc(r.email)}|${r.username}|${lc(r.host)}:${r.port}|${lc(r.smtp_host)}:${r.smtp_port}`;
async function imapPassword(env, acct) {
  if (acct.source !== "app") { const p = env[acct.secret]; if (!p) throw new Error(`no password for ${acct.email}: secret ${acct.secret} not set`); return p; }
  const r = await env.DB.prepare("SELECT email, username, host, port, smtp_host, smtp_port, pass_enc, pass_iv FROM imap_accounts WHERE email = ?").bind(acct.email).first();
  if (!r) throw new Error(`${acct.email} was removed`);
  // The servers this login is about to reach must be the ones in the row (and so, through the AAD, the ones the password was sealed
  // for): a cached account object from before an edit must never carry the new password to the old servers, or the reverse.
  if (lc(r.host) !== lc(acct.host) || +r.port !== +acct.port || lc(r.smtp_host) !== lc(acct.smtp_host) || +r.smtp_port !== +acct.smtp_port || r.username !== acct.user) { imapCache.at = 0; throw new Error(`${acct.email} changed since this run started`); }
  try { return await openToken(env, r.pass_enc, r.pass_iv, imapAad(r), "imap-password"); }
  catch (_) { throw new Error(`the saved password for ${acct.email} cannot be unlocked (its servers or the key changed); add it again in Settings`); }
}
// IANA's RDAP directory (which registry answers for which top-level domain), fetched once a day per isolate.
const rdapDirectory = { at: 0, map: null };
async function rdapBase(tld) {
  if (!rdapDirectory.map || Date.now() - rdapDirectory.at > 86400e3) {
    const j = await (await fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(5000) })).json(); const map = new Map();
    for (const [tlds, urls] of j.services || []) { const u = (urls || []).find((x) => /^https:\/\//.test(x)); if (u) for (const t of tlds) map.set(String(t).toLowerCase(), u); }
    rdapDirectory.map = map; rdapDirectory.at = Date.now();
  }
  return rdapDirectory.map.get(String(tld || "").toLowerCase()) || null;
}
// One statement that both counts the window and claims a slot, so concurrent requests cannot all pass a count taken before any of
// them wrote. SQLite runs it atomically.
async function reserveSlot(db, kind, limit, detail) {
  const r = await db.prepare("INSERT INTO events (kind, detail) SELECT ?, ? WHERE (SELECT COUNT(*) FROM events WHERE kind = ? AND at > datetime('now', '-15 minutes')) < ?").bind(kind, detail, kind, limit).run();
  return (r.meta?.changes || 0) === 1;
}
// Adding, re-keying or removing a mailbox is announced on every device, whatever the notification settings: a session that was
// stolen could otherwise point future work mail at another server quietly.
async function imapSecurityAlert(env, request, title, body) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown address", where = [request.cf?.city, request.cf?.country].filter(Boolean).join(", ");
  const text = `${body} From ${ip}${where ? " (" + where + ")" : ""}. Not you? Remove it in Settings → Accounts and sign out everywhere.`;
  await logEvent(env.DB, "security_alert", null, `${title}: ${text}`);
  ctxWaitUntil(sendPush(env, { kind: "security", title, body: text, url: "/" }, { urgency: "high" }));
}
// A login that must work before anything is stored: IMAP and SMTP in parallel, so the form waits for the slower one, not both.
async function imapVerifyLogin(f, password) {
  const imap = (async () => { const c = new ImapClient(f.host, f.port); try { await c.connect(); await c.login(f.username, password); } finally { await c.logout(); } })();
  const smtp = smtpSubmit({ smtp_host: f.smtp_host, smtp_port: f.smtp_port, user: f.username, password }, null, null, null);
  const [ri, rs] = await Promise.allSettled([withTimeout(imap, 20_000, "IMAP login"), withTimeout(smtp, 20_000, "SMTP login")]);
  // The server's own words, which never contain the password (the AUTHENTICATE / AUTH lines are redacted at the source).
  const secrets = secretForms(f.username, password);
  const why = (r) => scrubSecrets(String(r.reason?.message || r.reason || "").replace(/^open failed after \d+ attempts: /, ""), secrets).slice(0, 200);
  if (ri.status === "rejected") return { ok: false, error: /AUTHENTICATE/.test(why(ri)) ? `${f.host} refused the login: ${why(ri).replace(/^imap AUTHENTICATE → /, "")}` : `Couldn't reach ${f.host}:${f.port} (${why(ri)})` };
  if (rs.status === "rejected") return { ok: false, error: /smtp AUTH/.test(why(rs)) ? `The sending server ${f.smtp_host} refused the login: ${why(rs).replace(/^smtp AUTH → /, "")}` : `Couldn't reach the sending server ${f.smtp_host}:${f.smtp_port} (${why(rs)})` };
  return { ok: true };
}
// Fields of an add / change request, checked before anything opens a socket. Hosts are names that resolve publicly, ports are the
// two implicit-TLS ports, and nothing may carry the NUL that separates SASL PLAIN's fields.
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
async function imapAccountFields(b) {
  const email = lc(b.email);
  if (!/^[^\s@<>"(),;:\\]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/.test(email)) return { error: "That isn't an email address" };
  const host = lc(b.host), smtp_host = lc(b.smtp_host || b.host);
  const port = b.port === undefined ? IMAP_PORT : +b.port, smtp_port = b.smtp_port === undefined ? SMTP_PORT : +b.smtp_port;
  if (port !== IMAP_PORT || smtp_port !== SMTP_PORT) return { error: `Only encrypted connections are allowed: IMAP on ${IMAP_PORT} and SMTP on ${SMTP_PORT}` };
  for (const h of [host, smtp_host]) if (!HOST_RE.test(h) || badHost(h)) return { error: `"${h}" isn't a mail server name` };
  const username = String(b.username || email).trim();
  if (!username || username.length > 256 || /[\u0000-\u001f\u007f]/.test(username)) return { error: "That username can't be used" };
  const label = b.label == null ? null : String(b.label).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || null;
  const color = b.color == null ? null : /^#[0-9a-f]{6}$/i.test(String(b.color)) ? String(b.color).toLowerCase() : undefined;
  if (color === undefined) return { error: "Colour must look like #3b5bdb" };
  if ((await Promise.all([...new Set([host, smtp_host])].map(resolvesPrivate))).some(Boolean)) return { error: "That server resolves to a private address" };
  return { email, host, port, smtp_host, smtp_port, username, label, color };
}
// Where a domain's mail servers are, found WITHOUT sending any credential: DNS SRV (RFC 6186 / 8314) first, then the usual names,
// each kept only if it answers a TLS connection with the right greeting. The password later goes only to the servers shown.
async function imapDiscover(env, email) {
  const known = await imapAccountFor(env, email, { fresh: true });
  if (known) return { host: known.host, port: known.port, smtp_host: known.smtp_host, smtp_port: known.smtp_port, username: known.user, label: known.label, found: known.source };
  const domain = email.split("@")[1];
  const srv = async (name, want) => { try { const r = await (await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=SRV`, { headers: { accept: "application/dns-json" } })).json();
    return (r.Answer || []).slice(0, 10).filter((a) => a.type === 33).map((a) => String(a.data).split(/\s+/)).filter((x) => +x[2] === want).sort((x, y) => +x[0] - +y[0]).map((x) => lc(x[3]).replace(/\.$/, "")).filter((h) => h && h !== ".").slice(0, 1); } catch (_) { return []; } };
  const greets = async (host, port, re) => { if (!HOST_RE.test(host) || badHost(host) || (await resolvesPrivate(host))) return false;
    let sock; try { sock = await openTls(host, port, { timeoutMs: 4000, label: "discover" }); const rd = sock.readable.getReader(); const { value } = await withTimeout(rd.read(), 4000, "greeting"); return re.test(new TextDecoder().decode(value || new Uint8Array())); }
    catch (_) { return false; } finally { try { sock?.close(); } catch (_) {} } };
  const pick = async (cands, port, re) => { const uniq = [...new Set(cands)].slice(0, 3); const ok = await Promise.all(uniq.map((h) => greets(h, port, re))); return uniq.find((_, i) => ok[i]) || null; };
  const [iS, sS] = await Promise.all([srv(`_imaps._tcp.${domain}`, IMAP_PORT), srv(`_submissions._tcp.${domain}`, SMTP_PORT)]);
  const [host, smtp_host] = await Promise.all([pick([...iS, `mail.${domain}`, `imap.${domain}`], IMAP_PORT, /^\* (OK|PREAUTH)/), pick([...sS, `mail.${domain}`, `smtp.${domain}`], SMTP_PORT, /^220[ -]/)]);
  return { host, port: IMAP_PORT, smtp_host: smtp_host || host, smtp_port: SMTP_PORT, username: email, label: null, found: host ? "dns" : null };
}
const encU = new TextEncoder(), decU = new TextDecoder();
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timeout after ${ms} ms`)), ms))]);
const imapQuote = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
// A server holds the credential the moment it is sent, and may echo it in any reply after that: into an error this Worker would
// return, store in events or keep as a mailbox's last_error. So: the reply to an AUTH step is reduced to
// codes from a fixed list, never free text; and every error raised after a login has the credential, in every form it travels in,
// cut out. Case-insensitively for the password itself, since an echo need not preserve case.
// SASL PLAIN is UTF-8 (RFC 4616); btoa() of the raw string threw on any password outside Latin-1.
const b64utf8 = (s) => btoa(unescape(encodeURIComponent(s)));
const saslPlain = (user, pass) => b64utf8(`\u0000${user}\u0000${pass}`);
const secretForms = (user, pass) => { if (!pass) return []; const f = [pass, b64utf8(pass), saslPlain(user, pass), encodeURIComponent(pass)]; return [...new Set(f.filter((x) => x && x.length >= 3))]; };
const scrubSecrets = (msg, secrets) => { let out = String(msg ?? ""); for (const x of secrets || []) out = out.replace(new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]"); return out; };
const IMAP_AUTH_CODES = new Set(["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED", "PRIVACYREQUIRED", "CONTACTADMIN", "NOPERM", "INUSE", "LIMIT", "UNAVAILABLE", "SERVERBUG", "ALERT"]);   // RFC 5530 + ALERT
const authReplyImap = (st) => { const w = (st.match(/^(NO|BAD|BYE)\b/i)?.[1] || "refused").toUpperCase(); const c = (st.match(/^\S+\s+\[([A-Z-]+)\]/i)?.[1] || "").toUpperCase(); return IMAP_AUTH_CODES.has(c) ? `${w} [${c}]` : w; };
const authReplySmtp = (r) => { const e = String(r.text || "").replace(/^\d{3}[ -]/, "").match(/^([245]\.\d{1,3}\.\d{1,3})\b/)?.[1]; return `${r.code}${e ? " " + e : ""}`; };
class ImapClient {
  constructor(host, port = 993) { this.host = host; this.port = port; this.tagN = 0; this.buf = new Uint8Array(0); this.caps = new Set(); this.selected = null; }
  async connect() {
    this.socket = await openTls(this.host, this.port, { label: "imap open" }); this.openAttempts = this.socket.openAttempts;
    this.writer = this.socket.writable.getWriter(); this.reader = this.socket.readable.getReader();
    const g = await this.readLine();
    if (!/^\* (OK|PREAUTH)/.test(g)) throw new Error("imap greeting: " + g.slice(0, 100));
    const m = g.match(/\[CAPABILITY ([^\]]+)\]/); if (m) m[1].split(" ").forEach((c) => this.caps.add(c.toUpperCase()));
    return g;
  }
  async fill() { const { value, done } = await withTimeout(this.reader.read(), 30000, "imap read"); if (done) throw new Error("imap connection closed"); const n = new Uint8Array(this.buf.length + value.length); n.set(this.buf); n.set(value, this.buf.length); this.buf = n; }
  async readLine() { for (;;) { for (let i = 0; i + 1 < this.buf.length; i++) if (this.buf[i] === 13 && this.buf[i + 1] === 10) { const line = decU.decode(this.buf.subarray(0, i)); this.buf = this.buf.subarray(i + 2); return line; } if (this.buf.length > 1_048_576) throw new Error("imap line longer than 1 MiB"); await this.fill(); } }   // a server that never ends a line cannot grow this without bound
  async readBytes(n) { if (n > IMAP_LITERAL_MAX) throw new Error(`the server announced a ${Math.round(n / 1048576)} MB literal, over the ${IMAP_LITERAL_MAX / 1048576} MB this Worker will hold`); while (this.buf.length < n) await this.fill(); const out = this.buf.slice(0, n); this.buf = this.buf.subarray(n); return out; }
  async readResponse() { let line = await this.readLine(); const literals = []; let m; while ((m = line.match(/\{(\d+)\}$/))) { literals.push(await this.readBytes(Number(m[1]))); line = line.slice(0, -m[0].length) + `\u0000LIT${literals.length - 1}\u0000` + (await this.readLine()); } return { line, literals }; }
  write(s) { return this.writer.write(encU.encode(s)); }
  async cmd(command, { literal = null, redact = false } = {}) {
    const tag = "A" + String(++this.tagN).padStart(4, "0");
    if (literal) { await this.write(`${tag} ${command} {${literal.length}}\r\n`); const c = await this.readLine(); if (!c.startsWith("+")) throw new Error("imap no continuation: " + c.slice(0, 100)); await this.writer.write(literal); await this.write("\r\n"); }
    else await this.write(`${tag} ${command}\r\n`);
    const untagged = [];
    for (;;) {
      const r = await this.readResponse();
      if (r.line.startsWith(tag + " ")) { const st = r.line.slice(tag.length + 1); if (!/^OK/i.test(st)) throw new Error(scrubSecrets(`imap ${redact ? command.split(" ")[0] : command.split(" ").slice(0, 2).join(" ")} → ${redact ? authReplyImap(st) : st.slice(0, 160)}`, this.secrets)); return { status: st, untagged }; }
      if (r.line.startsWith("+")) continue;
      untagged.push(r);
    }
  }
  async login(user, pass) {
    this.secrets = secretForms(user, pass);   // from here on, no error this connection raises may carry the credential
    const r = await this.cmd(`AUTHENTICATE PLAIN ${saslPlain(user, pass)}`, { redact: true });
    const cm = r.status.match(/\[CAPABILITY ([^\]]+)\]/);
    if (cm) cm[1].split(" ").forEach((c) => this.caps.add(c.toUpperCase()));
    else { const c = await this.cmd("CAPABILITY"); for (const u of c.untagged) if (u.line.startsWith("* CAPABILITY")) u.line.slice(13).split(" ").forEach((x) => this.caps.add(x.toUpperCase())); }
  }
  async list() { const r = await this.cmd('LIST "" "*"'); return r.untagged.map((u) => u.line.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|(\S+)) (?:"((?:[^"\\]|\\.)*)"|(\S+))$/)).filter(Boolean).map((m) => ({ attrs: m[1].split(" ").filter(Boolean).map((a) => a.toLowerCase()), delim: m[2] ?? m[3], name: (m[4] ?? m[5]).replace(/\\(["\\])/g, "$1") })); }
  async select(folder) { const r = await this.cmd(`SELECT ${imapQuote(folder)}`); const info = { folder, exists: 0, uidvalidity: null, uidnext: null }; for (const u of [...r.untagged, { line: r.status }]) { let m; if ((m = u.line.match(/^\* (\d+) EXISTS/))) info.exists = +m[1]; if ((m = u.line.match(/UIDVALIDITY (\d+)/))) info.uidvalidity = +m[1]; if ((m = u.line.match(/UIDNEXT (\d+)/))) info.uidnext = +m[1]; } this.selected = folder; return info; }
  async uidSearch(q) { const r = await this.cmd(`UID SEARCH ${q}`); const out = []; for (const u of r.untagged) if (u.line.startsWith("* SEARCH")) out.push(...u.line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number)); return out; }
  async uidFetch(set, items) {
    const r = await this.cmd(`UID FETCH ${set} (${items})`); const out = [];
    for (const u of r.untagged) {
      const m = u.line.match(/^\* (\d+) FETCH \((.*)\)$/s); if (!m) continue;
      const b = m[2]; const rec = { seq: +m[1] }; let x;
      if ((x = b.match(/\bUID (\d+)/))) rec.uid = +x[1];
      if ((x = b.match(/\bFLAGS \(([^)]*)\)/))) rec.flags = x[1].split(" ").filter(Boolean);
      if ((x = b.match(/\bINTERNALDATE "([^"]+)"/))) rec.internalDate = x[1];
      if ((x = b.match(/\bRFC822\.SIZE (\d+)/))) rec.size = +x[1];
      if ((x = b.match(/\bBODY\[\] \u0000LIT(\d+)\u0000/))) rec.raw = u.literals[+x[1]];
      if ((x = b.match(/\bBODY\[HEADER\] \u0000LIT(\d+)\u0000/))) rec.header = u.literals[+x[1]];
      if ((x = b.match(/\bBODY\[HEADER\.FIELDS \([^)]*\)\] \u0000LIT(\d+)\u0000/))) rec.headers = decU.decode(u.literals[+x[1]]);
      out.push(rec);
    }
    return out;
  }
  async uidStore(set, mode, flags) { await this.cmd(`UID STORE ${set} ${mode}FLAGS.SILENT (${flags})`); }
  async uidMove(uid, folder) { if (this.caps.has("MOVE")) return this.cmd(`UID MOVE ${uid} ${imapQuote(folder)}`); await this.cmd(`UID COPY ${uid} ${imapQuote(folder)}`); await this.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`); if (this.caps.has("UIDPLUS")) await this.cmd(`UID EXPUNGE ${uid}`); else await this.cmd("EXPUNGE"); }
  async append(folder, raw, flags = "\\Seen") { return this.cmd(`APPEND ${imapQuote(folder)} (${flags})`, { literal: raw }); }
  async create(folder) { return this.cmd(`CREATE ${imapQuote(folder)}`); }
  async logout() { try { await withTimeout(this.cmd("LOGOUT"), 3000, "logout"); } catch (_) {} try { await this.writer.close(); } catch (_) {} try { this.socket.close(); } catch (_) {} }
}
async function smtpSubmit(acct, envelopeFrom, rcpts, raw, stage = {}) {
  const socket = await openTls(acct.smtp_host, acct.smtp_port, { label: "smtp open" }); // retries happen before any SMTP dialogue, so a retry can never double-send
  const writer = socket.writable.getWriter(), reader = socket.readable.getReader(); let buf = "";
  const read = async () => { for (;;) { const lines = buf.split("\r\n"); const complete = lines.slice(0, -1); const idx = complete.findIndex((l) => /^\d{3} /.test(l)); if (idx >= 0) { const code = +complete[idx].slice(0, 3); buf = lines.slice(idx + 1).join("\r\n"); return { code, text: complete.slice(0, idx + 1).join("\n") }; } const { value, done } = await withTimeout(reader.read(), 30000, "smtp read"); if (done) throw new Error("smtp connection closed"); buf += decU.decode(value, { stream: true }); if (buf.length > 1_048_576) throw new Error("smtp reply longer than 1 MiB"); } };
  const secrets = secretForms(acct.user, acct.password);   // no error from this session may carry the credential, whatever the server echoes
  const send = async (line, expect, label = line.split(" ")[0]) => { await writer.write(encU.encode(line + "\r\n")); const r = await read(); if (!expect.includes(r.code)) throw new Error(scrubSecrets(label === "AUTH" ? `smtp AUTH → ${authReplySmtp(r)}` : `smtp ${label} → ${r.code} ${r.text.slice(-140)}`, secrets)); return r; };
  try {
    const g = await read(); if (g.code !== 220) throw new Error("smtp greeting " + g.code);
    await send("EHLO mail.yourdomain.example", [250]);
    await send("AUTH PLAIN " + saslPlain(acct.user, acct.password), [235], "AUTH");
    if (raw === null) { try { await withTimeout(send("QUIT", [221]), 3000, "quit"); } catch (_) {} return "login ok"; }   // imapVerifyLogin: prove the login, send nothing
    await send(`MAIL FROM:<${envelopeFrom}>`, [250]);
    for (const r of rcpts) await send(`RCPT TO:<${r}>`, [250, 251]);
    await send("DATA", [354]);
    const data = raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    stage.smtp = "data"; // from here until the 250 a lost answer means the server MAY have accepted the message
    await writer.write(encU.encode(data + (data.endsWith("\r\n") ? "" : "\r\n") + ".\r\n"));
    const r = await read(); if (r.code !== 250) { stage.smtp = "rejected"; throw new Error(scrubSecrets(`smtp DATA → ${r.code} ${r.text.slice(-140)}`, secrets)); }
    stage.smtp = "done";
    try { await withTimeout(send("QUIT", [221]), 3000, "quit"); } catch (_) {}
    return r.text;
  } finally { try { await writer.close(); } catch (_) {} try { socket.close(); } catch (_) {} }
}
// A search query's terms, read as hub/public/search.worker.js buildMatch reads them: a "quoted phrase" (with or without
// a from:/subject: prefix) is one term; a bare word is one; the prefix of a bare from:x is the index's language and only x is the
// term here; a -word exclusion and account:x are the index's alone and are dropped, so the hub answers with a superset, never less.
function searchTerms(q) {
  const out = []; for (const m of String(q || "").matchAll(/(?:[a-z]+:)?"([^"]*)"|(\S+)/gi)) {
    let t = (m[1] ?? m[2]).trim(); if (m[2]) { if (t.startsWith("-")) continue; if (/^account:/i.test(t)) continue; t = t.replace(/^(from|to|subject|body):/i, "").replace(/^"|"$/g, ""); }
    if (t.trim()) out.push(t.trim()); }
  return out;
}
// A conversation holds a file: GET /api/threads' has_att and its has:attachment search (see the comment there).
const HAS_ATT_SQL = `EXISTS (SELECT 1 FROM messages ma JOIN attachments a ON a.message_id = ma.id WHERE ma.thread_id = t.id
        AND NOT (COALESCE(trim(a.content_id, '<> '), '') <> '' AND instr(COALESCE(ma.body_html, ''), 'cid:' || trim(a.content_id, '<> ')) > 0))`;
// Gmail's search operators: client/store.js parseSearch, the same function; the device sends the query in Gmail's
// spelling with its dates as epoch seconds (serverQuery), and a calendar date typed straight to this API is midnight UTC (the Worker's
// clock). test/searchops.mjs runs both on the same queries. The words left over go to searchTerms.
const SEARCH_IN = { inbox: "inbox", archive: "archived", archived: "archived", done: "archived", trash: "trash", bin: "trash", spam: "spam", junk: "spam", sent: "sent", snoozed: "snoozed", anywhere: "anywhere", all: "anywhere" };
const SEARCH_IS = { unread: ["unread", "read"], read: ["read", "unread"], starred: ["starred", "unstarred"], pinned: ["starred", "unstarred"] };
function searchWhen(v, now) {
  let m = /^(\d{9,11})$/.exec(v); if (m) return Number(m[1]) * 1000;
  let y = 0, mo = 0, d = 0;
  if ((m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [y, mo, d] = [+m[3], +m[1], +m[2]];
  if (y) { const t = new Date(y, mo - 1, d); return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : null; }
  m = /^(\d{1,4})([dmy])$/i.exec(v); if (m) { const n = +m[1], t = new Date(now); if (/d/i.test(m[2])) t.setDate(t.getDate() - n); else if (/m/i.test(m[2])) t.setMonth(t.getMonth() - n); else t.setFullYear(t.getFullYear() - n); return t.getTime(); }
  return null;
}
export function searchQuery(q, now = Date.now()) {
  const s = { text: "", in: [], notIn: [], want: [], after: null, before: null, ops: false }; const words = [];
  for (const m of String(q || "").matchAll(/(?:[a-z]+:)?"[^"]*"|\S+/gi)) {
    const tok = m[0], o = /^(-?)(in|is|has|after|before|newer|older|newer_than|older_than):(.+)$/i.exec(tok);
    const neg = !!(o && o[1]), op = o ? o[2].toLowerCase() : "", v = o ? o[3].toLowerCase() : "";
    if (op === "in" && SEARCH_IN[v]) (neg ? s.notIn : s.in).push(SEARCH_IN[v]);
    else if (op === "is" && SEARCH_IS[v]) s.want.push(SEARCH_IS[v][neg ? 1 : 0]);
    else if (op === "has" && (v === "attachment" || v === "attachments")) s.want.push(neg ? "noatt" : "att");
    else if (op && op !== "in" && op !== "is" && op !== "has" && searchWhen(v, now) != null && (/_than$/.test(op) === /^\d{1,4}[dmy]$/.test(v))) {
      const at = searchWhen(v, now), late = (op === "after" || op === "newer" || op === "newer_than") !== neg;
      if (late) s.after = s.after == null ? at : Math.max(s.after, at); else s.before = s.before == null ? at : Math.min(s.before, at);
    } else { words.push(tok); continue; }
    s.ops = true;
  }
  s.text = words.join(" ");
  return s;
}
const ROLE_ATTR = { "\\sent": "sent", "\\trash": "trash", "\\junk": "junk", "\\drafts": "drafts", "\\archive": "archive", "\\all": "all" };
async function imapFolderRoles(db, c, acct, { refresh = false } = {}) {
  const { results } = await db.prepare("SELECT folder, role FROM imap_folders WHERE account = ? AND role IS NOT NULL").bind(acct.email).all();
  const roles = {}; for (const r of results) roles[r.role] = r.folder;
  if (!refresh && roles.trash && roles.sent) return roles;
  const list = await c.list(); const delim = list[0]?.delim || ".";
  const byName = (n) => list.find((f) => f.name.toLowerCase() === n.toLowerCase() || f.name.toLowerCase() === ("inbox" + delim + n).toLowerCase())?.name;
  for (const f of list) for (const a of f.attrs) if (ROLE_ATTR[a] && !roles[ROLE_ATTR[a]]) roles[ROLE_ATTR[a]] = f.name;
  roles.inbox = "INBOX"; roles.sent ||= byName("Sent") || byName("Sent Items") || byName("Sent Messages"); roles.trash ||= byName("Trash") || byName("Deleted Items"); roles.junk ||= byName("Junk") || byName("Spam"); roles.drafts ||= byName("Drafts"); roles.archive ||= byName("Archive"); roles.snoozed = byName("Snoozed");
  for (const need of ["archive", "snoozed"]) if (!roles[need]) { const name = "INBOX" + delim + (need === "archive" ? "Archive" : "Snoozed"); try { await c.create(name); roles[need] = name; await logEvent(db, "imap_folder_created", null, `${acct.email} ${name}`); } catch (e) { await logEvent(db, "imap_folder_create_fail", null, `${acct.email} ${name} ${e?.message}`); } }
  for (const [role, folder] of Object.entries(roles)) if (folder) await db.prepare("INSERT INTO imap_folders (account, folder, role) VALUES (?, ?, ?) ON CONFLICT(account, folder) DO UPDATE SET role = excluded.role").bind(acct.email, folder, role).run();
  return roles;
}
const hdrOf = (raw, name) => { const head = decU.decode(raw.subarray(0, Math.min(raw.length, 65536))); const m = head.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im")); return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : ""; };
async function imapRecomputeThread(db, threadId) {
  const r = await db.prepare("SELECT SUM(CASE WHEN imap_flags NOT LIKE '%\\Seen%' AND direction = 'in' THEN 1 ELSE 0 END) unseen, SUM(CASE WHEN imap_flags LIKE '%\\Flagged%' THEN 1 ELSE 0 END) flagged FROM messages WHERE thread_id = ? AND imap_account IS NOT NULL").bind(threadId).first();
  await db.prepare("UPDATE threads SET unread = ?, starred = ? WHERE id = ?").bind(r?.unseen ? 1 : 0, r?.flagged ? 1 : 0, threadId).run();
}
// The server's INTERNALDATE ("19-Sep-2024 10:33:57 -0600", a single-digit day padded with a space) as ISO, or null.
const imapDateIso = (v) => { if (!v) return null; const d = new Date(String(v).trim()); return isNaN(d) ? null : d.toISOString(); };
const IMAP_BODY_MAX = 25 * 1024 * 1024;     // larger mail is kept as its headers (Cloudflare refuses inbound mail over 25 MiB as well)
const IMAP_LITERAL_MAX = 40 * 1024 * 1024;  // what readBytes will ever hold: past this a server's announced size is refused outright
// A message too large to download, stored as its own headers with a body line saying so: in the list, findable, and opened in the mailbox.
function imapHeadersOnly(rec) {
  if (!rec.header) return rec;
  // Its own Content-Type (a multipart's boundary) would describe a body that is not there: the headers say plain text instead.
  const head = new TextDecoder().decode(rec.header).replace(/^(?:content-type|content-transfer-encoding|mime-version):[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n/gim, "").replace(/(?:\r?\n)+$/, "\r\n");
  const raw = new TextEncoder().encode(`${head}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis message is ${Math.round((rec.size || 0) / 1048576)} MB, too large for the hub to download. Read it in the work mailbox.\r\n`);
  return { ...rec, raw, headersOnly: true };
}
async function imapStoreFetched(env, acct, folder, info, rec, trashRules = null, direction = "in") {
  const db = env.DB; if (!rec.raw || !rec.uid) return "nobody";
  const flags = JSON.stringify(rec.flags || []);
  const msgId = (hdrOf(rec.raw, "Message-ID") || "").trim();
  const internalIso = imapDateIso(rec.internalDate);
  // Already stored (an earlier run, or a run cut off part-way): link it to this UID, and give it the server's date if it was stored
  // with the time of the sync instead. That is what put a September 2024 message at the top of the inbox as "today": a
  // run was cut off between creating the row and dating it, and this path never dated it.
  const adopt = async (dup) => {
    const redate = internalIso && (dup.ingest_source === "imap" || dup.ingest_source === "imap-sent") && Math.abs(Date.parse(dup.created_at) - Date.parse(internalIso)) > 60_000;
    await db.prepare(`UPDATE messages SET imap_account = ?, imap_folder = ?, imap_uidvalidity = ?, imap_uid = ?, imap_flags = ?${redate ? ", created_at = ?" : ""} WHERE id = ?`).bind(...[acct.email, folder, info.uidvalidity, rec.uid, flags, ...(redate ? [internalIso] : []), dup.id]).run();
    if (redate) await db.prepare("UPDATE threads SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE thread_id = ?) WHERE id = ?").bind(dup.thread_id, dup.thread_id).run();
    await imapRecomputeThread(db, dup.thread_id); return "dup";
  };
  // By Message-ID, or by the server's own address for it (account, folder, UIDVALIDITY, UID): mail without a Message-ID used to be
  // stored again whenever a batch was repeated: a run cut off mid-batch, or two runs after a lost lease.
  // Matched in its own direction: a mail the user sent himself is in the Inbox AND in Sent, and each folder's copy
  // keeps its own row, as domain mail does, instead of one row pointed back and forth between the two folders.
  const findDup = async () => (msgId ? await db.prepare("SELECT id, thread_id, created_at, ingest_source FROM messages WHERE message_id = ? AND identity = ? AND direction = ? LIMIT 1").bind(msgId, acct.email, direction).first() : null)
    || await db.prepare("SELECT id, thread_id, created_at, ingest_source FROM messages WHERE imap_account = ? AND imap_folder = ? AND imap_uidvalidity = ? AND imap_uid = ? LIMIT 1").bind(acct.email, folder, info.uidvalidity, rec.uid).first();
  { const dup = await findDup(); if (dup) return adopt(dup); }
  const from = hdrOf(rec.raw, "From");
  // A mail whose ingest is killed for CPU runs no catch: the batch never saves its progress, the next run fetches the same mail and is
  // killed again, every minute, with every later work mail behind it. So the UID about to be read is written down
  // first, and the third run in a row to find it there stores the bytes without reading them (headers only, like an oversize mail).
  const tryKey = `imaptry:${acct.email}:${folder}`; let tries = 1;
  try {
    const t = await db.prepare("SELECT value FROM prefs WHERE key = ?").bind(tryKey).first(); const v = t ? JSON.parse(t.value) : null;
    if (v && v.uid === rec.uid && v.v === info.uidvalidity) tries = (v.n || 0) + 1;
    await db.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(tryKey, JSON.stringify({ uid: rec.uid, v: info.uidvalidity, n: tries }), now()).run();
  } catch (_) {}
  if (tries >= 3) await logEvent(db, "imap_store_only_retry", null, `${acct.email} ${folder} uid ${rec.uid}: tried ${tries - 1} times`);
  let r;
  // Stored WITH its date: the row is born dated, so no later step can be cut off before dating it.
  try { r = await ingestRaw(env, rec.raw, { rcpt: acct.email, envFrom: addrOnly(from), source: direction === "out" ? "imap-sent" : "imap", direction, gmailCopy: "imap", trashRules: direction === "out" ? null : trashRules, mentionRules: direction === "out" ? null : trashRules?.mention || null, storeOnly: rec.raw.byteLength > INBOUND_PARSE_MAX || tries >= 3, at: internalIso || undefined, dateHdr: hdrOf(rec.raw, "Date") || rec.internalDate, msgIdHdr: msgId, inReplyToHdr: hdrOf(rec.raw, "In-Reply-To"), refsHdr: hdrOf(rec.raw, "References"), subjectHdr: hdrOf(rec.raw, "Subject") }); }
  catch (e) {
    // Stored a moment ago by someone else (the lease makes this rare): that is a duplicate, not a reason to abort the whole run.
    const dup = /UNIQUE constraint failed: messages\.message_id/i.test(String(e?.message || "")) ? await findDup() : null;
    if (dup) { await logEvent(db, "imap_dup_race", null, `${acct.email} uid ${rec.uid}`); return adopt(dup); }
    throw e;
  }
  await db.prepare("UPDATE messages SET imap_account = ?, imap_folder = ?, imap_uidvalidity = ?, imap_uid = ?, imap_flags = ?, created_at = COALESCE(?, created_at) WHERE id = ?").bind(acct.email, folder, info.uidvalidity, rec.uid, flags, internalIso, r.id).run();
  await db.prepare("UPDATE threads SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE thread_id = ?) WHERE id = ?").bind(r.threadId, r.threadId).run();
  await imapRecomputeThread(db, r.threadId);
  // Matched one of my trash rules: stored in Trash on a conversation of its own, moved to the server's Trash
  // through the write-back queue, and never announced.
  if (r.trashRule) { await imapQueueForThread(env, r.threadId, { state: "trash" }); await trashHit(db, r.trashRule, `${acct.email} <- ${addrOnly(from)}`, r.id); return "trashed"; }
  if (r.mentionDrop) { await imapQueueForThread(env, r.threadId, { state: "trash" }); return "trashed"; }
  rec.stored = { id: r.id, thread: r.threadId };
  return "new";
}
// One sync of a mailbox at a time. The lease is taken before any connection, renewed after every saved batch, released at the end,
// and simply expires if a run is cut off mid-way (a Worker can be stopped at any await), so the next run picks up from the last batch.
const IMAP_LEASE_MS = 120_000;
// Sign-in backoff (migration 0033). A mailbox that refuses the password was tried every minute by the sync, again by
// the write-back queue, and once per conversation by a bulk action: 202 refused sign-ins were logged in October 2026, and mail hosts
// lock accounts out for that. After a refusal the next try waits 5, 10, 20, 40, then 60 minutes; a good sign-in or a new password
// clears it. A send the user asks for still tries at once: that is one sign-in, and its error reaches them.
const IMAP_BACKOFF_MIN = [5, 10, 20, 40, 60];
async function imapSignin(db, email) { try { return await db.prepare("SELECT auth_failures, auth_retry_at, last_error FROM imap_folders WHERE account = ? AND folder = 'INBOX'").bind(lc(email)).first(); } catch (_) { return null; } }
async function imapSigninWaiting(db, email) { const st = await imapSignin(db, email); return st?.auth_retry_at && st.auth_retry_at > Date.now() ? st : null; }
async function imapSigninRefused(db, email, e) {
  const n = (await imapSignin(db, email))?.auth_failures || 0;
  const retry = Date.now() + IMAP_BACKOFF_MIN[Math.min(n, IMAP_BACKOFF_MIN.length - 1)] * 60_000;
  try { await db.prepare("INSERT INTO imap_folders (account, folder, role, auth_failures, auth_retry_at, last_error) VALUES (?, 'INBOX', 'inbox', 1, ?, ?) ON CONFLICT(account, folder) DO UPDATE SET auth_failures = auth_failures + 1, auth_retry_at = excluded.auth_retry_at, last_error = excluded.last_error").bind(lc(email), retry, String(e?.message || e).slice(0, 300)).run(); } catch (_) {}
}
async function imapSigninOk(db, email) { try { await db.prepare("UPDATE imap_folders SET auth_failures = 0, auth_retry_at = NULL WHERE account = ? AND folder = 'INBOX' AND (auth_failures > 0 OR auth_retry_at IS NOT NULL)").bind(lc(email)).run(); } catch (_) {} }
// Logs in, and records the outcome for the backoff. A refusal is marked `signin` so callers can tell it from a dropped connection.
async function imapLogin(db, c, acct) {
  try { await c.login(acct.user, acct.password); }
  catch (e) { e.signin = true; await imapSigninRefused(db, acct.email, e); throw e; }
  await imapSigninOk(db, acct.email);
}
async function imapSyncAccount(env, acct, opts = {}) {
  const db = env.DB;
  if (!acct.ready) return { account: acct.email, skipped: `secret ${acct.secret} not set` };
  const waiting = await imapSigninWaiting(db, acct.email);
  if (waiting) return { account: acct.email, skipped: `sign-in refused; next try at ${new Date(waiting.auth_retry_at).toISOString()}` };
  const token = uuid();
  await db.prepare("INSERT INTO imap_folders (account, folder, role) VALUES (?, 'INBOX', 'inbox') ON CONFLICT(account, folder) DO NOTHING").bind(acct.email).run();
  const got = await db.prepare("UPDATE imap_folders SET sync_until = ?, sync_token = ? WHERE account = ? AND folder = 'INBOX' AND (sync_until IS NULL OR sync_until < ?)").bind(Date.now() + IMAP_LEASE_MS, token, acct.email, Date.now()).run();
  if (!got.meta?.changes) return { account: acct.email, skipped: "another sync of this mailbox is running" };
  try { return await imapSyncAccountLeased(env, acct, opts, token); }
  finally { try { await db.prepare("UPDATE imap_folders SET sync_until = NULL, sync_token = NULL WHERE account = ? AND folder = 'INBOX' AND sync_token = ?").bind(acct.email, token).run(); } catch (_) {} }
}
async function imapSyncAccountLeased(env, acct, { backfill = 0, sweep = false, initialWindow = 100 } = {}, token) {
  const db = env.DB;
  acct = { ...acct, password: await imapPassword(env, acct) };   // unlocked BEFORE any connection: a row that fails to unlock never reaches a server
  const started = Date.now(); const c = new ImapClient(acct.host, acct.port);
  // A connection that cannot be made left no trace at all (no event, no last_error), so "unreachable" looked like silence. It is
  // recorded where Settings reads it, without an event a minute.
  try { await c.connect(); } catch (e) { try { await db.prepare("INSERT INTO imap_folders (account, folder, role, last_error) VALUES (?, 'INBOX', 'inbox', ?) ON CONFLICT(account, folder) DO UPDATE SET last_error = excluded.last_error").bind(acct.email, `cannot connect: ${String(e?.message || e).slice(0, 280)}`).run(); } catch (_) {} throw e; }
  const out = { account: acct.email, folder: "INBOX", fetched: 0, dup: 0, backfilled: 0, flagsChanged: 0, removed: 0, items: [] };
  try {
    await imapLogin(db, c, acct);
    const roles = await imapFolderRoles(db, c, acct);
    const folder = "INBOX";
    const st = await db.prepare("SELECT * FROM imap_folders WHERE account = ? AND folder = ?").bind(acct.email, folder).first();
    const info = await c.select(folder);
    let highwater = st?.highwater || 0, lowwater = st?.lowwater || null;
    if (st?.uidvalidity && info.uidvalidity !== st.uidvalidity) { await logEvent(db, "imap_uidvalidity_changed", null, `${acct.email} ${folder} ${st.uidvalidity} → ${info.uidvalidity}: full resync keyed on Message-ID`); highwater = 0; lowwater = null; }
    // Progress is saved after every batch (it used to be saved only at the end, so a run cut off part-way saved nothing and the next
    // started over), and the lease renewed with it. Only mail that arrived in the last day is announced: a first sync stores up to
    // 100 messages that are months or years old, and none of them is news.
    out.recent = 0;
    const trashRules = folder === "INBOX" ? trashRulesLoader(db) : null;   // new arrivals only: a backfill of old mail is never moved
    if (trashRules) trashRules.mention = mentionRulesLoader(db);   // "Delete unless it mentions…" rides with it, on the same arrivals
    // A run that no longer holds the lease (a batch that outlasted IMAP_LEASE_MS, and another run took over) stops at once instead of
    // storing alongside the new one: the renewal is checked, not assumed.
    const saveProgress = async () => { const r = await db.prepare("UPDATE imap_folders SET uidvalidity = ?, highwater = ?, lowwater = ?, sync_until = ? WHERE account = ? AND folder = ? AND sync_token = ?").bind(info.uidvalidity, highwater, lowwater, Date.now() + IMAP_LEASE_MS, acct.email, folder, token).run(); if (!r.meta?.changes) throw new Error("imap sync lost its lease"); };
    // Sizes first, in one command: a message's size and its body used to arrive in
    // the same answer, so a huge one was read whole into the Worker's 128 MB before anything could look at its size, on every run, and
    // the mailbox stalled at that UID. Mail over IMAP_BODY_MAX is kept as its headers and a line saying where to read it.
    const fetchSet = async (uids, dir = "forward") => { const sizes = new Map(); for (let j = 0; j < uids.length; j += 200) for (const z of await c.uidFetch(uids.slice(j, j + 200).join(","), "UID RFC822.SIZE")) if (z.uid) sizes.set(z.uid, z.size || 0);
      for (let i = 0; i < uids.length; i += 4) { const batch = uids.slice(i, i + 4); const big = batch.filter((u) => (sizes.get(u) || 0) > IMAP_BODY_MAX), small = batch.filter((u) => !big.includes(u));
      const recs = [...(small.length ? await c.uidFetch(small.join(","), "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]") : []), ...(big.length ? (await c.uidFetch(big.join(","), "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER]")).map(imapHeadersOnly) : [])].sort((x, y) => batch.indexOf(x.uid) - batch.indexOf(y.uid)); for (const rec of recs) { const k = await imapStoreFetched(env, acct, folder, info, rec, dir === "forward" ? trashRules : null); if (k === "trashed") { out.fetched++; out.trashed = (out.trashed || 0) + 1; } else if (k === "new") { out.fetched++; const t = Date.parse(imapDateIso(rec.internalDate) || ""); const fresh = !(t < Date.now() - 86400e3); if (fresh) { out.recent++; if (rec.stored && out.items.length < 8) out.items.push(rec.stored); } } else if (k === "dup") out.dup++; }
      if (dir === "forward") highwater = Math.max(highwater, ...batch); lowwater = lowwater == null ? Math.min(...batch) : Math.min(lowwater, ...batch); await saveProgress(); } };
    if (info.exists > 0 && (info.uidnext == null || info.uidnext > highwater + 1)) {
      const uids = (await c.uidSearch(`UID ${highwater + 1}:*`)).filter((u) => u > highwater).sort((a, b) => a - b);
      const todo = highwater === 0 ? uids.slice(-initialWindow) : uids.slice(0, 200);
      if (todo.length) { await fetchSet(todo); highwater = Math.max(highwater, ...todo); lowwater = lowwater == null ? Math.min(...todo) : Math.min(lowwater, ...todo); }
    }
    if (backfill > 0 && lowwater && lowwater > 1) {
      const older = (await c.uidSearch(`UID 1:${lowwater - 1}`)).sort((a, b) => b - a).slice(0, backfill);
      if (older.length) { await fetchSet(older, "back"); out.backfilled = older.length; lowwater = Math.min(lowwater, ...older); }
    }
    const inflight = (await db.prepare("SELECT COUNT(*) n FROM imap_ops WHERE account = ? AND status = 'pending'").bind(acct.email).first())?.n || 0;
    const sweepDue = !inflight && (sweep || !st?.last_sweep_at || (Date.now() - Date.parse(st.last_sweep_at)) > 5 * 60_000 || (st?.exists_count != null && st.exists_count !== info.exists));
    if (sweepDue) {
      const { results: known } = await db.prepare("SELECT id, thread_id, imap_uid, imap_flags, created_at, ingest_source FROM messages WHERE imap_account = ? AND imap_folder = ? AND imap_uidvalidity = ?").bind(acct.email, folder, info.uidvalidity).all();
      if (known.length) {
        const server = new Map(), dated = new Map(); if (info.exists > 0) for (const r of await c.uidFetch("1:*", "UID FLAGS INTERNALDATE")) { server.set(r.uid, JSON.stringify(r.flags || [])); dated.set(r.uid, imapDateIso(r.internalDate)); }
        const touched = new Set(), redated = new Set();
        // A message stored with the time of the sync instead of its own date is put back where it belongs (the server's date).
        for (const m of known) { const d = dated.get(m.imap_uid); if (d && m.ingest_source === "imap" && Math.abs(Date.parse(m.created_at) - Date.parse(d)) > 60_000) { await db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").bind(d, m.id).run(); redated.add(m.thread_id); out.redated = (out.redated || 0) + 1; } }
        for (const th of redated) await db.prepare("UPDATE threads SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE thread_id = ?) WHERE id = ?").bind(th, th).run();
        for (const m of known) {
          const sf = server.get(m.imap_uid);
          if (sf === undefined) { await db.prepare("UPDATE messages SET imap_folder = NULL, imap_uid = NULL, labels = ? WHERE id = ?").bind(addLabel(null, "removed-on-server"), m.id).run(); const live = await db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id = ? AND direction = 'in' AND (imap_account IS NULL OR imap_folder IS NOT NULL)").bind(m.thread_id).first(); if (!live?.n) await db.prepare("UPDATE threads SET state = 'archived', labels = ? WHERE id = ? AND state IN ('inbox','snoozed')").bind(addLabel((await db.prepare("SELECT labels FROM threads WHERE id = ?").bind(m.thread_id).first())?.labels, "removed-on-server"), m.thread_id).run(); out.removed++; touched.add(m.thread_id); }
          else if (sf !== m.imap_flags) { await db.prepare("UPDATE messages SET imap_flags = ? WHERE id = ?").bind(sf, m.id).run(); out.flagsChanged++; touched.add(m.thread_id); }
        }
        for (const th of touched) await imapRecomputeThread(db, th);
      }
    }
    if ((await db.prepare("SELECT sync_token FROM imap_folders WHERE account = ? AND folder = ?").bind(acct.email, folder).first())?.sync_token !== token) throw new Error("imap sync lost its lease");
    await db.prepare("INSERT INTO imap_folders (account, folder, role, uidvalidity, uidnext, highwater, lowwater, exists_count, last_sync_at, last_sweep_at, last_error) VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(account, folder) DO UPDATE SET uidvalidity = excluded.uidvalidity, uidnext = excluded.uidnext, highwater = excluded.highwater, lowwater = excluded.lowwater, exists_count = excluded.exists_count, last_sync_at = excluded.last_sync_at, last_sweep_at = CASE WHEN ? THEN excluded.last_sweep_at ELSE imap_folders.last_sweep_at END, last_error = NULL").bind(acct.email, folder, info.uidvalidity, info.uidnext, highwater, lowwater, info.exists, now(), now(), sweepDue ? 1 : 0).run();
    // The Sent folder, on the same connection and under the same lease, once the Inbox's run is saved: a failure
    // here is recorded on the Sent folder's own row and never costs the Inbox its run. Only a lost lease stops the run.
    if (roles.sent) { try { out.sent = await imapSyncSent(env, c, acct, roles.sent, token); } catch (e) { out.sent = { error: e?.message }; try { await db.prepare("UPDATE imap_folders SET last_error = ? WHERE account = ? AND folder = ?").bind(String(e?.message || e).slice(0, 300), acct.email, roles.sent).run(); } catch (_) {} if (/lost its lease/.test(String(e?.message))) throw e; } }
    out.ms = Date.now() - started; out.caps = [...c.caps].filter((x) => ["MOVE", "UIDPLUS", "CONDSTORE", "IDLE", "SPECIAL-USE"].includes(x));
    if (out.fetched || out.backfilled || out.removed || out.flagsChanged) { await logEvent(db, "imap_sync", null, `${acct.email} new=${out.fetched} dup=${out.dup} backfill=${out.backfilled} flags=${out.flagsChanged} removed=${out.removed} ${out.ms}ms`); if (out.recent) { const preview = await notifyPreview(env); const items = []; for (const it of out.items) { const mm = await db.prepare("SELECT from_addr, from_name, subject, snippet, thread_id FROM messages WHERE id = ?").bind(it.id).first(); if (mm) items.push({ thread: mm.thread_id, from: mm.from_name ? `${mm.from_name} <${mm.from_addr}>` : mm.from_addr, subject: mm.subject, snippet: mm.snippet, addr: mm.from_addr }); }
      const quiet = await quietRules(env), kept = [];
      for (const it of items) { const q = quietMatch(quiet, it.addr, it.subject); if (q) await quietHit(env, q, `imap ${acct.email} ${it.addr}`); else kept.push(it); }
      const recent = out.recent - (items.length - kept.length); items.length = 0; for (const { addr, ...it } of kept) items.push(it);
      if (recent <= 0) {} else if (recent <= 4 && items.length === recent) { for (const it of items) await sendPush(env, mailPush(preview, { kind: "imap", account: "hub", label: acct.email, ...it })); } else await sendPush(env, mailPushSummary(preview, { kind: "imap", account: "hub", label: acct.email, items, count: recent }), { keys: items.filter((it) => it.thread).map((it) => `hub|${it.thread}`) }); } }
    return out;
  } catch (e) {
    await db.prepare("INSERT INTO imap_folders (account, folder, role, last_error) VALUES (?, 'INBOX', 'inbox', ?) ON CONFLICT(account, folder) DO UPDATE SET last_error = excluded.last_error").bind(acct.email, String(e?.message || e).slice(0, 300)).run();
    await logEvent(db, "imap_sync_fail", null, `${acct.email} ${e?.message}`);
    throw e;
  } finally { await c.logout(); }
}
// The work mailbox's Sent folder. Only the Inbox was ever read, so mail the user sent from the work address in
// Outlook, on his phone or in the webmail never reached the hub, and Sent under the work account was empty (0 sent messages stored
// against 311 received). Each run reads what is new in Sent, newest first on the first run; once nothing new is waiting,
// it reads older mail, a little each run, until the folder is in. A sent copy is stored as my own mail (ingestRaw's
// direction "out"): it joins its conversation by its In-Reply-To and References, a conversation it starts is born archived, and it
// is never announced, never trashed by a rule and never moves anything to the inbox. Progress is saved after every batch, under the
// Inbox's lease, as the Inbox's is.
const IMAP_SENT_FIRST = 50, IMAP_SENT_BACK = 20;
async function imapSyncSent(env, c, acct, folder, token) {
  const db = env.DB; const r = { folder, fetched: 0, dup: 0, backfilled: 0 };
  const st = await db.prepare("SELECT uidvalidity, highwater, lowwater FROM imap_folders WHERE account = ? AND folder = ?").bind(acct.email, folder).first();
  const info = await c.select(folder);
  let highwater = st?.highwater || 0, lowwater = st?.lowwater ?? null;
  if (st?.uidvalidity && info.uidvalidity !== st.uidvalidity) { await logEvent(db, "imap_uidvalidity_changed", null, `${acct.email} ${folder} ${st.uidvalidity} → ${info.uidvalidity}: Sent read again, keyed on Message-ID`); highwater = 0; lowwater = null; }
  const save = async () => {
    const held = await db.prepare("UPDATE imap_folders SET sync_until = ? WHERE account = ? AND folder = 'INBOX' AND sync_token = ?").bind(Date.now() + IMAP_LEASE_MS, acct.email, token).run();
    if (!held.meta?.changes) throw new Error("imap sync lost its lease");
    await db.prepare("INSERT INTO imap_folders (account, folder, role, uidvalidity, uidnext, highwater, lowwater, exists_count, last_sync_at, last_error) VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(account, folder) DO UPDATE SET role = 'sent', uidvalidity = excluded.uidvalidity, uidnext = excluded.uidnext, highwater = excluded.highwater, lowwater = excluded.lowwater, exists_count = excluded.exists_count, last_sync_at = excluded.last_sync_at, last_error = NULL")
      .bind(acct.email, folder, info.uidvalidity, info.uidnext ?? null, highwater, lowwater, info.exists ?? null, now()).run();
  };
  const fetchSet = async (uids, dir) => {
    const sizes = new Map(); for (let j = 0; j < uids.length; j += 200) for (const z of await c.uidFetch(uids.slice(j, j + 200).join(","), "UID RFC822.SIZE")) if (z.uid) sizes.set(z.uid, z.size || 0);
    for (let i = 0; i < uids.length; i += 4) {
      const batch = uids.slice(i, i + 4); const big = batch.filter((u) => (sizes.get(u) || 0) > IMAP_BODY_MAX), small = batch.filter((u) => !big.includes(u));
      const recs = [...(small.length ? await c.uidFetch(small.join(","), "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]") : []), ...(big.length ? (await c.uidFetch(big.join(","), "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER]")).map(imapHeadersOnly) : [])];
      for (const rec of recs) { const k = await imapStoreFetched(env, acct, folder, info, rec, null, "out"); if (k === "new") { if (dir === "back") r.backfilled++; else r.fetched++; } else if (k === "dup") r.dup++; }
      if (dir === "forward") highwater = Math.max(highwater, ...batch); lowwater = lowwater == null ? Math.min(...batch) : Math.min(lowwater, ...batch); await save();
    }
  };
  let forward = 0;
  if (info.exists > 0 && (info.uidnext == null || info.uidnext > highwater + 1)) {
    const uids = (await c.uidSearch(`UID ${highwater + 1}:*`)).filter((u) => u > highwater).sort((a, b) => a - b);
    const todo = highwater === 0 ? uids.slice(-IMAP_SENT_FIRST) : uids.slice(0, 200);
    forward = todo.length; if (todo.length) await fetchSet(todo, "forward");
  }
  // Older mail only on a run with nothing new: what was just sent comes first. lowwater 1 means the whole folder is in.
  if (!forward && info.exists > 0 && lowwater != null && lowwater > 1) {
    const older = (await c.uidSearch(`UID 1:${lowwater - 1}`)).filter((u) => u < lowwater).sort((a, b) => b - a).slice(0, IMAP_SENT_BACK);
    if (older.length) await fetchSet(older, "back"); else lowwater = 1;
  }
  await save();
  if (r.fetched || r.backfilled) await logEvent(db, "imap_sync_sent", null, `${acct.email} ${folder} new=${r.fetched} older=${r.backfilled} dup=${r.dup} uid ${lowwater ?? "-"}..${highwater} of ${info.exists}`);
  return r;
}
async function imapSyncAll(env, opts = {}) { const out = []; for (const a of await imapAccounts(env, { fresh: true })) { try { out.push(await imapSyncAccount(env, a, opts)); } catch (e) { out.push({ account: a.email, error: e?.message }); } } return out; }
// Write-back queue: hub actions on IMAP-backed threads become server operations (flags, moves), executed at once and retried by the cron.
async function imapQueueForThread(env, threadId, patch) {
  const db = env.DB;
  // Received messages only: Done, Trash, Snooze and Restore move a work conversation's mail between the Inbox and
  // its folders, and the user's sent copies stay in the server's Sent folder whatever he does with the conversation.
  const { results } = await db.prepare("SELECT id, imap_account FROM messages WHERE thread_id = ? AND imap_account IS NOT NULL AND direction = 'in'").bind(threadId).all();
  if (!results.length) return 0;
  // A mailbox with no password configured cannot be written to, ever: queueing an op for it only creates a row that retries
  // until someone notices. On the client that permanently non-empty queue is what stopped the installed app from updating itself
  // for a whole day. Not connected is not a temporary failure; it is "there is nothing to talk to yet".
  // A mailbox with no password cannot be written to, so queueing a PENDING op for it only creates a row that retries until
  // someone notices: that permanently non-empty queue is what stopped the installed app updating itself for a day. But simply
  // dropping the op throws the user's action away: the hub write
  // succeeds, the mailbox never learns, and when the password is finally set the two have diverged with nothing to reconcile.
  // So the op is still written, with status 'deferred'. runImapOps only ever selects 'pending', so nothing retries; and the
  // moment the account has a password those rows are promoted back to pending and delivered in order. Nothing is lost.
  const live = new Set((await imapAccounts(env)).filter((a) => a.ready).map((a) => lc(a.email)));
  const deferred = results.filter((m) => !live.has(lc(m.imap_account || "")));
  const usable = results.filter((m) => live.has(lc(m.imap_account || "")));
  const ops = [];
  if (patch.state === "archived") ops.push("archive"); if (patch.state === "trash") ops.push("trash"); if (patch.state === "inbox") ops.push("restore"); if (patch.state === "snoozed") ops.push("snooze");
  if (patch.unread !== undefined) ops.push(patch.unread ? "unseen" : "seen"); if (patch.starred !== undefined) ops.push(patch.starred ? "flag" : "unflag");
  for (const m of usable) for (const op of ops) await db.prepare("INSERT INTO imap_ops (id, account, message_id, op, created_at) VALUES (?, ?, ?, ?, ?)").bind(uuid(), m.imap_account, m.id, op, now()).run();
  for (const m of deferred) for (const op of ops) await db.prepare("INSERT INTO imap_ops (id, account, message_id, op, status, created_at) VALUES (?, ?, ?, ?, 'deferred', ?)").bind(uuid(), m.imap_account, m.id, op, now()).run();
  if (deferred.length) await logEvent(db, "imap_deferred", null, `${deferred.length * ops.length} op(s) parked for ${[...new Set(deferred.map((m) => m.imap_account))].join(", ")} until it has a password`);
  if (ops.length && usable.length) ctxWaitUntil(runImapOps(env, usable[0].imap_account));   // `usable` may be empty: everything was deferred
  return ops.length * usable.length;
}
async function runImapOps(env, onlyAccount = null) {
  const db = env.DB;
  const accts = await imapAccounts(env);   // cached per isolate (60 s): no D1 read a minute just to learn there is no mailbox
  if (!accts.some((a) => a.ready)) return 0;
  // Anything parked while this mailbox had no password is delivered now that it does, oldest first. This is the other half of the
  // deferral: without it, deferring would be the same silent loss as dropping.
  // Releasing parked work is not just flipping a status. An op parked while the
  // mailbox was unreachable is a command recorded at a moment that has since passed, and replaying it blind can REVERSE something
  // the user did afterwards: archive, then restore, then the password arrives, and the archive lands last.
  // It independently. So the parked rows are collapsed to the LAST intent per message before
  // any of them run: within each family of mutually-exclusive ops, only the newest survives and the rest are dropped as superseded.
  // Families are sets of MUTUALLY EXCLUSIVE intents. `snooze` was pulled into its own family in round four on the worry that
  // collapsing it might drop a scheduled un-snooze: a worry that was never sourced, and was wrong. In THIS table a snooze is
  // literally `await move(roles.snoozed || roles.archive)`: a folder move, nothing more. The scheduled RETURN lives in
  // `scheduled_actions`, a different table and subsystem, untouched by anything here.
  // Separating it created exactly the defect five lanes then reported: a snooze and an archive both
  // surviving the collapse and both applying, in whichever order. Back where it belongs: the newest placement wins, which is the
  // user's last expressed intent about where the message should sit.
  const FAMILY = { seen: "read", unseen: "read", flag: "star", unflag: "star", trash: "place", archive: "place", restore: "place", snooze: "place" };
  for (const a of accts.filter((x) => x.ready)) {
    if (onlyAccount && lc(a.email) !== lc(onlyAccount)) continue;   // promote only what this run will actually execute
    const { results: parked } = await db.prepare("SELECT id, message_id, op, created_at FROM imap_ops WHERE status = 'deferred' AND account = ? ORDER BY created_at").bind(a.email).all();
    if (!parked.length) continue;
    const winner = new Map();                                        // message_id + family -> the newest parked op for it
    for (const r of parked) winner.set(`${r.message_id}|${FAMILY[r.op] || r.op}`, r.id);
    const keep = new Set(winner.values());
    const superseded = parked.filter((r) => !keep.has(r.id)).map((r) => r.id);
    for (let i = 0; i < superseded.length; i += 20) {
      const chunk = superseded.slice(i, i + 20);
      await db.prepare(`UPDATE imap_ops SET status = 'superseded', done_at = ? WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(now(), ...chunk).run();
    }
    const promoted = await db.prepare("UPDATE imap_ops SET status = 'pending' WHERE status = 'deferred' AND account = ?").bind(a.email).run();
    if (promoted.meta?.changes) await logEvent(db, "imap_undeferred", null, `${promoted.meta.changes} parked op(s) released for ${a.email}${superseded.length ? `, ${superseded.length} superseded by a later action` : ""}`);
  }
  // Parked work for a mailbox that has since been REMOVED from IMAP_ACCOUNTS can never be delivered by anyone. Leaving it as
  // 'deferred' was a quiet pile that grew for ever. It is retired explicitly
  // and counted, so the divergence is on the record rather than in the table.
  // Once an hour, not once a minute: the dwell it enforces is measured in days.
  if (new Date().getUTCMinutes() === 0) {
    const parsed = await imapAccounts(env, { fresh: true });
    const known = parsed.map((a) => lc(a.email)).filter((e) => e && e.includes("@"));
    // "Empty OR MISPARSED" was the original finding, and the first fix only handled empty. A config that parses to junk (entries
    // with no usable address) is indistinguishable from a real list by `known.length` alone, and would have retired real
    // accounts' work. So entries must look like addresses, and if ANY entry fails to, nothing is swept:
    // a malformed config is a reason to do nothing, never a reason to retire work.
    const sane = parsed.length > 0 && parsed.every((a) => a.email && String(a.email).includes("@")) && known.length === parsed.length;
    if (sane) {
      const ph = known.map(() => "?").join(",");
      // THE DWELL IS MEASURED FROM WHEN THE ACCOUNT WENT MISSING, not from when the op was created. The previous version used
      // created_at, so an op written eight days ago for a mailbox removed an hour ago was retired within that hour, while the
      // audit log claimed the mailbox had been absent "for over 7 days".
      // This table records the first time each account was seen missing.
      // CLEARED FIRST, and keyed on the lowercased address. The old order inserted before clearing, and the INSERT stored the raw
      // account value while the DELETE matched lower(account): a case mismatch left a row nothing could ever clear.
      const ph2 = known.map(() => "?").join(",");
      await db.prepare(`DELETE FROM imap_account_absent WHERE account IN (${ph2})`).bind(...known).run();

      const { results: acctRows } = await db.prepare("SELECT DISTINCT account FROM imap_ops WHERE status IN ('deferred','pending','orphaned')").all();
      const missing = [...new Set(acctRows.map((r) => lc(String(r.account || ""))).filter((a) => a && !known.includes(a)))];
      for (const a of missing) {
        await db.prepare("INSERT INTO imap_account_absent (account, first_missing_at, last_confirmed_at) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET last_confirmed_at = excluded.last_confirmed_at").bind(a, now(), now()).run();
      }

      // Retirement needs BOTH: absent a long time, AND confirmed missing recently. An absence nobody has been watching (because
      // the config was malformed, or the Worker was not running) must not mature in the dark and retire work on the next glance.
      const dwell = new Date(Date.now() - 7 * 864e5).toISOString();
      const fresh = new Date(Date.now() - 2 * 3600e3).toISOString();
      const { results: ripe } = await db.prepare("SELECT account, first_missing_at FROM imap_account_absent WHERE first_missing_at < ? AND last_confirmed_at > ?").bind(dwell, fresh).all();
      for (const r of ripe) {
        const orphaned = await db.prepare("UPDATE imap_ops SET status = 'orphaned' WHERE status IN ('deferred','pending') AND lower(account) = ?").bind(lc(r.account)).run();
        if (orphaned.meta?.changes) await logEvent(db, "imap_orphaned", null, `${orphaned.meta.changes} op(s) retired: ${r.account} absent since ${String(r.first_missing_at || "").slice(0, 16)}`);
      }
      const restored = await db.prepare(`UPDATE imap_ops SET status = 'deferred' WHERE status = 'orphaned' AND lower(account) IN (${ph})`).bind(...known).run();
      if (restored.meta?.changes) await logEvent(db, "imap_unorphaned", null, `${restored.meta.changes} retired op(s) reclaimed: their mailbox is configured again`);
    }
  }

  // A Worker interrupted mid-run leaves rows claimed. Unlike a SEND, every op here is an idempotent state set (mark seen, move to
  // a folder) so re-running one is safe and losing one is not; stranded claims go back to pending rather than being failed.
  { const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const back = await db.prepare("UPDATE imap_ops SET status = 'pending', claimed_at = NULL WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at < ?)").bind(cutoff).run();
    if (back.meta?.changes) await logEvent(db, "imap_ops_recovered", null, `${back.meta.changes} op(s) released from a stranded claim`); }
  const { results } = await db.prepare(`SELECT * FROM imap_ops WHERE status = 'pending' AND attempts < 6 ${onlyAccount ? "AND account = ?" : ""} ORDER BY created_at LIMIT 100`).bind(...(onlyAccount ? [onlyAccount] : [])).all();
  if (!results.length) return 0;
  const byAcct = new Map(); for (const r of results) { const g = byAcct.get(r.account) || []; g.push(r); byAcct.set(r.account, g); }
  let done = 0;
  for (const [email, ops] of byAcct) {
    const acct0 = accts.find((a) => a.email === lc(email)); if (!acct0?.ready) continue;
    if (await imapSigninWaiting(db, acct0.email)) continue;   // refused sign-in: the ops wait with the sync
    let acct; try { acct = { ...acct0, password: await imapPassword(env, acct0) }; } catch (e) { await logEvent(db, "imap_ops_fail", null, `${email}: ${e?.message}`); continue; }   // unlocked before connecting
    const c = new ImapClient(acct.host, acct.port);
    try {
      await c.connect(); await imapLogin(db, c, acct);
      const roles = await imapFolderRoles(db, c, acct);
      for (const op of ops) {
        // The claim is the whole point: `AND status = 'pending'` means exactly one invocation can take this row, so a second
        // cron running concurrently (proved to happen on 2026-09-11) finds nothing to do rather than applying it again.
        // The claim doubles as a FENCING TOKEN. Taking the row is not enough on its own: if this Worker then stalls past the
        // ten-minute release, a second Worker legitimately re-claims the op, and the first, waking up late, would otherwise
        // still write 'done' or bump attempts on a row it no longer owns, resurrecting a finished op or producing a false
        // "GAVE UP". Every terminal write below therefore carries
        // `AND claimed_at = ?` with the exact timestamp of THIS claim, so a stale owner's write changes nothing.
        const fence = uuid();   // a TOKEN, not a timestamp: now() has second resolution and two claims could share one
        const claimed = await db.prepare("UPDATE imap_ops SET status = 'running', claimed_at = ?, claim_token = ? WHERE id = ? AND status = 'pending'").bind(now(), fence, op.id).run();
        if (!(claimed.meta?.changes)) continue;
        try {
          const m = await db.prepare("SELECT id, message_id, imap_folder, imap_uid FROM messages WHERE id = ?").bind(op.message_id).first();
          if (!m) throw new Error("message row gone");
          let folder = m.imap_folder, uid = m.imap_uid;
          if (!uid) { // moved earlier and not re-mapped: find it by Message-ID in the likely folders
            // SEARCH HEADER is a substring match and the sender writes the Message-ID: one stored as "@" or "@bank.com" matched other
            // people's mail, and the newest hit was the one moved or trashed. Only a whole <…@…> id is looked for, and a
            // hit is acted on only when its own Message-ID is exactly that id.
            const want = String(m.message_id || "").trim();
            if (!/^<[^<>\s@]+@[^<>\s]+>$/.test(want)) throw new Error("message not found on server (no whole Message-ID to look for)");
            for (const f of [folder, roles.archive, roles.snoozed, roles.trash, "INBOX"].filter(Boolean)) {
              await c.select(f); const found = await c.uidSearch(`HEADER Message-ID ${imapQuote(want)}`); if (!found.length) continue;
              const recs = await c.uidFetch(found.slice(-50).join(","), "UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]");
              const exact = recs.filter((r) => r.uid && ((/<[^<>]+>/.exec((/^message-id:[ \t]*(.*)$/im.exec(String(r.headers || "").replace(/\r?\n[ \t]+/g, " ")) || [])[1] || "") || [])[0] || "") === want).map((r) => r.uid).sort((x, y) => x - y);
              if (exact.length) { folder = f; uid = exact[exact.length - 1]; break; }
            }
            if (!uid) throw new Error("message not found on server");
          }
          if (c.selected !== folder) await c.select(folder);
          // AT-LEAST-ONCE plus idempotence, because at-most-once is not achievable here: a Worker can apply the IMAP mutation
          // and die before writing 'done', the lease expires, and a new owner replays it. Fencing cannot close that, only the
          // op being safe to repeat can.
          // seen/unseen/flag/unflag are naturally idempotent: STORE sets a flag to a value rather than toggling it.
          // A MOVE is not, so it is made so: if the message is already in the target folder the move is a no-op that succeeds,
          // rather than a uidMove against a UID that is no longer there, which would have failed and counted toward 'failed'.
          const move = async (target) => {
            if (!target) throw new Error("target folder unknown");
            if (target === folder) return;
            // A replay must be safe, because at-most-once is not achievable: a Worker can issue the uidMove and die before writing
            // 'done'. The previous version asked "is it in the TARGET already?": wrong when a message legitimately exists in both
            // folders, since it would skip a move that was genuinely needed. The precise
            // question is whether THIS copy is still in the SOURCE: if the uid has gone, the move already happened; if it is still
            // there, do it. A transient search failure answers "still there", so the move is attempted rather than silently
            // skipped: erring toward doing the work, which is the safe direction for an op that is safe to repeat.
            let stillHere = true;
            try { if (c.selected !== folder) await c.select(folder); const f = await c.uidSearch(`UID ${uid}`); stillHere = !!(f && f.length); }
            catch (_) { stillHere = true; }
            if (!stillHere) { await db.prepare("UPDATE messages SET imap_folder = ?, imap_uid = NULL WHERE id = ?").bind(target, m.id).run(); return; }
            await c.uidMove(uid, target); await db.prepare("UPDATE messages SET imap_folder = ?, imap_uid = NULL WHERE id = ?").bind(target, m.id).run(); };
          if (op.op === "seen" || op.op === "unseen") { await c.uidStore(uid, op.op === "seen" ? "+" : "-", "\\Seen"); await db.prepare("UPDATE messages SET imap_flags = ? WHERE id = ?").bind(JSON.stringify(op.op === "seen" ? ["\\Seen"] : []), m.id).run(); }
          else if (op.op === "flag" || op.op === "unflag") await c.uidStore(uid, op.op === "flag" ? "+" : "-", "\\Flagged");
          else if (op.op === "trash") await move(roles.trash);
          else if (op.op === "archive") await move(roles.archive);
          else if (op.op === "snooze") await move(roles.snoozed || roles.archive);
          else if (op.op === "restore") await move("INBOX");
          const fin = await db.prepare("UPDATE imap_ops SET status = 'done', done_at = ? WHERE id = ? AND status = 'running' AND claim_token = ?").bind(now(), op.id, fence).run();
          if (fin.meta?.changes) done++; else await logEvent(db, "imap_ops_stale_write", null, `${op.id} finished after its claim expired; another run owns it`);
        } catch (e) {
          const miss = await db.prepare("UPDATE imap_ops SET attempts = attempts + 1, error = ?, claimed_at = NULL, claim_token = NULL, status = CASE WHEN attempts + 1 >= 6 THEN 'failed' ELSE 'pending' END WHERE id = ? AND status = 'running' AND claim_token = ?")
            .bind(String(e?.message || e).slice(0, 300), op.id, fence).run();
          // Only the owner reports. Without this a stale owner, fenced out of the row, still logged a failure for an op that
          // had already succeeded under somebody else: the false-report half of the stale-writer finding.
          if (miss.meta?.changes) await logEvent(db, "imap_op_fail", op.message_id, `${email} ${op.op} ${e?.message}`);
          else await logEvent(db, "imap_ops_stale_write", null, `${op.id} failed after losing its claim; another run owns it`); }
      }
    } catch (e) { await logEvent(db, "imap_ops_fail", null, `${email} ${e?.message}`); }
    finally { await c.logout(); }
  }
  return done;
}
// Sending as the work address: SMTP submission to the host, then APPEND to its Sent folder, then a hub row like any other send.
// Work-mail sends are idempotent per client key: a retry after a lost SMTP response must never produce a second message. An attempt is
// recorded BEFORE the SMTP dialogue; a retry that finds an attempt without a result is refused as ambiguous (check the Sent folder).
// Work-mail sends are idempotent per client key, and every stage is recorded so a retry knows what happened: `send_attempt` before the
// SMTP dialogue, then `send_idem` (sent and recorded), `send_sent` (the server said 250 but the local copy/record failed) or `send_failed`
// (the failure came before the message body was handed over, or the server rejected it: nothing left). Only an attempt with no outcome
// is ambiguous (the answer to DATA was lost); that stays a 409 until the user checks the mailbox.
async function sendViaImapAccount(env, body, acct) {
  const db = env.DB; const key = body.idempotency_key && /^[A-Za-z0-9_-]{8,80}$/.test(body.idempotency_key) ? body.idempotency_key : null;
  const stage = { messageId: key ? `<${key}@${acct.email.split("@")[1]}>` : null };
  if (key) {
    const last = await db.prepare("SELECT kind, message_id FROM events WHERE kind IN ('send_attempt','send_idem','send_sent','send_failed') AND detail LIKE ? ORDER BY id DESC LIMIT 1").bind(key + " %").first();
    if (last?.kind === "send_idem") { const m = await db.prepare("SELECT id, thread_id, message_id FROM messages WHERE id = ?").bind(last.message_id).first(); if (m) return { id: m.id, thread_id: m.thread_id, message_id: m.message_id, dedup: true }; }
    if (last?.kind === "send_sent") return { id: null, thread_id: null, message_id: stage.messageId, dedup: true, warning: "it went out earlier, but its copy could not be saved" };
    if (last?.kind === "send_attempt") {
      const m = await db.prepare("SELECT id, thread_id, message_id FROM messages WHERE message_id = ?").bind(stage.messageId).first();
      if (m) return { id: m.id, thread_id: m.thread_id, message_id: m.message_id, dedup: true };
      throw Object.assign(new Error("This message may already have left the work mailbox (the server's answer was lost). Check its Sent folder and the recipient before sending it again."), { code: "ambiguous_send", status: 409, message_id: stage.messageId });
    }
    await logEvent(db, "send_attempt", null, `${key} ${acct.email}`);
  }
  let r;
  try { r = await sendViaImapAccountInner(env, body, acct, stage); }
  catch (e) {
    if (key) {
      if (stage.smtp === "done") { await logEvent(db, "send_sent", null, `${key} ${stage.messageId} ${String(e.message).slice(0, 200)}`); return { id: null, thread_id: null, message_id: stage.messageId, warning: "its copy could not be saved: " + e.message }; }
      if (stage.smtp !== "data") await logEvent(db, "send_failed", null, `${key} ${stage.smtp || "before-smtp"} ${String(e.message).slice(0, 200)}`); // nothing left the server: the same key may be retried
      else { e.code = e.code || "ambiguous_send"; e.status = e.status || 409; e.message_id = stage.messageId; }
    }
    throw e;
  }
  if (key) await logEvent(db, "send_idem", r.id || null, `${key} ${r.message_id || ""}`);
  return r;
}
async function sendViaImapAccountInner(env, body, acct, stage = {}) {
  assertHeaderSafe(body);
  const db = env.DB; if (!acct.ready) throw new Error(`cannot send as ${acct.email}: secret ${acct.secret} not set`);
  acct = { ...acct, password: await imapPassword(env, acct) };   // unlocked before the SMTP connection opens, and gone when this send returns
  const fromName = body.from_name || acct.label || "";
  const to = toAddrObjs(body.to), cc = toAddrObjs(body.cc), bcc = toAddrObjs(body.bcc);
  if (!to.length) throw new Error("to is required");
  const subject = (body.subject || "").toString(); const text = bodyText(body), html = body.html ?? null;
  if (!text && !html) throw new Error("text or html is required");
  const parent = await replyParent(db, body, acct.email);
  const mm = createMimeMessage();
  mm.setSender(fromName ? { name: fromName, addr: acct.email } : acct.email);
  const asBox = (x) => (typeof x === "string" ? x : { name: x.name || "", addr: x.email });
  mm.setTo(to.map(asBox)); if (cc.length) mm.setCc(cc.map(asBox)); // Bcc recipients go only into the SMTP envelope, never into the headers
  mm.setSubject(subject);
  const messageId = stage.messageId || `<${uuid()}@${acct.email.split("@")[1]}>`; stage.messageId = messageId; mm.setHeader("Message-ID", messageId); // derived from the idempotency key when there is one, so the message can be found by hand
  let inReplyTo = null, refs = null;
  if (hdrId(parent?.message_id)) { inReplyTo = hdrId(parent.message_id); const rl = parseIdList(parent.refs); if (!rl.includes(inReplyTo)) rl.push(inReplyTo); refs = rl.join(" "); mm.setHeader("In-Reply-To", inReplyTo); mm.setHeader("References", refs); }   // cleaned: a parent stored earlier
  if (text) mm.addMessage({ contentType: "text/plain", data: text }); if (html) mm.addMessage({ contentType: "text/html", data: html });
  // Inline parts keep their disposition and Content-ID, as the other send path does: a forwarded inline image lost both here.
  // Each file is decoded here, before anything is sent, and kept for the copy under Sent below.
  const files = [];
  for (const a of body.attachments || []) {
    if (!a?.content || !a?.filename) throw new Error("attachment needs filename and base64 content");
    const cid = a.contentId ? String(a.contentId).trim().replace(/^<|>$/g, "") : ""; const data = a.content.replace(/\s+/g, ""); const inline = a.disposition === "inline";
    let bytes; try { const bin = atob(data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch (_) { throw new Error(`attachment ${a.filename}: content must be base64`); }
    files.push({ bytes, filename: a.filename, type: a.type || "application/octet-stream", cid: cid || null, disposition: inline ? "inline" : "attachment" });
    mm.addAttachment({ filename: a.filename, contentType: a.type || "application/octet-stream", data, inline, ...(cid ? { headers: { "Content-ID": `<${cid}>` } } : {}) });
  }
  const raw = mm.asRaw();
  if (raw.length > 25 * 1024 * 1024) throw new Error("message exceeds 25 MiB");
  const rcpts = [...to, ...cc, ...bcc].map(addrOnly).filter(Boolean);
  const smtpReply = await smtpSubmit(acct, acct.email, rcpts, raw, stage);
  let appended = false, sentFolder = null;
  try { const c = new ImapClient(acct.host, acct.port); await c.connect(); try { await c.login(acct.user, acct.password); const roles = await imapFolderRoles(db, c, acct); if (roles.sent) { await c.append(roles.sent, encU.encode(raw.replace(/\r?\n/g, "\r\n"))); appended = true; sentFolder = roles.sent; } } finally { await c.logout(); } } catch (e) { await logEvent(db, "imap_append_fail", null, `${acct.email} ${e?.message}`); }
  const id = uuid(), at = now();
  const toAddrs = to.map((x) => ({ address: addrOnly(x), name: typeof x === "string" ? "" : x.name || "" })), ccAddrs = cc.map((x) => ({ address: addrOnly(x), name: typeof x === "string" ? "" : x.name || "" }));
  const own = await ownDomains(db, env); const subjectNorm = normSubject(subject); const participants = externalParticipants([acct.email, ...toAddrs.map((a) => a.address), ...ccAddrs.map((a) => a.address)], own);
  const tw = parent ? threadWrite(db, parent.thread_id, { subjectNorm, participants, at }) : threadWrite(db, await resolveThread(db, { inReplyTo: null, references: null, subjectNorm, participants }), { subjectNorm, participants, at, newState: "archived" }); const threadId = tw.id;
  const copyKey = `out/${at.slice(0, 4)}/${at.slice(5, 7)}/${id}.eml`;
  await env.STORE.put(copyKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
  // Each file's own bytes under att/ and a row for it, the layout the other send path and received mail use: this path kept only the
  // eml, so a file sent from the work address was listed nowhere under Sent (the open item).
  const fileKeys = files.map((f, i) => `att/${id}/${i + 1}-${safeName(f.filename)}`);
  for (const [i, f] of files.entries()) await env.STORE.put(fileKeys[i], f.bytes, { httpMetadata: { contentType: f.type } });
  await db.batch([tw.stmt, db.prepare(`INSERT INTO messages (id, thread_id, direction, identity, from_addr, from_name, to_addrs, cc_addrs, subject, message_id, in_reply_to, refs, body_text, body_html, snippet, raw_key, size_bytes, status, ingest_source, date_hdr, created_at, imap_account, imap_folder)
    VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 'imap-smtp', ?, ?, ?, ?)`)
    .bind(id, threadId, acct.email, acct.email, fromName, JSON.stringify(toAddrs), JSON.stringify(ccAddrs), subject, messageId, inReplyTo, refs, (text || "").slice(0, BODY_CAP), (html || "").slice(0, BODY_CAP), previewOf(text, html), copyKey, raw.length, at, at, acct.email, appended ? sentFolder : null),
    ...files.map((f, i) => db.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), id, f.filename, f.type, f.bytes.length, fileKeys[i], f.cid, f.disposition))])   /* the conversation, its message and its files land together or not at all */;
  await logEvent(db, "sent", id, `${acct.email} -> ${toAddrs.map((a) => a.address).join(",")} ${messageId} via smtp (${(smtpReply || "").split("\n").pop().slice(0, 60)})${appended ? "" : " [not appended to Sent]"}`);
  // The mail went, but the work mailbox's own Sent folder did not get its copy: say so with the "Sent" (it was only logged).
  return { id, thread_id: threadId, message_id: messageId, ...(appended ? {} : { warning: "the copy was not saved to the work mailbox's Sent folder" }) };
}
// ---------- Smart Inbox categorizer (mirrors the client's rule; hub-side so the CLI and the notification policy can use it) ----------
const AUTO_LOCAL_RE = /^(no-?reply|noreply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|auto|automated|system|info|support|hello|team|news|newsletter|digest|updates?|billing|receipts?|orders?|shipping|security|accounts?|verify|verification)([._+-]|@|$)/i;
function categorizeHeaders(h, fromAddr, rule = null) {
  if (rule?.category && ["personal", "notifications", "newsletters"].includes(rule.category)) return rule.category;
  const g = (n) => (typeof h?.get === "function" ? h.get(n) : h?.[n]) || "";
  if (g("list-unsubscribe") || g("list-id") || /bulk|list/i.test(g("precedence"))) return "newsletters";
  if (/auto-(generated|replied|notified)/i.test(g("auto-submitted")) || AUTO_LOCAL_RE.test(lc(fromAddr))) return "notifications";
  return "personal";
}
// Gatekeeper sender state: first sight → pending (mail stays where it is; only the push is muted under Smart), Accept/Block decide.
// One upsert, never SELECT-then-INSERT: two overlapping cron polls both saw no row for a new sender and the second INSERT died on the
// primary key (gmail_poll_fail 2026-09-11 07:03:39 "UNIQUE constraint failed: known_senders.address"). Same call from the inbound handler.
async function touchSender(db, addr, account, rules) {
  const a = lc(addr); if (!a || !a.includes("@")) return null;
  const rule = matchSender(rules, a, account);
  const auto = rule ? (rule.action === "block" ? "blocked" : "accepted") : "pending";
  // An address-level block always wins; a domain-level block never demotes a sender the user accepted (the accept is the exception).
  const hardBlock = rule?.action === "block" && !lc(rule.pattern).startsWith("*@") ? 1 : 0;
  const t = now();
  await db.prepare("INSERT INTO known_senders (address, status, first_seen_at, last_seen_at, first_account, seen_count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(address) DO UPDATE SET last_seen_at = excluded.last_seen_at, seen_count = known_senders.seen_count + 1, status = CASE WHEN ? = 1 THEN 'blocked' WHEN excluded.status = 'blocked' AND known_senders.status <> 'accepted' THEN 'blocked' ELSE known_senders.status END").bind(a, auto, t, t, account, hardBlock).run();
  return (await db.prepare("SELECT status FROM known_senders WHERE address = ?").bind(a).first())?.status ?? auto;
}
// Notification policy (Spark's All / Smart / Priority / None), global with per-account overrides in prefs; Smart mutes strangers
// (pending senders), automated senders and newsletters.
// Notification content, Spark-style (Full preview / Sender and subject / Sender only / No preview). On macOS the system
// notification shows only icon, title and body (no buttons, no images) so the sender is the title and the subject plus
// one line of the message is the body. `tag` per thread makes a follow-up replace the earlier notification.
const PREVIEW_LEVELS = ["full", "subject", "sender", "none"];
function mailPush(preview, { kind, account, label, thread, from, subject, snippet, priority }) {
  const level = PREVIEW_LEVELS.includes(preview) ? preview : "full";
  const raw = String(from || ""); const name = raw.replace(/<[^<>]*>/g, "").replace(/^\s*"?|"?\s*$/g, "").trim() || (raw.match(/<([^<>]+)>/) || [])[1] || raw.trim() || label || account;
  const subj = String(subject || "").replace(/\s+/g, " ").trim() || "(no subject)";
  const snip = String(snippet || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 160);
  const url = thread ? `/?account=${encodeURIComponent(account)}&thread=${encodeURIComponent(thread)}` : `/?account=${encodeURIComponent(account)}`;
  const title = level === "none" ? `New mail in ${label || account}` : name;
  const body = level === "full" ? (snip ? `${subj}\n${snip}` : subj) : level === "subject" ? subj : "";
  return { kind, account, thread: thread || undefined, priority: !!priority, title: title.slice(0, 120), body: body.slice(0, 320), url };
}
function mailPushSummary(preview, { kind, account, label, items, count }) {
  const level = PREVIEW_LEVELS.includes(preview) ? preview : "full"; const n = count || items.length;
  const lines = items.slice(0, 4).map((it) => { const p = mailPush(level, { kind, account, label, ...it }); return level === "none" ? "" : level === "sender" ? p.title : `${p.title}: ${String(it.subject || "").replace(/\s+/g, " ").trim() || "(no subject)"}`; }).filter(Boolean);
  const rest = n - Math.min(items.length, 4);
  return { kind, account, priority: items.some((it) => it.priority), title: `${n} new in ${label || account}`, body: (lines.join("\n") + (level !== "none" && rest > 0 ? `\n+${rest} more` : "")).trim().slice(0, 320), url: `/?account=${encodeURIComponent(account)}` };
}
async function notifyPreview(env) { try { const r = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'notifyPreview'").first(); const v = r ? JSON.parse(r.value) : null; return PREVIEW_LEVELS.includes(v) ? v : "full"; } catch (_) { return "full"; } }
// The buttons on a phone notification, left to right. Android shows at most three: "A notification can offer up to three
// action buttons" (developer.android.com, Create a notification). Chosen in Settings → Notifications; every mail push carries them,
// so a change applies to the next notification with nothing to reinstall. An empty list is a choice too: no buttons.
const NOTIFY_BUTTONS = ["done", "read", "trash", "quiet", "snooze", "reply"], NOTIFY_BUTTONS_DEFAULT = ["done", "read", "quiet"];
async function notifyButtons(env) {
  try { const r = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'notifyButtons'").first(); const v = r ? JSON.parse(r.value) : null; if (Array.isArray(v)) return [...new Set(v.filter((x) => NOTIFY_BUTTONS.includes(x)))].slice(0, 3); } catch (_) {}
  return NOTIFY_BUTTONS_DEFAULT;
}
async function notifyPolicy(env, account = null) {
  const { results } = await env.DB.prepare("SELECT key, value FROM prefs WHERE key IN ('notify', 'notifyByAccount')").all();
  let mode = "all", by = {};
  for (const r of results) { try { if (r.key === "notify") mode = JSON.parse(r.value); else by = JSON.parse(r.value) || {}; } catch (_) {} }
  return { mode, by, for: (acct) => by[lc(acct)] || mode };
}
function shouldNotify(policy, { category, rule, fromAddr, senderStatus, account }) {
  const mode = typeof policy === "string" ? policy : policy.for(account);
  if (mode === "none" || (rule?.action === "block" && senderStatus !== "accepted") || senderStatus === "blocked") return false;
  if (mode === "priority") return rule?.action === "priority";
  if (mode === "smart") return rule?.action === "priority" || (category === "personal" && senderStatus !== "pending" && !AUTO_LOCAL_RE.test(lc(fromAddr)));
  return true;
}
// ---------- Don't-notify rules ----------
// Rules that are very easy to make; the case in point, a daily Venmo password
// reset mail. Venmo's resets come from venmo@venmo.com, the same address as real payment receipts, so a rule is a sender AND,
// optionally, a phrase of the subject. The mail still arrives; only the notification is skipped, on every device and in the Mac/Windows
// feed alike.
const quietSubject = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").slice(0, 200);
// A rule's subject is a set of WORDS, every one of which must be in the subject, in any order: Uber's sign-in codes arrive as "Do not
// share: 1234", a new number each time, so the user picks the words that stay ("do not share") and leaves the code out.
// Words are compared whole, with the punctuation at their edges dropped ("share:" is "share").
const quietWords = (s) => quietSubject(s).split(" ").map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
// What "Stop these" on a notification keeps of a subject: its words without digits; codes, amounts, dates and order numbers change from
// one mail to the next. A subject that is nothing but such words is kept whole rather than widened to everything from the sender.
const quietGeneral = (s) => { const w = quietWords(s), keep = w.filter((x) => !/\d/.test(x)); return (keep.length ? keep : w).join(" "); };
const quietSender = (s) => { const a = lc(String(s || "").trim()); return /^(\*@)?[^\s@*]+@?[^\s@*]*$/.test(a) && a.includes("@") && !a.endsWith("@") ? a : null; };
async function quietRules(env) { try { return (await env.DB.prepare("SELECT id, sender, subject FROM quiet_rules").all()).results || []; } catch (_) { return []; } }
function quietMatch(rules, fromAddr, subject) {
  const a = lc(fromAddr || ""), dom = a.split("@")[1] || "", words = new Set(quietWords(subject));
  return (rules || []).find((r) => (r.sender === a || (r.sender.startsWith("*@") && r.sender.slice(2) === dom)) && (!r.subject || r.subject.split(" ").every((w) => words.has(w)))) || null;
}
async function quietHit(env, r, what) {
  try { await env.DB.prepare("UPDATE quiet_rules SET hits = hits + 1, last_hit_at = ? WHERE id = ?").bind(now(), r.id).run(); } catch (_) {}
  await logEvent(env.DB, "notify_quiet", null, `${what} (rule ${r.sender}${r.subject ? ` "${r.subject}"` : ""})`.slice(0, 300));
}
async function addQuietRule(env, sender, subject) {
  const snd = quietSender(sender); if (!snd) return null;
  const sub = quietWords(subject).join(" ");
  await env.DB.prepare("INSERT INTO quiet_rules (id, sender, subject, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(sender, subject) DO NOTHING").bind(uuid(), snd, sub, now()).run();
  return env.DB.prepare("SELECT * FROM quiet_rules WHERE sender = ? AND subject = ?").bind(snd, sub).first();
}
// ---------- Trash rules ----------
// The user's own rules for mail whose address keeps changing: the "Webmail" phish reached sam@domain5.example from three domains in a
// month under the one sender name, and an address or domain rule catches none of the next ones. A rule holds words of the sender's NAME
// and/or of the SUBJECT, matched like a don't-notify rule's subject (every word, in any order, whole words; both fields when both are
// set), and a scope: an address, every address at a domain (*@domain), or every account (*). Matching mail goes to Trash on arrival,
// with no notification, on all three paths: Cloudflare (a conversation of its own, created in Trash), Gmail (its Trash) and the work
// mailbox (moved to the server's Trash).
const TRASH_WORDS_MAX = 20;
const trashWords = (s) => quietWords(s).slice(0, TRASH_WORDS_MAX).map((w) => w.slice(0, 60)).join(" ");
const trashScope = (s) => { const v = String(s ?? "").trim(); return v === "*" ? "*" : quietSender(v); };
function trashRulesLoader(db) { let p = null; return () => (p ??= db.prepare("SELECT id, scope, name, subject FROM trash_rules").all().then((r) => r.results || []).catch(() => [])); }
export function trashMatch(rules, { name, subject, account }) {
  const acct = lc(account || ""), dom = acct.split("@")[1] || "";
  let nw = null, sw = null;
  for (const r of rules || []) {
    if (!(r.scope === "*" || r.scope === acct || (r.scope.startsWith("*@") && r.scope.slice(2) === dom))) continue;
    if (!r.name && !r.subject) continue;
    if (r.name && !r.name.split(" ").every((w) => (nw ??= new Set(quietWords(name))).has(w))) continue;
    if (r.subject && !r.subject.split(" ").every((w) => (sw ??= new Set(quietWords(subject))).has(w))) continue;
    return r;
  }
  return null;
}
// ---------- Named after a company the user gets mail from, sent from somewhere else ----------
// Three fakes reached the main Gmail inbox in two days under one company's name, each from noreply@ a different unrelated domain
// through that domain's own SendGrid account, so every sender check passed; the company's real mail comes from its own domain. The
// "real or fake" brand table (trust.js) knows only invitation and file-sharing brands, so it said nothing.
// A sender is an impostor when all of these hold:
//  - its name is a company's name: its first one to three words, run together, are the name of a domain the user gets mail from
//  ("Northwind" → northwind.com, "Blue Harbor" → blueharbor.com), and any words after them are plain ones ("Alerts", "Support");
//  - its address does not carry that name, so it is not the company's own mail service ("<company>@mail.sailthru.com",
//  "<company>@emails.thanx.com" and "support@<company>support.freshdesk.com" are genuine);
//  - nobody at its domain has written to the user before: a company's mail service sends a lot (a ticket seller's from
//  socialtoaster.com, Meta's from facebookmail.com), a hijacked account just once.
// The companies and the domains that have written are the user's known senders, less those blocked, plus the hub's own domains.
// Replayed over the 4,951 messages the hub held on 2026-11-25 (the Gmail mirror since July, hub mail and the work mailbox): 4 flagged,
// all fakes (the three above and one under a bank's name); without the last condition, 16, the other 12 genuine.
// The same functions are in trust.js for the app's banner; test/impostor.mjs holds the two identical.
const impostorRoot = lockRoot;
const IMPOSTOR_PLAIN = new Set("team support alerts alert security secure notifications notification notify account accounts billing service services customer customers care help helpdesk info news newsletter membership member members official online noreply no reply donotreply mail email center centre department dept updates update verification verify fraud protection payments payment rewards inc llc corp hq us usa".split(" "));
function impostorOf(name, addr, known) {
  const a = String(addr || "").toLowerCase(), i = a.lastIndexOf("@"); if (i < 1 || !known) return null;
  const org = impostorRoot(a.slice(i + 1)); if (!org || known.orgs.has(org)) return null;
  const flat = a.replace(/[^a-z0-9]/g, "");
  const shown = String(name || "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean), words = shown.map((w) => w.toLowerCase());
  if (words[0] === "the") { words.shift(); shown.shift(); }
  for (let k = 1; k <= Math.min(3, words.length); k++) {
    const cand = words.slice(0, k).join("");
    if (cand.length < 3 || !words.slice(k).every((w) => IMPOSTOR_PLAIN.has(w))) continue;
    if (flat.includes(cand)) return null;
    const real = [...(known.byLabel.get(cand) || [])].filter((o) => o !== org).sort();
    if (real.length) return { name: shown.slice(0, k).join(" "), real: real[0], org };
  }
  return null;
}
// The domains that have written to the user (known senders not blocked) and the user's own, each also under its name:
// "northwind.com" under "northwind".
function impostorKnownOf(orgList) {
  const orgs = new Set(), byLabel = new Map();
  for (const x of orgList || []) {
    const o = impostorRoot(x); if (!o) continue; orgs.add(o);
    const l = o.split(".")[0].replace(/[^a-z0-9]/g, ""); if (l.length >= 3) { if (!byLabel.has(l)) byLabel.set(l, new Set()); byLabel.get(l).add(o); }
  }
  return { orgs, byLabel };
}
// Read once per isolate every five minutes; a sender judged an impostor is never added to the known senders, so its domain stays new.
async function impostorOrgs(env) {
  const { results } = await env.DB.prepare("SELECT address FROM known_senders WHERE status != 'blocked'").all();
  const out = new Set([...(await ownDomains(env.DB, env))].map(impostorRoot));
  for (const r of results || []) { const d = String(r.address || "").toLowerCase().split("@")[1]; if (d) out.add(impostorRoot(d)); }
  out.delete(""); return [...out].sort();
}
let impostorCache = { at: 0, v: null };
async function impostorKnown(env) {
  if (impostorCache.v && Date.now() - impostorCache.at < 5 * 60e3) return impostorCache.v;
  impostorCache = { at: Date.now(), v: impostorKnownOf(await impostorOrgs(env)) };
  return impostorCache.v;
}
const impostorWhy = (v) => `named "${v.name}", whose mail comes from ${v.real}; this came from ${v.org}`;
async function trashHit(db, r, what, messageId = null) {
  try { await db.prepare("UPDATE trash_rules SET hits = hits + 1, last_hit_at = ? WHERE id = ?").bind(now(), r.id).run(); } catch (_) {}
  await logEvent(db, "rule_trashed", messageId, `${what} (rule ${r.scope}${r.name ? ` name "${r.name}"` : ""}${r.subject ? ` subject "${r.subject}"` : ""})`.slice(0, 300));
}
// ---------- Web Push (gates 5/6): content-free notifications to every subscribed device ----------
const pushConfigured = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
// Conversations the user has already handled on one device, so the next push can tell the others to drop their notification. Kept in
// prefs (a short ring, pruned by age), read at most once every 20 s per isolate, and attached to mail pushes that were going out anyway:
// no extra push, no per-action request. HANDLED_TTL_MS is how long a key is worth repeating; a device offline longer sweeps on its own.
const HANDLED_TTL_MS = 30 * 60_000, HANDLED_MAX = 300, DISMISS_MAX = 60, LIVE_MAX = 200;
let handledCache = { at: 0, list: [] };
const readHandled = async (env) => { try { const r = await env.DB.prepare("SELECT value FROM prefs WHERE key = 'handled'").first(); const v = r ? JSON.parse(r.value) : []; if (Array.isArray(v)) return v; } catch (_) {} return []; };
// The ring carries ENTRIES now, not bare keys. `at` is what lets a device refuse to close a notification
// NEWER than the dismissal that names it: a reply landing in a thread trashed a moment earlier would otherwise be silently
// swallowed. `by` is the push subscription that reported the action; the dismissal is
// never sent back to it, because that device closed its own notification before the request even left (layer (a)).
async function handledKeys(env) {
  if (Date.now() - handledCache.at < 20_000) return handledCache.list;
  const cut = Date.now() - HANDLED_TTL_MS;
  const list = (await readHandled(env)).filter((x) => x && x.k && x.at >= cut).map((x) => ({ k: x.k, at: x.at, by: x.by || null }));
  handledCache = { at: Date.now(), list }; return list;
}
// `when` is when the device acted, if it said (its report waits out a 4 s debounce): a reply pushed in those seconds is newer than
// the handling and must keep its notification, which a stamp taken on arrival would close.
async function addHandled(env, keys, by = null, when = null) {
  const clean = [...new Set((keys || []).filter((k) => typeof k === "string" && k.length <= 200 && k.includes("|")))].slice(0, HANDLED_MAX);
  if (!clean.length) return [];
  const rows = await readHandled(env);
  const cut = Date.now() - HANDLED_TTL_MS, at = when || Date.now();
  // A key already in the ring KEEPS its original `at` and `by`. The Gmail history feed re-observes the very label change the
  // client just reported, with no device attached, and letting that overwrite `by` would aim the dismissal back at the device
  // that acted (whose shade is empty by definition) for nothing.
  const prior = new Map(rows.filter((x) => x && x.k && x.at >= cut).map((x) => [x.k, x]));
  // `repeat` marks a key the ring already held: the same conversation reported again (the client, then Gmail's history
  // re-observing the same label change). It is not stored, only returned, so sendDismissPush can tell news from an echo.
  const fresh = clean.map((k) => { const p = prior.get(k); return p ? { k, at: p.at, by: p.by || null, repeat: true } : { k, at, by }; });
  const seen = new Set(clean);
  const next = [...fresh.map(({ repeat, ...e }) => e), ...rows.filter((x) => x && x.k && x.at >= cut && !seen.has(x.k))].slice(0, HANDLED_MAX);
  await env.DB.prepare("INSERT INTO prefs (key, value, updated_at) VALUES ('handled', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(next), now()).run();
  handledCache = { at: 0, list: [] };
  return fresh;
}
// New mail in a conversation ends its place in the ring. The ring's `repeat` marker exists to swallow an ECHO of one handling (the
// client's report, then Gmail's history seeing the same label change); without this, handling the REPLY within 30 minutes of the
// first was taken for an echo too, and neither the phone nor the Mac/Windows feed ever heard of it.
async function forgetHandled(env, keys) {
  const drop = new Set((keys || []).filter(Boolean)); if (!drop.size) return;
  const rows = await readHandled(env);
  if (!rows.some((x) => x && drop.has(x.k))) return;
  await env.DB.prepare("UPDATE prefs SET value = ?, updated_at = ? WHERE key = 'handled'").bind(JSON.stringify(rows.filter((x) => x && !drop.has(x.k))), now()).run();
  handledCache = { at: 0, list: [] };
}
// What each device is holding on screen. The Worker raised every one of these notifications itself, so it can know which
// device a given dismissal is even worth waking: see migration 0023 for why that matters more than the saved bytes.
const parseTags = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch (_) { return []; } };
const actorId = async (db, endpoint) => endpoint ? (await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").bind(String(endpoint).slice(0, 512)).first())?.id || null : null;
// One send to one device, plus the bookkeeping that makes the NEXT dismissal targetable: what this device is now holding on
// screen, and what it has just been told to drop.
async function pushOne(env, s, data, carry, opts = {}) {
  const db = env.DB;
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const body = JSON.stringify({ ...data, ...(carry.length ? { dismiss: carry } : {}), at: now() });
  try {
    const payload = await buildPushPayload({ data: body, options: { ttl: opts.ttl ?? 3600, urgency: opts.urgency || "normal" } }, { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } }, vapid);
    const r = await fetch(s.endpoint, payload);
    if (r.status === 404 || r.status === 410) { await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(s.id).run(); await logEvent(db, "push_sub_gone", null, `${s.id} http ${r.status}`); return "gone"; }
    if (!r.ok) { await db.prepare("UPDATE push_subscriptions SET last_error = ?, fail_count = fail_count + 1 WHERE id = ?").bind(`http ${r.status}`, s.id).run(); await logEvent(db, "push_fail", null, `${s.id} http ${r.status}`); return "failed"; }
    await db.prepare("UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL, fail_count = 0 WHERE id = ?").bind(now(), s.id).run();
    // The service worker raises one notification per thread, tagged `t-<account>|<thread>`; this is the same key, kept server
    // side. A push that was accepted by the push service is not proof the phone drew it, so this is a best guess that degrades
    // safely: a key wrongly believed live costs one dismissal that closes nothing, and one wrongly believed gone falls back to
    // the piggyback and to the device's own sweep on next wake.
    const key = data.thread && data.account ? `${data.account}|${data.thread}` : null;
    const drop = new Set(carry.map((e) => e.k));
    const next = parseTags(s.live_tags).filter((k) => !drop.has(k) && k !== key);
    if (key && data.kind !== "dismiss") next.push(key);
    await db.prepare("UPDATE push_subscriptions SET live_tags = ? WHERE id = ?").bind(JSON.stringify(next.slice(-LIVE_MAX)), s.id).run();
    return "sent";
  } catch (e) { await db.prepare("UPDATE push_subscriptions SET last_error = ?, fail_count = fail_count + 1 WHERE id = ?").bind(String(e?.message || e).slice(0, 200), s.id).run(); await logEvent(db, "push_fail", null, `${s.id} ${e?.message}`); return "failed"; }
}
// ---------- Firebase Cloud Messaging: the native Android app (migration 0027) ----------
// FCM HTTP v1 needs an OAuth token minted from a service account: a JWT signed RS256 (WebCrypto, no library) traded at
// Google's token endpoint, cached until a couple of minutes before it expires. Payloads ride as ONE data field `p` (FCM
// data values must be strings), always as data messages so the app (not the system) decides what to show and can fetch
// the conversation first. Mail goes out HIGH priority (it is shown); dismissals NORMAL (nothing is shown, and HIGH messages
// that never surface a notification get deprioritised by Android).
let fcmAuthCache = { accessToken: null, exp: 0, who: "" };
async function fcmAuth(env) {
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  if (fcmAuthCache.accessToken && fcmAuthCache.who === sa.client_email && Date.now() < fcmAuthCache.exp - 120_000) return { accessToken: fcmAuthCache.accessToken, project: sa.project_id };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const jwt = `${unsigned}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)))}`;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`fcm auth http ${r.status} ${j.error || ""}`.trim());
  fcmAuthCache = { accessToken: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, who: sa.client_email };
  return { accessToken: j.access_token, project: sa.project_id };
}
// ---------- What each phone is showing ----------
// A dismissal reaches a sleeping phone only at HIGH priority; NORMAL waits for Doze (on my Pixel up to 30 min in light
// doze, 1-6 h in deep: `dumpsys deviceidle`). But FCM demotes an app whose HIGH messages do not end in a visible
// notification: new mail included (firebase.google.com/docs/cloud-messaging/android/message-priority; Android 13 behavior
// changes). So a dismissal goes HIGH only where it removes something on screen: the hub remembers, per device, the keys it pushed
// HIGH and has not dismissed (live_tags), never wakes the device that did the work, and backs off to NORMAL for 7 days the moment the
// app reports a demoted delivery. Signal sends read syncs urgent (HIGH); Telegram's READ_HISTORY push names what to cancel, applied
// in onMessageReceived with no network: this does both.
const FCM_DEMOTED_MS = 7 * 86_400_000, FCM_CARRY_MAX = 20, FCM_LIVE_MAX = 200, FCM_PEND_MAX = 100;
// An FCM data payload is capped at 4,096 bytes; a key with its time is about 70, so 40 keys per message leaves room for the rest.
const FCM_KEYS_PER_MSG = 40;
const FCM_DEVICE_RE = /^fcm:[0-9a-f]{16}$/;
// The id the app computes from its own token (Hub.kt deviceId): "fcm:" + the first 16 hex of SHA-256(token).
const fcmDeviceId = async (token) => "fcm:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token))))].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
const fcmDemoted = (d) => !!d.demoted_at && Date.now() - Date.parse(d.demoted_at) < FCM_DEMOTED_MS;
async function fcmDevices(env) {
  try { return (await env.DB.prepare("SELECT token, live_tags, pend_tags, demoted_at, push_key FROM fcm_devices").all()).results; } catch (_) { return null; }
}
async function fcmDeviceById(db, id) {
  if (!FCM_DEVICE_RE.test(String(id || ""))) return null;
  const { results } = await db.prepare("SELECT token, live_tags, pend_tags, demoted_at FROM fcm_devices").all();
  for (const d of results) if ((await fcmDeviceId(d.token)) === id) return d;
  return null;
}
// An owed clear keeps the time it was handled: the ring forgets after 30 minutes, and a clear sent without its time ("0") would
// close whatever the phone shows under that key, newer mail included. Rows written
// before this held bare keys; those read as time 0 and are looked up in the ring.
const parsePend = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map((x) => typeof x === "string" ? { k: x, at: 0 } : x && typeof x.k === "string" ? { k: x.k, at: Number(x.at) || 0 } : null).filter(Boolean) : []; } catch (_) { return []; } };
// Every change to a device's sets is a function of what is stored NOW, written only if nothing changed meanwhile. A mail push, a
// dismissal and the phone's own "gone" can land together; read-then-write let the last one put back what another had just
// removed. Android shows at most 50 notifications per app (NotificationManagerService
// MAX_PACKAGE_NOTIFICATIONS), so the caps only ever trim drift.
async function fcmUpdateTags(db, token, fn) {
  for (let i = 0; i < 4; i++) {
    const r = await db.prepare("SELECT live_tags, pend_tags FROM fcm_devices WHERE token = ?").bind(token).first(); if (!r) return;
    const [live, pend] = fn(parseTags(r.live_tags), parsePend(r.pend_tags));
    const L = JSON.stringify(live.slice(-FCM_LIVE_MAX)), P = JSON.stringify(pend.slice(-FCM_PEND_MAX));
    if (L === (r.live_tags || "[]") && P === (r.pend_tags || "[]")) return;
    const w = await db.prepare("UPDATE fcm_devices SET live_tags = ?, pend_tags = ? WHERE token = ? AND live_tags IS ? AND pend_tags IS ?").bind(L, P, token, r.live_tags, r.pend_tags).run();
    if (w.meta?.changes) return;
  }
  await logEvent(db, "fcm_fail", null, "on-screen set not updated: four concurrent changes in a row");
}
// ---- Push previews sealed for the phone ----
// FCM carries a data message through Google's servers as it is given; Web Push is encrypted end to end (RFC 8291), FCM is not. So a
// phone that registered a key gets the payload as `e`: base64url(iv(12) || AES-256-GCM(deflate-raw(JSON)) || tag(16)), with this
// associated data. Deflated first: a 40-key dismissal is ~3.6 KB of JSON, near FCM's 4,096-byte limit, and sealing adds a third.
// `n: "1"` says, in the clear, only that the message is a notification, so a phone that cannot open it still shows "New mail".
// A phone without a key (an app before 1.13) gets the sender only: no subject, no text.
const PUSH_AAD = new TextEncoder().encode("sherit-push-v1"), FCM_DATA_MAX = 3900;
async function sealPush(keyB64, text) {
  const key = await crypto.subtle.importKey("raw", unb64(keyB64.replace(/-/g, "+").replace(/_/g, "/")), "AES-GCM", false, ["encrypt"]);
  const z = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: PUSH_AAD, tagLength: 128 }, key, z));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return b64url(out);
}
async function fcmData(d, payload) {
  const flag = payload.title ? { n: "1" } : {};
  if (!d.push_key) return { p: JSON.stringify({ ...payload, ...(payload.body ? { body: "" } : {}), at: now() }) };
  let e = await sealPush(d.push_key, JSON.stringify({ ...payload, at: now() }));
  // Over FCM's limit: a mail push goes without the clears it carries (they stay owed: the caller is told) rather than not at all.
  if (e.length > FCM_DATA_MAX && payload.title && payload.dismiss?.length) { e = await sealPush(d.push_key, JSON.stringify({ ...payload, dismiss: undefined, at: now() })); return { e, ...flag, dropped: true }; }
  return { e, ...flag };
}
// One message to one device, with the bookkeeping every send shares. "sent" | "sent-nocarry" (sent without its carried clears) |
// "gone" (token deleted) | "failed".
async function fcmSendOne(env, auth, d, payload, { high, ttl, collapse = null }) {
  try {
    const { dropped, ...data } = await fcmData(d, payload);
    const android = { priority: high ? "HIGH" : "NORMAL", ttl: ttl || (high ? "3600s" : "600s"), ...(collapse ? { collapse_key: collapse } : {}) };
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${auth.project}/messages:send`, { method: "POST", headers: { authorization: `Bearer ${auth.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: d.token, data, android } }) });
    if (r.ok) { await env.DB.prepare("UPDATE fcm_devices SET last_ok_at = ?, last_error = NULL, fail_count = 0 WHERE token = ?").bind(now(), d.token).run(); if (dropped) await logEvent(env.DB, "fcm_carry_dropped", null, `${(payload.dismiss || []).length} clear(s) left owed: the sealed push was over ${FCM_DATA_MAX} bytes`); return dropped ? "sent-nocarry" : "sent"; }
    const j = await r.json().catch(() => ({}));
    const code = (j?.error?.details || []).map((x) => x.errorCode).find(Boolean) || j?.error?.status || `http ${r.status}`;
    if (r.status === 404 || code === "UNREGISTERED") { await env.DB.prepare("DELETE FROM fcm_devices WHERE token = ?").bind(d.token).run(); await logEvent(env.DB, "fcm_gone", null, code); return "gone"; }
    await env.DB.prepare("UPDATE fcm_devices SET last_error = ?, fail_count = fail_count + 1 WHERE token = ?").bind(String(code).slice(0, 200), d.token).run();
    return "failed";
  } catch (_) { return "failed"; }
}
async function fcmReady(env) {
  if (!env.FCM_SERVICE_ACCOUNT) return { skip: { sent: 0, failed: 0, total: 0, skipped: "not configured" } };
  const devices = await fcmDevices(env);
  if (!devices?.length) return { skip: { sent: 0, failed: 0, total: 0 } };
  try { return { devices, auth: await fcmAuth(env) }; }
  catch (e) { await logEvent(env.DB, "fcm_fail", null, String(e?.message || e).slice(0, 200)); return { skip: { sent: 0, failed: devices.length, total: devices.length } }; }
}
// New mail (and the other notifying kinds), HIGH. A mail push becomes live on the device, and carries the clears still pending
// there (pend_tags), so the moment the phone lights up for new mail, notifications already dealt with leave with the same wake.
async function sendFcm(env, payload, { high = true, ttl = null } = {}) {
  const { devices, auth, skip } = await fcmReady(env); if (skip) return skip;
  const key = payload.thread && payload.account && payload.kind !== "dismiss" ? `${payload.account}|${payload.thread}` : null;
  if (key && ["gmail", "hub", "imap"].includes(payload.kind)) payload = { ...payload, acts: await notifyButtons(env) };
  let sent = 0, failed = 0;
  for (const d of devices) {
    // Never the key being shown now: a clear for an earlier message of this conversation must not close its new notification.
    const carry = high && key ? await withHandledAt(env, parsePend(d.pend_tags).filter((e) => e.k !== key).slice(-FCM_CARRY_MAX)) : [];
    const body = carry.length ? { ...payload, dismiss: carry } : payload;
    const out = await fcmSendOne(env, auth, d, body, { high, ttl });
    if (out === "sent" || out === "sent-nocarry") {
      sent++;
      if (key || carry.length) {
        // A clear that became owed again meanwhile, for a later handling, stays owed: only what this push carried is paid.
        const paid = new Map(out === "sent" ? carry.map((e) => [e.k, e.at]) : []);
        await fcmUpdateTags(env.DB, d.token, (live, pend) => [[...live.filter((k) => k !== key && !paid.has(k)), ...(key ? [key] : [])], pend.filter((e) => e.k !== key && !(paid.has(e.k) && e.at <= paid.get(e.k)))]);
      }
    } else if (out === "failed") failed++;
  }
  if (failed) await logEvent(env.DB, "fcm_fail", null, `${failed} of ${devices.length} device(s)`);
  return { sent, failed, total: devices.length };
}
// Owed clears as the phone reads them: { k, at }. Only an entry written before owed clears kept their time asks the ring for it.
async function withHandledAt(env, entries) {
  if (!entries.some((e) => !e.at)) return entries.map((e) => ({ k: e.k, at: e.at }));
  const ring = new Map((await handledKeys(env)).map((e) => [e.k, e.at]));
  return entries.map((e) => ({ k: e.k, at: e.at || ring.get(e.k) || 0 }));
}
// The dismissal itself, per device: HIGH for what the device is showing (unless it was demoted in the last 7 days), NORMAL for the
// rest, nothing to the device that did the work. Each entry carries the time it was handled: the app closes only a notification
// posted before that time, so a late NORMAL dismissal can never close the notification for a newer message in the same conversation.
async function fcmDismiss(env, news) {
  const { devices, auth, skip } = await fcmReady(env); if (skip) return skip;
  const item = (e) => ({ k: e.k, at: e.at });
  for (const d of devices) {
    const id = await fcmDeviceId(d.token);
    const live = parseTags(d.live_tags), pend = parsePend(d.pend_tags);
    // On screen as far as the hub knows: pushed HIGH and not dismissed since, or dismissed with that clear still owed.
    const showing = new Set([...live, ...pend.map((e) => e.k)]);
    const others = news.filter((e) => e.by !== id);   // what this phone did itself it has already cleared
    const shown = others.filter((e) => showing.has(e.k));
    const demoted = fcmDemoted(d);
    const high = demoted ? [] : shown, normal = others.filter((e) => !high.includes(e));
    // HIGH in chunks: a bulk triage of many shown conversations must not build one payload over FCM's 4,096-byte limit.
    let highOut = null; const unsent = [], paid = [];
    for (let i = 0; i < high.length; i += FCM_KEYS_PER_MSG) {
      const chunk = high.slice(i, i + FCM_KEYS_PER_MSG);
      const out = await fcmSendOne(env, auth, d, { kind: "dismiss", dismiss: chunk.map(item) }, { high: true, ttl: DISMISS_FCM_TTL });
      if (out === "gone") { highOut = "gone"; break; }
      if (out === "failed") unsent.push(...chunk); else { paid.push(...chunk); if (highOut === null) highOut = "sent"; }
    }
    if (highOut === "gone") continue;
    if (unsent.length && highOut === null) highOut = "failed";
    // A shown key whose clear did not go out HIGH (demoted, or the send failed) stays OWED, with its newest handled time, until a
    // HIGH message delivers it: the next mail push, or a later HIGH dismissal. A NORMAL message never pays it off: FCM may replace
    // a collapsible NORMAL before the phone wakes.
    const owed = [...(demoted ? shown : []), ...unsent].map(item);
    const paidAt = new Map(paid.map((e) => [e.k, e.at])), cleared = new Set(news.map((e) => e.k));
    const update = (live, pend) => {
      const kept = pend.filter((e) => !(paidAt.has(e.k) && e.at <= paidAt.get(e.k)));
      for (const o of owed) { const p = kept.find((e) => e.k === o.k); if (p) p.at = Math.max(p.at, o.at); else kept.push({ ...o }); }
      return [live.filter((k) => !cleared.has(k)), kept];
    };
    // NORMAL is COLLAPSIBLE: while the phone is unreachable FCM keeps only the newest one per collapse key, instead of piling up
    // non-collapsible messages until its limit of 100 discards everything stored: new mail included ("For Android, there is a limit
    // of 100 messages that can be stored without collapsing. If the limit is reached, all stored messages are discarded.",
    // firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types). So each NORMAL dismissal also carries
    // every clear still owed to this device: the one that survives covers them all. Keys the phone is not showing are low value and
    // capped at the newest few. A HIGH send that failed goes out this way too, so a phone that gets no more mail still hears of it
    // when it wakes.
    if (normal.length || unsent.length) {
      const extra = await withHandledAt(env, update(live, pend.map((e) => ({ ...e })))[1].filter((e) => !normal.some((n) => n.k === e.k)).slice(-FCM_CARRY_MAX));
      const items = [...normal.slice(-(FCM_KEYS_PER_MSG - extra.length)).map(item), ...extra];
      if ((await fcmSendOne(env, auth, d, { kind: "dismiss", dismiss: items }, { high: false, ttl: DISMISS_FCM_TTL, collapse: "dismiss" })) === "gone") continue;
    }
    await fcmUpdateTags(env.DB, d.token, update);
    if (highOut) await logEvent(env.DB, highOut === "sent" ? "fcm_dismiss_high" : "fcm_fail", null, `${paid.length} key(s) sent HIGH${unsent.length ? `, ${unsent.length} failed (sent NORMAL, kept owed)` : ""}`);
  }
}
// One row per notification or dismissal, read by clients that cannot receive Web Push (the native Mac app; migration 0026).
// Best-effort: a feed failure must never cost the push itself.
async function recordFeed(env, kind, payload) {
  try {
    await env.DB.prepare("INSERT INTO notify_feed (kind, payload) VALUES (?, ?)").bind(kind, JSON.stringify({ ...payload, at: now() })).run();
    await env.DB.prepare("DELETE FROM notify_feed WHERE at < ?").bind(new Date(Date.now() - 3 * 864e5).toISOString()).run();
  } catch (_) {}
}
async function sendPush(env, data, opts = {}) {
  // The conversations this push shows (a summary names them in opts.keys): handling any of them from now on is news, not an echo.
  await forgetHandled(env, [...(data?.thread && data?.account && data.kind !== "dismiss" ? [`${data.account}|${data.thread}`] : []), ...(opts.keys || [])]).catch(() => {});
  await recordFeed(env, data?.kind || "mail", data || {});
  await sendFcm(env, data || {}, { high: true }).catch(() => {});
  if (!pushConfigured(env)) return { sent: 0, failed: 0, total: 0, skipped: "not configured" };
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions").all();
  // The ring rides on EVERY push now, not only the mail kinds it used to be limited to: a snooze, a reminder or an error is
  // just as good a lift as new mail, and carrying it costs nothing.
  const ring = await handledKeys(env);
  let sent = 0, failed = 0;
  for (const s of results) {
    const live = parseTags(s.live_tags);
    const carry = ring.filter((e) => e.by !== s.id && live.includes(e.k)).slice(0, DISMISS_MAX);
    const out = await pushOne(env, s, data, carry, opts);
    if (out === "sent") sent++; else if (out === "failed") failed++;
  }
  return { sent, failed, total: results.length };
}
// A dismissal of its own, for the case this whole mechanism exists to fix: mail dealt with somewhere else and no new
// mail coming to carry the news. It wakes ONLY a device that is actually holding one of these notifications. That is not an
// optimisation: a push handler that finishes with an empty shade spends Chromium push budget,
// so a dismissal sent to a device with nothing to close would force the "Inbox zero" placeholder for no reason at all.
// How long a dismissal waits for a phone that is asleep. NORMAL-priority FCM is held while the phone dozes and handed over when
// it wakes; at the old 600 s a phone left on a desk for more than ten minutes never heard that the mail was dealt with, and the
// notification stayed for good (A mail trashed on the Windows app at 14:11Z, four dismissals sent and accepted, all
// expired by 14:22; the phone's screen came on at 14:29 and its log shows the app frozen in between). Three days, the life of
// notify_feed: a dismissal for a notification already gone closes nothing and costs nothing.
const DISMISS_FCM_TTL = "259200s";
async function sendDismissPush(env, entries, why = "") {
  // The feed and the phone hear each conversation ONCE per ring window. An echo (the same key reported again a moment later)
  // used to go out as well (four FCM messages and four feed rows for one trashed mail) which mattered little at 600 s and
  // would pile up against FCM's queue of pending messages per device now that each one waits days.
  const news = (entries || []).filter((e) => !e.repeat);
  if (news.length) {
    const dismiss = { kind: "dismiss", dismiss: news.map((e) => ({ k: e.k, at: e.at })) };
    await recordFeed(env, "dismiss", dismiss);
    await fcmDismiss(env, news).catch(() => {});
  }
  if (!pushConfigured(env) || !entries?.length) return { sent: 0, failed: 0, skipped: 0, total: 0 };
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions").all();
  let sent = 0, failed = 0, skipped = 0;
  for (const s of results) {
    // Only a worker that carries the never-empty-shade rule may be sent a push that shows nothing: see migration 0024.
    // Everyone else keeps exactly what they had: the ring riding along on the next push of any kind.
    if (!parseTags(s.caps).includes("dismiss2")) { skipped++; continue; }
    const live = parseTags(s.live_tags);
    const carry = entries.filter((e) => e.by !== s.id && live.includes(e.k)).slice(0, DISMISS_MAX);
    if (!carry.length) { skipped++; continue; }
    const out = await pushOne(env, s, { kind: "dismiss" }, carry, { urgency: "high", ttl: 600 });
    if (out === "sent") sent++; else if (out === "failed") failed++;
  }
  if (sent || failed) await logEvent(env.DB, "push_dismiss", null, `${why || "handled"} ${entries.length} key(s); sent ${sent}, failed ${failed}, ${skipped} device(s) skipped (reported it, or had nothing on screen)`);
  return { sent, failed, skipped, total: results.length };
}

// ---------- Gatekeeper: sender rules shared by every account ----------
function matchSender(rules, addr, account) {
  const a = lc(addr); if (!a) return null;
  const dom = a.split("@")[1] || "";
  const pick = (only) => {
    let best = null;
    for (const r of rules || []) {
      if (!only(r)) continue;
      if (r.scope !== "*" && lc(r.scope) !== lc(account)) continue;
      const pat = lc(r.pattern);
      const hit = pat === a || (pat.startsWith("*@") && pat.slice(2) === dom);
      if (!hit) continue;
      if (!best || (r.scope !== "*" && best.scope === "*") || (pat === a && best.pattern.startsWith("*@"))) best = r;
      if (best && !best.category && r.category && (r.pattern === best.pattern)) best = { ...best, category: r.category };
    }
    return best;
  };
  // A rule with no action only files the sender under a category. It never decides the action: the rule that
  // does is chosen among the rules that have one, and the category still comes from the most specific rule, as before. With no such
  // rules this is the old answer exactly.
  const any = pick(() => true); if (!any || any.action) return any;
  const acted = pick((r) => !!r.action);
  return acted ? { ...acted, category: any.category ?? acted.category } : any;
}
const hdrVal = (msg, name) => (((msg || {}).payload || {}).headers || []).find((h) => lc(h.name) === lc(name))?.value || "";

// A Gmail message scheduled for later is built (and its Date stamped) when it is scheduled; it goes out with the time it is sent.
function restampDate(raw) {
  try {
    const bytes = unb64(String(raw).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
    let str = ""; for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const end = str.search(/\r?\n\r?\n/); if (end < 0) return raw;
    const head = str.slice(0, end).replace(/^Date:[^\r\n]*/im, `Date: ${new Date().toUTCString()}`);
    return btoa(head + str.slice(end)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (_) { return raw; }
}
// ---------- Scheduler: snooze / send later / reminders, run by the one-minute cron ----------
async function runScheduled(env) {
  const db = env.DB;
  // Stranded claims (a Worker interrupted mid-run) are failed and reported, never re-executed blindly (a send may have gone out).
  const { results: stale } = await db.prepare("SELECT id, kind, account FROM scheduled_actions WHERE status = 'running' AND claimed_at < ?").bind(new Date(Date.now() - 10 * 60_000).toISOString()).all();
  for (const s of stale) { await db.prepare("UPDATE scheduled_actions SET status = 'failed', error = 'stranded: the run was interrupted; check whether it happened before retrying', done_at = ? WHERE id = ?").bind(now(), s.id).run(); await logEvent(db, "scheduled_fail", null, `${s.kind} ${s.account} stranded`); await sendPush(env, { kind: "error", title: `${s.kind.replace("_", " ")} may not have completed`, body: "Open Scheduled to check", url: "/" }).catch(() => {}); }
  const { results } = await db.prepare("SELECT * FROM scheduled_actions WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 50").bind(now()).all();
  for (const a of results) {
    const claimed = await db.prepare("UPDATE scheduled_actions SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'pending'").bind(now(), a.id).run();
    if (!(claimed.meta?.changes)) continue;
    try {
      const payload = a.payload ? JSON.parse(a.payload) : {};
      if (a.kind === "snooze") {
        // Only a conversation still snoozed comes back. One Done, trashed or moved meanwhile stays put: the work mailbox was told
        // "inbox, unread" regardless, and "Snoozed mail is back" was pushed for mail that was not.
        if (a.account === "hub") {
          const back = await db.prepare("UPDATE threads SET state = 'inbox', unread = 1 WHERE id = ? AND state = 'snoozed'").bind(a.ref).run();
          if (!back.meta?.changes) { await db.prepare("UPDATE scheduled_actions SET status = 'done', done_at = ?, error = 'no longer snoozed; left where it is' WHERE id = ?").bind(now(), a.id).run(); await logEvent(db, "scheduled_done", null, `snooze hub ${a.ref} skipped (no longer snoozed)`); continue; }
          await imapQueueForThread(env, a.ref, { state: "inbox", unread: true });
        }
        else {
          const tok = await gmailAccessToken(env, a.account);
          let labels = []; try { const th = await gmailApi(tok.access_token, `threads/${encodeURIComponent(a.ref)}?format=minimal`); for (const mm of th.messages || []) labels.push(...(mm.labelIds || [])); } catch (e) { if (e.status === 404) { await db.prepare("UPDATE scheduled_actions SET status = 'done', done_at = ?, error = 'thread gone' WHERE id = ?").bind(now(), a.id).run(); continue; } throw e; }
          if (labels.includes("TRASH") || labels.includes("SPAM") || labels.includes("INBOX")) { await db.prepare("UPDATE scheduled_actions SET status = 'done', done_at = ?, error = ? WHERE id = ?").bind(now(), labels.includes("INBOX") ? "already in inbox" : "trashed meanwhile; not resurrected", a.id).run(); await logEvent(db, "scheduled_done", null, `snooze ${a.account} ${a.ref} skipped (${labels.includes("INBOX") ? "in inbox" : "trashed"})`); continue; }
          const removeIds = payload.labelId ? [payload.labelId] : [];
          await gmailApi(tok.access_token, `threads/${encodeURIComponent(a.ref)}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: ["INBOX", "UNREAD"], removeLabelIds: removeIds }) });
        }
        await sendPush(env, { kind: "snooze", account: a.account, ref: a.ref, title: "Snoozed mail is back", body: a.account === "hub" ? (payload.subject || "") : `in ${a.account}`, url: `/?account=${encodeURIComponent(a.account)}&thread=${encodeURIComponent(a.ref)}` });
      } else if (a.kind === "reminder") {
        if (payload.count && a.ref) { // Spark semantics: remind only if the thread did not grow (no reply)
          let n = null;
          if (a.account === "hub") n = (await db.prepare("SELECT message_count FROM threads WHERE id = ?").bind(a.ref).first())?.message_count ?? null;
          else { try { const tok = await gmailAccessToken(env, a.account); n = ((await gmailApi(tok.access_token, `threads/${encodeURIComponent(a.ref)}?format=minimal`)).messages || []).length; } catch (_) {} }
          if (n !== null && n > payload.count) { await db.prepare("UPDATE scheduled_actions SET status = 'done', done_at = ?, error = 'replied' WHERE id = ?").bind(now(), a.id).run(); await logEvent(db, "scheduled_done", null, `reminder ${a.account} ${a.ref} skipped: replied`); continue; }
        }
        await sendPush(env, { kind: "reminder", account: a.account, ref: a.ref, title: payload.title || "Reminder", body: a.account === "hub" ? (payload.note || payload.subject || "") : `in ${a.account}`, url: a.ref ? `/?account=${encodeURIComponent(a.account)}&thread=${encodeURIComponent(a.ref)}` : "/" });
      } else if (a.kind === "send_later") {
        const draft = JSON.parse(await openToken(env, payload.enc, payload.iv, a.id, "drafts"));
        let ref;
        if (a.account === "hub") { const r = draft.forward_of ? await forwardMessage(env, String(draft.forward_of), draft) : await sendMail(env, draft); ref = r.id || r.message_id || a.ref; }
        else { const tok = await gmailAccessToken(env, a.account); const r = await gmailApi(tok.access_token, "messages/send", { method: "POST", body: JSON.stringify({ raw: restampDate(draft.raw), ...(draft.threadId ? { threadId: draft.threadId } : {}) }) }); ref = r.id; }
        // Sent. Nothing after this may turn it into a failure: a ref write or a push that threw used to mark a sent message failed and
        // push "send later failed".
        try { await db.prepare("UPDATE scheduled_actions SET ref = ? WHERE id = ?").bind(ref, a.id).run(); } catch (_) {}
        try { await sendPush(env, { kind: "sent", account: a.account, title: "Scheduled message sent", body: draft.subject || "", url: "/" }); } catch (_) {}
      }
      await db.prepare("UPDATE scheduled_actions SET status = 'done', done_at = ?, payload = CASE WHEN kind = 'send_later' THEN NULL ELSE payload END WHERE id = ?").bind(now(), a.id).run();
      await logEvent(db, "scheduled_done", null, `${a.kind} ${a.account} ${a.ref || ""}`);
    } catch (e) {
      await db.prepare("UPDATE scheduled_actions SET status = 'failed', error = ?, done_at = ? WHERE id = ?").bind(String(e?.message || e).slice(0, 300), now(), a.id).run();
      await logEvent(db, "scheduled_fail", null, `${a.kind} ${a.account} ${a.ref || ""} ${e?.message}`);
      await sendPush(env, { kind: "error", title: `${a.kind.replace("_", " ")} failed`, body: String(e?.message || e).slice(0, 120), url: "/" }).catch(() => {});
    }
  }
  return results.length;
}

// ---------- Gmail: one-minute new-mail detection (push + Gatekeeper). Headers are read transiently; nothing is stored. ----------
const gmailTokenCache = new Map(); // email -> { access_token, exp } (per isolate; a miss just mints again)
async function gmailCachedToken(env, email) {
  const c = gmailTokenCache.get(email);
  if (c && c.exp - Date.now() > 120_000) return c.access_token;
  const tok = await gmailAccessToken(env, email);
  gmailTokenCache.set(email, { access_token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 });
  return tok.access_token;
}
async function gmailApi(accessToken, path, o = {}) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { ...o, headers: { authorization: "Bearer " + accessToken, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `http ${r.status}`), { status: r.status });
  return j;
}
// One account's slice of the poll, so a Pub/Sub push can run exactly the same path for a single mailbox without touching the others.
// ---------- Gmail push (Cloud Pub/Sub) ----------
// Gmail publishes one tiny notification per mailbox change to a Pub/Sub topic; Pub/Sub POSTs it here; this Worker then runs exactly the
// history delta the cron would have run, for that one mailbox. The watch must be renewed at least every 7 days (Google's guide says
// daily), and Google's guide also insists on a polling fallback, which is the ten-minute backstop in gmailPoll.
// Push is "configured" only when every lock is in place: the topic, the URL secret, the service account Pub/Sub signs as, and the
// audience. Leaving the identity optional would have let push run on the URL secret alone.
const gmailPushConfigured = (env) => !!(env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUSH_SECRET && env.GMAIL_PUSH_SA && env.GMAIL_PUSH_AUDIENCE);
async function gmailWatch(env, email) {
  if (!gmailPushConfigured(env)) return { skipped: "not configured" };
  const at = await gmailCachedToken(env, email);
  const r = await gmailApi(at, "watch", { method: "POST", body: JSON.stringify({ topicName: env.GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }) });
  const exp = r.expiration ? new Date(Number(r.expiration)).toISOString() : null;
  // A watch response carries the mailbox's current historyId. Only adopt it when we have no cursor: overwriting a live cursor would skip
  // everything that arrived between the last poll and this renewal.
  await env.DB.prepare("UPDATE gmail_accounts SET watch_expiration = ?, poll_history_id = COALESCE(poll_history_id, ?) WHERE email = ?").bind(exp, r.historyId ? String(r.historyId) : null, email).run();
  return { email, expiration: exp, historyId: r.historyId };
}
async function gmailWatchAll(env) {
  if (!gmailPushConfigured(env)) return [];
  const { results } = await env.DB.prepare("SELECT email FROM gmail_accounts WHERE status = 'active'").all();
  const out = [];
  for (const r of results) { try { out.push(await gmailWatch(env, r.email)); } catch (e) { out.push({ email: r.email, error: e?.message }); await logEvent(env.DB, "gmail_watch_fail", null, `${r.email} ${e?.message}`); } }
  const ok = out.filter((x) => x.expiration).length; if (ok) await logEvent(env.DB, "gmail_watch_ok", null, out.map((x) => `${x.email}${x.expiration ? " until " + x.expiration : " FAILED"}`).join("; "));
  return out;
}
// Google's OIDC token on the push request: RS256 over Google's published keys, the audience we configured on the subscription, and the
// service account we named. The secret in the URL is a second, independent lock, so a mistake in either one alone is not an opening.
let googleCerts = { at: 0, keys: [] };
const pushSeen = new Map(); // Pub/Sub message id -> when this isolate handled it, so a redelivery or replay is acked without repeating
async function googleJwks() {
  if (Date.now() - googleCerts.at < 3600_000 && googleCerts.keys.length) return googleCerts.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error(`google certs http ${r.status}`);
  const j = await r.json(); googleCerts = { at: Date.now(), keys: j.keys || [] }; return googleCerts.keys;
}
const b64uJson = (s) => JSON.parse(new TextDecoder().decode(unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))));
async function verifyGooglePushToken(env, token) {
  const parts = String(token || "").split("."); if (parts.length !== 3) return null;
  let header, claims;
  try { header = b64uJson(parts[0]); claims = b64uJson(parts[1]); } catch (_) { return null; }
  if (header.alg !== "RS256") return null;
  let jwk = (await googleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) { googleCerts = { at: 0, keys: [] }; jwk = (await googleJwks()).find((k) => k.kid === header.kid); } // Google rotated keys: refetch once before refusing
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const sig = unb64(parts[2].replace(/-/g, "+").replace(/_/g, "/") + "===".slice((parts[2].length + 3) % 4));
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  // Pub/Sub's audience field is optional: left blank, it signs with the full push endpoint URL, which carries our secret in its query.
  // Compare origin + path only, so both the explicit audience and the default form are accepted and a blank field cannot break setup.
  if (env.GMAIL_PUSH_AUDIENCE) { const norm = (u) => { try { const x = new URL(String(u)); return x.origin + x.pathname; } catch (_) { return String(u || ""); } }; if (norm(claims.aud) !== norm(env.GMAIL_PUSH_AUDIENCE)) return null; }
  if (!env.GMAIL_PUSH_SA || claims.email !== env.GMAIL_PUSH_SA) return null;   // the signing identity is mandatory, never "checked if set"
  if (claims.email_verified === false) return null;
  return claims;
}
// Fold one page of Gmail history into (a) the inbox messages that are genuinely new and (b) a verdict per thread: has this
// conversation been DEALT WITH since the cursor (trashed, archived or read) wherever that happened, mailhub, the Gmail app
// or gmail.com. Records arrive in history order, so the LAST word on a thread wins: read and then marked unread again is NOT
// handled, and a thread that receives a new message is back in play even if an older message in it was just trashed.
// `state` is carried across pages by the caller, because the last word may be on a later page than the first.
export function foldHistory(history, state) {
  const added = [];
  for (const h of history || []) {
    for (const m of h.messagesAdded || []) if ((m.message?.labelIds || []).includes("INBOX")) { added.push(m.message); if (m.message.threadId) state.set(m.message.threadId, false); }
    for (const e of h.labelsRemoved || []) { const t = e.message?.threadId, l = e.labelIds || []; if (t && (l.includes("INBOX") || l.includes("UNREAD"))) state.set(t, true); }
    for (const e of h.labelsAdded || []) { const t = e.message?.threadId, l = e.labelIds || []; if (!t) continue;
      if (l.includes("TRASH") || l.includes("SPAM")) state.set(t, true);
      if (l.includes("INBOX") || l.includes("UNREAD")) state.set(t, false); }
    for (const e of h.messagesDeleted || []) { const t = e.message?.threadId; if (t) state.set(t, true); }
  }
  return added;
}
// One poll per Gmail mailbox at a time. A burst of Pub/Sub notifications starts a poll
// each, and the ten-minute cron backstop can land on top: overlapping runs fetched the same history and metadata and ran the sender
// rules twice; only the cursor claim kept them from notifying twice (gmail_poll_dup, up to 11 a day). Now a run that finds the
// mailbox being polled leaves a "poll again" flag and returns; the holder polls once more after it releases, so a change that
// arrived mid-poll is never left for the next backstop. A run that dies holding the lease loses it after GMAIL_POLL_LEASE_MS.
const GMAIL_POLL_LEASE_MS = 60_000;
export async function withMailboxLease(db, email, fn, { rounds = 5 } = {}) {
  const take = async () => { const token = uuid(); const r = await db.prepare("UPDATE gmail_accounts SET poll_lease_until = ?, poll_lease_token = ?, poll_again = 0 WHERE email = ? AND (poll_lease_until IS NULL OR poll_lease_until < ?)").bind(Date.now() + GMAIL_POLL_LEASE_MS, token, email, Date.now()).run(); return r.meta?.changes ? token : null; };
  let token;
  try { token = await take(); }
  catch (e) { if (/no such column/i.test(String(e?.message))) return fn(); throw e; }   // before migration 0034: poll as before, unleased
  if (!token) {
    await db.prepare("UPDATE gmail_accounts SET poll_again = 1 WHERE email = ?").bind(email).run();
    token = await take();   // the holder may have let go between the two statements; then nobody would see the flag
    if (!token) return { a: email, queued: "another poll of this mailbox is running; it polls again when it finishes" };
  }
  let out;
  for (let round = 0; round < rounds && token; round++) {
    try { out = await fn(); }
    finally { await db.prepare("UPDATE gmail_accounts SET poll_lease_until = NULL, poll_lease_token = NULL WHERE email = ? AND poll_lease_token = ?").bind(email, token).run().catch(() => {}); token = null; }
    const again = await db.prepare("UPDATE gmail_accounts SET poll_again = 0 WHERE email = ? AND poll_again = 1").bind(email).run();
    if (!again.meta?.changes) break;
    token = await take();   // asked for while we held it; if another run took the lease meanwhile, that run does the poll
  }
  return out;
}
export async function gmailPollAccount(env, a, rules, policy) {
  // The cursor is read inside the lease: a run that waited reads the one the previous holder left, not the one it was handed.
  // The mirror runs first, so the notification poll below finds each new message's metadata already stored, and a
  // mirror failure never costs a notification.
  return withMailboxLease(env.DB, a.email, async () => {
    let mirror = null;
    try { mirror = await gmailMirrorOnce(env, a.email); } catch (e) { mirror = { error: String(e?.message || e).slice(0, 200) }; await logEvent(env.DB, "gmail_mirror_fail", null, `${a.email} ${mirror.error}`); }
    const spam = mirror?.spam || []; if (mirror) delete mirror.spam;
    const out = await gmailPollOnce(env, (await env.DB.prepare("SELECT email, poll_history_id, watch_expiration, last_poll_at FROM gmail_accounts WHERE email = ?").bind(a.email).first()) || a, rules, policy, { spam });
    return mirror ? { ...out, mirror } : out;
  });
}
// ---------- Gmail metadata mirror ----------
// The hub follows Gmail and every device follows the hub. A device closed for days used to replay Gmail's history and download every
// new message itself (A browser showed 188 unread for minutes while Gmail had 1). The hub now keeps each message's METADATA:
// labels, the 13 headers the client lists by, and the snippet. It covers the 90-day window, every unread inbox message, and any message
// that enters the inbox while followed. Its changes ride the thread_changes feed as 'g|<account>|<id>', so a device catches up on
// domain mail and Gmail in one request.
// Its rules:
//  - every write of a run is conditioned on the cursor and progress the run started from, so a run that outlived its lease writes
//  nothing;
//  - every Gmail deletion writes an explicit 'd'. A row that only ages out becomes a STUB (labels, no meta), and stubs go after 31 days,
//  past the feed's 30, so no live 'u' event points at a row that is gone;
//  - gets are capped at GMAIL_MIRROR_GETS a minute per account, across rounds and runs;
//  - Gmail's history omits some arrivals, so the hub re-lists the last two days every ten minutes and the unread inbox
//  daily, as the devices did, and fetches what it lacks;
//  - labels carry the history id that set them, and an older record never overwrites a newer one.
// No bodies, attachments, raw MIME or drafts are stored. Gmail stays the system of record; the user's actions still go device → Gmail.
// GETS: 150 a minute is 3,000 quota units, half the per-user minute the devices and the notification poll share.
const GMAIL_MIRROR_DAYS = 90, GMAIL_MIRROR_GETS = 150, GMAIL_MIRROR_PAGES = 50, GMAIL_STUB_DAYS = 31;
const GMAIL_META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted", "Message-ID", "In-Reply-To", "References", "List-Unsubscribe-Post"];
const GMAIL_META_QS = "format=metadata&" + GMAIL_META_HEADERS.map((h) => "metadataHeaders=" + h).join("&");
const gmailIdMs = (id) => parseInt(String(id || "").slice(0, -5), 16) || 0;   // id >> 20 is never earlier than internalDate (30 samples)
const gmailMirrorOn = (env) => env.GMAIL_MIRROR !== "off";
// In the mirror: anything in the inbox, read or unread, and anything inside the window. Drafts never.
const gmailMirrorScope = (labels, ms, cutoff) => !labels.includes("DRAFT") && (labels.includes("INBOX") || (ms || 0) >= cutoff);
const parseJsonOr = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
// The per-account get budget, kept in mirror_progress so it holds across rounds of the lease and runs within the same minute.
const gmailBudget = (p) => { const m = Math.floor(Date.now() / 60_000); if (p.bm !== m) { p.bm = m; p.bu = 0; } return Math.max(0, GMAIL_MIRROR_GETS - (p.bu || 0)); };
// Gmail's batch endpoint: up to 100 gets in one HTTP call (each still costs its own quota). It returns what came back, what Gmail says is
// gone (404), and what failed otherwise, so a throttled get is never mistaken for a deleted message.
export async function gmailBatchGet(at, ids, qs) {
  const found = [], gone = [], failed = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100), boundary = "hub_" + uuid().replace(/-/g, "");
    const body = chunk.map((id, k) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <i${k}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${qs}\r\n\r\n`).join("") + `--${boundary}--\r\n`;
    let r; try { r = await fetch("https://gmail.googleapis.com/batch/gmail/v1", { method: "POST", headers: { authorization: "Bearer " + at, "content-type": `multipart/mixed; boundary=${boundary}` }, body }); } catch (_) { failed.push(...chunk); continue; }
    if (!r.ok) { failed.push(...chunk); continue; }
    const bm = (r.headers.get("content-type") || "").match(/boundary=([^;]+)/), text = await r.text(), seen = new Set();
    for (const part of text.split("--" + (bm ? bm[1].replace(/"/g, "") : boundary)).slice(1, -1)) {
      const k = (part.match(/Content-ID:\s*<response-i(\d+)>/i) || [])[1], id = k !== undefined ? chunk[Number(k)] : null;
      const status = Number((part.match(/HTTP\/[\d.]+ (\d{3})/) || [])[1] || 0);
      const j = part.indexOf("{"); let obj = null; if (j >= 0) { try { obj = JSON.parse(part.slice(j, part.lastIndexOf("}") + 1)); } catch (_) {} }
      const mid = (status === 200 && obj?.id) || id; if (!mid || !chunk.includes(mid)) continue; seen.add(mid);
      if (status === 200 && obj?.id) found.push(obj); else if (status === 404) gone.push(mid); else failed.push(mid);
    }
    for (const id of chunk) if (!seen.has(id)) failed.push(id);
  }
  return { found, gone, failed };
}
// One run's writes, as one D1 batch (a transaction). Each statement takes a JSON array of at most 100 messages, so the
// statement count does not grow with the message count. Every statement is conditioned on the account still holding the
// cursor and progress the run started from, and the cursor moves last.
export async function gmailMirrorCommit(db, a, w) {
  // The guard compares the cursor and a small progress VERSION, not the progress text itself, and every JSON parameter stays under about
  // 50 KB as well as 100 rows: D1 documents a 100 KB statement limit without saying whether bound parameters count.
  const pv = parseJsonOr(a.mirror_progress, {}).v ?? null, ts = now(), cas = [a.email, a.mirror_history_id ?? null, pv];
  const guard = "EXISTS (SELECT 1 FROM gmail_accounts WHERE email = ? AND mirror_history_id IS ? AND json_extract(mirror_progress, '$.v') IS ?)";
  const newer = (t, x) => `(${t}.history_id IS NULL OR ${x} IS NULL OR CAST(${t}.history_id AS INTEGER) <= CAST(${x} AS INTEGER))`;
  const chunks = (xs) => { const out = []; let cur = [], size = 2; for (const x of xs) { const n = JSON.stringify(x).length + 1; if (cur.length && (cur.length >= 100 || size + n > 50_000)) { out.push(cur); cur = []; size = 2; } cur.push(x); size += n; } if (cur.length) out.push(cur); return out; };
  w.progress = { ...w.progress, v: (pv || 0) + 1 };
  const st = [];
  // The changed list is materialized first, so each message is found by its primary key: as `FROM (SELECT...) AS j` SQLite walked the
  // account's whole date index to change a few (~7,600 rows a run in production; 67.6 ms -> 0.11 ms locally).
  for (const c of chunks(w.relabel || [])) st.push(db.prepare(`WITH j AS MATERIALIZED (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.l') AS l, json_extract(value, '$.h') AS h FROM json_each(?)) UPDATE gmail_messages SET labels = j.l, history_id = COALESCE(j.h, gmail_messages.history_id), updated_at = ? FROM j WHERE gmail_messages.account = ? AND gmail_messages.id = j.id AND ${newer("gmail_messages", "j.h")} AND ${guard}`).bind(JSON.stringify(c), ts, a.email, ...cas));
  for (const c of chunks(w.stubs || [])) st.push(db.prepare(`INSERT INTO gmail_messages (account, id, thread_id, labels, internal_date, meta, history_id, updated_at) SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.t'), json_extract(value, '$.l'), NULL, NULL, json_extract(value, '$.h'), ? FROM json_each(?) WHERE ${guard} ON CONFLICT(account, id) DO UPDATE SET labels = excluded.labels, history_id = COALESCE(excluded.history_id, gmail_messages.history_id), updated_at = excluded.updated_at WHERE ${newer("gmail_messages", "excluded.history_id")}`).bind(a.email, ts, JSON.stringify(c), ...cas));
  for (const c of chunks(w.full || [])) st.push(db.prepare(`INSERT INTO gmail_messages (account, id, thread_id, labels, internal_date, meta, history_id, updated_at) SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.t'), json_extract(value, '$.l'), json_extract(value, '$.d'), json_extract(value, '$.m'), json_extract(value, '$.h'), ? FROM json_each(?) WHERE ${guard} ON CONFLICT(account, id) DO UPDATE SET thread_id = excluded.thread_id, labels = excluded.labels, internal_date = excluded.internal_date, meta = excluded.meta, history_id = excluded.history_id, updated_at = excluded.updated_at WHERE ${newer("gmail_messages", "excluded.history_id")}`).bind(a.email, ts, JSON.stringify(c), ...cas));
  for (const c of chunks(w.gone || [])) {
    const j = JSON.stringify(c);
    st.push(db.prepare(`DELETE FROM gmail_messages WHERE account = ? AND id IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(a.email, j, ...cas));
    st.push(db.prepare(`INSERT INTO thread_changes (thread_id, op, at) SELECT 'g|' || ? || '|' || value, 'd', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM json_each(?) WHERE ${guard}`).bind(a.email, j, ...cas));
  }
  st.push(db.prepare("UPDATE gmail_accounts SET mirror_state = ?, mirror_history_id = ?, mirror_progress = ?, mirror_synced_at = CASE WHEN ? THEN ? ELSE mirror_synced_at END WHERE email = ? AND mirror_history_id IS ? AND json_extract(mirror_progress, '$.v') IS ?")
    .bind(w.state, w.cursor ?? null, JSON.stringify(w.progress), w.synced ? 1 : 0, ts, ...cas));
  const res = await db.batch(st);
  return res[res.length - 1]?.meta?.changes || 0;
}
// One run for one account, inside its mailbox lease. Returns null when the mirror is off or the migration is not applied yet.
export async function gmailMirrorOnce(env, email) {
  if (!gmailMirrorOn(env)) return null;
  const db = env.DB;
  let a; try { a = await db.prepare("SELECT email, mirror_state, mirror_history_id, mirror_progress FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(email).first(); }
  catch (e) { if (/no such column/i.test(String(e?.message))) return null; throw e; }
  if (!a) return null;
  const at = await gmailCachedToken(env, email);
  if (a.mirror_state !== "ready") return gmailMirrorBackfill(db, at, a);
  const p = parseJsonOr(a.mirror_progress, {}), owed = new Map((p.owed || []).map((o) => [o.id, o]));
  // Fold every record, in history order, per message. The last word wins: a label record carries the message's whole label set.
  const fold = new Map(); let page = null, pages = 0, r = null, last = null;
  try {
    do {
      r = await gmailApi(at, `history?startHistoryId=${encodeURIComponent(a.mirror_history_id)}&maxResults=500${page ? "&pageToken=" + encodeURIComponent(page) : ""}`);
      for (const h of r.history || []) {
        last = h.id || last;
        for (const x of h.messagesAdded || []) { const m = x.message || {}; if (!m.id) continue; const f = fold.get(m.id); fold.set(m.id, { id: m.id, t: m.threadId || f?.t, l: m.labelIds || f?.l || [], h: h.id, add: 1 }); }
        for (const x of [...(h.labelsAdded || []), ...(h.labelsRemoved || [])]) { const m = x.message || {}; if (!m.id) continue; const f = fold.get(m.id); fold.set(m.id, { id: m.id, t: m.threadId || f?.t, l: m.labelIds || f?.l || [], h: h.id, add: f?.add || 0 }); }
        for (const x of h.messagesDeleted || []) { const m = x.message || {}; if (!m.id) continue; const f = fold.get(m.id); fold.set(m.id, { id: m.id, t: m.threadId || f?.t, del: 1, draft: (f?.l || m.labelIds || []).includes("DRAFT") }); }
      }
      page = r.nextPageToken || null;
    } while (page && ++pages < GMAIL_MIRROR_PAGES);
  } catch (e) {
    if (e.status !== 404) throw e;
    // Gmail no longer has history from our cursor: rebuild from a fresh listing. Rows stay; the rebuild's gets replace them, and its
    // sweep re-checks the ones the listing no longer returns. Devices are told the account is updating meanwhile.
    await db.prepare("UPDATE gmail_accounts SET mirror_state = 'backfill', mirror_history_id = NULL, mirror_progress = ? WHERE email = ? AND mirror_history_id IS ?").bind(JSON.stringify({ rebuild: 1, pics: p.pics || [] }), email, a.mirror_history_id).run();
    await logEvent(db, "gmail_mirror_reset", null, `${email} history cursor expired; rebuilding the mirror`);
    return { a: email, mirror: "rebuild" };
  }
  // A run that stopped with pages left resumes after the last record it read. A partial page's historyId is the mailbox's CURRENT id
  // (Gmail 2026-10-07: 51352436 on a page of records 51295363-51295410), so adopting it would skip the rest.
  const cursor = page ? (last || a.mirror_history_id) : String(r?.historyId || last || a.mirror_history_id);
  const ids = [...fold.keys()], held = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { results } = await db.prepare("SELECT id, meta IS NOT NULL AS full FROM gmail_messages WHERE account = ? AND id IN (SELECT value FROM json_each(?))").bind(email, JSON.stringify(ids.slice(i, i + 100))).all();
    for (const x of results) held.set(x.id, !!x.full);
  }
  const cutoff = Date.now() - GMAIL_MIRROR_DAYS * 864e5, relabel = [], stubs = [], gone = [];
  for (const f of fold.values()) {
    if (f.del) { owed.delete(f.id); if (!(f.draft && !held.has(f.id))) gone.push(f.id); continue; }   // every deletion is told, held or not
    if (f.l.includes("DRAFT")) continue;
    if (held.get(f.id) === true) { relabel.push({ id: f.id, l: f.l, h: f.h }); continue; }
    if (f.add || gmailMirrorScope(f.l, gmailIdMs(f.id), cutoff)) { owed.set(f.id, { id: f.id, t: f.t }); if (held.has(f.id)) relabel.push({ id: f.id, l: f.l, h: f.h }); continue; }
    if (held.has(f.id)) relabel.push({ id: f.id, l: f.l, h: f.h }); else stubs.push({ id: f.id, t: f.t, l: f.l, h: f.h });   // outside the mirror: labels only, for a device that holds it
  }
  // What history never reported: the last two days every ten minutes, the unread inbox daily.
  const t0 = Date.now(), goneNow = new Set(gone);
  if (t0 - (p.rc || 0) > 10 * 60_000) { p.rc = t0; await gmailMirrorRelist(db, at, email, `includeSpamTrash=true&q=${encodeURIComponent("newer_than:2d -in:drafts")}`, owed, goneNow); }
  // The unread pass re-reads a stored copy that does not say INBOX and UNREAD while Gmail lists it as both: history missed a label change
  // on it, and counting it as held left it read on every device for good.
  if (t0 - (p.ru || 0) > 24 * 3600e3) { p.ru = t0; await gmailMirrorRelist(db, at, email, "labelIds=INBOX&labelIds=UNREAD", owed, goneNow, ["INBOX", "UNREAD"]); }
  const full = gmailMirrorFetched(await gmailMirrorFetch(at, p, [...owed.keys()]), owed, held, cutoff, { relabel, stubs, gone });
  p.owed = [...owed.values()];
  if (p.pics?.length) { try { await gmailPicFill(env, at, email, p); } catch (_) {} }   // before the commit, which keeps what it took
  const wrote = await gmailMirrorCommit(db, a, { state: "ready", cursor, progress: p, synced: !page, ...gmailMirrorDedupe({ full, relabel, stubs, gone }) });
  if (!wrote) return { a: email, mirror: "another run moved the cursor first; nothing written" };
  // What arrived in Spam this run, for the poll's mention rules. Only the run that wrote hands it over, so each arrival
  // is handed over once; the last record of the run decides, so a message moved out of Spam in the same minute is not in it.
  const spam = [...fold.values()].filter((f) => f.add && !f.del && (f.l || []).includes("SPAM")).map((f) => f.id);
  return { a: email, mirror: { changes: fold.size, full: full.length, relabel: relabel.length, stubs: stubs.length, gone: gone.length, owed: owed.size, more: !!page }, ...(spam.length ? { spam } : {}) };
}
async function gmailMirrorRelist(db, at, email, query, owed, gone, want = []) {
  const ids = []; let page = null;
  for (let i = 0; i < 5; i++) { const l = await gmailApi(at, `messages?maxResults=500&${query}${page ? "&pageToken=" + encodeURIComponent(page) : ""}`); ids.push(...(l.messages || []).map((m) => m.id)); page = l.nextPageToken || null; if (!page) break; }
  const have = new Set();
  for (let i = 0; i < ids.length; i += 100) { const { results } = await db.prepare("SELECT id, labels FROM gmail_messages WHERE account = ? AND meta IS NOT NULL AND id IN (SELECT value FROM json_each(?))").bind(email, JSON.stringify(ids.slice(i, i + 100))).all(); for (const x of results) { if (want.length) { const l = parseJsonOr(x.labels, []); if (!want.every((w) => l.includes(w))) continue; } have.add(x.id); } }
  for (const id of ids) if (!have.has(id) && !gone.has(id) && !owed.has(id)) owed.set(id, { id });
}
async function gmailMirrorFetch(at, p, ids) {
  const take = ids.slice(0, gmailBudget(p));
  if (!take.length) return { found: [], gone: [], failed: [] };
  p.bu = (p.bu || 0) + take.length;
  return gmailBatchGet(at, take, GMAIL_META_QS);
}
// Sorts what a batch of gets returned: in scope → a full row; out of scope → labels only; gone → deleted. A failed get stays owed.
function gmailMirrorFetched(got, owed, held, cutoff, w) {
  const full = [];
  for (const m of got.found) {
    owed.delete(m.id); const l = m.labelIds || []; if (l.includes("DRAFT")) continue;
    // When it reached the mailbox: the later of internalDate and the id's own time. Spam can carry a 1970 internalDate (five in
    // sam.owner.sxsw@gmail.com's Spam on 2026-10-07, ids from this month), and by internalDate alone it would never be in the window.
    const d = Math.max(Number(m.internalDate) || 0, gmailIdMs(m.id)) || null, h = m.historyId ? String(m.historyId) : null;
    if (gmailMirrorScope(l, d, cutoff)) full.push({ id: m.id, t: m.threadId, l, d, m, h });
    else if (held.has(m.id)) w.relabel.push({ id: m.id, l, h }); else w.stubs.push({ id: m.id, t: m.threadId, l, h });
  }
  for (const id of got.gone) { owed.delete(id); w.gone.push(id); }
  return full;
}
// A message is written once per run: a get beats a record, and a deletion beats both.
function gmailMirrorDedupe({ full, relabel, stubs, gone }) {
  const g = new Set(gone), f = new Set(full.map((x) => x.id));
  return { full: full.filter((x) => !g.has(x.id)), relabel: relabel.filter((x) => !g.has(x.id) && !f.has(x.id)), stubs: stubs.filter((x) => !g.has(x.id) && !f.has(x.id)), gone: [...g] };
}
// ---------- the picture fill ----------
// A Gmail message the mirror brings in without an arrival (an account's first fill, or a rebuild after Gmail expired the cursor) never
// had its pictures saved, and one received in the picture window (since the queue began, and in the last 90 days) is never fetched at an
// open, so a newly connected account's recent mail showed no pictures at all. Each such mail is noted, newest first, and read in full
// one minute's batch at a time once the mirror is ready; its pictures are queued for the cron's drain, as an arrival would have queued
// them. The fill waits while under half of the day's picture allowance is left, so mail arriving now keeps its pictures first.
const GMAIL_PIC_SKIP = new Set(["SPAM", "TRASH", "SENT", "DRAFT"]), GMAIL_PIC_MAX = 5000, GMAIL_PIC_PER_RUN = 10, GMAIL_PIC_MS = 8_000;
const gmailPicSince = () => Math.max(IMG_OPEN_SINCE, Date.now() - IMG_KEEP_MS);
// [[id, received ms]], newest first, each id once, the newest GMAIL_PIC_MAX kept.
function gmailPicsAdd(list, add) {
  if (!add.length) return list || [];
  const by = new Map((list || []).map((x) => [x[0], x])); for (const x of add) by.set(x[0], x);
  return [...by.values()].sort((a, b) => b[1] - a[1]).slice(0, GMAIL_PIC_MAX);
}
async function gmailPicFill(env, at, email, p) {
  p.pics = (p.pics || []).filter((x) => x[1] >= gmailPicSince());   // past the window: fetched at an open now, nothing to save
  if (!p.pics.length) return 0;
  const left = await prefetchAllowance(env);
  if (left.images < PREFETCH_DAY_IMAGES / 2 || left.bytes < PREFETCH_DAY_BYTES / 2) return 0;
  const until = Date.now() + GMAIL_PIC_MS; let n = 0, queued = 0;
  while (p.pics.length && n < GMAIL_PIC_PER_RUN && Date.now() < until) {
    const id = p.pics[0][0];
    try {
      const m = await gmailApi(at, `messages/${encodeURIComponent(id)}?format=full`);
      const html = (m.labelIds || []).some((l) => GMAIL_PIC_SKIP.has(l)) ? "" : gmailHtmlPart(m.payload);
      if (html) queued += (await prefetchImages(env, html, `gmail:${email}:${id}`, { queueOnly: true, from: addrOnly(hdrVal(m, "From")) })).queued || 0;
    } catch (e) {
      // gone (404) is done with; another failure is tried again next minute, and a message that fails three runs running is let go
      if (e.status !== 404 && (p.picTries = (p.picTries || 0) + 1) < 3) break;
    }
    p.pics.shift(); p.picTries = 0; n++;
  }
  if (n) await logEvent(env.DB, "gmail_pic_fill", null, `${email} read=${n} queued=${queued} left=${p.pics.length}`);
  return n;
}
// The first fill, and the rebuild after Gmail expires our cursor. The cursor is taken FIRST and history is replayed from it once the
// listing is fetched, so nothing that changes during the fill is missed. Gets share the per-minute budget; progress is durable.
async function gmailMirrorBackfill(db, at, a) {
  const email = a.email, p = parseJsonOr(a.mirror_progress, {});
  if (!p.start) { const prof = await gmailApi(at, "profile"); Object.assign(p, { start: String(prof.historyId), started: now(), q: 0, page: null, todo: [], n: 0 }); }
  const QUERIES = [`includeSpamTrash=true&q=${encodeURIComponent(`newer_than:${GMAIL_MIRROR_DAYS}d -in:drafts`)}`, "labelIds=INBOX&labelIds=UNREAD"];
  const queued = new Set(p.todo);
  for (let calls = 0; p.q < QUERIES.length && calls < 20; calls++) {
    const l = await gmailApi(at, `messages?maxResults=500&${QUERIES[p.q]}${p.page ? "&pageToken=" + encodeURIComponent(p.page) : ""}`);
    for (const m of l.messages || []) if (!queued.has(m.id)) { queued.add(m.id); p.todo.push(m.id); p.n++; }
    p.page = l.nextPageToken || null; if (!p.page) p.q++;
  }
  if (p.q >= QUERIES.length && !p.todo.length && !p.swept) {
    // Every listed message has been fetched, so its row was written after the fill started. A row not written since is one Gmail no
    // longer lists: it is re-checked, a 404 deletes it and anything else is refreshed. `<=`, because the clock is in
    // milliseconds: re-checking one row too many costs a get, missing one would keep a deleted message.
    const { results } = await db.prepare("SELECT id FROM gmail_messages WHERE account = ? AND meta IS NOT NULL AND updated_at <= ?").bind(email, p.started).all();
    p.todo.push(...results.map((x) => x.id));
    p.swept = 1;
  }
  const held = new Map(); const take = p.todo.slice(0, GMAIL_MIRROR_GETS);
  for (let i = 0; i < take.length; i += 100) { const { results } = await db.prepare("SELECT id, meta IS NOT NULL AS full FROM gmail_messages WHERE account = ? AND id IN (SELECT value FROM json_each(?))").bind(email, JSON.stringify(take.slice(i, i + 100))).all(); for (const x of results) held.set(x.id, !!x.full); }
  const todo = new Map(p.todo.map((id) => [id, { id }])), w = { relabel: [], stubs: [], gone: [] };
  const got = await gmailMirrorFetch(at, p, p.todo);
  const full = gmailMirrorFetched(got, todo, held, Date.now() - GMAIL_MIRROR_DAYS * 864e5, w);
  for (const id of got.found.map((m) => m.id).concat(got.gone)) todo.delete(id);
  p.todo = [...todo.keys()];
  // Mail this fill brings in that the hub never had: its pictures were never saved, and one of the picture window is never fetched at
  // an open, so it is noted for gmailPicFill. A rebuild's rows already held came by the poll and are not noted.
  const picSince = gmailPicSince();
  p.pics = gmailPicsAdd(p.pics, full.filter((x) => !held.has(x.id) && (x.d || 0) >= picSince && !x.l.some((l) => GMAIL_PIC_SKIP.has(l))).map((x) => [x.id, x.d]));
  const done = p.q >= QUERIES.length && !p.todo.length && !!p.swept;
  const progress = done ? { owed: [], bm: p.bm, bu: p.bu, pics: p.pics } : p;
  const wrote = await gmailMirrorCommit(db, a, { state: done ? "ready" : "backfill", cursor: done ? p.start : null, progress, synced: false, ...gmailMirrorDedupe({ full, ...w }) });
  if (done && wrote) await logEvent(db, "gmail_mirror_ready", null, `${email} ${p.n} listed; history replays from ${p.start}`);
  return { a: email, mirror: { backfill: true, listed: p.n, fetched: full.length, todo: p.todo.length, ready: done && !!wrote } };
}
// Daily: a row that left the inbox and the window keeps only its labels (a stub), and stubs go once the feed has forgotten them.
async function gmailMirrorPrune(env) {
  try {
    const cutoff = Date.now() - GMAIL_MIRROR_DAYS * 864e5, ts = now();
    const a = await env.DB.prepare(`UPDATE gmail_messages SET meta = NULL, updated_at = ? WHERE meta IS NOT NULL AND internal_date < ? AND labels NOT LIKE '%"INBOX"%'`).bind(ts, cutoff).run();
    const b = await env.DB.prepare("DELETE FROM gmail_messages WHERE meta IS NULL AND updated_at < ?").bind(new Date(Date.now() - GMAIL_STUB_DAYS * 864e5).toISOString()).run();
    if (a.meta?.changes || b.meta?.changes) await logEvent(env.DB, "gmail_mirror_prune", null, `${a.meta?.changes || 0} aged to labels only, ${b.meta?.changes || 0} stubs removed`);
  } catch (e) { if (!/no such table/i.test(String(e?.message))) await logEvent(env.DB, "gmail_mirror_prune_fail", null, String(e?.message || e).slice(0, 200)); }
}
// What a device needs to know about each Gmail account's mirror: whether it can switch, how fresh it is, and how much is still owed.
// GMAIL_MIRROR=shadow keeps the mirror running while telling devices nothing, so it can be checked against Gmail before any device
// relies on it; "off" stops it AND tells devices nothing, so a switched device goes back to Gmail instead of waiting on a frozen
// mirror. A device told nothing (state null) syncs Gmail directly, as before.
async function gmailMirrorStatus(db, env) {
  try {
    const { results } = await db.prepare("SELECT email, mirror_state, mirror_synced_at, mirror_progress FROM gmail_accounts WHERE status = 'active'").all();
    const out = {}, hidden = env?.GMAIL_MIRROR === "shadow" || env?.GMAIL_MIRROR === "off";
    for (const r of results) { const p = parseJsonOr(r.mirror_progress, {}); out[r.email] = { state: hidden ? null : r.mirror_state || null, synced_at: r.mirror_synced_at || null, owed: (p.owed || []).length + (p.todo || []).length }; }
    return out;
  } catch (_) { return {}; }
}
// ---------- "delete unless it mentions" rules ----------
// New mail in a Gmail account from a sender on one of these rules is read in full when it arrives. If it mentions one of the rule's
// words it stays and notifies as priority, and one that arrived in Spam is moved to the inbox; if it does not, it goes to Gmail's
// trash, which keeps it 30 days. Each message is decided once (mention_decisions). Nothing is deleted when the mail could not be read
// in full, has almost no text of its own, is in a conversation the user wrote in, or was already moved by the user.
const MENTION_WORDS_MAX = 10, MENTION_RUN_MAX = 40, MENTION_MIN_TEXT = 20, MENTION_CHECK_MAX = 100;
const MENTION_HUB = "hub";   // a rule's scope for mail outside Gmail: your own domains and the work mailbox // CHECK_MAX: app.js MENTION_CHECK_MAX
// Read at most once per run, and only when a run has new mail. Before migration 0040 the table is missing: no rules, nothing deleted.
function mentionRulesLoader(db) { let p = null; return () => (p ??= db.prepare("SELECT id, pattern, scope, words FROM mention_rules").all().then((r) => r.results.map((x) => ({ ...x, words: parseJsonOr(x.words, []) }))).catch(() => [])); }
// The most specific rule for this sender in this account. Specificity first: an address beats any domain, and a longer domain beats a
// shorter one. Only between rules equally specific does a rule for this account beat one for every account (as the sender rules' hint
// in Settings says). "*@example.com" covers example.com and its subdomains, never notexample.com.
export function matchMention(rules, addr, account) {
  const a = lc(addr), dom = a.split("@")[1] || ""; if (!dom) return null;
  let best = null, bestScore = -1;
  for (const r of rules || []) {
    if (r.scope !== "*" && lc(r.scope) !== lc(account)) continue;
    const p = lc(r.pattern), d = p.startsWith("*@") ? p.slice(2) : null;
    const s = p === a ? 1e6 : d && (dom === d || dom.endsWith("." + d)) ? d.length : -1;
    if (s < 0) continue;
    if (s * 2 + (r.scope !== "*" ? 1 : 0) > bestScore) { best = r; bestScore = s * 2 + (r.scope !== "*" ? 1 : 0); }
  }
  return best;
}
// A domain a rule may not name: a public mailbox (every sender there is a different person) or a public suffix such as co.uk, which with
// subdomains would cover a whole country's mail.
const MENTION_DOMAIN_REFUSED = /^((gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|mac|aol|proton|protonmail|pm|hey|fastmail|msn|comcast|att|verizon|sbcglobal|mail|gmx|yandex|zoho)\.(com|net|me|ch|ru|de|co\.uk)|(co|com|net|org|gov|edu|ac|or|ne|go|ltd|plc|nom|gob|mil)\.[a-z]{2})$/;   // the first half is app.js PUBLIC_MAILBOX
// The text of a Gmail message (format=full): every text/plain, text/html and text/calendar part that is not an attachment. Gmail hands
// these back already decoded from quoted-printable and base64, and its header values decoded from RFC 2047 (probed on 4 real mails
// ); each part is decoded here with its own charset. A text part Gmail keeps apart (an attachmentId instead of data) is not
// fetched, so `complete` says whether all of it was read. `labels` and `thread` are the message's as of this get.
export function gmailMessageText(msg) {
  const out = { plain: [], html: [], complete: true, labels: msg?.labelIds || [], thread: msg?.threadId || null };
  const hv = (p, n) => (p.headers || []).find((h) => lc(h.name) === n)?.value || "";
  const walk = (p) => {
    if (!p) return;
    const mt = lc(p.mimeType);
    if ((mt === "text/plain" || mt === "text/html" || mt === "text/calendar") && !/^\s*attachment/i.test(hv(p, "content-disposition"))) {
      if (p.body?.data) {
        const bytes = unb64(String(p.body.data).replace(/-/g, "+").replace(/_/g, "/")), cs = (hv(p, "content-type").match(/charset\s*=\s*"?([^";\s]+)/i) || [])[1] || "utf-8";
        let s; try { s = new TextDecoder(cs).decode(bytes); } catch (_) { s = new TextDecoder().decode(bytes); }
        (mt === "text/html" ? out.html : out.plain).push(s);
      } else if (p.body?.attachmentId) out.complete = false;
    }
    for (const c of p.parts || []) walk(c);
  };
  walk(msg?.payload);
  return out;
}
// Named entities that matter here. Zero-width ones become nothing, so they cannot split a word; any other unknown one becomes a space.
const MENTION_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", shy: "", zerowidthspace: "" };
// Inline elements run into the text around them when drawn ("SX<b>SW</b>" reads SXSW), so they go without a trace; every other tag is a
// break between words.
const MENTION_INLINE = /<\/?(?:a|abbr|b|bdi|bdo|big|cite|code|data|del|dfn|em|font|i|ins|kbd|label|mark|q|s|samp|small|span|strike|strong|sub|sup|time|tt|u|var|wbr)\b[^<>]*>/gi;
// What a person reads in an HTML part: no comments, head, style or script, a picture's alt text in place of the picture, no markup.
export function visibleText(html) {
  return dropBlocks(dropComments(html, " "), "head|style|script|title", " ")
    .replace(/<img\b[^<>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^<>]*>/gi, (_, x, y, z) => ` ${x ?? y ?? z} `)
    .replace(MENTION_INLINE, "").replace(/<[^<>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
      if (e[0] !== "#") return MENTION_ENTITIES[lc(e)] ?? " ";
      try { return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch (_) { return " "; }
    });
}
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whether a word appears in what a person reads, and how much text of its own the mail has. Read: the subject, the plain and calendar
// text, and the HTML's visible text. Before matching: zero-width characters and soft hyphens go; each URL is cut to its host, so a
// visible "sxsw.com" still counts but a tracking address does not; my own addresses go, whole and URL-encoded, and so does any
// local part that itself contains a word. Of the 19 mirrored messages whose subject or snippet said "sxsw" on 2026-10-16, none was about
// SXSW: they were Google alerts naming the account, spam greeting "sam.owner.sxsw, Claim Your Free Kobalt Tool Set", and the like.
// A word must start a word ("SXSW", "#SXSW", "SXSWedu"), never sit inside one, and a phrase may break across lines.
export function mentionScan({ subject = "", plain = [], html = [] }, words, own = []) {
  const ws = (words || []).map((w) => String(w).replace(/\s+/g, " ").trim()).filter(Boolean);
  const clean = (s) => {
    let t = String(s || "").replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "").replace(/(?:https?:\/\/|www\.)([^\s<>"'()[\]\/?#]*)[^\s<>"'()[\]]*/gi, (_, host) => ` ${host} `);
    for (const o of own) {
      const addr = lc(o); if (!addr.includes("@")) continue;
      const local = addr.split("@")[0];
      t = t.replace(new RegExp(escRe(addr), "gi"), " ").replace(new RegExp(escRe(addr.replace("@", "%40")), "gi"), " ");
      if (ws.some((w) => local.includes(lc(w)))) t = t.replace(new RegExp(`(?<![\\w.+-])${escRe(local)}(?![\\w-]|\\.\\w)(?:\\+[\\w.-]*)?`, "gi"), " ");
    }
    return t;
  };
  const body = clean([...plain, ...html.map(visibleText)].join("\n")), all = clean(subject) + "\n" + body;
  return { hit: ws.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escRe(w).replace(/ /g, "\\s+")}`, "iu").test(all)), chars: body.replace(/\s+/g, "").length };
}
export const mentionsAny = (m, words, own) => mentionScan(m, words, own).hit;
// A conversation at your own domains or in the work mailbox, from its stored rows, judged as one arriving is: "yours" if
// you wrote in it, "keep" on a word in any message, "unsure" when a message has almost no text of its own (a store-only message has
// none) or its stored text was cut at BODY_CAP, else "drop".
export function mentionHubVerdict(rows, words, own = []) {
  if (!rows.length) return "unsure";
  if (rows.some((r) => r.direction === "out")) return "yours";
  let unsure = false;
  for (const r of rows) {
    const scan = mentionScan({ subject: r.subject || "", plain: r.body_text ? [r.body_text] : [], html: r.body_html ? [r.body_html] : [] }, words, own);
    if (scan.hit) return "keep";
    if (scan.chars < MENTION_MIN_TEXT || String(r.body_text || "").length >= BODY_CAP || String(r.body_html || "").length >= BODY_CAP) unsure = true;
  }
  return unsure ? "unsure" : "drop";
}
// A conversation already in the mailbox, judged as mentionDecide judges a new message: "yours" if you wrote in it, "keep"
// if any message mentions a word, "unsure" if any message was not read in full or has almost no text of its own (or there is none),
// else "drop". Only "drop" is ever trashed.
export function mentionThreadVerdict(messages, words, own = []) {
  if (!messages.length) return "unsure";
  if (messages.some((x) => (x.labelIds || []).includes("SENT"))) return "yours";
  let unsure = false;
  for (const x of messages) {
    const subject = (x.payload?.headers || []).find((h) => lc(h.name) === "subject")?.value || "", text = gmailMessageText(x), scan = mentionScan({ subject, ...text }, words, own);
    if (scan.hit) return "keep";
    if (!text.complete || scan.chars < MENTION_MIN_TEXT) unsure = true;
  }
  return unsure ? "unsure" : "drop";
}
// Every address the user receives at: a word inside one of these is never a mention.
async function ownAddresses(env) {
  const out = new Set([lc(env.FORWARD_TO)]);
  for (const sql of ["SELECT email FROM gmail_accounts", "SELECT email FROM identities"]) { try { for (const r of (await env.DB.prepare(sql).all()).results) out.add(lc(r.email)); } catch (_) {} }
  try { for (const a of await imapAccounts(env)) out.add(lc(a.email)); } catch (_) {}
  out.delete(""); return [...out];
}
// Decides one message under one rule, and does it. Returns:
//  "kept" (a word found), "rescued" (a word found, moved Spam -> inbox), "dropped" (no word, moved to Gmail's trash);
//  "unread" (not read in full, or almost no text of its own: kept), "left" (the user already moved it, or wrote in its conversation),
//  "failed" (Gmail refused the move: the message is where it was);
//  "capped" (this run's decisions are used up: not claimed, nothing done); null (already claimed: nothing done).
// The message is claimed first, and the intended move is written before Gmail is asked, so a run that dies between the two leaves a row
// ("dropping", "rescuing") saying the move may have happened, which the daily report lists. After an error the labels are read back,
// because the move may have worked and only its answer been lost.
async function mentionDecide(env, at, account, rule, { id, from, subject, spam = false, own, budget }) {
  const db = env.DB, addr = addrOnly(from), row = (d) => db.prepare("UPDATE mention_decisions SET decision = ?, at = ? WHERE account = ? AND id = ?").bind(d, now(), account, id), set = (d) => row(d).run();
  if (budget.left <= 0) { budget.capped++; return "capped"; }
  const claim = await db.prepare("INSERT INTO mention_decisions (account, id, rule_id, decision, from_addr, subject, at) VALUES (?, ?, ?, 'claimed', ?, ?, ?) ON CONFLICT(account, id) DO NOTHING")
    .bind(account, id, rule.id, addr, String(subject || "").slice(0, 300), now()).run();
  if (!claim.meta?.changes) return null;
  budget.left--;
  let decision, why = "";
  try {
    const text = gmailMessageText(await gmailApi(at, `messages/${encodeURIComponent(id)}?format=full`)), scan = mentionScan({ subject, ...text }, rule.words, await own());
    // Where the user may have put it since the mirror read it: only a message still in Spam (or still in the inbox) is moved.
    if (spam ? !text.labels.includes("SPAM") : !text.labels.includes("INBOX") || text.labels.includes("TRASH")) { decision = "left"; why = "moved since it arrived"; }
    else if (scan.hit) decision = spam ? "rescued" : "kept";
    else if (!text.complete || scan.chars < MENTION_MIN_TEXT) { decision = "unread"; why = text.complete ? "almost no text of its own" : "not read in full"; }
    else if (text.thread && ((await gmailApi(at, `threads/${encodeURIComponent(text.thread)}?format=minimal`)).messages || []).some((x) => (x.labelIds || []).includes("SENT"))) { decision = "left"; why = "a conversation you wrote in"; }
    else decision = "dropped";
  } catch (_) { decision = "unread"; why = "Gmail did not give it in full"; }
  if (decision === "dropped" || decision === "rescued") {
    try { await set(decision === "dropped" ? "dropping" : "rescuing"); } catch (_) { decision = "unread"; why = "the intended move could not be recorded"; }
  }
  if (decision === "dropped" || decision === "rescued") {
    try {
      if (decision === "rescued") await gmailApi(at, `messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }) });
      else await gmailApi(at, `messages/${encodeURIComponent(id)}/trash`, { method: "POST", body: "{}" });
    } catch (e) {
      let l = null; try { l = (await gmailApi(at, `messages/${encodeURIComponent(id)}?format=minimal`)).labelIds || []; } catch (_) {}
      const done = l && (decision === "dropped" ? l.includes("TRASH") : l.includes("INBOX") && !l.includes("SPAM"));
      if (!done) { await logEvent(db, "mention_fail", null, `${account} ${decision} ${id} <- ${addr}: ${String(e?.message || e).slice(0, 120)}`); decision = l ? "failed" : decision === "dropped" ? "dropping" : "rescuing"; }
    }
  }
  try { await db.batch([row(decision), db.prepare(`UPDATE mention_rules SET ${decision === "dropped" ? "dropped = dropped + 1" : "kept = kept + 1"}, last_at = ? WHERE id = ?`).bind(now(), rule.id)]); }
  catch (e) { await logEvent(db, "mention_record_fail", null, `${account} ${id} ${decision}: ${String(e?.message || e).slice(0, 120)}`); }
  await logEvent(db, "mention_" + decision, null, `${account} <- ${addr} | ${String(subject || "").slice(0, 120)}${why ? ` (${why})` : ""}`);
  return decision;
}
async function gmailPollOnce(env, a, rules, policy, { spam = [] } = {}) {
  const db = env.DB;
  const at = await gmailCachedToken(env, a.email);
  const setCursor = (h) => db.prepare("UPDATE gmail_accounts SET poll_history_id = ?, last_poll_at = ? WHERE email = ?").bind(String(h), now(), a.email).run();
  if (!a.poll_history_id) { const prof = await gmailApi(at, "profile"); await setCursor(prof.historyId); return { a: a.email, init: prof.historyId }; }
  // history.list is capped at 500 records and Gmail says its returned historyId may be adopted only once there is no nextPageToken:
  //  a single page plus "jump to the newest historyId" silently skipped every record after the first page.
  const added = new Map();
  // Threads this mailbox says have been DEALT WITH since the last cursor; trashed, archived or read, wherever that happened:
  // in mailhub, in the Gmail app, on gmail.com. The Worker was always woken for these; it simply never asked for them, because
  // the query requested messageAdded alone. Verified 2026-09-18 against the live mailbox: with `labelId=INBOX`
  // left exactly as it was, the widened call still returns all 24 INBOX removals in the sample window, and the user's own
  // triage appears as UNREAD removed -> TRASH added -> INBOX removed on each of its threads.
  const handledState = new Map();
  let r = null, pageToken = null, pages = 0, lastRec = null;
  try {
    do {
      r = await gmailApi(at, `history?startHistoryId=${encodeURIComponent(a.poll_history_id)}&historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved&historyTypes=messageDeleted&labelId=INBOX&maxResults=500${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`);
      lastRec = (r.history || []).at(-1)?.id || lastRec;
      for (const m of foldHistory(r.history, handledState)) added.set(m.id, m);
      pageToken = r.nextPageToken || null;
    } while (pageToken && ++pages < 20);
    if (pageToken) await logEvent(db, "gmail_poll_truncated", null, `${a.email} more than ${pages} history pages; the rest arrives on the next run`);
  } catch (e) {
    // A cursor Gmail no longer knows (404). Jumping to the newest historyId dropped everything in between, so mail could arrive with no
    // notification and no screening. Instead: catch up over the INBOX since the last successful poll, then take the new cursor.
    if (e.status !== 404) throw e;
    const prof = await gmailApi(at, "profile");
    const sinceMs = Date.parse(a.last_poll_at || "") || (Date.now() - 3600_000);
    let caught = 0;
    try {
      const l = await gmailApi(at, `messages?labelIds=INBOX&maxResults=100&q=${encodeURIComponent("after:" + Math.floor(sinceMs / 1000))}`);
      for (const m of l.messages || []) { added.set(m.id, { id: m.id, labelIds: ["INBOX"] }); caught++; }
    } catch (_) {}
    await logEvent(db, "gmail_poll_reset", null, `${a.email} cursor expired; caught up ${caught} inbox message(s) since ${new Date(sinceMs).toISOString()}`);
    r = { historyId: prof.historyId };
  }
  let blocked = 0, dropped = 0, quiet = null; const fresh = [];
  if (added.size && typeof rules === "function") rules = await rules();   // read only when there is mail to screen (callers pass a loader)
  const mentionRules = mentionRulesLoader(db); let ownP = null; const own = () => (ownP ??= ownAddresses(env)), budget = { left: MENTION_RUN_MAX, capped: 0 };
  const notifyMode = typeof policy === "string" ? policy : policy?.for?.(a.email);
  const unsubJobs = unsubJobsLoader(db);   // read once, and only if a message gets this far
  const trashRules = trashRulesLoader(db); let ruled = 0;
  for (const [id, stub] of added) {
    let from = "", subject = "", snippet = "", thread = stub?.threadId || null, gone = false;
    try {
      // The mirror ran first in this lease and usually holds the message already: no second get for it.
      const row = await db.prepare("SELECT meta FROM gmail_messages WHERE account = ? AND id = ? AND meta IS NOT NULL").bind(a.email, id).first().catch(() => null);
      let meta = row ? JSON.parse(row.meta) : null;
      // A message Gmail no longer has is not notified. Gmail's package tracking puts a short-lived message into an old
      // shipping email to bump it up the inbox and removes it within seconds, with no deletion in the history (56Z and
      // It was pushed with no sender, "(no subject)" and nothing to open. Any other
      // failure is tried once more; if the message still cannot be read it is notified as before, with its conversation from the history.
      for (let k = 0; !meta && k < 2; k++) {
        try { meta = await gmailApi(at, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`); }
        catch (e) { if (e?.status === 404) { gone = true; break; } }
      }
      if (meta) { from = hdrVal(meta, "From"); subject = hdrVal(meta, "Subject"); snippet = meta.snippet || ""; thread = meta.threadId || thread; }
    } catch (_) {}
    if (gone) { await logEvent(db, "gmail_poll_gone", null, `${a.email} ${id} thread ${thread || "-"} ${JSON.stringify(stub?.labelIds || [])}`); continue; }
    const addr = addrOnly(from);
    // One of my trash rules decides first: to Gmail's Trash, with no notification. Gmail hands the headers
    // over decoded (none of the 3,844 stored in the mirror holds an encoded word). If Gmail refuses the trash, the mail is handled as usual.
    const fromName = from.includes("<") ? from.slice(0, from.lastIndexOf("<")).replace(/"/g, "").trim() : "";
    const tr = trashMatch(await trashRules(), { name: fromName, subject, account: a.email });
    if (tr) {
      try { await gmailApi(at, `messages/${id}/trash`, { method: "POST", body: "{}" }); ruled++; await trashHit(db, tr, `${a.email} <- ${addr}`); continue; }
      catch (e) { await logEvent(db, "rule_trash_fail", null, `${a.email} ${id} ${e?.message}`); }
    }
    // An impostor goes to Gmail's Spam, with no notification, and its sender is not recorded. If Gmail refuses the
    // move, or the known senders cannot be read, the mail is handled as usual.
    let imp = null; try { imp = impostorOf(fromName, addr, await impostorKnown(env)); } catch (_) { imp = null; }
    if (imp) {
      try { await gmailApi(at, `messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] }) }); await logEvent(db, "impostor_spam", null, `${a.email} ${id} <- ${addr}: ${impostorWhy(imp)} | ${String(subject || "").slice(0, 120)}`); continue; }
      catch (e) { await logEvent(db, "impostor_spam_fail", null, `${a.email} ${id} ${e?.message}`); }
    }
    const rule = matchSender(rules, addr, a.email);
    // A "delete unless it mentions" rule decides first. An address-level block still wins; a domain block gives way only to
    // a mail kept for its words. A message another run already claimed is left to that run: no notification, no block.
    const mr = rule?.action === "block" && !lc(rule.pattern).startsWith("*@") ? null : matchMention(await mentionRules(), addr, a.email);
    const said = mr ? await mentionDecide(env, at, a.email, mr, { id, from, subject, own, budget }) : undefined;
    if (said === null) continue;
    if (said === "dropped" || said === "dropping") { dropped++; continue; }
    const preStatus = rule?.action === "block" && lc(rule.pattern).startsWith("*@") ? (await db.prepare("SELECT status FROM known_senders WHERE address = ?").bind(addr).first())?.status : null;
    if (rule?.action === "block" && preStatus !== "accepted" && said !== "kept") { try { await gmailApi(at, `messages/${id}/trash`, { method: "POST", body: "{}" }); blocked++; await logEvent(db, "gatekeeper_blocked", null, `${a.email} <- ${addr}`); } catch (e) { await logEvent(db, "gatekeeper_fail", null, `${a.email} ${id} ${e?.message}`); } }
    else { const senderStatus = await touchSender(db, addr, a.email, rules); await unsubNoteArrival(db, unsubJobs, addr, subject, Date.now(), id); const wanted = said === "kept" && notifyMode !== "none";   // it mentions the user's words: notified unless notifications are off
      let notify = wanted || shouldNotify(policy, { category: rule?.category || (AUTO_LOCAL_RE.test(addr) ? "notifications" : "personal"), rule, fromAddr: addr, senderStatus, account: a.email });
      if (notify && !wanted) { quiet ??= await quietRules(env); const q = quietMatch(quiet, addr, subject); if (q) { notify = false; await quietHit(env, q, `${a.email} ${addr}`); } }
      fresh.push({ id, thread, from, subject, snippet, priority: wanted || rule?.action === "priority", notify }); }
  }
  // Spam arrivals the mirror read in this lease (gmailMirrorOnce). Only a sender with a mention rule is looked at: mentioning a word it is
  // moved to the inbox and notifies; otherwise it goes to the trash. The rules are read only when spam arrived, and the sender only from
  // what the mirror stored: one it did not store (its gets ran out this minute) stays in Spam, as it would without the rules.
  if (spam.length && (await mentionRules()).some((r) => r.scope === "*" || lc(r.scope) === lc(a.email))) {
    for (const id of spam) {
      const row = await db.prepare("SELECT meta FROM gmail_messages WHERE account = ? AND id = ? AND meta IS NOT NULL").bind(a.email, id).first().catch(() => null);
      const meta = row ? parseJsonOr(row.meta, null) : null; if (!meta) continue;
      const from = hdrVal(meta, "From"), subject = hdrVal(meta, "Subject"), mr = matchMention(await mentionRules(), addrOnly(from), a.email);
      if (!mr) continue;
      // Out of Spam only on Gmail's own DMARC pass for the From domain: the rule matches the From as written, and a
      // spoofed sender in a ruled domain was moved to the inbox with a priority push. The topmost Authentication-Results is Gmail's.
      let proven = false;
      try { const g = await gmailApi(at, `messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Authentication-Results`); const ar = (g?.payload?.headers || []).find((h) => /^authentication-results$/i.test(h.name))?.value || ""; proven = dmarcProves(ar, "mx.google.com", addrOnly(from)); } catch (_) {}
      if (!proven) { await logEvent(db, "mention_spam_unproven", id, `${a.email} ${addrOnly(from)}`); continue; }
      const said = await mentionDecide(env, at, a.email, mr, { id, from, subject, spam: true, own, budget });
      if (said === "rescued") fresh.push({ id, thread: meta.threadId || null, from, subject, snippet: meta.snippet || "", priority: true, notify: notifyMode !== "none" });
      if (said === "dropped" || said === "dropping") dropped++;
    }
  }
  if (budget.capped) await logEvent(db, "mention_capped", null, `${a.email} ${budget.capped} message(s) past this run's ${MENTION_RUN_MAX} decisions, left as they arrived`);
  // Claim the delta: the cursor moves only from the value this run started at. Cron invocations overlap (two polls of one account a
  // second apart); the loser has already touched senders (idempotent) and must not push the same mail twice.
  // Stopped at the page cap with pages left: resume after the last record read. A partial page's historyId is the mailbox's CURRENT id
  // (Gmail 2026-10-07: 51352436 on a page of records 51295363-51295410), so adopting it skipped every record past page 20.
  const nextCursor = pageToken ? (lastRec || a.poll_history_id) : (r.historyId || a.poll_history_id);
  const claim = await db.prepare("UPDATE gmail_accounts SET poll_history_id = ?, last_poll_at = ? WHERE email = ? AND poll_history_id = ?").bind(String(nextCursor), now(), a.email, String(a.poll_history_id)).run();
  if (!claim.meta?.changes) { if (fresh.length) await logEvent(db, "gmail_poll_dup", null, `${a.email} another run advanced the cursor first; ${fresh.length} new message(s) not notified twice`); return { a: a.email, dup: fresh.length }; }
  if (fresh.length) ctxWaitUntil(prefetchGmail(env, at, a.email, fresh.map((f) => f.id)));   // images fetched on arrival; gatekeeper-blocked mail is not in `fresh`
  // Only after the claim: the losing run of an overlapping cron minute must not re-push the same dismissal.
  const handledHere = [...handledState].filter(([, v]) => v).map(([t]) => `${a.email}|${t}`);
  if (handledHere.length) {
    const entries = await addHandled(env, handledHere, null);   // no device did this as far as the hub knows, so no device is excluded
    await sendDismissPush(env, entries, `gmail:${a.email}`);
  }
  const notable = fresh.filter((f) => f.notify);
  if (notable.length) {
    const preview = await notifyPreview(env);
    if (notable.length <= 4) for (const f of notable) await sendPush(env, mailPush(preview, { kind: "gmail", account: a.email, ...f }), { urgency: f.priority ? "high" : "normal" });
    else await sendPush(env, mailPushSummary(preview, { kind: "gmail", account: a.email, items: notable }), { urgency: notable.some((f) => f.priority) ? "high" : "normal", keys: notable.filter((f) => f.thread).map((f) => `${a.email}|${f.thread}`) });
    await logEvent(db, "gmail_poll", null, `${a.email} new=${fresh.length} blocked=${blocked} notified=${notable.length} first="${(notable[0].from || "").replace(/<.*$/, "").trim().slice(0, 40)}: ${(notable[0].subject || "").slice(0, 60)}"`);
  }
  return { a: a.email, new: fresh.length, blocked, ...(dropped ? { dropped } : {}), ...(ruled ? { ruled } : {}) };
}
// The sender rules, read at most once per run and only when a poll has new mail to screen. `sender_rules` has no index a poll could use,
// so every read scans the table; a poll with nothing new (most of them, now that the mirror polls every minute) reads nothing.
function senderRulesLoader(db) { let p = null; return () => (p ??= db.prepare("SELECT pattern, action, scope, category FROM sender_rules").all().then((r) => r.results)); }
async function gmailPoll(env) {
  if (!gmailConfigured(env)) return [];
  const db = env.DB;
  const { results: accounts } = await db.prepare("SELECT email, poll_history_id, watch_expiration, last_poll_at FROM gmail_accounts WHERE status = 'active'").all();
  const out = [];
  const minute = new Date().getUTCMinutes();
  // A mailbox with a live watch is driven by push; polling it stays as the backstop Google's own guide asks for, every ten
  // minutes instead of every minute. Without a watch (or with an expired one) nothing changes: one poll a minute.
  // With the Gmail mirror on every mailbox is followed every minute: the watch only covers the inbox, so this is how a
  // change elsewhere reaches the devices within a minute. It costs two history.list calls (4 quota units) when nothing
  // changed; the sender rules are read only when there is new mail to screen.
  const mirrorOn = gmailMirrorOn(env);
  const due = accounts.filter((a) => {
    const pushed = !mirrorOn && a.watch_expiration && Date.parse(a.watch_expiration) > Date.now() && minute % 10 !== 0;
    if (pushed) out.push({ a: a.email, skipped: "push" });
    return !pushed;
  });
  // Nothing to poll on nine minutes in ten, so the rules and the notify policy are not read at all. `sender_rules` has no WHERE
  // clause and no index to read instead, so every read scans the whole table, it gains a row on every unsubscribe and every block,
  // and the cron runs 1,440 times a day: reading it here unconditionally cost 1,440 full scans a day to answer nothing. D1's free
  // tier has been a hard stop since 2026-09-01 (5,000,000 rows SCANNED per UTC day, then queries fail), so this is availability,
  // not pennies. Measured by hub/test/budget.mjs: 201 rows/minute before, 1 after, at 200 rules.
  if (!due.length) return out;
  const rules = senderRulesLoader(db);
  const policy = await notifyPolicy(env);
  for (const a of due) {
    try { out.push(await gmailPollAccount(env, a, rules, policy)); }
    catch (e) { out.push({ a: a.email, error: e?.message }); await logEvent(db, "gmail_poll_fail", null, `${a.email} ${e?.message}`); }
  }
  return out;
}
let APP_VERSION = "";
async function appVersion() {
  if (APP_VERSION) return APP_VERSION;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(APP_HTML + "\n" + APP_JS + "\n" + SW_JS + "\n" + MANIFEST));
  APP_VERSION = [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  return APP_VERSION;
}
const html = (s, status = 200, extra = {}) => new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
const NO_SCRIPT = { "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'" };   // the sign-in error pages: text and one link
// The app shell's policy. Scripts: the app's own files, and the one inline script the app writes itself, the PDF frame's,
// which inherits this policy (a srcdoc document does), by a nonce made per response and read by app.js from its own <script> tag, where
// the browser hides it from CSS and getAttribute; never a meta tag, whose text injected CSS could read. blob: and 'wasm-unsafe-eval' are
// the PDF frame's (pdf.js imported from a blob, its decoders' WebAssembly); neither runs anything without a script already running.
// Nothing else is restricted here: images, styles, fonts and connections stay as they were (each mail frame has its own policy).
const SHELL_CSP = "script-src 'self' blob: 'wasm-unsafe-eval' 'nonce-__NONCE__'; worker-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export default {
  async scheduled(event, env, ctx) { return ctxStore.run(ctx, async () => {   // work a cron run starts in the background belongs to THIS run (ctxWaitUntil)
    const d = new Date(event.scheduledTime); const minute = d.getUTCMinutes();
    const results = [];
    // Every 15 min; migration bridge: poll both Resend accounts while their domains still receive there. Remove the secrets to stop.
    if (minute % 15 === 0) {
      for (const acct of ["domain2", "domain3"]) {
        if (!(acct === "domain2" ? env.RESEND_KEY_DOMAIN2 : env.RESEND_KEY_DOMAIN3)) continue;
        try { const r = await importResend(env, acct, { limit: 50 }); results.push(r); if (r.imported || r.failed) await logEvent(env.DB, "resend_poll", null, JSON.stringify({ ...r, ids: undefined })); }
        catch (e) { results.push({ account: acct, error: e?.message }); await logEvent(env.DB, "resend_poll_fail", null, `${acct} ${e?.message}`); }
      }
      if (results.length && !results.some((r) => r.error || r.failed)) await logEvent(env.DB, "resend_poll_ok", null, JSON.stringify(results.map((r) => ({ a: r.account, l: r.listed, i: r.imported }))));
    }
    // Every minute: Gmail new-mail detection (push + Gatekeeper) and the scheduler (snooze / send later / reminders).
    try { await gmailPoll(env); } catch (e) { await logEvent(env.DB, "gmail_poll_fail", null, e?.message); }
    try { await runScheduled(env); } catch (e) { await logEvent(env.DB, "scheduler_fail", null, e?.message); }
    try { await imapSyncAll(env); } catch (e) { await logEvent(env.DB, "imap_sync_fail", null, e?.message); }
    try { await runImapOps(env); } catch (e) { await logEvent(env.DB, "imap_ops_fail", null, e?.message); }
    // Mail accepted but not yet indexed. First in the daily block below would be too late: the inbox would be missing it
    // until 09:00 UTC, so this drains every minute.
    try { await reconcileInbound(env); } catch (e) { await logEvent(env.DB, "reconcile_fail", null, e?.message); }
    // The pictures arrival did not keep, retried on the arrival's schedule; after the mail itself, before the leftovers.
    try { await drainImgQueue(env); } catch (e) { await logEvent(env.DB, "img_queue_fail", null, e?.message); }
    // Spy trackers and ads: the learner hourly; the samples, then the lists, before the daily report reads them.
    if (minute === 20) { try { await trkLearn(env); } catch (e) { await logEvent(env.DB, "trk_learn_fail", null, e?.message); } }
    if (d.getUTCHours() === 8 && minute === 30) { try { await trkCanaries(env); } catch (e) { await logEvent(env.DB, "trk_canary_fail", null, e?.message); } }
    if (d.getUTCHours() === 8 && minute === 40) { try { await trkRefreshLists(env); } catch (e) { await logEvent(env.DB, "trk_lists_fail", null, e?.message); } }
    // Last, after everything that keeps mail flowing, and not in the daily minute: one leftover unsubscribe job.
    if (d.getUTCHours() !== 9 || minute !== 0) { try { await unsubCron(env); } catch (e) { await logEvent(env.DB, "unsubscribe_fail", null, `cron: ${e?.message}`); } }
    // Daily reconciliation at 09:00 UTC → my Gmail (a verified destination: free, outside quotas).
    if (d.getUTCHours() === 9 && minute === 0) { await purgeTrash(env); await purgeEvents(env); await pruneImgQueue(env); await sweepImgs(env).catch((e) => console.log("img sweep", String(e?.message || e))); await trkPrune(env); await gmailMirrorPrune(env); await gmailWatchAll(env); await gmailDailyCheck(env); try { await sweepUnindexedRaw(env, d.getUTCDay() === 0); } catch (e) { await logEvent(env.DB, "sweep_fail", null, e?.message); } try { await reconcileInbound(env, 20); } catch (e) { await logEvent(env.DB, "reconcile_fail", null, e?.message); } await dailyReport(env, results); }
    // A row that failed RECONCILE_TRIES times: one an hour, last, so a mail that cannot be projected costs only itself.
    if (minute === 30) { try { await reconcileInbound(env, 1, { stuck: true }); } catch (e) { await logEvent(env.DB, "reconcile_fail", null, `stuck: ${e?.message}`); } }
  }); },
  async email(message, env, ctx) { return ctxStore.run(ctx, async () => {
    // The tempfail probe: mail to the one address named by the TEMPFAIL_PROBE secret makes this handler
    // throw, uncaught, before the safety net below, to learn what the SENDING server is told: a 4xx (it retries) or a 5xx (it bounces).
    // Cloudflare documents setReject as permanent and says nothing about a thrown handler. Off unless the secret is set; no D1 or R2
    // is touched first, so the R2-first ordering holds for every other message.
    if (env.TEMPFAIL_PROBE && lc(message.to) === lc(env.TEMPFAIL_PROBE)) { console.log(`tempfail probe: throwing for ${message.from} -> ${message.to} at ${new Date().toISOString()}`); throw new Error("tempfail probe: thrown on purpose (R50)"); }
    try { await handleInbound(message, env); }
    catch (e) {
      // The handler asked for a retry: let it out, so the sender gets a temporary failure.
      if (e instanceof TempFail) throw e;
      // Last resort: never silently accept mail we could not forward, and never bounce it either. This used to setReject with
      // the words "temporary failure, please retry", but setReject is a PERMANENT error; rethrowing is the real temporary one.
      try { await logEvent(env.DB, "handler_crash", null, e?.message); } catch (_) {}
      try { await message.forward(env.FORWARD_TO); } catch (_) { throw e; }
    }
  }); },
  async fetch(request, env, ctx) { return ctxStore.run(ctx, async () => {
    const res = await this.route(request, env);
    const h = new Headers(res.headers);
    h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "no-referrer");
    if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, headers: h });
  }); },
  async route(request, env) {
    const url = new URL(request.url);
    // pdf.js's decoders are static assets under /pdfjs/, and the PDF frame's CSP opens that folder. CSP stops checking
    // the path after a redirect, so nothing under it may ever redirect: a request for /pdfjs/* that reaches the Worker (the file is not
    // there) is a plain 404, before any other route can answer it.
    if (url.pathname.startsWith("/pdfjs/") || url.pathname === "/pdfjs") return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    // (the old /health answered ok:true WITHOUT TOUCHING D1, so an external watcher would have shown green through the exact
    //  outage it was there to catch. The real one is below, and it reads a row.)
    // ---- Client shell (public: code only, no data) ----
    // /, /app.js and /sw.js stay here: the first checks the session, the other two carry the build version. Everything immutable
    // (the SQLite engine, the search worker, the icons) is served from./public as Workers Static Assets: those requests are free and
    // unlimited and do not count against the daily Worker request limit, and 1.5 MB leaves the script.
    if (request.method === "GET") {
      const v = await appVersion();
      const stat = (body, type, extra = {}) => new Response(body, { headers: { "content-type": type, "cache-control": "no-cache", etag: `"${v}"`, ...extra } });
      if (url.pathname === "/app.js") return request.headers.get("if-none-match") === `"${v}"` ? new Response(null, { status: 304 }) : stat(APP_JS.replace("__VERSION__", v), "text/javascript; charset=utf-8");
      if (url.pathname === "/sw.js") return stat(SW_JS.replace("__VERSION__", v), "text/javascript; charset=utf-8", { "service-worker-allowed": "/" });
      if (url.pathname === "/manifest.webmanifest") return stat(MANIFEST, "application/manifest+json");
      if (url.pathname === "/api/version") return json({ version: v });
    }
    if ((url.pathname === "/privacy" || url.pathname === "/terms") && request.method === "GET") return new Response(PRIVACY_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
    // ---- The Windows app's installer and its updates ----
    // Outside the session gate on purpose: the app's updater asks before anyone is signed in, and an installer for a shell that
    // loads this site holds nothing secret. Read-only, one fixed R2 prefix, names from a closed alphabet; written only by
    // windows/build.sh --publish. latest.json and the unversioned installer change each release, the versioned files never do.
    // The Android app's updates use the same shape under /dl/android/: android/publish.sh writes them, and
    // the app's Updater reads latest.json and checks the APK's sha256 before offering it.
    const dl = url.pathname.match(/^\/dl\/(windows|android)\/(.+)$/);
    if (dl && (request.method === "GET" || request.method === "HEAD")) {
      const [, os, name] = dl;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return new Response("not found", { status: 404 });
      const o = request.method === "HEAD" ? await env.STORE.head(`dl/${os}/${name}`) : await env.STORE.get(`dl/${os}/${name}`);
      if (!o) return new Response("not found", { status: 404 });
      const exe = name.endsWith(".exe"), apk = name.endsWith(".apk");
      const h = { "content-type": name.endsWith(".json") ? "application/json" : exe ? "application/vnd.microsoft.portable-executable" : apk ? "application/vnd.android.package-archive" : "text/plain; charset=utf-8",
        "content-length": String(o.size), "cache-control": /_\d+\.\d+\.\d+_|-\d+\.\d+(\.\d+)?\.apk$/.test(name) ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" };
      if (exe || apk) h["content-disposition"] = `attachment; filename="${name}"`;
      return new Response(request.method === "HEAD" ? null : o.body, { headers: h });
    }
    if (url.pathname === "/auth/google" && request.method === "GET") return googleStart(request, env, url);
    if (url.pathname === "/auth/google/callback" && request.method === "GET") return googleCallback(request, env, url);
    if (url.pathname === "/auth/app/exchange" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const code = String(b.code || ""), verifier = String(b.verifier || "");
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(code) || verifier.length < 43) return json({ error: "bad request" }, 400);
      const row = await env.DB.prepare("SELECT value FROM prefs WHERE key = ?").bind(`applogin:${code}`).first();
      await env.DB.prepare("DELETE FROM prefs WHERE key = ?").bind(`applogin:${code}`).run();   // single use, whatever happens next
      let rec = null; try { rec = JSON.parse(row?.value || "null"); } catch (_) {}
      if (!rec || rec.exp < Date.now()) return json({ error: "code expired or unknown" }, 401);
      const digest = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      if (!(await constantTimeEqual(digest, rec.challenge))) { await logEvent(env.DB, "login_fail", null, "app exchange: verifier mismatch"); return json({ error: "verifier mismatch" }, 401); }
      const session = await makeSession(env);
      return json({ ok: true, session, max_age: 30 * 86400 }, 200, { "set-cookie": `mh=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
    }
    if (url.pathname === "/auth/gmail" && request.method === "GET") return gmailStart(request, env, url);
    if (url.pathname === "/auth/gmail/callback" && request.method === "GET") return gmailCallback(request, env, url);
    if (url.pathname === "/login" && request.method === "POST") {
      if (env.UI_PASSWORD_DISABLED === "1") return json({ error: "password login disabled; use Google" }, 403);
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const recent = await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'login_fail' AND detail = ? AND at > datetime('now','-15 minutes')").bind(ip).first();
      if (recent.n >= 10) return json({ error: "too many attempts, try later" }, 429);
      const b = await request.json().catch(() => ({}));
      if (!env.UI_PASSWORD || !(await constantTimeEqual(b.password || "", env.UI_PASSWORD))) { await logEvent(env.DB, "login_fail", null, ip); return json({ error: "wrong password" }, 401); }
      await logEvent(env.DB, "login_ok", null, ip);
      return json({ ok: true }, 200, { "set-cookie": `mh=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
    }
    // ---- /health: the one thing an OUTSIDE watcher can ask ----
    // D1's free tier is a HARD STOP (queries FAIL until
    // midnight UTC when the daily row limit is crossed) and the daily report that would tell the user about it is itself built
    // by reading D1. The hub cannot raise the alarm about the failure that silences it. So this route is deliberately outside the
    // session gate, does exactly ONE indexed row read, and answers 503 when that read cannot be served. Point any external pinger
    // at it. It reveals nothing: a status, a timestamp and the build, no mail and no counts.
    if (url.pathname === "/health") {
      const t0 = Date.now();
      try {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json({ ok: true, d1: "ok", ms: Date.now() - t0, version: await appVersion(), at: now() }, 200, { "cache-control": "no-store" });
      } catch (e) {
        const msg = String(e?.message || e);
        // The limit message is Cloudflare's own wording; surfacing it is what makes the page actionable rather than just red.
        const limited = /daily .*(read|write) limit|exceeded .*limit/i.test(msg);
        return json({ ok: false, d1: limited ? "daily-limit-exceeded" : "error", detail: msg.slice(0, 200), at: now() }, 503, { "cache-control": "no-store" });
      }
    }
    const sameOrigin = () => request.headers.get("Origin") === url.origin;
    if (url.pathname === "/logout" && request.method === "POST") {
      if (!(await sessionValid(request, env)) || !sameOrigin()) return json({ error: "unauthorized" }, 401);
      const b = await request.json().catch(() => ({}));
      const everywhere = !!(b && b.everywhere), ip = request.headers.get("cf-connecting-ip") || "";
      // A device that is signed out also leaves the notification lists. Until then each one was still sent every new
      // mail's sender, subject and first lines. Everywhere: every phone and browser goes, and each registers again when it signs back
      // in (the Android app on sign-in, a browser on its next boot). This device: the one the page names, the Android app by its push
      // id and a browser by its Web Push endpoint. The sign-out never waits on this: a failure is logged and the cookie still goes.
      let off;
      if (everywhere) {
        const g = await bumpSessionGen(env);
        try { const [p, w] = await env.DB.batch([env.DB.prepare("DELETE FROM fcm_devices"), env.DB.prepare("DELETE FROM push_subscriptions")]); off = `phones=${p.meta?.changes ?? 0} browsers=${w.meta?.changes ?? 0}`; }
        catch (e) { off = `unlist failed: ${String(e?.message || e).slice(0, 120)}`; }
        await logEvent(env.DB, "logout_everywhere", null, `gen=${g} ${off} ${ip}`);
      } else {
        try {
          const d = await fcmDeviceById(env.DB, b?.device);
          const phones = d ? (await env.DB.prepare("DELETE FROM fcm_devices WHERE token = ?").bind(d.token).run()).meta?.changes ?? 0 : 0;
          const ep = typeof b?.endpoint === "string" && b.endpoint.length <= 2048 ? b.endpoint : "";
          const browsers = ep ? (await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(ep).run()).meta?.changes ?? 0 : 0;
          off = `phones=${phones} browsers=${browsers}`;
        } catch (e) { off = `unlist failed: ${String(e?.message || e).slice(0, 120)}`; }
        await logEvent(env.DB, "logout", null, `${off} ${ip}`);
      }
      return json({ ok: true, everywhere }, 200, { "set-cookie": "mh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
    }
    // Cloud Pub/Sub delivering a Gmail notification. It cannot carry this app's session, so it is authenticated twice over: a secret in
    // the URL (constant-time compared) and Google's signed OIDC token for the service account named on the subscription. A wrong secret
    // is a 404, so the endpoint does not advertise itself. Failures answer 500 so Pub/Sub retries with backoff; everything else is 204.
    if (url.pathname === "/hook/gmail") {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      if (!env.GMAIL_PUSH_SECRET || !(await constantTimeEqual(url.searchParams.get("k") || "", env.GMAIL_PUSH_SECRET))) return new Response("not found", { status: 404 });
      if (!env.GMAIL_PUSH_SA || !env.GMAIL_PUSH_AUDIENCE) { await logEvent(env.DB, "gmail_push_rejected", null, "GMAIL_PUSH_SA / GMAIL_PUSH_AUDIENCE not set: refusing to accept push on the URL secret alone"); return new Response("forbidden", { status: 403 }); }
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const claims = await verifyGooglePushToken(env, bearer).catch(() => null);
      if (!claims) { await logEvent(env.DB, "gmail_push_rejected", null, (request.headers.get("cf-connecting-ip") || "") + " bad or missing Google token"); return new Response("forbidden", { status: 403 }); }
      // A malformed or oversized body is ACKED, not retried: Pub/Sub redelivers anything that is not a success until the message expires,
      // so answering 500 to a poison message would have it hammer this Worker for days.
      const len = parseInt(request.headers.get("content-length") || "0", 10);
      if (len > 65536) { await logEvent(env.DB, "gmail_push_bad", null, `body ${len} bytes`); return new Response(null, { status: 204 }); }
      let b, note, email;
      try {
        const text = await request.text(); if (text.length > 65536) { await logEvent(env.DB, "gmail_push_bad", null, `body ${text.length} bytes`); return new Response(null, { status: 204 }); }
        b = JSON.parse(text);
        const d = b?.message?.data;
        if (!b || typeof b !== "object" || typeof d !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(d)) throw new Error("envelope");
        note = JSON.parse(new TextDecoder().decode(unb64(d.replace(/-/g, "+").replace(/_/g, "/"))) || "{}");
        email = lc(note.emailAddress || ""); if (!email || typeof note.historyId === "undefined") throw new Error("payload");
      } catch (e) { await logEvent(env.DB, "gmail_push_bad", null, `unreadable notification (${String(e?.message || e).slice(0, 40)})`); return new Response(null, { status: 204 }); }
      // Replay: the OIDC token stays valid for up to an hour and says nothing about the body. A captured request is therefore refused
      // once its publishTime is old, and a message id already handled by this isolate is acked without repeating the work.
      const pubMs = Date.parse(b?.message?.publishTime || "") || 0;
      if (pubMs && Date.now() - pubMs > 10 * 60_000) { await logEvent(env.DB, "gmail_push_stale", null, `${email} published ${b.message.publishTime}`); return new Response(null, { status: 204 }); }
      const mid = String(b?.message?.messageId || b?.message?.message_id || "");
      if (mid) { const seen = pushSeen.get(mid); if (seen) return new Response(null, { status: 204 }); pushSeen.set(mid, Date.now()); if (pushSeen.size > 500) for (const [k, t] of pushSeen) { if (Date.now() - t > 600_000) pushSeen.delete(k); } }
      try {
        const acct = await env.DB.prepare("SELECT email, poll_history_id, watch_expiration, last_poll_at FROM gmail_accounts WHERE email = ? AND status = 'active'").bind(email).first();
        if (!acct) return new Response(null, { status: 204 });                       // an account that was disconnected: nothing to do, do not make Pub/Sub retry
        await env.DB.prepare("UPDATE gmail_accounts SET last_push_at = ? WHERE email = ?").bind(now(), email).run();
        const r = await gmailPollAccount(env, acct, senderRulesLoader(env.DB), await notifyPolicy(env));  // the same history delta the cron runs, for one mailbox
        if (r && (r.new || r.blocked)) await logEvent(env.DB, "gmail_push", null, `${email} new=${r.new || 0} blocked=${r.blocked || 0}`);
        return new Response(null, { status: 204 });
      } catch (e) {
        await logEvent(env.DB, "gmail_push_fail", null, String(e?.message || e).slice(0, 200));
        return new Response("error", { status: 500 });                               // Pub/Sub retries; the ten-minute poll is the backstop either way
      }
    }
    if (url.pathname.startsWith("/api/")) {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const viaToken = !!(env.CLI_TOKEN && (await constantTimeEqual(token, env.CLI_TOKEN)));
      let ok; try { ok = viaToken || (await sessionValid(request, env)); } catch (e) { if (e.code !== "session_unavailable") throw e; return json({ error: "the hub cannot check the sign-in right now; try again" }, 503, { "retry-after": "30" }); }
      if (!ok) return json({ error: "unauthorized" }, 401);
      if (!viaToken && request.method !== "GET" && !sameOrigin()) return json({ error: "cross-origin request refused" }, 403);
      // A GET from another site, which SameSite=Lax still sends the cookie on as a top-level navigation: four GETs write
      // (a conversation marked read, an attachment fetched from Gmail, a domain looked up, a mail server probed). The app's own requests,
      // its frames' and a native shell's are same-origin or "none"; a browser that sends no Sec-Fetch-Site is not refused.
      if (!viaToken && request.method === "GET" && /^(cross-site|same-site)$/.test(request.headers.get("sec-fetch-site") || "")) return json({ error: "cross-site request refused" }, 403);
      // An image request the app did not write (imgSessionKey) is refused: /api/img always, since it fetches the open web, and an
      // IMAGE load of any other API route: what a mail's CSS url() or svg <image> pointing at a hub address is. The browser sets
      // Sec-Fetch-Dest itself and no page can change it; attachment downloads are navigations, so they never need the key. Without
      // this a mail could make the hub call the Gmail API with the user's token for invented attachment ids, hundreds per open.
      // No key computable means no image: comparing against a placeholder ("\0") would let a request that sent that placeholder through.
      if (!viaToken && (url.pathname === "/api/img" || request.headers.get("sec-fetch-dest") === "image")) {
        const want = await imgSessionKey(request, env);
        if (!want || !(await constantTimeEqual(url.searchParams.get("k") || "", want))) return new Response("image key required", { status: 403 });
      }
      try { return await api(request, env, url); } catch (e) { return json({ error: e.message }, 500); }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // replaceAll, not replace: app.html carries the placeholder TWICE (the app-version meta and the script src), and
      // String.replace with a string pattern substitutes the FIRST match only. The script tag therefore shipped as the
      // literal `/app.js?v=__VERSION__`, so the entry the page asks for never matched the `/app.js` the worker
      // precached: the 295 KB bundle was fetched a second time on the first launch of every build.
      let signedIn; try { signedIn = await sessionValid(request, env); } catch (e) { if (e.code !== "session_unavailable") throw e; return html("<p>The hub cannot check your sign-in right now. Try again in a minute.</p>", 503, { "retry-after": "30", ...NO_SCRIPT }); }
      if (signedIn) { const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
        return html(APP_HTML.replaceAll("__VERSION__", await appVersion()).replaceAll("__NONCE__", nonce), 200, { "x-app-shell": "1", "content-security-policy": SHELL_CSP.replace("__NONCE__", nonce) }); }
      const cfg = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? "1" : "0";
      const pw = env.UI_PASSWORD_DISABLED === "1" ? "0" : "1";
      return html(LOGIN_HTML.replace("__GOOGLE__", cfg).replace("__PASSWORD__", pw));
    }
    return new Response("not found", { status: 404 });
  },
};
