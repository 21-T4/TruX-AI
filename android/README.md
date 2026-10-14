# TruX-Omni Android shell

This native Android wrapper loads the existing TruX-Omni workspace at
`https://trux-ai-workspace.trux.website/`. It exposes a small JavaScript bridge
for Live and the Android assistant-role request.

## Build

Open the `android` directory in Android Studio, or use the repository workflow
**Build TruX-Omni Android** to produce a debug APK artifact. The APK from the
workflow is an unsigned debug build for testing, not a Play Store release.

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
