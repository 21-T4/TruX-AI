package website.trux.omni

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.media.projection.MediaProjectionManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private var pendingFirebaseToken: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(21, 21, 21)
        window.navigationBarColor = android.graphics.Color.rgb(21, 21, 21)
        handleLaunchIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    private fun handleLaunchIntent(launchIntent: Intent?) {
        val uri: Uri? = launchIntent?.data
        if (launchIntent?.action == Intent.ACTION_VIEW && uri?.scheme == NATIVE_SCHEME) {
            when (uri.host) {
                "live" -> {
                    showStatus("TruX Live\n\nApprove Android's screen-sharing prompt to begin. The ongoing notification lets you stop sharing at any time.")
                    val token = launchIntent.getStringExtra(EXTRA_DEEPLINK_FIREBASE_TOKEN)
                        ?: uri.getQueryParameter("token")
                    beginLiveSession(token.orEmpty())
                }
                "assistant" -> {
                    showStatus("Choose whether TruX-Omni can be your Android assistant.")
                    requestAndroidAssistantRole()
                }
                else -> launchWorkspace()
            }
            return
        }

        // Launch the complete workspace in the installed app shell; Google/Firebase sign-in remains in Chrome's supported browser context.
        launchWorkspace()
    }

    private fun showStatus(message: String) {
        setContentView(TextView(this).apply {
            text = message
            textSize = 16f
            setTextColor(android.graphics.Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(28, 28, 28, 28)
            setBackgroundColor(android.graphics.Color.rgb(21, 21, 21))
        })
    }

    private fun launchWorkspace() {
        try {
            startActivity(Intent(this, WorkspaceActivity::class.java))
        } catch (_: Exception) {
            Toast.makeText(this, "Open TruX-Omni in Chrome and try again.", Toast.LENGTH_LONG).show()
        } finally {
            finish()
        }
    }

    private fun beginLiveSession(firebaseToken: String) {
        if (firebaseToken.isBlank()) {
            Toast.makeText(this, "Sign in to TruX in your browser before starting Live.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        if (LiveCaptureService.isRunning) {
            startService(Intent(this, LiveCaptureService::class.java).setAction(LiveCaptureService.ACTION_STOP))
            finish()
            return
        }
        pendingFirebaseToken = firebaseToken

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

    @Deprecated("Android result callbacks keep the MediaProjection consent flow compatible with API 26+.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQUEST_SCREEN_CAPTURE -> {
                val token = pendingFirebaseToken
                pendingFirebaseToken = null
                if (resultCode != RESULT_OK || data == null || token.isNullOrBlank()) {
                    Toast.makeText(this, "Screen sharing was not started.", Toast.LENGTH_SHORT).show()
                    finish()
                    return
                }
                val serviceIntent = Intent(this, LiveCaptureService::class.java).apply {
                    putExtra(LiveCaptureService.EXTRA_FIREBASE_TOKEN, token)
                    putExtra(LiveCaptureService.EXTRA_PROJECTION_RESULT_CODE, resultCode)
                    putExtra(LiveCaptureService.EXTRA_PROJECTION_DATA, data)
                }
                try {
                    if (Build.VERSION.SDK_INT >= 26) startForegroundService(serviceIntent) else startService(serviceIntent)
                    // Return to the TruX workspace task after Android has granted capture.
                    window.decorView.postDelayed({ finish() }, 350L)
                } catch (_: Exception) {
                    Toast.makeText(this, "Could not start TruX Live. Please try again.", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
            REQUEST_ASSISTANT_ROLE -> {
                val message = if (resultCode == RESULT_OK) {
                    "TruX is selected as your Android assistant."
                } else {
                    "Android assistant selection was not changed."
                }
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                finish()
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
                    Toast.makeText(this, "Microphone permission is required for voice Live.", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        }
    }

    private fun requestAndroidAssistantRole() {
        if (Build.VERSION.SDK_INT < 29) {
            Toast.makeText(this, "Android assistant selection needs Android 10 or newer.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        val roleManager = getSystemService(RoleManager::class.java)
        if (!roleManager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
            Toast.makeText(this, "This Android version does not expose the assistant role.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        if (roleManager.isRoleHeld(RoleManager.ROLE_ASSISTANT)) {
            Toast.makeText(this, "TruX is already your selected Android assistant.", Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        @Suppress("DEPRECATION")
        startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT), REQUEST_ASSISTANT_ROLE)
    }

    companion object {
        private const val NATIVE_SCHEME = "truxnative"
        const val EXTRA_DEEPLINK_FIREBASE_TOKEN = "trux_firebase_token"
        private const val REQUEST_NOTIFICATIONS = 8101
        private const val REQUEST_MICROPHONE = 8102
        private const val REQUEST_SCREEN_CAPTURE = 8103
        private const val REQUEST_ASSISTANT_ROLE = 8104
    }
}
