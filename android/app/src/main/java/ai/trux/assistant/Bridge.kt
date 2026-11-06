package ai.trux.assistant

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Web ↔ native channel. Uses WebViewCompat.addWebMessageListener with an
 * origin allow-list, so only the TruX site's own frames can reach it.
 * Untrusted HTML previews (opaque-origin iframes) cannot place calls etc.
 */
class Bridge(private val activity: MainActivity, private val origin: String) {
    private var proxy: JavaScriptReplyProxy? = null
    private val worker = Executors.newSingleThreadExecutor()
    private val actions = DeviceActions(activity)

    @SuppressLint("RequiresFeature")
    fun install(web: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false
        val rules = setOf(origin)
        WebViewCompat.addWebMessageListener(web, "TruXNative", rules) { _, message, source, isMainFrame, reply ->
            if (!isMainFrame || source.toString().trimEnd('/') != origin.trimEnd('/')) return@addWebMessageListener
            handle(message, reply)
        }
        val script = activity.assets.open("bridge.js").bufferedReader().use { it.readText() }
        WebViewCompat.addDocumentStartJavaScript(web, script, rules)
        return true
    }

    /** Main-frame proxy of the current page (reset on navigation). */
    fun reset() { proxy = null }
    val isReady: Boolean get() = proxy != null

    fun push(obj: JSONObject) {
        val p = proxy ?: return
        activity.runOnUiThread { try { p.postMessage(obj.toString()) } catch (_: Exception) {} }
    }

    fun pushState() = push(JSONObject().put("state", activity.nativeState()))

    private fun handle(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val msg = try { JSONObject(message.data ?: return) } catch (_: Exception) { return }
        val args = msg.optJSONArray("args") ?: JSONArray()
        val id = if (msg.has("id")) msg.optInt("id") else null
        when (msg.optString("m")) {
            "ready" -> { proxy = reply; pushState(); activity.flushPending() }
            "deviceAction" -> worker.execute {
                val result = actions.run(args.optString(0))
                activity.runOnUiThread { try { reply.postMessage(JSONObject().put("reply", id).put("value", result).toString()) } catch (_: Exception) {} }
            }
            "requestAllPermissions" -> activity.startSetup()
            "openAssistantSettings" -> activity.openAssistantSettings()
            "setWakeWord" -> activity.setWakeWord(args.optBoolean(0))
            "startScreenShare" -> activity.requestScreenShare()
            "stopScreenShare" -> LiveService.stopScreen(activity)
            "liveActive" -> activity.setLiveActive(args.optBoolean(0))
            "googleSignIn" -> activity.googleSignIn()
            "startCircle" -> activity.startCircle()
        }
    }

    companion object {
        fun originOf(url: String): String { val u = Uri.parse(url); return u.scheme + "://" + u.host + (if (u.port > 0) ":" + u.port else "") }
    }
}
