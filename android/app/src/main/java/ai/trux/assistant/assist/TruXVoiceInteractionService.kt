package ai.trux.assistant.assist

import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession

/**
 * Registers TruX as an Android "Digital assistant app". When the user holds
 * the side/home button, Android starts a [TruXSession] with a screenshot.
 */
class TruXVoiceInteractionService : VoiceInteractionService() {
    override fun onReady() { super.onReady(); instance = this }
    override fun onShutdown() { if (instance === this) instance = null; super.onShutdown() }

    /** Circle to search from inside TruX (or a shortcut). */
    fun showCircle() = showSession(Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT)

    /** "Hey TruX": opening through the assistant session is allowed from the background. */
    fun showLive() = showSession(Bundle().apply { putString(TruXSession.MODE, TruXSession.MODE_LIVE) }, 0)

    companion object {
        @Volatile var instance: TruXVoiceInteractionService? = null
    }
}
