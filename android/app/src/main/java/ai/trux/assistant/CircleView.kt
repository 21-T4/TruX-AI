package ai.trux.assistant

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Frozen screenshot + animated glowing edge + lasso / tap selection. */
@SuppressLint("ViewConstructor")
class CircleView(context: Context, private val shot: Bitmap?, private val onSelected: (RectF) -> Unit) : View(context) {
    private val colors = intArrayOf(0xFF4F8CFF.toInt(), 0xFF9B6BFF.toInt(), 0xFFFF5FA2.toInt(), 0xFFFFB347.toInt(), 0xFF4F8CFF.toInt())
    private val dp = resources.displayMetrics.density
    private val path = Path()
    private val points = ArrayList<PointF>()
    private var drawing = false
    var selection: RectF? = null; private set
    private var angle = 0f
    private var intro = 0f
    private val shotRect = RectF()

    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val core = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = Color.WHITE; strokeWidth = 1.6f * dp }
    private val dim = Paint().apply { color = 0x8C04060E.toInt() }
    private val corner = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; color = Color.WHITE; strokeWidth = 4 * dp }
    private val shotPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val bg = Paint().apply { color = Color.BLACK }

    private val spinner = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 3200; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
        addUpdateListener { angle = it.animatedValue as Float; invalidate() }
    }
    private val introAnim = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 420; addUpdateListener { intro = it.animatedValue as Float; invalidate() }
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); spinner.start(); introAnim.start() }
    override fun onDetachedFromWindow() { spinner.cancel(); introAnim.cancel(); super.onDetachedFromWindow() }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        if (shot == null) return
        val s = min(w.toFloat() / shot.width, h.toFloat() / shot.height)
        val sw = shot.width * s; val sh = shot.height * s
        shotRect.set((w - sw) / 2, (h - sh) / 2, (w + sw) / 2, (h + sh) / 2)
    }

    override fun onDraw(c: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        c.drawRect(0f, 0f, w, h, bg)
        if (shot != null) c.drawBitmap(shot, null, shotRect, shotPaint)

        selection?.takeIf { !drawing }?.let { sel ->
            c.save(); c.clipOutRect(sel); c.drawRect(0f, 0f, w, h, dim); c.restore()
            drawCorners(c, sel)
        }

        if (points.size > 1) {
            val shader = LinearGradient(0f, 0f, w, h, colors, null, Shader.TileMode.CLAMP)
            ink.shader = shader
            // Soft glow: wide, faint strokes under the line (works with hardware rendering).
            for ((width, alpha) in listOf(22f to 40, 14f to 70, 8f to 140)) {
                ink.strokeWidth = width * dp; ink.alpha = alpha; c.drawPath(path, ink)
            }
            ink.strokeWidth = 4.5f * dp; ink.alpha = 255; c.drawPath(path, ink)
            c.drawPath(path, core)
        }

        // Rotating gradient border, like Gemini.
        val m = Matrix().apply { setRotate(angle, w / 2, h / 2) }
        val sweep = SweepGradient(w / 2, h / 2, colors, null).apply { setLocalMatrix(m) }
        glow.shader = sweep
        val radius = 26 * dp
        val fade = if (selection != null && !drawing) 0.55f else 1f
        for ((sw, a) in listOf(28f to 34, 16f to 70, 8f to 150, 3.5f to 255)) {
            glow.strokeWidth = sw * dp; glow.alpha = (a * intro * fade).toInt()
            c.drawRoundRect(0f, 0f, w, h, radius, radius, glow)
        }
    }

    private fun drawCorners(c: Canvas, r: RectF) {
        val len = min(28 * dp, min(r.width(), r.height()) / 3)
        for ((x, y, dx, dy) in listOf(Quad(r.left, r.top, 1f, 1f), Quad(r.right, r.top, -1f, 1f), Quad(r.left, r.bottom, 1f, -1f), Quad(r.right, r.bottom, -1f, -1f))) {
            c.drawLine(x, y, x + dx * len, y, corner); c.drawLine(x, y, x, y + dy * len, corner)
        }
    }

    private data class Quad(val a: Float, val b: Float, val c: Float, val d: Float)

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (shot == null) return false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                drawing = true; selection = null; points.clear(); path.reset()
                points += PointF(e.x, e.y); path.moveTo(e.x, e.y); invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                val last = points.last()
                if (hypot(e.x - last.x, e.y - last.y) > 2 * dp) {
                    path.quadTo(last.x, last.y, (e.x + last.x) / 2, (e.y + last.y) / 2)
                    points += PointF(e.x, e.y); invalidate()
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                drawing = false
                var l = points.minOf { it.x }; var r = points.maxOf { it.x }
                var t = points.minOf { it.y }; var b = points.maxOf { it.y }
                if (r - l < 24 * dp && b - t < 24 * dp) {
                    val half = min(width, height) * 0.2f
                    l = e.x - half; r = e.x + half; t = e.y - half * 0.7f; b = e.y + half * 0.7f
                    points.clear(); path.reset()
                }
                val pad = 10 * dp
                val sel = RectF(max(0f, l - pad), max(0f, t - pad), min(width.toFloat(), r + pad), min(height.toFloat(), b + pad))
                selection = sel
                performHapticFeedback(android.view.HapticFeedbackConstants.CONTEXT_CLICK)
                invalidate(); onSelected(sel)
            }
        }
        return true
    }

    /** Crop of the selection in screenshot pixels (or the whole screen). */
    fun crop(maxSide: Int = 1600): Bitmap? {
        val src = shot ?: return null
        val sel = selection ?: RectF(shotRect)
        val s = shotRect.width() / src.width
        if (s <= 0f) return null
        val x = ((sel.left - shotRect.left) / s).toInt().coerceIn(0, src.width - 1)
        val y = ((sel.top - shotRect.top) / s).toInt().coerceIn(0, src.height - 1)
        val w = (sel.width() / s).toInt().coerceIn(1, src.width - x)
        val h = (sel.height() / s).toInt().coerceIn(1, src.height - y)
        if (w < 4 || h < 4) return null
        return Images.fit(Bitmap.createBitmap(src, x, y, w, h), maxSide)
    }
}
