package com.sheritlabs.mail

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** Firebase data messages from the hub (hub/src/index.js sendFcm): one field `e`, the payload sealed with this phone's key
 *  (`p`, plain, from a hub with no key for it), the same payload Web Push carries.
 *  New mail arrives HIGH priority, which wakes the phone: the notification goes up first, then the conversation is
 *  downloaded so it is already on the device when it is tapped. Dismissals arrive NORMAL and only close notifications. */
class MailMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { Hub.registerFcm(applicationContext, token) }

    /** FCM threw away everything it was holding for this phone (more than 100 stored while it was unreachable). Say so: notifications
     *  for mail that arrived meanwhile may be missing, and the hub's daily report should show it. */
    override fun onDeletedMessages() {
        Log.w("SheritPush", "FCM discarded stored messages (onDeletedMessages)")
        Hub.reportOverflow(applicationContext)
    }

    companion object {
        /** Pushes being handled right now. A store restart (MainActivity.restartForStore) waits for zero, so it never kills the
         *  process halfway through writing a stash or raising a notification. */
        val busy = java.util.concurrent.atomic.AtomicInteger(0)
    }

    /** A sealed push this phone's key does not open: the hub holds another key for it (the app's data was cleared, a registration was
     *  lost). New mail still shows, as "New mail" with no preview (`n` says only that it is a notification), and the phone registers its
     *  key again, so the next push opens. */
    private fun unreadable(m: RemoteMessage) {
        Log.w("SheritPush", "a sealed push did not open with this phone's key: registering the key again")
        if (Hub.session(this) == null) return
        if (m.data["n"] == "1" && !MainActivity.foreground) Notify.show(this, JSONObject().put("kind", "hub").put("title", "New mail").put("body", "").put("url", "/"))
        Hub.fcmToken(this)?.let { Hub.registerFcm(applicationContext, it) }
    }

    override fun onMessageReceived(m: RemoteMessage) { busy.incrementAndGet(); try { handle(m) } finally { busy.decrementAndGet() } }

    private fun handle(m: RemoteMessage) {
        // Sealed (`e`) or, from a hub that has no key for this phone, plain (`p`, sender only).
        val sealed = m.data["e"]
        val text = if (sealed != null) Hub.openPush(this, sealed) else m.data["p"]
        if (text == null) { if (sealed != null) unreadable(m); return }
        val p = runCatching { JSONObject(text) }.getOrNull() ?: return
        val kind = p.optString("kind")
        Log.i("SheritPush", "received $kind (priority ${m.priority}, sent as ${m.originalPriority})")
        // Signed out: the hub drops this phone at sign-out, so a push now is one that crossed it, or a list the hub
        // could not update. It shows nothing and downloads nothing.
        if (Hub.session(this) == null) { Log.i("SheritPush", "signed out: $kind not shown"); return }
        // Clears first, from any message: a dismissal names exactly what to close (Telegram's READ_HISTORY shape; no fetch, no
        // network), and a new-mail push carries the clears still pending here, so they leave with the same wake.
        p.optJSONArray("dismiss")?.let { arr ->
            val items = (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { o -> o.optString("k").takeIf { it.isNotEmpty() }?.let { it to o.optLong("at", 0L) } } }
            if (items.isNotEmpty()) Notify.cancelHandled(this, items)
        }
        // Firebase lowered one of our HIGH messages: it has started to judge this app. Say so, and the hub stops sending dismissals
        // HIGH for 7 days, so they can never be what makes new mail slow. (Signal and Element X log the same pair; this acts on it.)
        if (m.originalPriority == RemoteMessage.PRIORITY_HIGH && m.priority != RemoteMessage.PRIORITY_HIGH) Hub.reportDemoted(this, kind, m.priority, m.originalPriority)
        else Hub.flushDemoted(this)   // one that failed earlier goes now
        if (kind == "dismiss") return
        if (p.optString("title").isEmpty()) return
        // In front of the user already: the list updates itself; a banner on top of it is noise. Nothing was posted, so the hub
        // must not count it as on screen, unless an earlier notification for the same conversation is still up (an unread
        // conversation keeps it), which a later dismissal must still reach HIGH.
        val thread = p.optString("thread")
        val key = "${p.optString("account").ifEmpty { kind }}|$thread"
        if (MainActivity.foreground) {
            MainActivity.instance?.onPush()
            if (thread.isNotEmpty() && key !in Notify.activeKeys(this)) Hub.reportGone(this, listOf(key))
            return
        }
        if (!Notify.show(this, p) && thread.isNotEmpty()) Hub.reportGone(this, listOf(key))   // notifications switched off: nothing on screen
        val account = p.optString("account")
        if (thread.isNotEmpty() && kind in setOf("gmail", "hub", "imap")) {
            Hub.prefetch(this, kind, account, thread)?.let {
                Stash.put(this, kind, account, thread, it)
                // App alive (even in the background): prime it now, so the tap opens a conversation already drawn.
                MainActivity.instance?.primeFromStash()
            }
        }
    }
}
