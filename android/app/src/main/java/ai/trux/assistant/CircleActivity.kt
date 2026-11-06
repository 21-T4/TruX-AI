package ai.trux.assistant

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.SpeechRecognizer
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File

/** Native Circle to search: shown by the assistant session over any app. */
class CircleActivity : Activity() {
    private lateinit var circle: CircleView
    private lateinit var input: EditText
    private lateinit var thumb: ImageView
    private lateinit var hint: TextView
    private lateinit var mic: ImageButton
    private lateinit var bar: LinearLayout
    private var recognizer: SpeechRecognizer? = null
    private var shot: Bitmap? = null
    private val dp get() = resources.displayMetrics.density

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val file = File(cacheDir, SHOT_FILE)
        shot = if (intent.getBooleanExtra(EXTRA_HAS_SHOT, false) && file.exists()) BitmapFactory.decodeFile(file.absolutePath) else null
        file.delete()

        val root = FrameLayout(this)
        circle = CircleView(this, shot) { onSelection() }
        root.addView(circle, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val close = roundButton(R.drawable.ic_close, 0xB80A0C16.toInt()) { finish() }
        hint = TextView(this).apply {
            text = if (shot != null) "Circle or tap anything to search" else "Ask TruX anything. To circle things, turn on \"Use screenshot\" in Digital assistant settings."
            setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            background = pill(0xB80A0C16.toInt()); setPadding((14 * dp).toInt(), (8 * dp).toInt(), (14 * dp).toInt(), (8 * dp).toInt())
            maxLines = 3
        }
        val live = TextView(this).apply {
            text = "Live"; setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_live, 0, 0, 0); compoundDrawablePadding = (6 * dp).toInt()
            background = pill(0xB80A0C16.toInt()); setPadding((12 * dp).toInt(), (8 * dp).toInt(), (14 * dp).toInt(), (8 * dp).toInt())
            setOnClickListener { openMain(JSONObject().put("type", "live")) }
        }
        top.addView(close, LinearLayout.LayoutParams((40 * dp).toInt(), (40 * dp).toInt()))
        top.addView(hint, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = (10 * dp).toInt(); marginEnd = (10 * dp).toInt() })
        top.addView(live, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        root.addView(top, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP).apply {
            setMargins((14 * dp).toInt(), (36 * dp).toInt(), (14 * dp).toInt(), 0)
        })

        bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = glowingPill(); setPadding((8 * dp).toInt(), (7 * dp).toInt(), (7 * dp).toInt(), (7 * dp).toInt())
            elevation = 12 * dp
        }
        thumb = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; visibility = View.GONE; clipToOutline = true; background = pill(Color.WHITE, 12f) }
        input = EditText(this).apply {
            hint = if (shot != null) "Ask about your screen…" else "Ask TruX…"
            setHintTextColor(0x99FFFFFF.toInt()); setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            background = null; isSingleLine = true; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setOnEditorActionListener { _, id, ev -> if (id == EditorInfo.IME_ACTION_SEARCH || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { submit(); true } else false }
        }
        mic = roundButton(R.drawable.ic_mic, 0x22FFFFFF) { dictate() }
        val send = roundButton(R.drawable.ic_send, 0) { submit() }.apply {
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFF4F8CFF.toInt(), 0xFF9B6BFF.toInt())).apply { shape = GradientDrawable.OVAL }
        }
        val s42 = (44 * dp).toInt()
        bar.addView(thumb, LinearLayout.LayoutParams((42 * dp).toInt(), (42 * dp).toInt()).apply { marginEnd = (4 * dp).toInt() })
        bar.addView(input, LinearLayout.LayoutParams(0, s42, 1f).apply { marginStart = (6 * dp).toInt() })
        bar.addView(mic, LinearLayout.LayoutParams(s42, s42).apply { marginEnd = (6 * dp).toInt() })
        bar.addView(send, LinearLayout.LayoutParams(s42, s42))
        root.addView(bar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins((12 * dp).toInt(), 0, (12 * dp).toInt(), (24 * dp).toInt())
        })
        setContentView(root)

        bar.translationY = 260 * dp
        bar.animate().translationY(0f).setStartDelay(120).setDuration(420)
            .setInterpolator(android.view.animation.OvershootInterpolator(1.1f)).start()
        if (shot == null) input.post { input.requestFocus(); getSystemService(InputMethodManager::class.java).showSoftInput(input, 0) }
    }

    private fun pill(color: Int, radiusDp: Float = 999f) = GradientDrawable().apply { setColor(color); cornerRadius = radiusDp * dp }

    private fun glowingPill(): LayerDrawable {
        val edge = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(0xFF4F8CFF.toInt(), 0xFF9B6BFF.toInt(), 0xFFFF5FA2.toInt(), 0xFFFFB347.toInt())).apply { cornerRadius = 999f * dp }
        val fill = GradientDrawable().apply { setColor(0xF2121420.toInt()); cornerRadius = 999f * dp }
        return LayerDrawable(arrayOf(edge, fill)).apply { val i = (1.6f * dp).toInt(); setLayerInset(1, i, i, i, i) }
    }

    private fun roundButton(icon: Int, color: Int, onClick: () -> Unit) = ImageButton(this).apply {
        setImageResource(icon); background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
        scaleType = ImageView.ScaleType.CENTER; setOnClickListener { onClick() }
    }

    private fun onSelection() {
        hint.text = "Ask anything, or circle again"
        circle.crop(360)?.let { thumb.setImageBitmap(it); thumb.visibility = View.VISIBLE }
        input.hint = "Ask about this…"
    }

    private fun dictate() {
        if (recognizer != null) { recognizer?.stopListening(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 7); return
        }
        val r = Recognizers.create(this) ?: run { hint.text = "Voice input isn't available on this phone."; return }
        recognizer = r
        mic.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFFF5FA2.toInt()) }
        WakeWordService.pause(this, true)
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(p: Bundle?) { hint.text = "Listening…" }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(v: Float) { mic.scaleX = 1f + (v.coerceIn(0f, 10f) / 60f); mic.scaleY = mic.scaleX }
            override fun onBufferReceived(b: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(e: Int) { done(); hint.text = "Didn't catch that. Try again." }
            override fun onResults(b: Bundle?) {
                val t = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                input.setText(t); done(); if (t.isNotBlank()) submit()
            }
            override fun onPartialResults(b: Bundle?) { b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { input.setText(it) } }
            override fun onEvent(t: Int, p: Bundle?) {}
        })
        r.startListening(Recognizers.intent())
    }

    private fun done() {
        recognizer?.destroy(); recognizer = null
        mic.scaleX = 1f; mic.scaleY = 1f
        mic.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x22FFFFFF) }
        WakeWordService.pause(this, false)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code == 7 && results.firstOrNull() == PackageManager.PERMISSION_GRANTED) dictate()
    }

    private fun submit() {
        val text = input.text.toString().trim()
        val crop = circle.crop()
        if (crop == null && text.isEmpty()) { hint.text = if (shot != null) "Circle something or type a question" else "Type or say a question"; return }
        val payload = if (crop != null) JSONObject().put("type", "circle").put("image", Images.dataUrl(crop))
            .put("text", text.ifEmpty { "What is this? Search it and tell me what matters." })
        else JSONObject().put("type", "share").put("text", text)
        // Text-only questions are sent straight away.
        if (crop == null) payload.put("send", true)
        openMain(payload)
    }

    private fun openMain(payload: JSONObject) {
        Pending.add(payload)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        finish()
    }

    override fun onStop() { super.onStop(); if (!isFinishing) finish() }
    override fun onDestroy() { recognizer?.destroy(); recognizer = null; WakeWordService.pause(this, false); super.onDestroy() }

    companion object {
        const val SHOT_FILE = "circle_shot.png"
        const val EXTRA_HAS_SHOT = "has_shot"
    }
}
