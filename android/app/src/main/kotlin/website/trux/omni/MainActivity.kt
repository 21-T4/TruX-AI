package website.trux.omni

import android.Manifest
import android.app.Activity
import android.app.MediaProjectionManager
import android.app.RoleManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var pendingFirebaseToken: String? = null

    private val liveStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val state = intent?.getStringExtra(LiveCaptureService.EXTRA_STATE) ?: return
            runOnUiThread {
                if (::webView.isInitialized) {
                    val encoded = org.json.JSONObject.quote(state)
                    webView.evaluateJavascript("window.onTruxLiveState && window.onTruxLiveState($encoded)", null)
                }
            }
        }
    }

    inner class TruXBridge {
        @JavascriptInterface
        fun startLiveSession(firebaseIdToken: String) {
            runOnUiThread { beginLiveSession(firebaseIdToken) }
        }

        @JavascriptInterface
        fun stopLiveSession() {
            runOnUiThread {
                startService(Intent(this@MainActivity, LiveCaptureService::class.java).setAction(LiveCaptureService.ACTION_STOP))
            }
        }

        @JavascriptInterface
        fun isLiveSessionActive(): Boolean = LiveCaptureService.isRunning

        @JavascriptInterface
        fun requestAssistantRole() {
            runOnUiThread { requestAndroidAssistantRole() }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(21, 21, 21)
        window.navigationBarColor = android.graphics.Color.rgb(21, 21, 21)

        webView = WebView(this)
        webView.setBackgroundColor(android.graphics.Color.rgb(21, 21, 21))
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.javaScriptCanOpenWindowsAutomatically = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.addJavascriptInterface(TruXBridge(), "TruXNativeAssistant")
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = WebViewClient()
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.rgb(21, 21, 21))
            addView(webView, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
        })

        val filter = IntentFilter(LiveCaptureService.ACTION_LIVE_STATE)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(liveStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(liveStateReceiver, filter)
        }
        webView.loadUrl(APP_URL)
    }

    private fun beginLiveSession(firebaseIdToken: String) {
        if (firebaseIdToken.isBlank()) {
            reportState("error")
            Toast.makeText(this, "Sign in to TruX before starting Live.", Toast.LENGTH_LONG).show()
            return
        }
        if (LiveCaptureService.isRunning) {
            startService(Intent(this, LiveCaptureService::class.java).setAction(LiveCaptureService.ACTION_STOP))
            return
        }
        pendingFirebaseToken = firebaseIdToken

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }
        continueLivePermissionFlow()
    }

    private fun continueLivePermissionFlow() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE)
            return
        }
        requestScreenShareConsent()
    }

    private fun requestScreenShareConsent() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE)
    }

    @Deprecated("Android activity-result APIs are kept compatible with the native permission flow.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQUEST_SCREEN_CAPTURE -> {
                val token = pendingFirebaseToken
                pendingFirebaseToken = null
                if (resultCode != RESULT_OK || data == null || token.isNullOrBlank()) {
                    reportState("stopped")
                    Toast.makeText(this, "Screen sharing was not started.", Toast.LENGTH_SHORT).show()
                    return
                }
                val serviceIntent = Intent(this, LiveCaptureService::class.java).apply {
                    putExtra(LiveCaptureService.EXTRA_FIREBASE_TOKEN, token)
                    putExtra(LiveCaptureService.EXTRA_PROJECTION_RESULT_CODE, resultCode)
                    putExtra(LiveCaptureService.EXTRA_PROJECTION_DATA, data)
                }
                try {
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(serviceIntent) else startService(serviceIntent)
                    reportState("connecting")
                    // The OS consent dialog has completed and the foreground service now owns the capture.
                    window.decorView.postDelayed({ moveTaskToBack(true) }, 350L)
                } catch (_: Exception) {
                    reportState("error")
                    Toast.makeText(this, "Could not start TruX Live. Please try again.", Toast.LENGTH_LONG).show()
                }
            }
            REQUEST_ASSISTANT_ROLE -> {
                val message = if (resultCode == RESULT_OK) "TruX is now selected as your Android assistant." else "Android assistant selection was not changed."
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }
    }

    @Deprecated("Required to support Android versions before Activity Result APIs.")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQUEST_NOTIFICATIONS -> continueLivePermissionFlow()
            REQUEST_MICROPHONE -> {
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                    requestScreenShareConsent()
                } else {
                    pendingFirebaseToken = null
                    reportState("error")
                    Toast.makeText(this, "Microphone permission is required for voice Live.", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun requestAndroidAssistantRole() {
        if (Build.VERSION.SDK_INT < 29) {
            Toast.makeText(this, "Android assistant selection needs Android 10 or newer.", Toast.LENGTH_LONG).show()
            return
        }
        val roleManager = getSystemService(RoleManager::class.java)
        if (!roleManager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
            Toast.makeText(this, "This Android version does not expose the assistant role.", Toast.LENGTH_LONG).show()
            return
        }
        if (roleManager.isRoleHeld(RoleManager.ROLE_ASSISTANT)) {
            Toast.makeText(this, "TruX is already your selected Android assistant.", Toast.LENGTH_SHORT).show()
            return
        }
        @Suppress("DEPRECATION")
        startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT), REQUEST_ASSISTANT_ROLE)
    }

    private fun reportState(state: String) {
        if (!::webView.isInitialized) return
        val encoded = org.json.JSONObject.quote(state)
        webView.evaluateJavascript("window.onTruxLiveState && window.onTruxLiveState($encoded)", null)
    }

    override fun onDestroy() {
        try { unregisterReceiver(liveStateReceiver) } catch (_: Exception) {}
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("TruXNativeAssistant")
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val APP_URL = "https://trux-ai-workspace.trux.website/"
        private const val REQUEST_NOTIFICATIONS = 8101
        private const val REQUEST_MICROPHONE = 8102
        private const val REQUEST_SCREEN_CAPTURE = 8103
        private const val REQUEST_ASSISTANT_ROLE = 8104
    }
}
