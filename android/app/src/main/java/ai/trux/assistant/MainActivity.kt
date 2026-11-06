package ai.trux.assistant

import android.Manifest
import android.annotation.SuppressLint
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import ai.trux.assistant.assist.TruXVoiceInteractionService
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.security.SecureRandom

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    private val appUrl = BuildConfig.APP_URL.trimEnd('/')
    private val origin = Bridge.originOf(BuildConfig.APP_URL)
    private val prefs by lazy { getSharedPreferences(TruXApp.PREFS, MODE_PRIVATE) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var liveActive = false
    private var setupStep = -1

    private val runtimePermissions: Array<String>
        get() = buildList {
            add(Manifest.permission.RECORD_AUDIO); add(Manifest.permission.CAMERA)
            add(Manifest.permission.CALL_PHONE); add(Manifest.permission.READ_CONTACTS)
            add(Manifest.permission.ACCESS_FINE_LOCATION); add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        grantWebPermission(); bridge.pushState()
        if (setupStep == 0) nextSetupStep()
    }
    private val askWebPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grantWebPermission() }
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val askProjection = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == RESULT_OK && r.data != null) LiveService.startScreen(this, r.resultCode, r.data!!)
        else bridge.push(JSONObject().put("screenStopped", true))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        TruXApp.main = WeakReference(this)
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString TruXAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        // Keep Live running while the user is in another app.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        bridge = Bridge(this, origin)
        if (!bridge.install(web)) Toast.makeText(this, "Update Android System WebView to use assistant features.", Toast.LENGTH_LONG).show()

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (Bridge.originOf(url.toString()) == origin) return false
                if (url.scheme == "truxai") { handleIntent(Intent(Intent.ACTION_VIEW, url)); return true }
                // Firebase's auth helper pages may load in the WebView; everything else opens outside.
                if (url.host?.endsWith(".firebaseapp.com") == true || url.host == "accounts.google.com") {
                    openCustomTab(url); return true
                }
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: ActivityNotFoundException) {}
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { bridge.reset() }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (Bridge.originOf(request.origin.toString()) != origin) { request.deny(); return }
                pendingWebPermission?.deny()
                pendingWebPermission = request
                val need = mutableListOf<String>()
                if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) need += Manifest.permission.RECORD_AUDIO
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) need += Manifest.permission.CAMERA
                val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) grantWebPermission() else askWebPermissions.launch(missing.toTypedArray())
            }
            override fun onGeolocationPermissionsShowPrompt(o: String, callback: android.webkit.GeolocationPermissions.Callback) {
                val ok = Bridge.originOf(o) == origin
                if (ok && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                    askWebPermissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }
                callback.invoke(o, ok, false)
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try { pickFiles.launch(params.createIntent()); true } catch (_: Exception) { fileCallback = null; false }
            }
        }
        web.settings.setGeolocationEnabled(true)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else moveTaskToBack(true) }
        })

        if (savedInstanceState == null) web.loadUrl("$appUrl/") else web.restoreState(savedInstanceState)
        handleIntent(intent)
        if (!prefs.getBoolean("onboarded", false)) {
            prefs.edit().putBoolean("onboarded", true).apply()
            Pending.add(JSONObject().put("type", "settings"))
        }
        if (prefs.getBoolean("wake", false)) WakeWordService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    override fun onResume() {
        super.onResume()
        web.onResume()
        bridge.pushState()
        if (setupStep > 0) nextSetupStep()
    }

    override fun onPause() {
        super.onPause()
        // Don't pause the page during Live, so voice and screen share keep going.
        if (!liveActive) web.onPause()
    }

    override fun onDestroy() {
        if (TruXApp.main?.get() === this) TruXApp.main = null
        super.onDestroy()
    }

    /* ---------- Intents ---------- */

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val data = intent.data
        when {
            data?.scheme == "truxai" && data.host == "auth" -> finishGoogleSignIn(data)
            data?.scheme == "truxai" && data.host == "live" -> Pending.add(JSONObject().put("type", "live"))
            data?.scheme == "truxai" && data.host == "circle" -> startCircle()
            intent.action == Intent.ACTION_ASSIST || intent.action == Intent.ACTION_VOICE_COMMAND ||
                intent.action == "android.speech.action.WEB_SEARCH" || intent.action == ACTION_LIVE ->
                Pending.add(JSONObject().put("type", "live"))
            intent.action == Intent.ACTION_SEND -> handleShare(intent)
        }
        if (intent.action == ACTION_LIVE || intent.action == Intent.ACTION_ASSIST) this.intent = Intent(this, MainActivity::class.java)
    }

    private fun handleShare(intent: Intent) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
        val stream: Uri? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        val payload = JSONObject().put("type", "share").put("text", text)
        if (stream != null && intent.type?.startsWith("image/") == true) {
            try {
                contentResolver.openInputStream(stream)?.use { input ->
                    val bmp = android.graphics.BitmapFactory.decodeStream(input)
                    if (bmp != null) payload.put("image", Images.dataUrl(Images.fit(bmp, 1600)))
                }
            } catch (_: Exception) {}
        }
        Pending.add(payload)
    }

    fun notifyPending() = runOnUiThread { flushPending() }

    fun flushPending() {
        if (!bridge.isReady) return
        while (true) {
            val next = Pending.take()
            if (next.isEmpty()) break
            bridge.push(JSONObject().put("pending", next))
        }
    }

    /* ---------- State for the web app ---------- */

    fun nativeState(): JSONObject {
        val g = { p: String -> checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED }
        val pm = getSystemService(PowerManager::class.java)
        val status = JSONObject()
            .put("microphone", g(Manifest.permission.RECORD_AUDIO))
            .put("camera", g(Manifest.permission.CAMERA))
            .put("phone", g(Manifest.permission.CALL_PHONE))
            .put("contacts", g(Manifest.permission.READ_CONTACTS))
            .put("notifications", Build.VERSION.SDK_INT < 33 || g(Manifest.permission.POST_NOTIFICATIONS))
            .put("location", g(Manifest.permission.ACCESS_COARSE_LOCATION))
            .put("overlay", Settings.canDrawOverlays(this))
            .put("battery", pm.isIgnoringBatteryOptimizations(packageName))
            .put("assistant", isDefaultAssistant())
        return JSONObject().put("status", status).put("wake", prefs.getBoolean("wake", false)).put("version", BuildConfig.VERSION_NAME)
    }

    fun isDefaultAssistant(): Boolean {
        if (Build.VERSION.SDK_INT >= 29) {
            val rm = getSystemService(RoleManager::class.java)
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) return rm.isRoleHeld(RoleManager.ROLE_ASSISTANT)
        }
        val current = Settings.Secure.getString(contentResolver, "voice_interaction_service") ?: Settings.Secure.getString(contentResolver, "assistant") ?: ""
        return current.startsWith("$packageName/")
    }

    /* ---------- Permission setup: runtime → overlay → battery → assistant ---------- */

    fun startSetup() = runOnUiThread { setupStep = 0; askPermissions.launch(runtimePermissions) }

    private fun nextSetupStep() {
        val pm = getSystemService(PowerManager::class.java)
        when {
            setupStep <= 1 && !Settings.canDrawOverlays(this) -> {
                setupStep = 2
                Toast.makeText(this, "Allow TruX to display over other apps so it can open from \"Hey TruX\".", Toast.LENGTH_LONG).show()
                tryStart(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
            setupStep <= 2 && !pm.isIgnoringBatteryOptimizations(packageName) -> {
                setupStep = 3
                @SuppressLint("BatteryLife")
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                tryStart(i)
            }
            setupStep <= 3 && !isDefaultAssistant() -> { setupStep = 4; openAssistantSettings() }
            else -> { setupStep = -1; bridge.pushState() }
        }
    }

    fun openAssistantSettings() = runOnUiThread {
        Toast.makeText(this, "Choose \"Digital assistant app\" → TruX", Toast.LENGTH_LONG).show()
        val options = listOf(
            Intent(Settings.ACTION_VOICE_INPUT_SETTINGS),
            Intent("android.settings.MANAGE_DEFAULT_APPS_SETTINGS"),
            Intent().setComponent(ComponentName("com.android.settings", "com.android.settings.Settings\$ManageAssistActivity")),
            Intent(Settings.ACTION_SETTINGS)
        )
        for (i in options) if (tryStart(i)) break
    }

    private fun tryStart(i: Intent): Boolean = try { startActivity(i); true } catch (_: Exception) { false }

    private fun grantWebPermission() {
        val req = pendingWebPermission ?: return
        pendingWebPermission = null
        val ok = req.resources.filter {
            (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) ||
                (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
        }
        if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
    }

    /* ---------- Features ---------- */

    fun setWakeWord(on: Boolean) = runOnUiThread {
        prefs.edit().putBoolean("wake", on).apply()
        if (on) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                askPermissions.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
            }
            WakeWordService.start(this)
        } else WakeWordService.stop(this)
        bridge.pushState()
    }

    fun setLiveActive(on: Boolean) = runOnUiThread {
        liveActive = on
        WakeWordService.pause(this, on)
        if (on) LiveService.startVoice(this) else LiveService.stopAll(this)
    }

    fun requestScreenShare() = runOnUiThread {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        askProjection.launch(mpm.createScreenCaptureIntent())
    }

    fun sendScreenFrame(b64: String) = bridge.push(JSONObject().put("frame", b64))
    fun screenStopped() = bridge.push(JSONObject().put("screenStopped", true))

    fun startCircle() = runOnUiThread {
        val service = TruXVoiceInteractionService.instance
        if (service != null) service.showCircle()
        else {
            Toast.makeText(this, "Set TruX as your digital assistant, then hold the side button anywhere to circle.", Toast.LENGTH_LONG).show()
            openAssistantSettings()
        }
    }

    /* ---------- Google sign-in via Custom Tab (Google blocks WebView sign-in) ---------- */

    private fun b64url(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun googleSignIn() = runOnUiThread {
        val rnd = SecureRandom()
        val state = b64url(ByteArray(32).also(rnd::nextBytes))
        val verifier = b64url(ByteArray(32).also(rnd::nextBytes))
        val challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        prefs.edit().putString("auth_state", state).putString("auth_verifier", verifier).putLong("auth_at", System.currentTimeMillis()).apply()
        openCustomTab(Uri.parse("$appUrl/native-auth.html?state=$state&challenge=$challenge"))
    }

    private fun openCustomTab(uri: Uri) {
        try { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri) }
        catch (_: Exception) { tryStart(Intent(Intent.ACTION_VIEW, uri)) }
    }

    private fun finishGoogleSignIn(data: Uri) {
        val state = data.getQueryParameter("state") ?: return
        val saved = prefs.getString("auth_state", null)
        val verifier = prefs.getString("auth_verifier", null)
        val fresh = System.currentTimeMillis() - prefs.getLong("auth_at", 0) < 5 * 60_000
        prefs.edit().remove("auth_state").remove("auth_verifier").apply()
        if (saved == null || verifier == null || saved != state || !fresh) {
            Toast.makeText(this, "Sign-in expired. Please try again.", Toast.LENGTH_LONG).show(); return
        }
        Pending.add(JSONObject().put("type", "auth").put("state", state).put("verifier", verifier))
    }

    companion object {
        const val ACTION_LIVE = "ai.trux.assistant.LIVE"
    }
}

object Images {
    fun fit(src: Bitmap, maxSide: Int): Bitmap {
        val scale = minOf(1f, maxSide.toFloat() / maxOf(src.width, src.height))
        return if (scale >= 1f) src else Bitmap.createScaledBitmap(src, (src.width * scale).toInt().coerceAtLeast(1), (src.height * scale).toInt().coerceAtLeast(1), true)
    }

    fun jpegBase64(bmp: Bitmap, quality: Int = 85): String {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    fun dataUrl(bmp: Bitmap, quality: Int = 88) = "data:image/jpeg;base64," + jpegBase64(bmp, quality)
}
