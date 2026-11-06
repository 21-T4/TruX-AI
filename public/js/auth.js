/* TruX authentication.
 *
 * Firebase Authentication with two providers only: Google and
 * email/password. Password accounts must verify their email before they can
 * chat; the server and the Realtime Database rules enforce the same check, so
 * skipping this UI gains nothing.
 *
 * Speed: the Firebase web config is cached in localStorage, so a returning
 * visitor initialises Firebase without waiting on /api/config, and Firebase
 * restores the session from IndexedDB on its own (no extra persistence call).
 */
let auth = null;
let provider = null;
let rtdb = null;
let firebaseMessaging = null;
let isSigningIn = false;
let truxAuthStateReady = false;
let resolveTruxAuthState = null;
const truxAuthStatePromise = new Promise(resolve => { resolveTruxAuthState = resolve; });
const TRUX_DEVELOPER_EMAIL = "ekagraavn2003@gmail.com";
const TRUX_FIREBASE_CONFIG_KEY = "trux_firebase_config_v2";
let truxLoginView = "signin";
let truxVerifyPoll = null;

function waitForTruxAuthState(timeoutMs = 8000) {
  if (truxAuthStateReady) return Promise.resolve(auth?.currentUser || null);
  return Promise.race([
    truxAuthStatePromise,
    new Promise(resolve => setTimeout(() => resolve(undefined), timeoutMs))
  ]);
}

function isTruxDeveloper(user = auth?.currentUser) {
  return String(user?.email || "").trim().toLowerCase() === TRUX_DEVELOPER_EMAIL && truxUserVerified(user);
}

/* Google accounts arrive verified; password accounts must click the link. */
function truxUserVerified(user = auth?.currentUser) {
  if (!user) return false;
  if (user.emailVerified) return true;
  return (user.providerData || []).some(p => p?.providerId === "google.com");
}

function truxUsesPassword(user = auth?.currentUser) {
  return (user?.providerData || []).some(p => p?.providerId === "password");
}

function applyDeveloperIdentity(user) {
  const owner = isTruxDeveloper(user);
  document.body.classList.toggle("developer-mode", owner);
  const emailEl = getEl("developerEmailText");
  if (emailEl) emailEl.textContent = owner ? TRUX_DEVELOPER_EMAIL : "Developer access available to the authorized account";
  try { updateAllUsageUI(); } catch {}
}

/* Paint the last signed-in identity immediately; Firebase confirms it later. */
function restoreCachedUserUI() {
  try {
    const cached = store.json("trux_cached_user", null);
    if (!cached?.uid) return;
    document.body.classList.add("user-signed-in");
    updateTruxProfileUI(cached);
  } catch {}
}

function cacheUserForNextBoot(user) {
  if (!user) { store.removeItem("trux_cached_user"); return; }
  store.setItem("trux_cached_user", JSON.stringify({
    uid: user.uid, displayName: user.displayName || "", email: user.email || "",
    photoURL: user.photoURL || "", emailVerified: truxUserVerified(user)
  }));
}

async function getTruxIdToken(user = auth?.currentUser, forceRefresh = false) {
  if (!user) return "";
  try { return await user.getIdToken(forceRefresh); }
  catch (error) { console.warn("TruX token refresh failed", error); return ""; }
}

/* Every API call goes through here so the token is attached consistently and
   an expired token is refreshed once before giving up. */
async function truxAuthenticatedFetch(url, options = {}) {
  let user = auth?.currentUser;
  if (!user && !truxAuthStateReady) { await waitForTruxAuthState(); user = auth?.currentUser; }
  if (!user) throw new Error("Please sign in first.");
  const send = async force => {
    const token = await getTruxIdToken(user, force);
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", "Bearer " + token);
    return fetch(url, { ...options, headers, credentials: "same-origin" });
  };
  let response = await send(false);
  if (response.status === 401) response = await send(true);
  return response;
}

function updateTruxProfileUI(user) {
  const signedIn = !!user;
  const name = signedIn ? (user.displayName || String(user.email || "").split("@")[0] || "User") : "Guest User";
  const email = signedIn ? (user.email || "") : "Tap to sign in";
  const setText = (id, value) => { const el = getEl(id); if (el) el.textContent = value; };
  setText("userName", name);
  setText("userEmail", email);
  setText("modalName", name);
  setText("modalEmail", signedIn ? email : "");
  setText("truxAccountEmailText", signedIn ? email : "Not signed in");
  setText("truxAccountVerifiedText", !signedIn ? "-" : (truxUserVerified(user) ? "Verified" : "Not verified"));
  const ids = (user?.providerData || []).map(p => p?.providerId);
  setText("truxAccountMethodText", !signedIn ? "-" :
    [ids.includes("google.com") && "Google", ids.includes("password") && "Email & password"].filter(Boolean).join(" + ") || "Email");
  const nameInput = getEl("truxAccountDisplayName");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = signedIn ? (user.displayName || "") : "";
  const pwRow = getEl("truxAccountPasswordRow");
  if (pwRow) pwRow.hidden = !truxUsesPassword(user);
  try { applyStoredAvatar(user); } catch {}
  const ownerBadge = document.querySelector(".owner-profile-badge");
  if (ownerBadge) ownerBadge.style.display = isTruxDeveloper(user) ? "inline-flex" : "none";
  try {
    if (typeof currentProfileOption !== "undefined" && currentProfileOption === "account" && getEl("profileDetailBody")) {
      const data = profileDetailData("account");
      setText("profileDetailTitle", data.title);
      setText("profileDetailSubtitle", data.subtitle);
      getEl("profileDetailBody").innerHTML = data.html;
    }
  } catch {}
  applyDeveloperIdentity(user);
}

async function refreshTruxProfileInfo(user = auth?.currentUser) {
  if (!user) return;
  try { await user.reload(); } catch {}
  updateTruxProfileUI(auth?.currentUser || user);
}

async function saveTruxDisplayName() {
  const user = auth?.currentUser;
  const input = getEl("truxAccountDisplayName");
  if (!user || !input) return;
  const value = input.value.trim().slice(0, 60);
  try {
    await user.updateProfile({ displayName: value || null });
    cacheUserForNextBoot(user);
    updateTruxProfileUI(user);
    toast("Name updated.", "ok");
  } catch (error) {
    toast(friendlyAuthError(error), "err");
  }
}

/* ---------- Firebase bootstrap ---------- */

async function loadFirebaseConfig() {
  const fresh = fetch("/api/config", { cache: "no-store" })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      const config = data?.firebase;
      if (!config?.apiKey) return null;
      store.setItem(TRUX_FIREBASE_CONFIG_KEY, JSON.stringify(config));
      return config;
    })
    .catch(() => null);
  const cached = store.json(TRUX_FIREBASE_CONFIG_KEY, null);
  if (cached?.apiKey && cached?.databaseURL) return cached;
  const config = await fresh;
  if (!config) throw new Error("Could not load the TruX sign-in configuration.");
  return config;
}

/* The SDK loads with `defer`, so it is ready by DOMContentLoaded at the latest. */
function waitForFirebaseSdk() {
  const ready = () => typeof firebase !== "undefined" && firebase.auth && firebase.database;
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => (ready() ? resolve() : reject(new Error("Firebase SDK failed to load. Check your connection.")));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check, { once: true });
    else window.addEventListener("load", check, { once: true });
  });
}

let initFirebasePromise = null;
function initFirebase() {
  if (!initFirebasePromise) initFirebasePromise = initFirebaseOnce().catch(error => {
    initFirebasePromise = null;
    truxAuthStateReady = true;
    resolveTruxAuthState(null);
    throw error;
  });
  return initFirebasePromise;
}

async function initFirebaseOnce() {
  const [config] = await Promise.all([loadFirebaseConfig(), waitForFirebaseSdk()]);
  if (!firebase.apps.length) firebase.initializeApp(config);
  auth = firebase.auth();
  auth.useDeviceLanguage();
  provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  rtdb = firebase.database();
  try { if (firebase.messaging?.isSupported?.()) firebaseMessaging = firebase.messaging(); } catch {}

  // Complete a redirect sign-in (used where popups are blocked).
  auth.getRedirectResult().catch(error => setLoginAuthMessage(friendlyAuthError(error), "err"));

  auth.onAuthStateChanged(user => {
    const first = !truxAuthStateReady;
    truxAuthStateReady = true;
    cacheUserForNextBoot(user);
    document.body.classList.toggle("user-signed-in", !!user);
    updateTruxProfileUI(user);
    try { updateLocationSettingUI(); updateNotificationSettingsUI(); } catch {}
    if (user && truxUserVerified(user)) { try { maybeAskForLocation(); } catch {} }
    if (user && !truxUserVerified(user)) {
      showLoginView("verify");
      openLoginWall();
    } else if (user) {
      closeLoginWall();
      stopVerifyPoll();
    }
    if (typeof onTruxUserChanged === "function") onTruxUserChanged(user && truxUserVerified(user) ? user : null);
    if (first) resolveTruxAuthState(user || null);
    if (user && truxUserVerified(user)) void syncTruxNotificationsSilently();
  });
}

/* ---------- Login wall ---------- */

function setLoginAuthMessage(message, tone = "info") {
  const el = getEl("loginAuthError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
  el.dataset.tone = tone;
}

function friendlyAuthError(error) {
  const code = String(error?.code || "");
  const map = {
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/email-already-in-use": "An account already exists for this email. Sign in instead.",
    "auth/weak-password": "Use at least 8 characters with letters and numbers.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/cancelled-popup-request": "Sign-in was cancelled.",
    "auth/account-exists-with-different-credential": "This email already uses another sign-in method.",
    "auth/requires-recent-login": "Please sign in again to do that.",
    "auth/unauthorized-domain": "This domain is not authorised in Firebase Authentication."
  };
  return map[code] || error?.message || "Something went wrong. Try again.";
}

function showLoginView(view) {
  truxLoginView = ["signin", "signup", "reset", "verify"].includes(view) ? view : "signin";
  const wall = getEl("loginWallModal");
  if (wall) wall.dataset.view = truxLoginView;
  const titles = {
    signin: ["Welcome back", "Sign in to chat and sync your workspace."],
    signup: ["Create your account", "Start with Google or an email and password."],
    reset: ["Reset password", "We'll email you a link to choose a new password."],
    verify: ["Verify your email", "Open the link we sent to finish setting up your account."]
  };
  const [title, sub] = titles[truxLoginView];
  const t = getEl("loginTitle"); if (t) t.textContent = title;
  const s = getEl("loginSubtitle"); if (s) s.textContent = sub;
  const submit = getEl("loginEmailSubmit");
  if (submit) submit.textContent = truxLoginView === "signup" ? "Create account" : truxLoginView === "reset" ? "Send reset link" : "Sign in";
  const pw = getEl("loginPassword");
  if (pw) {
    pw.required = truxLoginView === "signin" || truxLoginView === "signup";
    pw.autocomplete = truxLoginView === "signup" ? "new-password" : "current-password";
    pw.minLength = truxLoginView === "signup" ? 8 : 6;
  }
  const name = getEl("loginName"); if (name) name.required = false;
  const verifyEmail = getEl("loginVerifyEmail");
  if (verifyEmail) verifyEmail.textContent = auth?.currentUser?.email || "your inbox";
  setLoginAuthMessage("");
  if (truxLoginView === "verify") startVerifyPoll(); else stopVerifyPoll();
}

function openLoginWall(view) {
  const wall = getEl("loginWallModal");
  if (!wall) return;
  if (view) showLoginView(view);
  else if (!wall.dataset.view) showLoginView("signin");
  wall.classList.add("active");
  wall.setAttribute("aria-hidden", "false");
  document.body.classList.add("login-wall-open");
  setTimeout(() => {
    const focusTarget = truxLoginView === "verify" ? getEl("loginVerifyCheckBtn") : getEl("loginEmail");
    try { focusTarget?.focus({ preventScroll: true }); } catch {}
  }, 60);
}

function closeLoginWall() {
  // An unverified password account cannot dismiss the verification step.
  if (auth?.currentUser && !truxUserVerified(auth.currentUser)) return;
  const wall = getEl("loginWallModal");
  if (!wall) return;
  wall.classList.remove("active");
  wall.setAttribute("aria-hidden", "true");
  document.body.classList.remove("login-wall-open");
  setLoginAuthMessage("");
}

function setLoginBusy(busy) {
  isSigningIn = busy;
  ["loginEmailSubmit", "loginGoogleBtn"].forEach(id => { const el = getEl(id); if (el) el.disabled = busy; });
  getEl("loginWallModal")?.classList.toggle("busy", busy);
}

async function handleGoogleLogin() {
  if (isSigningIn) return;
  try { await initFirebase(); } catch (error) { setLoginAuthMessage(error.message, "err"); return; }
  setLoginBusy(true);
  setLoginAuthMessage("");
  try {
    await auth.signInWithPopup(provider);
  } catch (error) {
    if (error?.code === "auth/popup-blocked" || error?.code === "auth/operation-not-supported-in-this-environment") {
      await auth.signInWithRedirect(provider);
      return;
    }
    setLoginAuthMessage(friendlyAuthError(error), "err");
  } finally {
    setLoginBusy(false);
  }
}

function strongEnoughPassword(value) {
  return value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

async function handleEmailPasswordAuth(event, switchToSignup) {
  event?.preventDefault?.();
  if (switchToSignup === true) { showLoginView("signup"); return; }
  if (isSigningIn) return;
  try { await initFirebase(); } catch (error) { setLoginAuthMessage(error.message, "err"); return; }
  const email = String(getEl("loginEmail")?.value || "").trim();
  const password = String(getEl("loginPassword")?.value || "");
  if (!email) { setLoginAuthMessage("Enter your email address.", "err"); return; }
  if (truxLoginView === "reset") { await handlePasswordReset(); return; }
  if (!password) { setLoginAuthMessage("Enter your password.", "err"); return; }
  setLoginBusy(true);
  setLoginAuthMessage("");
  try {
    if (truxLoginView === "signup") {
      if (!strongEnoughPassword(password)) { setLoginAuthMessage("Use at least 8 characters with letters and numbers.", "err"); return; }
      const name = String(getEl("loginName")?.value || "").trim().slice(0, 60);
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      if (name) await cred.user.updateProfile({ displayName: name }).catch(() => {});
      await cred.user.sendEmailVerification({ url: location.origin + "/" }).catch(() => {});
      showLoginView("verify");
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
    const pw = getEl("loginPassword"); if (pw) pw.value = "";
  } catch (error) {
    setLoginAuthMessage(friendlyAuthError(error), "err");
  } finally {
    setLoginBusy(false);
  }
}

async function handlePasswordReset() {
  try { await initFirebase(); } catch (error) { setLoginAuthMessage(error.message, "err"); return; }
  const email = String(getEl("loginEmail")?.value || auth?.currentUser?.email || "").trim();
  if (truxLoginView !== "reset" && !email) { showLoginView("reset"); return; }
  if (!email) { setLoginAuthMessage("Enter your email address.", "err"); return; }
  try {
    await auth.sendPasswordResetEmail(email, { url: location.origin + "/" });
  } catch (error) {
    if (error?.code !== "auth/user-not-found") { setLoginAuthMessage(friendlyAuthError(error), "err"); return; }
  }
  // Same message either way so the form never reveals which emails exist.
  setLoginAuthMessage("If an account exists for that email, a reset link is on its way.", "ok");
  if (getEl("profileModal")?.style.display === "flex") toast("Password reset email sent.", "ok");
}

async function resendVerificationEmail() {
  const user = auth?.currentUser;
  if (!user) return showLoginView("signin");
  try {
    await user.sendEmailVerification({ url: location.origin + "/" });
    setLoginAuthMessage("Verification email sent. Check your inbox and spam folder.", "ok");
  } catch (error) {
    setLoginAuthMessage(friendlyAuthError(error), "err");
  }
}

async function checkEmailVerified(silent = false) {
  const user = auth?.currentUser;
  if (!user) return false;
  try { await user.reload(); } catch {}
  const fresh = auth.currentUser;
  if (fresh && truxUserVerified(fresh)) {
    // Refresh the ID token so the email_verified claim reaches the server and RTDB rules.
    await getTruxIdToken(fresh, true);
    stopVerifyPoll();
    cacheUserForNextBoot(fresh);
    updateTruxProfileUI(fresh);
    closeLoginWall();
    if (typeof onTruxUserChanged === "function") onTruxUserChanged(fresh);
    void syncTruxNotificationsSilently();
    toast("Email verified. Welcome to TruX.", "ok");
    return true;
  }
  if (!silent) setLoginAuthMessage("Not verified yet. Open the link in the email, then try again.", "err");
  return false;
}

function startVerifyPoll() {
  stopVerifyPoll();
  truxVerifyPoll = setInterval(() => { if (!document.hidden) void checkEmailVerified(true); }, 5000);
}
function stopVerifyPoll() { if (truxVerifyPoll) clearInterval(truxVerifyPoll); truxVerifyPoll = null; }

async function truxSignOut() {
  stopVerifyPoll();
  try { if (typeof onTruxUserChanged === "function") onTruxUserChanged(null); } catch {}
  try { await auth?.signOut(); } catch {}
  cacheUserForNextBoot(null);
  showLoginView("signin");
}

function toggleLoginPasswordVisibility() {
  const input = getEl("loginPassword");
  const btn = getEl("loginPasswordToggle");
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  if (btn) { btn.textContent = show ? "Hide" : "Show"; btn.setAttribute("aria-pressed", String(show)); }
}

/* ---------- Push notifications (finished-reply alerts) ---------- */

async function getPushRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.getRegistration("/") || navigator.serviceWorker.ready;
}

async function registerTruxPushToken() {
  if (!firebaseMessaging || Notification.permission !== "granted") return false;
  const cfg = await truxAuthenticatedFetch("/api/push/config").then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!cfg?.vapidKey) return false;
  const registration = await getPushRegistration();
  if (!registration) return false;
  const token = await firebaseMessaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: registration }).catch(() => "");
  if (!token) return false;
  const res = await truxAuthenticatedFetch("/api/push/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token })
  }).catch(() => null);
  return !!res?.ok;
}

async function syncTruxNotificationsSilently() {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    await registerTruxPushToken();
  } catch {}
}

async function enableTruxNotifications() {
  if (typeof Notification === "undefined") { toast("Notifications are not supported in this browser.", "err"); return false; }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") { toast("Notifications are blocked for this site.", "err"); return false; }
  const ok = await registerTruxPushToken();
  toast(ok ? "Notifications enabled." : "Notifications are not configured on the server yet.", ok ? "ok" : "err");
  return ok;
}
