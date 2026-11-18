package com.sheritlabs.mail

import android.content.Context
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** In-app updates from the hub. android/publish.sh puts the signed APK and latest.json under the hub's
 *  /dl/android/. At most every six hours the app asks. A higher versionCode is downloaded, its sha256 checked against latest.json, and
 *  a notification offers it; Android's own installer asks to confirm. The APK is signed with the same key, so it updates in place.
 *  Until now every app change needed the phone on ADB. */
object Updater {
    private const val LATEST = "${Hub.ORIGIN}/dl/android/latest.json"
    private const val EVERY_MS = 6 * 3600_000L

    fun maybeCheck(ctx: Context) {
        val p = ctx.getSharedPreferences("updater", Context.MODE_PRIVATE); val now = System.currentTimeMillis()
        if (now - p.getLong("checked", 0L) < EVERY_MS) return
        p.edit().putLong("checked", now).apply()
        Thread { runCatching { check(ctx.applicationContext) } }.start()
    }

    /** One check; returns what happened, for the log. `direct`: Settings → About → Update asked (the page's bridge op "update"
     * ): Android's installer opens now, instead of a notification offering it. */
    fun check(ctx: Context, direct: Boolean = false): String {
        val r = Hub.call(null, "GET", LATEST)
        if (r.code != 200) return "no update information (${r.code})"
        val j = JSONObject(r.body)
        val code = j.optInt("versionCode"); val name = j.optString("versionName"); val url = j.optString("url"); val sha = j.optString("sha256").lowercase()
        if (code <= BuildConfig.VERSION_CODE) return "up to date ($name)"
        if (!url.startsWith("${Hub.ORIGIN}/dl/android/") || sha.length != 64) return "update information refused"
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val f = File(dir, "SheritMail-$name.apk")
        download(url, f)
        if (sha256(f) != sha) { f.delete(); return "download did not match its checksum" }
        val apk = FileProvider.getUriForFile(ctx, "${ctx.packageName}.updates", f)
        if (direct) {
            ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(apk, "application/vnd.android.package-archive")
                .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            return "installing $name"
        }
        Notify.offerUpdate(ctx, name, apk)
        return "offered $name"
    }

    private fun download(url: String, to: File) {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 15000; c.readTimeout = 60000
            if (c.responseCode != 200) throw IllegalStateException("download answered ${c.responseCode}")
            c.inputStream.use { i -> to.outputStream().use { o -> i.copyTo(o) } }
        } finally { c.disconnect() }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { i -> val buf = ByteArray(65536); while (true) { val n = i.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
