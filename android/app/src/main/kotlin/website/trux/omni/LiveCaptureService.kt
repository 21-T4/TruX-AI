package website.trux.omni

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.Image
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

class LiveCaptureService : Service() {
    @Volatile private var stopping = false
    @Volatile private var sessionReady = false
    @Volatile private var audioCaptureStarted = false
    private var websocket: WebSocket? = null
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private var audioRecord: AudioRecord? = null
    private var audioThread: Thread? = null
    private var audioTrack: AudioTrack? = null
    private var audioPlaybackExecutor = Executors.newSingleThreadExecutor()
    private var lastVideoFrameMs = 0L
    private val socketClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            endLive("stopped", tellServer = true)
            return START_NOT_STICKY
        }
        if (isRunning) return START_NOT_STICKY

        val firebaseToken = intent?.getStringExtra(EXTRA_FIREBASE_TOKEN).orEmpty()
        val resultCode = intent?.getIntExtra(EXTRA_PROJECTION_RESULT_CODE, 0) ?: 0
        val resultData = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_PROJECTION_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_PROJECTION_DATA)
        }
        if (firebaseToken.isBlank() || resultData == null || resultCode != RESULT_OK) {
            stopSelf()
            return START_NOT_STICKY
        }

        isRunning = true
        createNotificationChannel()
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Exception) {
            broadcastState("error")
            isRunning = false
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(resultCode, resultData)
            if (projection == null) throw IllegalStateException("Android did not grant screen capture.")
            startScreenCapture()
            connectLiveSocket(firebaseToken)
            broadcastState("connecting")
        } catch (_: Exception) {
            endLive("error", tellServer = false)
        }
        return START_NOT_STICKY
    }

    private fun connectLiveSocket(firebaseToken: String) {
        val request = Request.Builder().url(LIVE_SOCKET_URL).build()
        websocket = socketClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject()
                    .put("type", "auth")
                    .put("token", firebaseToken)
                    .toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val packet = try { JSONObject(text) } catch (_: Exception) { return }
                when (packet.optString("type")) {
                    "ready" -> {
                        sessionReady = true
                        startAudioOutput()
                        startAudioCapture()
                        broadcastState("live")
                    }
                    "connecting" -> broadcastState("connecting")
                    "audio" -> {
                        val encoded = packet.optString("data")
                        if (encoded.isNotEmpty()) {
                            val pcm = try { Base64.decode(encoded, Base64.DEFAULT) } catch (_: Exception) { null }
                            if (pcm != null && pcm.isNotEmpty()) {
                                audioPlaybackExecutor.execute {
                                    try { audioTrack?.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING) } catch (_: Exception) {}
                                }
                            }
                        }
                    }
                    "error" -> {
                        broadcastState("error")
                        endLive("error", tellServer = false)
                    }
                    "ended" -> endLive("stopped", tellServer = false)
                    "interrupted" -> {
                        try { audioTrack?.pause(); audioTrack?.flush(); audioTrack?.play() } catch (_: Exception) {}
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!stopping) {
                    broadcastState("error")
                    endLive("error", tellServer = false)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!stopping) endLive("stopped", tellServer = false)
            }
        })
    }

    private fun startScreenCapture() {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        val manager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        manager.defaultDisplay.getRealMetrics(metrics)

        val originalWidth = metrics.widthPixels.coerceAtLeast(1)
        val originalHeight = metrics.heightPixels.coerceAtLeast(1)
        val scale = min(1.0, MAX_CAPTURE_DIMENSION.toDouble() / max(originalWidth, originalHeight).toDouble())
        val width = max(1, (originalWidth * scale).toInt())
        val height = max(1, (originalHeight * scale).toInt())

        captureThread = HandlerThread("TruXLiveCapture").apply { start() }
        captureHandler = Handler(captureThread!!.looper)
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader?.setOnImageAvailableListener({ reader ->
            val now = SystemClock.elapsedRealtime()
            if (now - lastVideoFrameMs < VIDEO_FRAME_INTERVAL_MS) {
                val skipped = try { reader.acquireLatestImage() } catch (_: Exception) { null }
                skipped?.close()
                return@setOnImageAvailableListener
            }
            val image = try { reader.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            lastVideoFrameMs = now
            try {
                val bytes = imageToJpeg(image) ?: return@setOnImageAvailableListener
                if (sessionReady && !stopping) {
                    val frame = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    sendPacket(JSONObject().put("type", "video").put("data", frame))
                }
            } catch (_: Exception) {
                // A dropped frame must not terminate the live session.
            } finally {
                image.close()
            }
        }, captureHandler)

        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                endLive("stopped", tellServer = true)
            }
        }, captureHandler)
        virtualDisplay = projection?.createVirtualDisplay(
            "TruX-Omni Live screen",
            width,
            height,
            metrics.densityDpi.coerceAtLeast(1),
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null,
            captureHandler
        )
        if (virtualDisplay == null) throw IllegalStateException("Android could not create the screen stream.")
    }

    private fun imageToJpeg(image: Image): ByteArray? {
        val plane = image.planes.firstOrNull() ?: return null
        val pixelStride = plane.pixelStride.coerceAtLeast(1)
        val rowStride = plane.rowStride.coerceAtLeast(image.width * pixelStride)
        val paddedWidth = image.width + max(0, rowStride - image.width * pixelStride) / pixelStride
        val buffer: ByteBuffer = plane.buffer
        val paddedBitmap = Bitmap.createBitmap(paddedWidth.coerceAtLeast(image.width), image.height, Bitmap.Config.ARGB_8888)
        try {
            buffer.rewind()
            paddedBitmap.copyPixelsFromBuffer(buffer)
            val cropped = if (paddedBitmap.width != image.width) {
                Bitmap.createBitmap(paddedBitmap, 0, 0, image.width, image.height)
            } else paddedBitmap
            try {
                val out = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                return out.toByteArray()
            } finally {
                if (cropped !== paddedBitmap) cropped.recycle()
            }
        } finally {
            paddedBitmap.recycle()
        }
    }

    private fun startAudioCapture() {
        if (audioCaptureStarted || stopping) return
        val minBuffer = AudioRecord.getMinBufferSize(
            INPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuffer <= 0) throw IllegalStateException("Audio recording is unavailable.")
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            INPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            max(minBuffer * 2, AUDIO_CHUNK_BYTES * 2)
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            throw IllegalStateException("Could not initialize the microphone.")
        }
        audioRecord = recorder
        recorder.startRecording()
        audioCaptureStarted = true
        audioThread = Thread({
            val buffer = ByteArray(AUDIO_CHUNK_BYTES)
            while (!stopping && audioCaptureStarted && !Thread.currentThread().isInterrupted) {
                val count = try { recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING) } catch (_: Exception) { -1 }
                if (count > 0 && sessionReady && !stopping) {
                    val encoded = Base64.encodeToString(buffer.copyOf(count), Base64.NO_WRAP)
                    sendPacket(JSONObject().put("type", "audio").put("data", encoded))
                } else if (count < 0) {
                    break
                }
            }
        }, "TruXLiveMicrophone").apply { start() }
    }

    private fun startAudioOutput() {
        if (audioTrack != null) return
        val minimum = AudioTrack.getMinBufferSize(
            OUTPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(4096)
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(OUTPUT_SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(minimum * 2)
            .build()
        audioTrack = track
        track.play()
    }

    private fun sendPacket(packet: JSONObject) {
        if (!sessionReady || stopping) return
        websocket?.send(packet.toString())
    }

    private fun buildNotification(): Notification {
        val stopIntent = PendingIntent.getService(
            this,
            21,
            Intent(this, LiveCaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val openIntent = PendingIntent.getActivity(
            this,
            22,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, NOTIFICATION_CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(getString(R.string.live_notification_title))
            .setContentText(getString(R.string.live_notification_text))
            .setContentIntent(openIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.live_stop), stopIntent).build())
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL,
                "TruX Live screen sharing",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Visible while TruX shares screen and microphone with Gemini Live." }
        )
    }

    private fun broadcastState(state: String) {
        sendBroadcast(Intent(ACTION_LIVE_STATE).setPackage(packageName).putExtra(EXTRA_STATE, state))
    }

    private fun endLive(state: String, tellServer: Boolean) {
        if (stopping) return
        stopping = true
        sessionReady = false
        audioCaptureStarted = false
        broadcastState(state)

        if (tellServer) {
            try { websocket?.send(JSONObject().put("type", "stop").toString()) } catch (_: Exception) {}
        }
        try { websocket?.close(1000, "TruX Live stopped") } catch (_: Exception) {}
        websocket = null

        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
        audioThread?.interrupt()
        audioThread = null

        try { audioTrack?.pause() } catch (_: Exception) {}
        try { audioTrack?.flush() } catch (_: Exception) {}
        try { audioTrack?.stop() } catch (_: Exception) {}
        try { audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null
        try { audioPlaybackExecutor.shutdownNow() } catch (_: Exception) {}
        audioPlaybackExecutor = Executors.newSingleThreadExecutor()

        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.setOnImageAvailableListener(null, null) } catch (_: Exception) {}
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
        try { captureThread?.quitSafely() } catch (_: Exception) {}
        captureThread = null
        captureHandler = null

        isRunning = false
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
        stopSelf()
    }

    override fun onDestroy() {
        if (!stopping) endLive("stopped", tellServer = true)
        socketClient.dispatcher.cancelAll()
        socketClient.connectionPool.evictAll()
        socketClient.dispatcher.executorService.shutdown()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "website.trux.omni.action.STOP_LIVE"
        const val ACTION_LIVE_STATE = "website.trux.omni.action.LIVE_STATE"
        const val EXTRA_STATE = "state"
        const val EXTRA_FIREBASE_TOKEN = "firebase_id_token"
        const val EXTRA_PROJECTION_RESULT_CODE = "projection_result_code"
        const val EXTRA_PROJECTION_DATA = "projection_result_data"
        private const val LIVE_SOCKET_URL = "wss://trux-ai-workspace.trux.website/api/live"
        private const val NOTIFICATION_ID = 4102
        private const val NOTIFICATION_CHANNEL = "trux_live_capture"
        private const val INPUT_SAMPLE_RATE = 16000
        private const val OUTPUT_SAMPLE_RATE = 24000
        private const val AUDIO_CHUNK_BYTES = 3200
        private const val MAX_CAPTURE_DIMENSION = 1024
        private const val VIDEO_FRAME_INTERVAL_MS = 1000L
        private const val JPEG_QUALITY = 60

        @Volatile
        var isRunning: Boolean = false
            private set
    }
}
