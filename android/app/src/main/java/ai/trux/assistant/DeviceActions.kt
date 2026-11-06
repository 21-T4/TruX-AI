package ai.trux.assistant

import android.Manifest
import android.app.Activity
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import org.json.JSONObject

/** Performs trux_device_action requests from the model. Returns {ok, message}. */
class DeviceActions(private val context: Context) {

    private fun granted(p: String) = context.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun start(intent: Intent): Boolean = try {
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent); true
    } catch (_: ActivityNotFoundException) { false } catch (_: SecurityException) { false }

    private fun result(ok: Boolean, message: String) = JSONObject().put("ok", ok).put("message", message).toString()

    data class Contact(val name: String, val number: String)

    private fun isNumber(s: String) = s.count { it.isDigit() } >= 3 && s.all { it.isDigit() || it in "+-() .*#" }

    private fun findContact(query: String): Contact? {
        if (!granted(Manifest.permission.READ_CONTACTS)) return null
        val uri = Uri.withAppendedPath(ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI, Uri.encode(query))
        val cols = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY,
            ContactsContract.CommonDataKinds.Phone.TIMES_CONTACTED
        )
        val matches = mutableListOf<Pair<Contact, Int>>()
        context.contentResolver.query(uri, cols, null, null, null)?.use { c ->
            while (c.moveToNext() && matches.size < 25) {
                val name = c.getString(0) ?: continue
                val number = c.getString(1) ?: continue
                var score = 0
                if (name.equals(query, true)) score += 100
                else if (name.startsWith(query, true)) score += 50
                if (c.getInt(2) == 1) score += 10
                score += minOf(c.getInt(3), 9)
                matches += Contact(name, number) to score
            }
        }
        return matches.maxByOrNull { it.second }?.first
    }

    private fun resolve(target: String): Contact? =
        if (isNumber(target)) Contact(target, target.filter { it.isDigit() || it == '+' || it == '*' || it == '#' }) else findContact(target)

    fun run(json: String): String {
        val a = try { JSONObject(json) } catch (_: Exception) { return result(false, "Invalid action.") }
        val action = a.optString("action")
        val target = a.optString("target").trim()
        val text = a.optString("text").trim()
        return when (action) {
            "call" -> {
                val c = resolve(target) ?: return result(false,
                    if (granted(Manifest.permission.READ_CONTACTS)) "No contact named $target." else "Allow Contacts so TruX can call people by name.")
                val direct = granted(Manifest.permission.CALL_PHONE)
                val ok = start(Intent(if (direct) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(c.number))))
                result(ok, if (ok) "Calling ${c.name}" else "Couldn't place the call.")
            }
            "message" -> {
                val c = resolve(target) ?: return result(false, "No contact named $target.")
                val i = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(c.number))).putExtra("sms_body", text)
                val ok = start(i)
                result(ok, if (ok) "Message to ${c.name} ready. Tap send." else "No messaging app found.")
            }
            "email" -> {
                val i = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(target)))
                    .putExtra(Intent.EXTRA_SUBJECT, a.optString("subject")).putExtra(Intent.EXTRA_TEXT, text)
                result(start(i), "Email draft opened.")
            }
            "open_app" -> openApp(target)
            "open_url" -> result(start(Intent(Intent.ACTION_VIEW, Uri.parse(target))), "Opening link")
            "navigate" -> {
                val ok = start(Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(target))))
                    || start(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(target))))
                result(ok, if (ok) "Directions to $target" else "No maps app found.")
            }
            "search_maps" -> result(start(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(target)))), "Searching maps")
            "set_alarm" -> {
                val parts = a.optString("time").split(":")
                val i = Intent(AlarmClock.ACTION_SET_ALARM)
                    .putExtra(AlarmClock.EXTRA_HOUR, parts.getOrNull(0)?.toIntOrNull() ?: 7)
                    .putExtra(AlarmClock.EXTRA_MINUTES, parts.getOrNull(1)?.toIntOrNull() ?: 0)
                    .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                if (text.isNotEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, text)
                result(start(i), "Alarm set for ${a.optString("time")}")
            }
            "set_timer" -> {
                val secs = a.optInt("seconds", 60)
                val i = Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, secs).putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                if (text.isNotEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, text)
                result(start(i), "Timer started")
            }
            "open_camera" -> result(start(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)), "Opening camera")
            "open_settings" -> result(start(Intent(settingsAction(target))), "Opening settings")
            "play_media" -> playMedia(target, text)
            else -> result(false, "Unknown action.")
        }
    }

    private fun settingsAction(page: String): String = when (page.lowercase()) {
        "wifi", "wi-fi" -> Settings.ACTION_WIFI_SETTINGS
        "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
        "display", "brightness" -> Settings.ACTION_DISPLAY_SETTINGS
        "sound", "volume" -> Settings.ACTION_SOUND_SETTINGS
        "battery" -> Settings.ACTION_BATTERY_SAVER_SETTINGS
        "apps" -> Settings.ACTION_APPLICATION_SETTINGS
        "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
        "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
        "assistant" -> Settings.ACTION_VOICE_INPUT_SETTINGS
        "notifications" -> "android.settings.NOTIFICATION_SETTINGS"
        else -> Settings.ACTION_SETTINGS
    }

    /** Finds a launcher app by its visible name. */
    fun findApp(name: String): Pair<String, String>? {
        val q = name.lowercase().removePrefix("the ").removeSuffix(" app").trim()
        if (q.isEmpty()) return null
        val pm = context.packageManager
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
        return apps.firstOrNull { it.first.lowercase() == q }
            ?: apps.firstOrNull { it.first.lowercase().startsWith(q) }
            ?: apps.firstOrNull { it.first.lowercase().contains(q) }
            ?: apps.firstOrNull { it.second.lowercase().contains(q.replace(" ", "")) }
    }

    private fun openApp(name: String): String {
        val app = findApp(name) ?: return result(false, "Couldn't find an app called $name.")
        val launch = context.packageManager.getLaunchIntentForPackage(app.second) ?: return result(false, "${app.first} can't be opened.")
        return result(start(launch), "Opening ${app.first}")
    }

    private fun playMedia(appName: String, query: String): String {
        val pkg = if (appName.isNotEmpty()) findApp(appName)?.second else null
        val q = query.ifEmpty { appName }
        if (pkg == "com.google.android.youtube") {
            if (start(Intent(Intent.ACTION_SEARCH).setPackage(pkg).putExtra(SearchManager.QUERY, q))) return result(true, "Playing $q")
        }
        val i = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
            .putExtra(SearchManager.QUERY, q)
        if (pkg != null) i.setPackage(pkg)
        if (start(i)) return result(true, "Playing $q")
        return result(start(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(q)))), "Searching for $q")
    }
}
