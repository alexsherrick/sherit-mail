package com.sheritlabs.mail

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.MailTo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The web client in one WebView, and everything a WebView cannot do itself:
 *  - Google sign-in: Google refuses OAuth inside WebViews, so /auth/google runs in an Auth Tab (or a Custom Tab where the
 *  browser has none) and the hub hands back a one-time code, traded with a PKCE-style secret for the session cookie.
 *  - A bridge (`SheritAndroid`, WebViewCompat.addWebMessageListener, this origin only) for the page: conversations FCM
 *  downloaded, closing notifications, links out, saving attachments.
 *  - mailto:, Share-to-compose, the "New message" shortcut, edge-to-edge insets and predictive back.
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val ACTION_OPEN = "com.sheritlabs.mail.OPEN"
        @Volatile var foreground = false
        @Volatile var instance: MainActivity? = null
    }

    private lateinit var web: WebView
    private var pageReady = false
    private var pendingPath: String? = null
    private var clearHistoryOnLoad = false
    private var fcmRegistered = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pageLogLines = 0

    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray()); fileCallback = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private val authTab = AuthTabIntent.registerActivityResultLauncher(this) { r ->
        Log.i("SheritAuth", "auth tab result ${r.resultCode} uri=${r.resultUri?.scheme}://${r.resultUri?.host} code=${r.resultUri?.getQueryParameter("code") != null}")
        if (r.resultCode == AuthTabIntent.RESULT_OK) r.resultUri?.let { finishSignIn(it) }
    }

    override fun onCreate(saved: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(saved)
        instance = this
        Updater.maybeCheck(this)   // a newer app from the hub, at most every six hours
        web = WebView(this)
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        // Edge-to-edge (required at SDK 35+): the bars show the page's own colour, the content sits inside them, and the
        // keyboard pushes the page up instead of covering the composer.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        configure(web)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The page owns its back stack (app.js layers: a conversation, the composer, Settings), so it is asked first.
                // WebView.canGoBack() cannot answer for it: Chromium marks a history entry skippable when the page adds the next one
                // without a user gesture (exactly what opening a conversation from a notification does) and canGoBack() then said
                // false with the conversation open, so back closed the app (wm_finish_activity app-request).
                val leave = { if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true } }
                if (!pageReady) { leave(); return }
                // A page mid-navigation or a renderer that died may never answer: after 600 ms the back press is handled here.
                var answered = false
                val fallback = Runnable { if (!answered) { answered = true; leave() } }
                web.postDelayed(fallback, 600)
                web.evaluateJavascript("window.mh&&window.mh.back?window.mh.back():false") { r -> if (answered) return@evaluateJavascript; answered = true; web.removeCallbacks(fallback); if (r != "true") leave() }
            }
        })
        if (saved != null) web.restoreState(saved)
        else web.loadUrl(Hub.ORIGIN + (startPath(intent) ?: "/"))
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val d = intent.data
        if (d?.scheme == "sheritmail" && d.host == "auth") { finishSignIn(d); return }
        startPath(intent)?.let { openPath(it) }
    }

    override fun onResume() { super.onResume(); foreground = true }
    override fun onPause() { super.onPause(); foreground = false; CookieManager.getInstance().flush() }
    /** The WebView goes with its activity. It used to outlive it: on 2026-10-03 my phone held two activities and two
     *  WebViews in one process (dumpsys meminfo: Activities 2, WebViews 2, ViewRootImpl 1); the page from 08:07 still loaded,
     *  still holding its own connection to the same IndexedDB, behind a screen created at 10:38 whose every store request then
     *  stopped answering. destroy() closes that page, its database connection and its locks. */
    override fun onDestroy() {
        if (instance === this) instance = null
        if (::web.isInitialized) runCatching { (web.parent as? ViewGroup)?.removeView(web); web.stopLoading(); web.destroy() }
        super.onDestroy()
    }
    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); web.saveState(out) }

    /** Where an incoming intent wants the client to go: a notification's conversation, a compose, or nothing. */
    private fun startPath(i: Intent?): String? {
        i ?: return null
        val d = i.data
        return when {
            i.action == ACTION_OPEN -> notificationRoute(i.getStringExtra("url"))
            d?.scheme == "sheritmail" && d.host == "compose" -> "/?compose=1"
            d?.scheme == "mailto" -> composePath(d.toString())
            i.action == Intent.ACTION_SEND -> Uri.parse("/").buildUpon().appendQueryParameter("compose", "1")
                .apply { i.getStringExtra(Intent.EXTRA_SUBJECT)?.let { appendQueryParameter("subject", it) } }
                .apply { i.getStringExtra(Intent.EXTRA_TEXT)?.let { appendQueryParameter("body", it) } }.build().toString()
            else -> null
        }
    }

    /** The one kind of URL ACTION_OPEN may carry: a notification's own route, `/?account=…[&thread=…]`. This activity is exported
     *  (it is the launcher), so any app on the phone can send it this action with any extra, and the extra used to reach the page
     *  as is: it could pre-fill the composer, open Settings with a false "Gmail connected", or (on a page without window.mh, such
     *  as sign-in) reach location.assign with a javascript: or foreign URL. Anything else is dropped
     *  and the app simply opens. mailto: and Share keep their own, ordinary, paths below. */
    private fun notificationRoute(s: String?): String? {
        val u = runCatching { Uri.parse(s ?: return null) }.getOrNull() ?: return null
        if (u.scheme != null || u.authority != null || u.path != "/") return null
        val names = runCatching { u.queryParameterNames }.getOrNull() ?: return null
        if (names.isEmpty() || !names.all { it == "account" || it == "thread" }) return null
        val b = Uri.parse("/").buildUpon()
        u.getQueryParameter("account")?.let { b.appendQueryParameter("account", it) }
        u.getQueryParameter("thread")?.let { b.appendQueryParameter("thread", it) }
        return b.build().toString()
    }

    private fun composePath(mailto: String): String {
        val m = runCatching { MailTo.parse(mailto) }.getOrNull()
        val b = Uri.parse("/").buildUpon().appendQueryParameter("compose", "1")
        m?.to?.takeIf { it.isNotBlank() }?.let { b.appendQueryParameter("to", it) }
        m?.cc?.takeIf { it.isNotBlank() }?.let { b.appendQueryParameter("cc", it) }
        m?.subject?.takeIf { it.isNotBlank() }?.let { b.appendQueryParameter("subject", it) }
        m?.body?.takeIf { it.isNotBlank() }?.let { b.appendQueryParameter("body", it) }
        return b.build().toString()
    }

    /** Open a path inside the running client without reloading it (window.mh.openUrl), or once the page is up. */
    private fun openPath(path: String) {
        if (!path.startsWith("/") || path.startsWith("//")) return   // this app's own routes only: never a scheme, never another host
        if (!pageReady) { pendingPath = path; return }
        val q = JSONObject.quote(path)
        // A page without window.mh (sign-in, an error page) gets the route loaded from this origin: never location.assign(string).
        web.evaluateJavascript("window.mh&&window.mh.openUrl?(window.mh.openUrl($q),'ok'):'none'") { r -> if (r != "\"ok\"") web.loadUrl(Hub.ORIGIN + path) }
    }

    /** A conversation the push service just downloaded: the page takes it, adopts it into the list and prerenders it. */
    fun primeFromStash() = runOnUiThread { if (pageReady) web.evaluateJavascript("window.mh&&window.mh.importNow&&window.mh.importNow()", null) }

    /** A push for mail while the app is in front: no notification, just let the list pull it in now. */
    fun onPush() = runOnUiThread { web.evaluateJavascript("window.mh&&window.mh.refresh&&window.mh.refresh({silent:true})", null) }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(w: WebView) {
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportMultipleWindows(true)          // window.open / target=_blank arrive at onCreateWindow, and go to the browser
            javaScriptCanOpenWindowsAutomatically = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            textZoom = 100
            userAgentString = "$userAgentString SheritAndroid/${BuildConfig.VERSION_NAME}"   // app.js NATIVE_ANDROID
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        w.setBackgroundColor(getColor(R.color.page_bg))
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = route(req.url, req.isForMainFrame)
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                if (clearHistoryOnLoad) { clearHistoryOnLoad = false; view.clearHistory() }   // back must not return to the sign-in page
                pendingPath?.let { pendingPath = null; openPath(it) }
                registerFcmOnce()
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean { recreate(); return true }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null); fileCallback = cb; pickFiles.launch("*/*"); return true
            }
            override fun onCreateWindow(view: WebView, dialog: Boolean, gesture: Boolean, msg: android.os.Message): Boolean {
                // Links inside a message (<base target="_blank">): catch the new window's first URL and hand it out.
                val probe = WebView(this@MainActivity)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean { openExternal(r.url); v.destroy(); return true }
                    override fun onPageStarted(v: WebView, url: String, favicon: android.graphics.Bitmap?) { openExternal(Uri.parse(url)); v.stopLoading(); v.destroy() }
                }
                (msg.obj as WebView.WebViewTransport).webView = probe
                msg.sendToTarget()
                return true
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
            WebViewCompat.addWebMessageListener(w, "SheritAndroid", setOf(Hub.ORIGIN), bridge)
    }

    /** true = handled here, the WebView must not load it. */
    private fun route(u: Uri, mainFrame: Boolean): Boolean {
        val scheme = u.scheme?.lowercase()
        if (scheme == "mailto") { openPath(composePath(u.toString())); return true }
        // intent: is never followed. It was handed to startActivity from ANY frame, so a mail's
        // <a href="intent:#Intent;component=…;end" target="_self"> started any activity on the phone with one tap; the app's own
        // non-exported screens included, no BROWSABLE category, component and extras as the sender wrote them. The page never makes
        // one inside this app (openExternal goes through the bridge; chromeIntent is the installed web app's), so nothing is lost.
        if (scheme != "http" && scheme != "https") return scheme !in setOf("about", "blob", "data", "javascript")
        if (u.host == "mail.yourdomain.example") {
            if (u.path == "/auth/google") { signIn(); return true }                              // Google refuses WebViews
            if (u.path?.startsWith("/auth/gmail") == true) { openExternal(u); return true }    // connect Gmail in the browser
            return false
        }
        // Any frame: a web address that is not the hub's opens outside. A message frame that navigated (a link with
        // target="_self") used to load the sender's page inside the message, in the app's own chrome.
        openExternal(u); return true
    }

    /** Out of the app, into whatever owns the link: Chrome, or the YouTube app for a YouTube link. */
    private fun openExternal(u: Uri) {
        // Web and mail links only: the new-window catcher above hands this whatever a message's link said.
        if (u.scheme?.lowercase() !in setOf("http", "https", "mailto")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    // ---------- sign-in ----------

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun signIn() {
        val verifier = b64(ByteArray(32).also { SecureRandom().nextBytes(it) })
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        getSharedPreferences("hub", MODE_PRIVATE).edit().putString("verifier", verifier).apply()   // survives a Custom Tab round trip
        val uri = Uri.parse("${Hub.ORIGIN}/auth/google?app=1&challenge=$challenge")
        val browser = CustomTabsClient.getPackageName(this, null)
        val authTabOk = browser != null && CustomTabsClient.isAuthTabSupported(this, browser)
        Log.i("SheritAuth", "sign-in via ${if (authTabOk) "auth tab" else "custom tab"} (browser $browser)")
        if (authTabOk) AuthTabIntent.Builder().build().launch(authTab, uri, "sheritmail")
        else CustomTabsIntent.Builder().build().launchUrl(this, uri)   // its redirect to sheritmail://auth arrives at onNewIntent
    }

    private fun finishSignIn(u: Uri) {
        val code = u.getQueryParameter("code")
        val verifier = getSharedPreferences("hub", MODE_PRIVATE).getString("verifier", null)
        Log.i("SheritAuth", "finish sign-in: code=${code != null} verifier=${verifier != null}")
        if (code == null || verifier == null) return
        Thread {
            val ok = Hub.exchange(applicationContext, code, verifier)
            Log.i("SheritAuth", "exchange ${if (ok) "ok" else "FAILED"}; session now ${Hub.session(applicationContext) != null}")
            runOnUiThread {
                if (ok) { clearHistoryOnLoad = true; fcmRegistered = false; web.loadUrl(Hub.ORIGIN) }
                else Toast.makeText(this, "Sign-in didn't complete. Try again.", Toast.LENGTH_LONG).show()
            }
        }.start()
    }

    /** The page's IndexedDB stalled (app.js recoverStore asks only while the app is out of sight, with nothing typed or queued).
     *  WebView runs IndexedDB's backend inside this process, so a new process is the one thing that gives the page a working
     *  store back. Out of sight, that is what Android does to cached apps anyway: the next open is an ordinary cold start that
     *  restores this screen. At most once in ten minutes, so a store that fails again after a fresh start cannot loop. */
    /** Answers the page only after the last check, at the moment it would kill: a refusal then reaches the page, which asks again
     *  a minute later while it stays out of sight.
     *  */
    private fun restartForStore(why: String, answer: (Boolean) -> Unit) {
        val prefs = getSharedPreferences("hub", MODE_PRIVATE)
        if (!restartSafe() || System.currentTimeMillis() - prefs.getLong("storeRestartAt", 0) < 10 * 60_000L) { answer(false); return }
        CookieManager.getInstance().flush()
        web.postDelayed({
            // Re-checked at the moment of the kill, not only when asked: the user may be back in the
            // app, or a push may be writing a stash, in the 500 ms between.
            if (!restartSafe()) { Log.i("SheritPage", "store restart called off: the app is in use"); answer(false); return@postDelayed }
            prefs.edit().putLong("storeRestartAt", System.currentTimeMillis()).commit()
            Log.w("SheritPage", "restarting the app process: the page's IndexedDB stalled ($why)")
            android.os.Process.killProcess(android.os.Process.myPid())
        }, 500)
    }
    // Not under the notification hand-off screen either: the user is looking at the app then.
    private fun restartSafe() = !foreground && !OpenActivity.inFront && MailMessagingService.busy.get() == 0

    private fun registerFcmOnce() {
        if (fcmRegistered || Hub.session(this) == null) return
        fcmRegistered = true
        runCatching {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { t -> Log.i("SheritPush", "FCM token ready"); Thread { Hub.registerFcm(applicationContext, t); Hub.flushDemoted(applicationContext) }.start() }
                .addOnFailureListener { e -> Log.w("SheritPush", "FCM token failed: $e"); fcmRegistered = false }
        }.onFailure { Log.w("SheritPush", "Firebase unavailable: $it"); fcmRegistered = false }   // no google-services.json: the app works, without push
    }

    // ---------- the page's bridge ----------

    private val bridge = WebViewCompat.WebMessageListener { _, message, origin, isMainFrame, reply ->
        if (!isMainFrame || origin.toString().trimEnd('/') != Hub.ORIGIN) return@WebMessageListener
        val req = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@WebMessageListener
        val id = req.optInt("id")
        val args = req.optJSONObject("args") ?: JSONObject()
        fun answer(resultJson: String) = runOnUiThread { reply.postMessage("{\"id\":$id,\"result\":$resultJson}") }
        fun fail(why: String) = runOnUiThread { reply.postMessage(JSONObject().put("id", id).put("error", why).toString()) }
        when (req.optString("op")) {
            "takeStashes" -> Thread { answer(Stash.peekAllJson(applicationContext)) }.start()
            "ackStashes" -> { val files = args.optJSONArray("files") ?: JSONArray(); Thread { Stash.ack(applicationContext, files); answer("true") }.start() }
            "log" -> { if (pageLogLines++ < 200) Log.i("SheritPage", args.optString("m").take(500)); answer("true") }   // capped: diagnostics, not a channel
            "restart" -> restartForStore(args.optJSONObject("stalled")?.optString("what").orEmpty().take(40)) { ok -> answer(if (ok) "true" else "false") }
            "activeKeys" -> answer(JSONArray(Notify.activeKeys(this)).toString())
            "pushDevice" -> answer(Hub.deviceId(this)?.let { JSONObject.quote(it) } ?: "null")   // the page's handled reports name this phone
            "signedOut" -> { fcmRegistered = false; Thread { Hub.signedOut(applicationContext); answer("true") }.start() }   // app.js signOut()
            "dismiss" -> {
                val keys = args.optJSONArray("keys") ?: JSONArray()
                val list = (0 until keys.length()).map { keys.optString(it) }.filter { it.isNotEmpty() }
                // `before` (the page's sweep): only notifications older than the page's last complete sync close; the rest may be for a
                // reply it has not seen. Without it (the user acted on these), all close. Answers with the keys it closed.
                val before = args.optLong("before", 0L)
                val done = if (before > 0) Notify.cancelOlder(this, list, before) else list.also { Notify.cancel(this, it) }
                // Tell the hub at once that these are off the screen. The page's own report waits 4 s and Gmail's echo of the same
                // change can arrive first; without this, either one woke this phone HIGH to close what it had just closed.
                if (done.isNotEmpty()) Thread { Hub.reportGone(applicationContext, done) }.start()
                answer(JSONArray(done).toString())
            }
            "openExternal" -> { openExternal(Uri.parse(args.optString("url"))); answer("true") }
            // Settings → About → Update: check the hub now, and open Android's installer for a newer, checksum-verified app.
            "update" -> Thread { answer(JSONObject.quote(runCatching { Updater.check(applicationContext, direct = true) }.getOrElse { "Update failed: ${it.message}" })) }.start()
            "saveFile" -> Thread {
                val uri = saveToDownloads(args.optString("name", "attachment"), args.optString("b64"))
                if (uri != null) answer(JSONObject.quote(uri.toString())) else fail("could not save the file")
            }.start()
            "openFile" -> openSaved(args.optString("uri"))?.let { fail(it) } ?: answer("true")
            else -> fail("unknown op")
        }
    }

    // Attachments. Saved to Downloads through MediaStore, pending until fully written so nothing sees half a file,
    // with the type taken from the name's extension rather than what the sender declared: Android picks the app to open a file by
    // its type, and a ".pdf" declared as an APK must not reach the installer, which this app may open (REQUEST_INSTALL_PACKAGES).
    // "Open" is offered only for files this app saved this session, judged by the extension each was SAVED with: the person can
    // rename the file afterwards, and the new name must not change the answer.
    private val savedUris = mutableMapOf<String, String>()
    private fun safeName(n: String) = n.replace(Regex("[\\u0000-\\u001f\\u007f/\\\\:\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]"), "_").trim().trimStart('.').take(150).ifEmpty { "attachment" }
    private val invisible = Regex("[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0]")
    private fun extOf(n: String) = Regex("\\.([a-z0-9_~-]{1,24})$").find(n.replace(invisible, "").trim().trimEnd('.', ' ').lowercase())?.groupValues?.get(1).orEmpty()
    private fun saveToDownloads(name: String, b64: String): Uri? {
        val clean = safeName(name)
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extOf(clean)) ?: "application/octet-stream"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, clean)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = runCatching { contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) }.getOrNull() ?: return null
        return runCatching {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            synchronized(savedUris) { savedUris[uri.toString()] = extOf(clean) }
            uri
        }.getOrElse { runCatching { contentResolver.delete(uri, null, null) }; null }
    }
    // The same program and script types the page holds behind a warning (app.js ATT_DANGER): never handed to another app from here.
    private val dangerExt = (
        "ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpkg dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib " +
        "lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll " +
        "app application appref-ms bas hlp htc inf library-ms mht mhtml msh msh1 msh2 mshxml msh1xml msh2xml msu pl ps1xml ps2 ps2xml psc1 psc2 " +
        "py pyc pyo pyw pyz pyzw reg scf search-ms settingcontent-ms url vhdx website wsb xbap " +
        "mad maf mag mam maq mar mas mat mau mav maw mda mdb mdt mdw mdz pkg command terminal workflow scpt dylib kext macho plugin tool action caction " +
        "sh bash zsh csh ksh applescript " +
        "gadget ocx drv shs xapk apkm apks mobileconfig webloc inetloc fileloc").split(Regex("\\s+")).filter { it.isNotEmpty() }.toSet()
    // The page's other classes (app.js ATT_ARCHIVE, ATT_MACRO, ATT_ACTIVE): the page never offers Open for them, and this refuses it
    // too, so the two cannot drift apart unnoticed (test/attview.py compares the lists).
    private val cautionExt = "zip 7z rar gz bz2 tgz tbz tbz2 xz z tar ace arj lha lzh zst docm dotm xlsm xltm xlam xla xlsb pptm potm ppam ppa ppsm sldm html htm xhtml shtml svg svgz xml xsl".split(" ").toSet()
    /** Opens a saved file in an app the person picks. Null when it opened; otherwise why not. Never an APK or a program. */
    private fun openSaved(uriStr: String): String? {
        val savedExt = synchronized(savedUris) { savedUris[uriStr] } ?: return "that file was not saved by this app"
        val uri = Uri.parse(uriStr)
        val type = contentResolver.getType(uri) ?: "application/octet-stream"
        if (type == "application/vnd.android.package-archive" || savedExt in dangerExt) return "programs are not opened from here"
        if (savedExt in cautionExt) return "this kind of file is not opened from here"
        // No resolveActivity pre-check: under Android 11 package visibility it can answer null when an app exists. The chooser always
        // resolves, and says itself when no app can open the file.
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try { startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); null }
        catch (e: ActivityNotFoundException) { "no app on this phone opens this kind of file" }
        catch (e: Exception) { e.message ?: "could not open it" }
    }
}
