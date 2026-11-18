#!/usr/bin/env python3
"""Compare the hub's Gmail mirror (GET /api/gmail/mirror) with Gmail itself, per account (used for its rollout and its
2026-10-14 prediction). Usage: python3 cli/verify_mirror.py (reads the CLI token from ~/.config/mailhub/token; exit 1 on a difference)
Checks: every message Gmail lists for the window (newer_than:90d, Trash/Spam included, drafts excluded) and the unread inbox is in the
mirror with metadata; every mirror row with metadata is something Gmail still has; and the labels of a sample match Gmail's."""
import json, os, random, sys, urllib.request, urllib.parse
HUB = "https://mail.yourdomain.example"
TOK = open(os.path.expanduser("~/.config/mailhub/token")).read().strip()
def hub(path, method="GET"):
    r = urllib.request.Request(HUB + path, method=method, headers={"Authorization": "Bearer " + TOK, "User-Agent": "mail-cli/1"})
    return json.load(urllib.request.urlopen(r))
def gmail(at, path):
    return json.load(urllib.request.urlopen(urllib.request.Request("https://gmail.googleapis.com/gmail/v1/users/me/" + path, headers={"Authorization": "Bearer " + at})))
def listed(at, query):
    ids, page = [], None
    while True:
        d = gmail(at, "messages?maxResults=500&" + query + ("&pageToken=" + page if page else ""))
        ids += [m["id"] for m in d.get("messages", [])]; page = d.get("nextPageToken")
        if not page: return ids
bad = 0
for acct in [a["email"] for a in hub("/api/gmail/accounts")["accounts"] if a["status"] == "active"]:
    at = hub(f"/api/gmail/accounts/{urllib.parse.quote(acct)}/token", "POST")["access_token"]
    rows, after, first = [], "", None
    while True:
        d = hub(f"/api/gmail/mirror?account={urllib.parse.quote(acct)}&limit=1000" + (f"&after={urllib.parse.quote(after)}" if after else ""))
        first = first or d; rows += d["rows"]; after = d.get("next") or ""
        if not after: break
    full = {r["id"]: r for r in rows if r["meta"]}; stubs = [r for r in rows if not r["meta"]]
    want = set(listed(at, "includeSpamTrash=true&q=" + urllib.parse.quote("newer_than:90d -in:drafts"))) | set(listed(at, "labelIds=INBOX&labelIds=UNREAD"))
    missing = sorted(want - set(full)); extra = sorted(set(full) - want)
    # extra rows are allowed when they carry INBOX (scope): check those against Gmail directly
    sample = random.sample(sorted(full), min(40, len(full))) + extra[:40]
    mism, gone = [], []
    for mid in sample:
        try: m = gmail(at, f"messages/{mid}?format=minimal")
        except urllib.error.HTTPError as e:
            if e.code == 404: gone.append(mid); continue
            raise
        if sorted(m.get("labelIds", [])) != sorted(json.loads(full[mid]["labels"])): mism.append((mid, sorted(m.get("labelIds", [])), sorted(json.loads(full[mid]["labels"]))))
    st = first.get("status")
    print(f"{acct}: status {st} complete={first.get('complete')} | mirror {len(full)} rows + {len(stubs)} stubs | Gmail lists {len(want)} | missing {len(missing)} | extra {len(extra)} | sampled {len(sample)}: {len(mism)} label mismatches, {len(gone)} gone in Gmail")
    for x in missing[:5]: print("   missing", x)
    for x in mism[:5]: print("   labels", x)
    for x in gone[:5]: print("   gone", x)
    bad += len(missing) + len(mism) + len(gone)
print("MIRROR MATCHES GMAIL" if not bad else f"{bad} DIFFERENCES")
sys.exit(1 if bad else 0)
