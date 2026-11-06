package ai.trux.assistant

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.SpeechRecognizer
import ai.trux.assistant.assist.TruXVoiceInteractionService

/**
 * "Hey TruX" listener. Runs as a microphone foreground service (Android
 * requires the visible notification) and loops the phone's speech
 * recognizer, preferring offline recognition. On a match it opens Live
 * through the assistant session (allowed from the background), or directly
 * when "Display over other apps" is granted.
 */
class WakeWordService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var paused = false
    private var backoff = 300L
    private var lastWake = 0L
    private val audio by lazy { getSystemService(AudioManager::class.java) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE -> { paused = true; stopListening(); return START_STICKY }
            ACTION_RESUME -> { paused = false; schedule(500); return START_STICKY }
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { stopSelf(); return START_NOT_STICKY }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, TruXApp.CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(getString(R.string.wake_listening))
            .setContentText(getString(R.string.wake_listening_sub))
            .setContentIntent(open).setOngoing(true).build()
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(ID, n)
        } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
        schedule(200)
        return START_STICKY
    }

    private fun schedule(delay: Long) { handler.removeCallbacksAndMessages(null); handler.postDelayed({ listen() }, delay) }

    private fun listen() {
        if (paused || recognizer != null) return
        val r = Recognizers.create(this) ?: run { stopSelf(); return }
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(p: Bundle?) { backoff = 300 }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(v: Float) {}
            override fun onBufferReceived(b: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                release()
                backoff = if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) 150 else (backoff * 2).coerceAtMost(15_000)
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) { stopSelf(); return }
                schedule(backoff)
            }
            override fun onResults(b: Bundle?) { check(b); release(); schedule(150) }
            override fun onPartialResults(b: Bundle?) { if (check(b)) release() }
            override fun onEvent(t: Int, p: Bundle?) {}
        })
        // Silence the recognizer's start/stop beeps while looping.
        muteBeeps(true)
        try { r.startListening(Recognizers.intent(partial = true, preferOffline = true)) } catch (_: Exception) { release(); schedule(2000) }
        handler.postDelayed({ muteBeeps(false) }, 700)
    }

    private fun check(b: Bundle?): Boolean {
        val heard = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return false
        if (heard.none { WAKE.containsMatchIn(it) }) return false
        val now = System.currentTimeMillis()
        if (now - lastWake < 4000) return true
        lastWake = now
        wake()
        return true
    }

    private fun wake() {
        paused = true
        val service = TruXVoiceInteractionService.instance
        when {
            service != null -> service.showLive()
            Settings.canDrawOverlays(this) || TruXApp.main?.get()?.hasWindowFocus() == true ->
                startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_LIVE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            else -> { paused = false; return }
        }
        // Live takes the mic; MainActivity resumes us when Live ends. Safety net:
        handler.postDelayed({ if (paused && TruXApp.main?.get() == null) { paused = false; schedule(300) } }, 20_000)
    }

    private fun muteBeeps(mute: Boolean) {
        try {
            val dir = if (mute) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE
            audio.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, dir, 0)
            audio.adjustStreamVolume(AudioManager.STREAM_SYSTEM, dir, 0)
        } catch (_: Exception) {}
    }

    private fun release() { recognizer?.destroy(); recognizer = null }
    private fun stopListening() { handler.removeCallbacksAndMessages(null); release(); muteBeeps(false) }

    override fun onDestroy() { stopListening(); super.onDestroy() }

    companion object {
        private const val ID = 41
        private const val ACTION_PAUSE = "pause"
        private const val ACTION_RESUME = "resume"
        val WAKE = Regex("\\b(hey\\s+)?(tru\\s?x|true\\s?x|trucks|truex|trux|tracks|truck's)\\b", RegexOption.IGNORE_CASE)

        private fun enabled(c: Context) = c.getSharedPreferences(TruXApp.PREFS, Context.MODE_PRIVATE).getBoolean("wake", false)

        fun start(c: Context) {
            if (c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
            try { c.startForegroundService(Intent(c, WakeWordService::class.java)) } catch (_: Exception) {}
        }
        fun stop(c: Context) = c.stopService(Intent(c, WakeWordService::class.java))
        fun pause(c: Context, on: Boolean) {
            if (!enabled(c)) return
            try { c.startService(Intent(c, WakeWordService::class.java).setAction(if (on) ACTION_PAUSE else ACTION_RESUME)) } catch (_: Exception) {}
        }
    }
}
