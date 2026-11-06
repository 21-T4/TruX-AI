/* Runs in a Chrome Custom Tab opened by the TruX Android app. Signs in with
   Google, hands the Google ID token to the server under the app's one-time
   state, then returns to the app. See server/routes/native-auth.js. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const state = params.get("state") || "";
  const challenge = params.get("challenge") || "";
  const returnUrl = "truxai://auth?state=" + encodeURIComponent(state);
  const showError = message => { const el = $("naError"); el.textContent = message; el.hidden = false; $("naGoogle").disabled = false; };

  if (!/^[A-Za-z0-9_-]{32,96}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    $("naText").textContent = "Open this page from the TruX app to sign in.";
    $("naGoogle").hidden = true;
    return;
  }

  let auth, provider;
  async function init() {
    const res = await fetch("/api/config", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!data?.firebase?.apiKey) throw new Error("Sign-in is not available right now.");
    firebase.initializeApp(data.firebase);
    auth = firebase.auth();
    auth.useDeviceLanguage();
    provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
  }

  async function finish(result) {
    const googleIdToken = result?.credential?.idToken;
    if (!result?.user || !googleIdToken) throw new Error("Google did not return a sign-in token. Please try again.");
    const token = await result.user.getIdToken();
    const res = await fetch("/api/native-auth/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ state, challenge, googleIdToken })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Could not finish sign-in."); }
    // This tab doesn't need to stay signed in; the app signs in itself.
    auth.signOut().catch(() => {});
    $("naTitle").textContent = "You're signed in";
    $("naText").textContent = "Returning to TruX…";
    $("naGoogle").hidden = true;
    const back = $("naReturn"); back.href = returnUrl; back.hidden = false;
    location.href = returnUrl;
  }

  async function signIn() {
    $("naGoogle").disabled = true;
    $("naError").hidden = true;
    try {
      const result = await auth.signInWithPopup(provider);
      await finish(result);
    } catch (error) {
      if (error?.code === "auth/popup-blocked" || error?.code === "auth/operation-not-supported-in-this-environment") {
        sessionStorage.setItem("trux_native_auth", JSON.stringify({ state, challenge }));
        await auth.signInWithRedirect(provider);
        return;
      }
      if (error?.code === "auth/popup-closed-by-user" || error?.code === "auth/cancelled-popup-request") { $("naGoogle").disabled = false; return; }
      showError(error?.message || "Sign-in failed. Please try again.");
    }
  }

  window.addEventListener("DOMContentLoaded", async () => {
    try {
      await init();
      const redirected = await auth.getRedirectResult().catch(() => null);
      if (redirected?.user) { await finish(redirected); return; }
      $("naGoogle").disabled = false;
      $("naGoogle").addEventListener("click", signIn);
    } catch (error) {
      showError(error?.message || "Sign-in is not available right now.");
    }
  });
})();
