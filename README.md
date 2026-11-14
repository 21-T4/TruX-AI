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
  css/              styles; tokens.css holds every colour token (Light and Dark), claude.css is the Claude-style look and loads last
  js/               one file per feature, loaded in order at the bottom of index.html
  assetlinks.json   Digital Asset Links for the Play Store app (served at /.well-known/assetlinks.json)
database.rules.json Realtime Database security rules
```

## Models

| Feature | Model |
| --- | --- |
| Light and moderately complex chat | `gemini-4-hydrogen` |
| Complex, multi-step and deep-research chat | `gemini-4-argon` |
| Video shot planning | `gemini-4-argon` |
| Images (in normal chat) | `gemini-3-pro-image` (Nano Banana Pro) |
| Video shots | `veo-3.1-generate-001` (1080p, with sound) |
| Longer cuts and video edits | `gemini-omni-1.2-flash` |
| Speech / Live voice | `gemini-3.8-flash-tts` / `gemini-3.8-live` (different modalities, unchanged) |

### Auto routing

`routeModel()` in `server/lib/vertex.js` scores every chat request on independent signals (hard-topic terms, code size and stack traces, "build an app/system" briefs, maths or proofs, request length, many-part lists, several questions, many attachments, max-thinking). A score of 4 or more goes to Argon, everything else to Hydrogen; deep research always uses Argon. Hydrogen thinks at the lowest level for plain chat and a medium amount for slightly complex asks (the Gemini 4 models reject `thinkingBudget`, so only `thinkingLevel` is ever sent); Argon never thinks less than medium. During an agent run Hydrogen is handed to Argon after three tool rounds or a failed tool. Small helpers (chat titles, home-screen copy) use Hydrogen. Set `TRUX_LOG_ROUTING=1` to log each decision with its reasons. The owner-only model picker still overrides routing.

Video lengths: 8 s (one Veo shot), 18 s and 28 s (Veo opening shot, then Gemini Omni extensions).

## Configuration

No `.env` file and no environment variables. The project ID comes from Cloud Run, the Firebase web config, database and bucket (`<project>-bucket`) are discovered from the project, Vertex AI uses `location=global`, and Live uses `us-central1` (the Live API has no global endpoint). Feedback mail goes to ekagraavn2003@gmail.com from `onboarding@resend.dev`.

Firebase web config: discovered from the project, with the public values of the shared `trux-ai` project (the same ones TruX Code uses) built in as a fallback, so sign-in and the Realtime Database keep working if the lookup fails. `FIREBASE_*` environment variables (including `FIREBASE_DATABASE_URL` for a regional database) override any value. At startup the log says whether the Realtime Database is reachable and whether the deployed rules match `database.rules.json`; the server now publishes the rules itself when they differ (set `TRUX_SYNC_DB_RULES=0` to only report). If the browser is still refused, chats, personalization and memories fall back to the server (`/api/data/*`, Admin SDK), which is how TruX Code works. Outdated rules are the usual cause of "chat history is locked".

Optional Secret Manager secrets: `COMPOSIO_API_KEY` (plugins), `RESEND_API_KEY` (feedback email), `FCM_VAPID_PUBLIC_KEY` (web push), `TRUX_SESSION_KEY` (see below).

## Sign-in tokens

Google and email/password accounts get in as soon as Firebase signs them in; there is no email-verification step. After every new sign-in the browser sends its fresh Firebase ID token to `POST /api/session/login`. The server verifies it, encrypts it (AES-256-GCM, a key derived per user and per sign-in) and stores only the sealed text at `_server/sessions/{uid}/{sessionId}`, a path the database rules close to clients. `POST /api/session/verify` opens it again in memory and checks it still belongs to the caller; signing out clears the records. Set `TRUX_SESSION_KEY` (`openssl rand -base64 32 | gcloud secrets create TRUX_SESSION_KEY --data-file=-`). Without it the server generates a key on first use and keeps it in the database, which still encrypts the tokens but is weaker.

## Memory

Like TruX Code, the model decides what to remember and saves short notes with a topic, kind and importance (`users/{uid}/memories`). Secrets are refused, near-duplicates update the existing note, the store is capped at 200, and each turn only sees notes about the topic of the question plus standing instructions.

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

## Background answers

Answers keep generating on the server after the app is closed or backgrounded. The reply is stored as it is written, the app follows it again when it is reopened (or the network returns), and a push notification is sent when it finishes. If you host on Cloud Run, deploy with CPU always allocated (`--no-cpu-throttling`) so the instance keeps working after the client disconnects.

## Answer streaming and Stop

Text appears the way modern chat apps show it: each newly revealed run of words fades in to a soft grey and then glides up to full colour, so only the newest ~5 lines look dull (the fade length adapts to how fast the text arrives) and everything above them is already normal text. Only the text itself is dimmed; there is no overlay on the page. The app does not switch its motion off wholesale when the phone reports "reduce motion" (phones set it with battery saver); only endless decorative loops are calmed. The renderer (`createStreamRenderer` in `public/js/messages.js`) reveals words every frame at a quick reading pace (about 95–320 words a second, faster when a backlog builds; slow devices step a little less often), eases the scroll position instead of jumping, and keeps going after the server says "done" so a long answer is never dumped at once. The `.rv` keyframes live in `public/css/chat.css`; `messages.js` sets each run's duration inline.

The send button turns into a Stop button while an answer is being generated and also while an already-received answer is still being revealed. Stopping keeps exactly the text that was shown, marks the message as stopped and re-enables the composer.

## Chats and deleting

Deleting a chat (or "Remove all chats") only hides it: the chat is flagged `deleted`/`deletedAt` in the Realtime Database and the server ignores requests that would wipe message history. Nothing is lost from the database by a delete in the UI.

## Front end notes

- Scripts are classic scripts sharing globals; the order in `index.html` matters.
- Font: Google Sans (with Google Sans Flex / Code) via the font tokens in `tokens.css`.
- On phones the model picker and the message menu open as bottom sheets (`sheets.js`) that can be dismissed by swiping down. `--app-h` follows the visual viewport so the keyboard does not resize the page.
- Bump `CACHE_NAME` in `public/sw.js` whenever front-end files change so installed apps pick up the update.
- Final audit: dead CSS rules, references to removed UI elements (profile summary fields, chat help modal), unused helpers and duplicate code were removed. Lint is clean apart from three guarded `typeof` references that are defined at runtime by `plugins.js`/`live.js`.

## Motion

- All transitions use the shared tokens in `tokens.css` (`--ease`, `--ease-out`, `--dur-1/2/3` = 160 / 260 / 420 ms). A zero-specificity baseline rule gives buttons, links and inputs the same colour/shadow/press easing.
- Overlays fade and scale out as well as in: use `showOverlay` / `hideOverlay` (inline `display`) or `setOverlayActive` (`.active` class) from `core.js` instead of toggling `display` directly.
- Circle to Search (`circle-search.js`, `circle.css`) draws through one eased animation loop (stroke, dim, corner brackets and selection box all glide) with soft colours; only transform/opacity animate in CSS.
- Live (`live.js`, `live.css`) is a dark, calm screen (near-black with champagne / dusty-rose accents, no blue): a voice-reactive orb in the middle (your voice swells it softly, TruX's voice warms the glow), a slim top bar with a live-status dot and a floating glass control dock. It fades in and out, staggers its sections, cross-fades status text and drives the orb from smoothed `--trux-live-in` / `--trux-live-out` levels: the orb's own circumference ripples in smooth cool-blue waves while you speak, and orange lines radiate out of it while TruX speaks (one canvas, `drawAura` in `live.js`; there is only one circle). The "Hey TruX" wake-word feature was removed.
