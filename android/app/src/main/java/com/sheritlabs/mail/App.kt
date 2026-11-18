package com.sheritlabs.mail

import android.app.Application
import android.util.Log
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import java.util.concurrent.Executors

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notify.ensureChannel(this)
        startWebViewEarly()
    }

    // WebView's first initialisation is heavy and, left to `WebView(this)` in MainActivity, runs entirely on the main thread while the
    // launch waits. androidx.webkit's startUpWebView (stable since 1.16; this app ships 1.17.1) moves what it can to a background
    // thread, started here, before the activity exists. The result says how much still landed on the UI thread.
    private fun startWebViewEarly() {
        try {
            val cfg = WebViewStartUpConfig.Builder(Executors.newSingleThreadExecutor()).build()
            WebViewCompat.startUpWebView(this, cfg, object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
                override fun onResult(r: WebViewStartUpResult) {
                    Log.i("SheritStart", "webview started: ui thread ${r.totalTimeInUiThreadMillis} ms, longest task ${r.maxTimePerTaskInUiThreadMillis} ms")
                }
                override fun onError(e: WebViewStartupException) { Log.w("SheritStart", "webview start-up failed", e) }
            })
        } catch (t: Throwable) {
            Log.w("SheritStart", "startUpWebView unavailable", t)   // an old WebView: MainActivity starts it the ordinary way
        }
    }
}
