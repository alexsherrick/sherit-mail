package com.sheritlabs.mail

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** The hub, from native code: the same session the web view carries (cookie `mh`), plain HTTPS, JSON in and out. */
object Hub {
    const val ORIGIN = "https://mail.yourdomain.example"
    private const val HOST = "mail.yourdomain.example"
    val UA = "SheritAndroid/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MANUFACTURER} ${Build.MODEL})"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("hub", Context.MODE_PRIVATE)

    /** The web view's cookie is the truth (the page can sign out or in again); a private copy covers a cold process
     *  where the WebView provider is not up yet. */
    fun session(ctx: Context): String? {
        val live = try {
            CookieManager.getInstance().getCookie(ORIGIN)?.split(";")?.map { it.trim() }?.firstOrNull { it.startsWith("mh=") }?.removePrefix("mh=")
        } catch (_: Throwable) { null }
        if (!live.isNullOrEmpty()) { prefs(ctx).edit().putString("mh", live).apply(); return live }
        return prefs(ctx).getString("mh", null)
    }

    fun saveSession(ctx: Context, value: String, maxAge: Long) {
        prefs(ctx).edit().putString("mh", value).apply()
        val cm = CookieManager.getInstance()
        cm.setCookie(ORIGIN, "mh=$value; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=$maxAge")
        cm.flush()
    }

    /** The page signed out. The hub has already dropped this phone from its notification list; here the app forgets
     *  its own copy of the session, which sign-out used to leave behind and which kept the notification buttons, the conversation
     *  downloads and the next start's registration working while signed out. Then what that copy fetched: the stash and the
     *  notifications on screen. A sign-in registers again (MainActivity.finishSignIn). */
    fun signedOut(ctx: Context) {
        prefs(ctx).edit().remove("mh").remove("fcm_registered").commit()
        runCatching { val cm = CookieManager.getInstance(); cm.setCookie(ORIGIN, "mh=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"); cm.flush() }
        Stash.clear(ctx)
        Notify.cancelMail(ctx)
        android.util.Log.i("SheritAuth", "signed out: session copy, stash and notifications cleared")
    }

    data class Res(val code: Int, val body: String)

    fun call(ctx: Context?, method: String, url: String, json: JSONObject? = null, bearer: String? = null, timeoutMs: Int = 15000): Res {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 10000; c.readTimeout = timeoutMs
            c.setRequestProperty("User-Agent", UA)
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer $bearer")
            else if (ctx != null && URL(url).host == HOST) session(ctx)?.let { c.setRequestProperty("Cookie", "mh=$it") }
            // The hub refuses a cookie-authenticated POST whose Origin is not its own (its CSRF guard). This app IS the
            // client, not a third-party page riding the cookie, so it says so: exactly what the web client's fetch sends.
            if (URL(url).host == HOST) c.setRequestProperty("Origin", ORIGIN)
            if (json != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toString().toByteArray()) }
            }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return Res(code, text)
        } finally { c.disconnect() }
    }

    /** End of sign-in: the one-time code plus the secret only this app holds -> a session. */
    fun exchange(ctx: Context, code: String, verifier: String): Boolean {
        val r = runCatching { call(null, "POST", "$ORIGIN/auth/app/exchange", JSONObject().put("code", code).put("verifier", verifier)) }
            .onFailure { android.util.Log.w("SheritAuth", "exchange request failed: $it") }.getOrNull() ?: return false
        android.util.Log.i("SheritAuth", "exchange http ${r.code}")   // never the body: it carries the session
        if (r.code != 200) return false
        val j = runCatching { JSONObject(r.body) }.getOrNull() ?: return false
        val s = j.optString("session"); if (s.isEmpty()) return false
        saveSession(ctx, s, j.optLong("max_age", 30L * 86400))
        return true
    }

    fun registerFcm(ctx: Context, token: String) {
        prefs(ctx).edit().putString("fcm_token", token).apply()   // deviceId() is derived from it, signed in or not
        if (session(ctx) == null) { android.util.Log.i("SheritPush", "not signed in yet; FCM registration deferred"); return }
        // The token the hub last accepted from this phone: after a rotation the hub moves that row (what is on screen, what is owed,
        // any demotion) to the new token instead of keeping two rows for one phone.
        val previous = prefs(ctx).getString("fcm_registered", null)?.takeIf { it != token }
        // With the push key: the hub seals every push to this phone with it, so Google carries no preview text.
        val body = JSONObject().put("token", token).put("ua", UA).put("key", pushKey(ctx)).also { if (previous != null) it.put("previous", previous) }
        val r = runCatching { call(ctx, "POST", "$ORIGIN/api/push/fcm", body) }
        if (r.getOrNull()?.code in 200..299) prefs(ctx).edit().putString("fcm_registered", token).apply()
        android.util.Log.i("SheritPush", "registered with the hub${if (previous != null) " (replacing a rotated token)" else ""}: ${r.getOrNull()?.code ?: r.exceptionOrNull()}")
    }

    /** This phone's push key, made once and kept in the app's private storage; registered with every token. */
    fun pushKey(ctx: Context): String {
        prefs(ctx).getString("push_key", null)?.let { return it }
        val k = PushSeal.newKey(); prefs(ctx).edit().putString("push_key", k).commit(); return k
    }
    /** A sealed push's JSON, or null when this phone's key cannot open it. */
    fun openPush(ctx: Context, sealed: String): String? = prefs(ctx).getString("push_key", null)?.let { PushSeal.open(it, sealed) }
    fun fcmToken(ctx: Context): String? = prefs(ctx).getString("fcm_token", null)

    /** This phone's name on the hub: "fcm:" + the first 16 hex of SHA-256(FCM token), the same the hub computes (fcmDeviceId).
     *  Handled reports carry it, so the hub never wakes this phone to close a notification it closed itself. */
    fun deviceId(ctx: Context): String? {
        val fcm = prefs(ctx).getString("fcm_token", null) ?: return null
        val d = java.security.MessageDigest.getInstance("SHA-256").digest(fcm.toByteArray(Charsets.UTF_8))
        return "fcm:" + d.joinToString("") { "%02x".format(it) }.take(16)
    }

    /** Done / Mark read from a notification: the hub applies it and tells the other devices (not this one). */
    fun notifyAct(ctx: Context, account: String, thread: String, action: String, until: String? = null) {
        val body = JSONObject().put("account", account).put("thread", thread).put("action", action).put("device", deviceId(ctx) ?: "")
        if (until != null) body.put("until", until)
        runCatching { call(ctx, "POST", "$ORIGIN/api/notify/act", body) }
    }

    /** A reply typed into a notification: the hub sends it as Reply in the app would. The idempotency key
     *  keeps a retried request from sending it twice. Code 0 means no answer at all. */
    fun notifyReply(ctx: Context, account: String, thread: String, text: String): Res = runCatching {
        call(ctx, "POST", "$ORIGIN/api/notify/reply", JSONObject().put("account", account).put("thread", thread).put("text", text)
            .put("device", deviceId(ctx) ?: "").put("idempotency_key", java.util.UUID.randomUUID().toString().replace("-", "")), timeoutMs = 30000)
    }.getOrElse { Res(0, "") }

    /** Notifications this phone is no longer showing although nobody handled the mail: swiped away, or never posted because the
     *  app was in front. The hub stops counting them as on screen, so no HIGH dismissal is spent on them later. */
    fun reportGone(ctx: Context, keys: List<String>) {
        val id = deviceId(ctx) ?: return
        if (keys.isEmpty()) return
        runCatching { call(ctx, "POST", "$ORIGIN/api/push/fcm/gone", JSONObject().put("device", id).put("keys", org.json.JSONArray(keys))) }
    }

    fun reportOverflow(ctx: Context) {
        val id = deviceId(ctx) ?: return
        runCatching { call(ctx, "POST", "$ORIGIN/api/push/fcm/overflow", JSONObject().put("device", id)) }
    }

    /** Firebase delivered one of our HIGH messages at a lower priority: the hub sends dismissals NORMAL for 7 days. The report is
     *  kept until the hub has it (a lost request must not leave the hub sending HIGH to an app it is demoting
     * ) and repeated at most hourly while the demotion lasts (the hub counts 7 days from the last). */
    fun reportDemoted(ctx: Context, kind: String, priority: Int, original: Int) {
        android.util.Log.w("SheritPush", "Firebase demoted a $kind push ($original -> $priority)")
        val p = prefs(ctx)
        if (p.getString("demoted_pending", null) == null && System.currentTimeMillis() - p.getLong("demoted_told", 0L) < 3_600_000L) return
        p.edit().putString("demoted_pending", JSONObject().put("kind", kind).put("priority", priority).put("original", original).toString()).commit()
        flushDemoted(ctx)
    }

    /** Sends a demotion report still waiting; called on every push and when the app starts. */
    fun flushDemoted(ctx: Context) {
        val p = prefs(ctx)
        val pending = p.getString("demoted_pending", null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
        val id = deviceId(ctx) ?: return
        val r = runCatching { call(ctx, "POST", "$ORIGIN/api/push/fcm/demoted", pending.put("device", id)) }
        val code = r.getOrNull()?.code
        // 2xx: told. 400/404: this hub will never take it (malformed, or a device it does not know); retrying cannot help.
        if (code != null && (code in 200..299 || code == 400 || code == 404)) p.edit().remove("demoted_pending").putLong("demoted_told", System.currentTimeMillis()).apply()
        android.util.Log.i("SheritPush", "demotion report: ${code ?: r.exceptionOrNull()}")
    }

    /** The whole conversation, fetched while the phone is still in a pocket: exactly what sw.js prefetchThread() fetches.
     *  keep_unread=1: a background fetch must not mark the mail read. */
    fun prefetch(ctx: Context, kind: String, account: String, thread: String): String? = runCatching {
        if (kind == "gmail") {
            val t = call(ctx, "POST", "$ORIGIN/api/gmail/accounts/${URLEncoder.encode(account, "UTF-8")}/token")
            if (t.code != 200) return null
            val at = JSONObject(t.body).optString("access_token"); if (at.isEmpty()) return null
            val g = call(null, "GET", "https://gmail.googleapis.com/gmail/v1/users/me/threads/${URLEncoder.encode(thread, "UTF-8")}?format=full", bearer = at, timeoutMs = 20000)
            if (g.code == 200) g.body else null
        } else {
            val h = call(ctx, "GET", "$ORIGIN/api/threads/${URLEncoder.encode(thread, "UTF-8")}?keep_unread=1", timeoutMs = 20000)
            if (h.code == 200) h.body else null
        }
    }.getOrNull()
}
