package com.sheritlabs.mail

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Conversations downloaded at push time, waiting for the page to take them (app.js importNativeStashes). One file each,
 *  newest 20 kept, nothing older than a day handed over: the same bounds sw.js puts on its own stash. A file stays until the
 *  page says it is safely in IndexedDB (ack): handing them over used to delete them first, so a page whose store could not take
 *  the write lost the conversation from both places. */
object Stash {
    private const val MAX = 20
    private const val TTL = 24L * 3600 * 1000
    private val NAME = Regex("^[0-9a-f]{32}\\.json$")
    private fun dir(ctx: Context) = File(ctx.filesDir, "stash").apply { mkdirs() }
    private fun name(account: String, id: String) =
        MessageDigest.getInstance("SHA-256").digest("$account|$id".toByteArray()).joinToString("") { "%02x".format(it) }.take(32) + ".json"

    @Synchronized fun put(ctx: Context, kind: String, account: String, id: String, rawJson: String) {
        val at = System.currentTimeMillis()
        // rawJson is already JSON: embed it rather than parse and re-serialise a whole conversation
        val body = "{\"kind\":${JSONObject.quote(kind)},\"account\":${JSONObject.quote(account)},\"id\":${JSONObject.quote(id)},\"at\":$at,\"raw\":$rawJson}"
        File(dir(ctx), name(account, id)).writeText(body)
        val files = dir(ctx).listFiles()?.sortedByDescending { it.lastModified() } ?: return
        files.drop(MAX).forEach { it.delete() }
    }

    /** Everything waiting, as one JSON array; each entry also names its file and that file's mtime, for ack(). Expired files go. */
    @Synchronized fun peekAllJson(ctx: Context): String {
        val now = System.currentTimeMillis()
        val parts = mutableListOf<String>()
        for (f in dir(ctx).listFiles() ?: emptyArray()) {
            if (now - f.lastModified() > TTL) { f.delete(); continue }
            runCatching {
                val text = f.readText().trimEnd()
                if (text.endsWith("}")) parts.add(text.dropLast(1) + ",\"file\":${JSONObject.quote(f.name)},\"mtime\":${f.lastModified()}}")
            }
        }
        return parts.joinToString(",", "[", "]")
    }

    /** Signed out: nothing downloaded stays on the phone. */
    @Synchronized fun clear(ctx: Context) { dir(ctx).listFiles()?.forEach { it.delete() } }

    /** The page has these in IndexedDB. A file rewritten since it was handed over (a newer push for the same conversation) stays. */
    @Synchronized fun ack(ctx: Context, files: JSONArray) {
        for (i in 0 until files.length()) {
            val o = files.optJSONObject(i) ?: continue
            val n = o.optString("file"); if (!NAME.matches(n)) continue   // only names this object writes: never a path, never another file
            val f = File(dir(ctx), n)
            if (f.exists() && f.lastModified() == o.optLong("mtime", -1)) f.delete()
        }
    }
}
