package ai.trux.assistant

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder

/**
 * Keeps TruX Live running while the user is in another app (microphone
 * foreground service) and, when asked, shares the whole phone screen with
 * Gemini Live using MediaProjection (one ~768px JPEG per second).
 */
class LiveService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var worker: Handler? = null
    private var lastFrame = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val screen = intent?.action == ACTION_SCREEN
        if (intent?.action == ACTION_STOP_SCREEN) { stopProjection(); goForeground(false); return START_NOT_STICKY }
        if (!goForeground(screen)) { stopSelf(); return START_NOT_STICKY }
        if (screen) {
            val code = intent!!.getIntExtra(EXTRA_CODE, Activity.RESULT_CANCELED)
            val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)
            if (data != null) startProjection(code, data)
        }
        return START_NOT_STICKY
    }

    private fun goForeground(screen: Boolean): Boolean {
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, TruXApp.CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(getString(R.string.live_running))
            .setContentText(if (screen) "Sharing your screen with TruX" else getString(R.string.live_running_sub))
            .setContentIntent(open).setOngoing(true).build()
        return try {
            if (Build.VERSION.SDK_INT >= 30) {
                var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (screen) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                startForeground(ID, n, type)
            } else startForeground(ID, n)
            true
        } catch (_: Exception) { false }
    }

    private fun startProjection(code: Int, data: Intent) {
        stopProjection()
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val p = try { mpm.getMediaProjection(code, data) } catch (_: Exception) { null } ?: run { TruXApp.main?.get()?.screenStopped(); return }
        projection = p
        val t = HandlerThread("trux-screen").also { it.start() }
        thread = t; worker = Handler(t.looper)
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { cleanupProjection(); TruXApp.main?.get()?.screenStopped() }
        }, worker)
        val m = resources.displayMetrics
        val scale = minOf(1f, 768f / maxOf(m.widthPixels, m.heightPixels))
        val w = (m.widthPixels * scale).toInt() and 1.inv()
        val h = (m.heightPixels * scale).toInt() and 1.inv()
        val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader = r
        r.setOnImageAvailableListener({ ir ->
            val image = try { ir.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            try {
                val now = System.currentTimeMillis()
                if (now - lastFrame < 1000) return@setOnImageAvailableListener
                lastFrame = now
                val plane = image.planes[0]
                val rowPx = plane.rowStride / plane.pixelStride
                val bmp = Bitmap.createBitmap(rowPx, h, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                val frame = Bitmap.createBitmap(bmp, 0, 0, w, h)
                TruXApp.main?.get()?.sendScreenFrame(Images.jpegBase64(frame, 70))
                if (frame !== bmp) frame.recycle(); bmp.recycle()
            } catch (_: Exception) {
            } finally { image.close() }
        }, worker)
        display = p.createVirtualDisplay("trux-screen", w, h, m.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, worker)
    }

    private fun cleanupProjection() {
        display?.release(); display = null
        reader?.close(); reader = null
        thread?.quitSafely(); thread = null; worker = null
        projection = null
    }

    private fun stopProjection() { val p = projection; cleanupProjection(); try { p?.stop() } catch (_: Exception) {} }

    override fun onDestroy() { stopProjection(); super.onDestroy() }

    companion object {
        private const val ID = 42
        private const val ACTION_VOICE = "voice"
        private const val ACTION_SCREEN = "screen"
        private const val ACTION_STOP_SCREEN = "stop_screen"
        private const val EXTRA_CODE = "code"
        private const val EXTRA_DATA = "data"

        fun startVoice(c: Context) { try { c.startForegroundService(Intent(c, LiveService::class.java).setAction(ACTION_VOICE)) } catch (_: Exception) {} }
        fun startScreen(c: Context, code: Int, data: Intent) {
            try { c.startForegroundService(Intent(c, LiveService::class.java).setAction(ACTION_SCREEN).putExtra(EXTRA_CODE, code).putExtra(EXTRA_DATA, data)) } catch (_: Exception) {}
        }
        fun stopScreen(c: Context) { try { c.startService(Intent(c, LiveService::class.java).setAction(ACTION_STOP_SCREEN)) } catch (_: Exception) {} }
        fun stopAll(c: Context) = c.stopService(Intent(c, LiveService::class.java))
    }
}
