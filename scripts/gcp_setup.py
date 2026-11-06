#!/usr/bin/env python3
"""One-click Google Cloud + Firebase setup for TruX (run by .github/workflows/gcp-setup.yml).

Idempotent: safe to run again any time. It
  1. enables the required APIs,
  2. finds the Cloud Run service and its runtime service account,
  3. grants that account the roles TruX needs,
  4. stores the optional API keys in Secret Manager,
  5. makes sure the storage bucket, Firebase project, web app and Realtime
     Database exist, and uploads database.rules.json,
  6. turns on Email/Password sign-in and adds the authorized domains,
  7. sets the Cloud Run environment variables and runtime flags.

Every step reports what it did to the GitHub job summary.
"""
import json
import os
import subprocess
import sys
import time

import google.auth
import google.auth.transport.requests
from google.oauth2 import service_account

PROJECT = os.environ.get("PROJECT", "").strip()
REGION = os.environ.get("REGION", "").strip()
SERVICE = os.environ.get("SERVICE", "").strip()
APP_DOMAIN = os.environ.get("APP_DOMAIN", "trux-ai-workspace.trux.website").strip()
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "ekagraavn2003@gmail.com").strip()
LIVE_LOCATION = os.environ.get("LIVE_LOCATION", "us-central1").strip()

APIS = [
    "run.googleapis.com", "aiplatform.googleapis.com", "firebase.googleapis.com",
    "firebasedatabase.googleapis.com", "identitytoolkit.googleapis.com", "secretmanager.googleapis.com",
    "iam.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com",
    "fcm.googleapis.com", "fcmregistrations.googleapis.com", "firebaseinstallations.googleapis.com",
    "storage.googleapis.com", "serviceusage.googleapis.com", "cloudresourcemanager.googleapis.com",
    "texttospeech.googleapis.com",
]
ROLES = [
    ("roles/aiplatform.user", "Vertex AI User"),
    ("roles/firebase.viewer", "Firebase Viewer"),
    ("roles/firebasedatabase.admin", "Firebase Realtime Database Admin"),
    ("roles/firebaseauth.admin", "Firebase Authentication Admin"),
    ("roles/storage.objectAdmin", "Storage Object Admin"),
    ("roles/secretmanager.secretAccessor", "Secret Manager Secret Accessor"),
    ("roles/firebasecloudmessaging.admin", "Firebase Cloud Messaging Admin"),
    ("roles/serviceusage.serviceUsageConsumer", "Service Usage Consumer"),
    ("roles/logging.logWriter", "Logs Writer"),
]
SECRETS = ["COMPOSIO_API_KEY", "RESEND_API_KEY", "TRUX_FEEDBACK_FROM_EMAIL", "FCM_VAPID_PUBLIC_KEY"]

summary = []
problems = []


def log(line):
    print(line, flush=True)


def ok(line):
    summary.append("- ✅ " + line)
    log("OK  " + line)


def warn(line):
    summary.append("- ⚠️ " + line)
    problems.append(line)
    log("WARN " + line)


def gcloud(*args, check=True, quiet=False):
    cmd = ["gcloud", *args, "--project", PROJECT, "--quiet"]
    if not quiet:
        log("$ " + " ".join(a if len(a) < 200 else a[:200] + "…" for a in cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    if check and res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res


# ---------- REST helpers (Firebase APIs gcloud doesn't cover) ----------

def credentials(scopes):
    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if path and os.path.exists(path):
        try:
            info = json.load(open(path))
            if info.get("type") == "service_account":
                return service_account.Credentials.from_service_account_info(info, scopes=scopes)
        except Exception:
            pass
    creds, _ = google.auth.default(scopes=scopes)
    return creds


_session = None


def session():
    global _session
    if _session is None:
        creds = credentials(["https://www.googleapis.com/auth/cloud-platform",
                             "https://www.googleapis.com/auth/firebase",
                             "https://www.googleapis.com/auth/firebase.database",
                             "https://www.googleapis.com/auth/userinfo.email"])
        _session = google.auth.transport.requests.AuthorizedSession(creds)
        _session.headers["X-Goog-User-Project"] = PROJECT
    return _session


def api(method, url, body=None, ok_codes=(200,)):
    r = session().request(method, url, json=body, timeout=60)
    if r.status_code not in ok_codes:
        raise RuntimeError(f"{method} {url} -> HTTP {r.status_code}: {r.text[:500]}")
    return r.json() if r.text else {}


def wait_operation(base, op):
    name = op.get("name")
    for _ in range(60):
        if op.get("done"):
            if "error" in op:
                raise RuntimeError(json.dumps(op["error"]))
            return op.get("response", {})
        time.sleep(3)
        op = api("GET", f"{base}/{name}")
    raise RuntimeError("Timed out waiting for " + str(name))


# ---------- Steps ----------

def step_project():
    global PROJECT
    if not PROJECT:
        PROJECT = subprocess.run(["gcloud", "config", "get-value", "project"], capture_output=True, text=True).stdout.strip()
    if not PROJECT:
        raise SystemExit("No project id. Set the PROJECT input.")
    number = gcloud("projects", "describe", PROJECT, "--format=value(projectNumber)").stdout.strip()
    ok(f"Project `{PROJECT}` (number {number})")
    return number


def step_apis():
    try:
        gcloud("services", "enable", *APIS)
        ok("Enabled APIs: " + ", ".join(a.split(".")[0] for a in APIS))
    except Exception as e:
        warn("Could not enable some APIs: " + str(e)[:300])


def step_service(number):
    global SERVICE, REGION
    res = gcloud("run", "services", "list", "--format=json", check=False)
    services = json.loads(res.stdout or "[]") if res.returncode == 0 else []
    if not SERVICE:
        named = [s for s in services if "trux" in s["metadata"]["name"].lower()]
        pick = (named or services or [None])[0]
        if not pick:
            warn("No Cloud Run service found. Deploy TruX first, then run this again.")
            return None
        SERVICE = pick["metadata"]["name"]
        REGION = REGION or pick["metadata"].get("labels", {}).get("cloud.googleapis.com/location", "")
    if not REGION:
        for s in services:
            if s["metadata"]["name"] == SERVICE:
                REGION = s["metadata"].get("labels", {}).get("cloud.googleapis.com/location", "")
    REGION = REGION or "us-central1"
    desc = json.loads(gcloud("run", "services", "describe", SERVICE, "--region", REGION, "--format=json").stdout)
    sa = desc["spec"]["template"]["spec"].get("serviceAccountName") or f"{number}-compute@developer.gserviceaccount.com"
    url = desc.get("status", {}).get("url", "")
    ok(f"Cloud Run service `{SERVICE}` in `{REGION}` runs as `{sa}` ({url})")
    return {"sa": sa, "url": url}


def step_roles(sa):
    policy = json.loads(gcloud("projects", "get-iam-policy", PROJECT, "--format=json").stdout)
    member = "serviceAccount:" + sa
    have = {b["role"] for b in policy.get("bindings", []) if member in b.get("members", []) and not b.get("condition")}
    added = []
    for role, label in ROLES:
        if role in have:
            continue
        try:
            gcloud("projects", "add-iam-policy-binding", PROJECT, "--member", member, "--role", role, "--condition=None", "--format=none")
            added.append(label)
        except Exception as e:
            warn(f"Could not grant {label}: {str(e)[:200]}")
    ok("Roles for the service account: " + (("added " + ", ".join(added)) if added else "all already granted"))


def step_secrets():
    for name in SECRETS:
        value = os.environ.get(name, "")
        exists = gcloud("secrets", "describe", name, "--format=value(name)", check=False, quiet=True).returncode == 0
        if not value.strip():
            summary.append(f"- ➖ `{name}`: " + ("already in Secret Manager (kept)" if exists else "optional, not provided (feature stays off)"))
            continue
        if not exists:
            gcloud("secrets", "create", name, "--replication-policy=automatic", "--format=none")
        p = subprocess.run(["gcloud", "secrets", "versions", "add", name, "--data-file=-", "--project", PROJECT, "--quiet", "--format=none"],
                           input=value.strip(), capture_output=True, text=True)
        if p.returncode != 0:
            warn(f"Could not store `{name}`: {p.stderr.strip()[:200]}")
        else:
            ok(f"Secret `{name}` stored in Secret Manager")


def step_bucket():
    bucket = os.environ.get("BUCKET") or f"{PROJECT}-bucket"
    if gcloud("storage", "buckets", "describe", f"gs://{bucket}", "--format=value(name)", check=False, quiet=True).returncode == 0:
        ok(f"Bucket `{bucket}` exists")
        return bucket
    try:
        gcloud("storage", "buckets", "create", f"gs://{bucket}", "--location", LIVE_LOCATION if LIVE_LOCATION not in ("us", "eu") else "us-central1",
               "--uniform-bucket-level-access", "--public-access-prevention")
        ok(f"Created bucket `{bucket}`")
    except Exception as e:
        warn(f"Could not create bucket `{bucket}`: {str(e)[:200]}")
    return bucket


FB = "https://firebase.googleapis.com/v1beta1"


def step_firebase():
    r = session().get(f"{FB}/projects/{PROJECT}", timeout=60)
    if r.status_code == 200:
        ok("Firebase is enabled on the project")
    else:
        try:
            wait_operation(FB, api("POST", f"{FB}/projects/{PROJECT}:addFirebase", {}))
            ok("Added Firebase to the project")
        except Exception as e:
            warn(f"Firebase project check returned HTTP {r.status_code} and adding Firebase failed: {str(e)[:200]}")

    apps = api("GET", f"{FB}/projects/{PROJECT}/webApps").get("apps", [])
    active = [a for a in apps if a.get("state") == "ACTIVE"] or apps
    if active:
        app = active[0]
        ok(f"Firebase web app `{app.get('displayName', app['appId'])}` ({app['appId']})")
    else:
        app = wait_operation(FB, api("POST", f"{FB}/projects/{PROJECT}/webApps", {"displayName": "TruX Web"}))
        ok(f"Created Firebase web app ({app['appId']})")
    return app["appId"]


RTDB = "https://firebasedatabase.googleapis.com/v1beta"


def step_database():
    instances = api("GET", f"{RTDB}/projects/{PROJECT}/locations/-/instances").get("instances", [])
    default = [i for i in instances if i.get("type") == "DEFAULT_DATABASE"] or instances
    if default:
        db = default[0]
        ok(f"Realtime Database `{db['name'].split('/')[-1]}`")
    else:
        db_id = f"{PROJECT}-default-rtdb"
        db = api("POST", f"{RTDB}/projects/{PROJECT}/locations/us-central1/instances?databaseId={db_id}", {"type": "DEFAULT_DATABASE"})
        ok(f"Created Realtime Database `{db_id}` (us-central1)")
    url = db.get("databaseUrl") or f"https://{PROJECT}-default-rtdb.firebaseio.com"
    try:
        rules = open("database.rules.json").read()
        r = session().put(url.rstrip("/") + "/.settings/rules.json", data=rules.encode(), headers={"Content-Type": "application/json"}, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        ok("Uploaded database.rules.json (private by default, each user can only read their own data)")
    except Exception as e:
        warn("Could not upload database rules: " + str(e)[:300] + ". Paste database.rules.json into Firebase console → Realtime Database → Rules.")
    return url


IDT = "https://identitytoolkit.googleapis.com/admin/v2"


def step_auth(run_url):
    domains = {APP_DOMAIN, f"{PROJECT}.firebaseapp.com", f"{PROJECT}.web.app", "localhost"}
    if run_url:
        domains.add(run_url.split("://", 1)[-1].split("/")[0])
    r = session().get(f"{IDT}/projects/{PROJECT}/config", timeout=60)
    if r.status_code != 200:
        warn("Firebase Authentication isn't initialised. Open Firebase console → Authentication → Get started, then run this again.")
        return
    cfg = r.json()
    current = set(cfg.get("authorizedDomains", []))
    email = cfg.get("signIn", {}).get("email", {})
    body = {"signIn": {"email": {"enabled": True, "passwordRequired": True}}, "authorizedDomains": sorted(current | domains)}
    mask = "signIn.email.enabled,signIn.email.passwordRequired,authorizedDomains"
    if email.get("enabled") and email.get("passwordRequired") and domains <= current:
        ok("Email/Password sign-in already on; authorized domains already set")
    else:
        api("PATCH", f"{IDT}/projects/{PROJECT}/config?updateMask={mask}", body)
        ok("Turned on Email/Password sign-in and added authorized domains: " + ", ".join(sorted(domains - current) or ["(none new)"]))
    g = session().get(f"{IDT}/projects/{PROJECT}/defaultSupportedIdpConfigs/google.com", timeout=60)
    if g.status_code == 200 and g.json().get("enabled"):
        ok("Google sign-in provider is on")
    else:
        warn("Google sign-in provider is off. Firebase console → Authentication → Sign-in method → Add new provider → Google → Enable → Save (Google creates the OAuth client for you).")


def step_cloud_run(env):
    pairs = ",".join(f"{k}={v}" for k, v in env.items() if v)
    try:
        gcloud("run", "services", "update", SERVICE, "--region", REGION, "--update-env-vars", pairs,
               "--no-cpu-throttling", "--timeout=3600", "--session-affinity", "--format=none")
        ok("Cloud Run updated: " + ", ".join(f"`{k}`" for k in env if env[k]) + ", CPU always allocated, 60 min timeout, session affinity")
    except Exception as e:
        warn("Could not update Cloud Run: " + str(e)[:400])


def main():
    number = step_project()
    step_apis()
    svc = step_service(number)
    if svc:
        step_roles(svc["sa"])
    step_secrets()
    bucket = step_bucket()
    app_id = db_url = None
    try:
        app_id = step_firebase()
    except Exception as e:
        warn("Firebase web app step failed: " + str(e)[:300])
    try:
        db_url = step_database()
    except Exception as e:
        warn("Realtime Database step failed: " + str(e)[:300])
    try:
        step_auth(svc["url"] if svc else "")
    except Exception as e:
        warn("Authentication step failed: " + str(e)[:300])
    if svc:
        step_cloud_run({
            "TRUX_LIVE_LOCATION": LIVE_LOCATION,
            "TRUX_BUCKET_NAME": bucket,
            "FIREBASE_WEB_APP_ID": app_id,
            "FIREBASE_DATABASE_URL": db_url,
            "TRUX_OWNER_EMAIL": OWNER_EMAIL,
            "TRUX_VIDEO_MODEL": os.environ.get("VIDEO_MODEL", "veo-3.1-fast-generate-001"),
            "TRUX_LIVE_MODEL": os.environ.get("LIVE_MODEL", "gemini-3.8-live"),
        })
    out = os.environ.get("GITHUB_STEP_SUMMARY")
    text = "## TruX Google Cloud setup\n\n" + "\n".join(summary) + "\n"
    if problems:
        text += "\n### Needs your attention\n\n" + "\n".join("- " + p for p in problems) + "\n"
    if out:
        with open(out, "a") as f:
            f.write(text)
    print("\n" + text)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Setup failed: " + str(e), file=sys.stderr)
        sys.exit(1)
