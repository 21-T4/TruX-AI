package ai.trux.assistant.assist

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import ai.trux.assistant.Recognizers

/**
 * Required for the assistant role. Android makes the assistant's recognizer
 * the system default, so this forwards to the phone's real recognizer
 * (Google's) to keep voice typing working in every other app.
 */
class TruXRecognitionService : RecognitionService() {
    private var inner: SpeechRecognizer? = null

    override fun onStartListening(intent: Intent, listener: Callback) {
        inner?.destroy()
        val r = Recognizers.create(this)
        if (r == null) { listener.error(SpeechRecognizer.ERROR_CLIENT); return }
        inner = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = safe { listener.readyForSpeech(params ?: Bundle()) }
            override fun onBeginningOfSpeech() = safe { listener.beginningOfSpeech() }
            override fun onRmsChanged(rmsdB: Float) = safe { listener.rmsChanged(rmsdB) }
            override fun onBufferReceived(buffer: ByteArray?) = safe { if (buffer != null) listener.bufferReceived(buffer) }
            override fun onEndOfSpeech() = safe { listener.endOfSpeech() }
            override fun onError(error: Int) = safe { listener.error(error) }
            override fun onResults(results: Bundle?) = safe { listener.results(results ?: Bundle()) }
            override fun onPartialResults(partialResults: Bundle?) = safe { listener.partialResults(partialResults ?: Bundle()) }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(intent)
    }

    private fun safe(block: () -> Unit) { try { block() } catch (_: Exception) {} }

    override fun onStopListening(listener: Callback) { inner?.stopListening() }
    override fun onCancel(listener: Callback) { inner?.cancel() }
    override fun onDestroy() { inner?.destroy(); inner = null; super.onDestroy() }
}
