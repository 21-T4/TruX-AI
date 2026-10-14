# TruX-Omni Android shell

The native Android companion launches the existing TruX-Omni workspace in the
user's normal browser so Firebase/Google sign-in keeps working. Its native side
handles explicit Android screen-sharing permission, the Live foreground
service, and an opt-in Android assistant role. The app and companion source are
in this repository; the web app remains at
`https://trux-ai-workspace.trux.website/`.

## Build

The latest installable debug APK is published at
https://github.com/21-T4/TruX-AI/releases/download/trux-android-latest/TruX-Omni-Android.apk.
The workflow **Build TruX-Omni Android** also keeps a downloadable Actions
artifact as a backup. This APK is for direct testing, not a Play Store release.
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
