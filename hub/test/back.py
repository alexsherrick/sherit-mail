#!/usr/bin/env python3
"""Back-gesture receipts on headless Chromium (fake network from test/mock-fetch.js). The report: a left
swipe should go back instead of closing the app. Opening a conversation, Settings, the composer or the side menu only toggled a
CSS class, so the installed PWA had NOTHING on the history stack: Android's back gesture found nothing to pop and closed the app.
Every dismissable layer now owns one history entry. These checks cover: the entry is pushed, the gesture unwinds the UI instead of
leaving, an in-app close consumes its entry rather than stranding it, and moving between conversations does not stack one entry per
conversation. Usage: python3 test/back.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0,"test")
import preview
from playwright.sync_api import sync_playwright
srv=preview.serve(); base=f"http://127.0.0.1:{srv.server_address[1]}/"
UA="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36"
fails=[]
# a missing back stack is the defect itself, not a crash: report it and let the remaining checks still run
LAYERS = "() => (window.mh && window.mh.layers) ? window.mh.layers.length : -1"
def check(c,m):
    print(("ok   " if c else "FAIL ")+m); (c or fails.append(m))
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(user_agent=UA,viewport={"width":390,"height":844},has_touch=True)
    page=ctx.new_page(); page.goto(base)
    page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 2500)
    depth0 = page.evaluate("() => history.length")
    # if the back gesture leaves the app, #app is gone from the document: that IS the reported bug, so it must read as a FAIL
    # rather than a traceback. Everything below asks the page this way.
    inApp = lambda: page.evaluate("() => !!document.querySelector('#app')")
    viewing = lambda: page.evaluate("() => { const a = document.querySelector('#app'); return !!a && a.classList.contains('viewing'); }")
    k = page.evaluate("() => [...document.querySelectorAll('.t')][0].dataset.key")

    page.evaluate("(k)=>window.mh.openThread(k)", k); preview.settle(page, 500)
    check(viewing(), "conversation open")
    check(page.evaluate("() => history.length") > depth0, "opening a conversation pushes a history entry (it pushed none before)")
    check(page.evaluate(LAYERS) == 1, "one layer on the stack")

    page.go_back(); preview.settle(page, 700)
    check(inApp(), "the BACK GESTURE stays in the app (before the fix it navigated away and the PWA closed)")
    check(inApp() and not viewing(), "and returns to the conversation list")
    check(page.evaluate(LAYERS) == 0, "and the layer stack is empty again")

    # the in-app chevron must consume its entry too, or the next back looks dead
    page.evaluate("(k)=>window.mh.openThread(k)", k); preview.settle(page, 500)
    page.evaluate("() => document.querySelector('#back').click()"); preview.settle(page, 500)
    check(not viewing(), "the Back chevron closes the conversation")
    check(page.evaluate(LAYERS) == 0, "and consumes its history entry rather than stranding it")

    # next/prev while reading must not stack an entry per conversation
    keys = page.evaluate("() => [...document.querySelectorAll('.t')].slice(0,3).map(d=>d.dataset.key)")
    for kk in keys:
        page.evaluate("(k)=>window.mh.openThread(k)", kk); preview.settle(page, 250)
    check(page.evaluate(LAYERS) == 1, "moving between conversations keeps ONE entry, not one per conversation")
    page.go_back(); preview.settle(page, 700)
    check(inApp() and not viewing(), "so a single back gesture leaves the reader, still inside the app")

    # settings
    page.evaluate("() => window.mh.state && document.querySelector('#settingsBtn').click()"); preview.settle(page, 900)
    on = page.evaluate("() => document.querySelector('#smodal').classList.contains('on')")
    check(on, "settings open")
    page.go_back(); preview.settle(page, 700)
    check(inApp() and not page.evaluate("() => { const m = document.querySelector('#smodal'); return !!m && m.classList.contains('on'); }"),
          "the back gesture closes Settings instead of the app")
    # settings reached the way a phone reaches it: the drawer, then its gear. Closing the drawer used to leave a history.back()
    # in flight that landed AFTER Settings pushed its own entry and closed Settings instead: the gear did nothing.
    page.click("#menuBtn"); preview.settle(page, 400)
    check(page.evaluate("() => document.querySelector('#app').classList.contains('menu')"), "the drawer opens")
    page.click("#settingsBtn"); preview.settle(page, 900)
    check(page.evaluate("() => document.querySelector('#smodal').classList.contains('on') && !document.querySelector('#app').classList.contains('menu')"),
          "the drawer's gear opens Settings on the first tap, and the drawer closes")
    check(page.evaluate(LAYERS) == 1, "with one layer on the stack (Settings), not the drawer's")
    page.go_back(); preview.settle(page, 700)
    check(inApp() and not page.evaluate("() => document.querySelector('#smodal').classList.contains('on')") and page.evaluate(LAYERS) == 0,
          "and one back gesture closes it, still inside the app")
    # Settings on a phone is a list to tap into (Back steps out of a section to the list, the next back
    # closes Settings, and the close button inside a section closes everything without leaving a layer or a history entry behind.
    VIEW = "() => { const m = document.querySelector('#smodal'), c = document.querySelector('#scard'), nav = c.querySelector('.st-nav'), main = c.querySelector('.st-main'), sw = c.querySelector('[data-sec=swipes]'); return { on: m.classList.contains('on'), insec: c.classList.contains('insec'), nav: !!nav && getComputedStyle(nav).display !== 'none', swipes: !!sw && !sw.hidden && !!main && getComputedStyle(main).display !== 'none' }; }"
    HDEPTH = "() => (history.state && history.state.mhDepth) || 0"
    def open_settings():
        page.evaluate("() => document.querySelector('#settingsBtn').click()"); page.wait_for_function("() => !!document.querySelector('#scard [data-sec-nav]')", timeout=8000); preview.settle(page, 200)
    open_settings(); v = page.evaluate(VIEW)
    check(v["on"] and v["nav"] and not v["insec"], f"settings on a phone opens on the list of sections ({v})")
    page.click("#scard [data-sec-nav=swipes]"); preview.settle(page, 300); v = page.evaluate(VIEW)
    check(v["insec"] and v["swipes"] and not v["nav"] and page.evaluate(LAYERS) == 2, f"tapping Swipes opens that section on its own layer ({v}, layers {page.evaluate(LAYERS)})")
    page.go_back(); preview.settle(page, 700); v = page.evaluate(VIEW)
    check(inApp() and v["on"] and v["nav"] and not v["insec"] and page.evaluate(LAYERS) == 1, f"back from a section returns to the list, Settings still open ({v})")
    page.go_back(); preview.settle(page, 700)
    check(inApp() and not page.evaluate(VIEW)["on"] and page.evaluate(LAYERS) == 0, "the next back closes Settings, still inside the app")
    open_settings(); page.click("#scard [data-sec-nav=general]"); preview.settle(page, 300); page.click("#sclose"); preview.settle(page, 700)
    check(inApp() and not page.evaluate(VIEW)["on"] and page.evaluate(LAYERS) == 0 and page.evaluate(HDEPTH) == 0, f"the close button inside a section closes everything (layers {page.evaluate(LAYERS)}, history depth {page.evaluate(HDEPTH)})")
    open_settings(); v = page.evaluate(VIEW)
    check(v["nav"] and not v["insec"], f"and Settings reopens on the list, not inside the last section ({v})")
    page.evaluate("() => document.querySelector('#sclose').click()"); preview.settle(page, 700)
    page.evaluate("() => document.querySelector('#accountsBtn').click()"); page.wait_for_function("() => !!document.querySelector('#scard [data-sec-nav]')", timeout=8000); preview.settle(page, 300)
    v = page.evaluate("() => ({ insec: document.querySelector('#scard').classList.contains('insec'), acc: !document.querySelector('#scard [data-sec=accounts]').hidden })")
    check(v["insec"] and v["acc"], f"the drawer's Accounts link opens Settings straight on Accounts ({v})")
    page.go_back(); preview.settle(page, 700); page.go_back(); preview.settle(page, 700)
    check(inApp() and not page.evaluate(VIEW)["on"] and page.evaluate(LAYERS) == 0, "two backs from there close it")
    DEPTH = "() => (history.state && history.state.mhDepth) || 0"
    # The phone's reply sheet: closed until Reply; back closes the sheet first and the conversation next; the conversation's
    # own back button closes both without leaving a layer behind.
    REPLYING = "() => document.querySelector('#app').classList.contains('replying')"
    kk = page.evaluate("() => [...document.querySelectorAll('.t')][0].dataset.key")
    page.evaluate("(k)=>window.mh.openThread(k)", kk); preview.settle(page, 500)
    check(viewing() and not page.evaluate(REPLYING) and page.evaluate("() => getComputedStyle(document.querySelector('#replybox')).display") == "none", "a conversation opens with the reply sheet closed")
    page.click('#actions [data-act="reply"]'); preview.settle(page, 300)
    check(page.evaluate(REPLYING) and page.evaluate("() => getComputedStyle(document.querySelector('#replybox')).display") != "none" and page.evaluate(LAYERS) == 2, f"Reply opens the sheet, as a layer of its own (layers {page.evaluate(LAYERS)})")
    page.go_back(); preview.settle(page, 600)
    check(inApp() and viewing() and not page.evaluate(REPLYING) and page.evaluate(LAYERS) == 1, "back closes the sheet and leaves the conversation open")
    page.go_back(); preview.settle(page, 600)
    check(inApp() and not viewing() and page.evaluate(LAYERS) == 0, "the next back closes the conversation")
    page.evaluate("(k)=>window.mh.openThread(k)", kk); preview.settle(page, 500); page.click('#actions [data-act="reply"]'); preview.settle(page, 300)
    page.click("#back"); preview.settle(page, 700)
    check(inApp() and not viewing() and not page.evaluate(REPLYING) and page.evaluate(LAYERS) == 0 and page.evaluate("() => (history.state && history.state.mhDepth) || 0") == 0, f"the conversation's back button with the sheet open closes both, leaving nothing armed (layers {page.evaluate(LAYERS)})")
    # a conversation with no message has no one to reply to: Reply opens nothing
    page.evaluate("(k)=>window.mh.openThread(k)", kk); preview.settle(page, 400)
    page.evaluate("() => { window.mh.state.replyTo = null; openReplySheet(); }"); preview.settle(page, 200)
    check(not page.evaluate(REPLYING) and page.evaluate(LAYERS) == 1, f"Reply with no message to reply to opens no sheet (layers {page.evaluate(LAYERS)})")
    page.go_back(); preview.settle(page, 500)
    # a folder tapped in the drawer closes it. It used to remove the class and leave the drawer's entry on the stack, so the next back
    # gesture did nothing.
    page.click("#menuBtn"); preview.settle(page, 400)
    page.click('#nav a[data-view="unread"]'); preview.settle(page, 600)
    check(not page.evaluate("() => document.querySelector('#app').classList.contains('menu')") and page.evaluate(LAYERS) == 0 and page.evaluate(DEPTH) == 0,
          f"a folder tapped in the drawer leaves no layer and no history entry behind (layers {page.evaluate(LAYERS)}, depth {page.evaluate(DEPTH)})")
    page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 400)   # the Inbox tab is gone: the drawer or the title gets back
    k2 = page.evaluate("() => [...document.querySelectorAll('.t')][0].dataset.key")
    page.evaluate("(k)=>window.mh.openThread(k)", k2); preview.settle(page, 500)
    page.go_back(); preview.settle(page, 600)
    check(inApp() and not viewing(), "so the next back gesture does something: it closes the conversation")
    # a close and a back gesture close together: the stack follows history's depth, so nothing is left armed to swallow a gesture
    page.evaluate("(k)=>window.mh.openThread(k)", k2); preview.settle(page, 500)
    page.evaluate("() => window.mh.dropLayer('thread')"); page.wait_for_timeout(100)
    check(page.evaluate(LAYERS) == 0 and page.evaluate(DEPTH) == 0, "an in-app close steps history back to the base")
    page.evaluate("(k)=>window.mh.openThread(k)", k2); preview.settle(page, 500)
    page.go_back(); preview.settle(page, 600)
    check(inApp() and not viewing() and page.evaluate(LAYERS) == 0, "and the very next back gesture still closes a conversation — none is swallowed")
    # two layers closed in one task (the drawer over an open conversation, then a folder): one step back of two entries
    page.evaluate("(k)=>window.mh.openThread(k)", k2); preview.settle(page, 400)
    page.evaluate("() => document.querySelector('#menuBtn').click()"); preview.settle(page, 400)   # the tab bar is covered while reading on a phone; the drawer is the same layer
    check(page.evaluate(LAYERS) == 2 and page.evaluate(DEPTH) == 2, f"a conversation and the drawer over it are two layers, two entries")
    page.evaluate("() => document.querySelector('#nav a[data-view=\"inbox\"]').click()"); preview.settle(page, 600)
    check(inApp() and page.evaluate(LAYERS) == 0 and page.evaluate(DEPTH) == 0 and not viewing(),
          f"a folder tapped from there closes both and steps history back over both (layers {page.evaluate(LAYERS)}, depth {page.evaluate(DEPTH)})")
    # the drawer's lock button closes the drawer through its layer too
    page.evaluate("() => document.querySelector('#menuBtn').click()"); preview.settle(page, 400)
    page.evaluate("() => document.querySelector('#sidelock').click()"); preview.settle(page, 500)
    check(page.evaluate(LAYERS) == 0 and page.evaluate(DEPTH) == 0, f"locking the sidebar from the open drawer leaves no layer or entry behind (layers {page.evaluate(LAYERS)}, depth {page.evaluate(DEPTH)})")
    page.evaluate("() => document.querySelector('#sidelock').click()"); preview.settle(page, 300)   # back to unlocked, as the phone uses it
    # the Android app's back button asks the page (window.mh.back) instead of WebView.canGoBack(): Chromium marks an entry
    # skippable when the next one is pushed without a user gesture (a conversation opened from a notification) and canGoBack()
    # then said false with the conversation open, so back closed the app
    page.evaluate("(k) => window.mh.openUrl('/?account=' + encodeURIComponent(k.split('|')[0]) + '&thread=' + encodeURIComponent(k.split('|')[1]))", k2); preview.settle(page, 800)
    check(viewing() and page.evaluate(LAYERS) == 1, "a notification's route opens the conversation as one layer")
    r1 = page.evaluate("() => window.mh.back()"); preview.settle(page, 500)
    check(r1 is True and inApp() and not viewing() and page.evaluate(LAYERS) == 0 and page.evaluate(DEPTH) == 0, "the app's back button closes it through the page and steps history back")
    r2 = page.evaluate("() => window.mh.back()")
    check(r2 is False, "and with nothing open the page says so, so the app leaves")
    ctx.close(); b.close()
srv.shutdown()
print(("FAILED: "+"; ".join(fails)) if fails else "all back-gesture checks passed")
sys.exit(1 if fails else 0)
