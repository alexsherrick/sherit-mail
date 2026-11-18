// ---------- Real or fake ----------
// One pure function over a message the app already holds. It answers two things: what the RECEIVING server says about who really
// sent it, and whether it wears a known brand's look without being sent by that brand while its links go somewhere else. That is
// the fake-invitation pattern (a fake Evite or Punchbowl invitation, often sent from a hijacked personal Gmail account, with
// every link to a domain registered days earlier). It runs
// where the message is drawn: about a millisecond, no network, no Gmail quota. It is silent on everything else: a missing DMARC
// record is normal (8 of 150 genuine messages in my Gmail), and a forward whose links stay on the brand is a forward.
// Self-contained on purpose: test/trust.mjs runs this file on its own against fixtures and my real mail.

// Only the receiving server's own stamp counts. Receivers PREPEND Authentication-Results, so theirs is the first one carrying their
// name; anything further down could have been written by the sender.
// `<(x)\b[\s\S]*?<\/\1>` is quadratic on an opener with no closer (every start rescans to the end), and mail decides the input:
//  the same blocks dropped in one pass with indexOf; a block with no closer stays, as the regex left it.
function dropTagBlocks(s, names) {
  s = String(s ?? ""); const lower = s.toLowerCase(), re = new RegExp("<(" + names + ")\\b", "gi"), dead = new Set(); let out = "", at = 0, m;
  while ((m = re.exec(s))) { const n = m[1].toLowerCase(); if (dead.has(n)) continue; const k = lower.indexOf("</" + n + ">", m.index + m[0].length); if (k < 0) { dead.add(n); continue; } out += s.slice(at, m.index) + " "; at = k + n.length + 3; re.lastIndex = at; }
  return at ? out + s.slice(at) : s;
}
const TRUST_SERVERS = ["mx.google.com", "mx.cloudflare.net"];
// Each brand: the domains it really sends from, where its emails' images live, where its links go, its name. Every entry was checked
// against a genuine message in my mail on 2026-10-05 (Evite, Paperless Post, Punchbowl, Greenvelope, DocuSign, Dropbox,
// Adobe Acrobat Sign, Google Drive) or against Sublime's rule for it (Greetings Island).
const TRUST_BRANDS = [
  { name: "Evite", home: "evite.com", from: ["evite.com"], assets: ["evitecdn.com", "evite.com", "eviteideas.com"], links: ["evite.com"], word: /\bevite\b/i },
  { name: "Punchbowl", home: "punchbowl.com", from: ["punchbowl.com"], assets: ["punchbowl.com"], links: ["punchbowl.com"], word: /\bpunchbowl\b/i },
  { name: "Paperless Post", home: "paperlesspost.com", from: ["paperlesspost.com"], assets: ["ppassets.com", "paperlesspost.com"], links: ["paperlesspost.com"], word: /\bpaperless\s?post\b/i },
  { name: "Greenvelope", home: "greenvelope.com", from: ["greenvelope.com", "greenvelope-email.com"], assets: ["greenvelope.com", "greenvelope-email.com"], links: ["greenvelope.com", "greenvelope-email.com"], word: /\bgreenvelope\b/i },
  { name: "Greetings Island", home: "greetingsisland.com", from: ["greetingsisland.com"], assets: ["greetingsisland.com"], links: ["greetingsisland.com"], word: /\bgreetings\s?island\b/i },
  { name: "DocuSign", home: "docusign.com", from: ["docusign.net", "docusign.com"], assets: ["docusign.net", "docusign.com", "docucdn-a.akamaihd.net"], links: ["docusign.net", "docusign.com"], word: /\bdocu\s?sign\b/i },
  { name: "Dropbox", home: "dropbox.com", from: ["dropbox.com"], assets: ["dropbox.com", "dropboxstatic.com"], links: ["dropbox.com"], word: /\bdropbox\b/i },
  { name: "Adobe Acrobat Sign", home: "adobe.com", from: ["echosign.com", "adobesign.com", "adobe.com"], assets: ["echosign.com", "adobesign.com"], links: ["echosign.com", "adobesign.com", "adobe.com"], word: /\b(?:adobe\s+(?:acrobat\s+)?sign|echosign)\b/i },
  { name: "Google Drive", home: "google.com", from: ["google.com"], assets: [], links: ["google.com"], word: /\bgoogle\s+(?:drive|docs|sheets|slides)\b/i },
];
// The phrases these templates use to get the click. With the brand's name they stand in for its images, which a fake need not hotlink.
const TRUST_TEMPLATE = /you(?:'|’)re invited|sent you an? (?:invitation|invite)|open (?:your |the )?invitation|view (?:the |your )?invitation|\brsvp\b|shared (?:a|an|the) (?:document|file|folder|spreadsheet|presentation)|review (?:and|&) sign|sent you (?:a )?documents?|(?:view|open|download) (?:the )?(?:document|file)s?\b/i;
// Links every genuine template carries that say nothing about where the click goes.
const TRUST_NEUTRAL = ["instagram.com", "facebook.com", "twitter.com", "x.com", "tiktok.com", "pinterest.com", "linkedin.com", "youtube.com", "apple.com", "onetrust.com"];
// Personal mailboxes: a brand's NAME (without its images) only counts when the sender is one of these (a hijacked friend) or a
// domain that borrows the brand's name. A newsletter that says "plan your party with Evite, RSVP" through its own mailing service
// is neither, and must stay silent.
const TRUST_FREEMAIL = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "comcast.net", "att.net", "verizon.net"];
// Two-label public suffixes common enough to matter, so "example.co.uk" is one site and not "co.uk".
const TRUST_SUFFIX2 = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "co.in", "com.br", "com.mx", "co.za", "com.sg", "com.hk", "com.tr", "com.cn", "com.tw", "co.kr", "com.ar", "co.il", "com.my", "com.ph"]);
function trustRoot(host) { const h = String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\./, ""); const p = h.split("."); if (p.length <= 2) return h; return TRUST_SUFFIX2.has(p.slice(-2).join(".")) ? p.slice(-3).join(".") : p.slice(-2).join("."); }
function trustHostOf(u) { const m = /^https?:\/\/(?:[^@\/?#\s]*@)?([^\/:?#\s]+)/i.exec(String(u || "").trim()); return m ? m[1].toLowerCase() : ""; }
function trustOn(host, list) { return list.some((d) => host === d || host.endsWith("." + d)); }
// The receiving server's result, from the first Authentication-Results it stamped.
function trustedAuth(values) {
  for (const v of values || []) {
    const s = String(v || "").replace(/\s+/g, " ").trim(); const id = s.split(/[;\s]/)[0].toLowerCase();
    if (!TRUST_SERVERS.includes(id)) continue;
    const r = (k) => ((new RegExp("\\b" + k + "=([a-z]+)", "i").exec(s) || [])[1] || "").toLowerCase() || null;
    // The domain's own policy for failures: Gmail writes "dmarc=fail (p=REJECT...)", Cloudflare "policy.dmarc=reject".
    const policy = ((/\bdmarc=\w+\s*\(p=(\w+)/i.exec(s) || /\bpolicy\.dmarc=(\w+)/i.exec(s) || [])[1] || "").toLowerCase() || null;
    return { server: id, dmarc: r("dmarc"), dkim: r("dkim"), spf: r("spf"), policy, from: ((/\bdmarc=\w+[^;]*?header\.from=([^\s;]+)/i.exec(s) || [])[1] || "").toLowerCase() };
  }
  return null;
}
// → null (nothing to say), or { level: "danger" | "warn", title, lines: [...], ageDomain, date }.
function assessTrust(m) {
  if (!m || m.out) return null;
  const fromAddr = String(m.fromAddr || "").toLowerCase(), fromRoot = trustRoot(fromAddr.split("@")[1] || "");
  const auth = trustedAuth(m.authResults ? [].concat(m.authResults) : []);
  const html = String(m.html || "");
  const visible = (html ? dropTagBlocks(html, "style|script|head").replace(/<[^<>]+>/g, " ") : String(m.text || ""))
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&(?:#39|#x27|apos|rsquo|#8217);/gi, "'").replace(/&amp;/gi, "&");
  const alts = html ? [...html.matchAll(/\balt\s*=\s*["']([^"']*)["']/gi)].map((x) => x[1]).join(" ") : "";
  const imgs = html ? [...html.matchAll(/<img\b[^<>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)].map((x) => trustHostOf(x[1])).filter(Boolean) : [];
  const links = (html ? [...html.matchAll(/<a\b[^<>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]) : [...visible.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((x) => x[0]))
    .map(trustHostOf).filter(Boolean);
  const template = TRUST_TEMPLATE.test(visible) || TRUST_TEMPLATE.test(alts);
  const out = { level: null, title: "", lines: [], ageDomain: null, date: m.date || 0 };
  for (const b of TRUST_BRANDS) {
    if (trustOn(fromRoot, b.from)) continue;   // sent by the brand (whether it really was is the sender check below)
    const assetHits = imgs.filter((h) => trustOn(h, b.assets)).length;
    const named = b.word.test(visible) || b.word.test(alts);
    const borrowed = b.word.test(fromRoot.replace(/[-.]/g, " "));   // "evite-events.com", "docusign-secure.net"
    if (!assetHits && !(named && template && (TRUST_FREEMAIL.includes(fromRoot) || borrowed))) continue;
    const off = links.filter((h) => !trustOn(h, [...b.links, ...b.from, ...b.assets]) && trustRoot(h) !== fromRoot && !trustOn(h, TRUST_NEUTRAL));
    if (!off.length) continue;   // its links stay on the brand: a forward, or a genuine invitation pasted in; nothing to say
    // Without the brand's images, only a TEMPLATE counts, not a person mentioning the brand: most of its links must leave for elsewhere.
    if (!assetHits && off.length / links.length < 0.6) continue;
    const tally = {}; for (const h of off) { const r = trustRoot(h); tally[r] = (tally[r] || 0) + 1; }
    const top = Object.keys(tally).sort((x, y) => tally[y] - tally[x])[0];
    out.level = "danger"; out.ageDomain = top;
    out.title = `Looks like ${b.name}, but it wasn't sent by ${b.name}.`;
    out.lines.push(`It came from ${fromAddr || "an unknown address"}, not ${b.home}.`);
    out.lines.push(`Its links go to ${top}, not ${b.home}.`);
    if (auth && auth.dmarc === "pass") out.lines.push(`The account itself is real (${auth.from || fromRoot} confirmed it was sent from it). That is what a hijacked account looks like.`);
    if (/undisclosed[- ]recipients/i.test(String(m.to || "")) || (!m.to && !m.cc)) out.lines.push("It was sent to undisclosed recipients — a mass mailing, not a personal invitation.");
    if (/(?:open|view|access)\b[^.]{0,40}\bon (?:a |your )?(?:computer|desktop|laptop|pc)\b|optimi[sz]ed for desktop/i.test(visible)) out.lines.push("It asks you to open it on a computer — the usual sign of a download aimed at a PC.");
    return out;
  }
  // Only a failure against a domain that ASKED receivers to quarantine or reject failing mail: that is a forgery of a domain that
  // protects itself (a fake "Your Google Account is being deleted" claiming accounts.google.com, p=REJECT, in the user's spam).
  // A failure under p=none is a sloppy sender far more often than a forgery (a genuine ghost.io newsletter in the replay) and says
  // nothing the user can act on (2026-10-05 replay: 1 of 155 genuine messages in one account).
  if (auth && auth.dmarc === "fail" && (auth.policy === "reject" || auth.policy === "quarantine")) {
    const who = auth.from || fromRoot;
    out.level = "warn"; out.title = `Not verified: this claims to be from ${who}, but ${who}'s own check says it isn't.`;
    out.lines.push(`${who} publishes a rule (DMARC) for proving its mail is real and asks for mail that fails it to be ${auth.policy === "reject" ? "rejected" : "treated as spam"}. This message failed it.`);
    return out;
  }
  return null;
}
