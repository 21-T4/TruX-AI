# Methods called from JavaScript must keep their names.
-keepclassmembers class ai.trux.assistant.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
