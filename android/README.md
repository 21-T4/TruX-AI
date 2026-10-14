# TruX-Omni Android app

The launcher opens the complete live TruX-Omni workspace in a Trusted Web Activity
(TWA), using Chrome's browser engine. Chat, TruX-Code, Image, Video, account, and
other workspace pages load inside the app shell, while Google/Firebase sign-in
remains in the supported browser environment. The live workspace is served from
https://trux-ai-workspace.trux.website/ and requires internet access; this APK is
not a standalone offline copy of the hosted app or its Cloud Run backend.

The native companion also handles explicitly approved screen-and-microphone
sharing for TruX Live and the optional Android assistant role through the
truxnative:// deep links.

## Build, signing, and distribution

The workflow **Build TruX-Omni Android** builds an APK, signs it, verifies the
signature, and produces a SHA-256 checksum. With the permanent release key
configured, it publishes the app at:
https://trux-ai-workspace.trux.website/TruX-Omni-Android.apk

The public origin association at `/.well-known/assetlinks.json` matches the
release certificate for package `website.trux.omni`. The workflow refuses to
publish if the configured certificate fingerprint does not match it. Without
the permanent secrets, it creates a temporary signed Actions artifact only and
does not publish that build as an official update.

Configure the following four repository Actions secrets using the private files
provided to the app owner:
- `ANDROID_KEYSTORE_BASE64`: full contents of `ANDROID_KEYSTORE_BASE64.txt`
- `ANDROID_KEYSTORE_PASSWORD`: password from `TruX-Omni-signing-secrets.txt`
- `ANDROID_KEY_ALIAS`: `trux-omni-release`
- `ANDROID_KEY_PASSWORD`: same password from the credentials file

Save these under **GitHub → TruX-AI → Settings → Secrets and variables → Actions**,
then run **Actions → Build TruX-Omni Android → Run workflow**. Keep the keystore
and passwords private and backed up; the signing key is needed for future
update-compatible builds.

The workflow uses Node.js 24-compatible GitHub Actions and Java 17. Direct APK
downloads can still prompt Android or Play Protect to warn about sideloading.
A verified signature and web origin improve trust verification, but do not equal
Google Play review and cannot guarantee a “safe” badge.

## Live screen and microphone sharing

1. Sign in to TruX-Omni in the app.
2. Tap the Live button in the composer.
3. Grant microphone access and approve Android's separate screen-capture prompt.
4. While active, a persistent notification offers Stop. TruX sends microphone
   audio and screen frames (at most one frame per second) to the authenticated
   `/api/live` WebSocket and plays Gemini Live audio responses.
5. Stop sharing through the notification or Live control.

Android's screen-sharing indicator and stop controls remain available. The service
does not bypass the operating system's consent prompt. Screen pixels and microphone
audio are sent to the configured Gemini Live service only during an active session.

## Android assistant role

Choose **Set TruX as Android assistant** in the workspace's three-dot menu.
Android displays its own confirmation; the app cannot silently select itself.
