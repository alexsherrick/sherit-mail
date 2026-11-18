package com.sheritlabs.mail

import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.Inflater
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Push previews sealed by the hub (hub/src/index.js sealPush): base64url(iv(12) || AES-256-GCM(deflate-raw(JSON)) ||
 *  tag(16)), associated data "sherit-push-v1". FCM carries a data message through Google's servers as it is given, so the sender,
 *  subject and first lines of each new mail were readable there; sealed, Google carries ciphertext. Plain Java APIs only, so the hub's
 *  test compiles and runs this exact file on a JVM against pushes the hub's own code sealed (hub/test/pushseal.mjs). */
object PushSeal {
    private val AAD = "sherit-push-v1".toByteArray(Charsets.UTF_8)
    private const val MAX_PLAIN = 64 * 1024

    /** A new 256-bit key, base64url without padding (43 characters), as the hub's registration takes it. */
    fun newKey(): String { val b = ByteArray(32); SecureRandom().nextBytes(b); return Base64.getUrlEncoder().withoutPadding().encodeToString(b) }

    /** The payload's JSON text, or null when this key cannot open it (another key, a damaged message). */
    fun open(keyB64: String, sealed: String): String? = runCatching {
        val key = Base64.getUrlDecoder().decode(keyB64)
        val raw = Base64.getUrlDecoder().decode(sealed)
        if (key.size != 32 || raw.size < 12 + 16) return null
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw, 0, 12))
        c.updateAAD(AAD)
        val z = c.doFinal(raw, 12, raw.size - 12)
        val inf = Inflater(true)   // raw deflate, as CompressionStream("deflate-raw") writes it
        val out = ByteArrayOutputStream(); val buf = ByteArray(4096)
        try {
            inf.setInput(z.copyOf(z.size + 1))   // "nowrap" wants one extra dummy byte (java.util.zip.Inflater)
            while (!inf.finished()) {
                val n = inf.inflate(buf)
                if (n == 0 && (inf.needsInput() || inf.needsDictionary())) break
                out.write(buf, 0, n); if (out.size() > MAX_PLAIN) return null
            }
            if (!inf.finished()) return null
        } finally { inf.end() }
        String(out.toByteArray(), Charsets.UTF_8)
    }.getOrNull()
}
