# TruX-Omni Android shell

The native Android companion launches the existing TruX-Omni workspace in the
user's normal browser so Firebase/Google sign-in keeps working. Its native side
handles explicit Android screen-sharing permission, the Live foreground
service, and an opt-in Android assistant role. The app and companion source are
in this repository; the web app remains at
`https://trux-ai-workspace.trux.website/`.

## Build and signing

The workflow **Build TruX-Omni Android** builds a native installable release APK,
verifies its Android signature, and publishes it at:
https://trux-ai-workspace.trux.website/TruX-Omni-Android.apk

The build artifact is also available from the workflow run for 30 days. This is
a directly installable APK, not a PWA package or Play Store release.

For a stable release signature that permits future APK upgrades, add these four
GitHub Actions repository secrets before distributing releases:

- `ANDROID_KEYSTORE_BASE64`: Base64-encoded permanent Android signing keystore
- `ANDROID_KEYSTORE_PASSWORD`: keystore password
- `ANDROID_KEY_ALIAS`: key alias
- `ANDROID_KEY_PASSWORD`: key password

Without those secrets, CI uses the generated Android debug certificate so the APK
is still signed and testable, but that certificate is not stable between hosted
runners. Do not treat that fallback as a production/update-compatible signing key.

The build uses Android Gradle Plugin 8.9.2, Gradle 8.11.1, and Java 17.

## Live screen and microphone sharing

1. Install the native APK and sign in to TruX-Omni inside it.
2. Tap the Live button in the empty composer.
3. Grant microphone permission and approve Android's screen-capture prompt. In
   the system chooser, choose full-screen sharing when that option is offered.
4. TruX starts a foreground service with a persistent notification and moves
   the app to the background. The service sends microphone audio and screen
   frames (at most one frame per second) to the authenticated `/api/live`
   WebSocket, then plays Gemini Live's audio replies.
5. Tap **Stop Live** in the ongoing notification or tap the composer button
   again while the app is open to stop sharing.

Android displays its own screen-sharing indicator and lets the user end capture
at any time. The service does not try to bypass those controls. Screen pixels
and microphone audio are sent to the configured Gemini Live service while the
session is active.

The server uses the Cloud Run service identity for Vertex AI. The model and
location can be set with `TRUX_LIVE_MODEL` and `TRUX_LIVE_LOCATION`.

## Make TruX the Android assistant

Open the three-dot menu in the composer and choose **Set TruX as Android
assistant**. Android decides whether the role is available and displays its
system confirmation screen. The user can decline or select another assistant
later in Android settings. This app requests the role; it cannot silently set
itself as the default assistant.
