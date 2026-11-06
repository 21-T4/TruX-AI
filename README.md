# TruX AI

TruX runs as one Node service on Cloud Run. It uses Vertex AI (global endpoint) for chat, images, video and text to speech, and Firebase for sign-in, the Realtime Database (chats, personalization, memories) and push notifications. A second, private Cloud Run service (`trux-sandbox`) gives the assistant a Linux shell, curl and a headless browser.

## Layout

```
server/
  index.js          HTTP server, security headers, static files, /healthz
  live.js           /api/live WebSocket bridge to the Gemini Live API
  lib/              config discovery, Firebase Admin, Vertex client, video pipeline, sandbox client, prompts, memory
  chat/             chat context, agent loop, tools, RTDB stream writer
  routes/           /api/* handlers (chat, files, media, tts, home, plugins, push, feedback, config, models)
sandbox/            the trux-sandbox service (bash, curl, Playwright browser, screenshots)
public/
  index.html        markup only
  css/              styles; themes.css holds every colour token and loads last
  js/               one file per feature, loaded in order at the bottom of index.html
  assetlinks.json   Digital Asset Links for the Play Store app (served at /.well-known/assetlinks.json)
database.rules.json Realtime Database security rules
```

## Models

| Feature | Model |
| --- | --- |
| Images (in normal chat) | `gemini-3-pro-image` (Nano Banana Pro) |
| Video shot planning | `gemini-4-argon` |
| Video shots | `veo-3.1-generate-001` (1080p, with sound) |
| Longer cuts and video edits | `gemini-omni-1.2-flash` |

Video lengths: 8 s (one Veo shot), 18 s and 28 s (Veo opening shot, then Gemini Omni extensions).

## Configuration

No `.env` file and no environment variables. The project ID comes from Cloud Run, the Firebase web config, database and bucket (`<project>-bucket`) are discovered from the project, Vertex AI uses `location=global`, and Live uses `us-central1` (the Live API has no global endpoint). Feedback mail goes to ekagraavn2003@gmail.com from `onboarding@resend.dev`.

Optional Secret Manager secrets: `COMPOSIO_API_KEY` (plugins), `RESEND_API_KEY` (feedback email), `FCM_VAPID_PUBLIC_KEY` (web push).

## One-click setup (no terminal)

`.github/workflows/gcp-setup.yml` enables the APIs, grants the service account its roles, stores the secrets, checks Firebase (web app, database rules, sign-in, domains), deploys the private sandbox and sets the Cloud Run flags.

1. Google Cloud console → IAM & Admin → Service accounts → Create service account (`trux-setup`, role **Owner**) → Keys → Add key → JSON.
2. GitHub → Settings → Secrets and variables → Actions → New repository secret: `GCP_SA_KEY` = the whole JSON file. Optionally add `COMPOSIO_API_KEY`, `RESEND_API_KEY`, `FCM_VAPID_PUBLIC_KEY`.
3. Actions → **Google Cloud setup** → Run workflow. The run summary lists what changed and anything left to do. Delete the key afterwards if you like.

## Play Store app

TruX is a PWA, so the Play Store app is a Trusted Web Activity (a full-screen Chrome view of the site, which keeps Google sign-in, the mic, camera and push working):

1. Open [PWABuilder](https://www.pwabuilder.com), enter the site URL, choose **Android → Google Play**, and download the package (it contains the `.aab` and a signing key; keep the key safe).
2. Upload the `.aab` in Play Console.
3. Play Console → your app → Test and release → App integrity → copy the **SHA-256** of the app signing key.
4. In GitHub, edit `public/assetlinks.json` and paste:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": { "namespace": "android_app", "package_name": "YOUR.PACKAGE.NAME", "sha256_cert_fingerprints": ["AA:BB:…"] }
}]
```

Once that file is live the app opens without the browser bar.

## Local development

```
gcloud auth application-default login
GOOGLE_CLOUD_PROJECT=trux-ai npm run dev
npm run check
```

To try the sandbox locally run `cd sandbox && npm install && node server.mjs` and start TruX with `TRUX_SANDBOX_URL=http://localhost:8080`.
