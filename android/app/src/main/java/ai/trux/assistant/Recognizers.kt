package ai.trux.assistant

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * When TruX is the default assistant, Android also makes TruX's
 * RecognitionService the system default. So TruX itself always binds to a
 * real recognizer (Google's, then any other installed one, then on-device).
 */
object Recognizers {
    private const val GOOGLE = "com.google.android.googlequicksearchbox"

    fun component(context: Context): ComponentName? {
        val services = context.packageManager.queryIntentServices(Intent("android.speech.RecognitionService"), 0)
            .map { ComponentName(it.serviceInfo.packageName, it.serviceInfo.name) }
            .filter { it.packageName != context.packageName }
        return services.firstOrNull { it.packageName == GOOGLE }
            ?: services.firstOrNull { it.packageName.contains("google") }
            ?: services.firstOrNull()
    }

    fun create(context: Context): SpeechRecognizer? {
        component(context)?.let { return SpeechRecognizer.createSpeechRecognizer(context, it) }
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            return SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        }
        return null
    }

    fun intent(partial: Boolean = true, preferOffline: Boolean = false): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            if (preferOffline) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
}
