#!/usr/bin/env python3
"""The mail CLI never prints a mail's control codes to the terminal.

A fake hub answers with a sender address, a scheduled send's subject and error, a message and its raw bytes, each carrying ESC, a C1
CSI (U+009B) and DEL. Run on a terminal (a pseudo-terminal here), `mail senders pending`, `mail schedule pending`, `mail show` (through
jq, and through the plain fallback when jq is missing) and `mail raw` must print none of them; piped, `mail show` keeps the JSON
exactly as sent. CONTROL=1 also runs the CLI as of 6551208, which printed them.
Usage: python3 test/clictl.py (exit 1 on any failed check)"""
import http.server, json, os, re, subprocess, sys, tempfile, threading, tty
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BAD = "evil\x1b[31mRED\x9b2J\x7fend"
CTL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


class Hub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/api/senders"):
            body = {"counts": {"pending": 1}, "senders": [{"last_seen_at": "2026-11-13T00:00:00Z", "status": "pending", "address": BAD + "@x.example", "first_account": BAD}]}
        elif self.path.startswith("/api/raw/"):
            b = ("Subject: " + BAD + "\r\n\r\nbody " + BAD + "\r\n").encode()
            self.send_response(200); self.send_header("content-type", "message/rfc822"); self.end_headers(); self.wfile.write(b); return
        elif self.path.startswith("/api/schedule"):
            body = {"actions": [{"id": "abcdefgh1234", "kind": "send", "account": "a", "due_at": "2026-11-13T10:00:00Z", "payload": {"subject": BAD}, "error": BAD}]}
        else:
            body = {"subject": BAD, "from": BAD}
        b = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
env = {**os.environ, "MAILHUB_URL": f"http://127.0.0.1:{srv.server_address[1]}", "MAILHUB_TOKEN": "x"}
fails = []


def check(ok, msg):
    print(("ok   " if ok else "FAIL ") + msg)
    if not ok:
        fails.append(msg)


def run(cli, args, path=None, term=True):
    """The CLI's output, on a pseudo-terminal in raw mode (no CR added) or, with term=False, through a pipe."""
    e = dict(env)
    if path is not None:
        e["PATH"] = path
    if not term:
        out = subprocess.run(["bash", str(cli), *args], env=e, capture_output=True, timeout=60).stdout.decode("utf-8", "replace")
        return out, len(CTL.findall(out))
    master, slave = os.openpty(); tty.setraw(slave)
    p = subprocess.Popen(["bash", str(cli), *args], env=e, stdout=slave, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    os.close(slave); chunks = []
    while True:
        try:
            b = os.read(master, 65536)
        except OSError:
            break
        if not b:
            break
        chunks.append(b)
    p.wait(timeout=60); os.close(master)
    out = b"".join(chunks).decode("utf-8", "replace")
    return out, len(CTL.findall(out))


# A PATH with python3, curl and the shell's tools but no jq: a folder of links to the ones this machine has.
nojq = tempfile.mkdtemp()
for tool in ("python3", "curl", "bash", "cat", "env", "tr"):
    found = subprocess.run(["bash", "-c", f"command -v {tool}"], capture_output=True, text=True).stdout.strip()
    if found:
        os.symlink(found, os.path.join(nojq, tool))


def cases(cli, label):
    res = {}
    for args in (["senders", "pending"], ["schedule", "pending"], ["show", "m1"], ["raw", "11111111-2222-3333-4444-555555555555"]):
        out, n = run(cli, args)
        res[" ".join(args)] = (n, "evil" in out)
    out, n = run(cli, ["show", "m1"], path=nojq)
    res["show m1 (no jq)"] = (n, "evil" in out)
    return res


new = cases(ROOT / "cli" / "mail", "now")
for k, (n, shown) in new.items():
    check(n == 0 and shown, f"`mail {k}` prints the mail's text to a terminal without its control codes ({n} left)")
piped, _ = run(ROOT / "cli" / "mail", ["show", "m1"], term=False)
try:
    kept = json.loads(piped).get("subject") == BAD
except Exception:
    kept = False
check(kept, "piped, `mail show` keeps the JSON exactly as sent, control codes and all, for the program reading it")

if os.environ.get("CONTROL") == "1":
    old = Path(tempfile.mkdtemp()) / "mail"
    old.write_text(subprocess.run(["git", "show", "6551208:cli/mail"], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    res = cases(old, "6551208")
    check(sum(n for n, _ in res.values()) > 0, f"CONTROL: the CLI at 6551208 printed them ({', '.join(f'{k}: {n}' for k, (n, _) in res.items())})")

srv.shutdown()
print(f"\n{len(fails)} FAILED" if fails else "\nall CLI control-code checks passed")
sys.exit(1 if fails else 0)
