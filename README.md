# TruX AI

TruX runs as one Node service on Cloud Run. It uses Vertex AI (global endpoint) for chat, images, video and text to speech, and Firebase for sign-in, the Realtime Database (chats, personalization, memories) and push notifications.

## Layout

```
server/
  index.js          HTTP server, security headers, static files, /healthz
  live.js           /api/live WebSocket bridge to the Gemini Live API
  lib/              config discovery, Firebase Admin, Vertex client, prompts, memory, usage, push
  chat/             chat context, agent loop, tools, RTDB stream writer
  routes/           /api/* handlers (chat, files, media, tts, home, plugins, push, feedback, config, models)
public/
  index.html        markup only
  css/              styles (app-1..6, extras, login, live)
  js/               one file per feature, loaded in order at the bottom of index.html
database.rules.json Realtime Database security rules
```

## Configuration

No `.env` file is needed. The project ID, access tokens and the Firebase web config are read from the Cloud Run metadata server and Google APIs at startup. Vertex AI uses `location=global`; Live uses `us-central1` because the Live API has no global endpoint.

Optional environment variables: `TRUX_LIVE_LOCATION`, `TRUX_BUCKET_NAME`, `FIREBASE_WEB_APP_ID`, `FIREBASE_DATABASE_URL`, `TRUX_OWNER_EMAIL`, `TRUX_VIDEO_MODEL`, `TRUX_LIVE_MODEL`.

Optional Secret Manager secrets (same name as the variable): `COMPOSIO_API_KEY`, `RESEND_API_KEY`, `TRUX_FEEDBACK_FROM_EMAIL`, `FCM_VAPID_PUBLIC_KEY`.

## Setup

1. Give the Cloud Run service account these roles: Vertex AI User, Firebase Viewer, Firebase Realtime Database Admin, Firebase Authentication Admin, Storage Object Admin, Secret Manager Secret Accessor, Firebase Cloud Messaging Admin.
2. Create the Realtime Database and deploy the rules: `firebase deploy --only database`.
3. In Firebase Authentication, enable the Email/Password and Google providers and add your domains to Authorized domains.
4. Deploy with request-based billing off so streams keep running after a client disconnects:

```
gcloud run deploy trux-ai --source . --region us-central1 \
  --no-cpu-throttling --timeout=3600 --allow-unauthenticated
```

## One-click setup (no terminal)

`.github/workflows/gcp-setup.yml` does all of the setup below from GitHub:

1. Google Cloud console → IAM & Admin → Service accounts → Create service account (`trux-setup`, role **Owner**) → Keys → Add key → JSON.
2. GitHub → Settings → Secrets and variables → Actions → New repository secret: `GCP_SA_KEY` = the whole JSON file. Optionally add `COMPOSIO_API_KEY`, `RESEND_API_KEY`, `TRUX_FEEDBACK_FROM_EMAIL`, `FCM_VAPID_PUBLIC_KEY`.
3. Actions → **Google Cloud setup** → Run workflow. The run summary lists what changed and anything left to do. Delete the key afterwards if you like.

## Android app (digital assistant)

`android/` is a small Kotlin app that loads the web app and registers TruX as an Android **Digital assistant app** (VoiceInteractionService), so it shows up in Settings → Apps → Default apps → Digital assistant app (including Samsung). It adds system-wide Circle to search (hold the side/home button), the "Hey TruX" wake word, phone actions (calls, texts, apps, alarms) and full-screen sharing in Live.

`.github/workflows/android.yml` builds a signed APK and publishes it to GitHub Releases on every change to `android/` on `main`. `/download/android` on the site redirects to the latest APK.

## Local development

```
gcloud auth application-default login
GOOGLE_CLOUD_PROJECT=trux-ai npm run dev
npm run check
```
