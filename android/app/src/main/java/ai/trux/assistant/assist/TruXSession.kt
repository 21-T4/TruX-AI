package ai.trux.assistant.assist

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import ai.trux.assistant.CircleActivity
import ai.trux.assistant.MainActivity
import java.io.File
import java.io.FileOutputStream

/**
 * One assistant invocation. With a screenshot → Circle to search.
 * Without one (screenshot access turned off, or a voice trigger) → Live.
 */
class TruXSession(context: Context) : VoiceInteractionSession(context) {
    private val handler = Handler(Looper.getMainLooper())
    private var handled = false
    private var wantsShot = false

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        handled = false
        if (args?.getString(MODE) == MODE_LIVE) { openLive(); return }
        wantsShot = true
        // If no screenshot arrives (user disabled "Use screenshot"), still open the circle UI.
        handler.postDelayed({ if (!handled) openCircle(null) }, 1500)
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        if (!wantsShot || handled) return
        openCircle(screenshot)
    }

    private fun openCircle(shot: Bitmap?) {
        handled = true
        val file = File(context.cacheDir, CircleActivity.SHOT_FILE)
        if (shot != null) {
            try { FileOutputStream(file).use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) } } catch (_: Exception) { file.delete() }
        } else file.delete()
        try {
            startAssistantActivity(Intent(context, CircleActivity::class.java).putExtra(CircleActivity.EXTRA_HAS_SHOT, shot != null))
        } catch (_: Exception) {
            context.startActivity(Intent(context, CircleActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        handler.postDelayed({ hide() }, 300)
    }

    private fun openLive() {
        handled = true
        val intent = Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_LIVE)
        try { startAssistantActivity(intent) } catch (_: Exception) {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        handler.postDelayed({ hide() }, 300)
    }

    override fun onHide() { handler.removeCallbacksAndMessages(null); super.onHide() }

    companion object {
        const val MODE = "mode"
        const val MODE_LIVE = "live"
    }
}
