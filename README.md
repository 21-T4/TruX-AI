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

## Local development

```
gcloud auth application-default login
GOOGLE_CLOUD_PROJECT=trux-ai npm run dev
npm run check
```
