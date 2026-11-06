package ai.trux.assistant

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import org.json.JSONObject
import java.lang.ref.WeakReference

class TruXApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.channel_assistant), NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
        )
    }

    companion object {
        const val CHANNEL = "assistant"
        const val PREFS = "trux"
        var main: WeakReference<MainActivity>? = null
    }
}

/** Work handed from native screens (assistant, circle, share, sign-in) to the web app. */
object Pending {
    private val queue = ArrayDeque<String>()

    @Synchronized
    fun add(payload: JSONObject) {
        queue.addLast(payload.toString())
        while (queue.size > 8) queue.removeFirst()
        TruXApp.main?.get()?.notifyPending()
    }

    @Synchronized
    fun take(): String = if (queue.isEmpty()) "" else queue.removeFirst()
}
