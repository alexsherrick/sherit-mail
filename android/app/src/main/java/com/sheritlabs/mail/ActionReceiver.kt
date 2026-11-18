package com.sheritlabs.mail

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

/** A notification button (Done, Mark read, Trash, Snooze, Stop these; the user picks which): closes it at once,
 *  then tells the hub. */
class ActionReceiver : BroadcastReceiver() {
    companion object { const val GONE = "gone" }

    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == GONE) {   // swiped away: not handled, just no longer on screen
            val key = intent.getStringExtra("key") ?: return
            val pending = goAsync()
            Thread { try { Hub.reportGone(ctx.applicationContext, listOf(key)) } finally { pending.finish() } }.start()
            return
        }
        val account = intent.getStringExtra("account") ?: return
        val thread = intent.getStringExtra("thread") ?: return
        if (action == "reply") {   // typed into the notification: the notification stays until the hub answers
            val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notify.REPLY_KEY)?.toString()?.trim().orEmpty()
            val tag = intent.getStringExtra("tag") ?: "t-$account|$thread"
            val pending = goAsync()
            Thread { try {
                val r = if (text.isEmpty()) Hub.Res(400, "{\"error\":\"The reply was empty\"}") else Hub.notifyReply(ctx.applicationContext, account, thread, text)
                val ok = r.code in 200..299
                val err = if (ok) "" else runCatching { org.json.JSONObject(r.body).optString("error") }.getOrDefault("").ifEmpty { if (r.code == 0) "No connection" else "The hub answered ${r.code}" }
                Notify.replyResult(ctx.applicationContext, tag, ok, text, err)
            } finally { pending.finish() } }.start()
            return
        }
        intent.getStringExtra("tag")?.let { Notify.cancelTag(ctx, it) }
        val pending = goAsync()
        Thread { try {
            // Snooze means until tomorrow at 8 in the morning, in this phone's own time zone.
            val until = if (action == "snooze") java.time.ZonedDateTime.now().plusDays(1).withHour(8).withMinute(0).withSecond(0).withNano(0).toInstant().toString() else null
            Hub.notifyAct(ctx.applicationContext, account, thread, action, until)
            // "Stop these" leaves the mail unhandled, so nothing else tells the hub this notification is gone.
            if (action == "quiet") Hub.reportGone(ctx.applicationContext, listOf("$account|$thread"))
        } finally { pending.finish() } }.start()
    }
}
