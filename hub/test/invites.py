#!/usr/bin/env python3
"""A calendar invitation in the mail shows as a card you can answer. In WebKit and Chromium, the page's clock in
New York, with the app's fake network (test/mock-fetch.js):
  - a hub mail carrying an invite.ics (Chicago time, a Meet link, an organizer and guests) shows a card above the message: the title,
    the time in the viewer's own zone (10:00 Chicago is 11:00 here), the video link, who sent it and who is coming;
  - Yes queues an iTIP REPLY to the organizer from the address the invitation is to: METHOD:REPLY, the same UID, DTSTART and organizer,
    the attendee ACCEPTED, as text/calendar beside the text; the card then shows the answer, kept as a pref for every device;
  - a Gmail account's answer is built as multipart/alternative, text/plain then text/calendar; method=REPLY;
  - times: an Outlook "Central Standard Time", a zone given only by its own VTIMEZONE rules (summer and winter), UTC, all day;
  - a cancellation says Canceled and offers no answer; an answer to your own invitation says who accepted; escaped text reads plainly;
    the REPLY's lines are folded at 75 octets;
  - a copy the hub stored as the text of its byte values ("66,69,71,...", before this change) still reads;
  - a crafted invitation's extra VTIMEZONE content, organizer parameters and conference link reach neither the REPLY nor the card;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the card checks.
Usage: python3 test/invites.py"""
import os, sys, base64, email
from email import policy
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID; GMAIL = "sam.owner.sxsw@gmail.com"
def ics(me, method="REQUEST", extra=""):
    return "\r\n".join(["BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", f"METHOD:{method}",
        "BEGIN:VTIMEZONE", "TZID:America/Chicago", "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD", "END:VTIMEZONE",
        "BEGIN:VEVENT", "DTSTART;TZID=America/Chicago:20261201T100000", "DTEND;TZID=America/Chicago:20261201T110000", "DTSTAMP:20261126T020000Z",
        "ORGANIZER;CN=Dana Smith:mailto:dana@work.example", "UID:evt-42@calendar.example",
        f"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN={me}:mailto:{me}",
        "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Eve Example:mailto:eve@work.example",
        "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", "SEQUENCE:0", "STATUS:CONFIRMED", "SUMMARY:Planning\\, then lunch",
        "LOCATION:Room 4\\, second floor", "DESCRIPTION:Agenda:\\nthe plan", extra, "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:not the event", "TRIGGER:-P0DT0H10M0S", "END:VALARM",
        "END:VEVENT", "END:VCALENDAR", ""]).replace("\r\n\r\n", "\r\n")
SETUP = """([tid, icsB64, size]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; const m = r.messages[r.messages.length - 1];
  m.attachments = [{ id: 'att-ics', filename: 'invite.ics', content_type: 'text/calendar', size_bytes: size, disposition: 'attachment' }];
  window.__mock.routes['GET /api/att/att-ics'] = { __b64: icsB64 }; }"""
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
OPEN = """async (k) => { window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key)); await window.mh.openThread(k); await new Promise((r) => setTimeout(r, 700)); const c = document.querySelector('#msgs .invite'); return c ? c.innerText : null; }"""
WHEN = "([src]) => { const iv = window.mh.invites; const cal = iv.parseIcs(src); const w = iv.inviteWhen(cal.events[0], cal); return w ? { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(), allDay: w.allDay, text: iv.whenText(w), summary: cal.events[0].summary } : null; }"
def one(dt, dtend="", zone=""):
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", *([zone] if zone else []), "BEGIN:VEVENT", "UID:u1", dt, *([dtend] if dtend else []), "SUMMARY:x", "END:VEVENT", "END:VCALENDAR"])
OUTLOOK_ZONE = "\r\n".join(["BEGIN:VTIMEZONE", "TZID:Custom Zone", "BEGIN:STANDARD", "DTSTART:16011104T020000", "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "END:STANDARD",
                            "BEGIN:DAYLIGHT", "DTSTART:16010311T020000", "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "END:DAYLIGHT", "END:VTIMEZONE"])
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); ctx = b.new_context(viewport={"width": 1300, "height": 900}, timezone_id="America/New_York", locale="en-US"); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        me = page.evaluate("() => (window.mh.state.me.identities[0] || {}).email")
        src = ics(me); page.evaluate(SETUP, [TID, base64.b64encode(src.encode()).decode(), len(src)]); page.evaluate(CAPTURE)
        card = page.evaluate(OPEN, KEY) or ""
        check("Planning, then lunch" in card and "Dec 1" in card and "11:00" in card and "12:00" in card, f"{name}: the card: title (escapes read), the time in the viewer's zone ({card[:160]!r})")
        check("meet.google.com/abc-defg-hij" in card and "Room 4, second floor" in card and "Dana Smith" in card and "Eve Example" in card and "not the event" not in card, f"{name}: where, the video link, who asked and who is coming, not the alarm's words")
        page.click("#msgs .invite [data-rsvp=ACCEPTED]"); preview.settle(page, 600)
        row = page.evaluate("() => (window.__rows || []).find((x) => x.op === 'send')")
        d = (row or {}).get("args", {}).get("draft", {}) if row else {}
        rep = (d.get("calendar") or {}).get("ics", "")
        unf = rep.replace("\r\n ", "")
        check(d.get("to") == ["dana@work.example"] and d.get("from") == me and d.get("subject") == "Accepted: Planning, then lunch" and (d.get("calendar") or {}).get("method") == "REPLY", f"{name}: Yes queues an answer to the organizer from the invited address ({ {k: d.get(k) for k in ('from', 'to', 'subject')} })")
        check("METHOD:REPLY" in unf and "UID:evt-42@calendar.example" in unf and "DTSTART;TZID=America/Chicago:20261201T100000" in unf and 'ORGANIZER;CN="Dana Smith":mailto:dana@work.example' in unf
              and f"PARTSTAT=ACCEPTED" in unf and f"mailto:{me}" in unf and "TZID:America/Chicago" in unf and "Eve" not in unf, f"{name}: the REPLY: same UID, start, zone and organizer, the attendee ACCEPTED, no one else's line")
        check(all(len(l.encode()) <= 75 for l in rep.split("\r\n")), f"{name}: the REPLY's lines are folded at 75 octets")
        # a crafted invitation: a VTIMEZONE carrying an event and a property of its own, an organizer line with extra parameters, a
        # conference link to some other site. The REPLY is written from the values read; the card links no other site.
        evil = src.replace("BEGIN:STANDARD", "X-EVIL:injected\r\nBEGIN:VEVENT\r\nUID:planted\r\nSUMMARY:planted event\r\nEND:VEVENT\r\nBEGIN:STANDARD", 1).replace(
            "ORGANIZER;CN=Dana Smith:mailto:dana@work.example", "ORGANIZER;CN=Dana Smith;SENT-BY=\"mailto:x@evil.example\";X-P=1:mailto:dana@work.example").replace(
            "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", "X-GOOGLE-CONFERENCE:https://evil.example/login")
        ev2 = page.evaluate("""([src, me]) => { const iv = window.mh.invites; const cal = iv.parseIcs(src); return iv.rsvpIcs(cal, cal.events[0], me, 'Sam', 'ACCEPTED'); }""", [evil, me])
        u2 = ev2.replace("\r\n ", "")
        check("planted" not in u2 and "X-EVIL" not in u2 and "SENT-BY" not in u2 and "X-P=" not in u2 and u2.count("BEGIN:VEVENT") == 1 and 'ORGANIZER;CN="Dana Smith":mailto:dana@work.example' in u2 and "TZOFFSETTO:-0600" in u2, f"{name}: a crafted invitation's extra lines and parameters never reach the REPLY ({[l for l in u2.split(chr(13)+chr(10)) if 'ORGANIZER' in l or 'planted' in l]})")
        page.evaluate(SETUP, [TID, base64.b64encode(evil.encode()).decode(), len(evil)])
        page.evaluate("(k) => { const r = window.__mock.routes['GET /api/threads/' + k.split('|')[1]]; const m = r.messages[r.messages.length - 1]; m.id = m.id + 'e'; }", KEY)
        c3 = page.evaluate(OPEN, KEY) or ""
        hrefs = page.evaluate("() => [...document.querySelectorAll('#msgs .invite a')].map((a) => a.getAttribute('href'))")
        check("evil.example" not in c3 and not any("evil.example" in (h or "") for h in hrefs), f"{name}: a conference link to another site is not shown as Join ({hrefs})")
        card2 = page.evaluate("() => (document.querySelector('#msgs .invite') || {}).innerText || ''")
        saved = page.evaluate("() => (window.mh.state.prefs.rsvp || {})['evt-42@calendar.example']")
        check("You said yes" in card2 and saved and saved.get("p") == "ACCEPTED", f"{name}: the card shows the answer, kept as a pref ({saved})")
        # a Gmail account's answer, as the queue would hand it to Gmail
        raw = page.evaluate("([g, ics]) => window.mh.buildMime({ from: g, to: ['dana@work.example'], subject: 'Accepted: Planning', text: 'ok', calendar: { method: 'REPLY', ics } })", [GMAIL, rep])
        mm = email.message_from_bytes(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)), policy=policy.default)
        kinds = [(p.get_content_type(), p.get_param("method")) for p in mm.walk() if not p.is_multipart()]
        check(mm.get_content_type() == "multipart/alternative" and kinds == [("text/plain", None), ("text/calendar", "REPLY")], f"{name}: a Gmail account's answer is text/plain then text/calendar; method=REPLY ({mm.get_content_type()} {kinds})")
        # times
        w1 = page.evaluate(WHEN, [one("DTSTART;TZID=Central Standard Time:20260715T090000", "DTEND;TZID=Central Standard Time:20260715T100000")])
        w2 = page.evaluate(WHEN, [one("DTSTART;TZID=Custom Zone:20260715T090000", "", OUTLOOK_ZONE)])
        w3 = page.evaluate(WHEN, [one("DTSTART;TZID=Custom Zone:20260115T090000", "", OUTLOOK_ZONE)])
        w4 = page.evaluate(WHEN, [one("DTSTART:20261201T150000Z", "DTEND:20261201T153000Z")])
        w5 = page.evaluate(WHEN, [one("DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261226")])
        check(w1 and w1["start"] == "2026-07-15T14:00:00.000Z" and w1["end"] == "2026-07-15T15:00:00.000Z", f"{name}: Outlook's 'Central Standard Time' is Chicago, summer time kept ({w1})")
        check(w2 and w2["start"] == "2026-07-15T14:00:00.000Z" and w3 and w3["start"] == "2026-01-15T15:00:00.000Z", f"{name}: a zone known only by its VTIMEZONE rules, summer and winter ({w2 and w2['start']}, {w3 and w3['start']})")
        check(w4 and w4["start"] == "2026-12-01T15:00:00.000Z" and "10:00" in w4["text"] and "10:30" in w4["text"], f"{name}: a UTC time, shown in the viewer's zone ({w4 and w4['text']})")
        tzc = page.evaluate("""() => { const iv = window.mh.invites; const z = '(UTC-06:00) Central Time (US & Canada)'; const src = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:u9', 'DTSTART;TZID="' + z + '":20261201T100000', 'DTEND;TZID="' + z + '":20261201T110000', 'ORGANIZER:mailto:dana@work.example', 'SUMMARY:x', 'END:VEVENT', 'END:VCALENDAR'].join('\\r\\n');
          const cal = iv.parseIcs(src); return { start: new Date(iv.inviteWhen(cal.events[0], cal).start).toISOString(), reply: iv.rsvpIcs(cal, cal.events[0], 'me@x.example', 'Me', 'ACCEPTED').replace(/\\r\\n /g, '') }; }""")
        check(tzc["start"] == "2026-12-01T16:00:00.000Z" and 'DTSTART;TZID="(UTC-06:00) Central Time (US & Canada)":20261201T100000' in tzc["reply"], f"{name}: Outlook's zone name with a colon is read, and written back quoted, not dropped ({tzc['start']})")
        EXPLICIT = "\r\n".join(["BEGIN:VTIMEZONE", "TZID:Explicit Zone", "BEGIN:DAYLIGHT", "DTSTART:20260308T020000", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "END:DAYLIGHT", "BEGIN:STANDARD", "DTSTART:20261101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "END:STANDARD", "END:VTIMEZONE"])
        w6 = page.evaluate(WHEN, [one("DTSTART;TZID=Explicit Zone:20260701T130000", "", EXPLICIT)]); w7 = page.evaluate(WHEN, [one("DTSTART;TZID=Explicit Zone:20261201T130000", "", EXPLICIT)])
        check(w6 and w6["start"] == "2026-07-01T18:00:00.000Z" and w7 and w7["start"] == "2026-12-01T19:00:00.000Z", f"{name}: a zone written as explicit changes (no RRULE): summer and winter ({w6 and w6['start']}, {w7 and w7['start']})")
        ENDED = "\r\n".join(["BEGIN:VTIMEZONE", "TZID:Old And New", "BEGIN:DAYLIGHT", "DTSTART:19870405T020000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=20060402T080000Z", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "END:DAYLIGHT",
            "BEGIN:STANDARD", "DTSTART:19671029T020000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20061029T070000Z", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "END:STANDARD",
            "BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "END:DAYLIGHT",
            "BEGIN:STANDARD", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "END:STANDARD", "END:VTIMEZONE"])
        w8 = page.evaluate(WHEN, [one("DTSTART;TZID=Old And New:20261028T130000", "", ENDED)])
        check(w8 and w8["start"] == "2026-10-28T18:00:00.000Z", f"{name}: a rule that ended (UNTIL) does not decide a later year's time ({w8 and w8['start']})")
        longuid = "u" + "x" * 600 + "@example"
        lu = page.evaluate("""([uid]) => { const iv = window.mh.invites; const cal = iv.parseIcs(['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:' + uid, 'DTSTART:20261201T150000Z', 'ORGANIZER:mailto:dana@work.example', 'END:VEVENT', 'END:VCALENDAR'].join('\\r\\n')); return iv.rsvpIcs(cal, cal.events[0], 'me@x.example', 'Me', 'ACCEPTED').replace(/\\r\\n /g, ''); }""", [longuid])
        check(("UID:" + longuid) in lu, f"{name}: a long UID goes back exactly as it came")
        check(w5 and w5["allDay"] and "Dec 24" in w5["text"] and "Dec 25" in w5["text"] and "all day" in w5["text"], f"{name}: all day, two days ({w5 and w5['text']})")
        # a cancellation; an answer to your invitation; your own invitation
        for method, extra, want, nobtn in [("CANCEL", "", "Canceled", True), ("REPLY", "", "accepted this invitation", True)]:
            src2 = ics(me, method).replace(f"PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN={me}:mailto:{me}\r\n", "") if method == "REPLY" else ics(me, method)
            page.evaluate("() => { window.mh.state.prefs.rsvp = {}; }")
            page.evaluate(SETUP, [TID, base64.b64encode(src2.encode()).decode(), len(src2)])
            page.evaluate("() => { for (const k of [...(window.mh.inviteCache ? [] : [])]) ; }")
            c = page.evaluate("""async (k) => { const r = window.__mock.routes['GET /api/threads/' + k.split('|')[1]]; const m = r.messages[r.messages.length - 1]; m.id = m.id + 'x'; return null; }""", KEY)
            c = page.evaluate(OPEN, KEY) or ""
            btns = page.evaluate("() => document.querySelectorAll('#msgs .invite [data-rsvp]').length")
            check(want in c and (btns == 0) == nobtn, f"{name}: METHOD:{method} says {want!r}, no answer buttons ({c[:120]!r}, {btns} buttons)")
        # a copy stored before the fix, as the text of its byte values
        dec = ",".join(str(x) for x in src.encode())
        page.evaluate(SETUP, [TID, base64.b64encode(dec.encode()).decode(), len(dec)])
        page.evaluate("(k) => { const r = window.__mock.routes['GET /api/threads/' + k.split('|')[1]]; const m = r.messages[r.messages.length - 1]; m.id = m.id + 'd'; }", KEY)
        c = page.evaluate(OPEN, KEY) or ""
        check("Planning, then lunch" in c and "11:00" in c, f"{name}: an invitation the hub stored as its byte values still reads ({c[:60]!r})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all invitation checks passed")
sys.exit(1 if fails else 0)
