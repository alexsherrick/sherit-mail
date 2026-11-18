package com.sheritlabs.mail

import android.app.ActivityOptions
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge

/**
 * Every notification opens through here. Tapped on the lock screen, a notification brought MainActivity itself
 * forward, and Android put its startup screenshot of the app (SnapshotStartingWindow) on MainActivity. Sometimes it never took it
 * down: my phone, 2026-10-20, kept a picture from before 13:34 over a working app for 59 minutes, taps going through to
 * the app blind. Why Android forgets it is not known; what is known is that the window belongs to the activity being opened, and goes
 * when that activity's token goes (WindowToken.removeIfPossible). So the notification opens this screen instead: any startup window
 * is put on it, and it hands the route to MainActivity and finishes, taking any leftover window with it.
 *
 * When it hands off matters:
 *  - Unlocking gives the visible activity of each task a startup window (KeyguardController.keyguardGoingAway ->
 *  addStartingWindowsForVisibleActivities); until then that activity must be this one. So never while the phone is locked.
 *  - A startup window Android still tracks moves to MainActivity when MainActivity comes back from under a finished screen above it
 *  (ActivityRecord.transferStartingWindowFromHiddenAboveTokenIfNeeded, "Trampoline activity T start main activity M"). A window
 *  whose tracking Android already cleared, as the stuck one had, cannot move. So only once this screen has drawn a frame with focus
 *  and the phone unlocked: its own first draw has asked for its startup window to go, and a removal deferred to a transition's sync
 *  has run by the time focus arrives.
 */
class OpenActivity : ComponentActivity() {
    companion object {
        /** On screen now. MainActivity.restartSafe() must not kill the process under it. */
        @Volatile var inFront = false
    }

    private var handed = false
    private var focused = false
    private var awaitingFrame = false
    private var lockedChecks = 0
    private val createdAt = SystemClock.uptimeMillis()
    private val retry = Runnable { tryHandOff() }

    override fun onCreate(saved: Bundle?) {
        enableEdgeToEdge()   // the bars over page_bg, as MainActivity draws them, for the frame or two this is on screen
        super.onCreate(saved)
    }

    /** A second notification tapped while this is still up (the taps are SINGLE_TOP): the newer route is the one handed off. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onResume() { super.onResume(); inFront = true; tryHandOff() }
    override fun onPause() { super.onPause(); inFront = false; window.decorView.removeCallbacks(retry) }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        focused = hasFocus
        tryHandOff()
    }

    private fun locked() = getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true

    private fun tryHandOff() {
        if (handed || isFinishing || !focused || awaitingFrame) return
        val d = window.decorView
        d.removeCallbacks(retry)
        // Focus is not normally given behind the lock screen; if it is, wait for the unlock, however long, while this has focus.
        if (locked()) { lockedChecks++; d.postDelayed(retry, 100); return }
        // One frame of this screen committed with focus and the phone unlocked, then the hand-off. A window that never draws (it
        // should not happen with focus) is handed off after 300 ms rather than left waiting.
        awaitingFrame = true
        val go = Runnable { if (awaitingFrame) { awaitingFrame = false; if (focused && !locked()) handOff() else tryHandOff() } }
        d.viewTreeObserver.registerFrameCommitCallback { d.post(go) }
        d.postDelayed(go, 300)
        d.invalidate()
    }

    private fun handOff() {
        if (handed || isFinishing) return
        handed = true
        Log.i("SheritOpen", "hand-off after ${SystemClock.uptimeMillis() - createdAt} ms (found the phone locked $lockedChecks time(s))")
        // MainActivity is singleTask: the one already in this task gets the route as a new intent (MainActivity.startPath checks it)
        // and this screen above it is cleared; with none, it starts here. Either way no screen change is animated.
        val next = Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN)
        intent.getStringExtra("url")?.let { next.putExtra("url", it) }
        startActivity(next, ActivityOptions.makeCustomAnimation(this, 0, 0).toBundle())
        finish()
        if (Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        else @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
}
