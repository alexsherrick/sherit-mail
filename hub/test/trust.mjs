#!/usr/bin/env node
// run_all: alone (it holds time limits; with other tests running, the CPU they take decides it)
// The "real or fake" check (src/client/trust.js) run on its own: fixtures shaped like the user's real mail of
// 2026-10-05: the fake Punchbowl from a hijacked Gmail, genuine Evite / Paperless Post / Dropbox / DocuSign mail, a forwarded
// invitation, a newsletter that mentions a brand, legitimate senders with no DMARC record, and forged header order.
// Usage: node test/trust.mjs (exit 1 on any failed check)
import { readFileSync } from "node:fs"; import vm from "node:vm";
const ctx = {}; vm.createContext(ctx); vm.runInContext(readFileSync(new URL("../src/client/trust.js", import.meta.url), "utf8") + "\n;globalThis.assessTrust = assessTrust; globalThis.trustedAuth = trustedAuth;", ctx);
const fails = []; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const AR = (server, dmarc, from, policy = "NONE") => `${server}; dkim=pass header.i=@${from} header.s=s1 header.b=xyz; spf=pass smtp.mailfrom=${from}; ${dmarc ? `dmarc=${dmarc} (p=${policy} sp=${policy} dis=NONE) header.from=${from}` : ""}`;
const a = (m) => ctx.assessTrust(m);
// 1. a phish, shape for shape: Punchbowl's images, a hijacked Gmail, every link to a seven-day-old domain
const phish = { fromAddr: "dana.park@gmail.com", to: "undisclosed-recipients:;", subject: "Come to rejoice with me", date: Date.UTC(2026, 8, 14), authResults: [AR("mx.google.com", "pass", "gmail.com")],
  html: `<img src="https://static.punchbowl.com/assets/logos/punchbowl/logo_punchbowl.png" alt="Punchbowl"><h2>You're invited!</h2><p>Friends and family, Join me to celebrate.</p><a href="https://qxvbnk.info/welcometomyparty"><img src="https://static.punchbowl.com/assets/email/invite/btn_open_invitation_170x40.png" alt="Open your invitation"></a><a href="https://qxvbnk.info/welcometomyparty">Remove yourself</a><a href="http://www.avast.com">www.avast.com</a><p>💻 Optimized for desktop: Please open on a computer to access the full experience.</p>` };
let v = a(phish);
check(v?.level === "danger" && /Punchbowl/.test(v.title) && v.ageDomain === "qxvbnk.info", `the fake Punchbowl from a hijacked Gmail is flagged, naming the real destination (${JSON.stringify(v && { level: v.level, title: v.title, age: v.ageDomain })})`);
check(v && v.lines.some((l) => /hijacked/.test(l)) && v.lines.some((l) => /undisclosed/.test(l)) && v.lines.some((l) => /computer/.test(l)), `and says why: real account, undisclosed recipients, "open on a computer" (${v && v.lines.length} reasons)`);
// 2. a lookalike: "Lee Rivers invited you" wearing Evite, from somewhere that is not Evite
v = a({ fromAddr: "lee.rivers.events@outlook.com", to: "sam@example.com", subject: "Lee Rivers invited you", authResults: [AR("mx.google.com", "pass", "outlook.com")],
  html: `<img src="https://g0.evitecdn.com/x/header.png"><p>Lee Rivers invited you to a party</p><a href="https://party-rsvp.top/i/8f2">View invitation</a>` });
check(v?.level === "danger" && /Evite/.test(v.title) && v.ageDomain === "party-rsvp.top", `a fake Evite naming a contact is flagged (${v && v.title})`);
v = a({ fromAddr: "lee@rivers-family.example", subject: "Party!", text: "Lee Rivers sent you an invitation on Evite. Open invitation: https://evite-rsvp.top/x9", authResults: [] });
check(v === null, "a plain-text Evite mention from a non-personal, non-lookalike domain stays silent");
v = a({ fromAddr: "invites@evite-events.com", subject: "You're invited", text: "Lee Rivers sent you an invitation on Evite. Open invitation: https://evite-rsvp.top/x9" });
check(v?.level === "danger" && v.ageDomain === "evite-rsvp.top", `a lookalike sender domain borrowing the brand name is flagged even with no images (${v && v.title})`);
v = a({ fromAddr: "lee.rivers@gmail.com", subject: "You're invited", text: "Lee Rivers sent you an invitation on Evite! Open invitation: https://evite-rsvp.top/x9" });
check(v?.level === "danger", "a text-only fake Evite from a personal mailbox is flagged");
// 3. genuine mail stays silent
check(a({ fromAddr: "info@mailva.evite.com", subject: "Don't forget! Riley's 4th Birthday is coming up.", authResults: [AR("mx.google.com", "pass", "mailva.evite.com")],
  html: `<img src="https://g0.evitecdn.com/a.png"><a href="https://www.evite.com/event/1">View invitation</a><a href="https://instagram.com/evite">ig</a><a href="https://itunes.apple.com/app/evite">app</a><a href="https://privacyportal-cdn.onetrust.com/x">privacy</a>` }) === null, "a genuine Evite (from evite.com, DMARC pass) is silent");
check(a({ fromAddr: "robin.owner@gmail.com", subject: "Fwd: Mia's 5th Birthday", authResults: [AR("mx.google.com", "pass", "gmail.com")],
  html: `<img src="https://assets.ppassets.com/p/1.png"><a href="https://links.paperlesspost.com/ls/click?x">Open invitation</a><a href="#">x</a>` }) === null, "a friend forwarding a genuine Paperless Post invitation is silent (its links stay on Paperless Post)");
check(a({ fromAddr: "no-reply@dropbox.com", subject: "Victoria shared a folder", html: `<img src="https://cfl.dropboxstatic.com/a.png"><a href="https://www.dropbox.com/s/1">View folder</a>` }) === null, "a genuine Dropbox share is silent");
check(a({ fromAddr: "dse_NA4@docusign.net", subject: "Please DocuSign", html: `<img src="https://docucdn-a.akamaihd.net/olive/images/2.62.0/global-assets/email-templates/email-logo.png"><a href="https://na4.docusign.net/Signing/x">REVIEW DOCUMENTS</a>` }) === null, "a genuine DocuSign request is silent");
check(a({ fromAddr: "bob@acme.co", subject: "deck", text: "I shared a document with you on Google Drive: https://docs.google.com/d/1 — and the zoom is https://zoom.us/j/1" }) === null, "a colleague sharing a Google Doc plus a Zoom link is silent");
check(a({ fromAddr: "news@kids-weekly.example", subject: "Party season", html: `<p>Plan your party with Evite and get every RSVP!</p><a href="https://click.mcsv.net/1">Read</a><a href="https://click.mcsv.net/2">More</a>` }) === null, "a newsletter that mentions Evite and RSVP through its own mailing service is silent");
check(a({ fromAddr: "ali@smallfund.example", subject: "update", authResults: ["mx.google.com; dkim=pass header.i=@smallfund.example header.s=google; spf=none"], text: "hi" }) === null, "a real person at a domain with no DMARC record is silent");
check(a({ fromAddr: "experience@retreat.example", authResults: [AR("mx.cloudflare.net", "pass", "retreat.example")], text: "hi" }) === null, "domain mail that passed at Cloudflare is silent");
check(a({ out: true, fromAddr: "me@x.com", html: `<img src="https://static.punchbowl.com/a.png"><a href="https://evil.example">x</a>` }) === null, "your own sent mail is never assessed");
// 4. sender verification: only an explicit DMARC failure, read from the receiver's own (first) stamp
v = a({ fromAddr: "no-reply@accounts.google.com", authResults: [AR("mx.google.com", "fail", "accounts.google.com", "REJECT")], text: "Your Google Account is being deleted" });
check(v?.level === "warn" && /accounts\.google\.com/.test(v.title) && /rejected/.test(v.lines[0]), `a forgery of a domain with p=REJECT is flagged (${v && v.title})`);
check(a({ fromAddr: "x@bank.example", authResults: [AR("mx.cloudflare.net", "fail", "bank.example").replace(/\(p=NONE[^)]*\)/, "") + " policy.dmarc=quarantine"], text: "x" })?.level === "warn", "Cloudflare's policy.dmarc=quarantine counts the same way");
check(a({ fromAddr: "newsletter@ghost.io", authResults: [AR("mx.google.com", "fail", "ghost.io", "NONE")], text: "This week's track" }) === null, "a failure under p=none (a genuine newsletter in the replay) is silent");
v = a({ fromAddr: "service@paypal.com", authResults: [AR("mx.google.com", "fail", "paypal.com", "REJECT"), AR("mx.google.com", "pass", "paypal.com", "REJECT")], text: "x" });
check(v?.level === "warn", "a forged passing stamp BELOW the receiver's own does not hide the failure");
v = a({ fromAddr: "service@paypal.com", authResults: [AR("mx.evil.example", "pass", "paypal.com", "REJECT"), AR("mx.google.com", "fail", "paypal.com", "REJECT")], text: "x" });
check(v?.level === "warn", "a stamp from any server but ours is ignored");
check(ctx.trustedAuth(["mx.cloudflare.net; dkim=pass header.i=experience@retreat.example header.s=k3; dmarc=pass header.from=retreat.example policy.dmarc=none; spf=pass"])?.from === "retreat.example", "Cloudflare's stamp parses (dmarc + header.from)");
// 5. speed: the check over a 300 KB newsletter-sized message
const big = { fromAddr: "news@shop.example", html: ("<p>Deals <a href='https://shop.example/x'>shop</a> <img src='https://cdn.shop.example/i.png' alt='sale'></p>").repeat(3000) };
a(big); const t = performance.now(); for (let i = 0; i < 50; i++) a(big); const ms = (performance.now() - t) / 50;
check(ms < 10, `a ${Math.round(big.html.length / 1024)} KB message is assessed in ${ms.toFixed(2)} ms`);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall real-or-fake checks passed");
