package com.sheritlabs.mail

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

/** One notification per conversation, tagged exactly like the web client's (`t-<account>|<thread>`), so a follow-up
 *  replaces rather than stacks and a dismissal from any device removes exactly that one. Grouped per account. */
object Notify {
    const val CHANNEL = "mail"
    private const val HUB_AT = "sherit.hubAt"
    private const val ID = 1
    /** What each notification button says. "quiet" is Stop these: no more notifications for mail like this one. */
    private val BUTTONS = linkedMapOf("done" to "Done", "read" to "Mark read", "trash" to "Trash", "quiet" to "Stop these", "snooze" to "Snooze", "reply" to "Reply")
    /** The RemoteInput key of the Reply button's text. */
    const val REPLY_KEY = "sherit.reply"

    private fun nm(ctx: Context) = ctx.getSystemService(NotificationManager::class.java)

    fun ensureChannel(ctx: Context) {
        val ch = NotificationChannel(CHANNEL, ctx.getString(R.string.channel_mail), NotificationManager.IMPORTANCE_HIGH)
        ch.description = ctx.getString(R.string.channel_mail_desc)
        nm(ctx).createNotificationChannel(ch)
    }

    /** Returns whether the user can see it: with notifications or this channel switched off, the post goes nowhere, and the hub
     *  must not count it as on screen. */
    fun show(ctx: Context, p: JSONObject): Boolean {
        val kind = p.optString("kind")
        val account = p.optString("account").ifEmpty { kind }
        val thread = p.optString("thread")
        val key = if (thread.isNotEmpty()) "$account|$thread" else "$kind-$account"
        val tag = "t-$key"
        val title = p.optString("title").ifEmpty { "New mail" }
        val lines = p.optString("body").split("\n")
        val subject = lines.firstOrNull().orEmpty()
        val rest = lines.drop(1).joinToString(" ").trim()
        val url = p.optString("url").ifEmpty { "/" }

        // Through OpenActivity, never MainActivity itself: a startup window Android puts up for the tap and forgets goes with it.
        val open = PendingIntent.getActivity(ctx, tag.hashCode(),
            Intent(ctx, OpenActivity::class.java).setAction(MainActivity.ACTION_OPEN).putExtra("url", url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setColor(ctx.getColor(R.color.accent))
            .setContentTitle(title)
            .setContentText(subject)
            .setStyle(NotificationCompat.BigTextStyle().bigText(if (rest.isEmpty()) subject else "$subject\n$rest"))
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
            // Swiped away without being handled: the hub stops counting it as on screen.
            .setDeleteIntent(PendingIntent.getBroadcast(ctx, "$tag/gone".hashCode(),
                Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.GONE).putExtra("key", key),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setGroup("mail-$account")
            .setShowWhen(true)
            // When the HUB sent this (its own clock): a dismissal's handled time is the hub's too, so the newer-than check below
            // compares one clock with itself, as Telegram compares message dates with its read watermark.
            .addExtras(android.os.Bundle().apply { putLong(HUB_AT, runCatching { java.time.Instant.parse(p.optString("at")).toEpochMilli() }.getOrDefault(0L)) })
        if (thread.isNotEmpty() && kind in setOf("gmail", "hub", "imap")) {
            // The user's buttons, in my order, from Settings → Notifications: the push names them ("acts"), so a
            // change applies to the next notification. Android shows at most three. A push from an older hub names none: the old set.
            val acts = p.optJSONArray("acts")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: listOf("done", "read", "quiet")
            for (a in acts.filter { it in BUTTONS }.distinct().take(3)) {
                if (a == "reply") b.addAction(replyAction(ctx, account, thread, tag)) else b.addAction(0, BUTTONS.getValue(a), action(ctx, a, account, thread, tag))
            }
        }
        nm(ctx).notify(tag, ID, b.build())
        summarize(ctx, account)
        return nm(ctx).areNotificationsEnabled() && (nm(ctx).getNotificationChannel(CHANNEL)?.importance ?: NotificationManager.IMPORTANCE_DEFAULT) != NotificationManager.IMPORTANCE_NONE
    }

    private fun action(ctx: Context, act: String, account: String, thread: String, tag: String) =
        PendingIntent.getBroadcast(ctx, "$tag/$act".hashCode(),
            Intent(ctx, ActionReceiver::class.java).setAction(act).putExtra("account", account).putExtra("thread", thread).putExtra("tag", tag),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** Reply typed into the notification. A RemoteInput needs a MUTABLE PendingIntent (Android fills the
     *  text in); the Intent is explicit, so nothing else can receive it. */
    private fun replyAction(ctx: Context, account: String, thread: String, tag: String): NotificationCompat.Action {
        val pi = PendingIntent.getBroadcast(ctx, "$tag/reply".hashCode(),
            Intent(ctx, ActionReceiver::class.java).setAction("reply").putExtra("account", account).putExtra("thread", thread).putExtra("tag", tag),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(0, "Reply", pi)
            .addRemoteInput(RemoteInput.Builder(REPLY_KEY).setLabel("Reply").build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).setAllowGeneratedReplies(false).build()
    }

    /** After a reply typed into a notification: gone when it was sent. If not, the notification says why and shows the text, so it
     *  is not lost (Android needs the notification updated either way, or its spinner stays). */
    fun replyResult(ctx: Context, tag: String, ok: Boolean, text: String, error: String) {
        if (ok) { nm(ctx).cancel(tag, ID); return }
        val why = error.ifEmpty { "Open Sherit to send it" }
        val open = PendingIntent.getActivity(ctx, "$tag/replyfail".hashCode(), Intent(ctx, OpenActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        nm(ctx).notify(tag, ID, NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_stat_mail).setColor(ctx.getColor(R.color.accent))
            .setContentTitle("Reply not sent").setContentText(why).setStyle(NotificationCompat.BigTextStyle().bigText("$why\n\nYour reply: $text"))
            .setContentIntent(open).setAutoCancel(true).build())
    }

    /** A newer app is downloaded and checked (Updater): tapping this opens Android's installer for it. */
    fun offerUpdate(ctx: Context, version: String, apk: Uri) {
        val install = Intent(Intent.ACTION_VIEW).setDataAndType(apk, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        nm(ctx).notify("update", ID, NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_stat_mail).setColor(ctx.getColor(R.color.accent))
            .setContentTitle("Sherit Mail $version is ready").setContentText("Tap to install the update")
            .setContentIntent(PendingIntent.getActivity(ctx, "update".hashCode(), install, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true).build())
    }

    /** A quiet summary once an account has two or more, so the shade folds them into one group per account. */
    private fun summarize(ctx: Context, account: String) {
        val group = "mail-$account"
        val n = nm(ctx).activeNotifications.count { it.notification.group == group && it.tag?.startsWith("t-") == true }
        if (n < 2) { nm(ctx).cancel("g-$account", ID); return }
        // A collapsed group is tapped as its SUMMARY. Without a content intent that tap did nothing at all: measured on my
        // phone 2026-10-03: no notification_clicked, no app. It opens the account's inbox, where every one of them is.
        val open = PendingIntent.getActivity(ctx, "g-$account".hashCode(),
            Intent(ctx, OpenActivity::class.java).setAction(MainActivity.ACTION_OPEN).putExtra("url", "/?account=${android.net.Uri.encode(account)}")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val s = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_mail).setColor(ctx.getColor(R.color.accent))
            .setContentIntent(open)
            .setContentTitle("$n new").setSubText(account).setGroup(group).setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).setAutoCancel(true).build()
        nm(ctx).notify("g-$account", ID, s)
    }

    fun cancel(ctx: Context, keys: List<String>) {
        android.util.Log.i("SheritPush", "closing ${keys.size} notification(s): $keys; showing ${activeKeys(ctx)}")
        val accounts = mutableSetOf<String>()
        for (k in keys) { nm(ctx).cancel("t-$k", ID); accounts.add(k.substringBefore("|")) }
        accounts.forEach { summarize(ctx, it) }
    }

    fun cancelTag(ctx: Context, tag: String) = cancel(ctx, listOf(tag.removePrefix("t-")))

    /** The page's sweep: close only notifications posted before `before` (this phone's clock, the page's last complete sync); one
     *  raised after it may be for mail the page has not seen. Returns the keys it closed, the only ones the page may report handled. */
    fun cancelOlder(ctx: Context, keys: List<String>, before: Long): List<String> {
        val posted = nm(ctx).activeNotifications.filter { it.tag?.startsWith("t-") == true }.associate { it.tag!!.removePrefix("t-") to it.postTime }
        val (close, kept) = keys.filter { it in posted }.partition { k -> posted.getValue(k) < before }
        if (kept.isNotEmpty()) android.util.Log.i("SheritPush", "sweep kept ${kept.size} notification(s) newer than the page's last sync: $kept")
        if (close.isNotEmpty()) cancel(ctx, close)
        return close
    }

    /** A dismissal from the hub: each key with the time it was handled (ms; 0 = unknown). A notification posted AFTER that time is
     *  for newer mail in the same conversation: a dismissal that waited in Doze must not close it, so it stays. */
    fun cancelHandled(ctx: Context, items: List<Pair<String, Long>>) {
        // The hub's send time where the notification carries it (hub clock vs hub clock); the phone's post time otherwise.
        val posted = nm(ctx).activeNotifications.filter { it.tag?.startsWith("t-") == true }
            .associate { it.tag!!.removePrefix("t-") to (it.notification.extras.getLong(HUB_AT, 0L).takeIf { v -> v > 0 } ?: it.postTime) }
        val (kept, close) = items.partition { (k, at) -> at > 0 && (posted[k] ?: 0L) > at }
        if (kept.isNotEmpty()) android.util.Log.i("SheritPush", "kept ${kept.size} notification(s) newer than their dismissal: ${kept.map { it.first }}")
        if (close.isNotEmpty()) cancel(ctx, close.map { it.first })
    }

    /** Signed out: every conversation's notification and every account's summary goes. An offered update stays. */
    fun cancelMail(ctx: Context) {
        for (n in nm(ctx).activeNotifications) { val t = n.tag ?: continue; if (t.startsWith("t-") || t.startsWith("g-")) nm(ctx).cancel(t, n.id) }
    }

    fun activeKeys(ctx: Context): List<String> =
        nm(ctx).activeNotifications.mapNotNull { it.tag }.filter { it.startsWith("t-") }.map { it.removePrefix("t-") }

    @Suppress("unused") private fun Notification.isSummary() = (flags and Notification.FLAG_GROUP_SUMMARY) != 0
}
