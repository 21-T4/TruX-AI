
    const getEl = (id) => document.getElementById(id);

    /* ---------- toasts ----------
       Replaces the blocking window dialogs, which froze the page and looked
       nothing like the rest of the app. */
    function toast(msg, kind) {
      let host = getEl("toastHost");
      if(!host) return;
      let t = document.createElement("div");
      t.className = "toast" + (kind ? " " + kind : "");
      t.innerHTML = '<i></i><span></span>';
      t.querySelector("span").textContent = String(msg);
      host.appendChild(t);
      let life = Math.min(7000, 2600 + String(msg).length * 28);
      setTimeout(() => {
        t.classList.add("out");
        setTimeout(() => t.remove(), 300);
      }, life);
      while(host.children.length > 3) host.firstElementChild.remove();
    }

    /* iOS Safari honours neither user-scalable=no nor maximum-scale, so pinch
       and double-tap zoom are cancelled by hand. Wheel+ctrl (trackpad pinch on
       desktop) is blocked too, which is what a native app shell feels like. */
    ["gesturestart", "gesturechange", "gestureend"].forEach(function(t) {
      document.addEventListener(t, function(e) { e.preventDefault(); }, { passive: false });
    });
    document.addEventListener("touchmove", function(e) {
      if(e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    document.addEventListener("wheel", function(e) {
      if(e.ctrlKey) e.preventDefault();
    }, { passive: false });
    let lastTouchEnd = 0;
    document.addEventListener("touchend", function(e) {
      let now = Date.now();
      /* Controls keep their native double-tap behaviour (touch-action:
         manipulation already kills zoom there) so fast repeat taps still work. */
      let interactive = e.target.closest && e.target.closest("button, a, input, textarea, select, label, [contenteditable]");
      if(!interactive && now - lastTouchEnd <= 320) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    addEventListener("load", () => { try { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=20261015-2", { updateViaCache: "none" }).catch(() => {}); } catch (e) {} });
    // Suppress the browser's PWA-install prompt: the sidebar download control now
    // downloads the native Android APK instead.
    addEventListener("beforeinstallprompt", event => event.preventDefault());
    function downloadTruXAndroidApk() {
      window.location.href = "https://trux-ai-workspace.trux.website/TruX-Omni-Android.apk";
    }

    /* ============ Auth: sign-in wall only shown on demand ============ */
    let auth = null, provider = null, isSigningIn = false, firebaseMessaging = null, pushMessageBound = false;
    let truxAuthStateReady = false;
    let resolveTruxAuthStateReady;
    const TRUX_AUTH_NOT_READY = {};
    const truxAuthStateReadyPromise = new Promise(resolve => { resolveTruxAuthStateReady = resolve; });
    function markTruxAuthStateReady(user) {
      if (truxAuthStateReady) return;
      truxAuthStateReady = true;
      resolveTruxAuthStateReady(user || null);
    }
    async function waitForTruxAuthState(timeoutMs = 6500) {
      if (truxAuthStateReady) return auth?.currentUser || null;
      let timeoutId;
      const result = await Promise.race([
        truxAuthStateReadyPromise,
        new Promise(resolve => { timeoutId = setTimeout(() => resolve(TRUX_AUTH_NOT_READY), timeoutMs); })
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (result === TRUX_AUTH_NOT_READY && !truxAuthStateReady) return undefined;
      return auth?.currentUser || result || null;
    }
    function setLoginAuthMessage(message, isError = true) {
      const node = getEl("loginAuthError");
      if (!node) return;
      node.textContent = String(message || "");
      node.hidden = !message;
      node.style.borderColor = isError ? "rgba(255,110,110,.28)" : "rgba(125,220,165,.28)";
      node.style.color = isError ? "#ffb5b5" : "#b7f3ca";
    }
    const TRUX_DEVELOPER_EMAIL = "ekagraavn2003@gmail.com";
    function isTruxDeveloper(user) {
      return !!user && String(user.email || "").trim().toLowerCase() === TRUX_DEVELOPER_EMAIL;
    }
    function applyDeveloperIdentity(user) {
      const owner = isTruxDeveloper(user);
      document.body.classList.toggle("developer-mode", owner);
      const emailEl = getEl("developerEmailText");
      if (emailEl) emailEl.textContent = owner ? TRUX_DEVELOPER_EMAIL : "Developer access available to the authorized account";
      updateAllUsageUI();
    }


    function restoreCachedUserUI() {
      try {
        const cached = store.json("trux_cached_user", null);
        if (cached && cached.email) {
          if (getEl("userName")) getEl("userName").innerText = cached.displayName || "User";
          if (getEl("userEmail")) getEl("userEmail").innerText = cached.email || "";
          applyStoredAvatar(cached);
          document.body.classList.add("user-signed-in");
        }
      } catch (e) {}
    }
    restoreCachedUserUI();

    async function getTruxIdToken(user, forceRefresh = false) {
      const target = user || auth?.currentUser;
      if (!target) throw new Error("Sign in to continue.");
      const token = await target.getIdToken(!!forceRefresh);
      if (!token) throw new Error("Could not obtain your sign-in token. Please sign in again.");
      if (auth?.currentUser && auth.currentUser.uid !== target.uid) {
        throw new Error("Your account changed. Please retry the request.");
      }
      return token;
    }

    async function truxAuthenticatedFetch(input, init = {}, userOverride = null) {
      const requestUser = userOverride || auth?.currentUser;
      if (!requestUser) throw new Error("Sign in to continue.");
      const makeInit = async forceRefresh => {
        const headers = new Headers(init.headers || {});
        headers.set("Authorization", "Bearer " + await getTruxIdToken(requestUser, forceRefresh));
        return { ...init, headers };
      };
      let response = await fetch(input, await makeInit(false));
      if (response.status === 401 && auth?.currentUser?.uid === requestUser.uid) {
        response = await fetch(input, await makeInit(true));
      }
      return response;
    }

    function updateTruxProfileUI(user) {
      const signedIn = !!user;
      const fallbackAvatar = "https://ui-avatars.com/api/?name=Guest+User&background=111111&color=fff";
      if (!signedIn) {
        const nameEl = getEl("userName"); if (nameEl) nameEl.textContent = "Guest User";
        const emailEl = getEl("userEmail"); if (emailEl) emailEl.textContent = "Tap to sign in";
        ["userAvatar", "modalAvatar", "topProfileAvatar"].forEach(id => { const el = getEl(id); if (el) el.src = fallbackAvatar; });
        const modalName = getEl("modalName"); if (modalName) modalName.textContent = "Guest User";
        const modalEmail = getEl("modalEmail"); if (modalEmail) modalEmail.textContent = "";
        try { store.removeItem("trux_cached_user"); } catch {}
        return;
      }
      const cached = {
        uid: user.uid,
        email: user.email || "",
        displayName: user.displayName || "",
        photoURL: user.photoURL || ""
      };
      try { store.setItem("trux_cached_user", JSON.stringify(cached)); } catch {}
      const nameEl = getEl("userName"); if (nameEl) nameEl.textContent = cached.displayName || "User";
      const emailEl = getEl("userEmail"); if (emailEl) emailEl.textContent = cached.email;
      const modalName = getEl("modalName"); if (modalName) modalName.textContent = cached.displayName || "User";
      const modalEmail = getEl("modalEmail"); if (modalEmail) modalEmail.textContent = cached.email;
      applyStoredAvatar(user);
      const ownerBadge = document.querySelector(".owner-profile-badge");
      if (ownerBadge) ownerBadge.style.display = isTruxDeveloper(user) ? "inline-flex" : "none";
      if (currentProfileOption === "account" && getEl("profileDetailBody")) {
        const data = profileDetailData("account");
        if (getEl("profileDetailTitle")) getEl("profileDetailTitle").textContent = data.title;
        if (getEl("profileDetailSubtitle")) getEl("profileDetailSubtitle").textContent = data.subtitle;
        getEl("profileDetailBody").innerHTML = data.html;
      }
    }

    function refreshTruxProfileInfo(user = auth?.currentUser) {
      // Firebase Auth already supplies immediate profile fields; auth changes refresh this UI.
      updateTruxProfileUI(user || null);
    }

    async function initFirebase() {
      const fallback = { apiKey: "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q", authDomain: "trux-ai.firebaseapp.com", projectId: "trux-ai", storageBucket: "trux-ai.firebasestorage.app", messagingSenderId: "59313097411", appId: "1:59313097411:web:32e4158bfb733fa7cfb076" };
      try {
        const response = await fetch("/api/firebase-config", { cache: "no-store" });
        if (!response.ok) throw new Error("Firebase config endpoint returned " + response.status);
        const config = await response.json();
        if (!config || !config.apiKey || !config.projectId || !config.authDomain) throw new Error("Firebase configuration is incomplete");
        firebase.initializeApp(config);
      } catch (error) {
        console.warn("Using configured Firebase fallback:", error?.message || error);
        firebase.initializeApp(fallback);
      }
      auth = firebase.auth();
      provider = new firebase.auth.GoogleAuthProvider();
      try {
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      } catch (e) {
        console.warn("Auth persistence error:", e);
      }


      try {
        firebaseMessaging = firebase.messaging();
        /* Foreground stays silent. Background completion notifications are
           rendered by public/sw.js as full OS notifications. */
        if(!pushMessageBound) {
          firebaseMessaging.onMessage(() => {});
          pushMessageBound = true;
        }
      } catch {}
      
      auth.onAuthStateChanged(u => {
        markTruxAuthStateReady(u);
        applyDeveloperIdentity(u);
        updateTruxProfileUI(u);
        if(u) {
          void refreshTruxProfileInfo(u);
          store.setItem("trux_cached_user", JSON.stringify({
            uid: u.uid,
            email: u.email,
            displayName: u.displayName,
            photoURL: u.photoURL
          }));
          document.body.classList.add("user-signed-in");
          if (getEl("userName")) getEl("userName").innerText = u.displayName || "User";
          if (getEl("userEmail")) getEl("userEmail").innerText = u.email || "";
          applyStoredAvatar(u);
          closeLoginWall();
          updateNotificationButton();
          updateLocationSettingUI();
          updateNotificationSettingsUI();
          maybeAskForLocation();
          if("Notification" in window && Notification.permission === "granted") syncTruxNotificationsSilently();
          updateCloudChatStatus("loading");
          void loadChatsFromCloud(u);
        } else {
          clearTimeout(cloudChatRetryTimer);
          cloudChatRetryTimer = null;
          cloudChatRetryDelayMs = 1500;
          cloudChatLoadGeneration += 1;
          cloudChatsReady = false;
          cloudChatsOwnerUid = null;
          cloudChatLoadState = "signed-out";
          cloudChatStatusMessage = "";
          updateCloudChatStatus("signed-out");
          chatSessions = {};
          cloudChatSyncedFingerprints.clear();
          pendingDeletedCloudChatIds.clear();
          clearTimeout(cloudChatSyncTimer);
          currentChatId = null;
          getEl("chatContainer")?.replaceChildren();
          getEl("codeChatContainer")?.replaceChildren();
          getEl("welcomeScreen")?.style.setProperty("display", "block", "important");
          document.body.classList.remove("chat-session-active", "coding-workspace");
          document.body.classList.add("home-active");
          renderSidebar();
          store.removeItem("trux_cached_user");
          document.body.classList.remove("user-signed-in");
          if (getEl("userName")) getEl("userName").innerText = "Guest User";
          if (getEl("userEmail")) getEl("userEmail").innerText = "Tap to sign in";
          if (getEl("userAvatar")) getEl("userAvatar").src = "https://ui-avatars.com/api/?name=Guest+User&background=111111&color=fff";
          if (getEl("topProfileAvatar")) getEl("topProfileAvatar").src = "https://ui-avatars.com/api/?name=Guest+User&background=111111&color=fff";
        }
      });
      if (typeof auth.onIdTokenChanged === "function") {
        auth.onIdTokenChanged(user => {
          if (user && auth?.currentUser?.uid === user.uid) updateTruxProfileUI(user);
        });
      }
    }


    function updateNotificationButton() {
      const buttons = [];
      const enabled = "Notification" in window && Notification.permission === "granted";
      buttons.forEach(b => {
        b.textContent = enabled ? "Notifications on" : "Enable notifications";
        if(b.id === "notifyBtn") {
          b.innerHTML = enabled
            ? '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Z"/><path d="M10 21h4"/></svg>';
        }
      });
    }

    async function syncTruxNotificationsSilently() {
      try {
        if(!auth?.currentUser || !("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator) || !firebaseMessaging) return;
        const registration = await navigator.serviceWorker.ready;
        const cfg = await fetch("/api/push/config",{cache:"no-store"}).then(r=>r.json()).catch(()=>({}));
        const options = { serviceWorkerRegistration: registration };
        if(cfg?.vapidKey) options.vapidKey = cfg.vapidKey;
        const token = await firebaseMessaging.getToken(options);
        if(!token) return;
        await truxAuthenticatedFetch("/api/push/register",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          credentials:"same-origin",
          body:JSON.stringify({userId:auth.currentUser.uid,token})
        }, auth.currentUser);
        updateNotificationButton();
      } catch {}
    }

    async function enableTruxNotifications() {
      if(!auth?.currentUser) return openLoginWall();
      if(!("Notification" in window) || !("serviceWorker" in navigator)) return toast("This device/browser does not support response notifications.","err");
      try {
        const permission = await Notification.requestPermission();
        if(permission !== "granted") return toast("Notifications are not enabled.","err");
        if(!firebaseMessaging) firebaseMessaging = firebase.messaging();
        await navigator.serviceWorker.ready;
        await syncTruxNotificationsSilently();
        toast("Response notifications enabled.","ok");
      } catch(e) {
        toast("Notifications could not be enabled: " + (e?.message || "unknown error"),"err");
      }
    }

    function openLoginWall() { getEl("loginWallModal").classList.add("active"); }
    function closeLoginWall() { getEl("loginWallModal").classList.remove("active"); }

    const TRUX_ANDROID_APK_URL = "https://trux-ai-workspace.trux.website/TruX-Omni-Android.apk";
    const TRUX_ANDROID_BUILD_URL = "https://github.com/21-T4/TruX-AI/actions/workflows/build-android.yml";

    function closeAndroidCompanionInstallDialog() {
      getEl("androidCompanionInstallModal")?.classList.remove("active");
    }

    function showAndroidCompanionInstallDialog() {
      let modal = getEl("androidCompanionInstallModal");
      if (!modal) {
        modal = document.createElement("div");
        modal.className = "modal";
        modal.id = "androidCompanionInstallModal";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-labelledby", "androidCompanionInstallTitle");
        modal.innerHTML = `
          <div class="card" style="width:min(540px,100%);max-height:84vh;overflow:auto;text-align:left">
            <button class="close" type="button" onclick="closeAndroidCompanionInstallDialog()" aria-label="Close">×</button>
            <div class="mtitle" id="androidCompanionInstallTitle">Enable TruX Live on Android</div>
            <div class="msub">A browser tab cannot keep sharing your whole screen after it is minimized. Install the native companion once; Android will then ask for screen-sharing permission whenever Live starts.</div>
            <div style="display:grid;gap:11px;margin-top:18px;font-size:13px;line-height:1.55;color:var(--txt-2)">
              <div><b style="color:var(--txt)">1. Download and install</b><br>Download the APK below and open it on your Android phone. Approve Android's installer prompt if asked.</div>
              <div><b style="color:var(--txt)">2. Sign in</b><br>Open TruX-Omni and sign in to your usual account in your browser.</div>
              <div><b style="color:var(--txt)">3. Start Live again</b><br>Tap Live and approve the microphone and screen-sharing prompts. Android's persistent notification lets you stop sharing at any time.</div>
              <div style="font-size:12px;color:var(--txt-3)">To make TruX your system assistant, install the companion first, then choose <b>Set TruX as Android assistant</b> from the three-dot menu and confirm it in Android's system dialog.</div>
            </div>
            <a class="mbtn" href="${TRUX_ANDROID_APK_URL}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;justify-content:center;text-decoration:none;width:100%;margin-top:20px">Download Android companion APK</a>
            <a href="${TRUX_ANDROID_BUILD_URL}" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:12px;text-align:center;color:var(--txt-3);font-size:12px;text-decoration:underline">Build status / backup download</a>
            <button class="mbtn" type="button" onclick="closeAndroidCompanionInstallDialog()" style="width:100%;margin-top:10px">Not now</button>
          </div>`;
        modal.addEventListener("click", event => {
          if (event.target === modal) closeAndroidCompanionInstallDialog();
        });
        document.body.appendChild(modal);
      }
      modal.classList.add("active");
      modal.querySelector(".close")?.focus();
    }

    try {
      const currentUrl = new URL(location.href);
      if (currentUrl.searchParams.get("truxNativeMissing") === "1") {
        currentUrl.searchParams.delete("truxNativeMissing");
        history.replaceState(history.state, "", currentUrl.toString());
        setTimeout(showAndroidCompanionInstallDialog, 350);
      }
    } catch {}

    function handleGoogleLogin() {
      if (!auth || isSigningIn) { setLoginAuthMessage("Sign-in is still initializing. Please try again."); return; }
      isSigningIn = true; setLoginAuthMessage("");
      const button = getEl("loginGoogleBtn"); if (button) button.disabled = true;
      auth.signInWithPopup(provider)
        .then(() => { setLoginAuthMessage(""); closeLoginWall(); })
        .catch(error => {
          const code = String(error?.code || "");
          if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") setLoginAuthMessage("Sign-in was cancelled.", false);
          else if (code === "auth/unauthorized-domain") setLoginAuthMessage("This app domain is not authorized in Firebase Authentication.");
          else setLoginAuthMessage("Google sign-in failed. Please try again or use email and password.");
        })
        .finally(() => { isSigningIn = false; if (button) button.disabled = false; });
    }

    async function handleEmailPasswordAuth(event, createAccount = false) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (!auth || isSigningIn) { setLoginAuthMessage("Sign-in is still initializing. Please try again."); return; }
      const email = String(getEl("loginEmail")?.value || "").trim();
      const password = String(getEl("loginPassword")?.value || "");
      if (!email || !password) { setLoginAuthMessage("Enter your email and password."); return; }
      if (createAccount && password.length < 6) { setLoginAuthMessage("Choose a password with at least 6 characters."); return; }
      isSigningIn = true; setLoginAuthMessage("");
      const controls = Array.from(getEl("loginEmailForm")?.querySelectorAll("button,input") || []);
      const googleButton = getEl("loginGoogleBtn");
      controls.forEach(control => { control.disabled = true; });
      if (googleButton) googleButton.disabled = true;
      try {
        if (createAccount) await auth.createUserWithEmailAndPassword(email, password);
        else await auth.signInWithEmailAndPassword(email, password);
        if (getEl("loginPassword")) getEl("loginPassword").value = "";
        setLoginAuthMessage(""); closeLoginWall();
      } catch (error) {
        const code = String(error?.code || "");
        let message = "Sign-in failed. Check your details and try again.";
        if (code === "auth/invalid-email") message = "Enter a valid email address.";
        else if (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password") message = "That email and password do not match.";
        else if (code === "auth/email-already-in-use") message = "An account already uses this email. Sign in instead.";
        else if (code === "auth/weak-password") message = "Choose a stronger password with at least 6 characters.";
        else if (code === "auth/operation-not-allowed") message = "Email/password sign-in is not enabled in Firebase Authentication.";
        else if (code === "auth/too-many-requests") message = "Too many attempts. Please wait a little and try again.";
        else if (code === "auth/network-request-failed") message = "Network error. Check your connection and try again.";
        setLoginAuthMessage(message);
      } finally {
        isSigningIn = false; controls.forEach(control => { control.disabled = false; });
        if (googleButton) googleButton.disabled = false;
      }
    }

    async function handlePasswordReset() {
      if (!auth || isSigningIn) { setLoginAuthMessage("Sign-in is still initializing. Please try again."); return; }
      const email = String(getEl("loginEmail")?.value || "").trim();
      if (!email) { setLoginAuthMessage("Enter your email above, then choose Forgot password."); getEl("loginEmail")?.focus(); return; }
      setLoginAuthMessage("");
      try {
        await auth.sendPasswordResetEmail(email);
        setLoginAuthMessage("Password reset email sent. Check your inbox.", false);
      } catch (error) {
        const code = String(error?.code || "");
        const message = code === "auth/invalid-email" ? "Enter a valid email address."
          : code === "auth/user-not-found" ? "No account was found for that email."
          : code === "auth/operation-not-allowed" ? "Email/password sign-in is not enabled in Firebase Authentication."
          : "Could not send a reset email. Please try again.";
        setLoginAuthMessage(message);
      }
    }

    /* =====================================================================
       SAFE STORAGE
       Touching localStorage throws in some contexts (Safari private mode,
       embedded webviews, sandboxed iframes, storage disabled). That used to
       kill this whole script on the very first line that read it, so the app
       rendered nothing at all. Now it degrades to in-memory state instead.
       ===================================================================== */
    const store = (() => {
      let backing = null;
      let persistent = false;
      try {
        localStorage.setItem("__trux_probe", "1");
        localStorage.removeItem("__trux_probe");
        backing = localStorage;
        persistent = true;
      } catch (e) {
        const mem = new Map();
        backing = {
          getItem: k => (mem.has(k) ? mem.get(k) : null),
          setItem: (k, v) => mem.set(k, String(v)),
          removeItem: k => mem.delete(k)
        };
      }
      return {
        available: persistent,
        getItem(k) { try { return backing.getItem(k); } catch (e) { return null; } },
        setItem(k, v) { try { backing.setItem(k, v); } catch (e) {} },
        removeItem(k) { try { backing.removeItem(k); } catch (e) {} },
        // Parse JSON defensively: one corrupted entry must not brick the app.
        json(k, fallback) {
          try {
            const raw = backing.getItem(k);
            if (raw === null || raw === "") return fallback;
            const parsed = JSON.parse(raw);
            return parsed === null || parsed === undefined ? fallback : parsed;
          } catch (e) { return fallback; }
        }
      };
    })();

    // Chat history is account-scoped in Firestore; discard the obsolete device-only cache.
    store.removeItem("trux_chats");
    let cloudChatsReady = false;
    let cloudChatsOwnerUid = null;
    let cloudChatLoadState = "signed-out";
    let cloudChatStatusMessage = "";
    let cloudChatLoadGeneration = 0;
    const cloudChatSyncedFingerprints = new Map();
    const pendingDeletedCloudChatIds = new Set();
    let cloudChatSyncChain = Promise.resolve();

    let currentPlanTier = "base",
        workspaceMode = "chat",
        chatSessions = {},
        pinnedInsights = store.json("trux_pinned", []),
        feedbackCount = Number(store.getItem("trux_feedback_count")) || 0,
        currentChatId = null,
        isGenerating = false,
        sendPromptInFlight = false,
        activeAbortController = null,
        selectedImageBase64 = null,
        pastedTextBlocks = [],
        fileAttachments = [],
        wasInputByVoice = false,
        contextMenuTargetId = null,
        notebookMoveTargetId = null,
        codeBlockCounter = 0,
        recognition = null,
        isRecording = false,
        isScrolledUp = false,
        activeStreamer = null,
        advancedThinkingEnabled = false,
        advancedThinkingLevel = "low",
        incognitoMode = false,
        generationEpoch = 0,
        activeTurnContext = null,
        generationStopRequested = false,
        truxLocationCache = null,
        currentProfileOption = null;
    try {
      const legacyModel = store.getItem("trux_model");
      const savedPlanTier = store.getItem("trux_plan_tier");
      currentPlanTier = ["base","pro"].includes(savedPlanTier)
        ? savedPlanTier
        : (legacyModel === "pro" ? "pro" : "base");
      if(!isTruxDeveloper(auth?.currentUser) && legacyModel === "ultra") currentPlanTier = "base";
      store.setItem("trux_plan_tier", currentPlanTier);
      store.setItem("trux_model", "auto");
      advancedThinkingLevel = ["low","medium","extended"].includes(store.getItem("trux_thinking_level")) ? store.getItem("trux_thinking_level") : "low";
      advancedThinkingEnabled = advancedThinkingLevel === "extended";
    } catch (_) {}

    function positionModelDropdown() {
      const dropdown = getEl("modelDropdown"), button = getEl("modelPickerBtn");
      if(!dropdown || !button || !dropdown.classList.contains("open")) return;
      const r = button.getBoundingClientRect();
      const width = Math.min(360, Math.max(260, window.innerWidth - 20));
      const left = Math.min(Math.max(10, r.left), Math.max(10, window.innerWidth - width - 10));
      const maxH = Math.min(540, Math.max(260, window.innerHeight - 24));
      dropdown.style.setProperty("position", "fixed", "important");
      dropdown.style.setProperty("width", width + "px", "important");
      dropdown.style.setProperty("max-width", "calc(100vw - 20px)", "important");
      dropdown.style.setProperty("max-height", maxH + "px", "important");
      dropdown.style.setProperty("left", left + "px", "important");
      dropdown.style.setProperty("right", "auto", "important");
      dropdown.style.setProperty("top", "auto", "important");
      dropdown.style.setProperty("bottom", Math.max(12, window.innerHeight - r.top + 8) + "px", "important");
      dropdown.style.setProperty("transform", "none", "important");
    }
    window.positionModelDropdown = positionModelDropdown;
    window.addEventListener("resize", () => {
      if (getEl("modelDropdown")?.classList.contains("open")) positionModelDropdown();
    }, { passive: true });

    function toggleModelDropdown(e) {
      if (workspaceMode === "coding") { closeModelDropdown(); return; }
      e?.stopPropagation();
      const dropdown = getEl("modelDropdown"), button = getEl("modelPickerBtn");
      if(!dropdown || !button) return;
      closeAttachmentMenu();
      const open = dropdown.classList.toggle("open");
      button.closest(".model-picker-container")?.classList.toggle("open", open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if(open) requestAnimationFrame(positionModelDropdown);
    }
    function closeModelDropdown() {
      const dropdown = getEl("modelDropdown");
      dropdown?.classList.remove("open");
      if(dropdown){
        dropdown.style.removeProperty("top"); dropdown.style.removeProperty("bottom");
        dropdown.style.removeProperty("left"); dropdown.style.removeProperty("right");
        dropdown.style.removeProperty("width"); dropdown.style.removeProperty("max-height");
        dropdown.style.removeProperty("transform");
      }
      const button = getEl("modelPickerBtn");
      button?.closest(".model-picker-container")?.classList.remove("open");
      button?.setAttribute("aria-expanded", "false");
    }

    function selectModel(m, e) {
      if (workspaceMode === "coding") { closeModelDropdown(); return; }
      e?.stopPropagation();
      // Auto is the only Chat model selection; account entitlements remain separate.
      try { store.setItem("trux_model", "auto"); } catch (_) {}
      const modelEl = getEl("profileModelText");
      if(modelEl) modelEl.innerText = "Auto";
      const pickerLabel = getEl("modelPickerLabel");
      if(pickerLabel) pickerLabel.textContent = "Auto";
      document.querySelectorAll("[data-model]").forEach(x => {
        x.classList.toggle("active", x.dataset.model === "auto");
        const check = x.querySelector(".model-check");
        if(check) check.textContent = x.dataset.model === "auto" ? "✓" : "";
      });
      updateAllUsageUI();
    }

    function setThinkingLevel(level, e) {
      e?.stopPropagation();
      const next = ["low","medium","extended"].includes(level) ? level : "medium";
      advancedThinkingLevel = next;
      advancedThinkingEnabled = next === "extended";
      try { store.setItem("trux_thinking_level", next); } catch (_) {}
      document.querySelectorAll("[data-thinking-level]").forEach(x => {
        x.classList.toggle("active", x.dataset.thinkingLevel === next);
        const check = x.querySelector(".thinking-check");
        if(check) check.textContent = x.dataset.thinkingLevel === next ? "✓" : "";
      });
    }

    function syncModelPickerUI() {
      const pickerLabel = getEl("modelPickerLabel");
      if(pickerLabel) pickerLabel.textContent = "Auto";
      const modelEl = getEl("profileModelText");
      if(modelEl) modelEl.innerText = "Auto";
      document.querySelectorAll("[data-model]").forEach(x => {
        x.classList.toggle("active", x.dataset.model === "auto");
        const check = x.querySelector(".model-check");
        if(check) check.textContent = x.dataset.model === "auto" ? "✓" : "";
      });
      document.querySelectorAll("[data-thinking-level]").forEach(x => {
        x.classList.toggle("active", x.dataset.thinkingLevel === advancedThinkingLevel);
        const check = x.querySelector(".thinking-check");
        if(check) check.textContent = x.dataset.thinkingLevel === advancedThinkingLevel ? "✓" : "";
      });
    }

    async function loadOwnerGeminiModels(forceRefresh = false) {
      if (!isTruxDeveloper(auth?.currentUser)) return;
      const selector = getEl("ownerGeminiModelSelect");
      const status = getEl("ownerGeminiModelStatus");
      if (!selector) return;
      const currentUser = auth.currentUser;
      selector.disabled = true;
      if (status) status.textContent = "Loading Gemini models…";
      try {
        const endpoint = "/api/models" + (forceRefresh ? "?refresh=1" : "");
        const response = await truxAuthenticatedFetch(endpoint, {
          method: "GET",
          cache: "no-store"
        }, currentUser);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not load Google Cloud Gemini models.");
        if (!isTruxDeveloper(auth?.currentUser) || auth.currentUser.uid !== currentUser.uid) return;

        const models = Array.isArray(payload.models) ? payload.models : [];
        const savedModel = store.getItem("trux_owner_gemini_model") || "auto";
        selector.replaceChildren();
        const autoOption = document.createElement("option");
        autoOption.value = "auto";
        autoOption.textContent = "Auto — automatic routing";
        selector.appendChild(autoOption);
        for (const model of models) {
          if (!model || typeof model.id !== "string" || !model.id) continue;
          const option = document.createElement("option");
          option.value = model.id;
          option.textContent = model.displayName ? model.displayName + " (" + model.id + ")" : model.id;
          selector.appendChild(option);
        }

        const savedIsAvailable = Array.from(selector.options).some(option => option.value === savedModel);
        selector.value = savedIsAvailable ? savedModel : "auto";
        if (!savedIsAvailable && savedModel !== "auto") store.setItem("trux_owner_gemini_model", "auto");
        selector.dataset.loaded = "true";
        updateOwnerGeminiModelStatus();
        if (status) status.textContent = models.length + " Gemini models loaded from Google Cloud.";
      } catch (error) {
        if (status) status.textContent = String(error?.message || "Gemini model catalog could not be loaded.");
      } finally {
        selector.disabled = false;
      }
    }

    function saveOwnerGeminiModel(value) {
      if (!isTruxDeveloper(auth?.currentUser)) return;
      const selector = getEl("ownerGeminiModelSelect");
      if (!selector || !Array.from(selector.options).some(option => option.value === value)) return;
      store.setItem("trux_owner_gemini_model", value === "auto" ? "auto" : String(value));
      updateOwnerGeminiModelStatus();
    }

    function updateOwnerGeminiModelStatus() {
      const selected = store.getItem("trux_owner_gemini_model") || "auto";
      const state = getEl("ownerModelStateText");
      if (state) state.textContent = selected === "auto" ? "Auto · automatic routing" : selected;
    }

    function getActiveChatContainer() {
      return getEl(workspaceMode === "coding" ? "codeChatContainer" : "chatContainer");
    }


    const TRUX_ACCENTS = new Set(["blue","cyan","purple","pink","red","orange","yellow","green","teal","white"]);
    function applyTruxAccent(name, persist) {
      const next = TRUX_ACCENTS.has(String(name || "").toLowerCase()) ? String(name).toLowerCase() : "blue";
      document.body.dataset.accent = next;
      document.querySelectorAll("[data-accent-option]").forEach(function(el){ el.classList.toggle("active", el.dataset.accentOption === next); });
      if(persist !== false) store.setItem("trux_accent", next);
    }
    applyTruxAccent(store.getItem("trux_accent") || "blue", false);
    
    void initFirebase().catch(error => {
      console.warn("TruX Firebase initialization failed:", error?.message || error);
      markTruxAuthStateReady(null);
      updateTruxProfileUI(null);
    });

    function updateLocationSettingUI() {
      const toggle=getEl("locationAccessToggle"), status=getEl("locationStatusText");
      const enabled=store.getItem("trux_location_enabled") !== "false";
      if(toggle) toggle.checked=enabled;
      if(!status) return;
      if(!("geolocation" in navigator)) status.textContent="Location is not supported by this browser.";
      else if(!enabled) status.textContent="Location access is off. TruX will not request it.";
      else if(truxLocationCache) status.textContent="Location available for this session.";
      else if(store.getItem("trux_location_granted")==="true") status.textContent="Permission granted. Waiting for a fresh position.";
      else if(store.getItem("trux_location_granted")==="false") status.textContent="Permission unavailable or denied.";
      else status.textContent="Location access is enabled. TruX will ask when needed.";
    }

    function toggleTruxLocationAccess(enabled) {
      store.setItem("trux_location_enabled", enabled ? "true" : "false");
      if(!enabled){ truxLocationCache=null; store.setItem("trux_location_granted","false"); updateLocationSettingUI(); return; }
      requestTruxLocation({interactive:true,force:true});
      updateLocationSettingUI();
    }

    function requestTruxLocation(options) {
      options=options||{};
      const interactive=!!options.interactive, force=!!options.force;
      if(store.getItem("trux_location_enabled")==="false" || !("geolocation" in navigator)){ updateLocationSettingUI(); return Promise.resolve(null); }
      if(truxLocationCache && !force) return Promise.resolve(truxLocationCache);
      return new Promise(function(resolve){
        navigator.geolocation.getCurrentPosition(function(pos){
          truxLocationCache={latitude:Number(pos.coords.latitude),longitude:Number(pos.coords.longitude),accuracy:Number(pos.coords.accuracy||0)};
          store.setItem("trux_location_granted","true"); store.setItem("trux_location_prompted","true"); updateLocationSettingUI();
          if(interactive) toast("Location access enabled for TruX.","ok");
          resolve(truxLocationCache);
        },function(err){
          store.setItem("trux_location_granted","false"); updateLocationSettingUI();
          if(interactive) toast(err && err.code===1 ? "Location permission was denied. You can enable it later in Personalization." : "TruX could not access your location right now.","err");
          resolve(null);
        },{enableHighAccuracy:false,maximumAge:300000,timeout:12000});
      });
    }

    function getTruxLocationForTurn(){
      if(store.getItem("trux_location_enabled")==="false") return Promise.resolve(null);
      if(truxLocationCache) return Promise.resolve(truxLocationCache);
      if(store.getItem("trux_location_granted")==="false") return Promise.resolve(null);
      return requestTruxLocation({interactive:false});
    }

    function dismissLocationConsent(useLocation){
      store.setItem("trux_location_prompted","true");
      getEl("locationConsentModal") && getEl("locationConsentModal").classList.remove("active");
      if(useLocation){ store.setItem("trux_location_enabled","true"); requestTruxLocation({interactive:true,force:true}); }
      else { store.setItem("trux_location_enabled","false"); truxLocationCache=null; updateLocationSettingUI(); }
    }

    function maybeAskForLocation(){
      if(!auth || !auth.currentUser) return;
      if(store.getItem("trux_location_prompted")==="true" || store.getItem("trux_location_enabled")==="false") return;
      if(!("geolocation" in navigator)){ store.setItem("trux_location_prompted","true"); return; }
      setTimeout(function(){ const el=getEl("locationConsentModal"); if(el) el.classList.add("active"); },380);
    }

    function applyStoredAvatar(user){
      const override=store.getItem("trux_avatar_override")||"";
      const src=override || (user && user.photoURL) || "https://ui-avatars.com/api/?name=User&background=111111&color=fff";
      if(getEl("userAvatar")) getEl("userAvatar").src=src;
      if(getEl("modalAvatar")) getEl("modalAvatar").src=src;
      if(getEl("topProfileAvatar")) getEl("topProfileAvatar").src=src;
    }

    function openAvatarPicker(){
      let input=getEl("profileAvatarUpload");
      if(!input){
        input=document.createElement("input"); input.id="profileAvatarUpload"; input.type="file"; input.accept="image/*"; input.hidden=true;
        input.onchange=handleProfileAvatarUpload; document.body.appendChild(input);
      }
      input.click();
    }

    function handleProfileAvatarUpload(event){
      const file=event && event.target && event.target.files && event.target.files[0];
      if(!file || !file.type.startsWith("image/")) return;
      const reader=new FileReader();
      reader.onload=function(e){ const data=String(e.target.result||""); if(!data)return; store.setItem("trux_avatar_override",data); applyStoredAvatar(auth&&auth.currentUser); toast("Profile avatar updated on this device.","ok"); };
      reader.readAsDataURL(file);
    }

    function resetAvatarOverride(){ store.removeItem("trux_avatar_override"); applyStoredAvatar(auth&&auth.currentUser); toast("Profile avatar reset.","ok"); }

    function exportTruxMemory(){
      const preferences={}; ["trux_custom_instructions","trux_theme","trux_profile_display_name","trux_age_group","trux_dictation_language","trux_speech_voice",...TRUX_PROFILE_PREFERENCES.map(k=>"trux_"+k),...TRUX_NOTIFICATION_CATEGORIES.map(k=>"trux_notification_cat_"+k)].forEach(k=>{const v=store.getItem(k);if(v!==null)preferences[k]=v;}); const payload={version:2,exportedAt:new Date().toISOString(),chats:chatSessions,pinnedInsights:pinnedInsights,customInstructions:store.getItem("trux_custom_instructions")||"",preferences};
      const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}), url=URL.createObjectURL(blob), a=document.createElement("a");
      a.href=url; a.download="trux-memory-export.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(url);},500);
    }

    function importTruxMemory(){
      const input=document.createElement("input"); input.type="file"; input.accept="application/json,.json";
      input.onchange=async function(){
        const file=input.files&&input.files[0]; if(!file)return;
        try{
          const data=JSON.parse(await file.text());
          if(data && data.chats && typeof data.chats==="object"){ chatSessions=Object.assign({},chatSessions,data.chats); saveChatSessions(); }
          if(data && Array.isArray(data.pinnedInsights)){ pinnedInsights=Array.from(new Set(pinnedInsights.concat(data.pinnedInsights))); store.setItem("trux_pinned",JSON.stringify(pinnedInsights)); }
          if(data && typeof data.customInstructions==="string") store.setItem("trux_custom_instructions",data.customInstructions);
          if(data && data.preferences && typeof data.preferences==="object") Object.entries(data.preferences).forEach(([key,value])=>{if(String(key).startsWith("trux_") && !/token|secret|key/i.test(key) && (typeof value==="string" || typeof value==="boolean")) store.setItem(key,String(value));});
          loadSettings(); renderSidebar(); toast("TruX memory imported.","ok");
        }catch(e){ toast("Could not import that memory file.","err"); }
      };
      input.click();
    }

    function profileDetailData(key){
      const email=escapeHtml((auth&&auth.currentUser&&auth.currentUser.email)||"No account");
      if(key==="account") return {title:"Manage your account",subtitle:"Your connected sign-in and account controls.",html:'<div class="detail-callout"><h4>Connected account</h4><p>'+email+'</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="window.open(&#39;https://myaccount.google.com/&#39;,&#39;_blank&#39;,&#39;noopener&#39;)">Open Google Account</button></div></div>'};
      if(key==="avatar") return {title:"Avatar",subtitle:"Choose the image shown in your TruX profile.",html:'<div class="detail-callout"><h4>Profile image</h4><p>Choose a local image or reset to your connected Google photo.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openAvatarPicker()">Choose image</button><button class="mbtn" type="button" onclick="resetAvatarOverride()">Reset avatar</button></div></div>'};
      if(key==="help") return {title:"Help & privacy",subtitle:"Guides, troubleshooting, bug reports, and direct founder contact.",html:"<div class=\"help-layout\">\n  <section class=\"help-panel help-wide\">\n    <h4>Welcome to TruX-Omni</h4>\n    <p>This page explains the main workspaces, tools, settings, and ways to get help.</p>\n    <ul>\n      <li><b>Chat:</b> Ask questions, learn, brainstorm, write, and work through follow-up questions.</li>\n      <li><b>TruX-Code:</b> Use the coding workspace for code, debugging, and connected repository tasks. Review proposed changes before relying on them.</li>\n      <li><b>Image and Video:</b> Switch to the matching workspace and describe what you want to create.</li>\n      <li><b>TruX Live:</b> Start a live voice session when you want to speak naturally; allow camera or screen access only when you need it.</li>\n    </ul>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Chat and model selection</h4>\n    <p>Choose Chat for everyday questions. The regular user model choice is <b>Auto</b>, which selects a suitable model for your request. Be specific about your goal, constraints, and preferred output, then ask follow-up questions to refine the result.</p>\n    <p>Thinking controls, when available, let you adjust how much reasoning to use.</p>\n  </section>\n  <section class=\"help-panel\">\n    <h4>The + tools menu</h4>\n    <p>Use the <b>+</b> menu to access tools such as coding, Deep Research, image generation, files, camera, and photos. Describe what you want done with an attachment so TruX knows how to use it.</p>\n    <p>Use the Library to revisit supported generated media and saved items.</p>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Chats, notebooks, and Incognito</h4>\n    <p>Use the sidebar to switch between chats and notebooks. Move relevant conversations into a notebook to keep related work together. Use the Incognito option when you want a separate private-style session; check the current interface before assuming a conversation has been saved.</p>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Settings and privacy</h4>\n    <p>Open your profile menu for Settings, Personalization, Notifications, usage information, and account options. Location access can be managed from Personalization. Only grant device permissions when a feature needs them.</p>\n    <div class=\"detail-stack-actions\"><button class=\"mbtn\" type=\"button\" onclick=\"closeProfileOption();openSettingsModal(&quot;personalization&quot;)\">Open Personalization</button></div>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Troubleshooting</h4>\n    <ol>\n      <li>Check your internet connection and confirm you are signed in.</li>\n      <li>If a tool fails, retry once and note the exact error message.</li>\n      <li>For voice, camera, or screen features, check the browser permission for that feature.</li>\n      <li>If the issue continues, send a bug report below with the steps that caused it and what you expected to happen.</li>\n    </ol>\n  </section>\n  <section class=\"help-panel help-wide\" id=\"helpFeedbackSection\">\n    <h4>Feedback and bug reports</h4>\n    <p>Use this form to report a bug, describe an issue, suggest a feature, or share feedback. For bugs, include what you were doing, the steps to reproduce the issue, what happened, and what you expected instead. Please do not include passwords, API keys, or other secrets.</p>\n    <form class=\"help-form\" onsubmit=\"submitHelpFeedback(event)\">\n      <label>Feedback type\n        <select name=\"type\" required>\n          <option value=\"bug-report\">Report a bug or issue</option>\n          <option value=\"product-feedback\">General feedback</option>\n          <option value=\"feature-request\">Suggest a feature</option>\n          <option value=\"general-feedback\">Other</option>\n        </select>\n      </label>\n      <label>Subject (optional)\n        <input name=\"subject\" type=\"text\" maxlength=\"160\" placeholder=\"A short title for your feedback\">\n      </label>\n      <label>Details\n        <textarea name=\"message\" required minlength=\"8\" maxlength=\"12000\" rows=\"5\" placeholder=\"Describe the issue, steps to reproduce it, or your suggestion…\"></textarea>\n      </label>\n      <button class=\"mbtn help-submit\" type=\"submit\">Send feedback</button>\n    </form>\n  </section>\n  <section class=\"help-panel help-wide\" id=\"founderContactSection\">\n    <h4>Contact the founder directly</h4>\n    <p>Have a question, suggestion, or query for the founder? Type it here and submit it as a direct contact request. Replies use the email address associated with your signed-in account.</p>\n    <form class=\"help-form\" onsubmit=\"submitFounderQuery(event)\">\n      <label>Subject\n        <input name=\"subject\" type=\"text\" required maxlength=\"160\" placeholder=\"What is your query about?\">\n      </label>\n      <label>Your query\n        <textarea name=\"message\" required minlength=\"8\" maxlength=\"12000\" rows=\"4\" placeholder=\"Write your question or query to the founder…\"></textarea>\n      </label>\n      <button class=\"mbtn help-submit\" type=\"submit\">Email the founder</button>\n    </form>\n  </section>\n  <p class=\"help-footnote help-wide\">Feedback and founder queries require you to be signed in. Submissions are emailed to the TruX-Omni founder when server delivery is available. If email delivery fails, TruX opens your email app with the message prepared so you can send it manually.</p>\n</div>"};

      if(key==="workspace") return {title:"Workspace",subtitle:"Your current TruX-Omni plan and tools.",html:'<div class="detail-callout"><h4>Current workspace</h4><p>'+((currentPlanTier==="pro")?"Pro workspace":"Personal workspace")+'</p><p>Usage and model access are managed by your current plan.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;usage&quot;)">View usage &amp; limits</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;data&quot;)">Manage workspace data</button></div></div>'};
      if(key==="safety") return {title:"Safety & wellbeing",subtitle:"Permission and safe-use guidance for this workspace.",html:'<div class="detail-callout"><h4>Device permissions</h4><p>Only grant location, microphone, camera, or notification permissions when you are using a feature that needs them. You can change location and notification settings below.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;personalization&quot;)">Location &amp; personalization</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;notifications&quot;)">Notification settings</button></div></div><div class="detail-callout"><h4>Content safeguards</h4><p>TruX does not currently expose a separate sensitive-content filter switch. Do not use this screen as a substitute for reviewing generated content.</p></div>'};
      if(key==="security") return {title:"Security & login",subtitle:"Manage the account used to sign in to TruX.",html:'<div class="detail-callout"><h4>Connected account</h4><p>'+email+'</p><p>Account password, passkeys, and multi-factor authentication are managed by your sign-in provider.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="window.open(&#39;https://myaccount.google.com/security&#39;,&#39;_blank&#39;,&#39;noopener&#39;)">Open account security</button><button class="mbtn danger" type="button" onclick="confirmSignOut()">Sign out</button></div></div>'};
      if(key==="remote") return {title:"Remote control",subtitle:"Control TruX from another device.",html:'<div class="detail-callout"><h4>Remote pairing is not available yet</h4><p>This TruX web app does not currently implement QR pairing or remote desktop control. No saved connections are being hidden here.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="closeProfileOption()">Back to profile</button></div></div>'};
      if(key==="storage") return {title:"Storage",subtitle:"Manage chats and workspace data saved by TruX.",html:'<div class="detail-callout"><h4>Workspace data</h4><p>Export a copy of your chats before clearing history. Clearing chat history is destructive and requires confirmation.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="exportChatData()">Export chats</button><button class="mbtn" type="button" onclick="exportTruxMemory()">Export workspace memory</button><button class="mbtn danger" type="button" onclick="clearAllHistory()">Clear chat history</button></div></div>'};
      if(key==="privacy") return {title:"Privacy center",subtitle:"Review the privacy controls available in TruX.",html:'<div class="detail-callout"><h4>Available controls</h4><p>Use Data controls to export or clear chats and to import or export workspace memory. Location access can be changed under Personalization. Incognito sessions are intended to stay separate from normal chat history.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;data&quot;)">Open data controls</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;personalization&quot;)">Open personalization</button></div></div>'};
      if(key==="ads") return {title:"Ads controls",subtitle:"Advertising preferences for TruX-Omni.",html:'<div class="detail-callout"><h4>Ads are not currently enabled in TruX</h4><p>This app does not currently serve personalized ads or maintain an ads-topic history, so an ad personalization toggle would not change anything. Your chat and workspace controls are available separately.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;data&quot;)">Open data controls</button></div></div>'};
      if(key==="about") return {title:"About TruX-Omni",subtitle:"Your AI workspace.",html:'<div class="detail-callout"><h4>TruX-Omni</h4><p>An AI workspace for chat, coding, image and video creation, and connected tools.</p><p>Application: <a href="https://trux-ai-workspace.trux.website/" target="_blank" rel="noopener noreferrer">trux-ai-workspace.trux.website</a></p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openProfileOption(&quot;help&quot;)">Help &amp; feedback</button></div></div>'};
      if(key==="reportbug"){ const page=profileDetailData("help"); page.title="Report a bug"; page.subtitle="Send a bug report, feature request, or product feedback."; return page; }

      if(key==="parental") return {title:"Parental controls",subtitle:"Safety options for younger users.",html:'<div class="detail-callout"><h4>Device-level controls</h4><p>TruX does not currently provide parent-linked controls or cross-account monitoring. A parent or guardian can configure device-level restrictions using the device operating system or family-management service.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;personalization&quot;)">Review personalization</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;notifications&quot;)">Review notifications</button></div></div>'};
      if(key==="upgrade") return {title:"Plan & usage",subtitle:"Review your current plan limits.",html:'<div class="detail-callout"><h4>Current plan</h4><p>Open usage and limits to review your current workspace allowance and image-generation usage. Plan purchasing is not handled by this page.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;usage&quot;)">View usage &amp; limits</button></div></div>'};
      return {title:"Profile",subtitle:"Choose a profile setting.",html:'<div class="detail-callout"><p>That option is not available for this account.</p></div>'};
    }

    function openProfileOption(key){
      const settingsSections={usage:"usage",personalization:"personalization",notifications:"voice",memory:"personalization",appearance:"appearance",general:"general",voice:"voice",dataControls:"data",developer:"developer",account:"account",workspace:"account",upgrade:"usage",security:"account",safety:"personalization",remote:"data",storage:"data",privacy:"data",ads:"data",parental:"personalization",avatar:"account"};
      if(key==="plugins"){
        closeProfileOption();
        closeProfileModal();
        if(typeof openPluginsPage==="function") openPluginsPage();
        else toast("Plugins could not be opened. Please refresh TruX and try again.","err");
        return;
      }
      if(Object.prototype.hasOwnProperty.call(settingsSections,key)){
        closeProfileOption();
        openSettingsModal(settingsSections[key]);
        return;
      }
      currentProfileOption=key;
      const detail=getEl("profileDetailView");
      const data=profileDetailData(key);
      document.querySelectorAll("#profileModal .profile-option-list").forEach(el=>el.style.display="none");
      document.querySelectorAll("#profileModal .profile-list-group-title").forEach(el=>el.style.display="none");
      const hero=getEl("profileHero"), summary=getEl("profileMetaSummary"), actions=getEl("profileActionsRow");
      if(hero) hero.style.display="none";
      if(summary) summary.style.display="none";
      if(actions) actions.style.display="none";
      if(detail){ detail.hidden=false; getEl("profileDetailTitle").textContent=data.title; getEl("profileDetailSubtitle").textContent=data.subtitle; getEl("profileDetailBody").innerHTML=data.html; }
      const scroller=getEl("profileModal"); if(scroller) scroller.scrollTop=0;
    }

    function closeProfileOption(){
      currentProfileOption=null;
      document.querySelectorAll("#profileModal .profile-option-list").forEach(el=>el.style.display="");
      document.querySelectorAll("#profileModal .profile-list-group-title").forEach(el=>el.style.display="");
      const hero=getEl("profileHero"), summary=getEl("profileMetaSummary"), actions=getEl("profileActionsRow");
      if(hero) hero.style.display="";
      if(summary) summary.style.display="";
      if(actions) actions.style.display="";
      const detail=getEl("profileDetailView");
      if(detail) detail.hidden=true;
      const scroller=getEl("profileModal"); if(scroller) scroller.scrollTop=0;
    }

    function updateNotificationSettingsUI(){
      const granted=("Notification" in window && Notification.permission==="granted");
      const t=getEl("notificationsToggle"); if(t) t.checked=granted;
      const s=getEl("notificationStatusText"); if(s) s.textContent=("Notification" in window) ? "Permission: "+Notification.permission : "Notifications are not supported.";
    }

    async function toggleTruxNotificationsSetting(enabled){
      if(!enabled){ updateNotificationSettingsUI(); return; }
      await enableTruxNotifications();
      updateNotificationSettingsUI();
    }

    function setWorkspaceMode(mode, options) {
      document.body.classList.remove("plugins-page-active","notebook-open");
      options = options || {};
      const nextMode = mode || "chat";
      const previousMode = workspaceMode;
      // Plans is a standalone page. Any explicit workspace switch must leave it
      // first, even when the selected mode matches the previously saved mode.
      const leavingSubscriptionPage = document.body.classList.contains("subscription-page-active");
      if(leavingSubscriptionPage) {
        document.body.classList.remove("subscription-page-active");
        truxSubscriptionReturnState = null;
      }
      const modeChanged = leavingSubscriptionPage || nextMode !== previousMode || !!document.body.dataset.mediaMode || options.forceReset === true;
      const preserveSession = options.preserveSession === true;

      closeAttachmentMenu(); closeModelDropdown();

      if(modeChanged) {
        if (activeTurnContext) persistTurnDraft(activeTurnContext, activeTurnContext.latestText || "", true);
        if(currentChatId && isPersistableChatSession(chatSessions[currentChatId])) void syncChatsToCloud(true);
        generationEpoch += 1;
        activeTurnContext = null;
        activeAbortController?.abort();
        activeStreamer?.cancel(); activeStreamer = null;
        isGenerating = false;
        generationStopRequested = false;
        handleInputChange();
        if(typeof clearHomeGreetingTimers === "function") clearHomeGreetingTimers();
        document.body.classList.remove("scrolled");
        getEl("scrollDownBtn")?.classList.remove("visible");
        pastedTextBlocks = []; fileAttachments = []; renderFileChips();

        // Switching between Chat and TruX-Code is a workspace boundary.
        // It always starts a fresh session. Only history navigation opts into
        // preserving the existing session.
        if(!preserveSession) {
          currentChatId = null;
          incognitoMode = false;
        }

        const chatView = getEl("chatContainer");
        const codeView = getEl("codeChatContainer");
        if(chatView) { chatView.style.display = "none"; chatView.innerHTML = ""; }
        if(codeView) { codeView.style.display = "none"; codeView.innerHTML = ""; }
        void document.body.offsetHeight;
      }

      workspaceMode = nextMode;
      document.body.dataset.workspaceMode = workspaceMode;
      if(currentChatId && chatSessions[currentChatId] && preserveSession) chatSessions[currentChatId].mode = workspaceMode;

      const isCoding = workspaceMode === "coding";
      const isMedia = workspaceMode === "image" || workspaceMode === "video";

      if(isMedia) document.body.dataset.mediaMode = workspaceMode;
      else document.body.removeAttribute("data-media-mode");

      document.body.classList.toggle("coding-workspace", isCoding);
      document.body.classList.toggle("chat-session-active", !!currentChatId && !isMedia && !isCoding);
      document.body.classList.toggle("home-active", !isCoding && !isMedia && !currentChatId);

      const welcome = getEl("welcomeScreen");
      if(welcome) {
        // Workspace classes are the single source of truth for home visibility.
        // Clear inline values left by older navigation paths before CSS applies.
        welcome.style.removeProperty("display");
        welcome.style.removeProperty("visibility");
        welcome.style.removeProperty("pointer-events");
      }

      const chatView = getEl("chatContainer");
      const codeView = getEl("codeChatContainer");
      if(chatView) chatView.style.display = isCoding ? "none" : (currentChatId ? "block" : "none");
      if(codeView) codeView.style.display = isCoding ? "block" : "none";

      // Reset any stale inline state. Workspace-mode CSS controls visibility;
      // the transcript lives inside this same element.
      const codeHome = getEl("truxCodeWorkspace");
      if(codeHome) {
        codeHome.style.removeProperty("display");
        codeHome.style.removeProperty("opacity");
        codeHome.style.removeProperty("transform");
      }

      // Rehydrate the same chat only for internal/history navigation.
      if(modeChanged && currentChatId && chatSessions[currentChatId] && !isMedia) {
        const target = isCoding ? codeView : chatView;
        if(target) {
          target.innerHTML = "";
          target.style.display = "block";
          (chatSessions[currentChatId].messages || []).forEach(m => appendMessageRow(
            m.role === "user" ? "You" : "TruX-Omni",
            m.text || "",
            m.role === "user" ? "user-row" : "trux-row",
            m.role === "user" ? "user-bubble" : "trux-bubble",
            m.image || null, false, m.sources, m.video
          ));
          target.scrollTop = target.scrollHeight;
        }
      }

      document.querySelectorAll("[data-trux-mode]").forEach(x => x.classList.toggle("active", x.dataset.truxMode === workspaceMode));
      document.querySelectorAll("[data-trux-menu-mode]").forEach(x => x.classList.toggle("active", x.dataset.truxMenuMode === workspaceMode));

      const p = getEl("promptInput");
      const placeholders = { chat:"Ask TruX…", coding:"Let’s code…", "deep-research":"Let’s research…", image:"Let’s create an image…", video:"Let’s make a video…" };
      if(p) { p.placeholder = placeholders[workspaceMode] || "Ask TruX…"; p.style.height = "auto"; handleInputChange(); }

      // Thinking is controlled inside the model picker; no separate top thinking button exists.
      syncModelPickerUI();
      renderSidebar();
      if(workspaceMode === "chat" && !currentChatId && !isMedia) {
        startHomeGreetingPulse();
      }
      if(isCoding) {
        startTruxCodeIdlePulse();
      } else {
        if(truxCodeIdleTimer) clearInterval(truxCodeIdleTimer);
        if(truxCodeGreetingSwapTimer) clearTimeout(truxCodeGreetingSwapTimer);
        truxCodeIdleTimer = null;
        truxCodeGreetingSwapTimer = null;
      }
    }
    async function submitFeedback() {
      const type = getEl("feedbackType")?.value || "general-feedback";
      const subject = getEl("feedbackSubject")?.value?.trim() || "";
      const message = getEl("feedbackInput")?.value?.trim() || "";
      if (!message) return toast("Please describe your feedback or bug.", "err");
      return sendTruxFeedback({ type, subject, message, button: getEl("feedbackSubmitBtn") });
    }

    async function submitHelpFeedback(event) {
      event?.preventDefault();
      const form = event?.currentTarget;
      if (!form) return;
      const type = form.querySelector('[name="type"]')?.value || "general-feedback";
      const subject = form.querySelector('[name="subject"]')?.value?.trim() || "";
      const message = form.querySelector('[name="message"]')?.value?.trim() || "";
      if (message.length < 8) return toast("Please add a little more detail before sending.", "err");
      return sendTruxFeedback({ type, subject, message, form, button: form.querySelector('[type="submit"]') });
    }

    async function submitFounderQuery(event) {
      event?.preventDefault();
      const form = event?.currentTarget;
      if (!form) return;
      const subject = form.querySelector('[name="subject"]')?.value?.trim() || "";
      const message = form.querySelector('[name="message"]')?.value?.trim() || "";
      if (subject.length < 2 || message.length < 8) return toast("Please add a subject and write your query.", "err");
      return sendTruxFeedback({ type: "founder-query", subject, message, form, button: form.querySelector('[type="submit"]') });
    }

    function openFeedbackEmailDraft({ type, subject, message, user }) {
      const labels = {
        "bug-report": "Bug report",
        "product-feedback": "Product feedback",
        "feature-request": "Feature request",
        "general-feedback": "General feedback",
        "founder-query": "Founder query"
      };
      const label = labels[type] || "Feedback";
      const emailSubject = "[TruX-Omni " + label + "] " + (subject || label);
      const body = [
        "TruX-Omni " + label,
        "Submitted from: " + window.location.origin,
        "Account name: " + (user?.displayName || "Not provided"),
        "Account email: " + (user?.email || "Not provided"),
        "Submitted at: " + new Date().toISOString(),
        "",
        "Message:",
        message
      ].join("\n");
      const mailto = "mailto:ekagraavn2003@gmail.com?subject=" +
        encodeURIComponent(emailSubject) + "&body=" + encodeURIComponent(body);
      try {
        window.location.href = mailto;
        toast("Your email app should open with this message prepared. Tap Send there to deliver it to the founder.", "ok");
        return true;
      } catch {
        toast("Automatic email is unavailable. Email ekagraavn2003@gmail.com and paste your message.", "err");
        return false;
      }
    }

    async function sendTruxFeedback({ type, subject, message, form, button }) {
      const user = auth?.currentUser;
      if (!user) {
        toast("Sign in to send feedback or contact the founder.", "err");
        openLoginWall();
        return false;
      }
      if (message.length > 12000) return toast("Your message is too long. Please shorten it.", "err");
      const originalHtml = button?.innerHTML;
      if (button) {
        button.disabled = true;
        button.textContent = "Sending…";
      }
      try {
        const requestOptions = {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, subject, message })
        };
        let response;
        try {
          response = await truxAuthenticatedFetch("/api/feedback", requestOptions, user);
        } catch {
          return openFeedbackEmailDraft({ type, subject, message, user });
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          if ([404, 405, 500, 502, 503, 504].includes(response.status)) {
            return openFeedbackEmailDraft({ type, subject, message, user });
          }
          throw new Error(payload.error || payload.detail || "Feedback could not be sent. Please try again.");
        }
        if (form) form.reset();
        else {
          if (getEl("feedbackInput")) getEl("feedbackInput").value = "";
          if (getEl("feedbackSubject")) getEl("feedbackSubject").value = "";
        }
        toast(payload.message || "Your message was emailed to the founder.", "ok");
        return true;
      } catch (error) {
        toast(error?.message || "Feedback could not be sent. Please try again.", "err");
        return false;
      } finally {
        if (button) {
          button.disabled = false;
          if (originalHtml !== undefined) button.innerHTML = originalHtml;
        }
      }
    }

    function getProUsageData() {
      let currentMonth = new Date().toISOString().slice(0, 7);
      let u = store.json("trux_pro_usage", { tokensUsed: 0, monthReset: currentMonth });
      if(u.monthReset !== currentMonth) { u = { tokensUsed: 0, monthReset: currentMonth }; store.setItem("trux_pro_usage", JSON.stringify(u)); }
      return u;
    }
    function recordProTokens(n) {
      let u = getProUsageData(); u.tokensUsed = Math.min(1000000, u.tokensUsed + n);
      store.setItem("trux_pro_usage", JSON.stringify(u)); updateAllUsageUI();
    }

    function getCoreUsageData() {
      let currentMonth = new Date().toISOString().slice(0, 7);
      let u = store.json("trux_core_usage", { tokensUsed: 0, monthReset: currentMonth });
      if(u.monthReset !== currentMonth) { u = { tokensUsed: 0, monthReset: currentMonth }; store.setItem("trux_core_usage", JSON.stringify(u)); }
      return u;
    }
    function recordCoreTokens(n) {
      let u = getCoreUsageData(); u.tokensUsed = u.tokensUsed + n;
      store.setItem("trux_core_usage", JSON.stringify(u)); updateAllUsageUI();
    }

    function getImageUsageData() {
      let currentMonth = new Date().toISOString().slice(0, 7);
      let u = store.json("trux_image_usage", { count: 0, monthReset: currentMonth });
      if(u.monthReset !== currentMonth) { u = { count: 0, monthReset: currentMonth }; store.setItem("trux_image_usage", JSON.stringify(u)); }
      return u;
    }

    function updateAllUsageUI() {
      const owner = isTruxDeveloper(auth?.currentUser);
      let cU = getCoreUsageData();
      getEl("coreUsageBarFill").style.width = owner ? "8%" : "12%";
      getEl("coreUsageText").innerText = `Unlimited · ${cU.tokensUsed.toLocaleString()} tokens used`;

      let pU = getProUsageData();
      getEl("proUsageBarFill").style.width = owner ? "100%" : Math.min(100, (pU.tokensUsed / 1000000) * 100) + "%";
      getEl("proUsageText").innerText = owner ? `Unlimited · ${pU.tokensUsed.toLocaleString()} tokens used` : `${pU.tokensUsed.toLocaleString()} / 1,000,000 Tokens`;

      let iU = getImageUsageData();
      getEl("imageUsageBarFill").style.width = Math.min(100, (iU.count / 15) * 100) + "%";
      getEl("imageUsageText").innerText = owner ? `${iU.count} / 15 Images · Owner access` : `${iU.count} / 15 Images`;

      const plan = getEl("profilePlanText"), limit = getEl("profileLimitText");
      if(plan) plan.innerText = owner ? "Owner" : (currentPlanTier === "pro" ? "Pro" : "Core");
      if(limit) limit.innerText = "Unlimited";
      updateFeedbackCounterUI();
    }


    const TRUX_PROFILE_PREFERENCES = ["base_style","warmth","enthusiasm","formatting","emoji","fast_answers","memory_enabled","nickname","occupation","about","dictation_history","age_group","reduce_sensitive","focus_reminder","focus_interval"];
    const TRUX_NOTIFICATION_CATEGORIES = ["codex","group_chats","health","library","marketing","tips","projects","responses","tasks","usage"];
    let truxFocusReminderTimer = null;
    function saveProfilePreference(key, value) {
      if (typeof value === "boolean") store.setItem("trux_" + key, value ? "true" : "false");
      else store.setItem("trux_" + key, String(value ?? ""));
      if (key === "dictation_history" && !value) store.removeItem("trux_dictation_history_items");
      if (["memory_enabled","base_style","warmth","enthusiasm","formatting","emoji","fast_answers","reduce_sensitive"].includes(key)) { try { refreshTruxMemorySummary(); } catch {} }
    }
    function saveProfileField(input, key) {
      if (!input) return;
      store.setItem("trux_" + key, input.value.slice(0, key === "about" ? 3000 : 120));
      try { refreshTruxMemorySummary(); } catch {}
    }
    function applyTruxTheme(theme, persist) {
      const allowed = new Set(["dark","light","oled","dracula","nord","solarized","rose-pine","monokai","hacker"]);
      const next = allowed.has(String(theme || "")) ? String(theme) : "dark";
      if (next === "dark") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.dataset.theme = next;
      if (persist !== false) store.setItem("trux_theme", next);
      const select = getEl("truxThemeSelect"); if (select) select.value = next;
    }
    function saveNotificationCategory(category, enabled) {
      if (!TRUX_NOTIFICATION_CATEGORIES.includes(category)) return;
      store.setItem("trux_notification_cat_" + category, enabled ? "true" : "false");
    }
    function saveDictationLanguage(language) {
      const allowed = new Set(["auto","en-US","en-GB","hi-IN","fr-FR","es-ES","de-DE","ja-JP"]);
      const next = allowed.has(language) ? language : "auto";
      store.setItem("trux_dictation_language", next);
      if (recognition) recognition.lang = next === "auto" ? (navigator.language || "en-US") : next;
    }
    function saveSpeechVoice(name) { store.setItem("trux_speech_voice", String(name || "")); }
    function populateTruxSpeechVoices() {
      const select = getEl("truxSpeechVoiceSelect");
      if (!select || !("speechSynthesis" in window)) return;
      const selected = store.getItem("trux_speech_voice") || "";
      const voices = speechSynthesis.getVoices();
      select.innerHTML = '<option value="">System default</option>';
      voices.forEach(voice => {
        const option = document.createElement("option");
        option.value = voice.name;
        option.textContent = voice.name + (voice.lang ? " · " + voice.lang : "");
        select.appendChild(option);
      });
      select.value = voices.some(v => v.name === selected) ? selected : "";
      if (!window.__truxVoiceOptionsBound) {
        window.__truxVoiceOptionsBound = true;
        speechSynthesis.addEventListener("voiceschanged", populateTruxSpeechVoices);
      }
    }
    function saveAccountProfile() {
      const input = getEl("truxAccountDisplayName"); if (!input) return;
      const name = input.value.trim().slice(0,100);
      if (!name) { toast("Enter a profile name first.", "err"); return; }
      store.setItem("trux_profile_display_name", name);
      const user = auth && auth.currentUser;
      const update = user && typeof user.updateProfile === "function" ? user.updateProfile({displayName:name}) : Promise.resolve();
      Promise.resolve(update).then(() => {
        if (user) updateTruxProfileUI(user);
        const modalName = getEl("modalName"); if (modalName) modalName.textContent = name;
        toast("Profile name saved.", "ok");
      }).catch(error => {
        console.warn("Profile name saved locally; provider update was rejected.", error);
        toast("Saved on this device. Your sign-in provider did not accept the profile update.", "err");
      });
    }
    function refreshTruxMemorySummary() {
      const host = getEl("truxMemorySummaryText"); if (!host) return;
      if (store.getItem("trux_memory_enabled") === "false") { host.textContent = "Memory is off. Saved profile details are not added to TruX prompts."; return; }
      const rows = [["Nickname",store.getItem("trux_nickname")],["Occupation",store.getItem("trux_occupation")],["More about you",store.getItem("trux_about")],["Response style",store.getItem("trux_base_style") && store.getItem("trux_base_style")!=="Default" ? store.getItem("trux_base_style") : ""]].filter(row=>row[1]);
      host.textContent = rows.length ? rows.map(row=>row[0]+": "+row[1]).join("\n\n") : "No profile details saved yet.";
    }
    function loadSupplementarySettings() {
      const values = {
        truxBaseStyleSelect:["trux_base_style","Default"], truxWarmthSelect:["trux_warmth","Default"], truxEnthusiasmSelect:["trux_enthusiasm","Default"], truxFormattingSelect:["trux_formatting","Default"], truxEmojiSelect:["trux_emoji","Default"], truxThemeSelect:["trux_theme","dark"],
        truxMemoryNickname:["trux_nickname",""], truxMemoryOccupation:["trux_occupation",""], truxMemoryAbout:["trux_about",""],
        truxAccountDisplayName:["trux_profile_display_name",(auth && auth.currentUser && auth.currentUser.displayName)||""], truxAccountAgeGroup:["trux_age_group",""],
        truxDictationLanguage:["trux_dictation_language","auto"], truxFocusInterval:["trux_focus_interval","45"]
      };
      Object.entries(values).forEach(([id,pair])=>{const el=getEl(id);if(el)el.value=store.getItem(pair[0])??pair[1];});
      const checked = {
        truxFastAnswersToggle:["trux_fast_answers",true], truxMemoryEnabledToggle:["trux_memory_enabled",true], truxDictationHistoryToggle:["trux_dictation_history",false], truxReduceSensitiveToggle:["trux_reduce_sensitive",false], truxFocusReminderToggle:["trux_focus_reminder",false]
      };
      Object.entries(checked).forEach(([id,pair])=>{const el=getEl(id);if(el)el.checked=store.getItem(pair[0])==null?pair[1]:store.getItem(pair[0])==="true";});
      const user=auth&&auth.currentUser;
      const email=getEl("truxAccountEmailText");if(email)email.textContent=user?.email||"Not signed in";
      const securityEmail=getEl("truxSecurityEmailText");if(securityEmail)securityEmail.textContent=user?.email||"Not signed in";
      const phone=getEl("truxAccountPhoneText");if(phone)phone.textContent=user?.phoneNumber||"Not provided by sign-in provider";
      const workspace=getEl("truxWorkspaceSummary");if(workspace)workspace.textContent=(isTruxDeveloper(user)?"Owner workspace":currentPlanTier==="pro"?"Pro workspace":"Personal workspace")+" · TruX-Omni";
      TRUX_NOTIFICATION_CATEGORIES.forEach(key=>{
        const id="notif"+({codex:"Codex",group_chats:"GroupChats",health:"Health",library:"Library",marketing:"Marketing",tips:"Tips",projects:"Projects",responses:"Responses",tasks:"Tasks",usage:"Usage"}[key]||key);
        const el=getEl(id);if(el)el.checked=store.getItem("trux_notification_cat_"+key)!=="false";
      });
      applyTruxTheme(store.getItem("trux_theme")||"dark",false);
      populateTruxSpeechVoices();
      try{refreshTruxMemorySummary();}catch{}
      try{updateTruxStorageSummary();}catch{}
    }
    function getTruxSystemInstruction() {
      const parts=[], custom=store.getItem("trux_custom_instructions")||"";
      if(custom.trim())parts.push(custom.trim());
      const style=store.getItem("trux_base_style")||"Default", warmth=store.getItem("trux_warmth")||"Default", enthusiasm=store.getItem("trux_enthusiasm")||"Default", formatting=store.getItem("trux_formatting")||"Default", emoji=store.getItem("trux_emoji")||"Default";
      if(style!=="Default")parts.push("Response style preference: "+style+".");
      if(warmth!=="Default")parts.push("Warmth preference: "+warmth+".");
      if(enthusiasm!=="Default")parts.push("Enthusiasm preference: "+enthusiasm+".");
      if(formatting!=="Default")parts.push("Formatting preference for headers and lists: "+formatting+".");
      if(emoji!=="Default")parts.push("Emoji preference: "+emoji+".");
      if(store.getItem("trux_fast_answers")!=="false")parts.push("Prefer fast, direct answers; add depth when the task requires it or the user asks.");
      if(store.getItem("trux_memory_enabled")!=="false"){
        const memory=[["Nickname",store.getItem("trux_nickname")],["Occupation",store.getItem("trux_occupation")],["User preferences",store.getItem("trux_about")]].filter(row=>row[1]).map(row=>row[0]+": "+row[1]);
        if(memory.length)parts.push("User-provided profile preferences (use only when relevant):\n"+memory.join("\n"));
      }
      if(store.getItem("trux_reduce_sensitive")==="true")parts.push("Use extra care with sensitive topics: be measured, avoid unnecessary detail, and prioritize safe, constructive guidance.");
      return parts.join("\n\n");
    }
    function storeDictationHistory(text) {
      if(store.getItem("trux_dictation_history")!=="true"||!String(text||"").trim())return;
      let rows=[];try{rows=JSON.parse(store.getItem("trux_dictation_history_items")||"[]");if(!Array.isArray(rows))rows=[];}catch{}
      rows.unshift({text:String(text).trim().slice(0,1000),at:new Date().toISOString()});store.setItem("trux_dictation_history_items",JSON.stringify(rows.slice(0,30)));
    }
    function showDictationHistory() {
      const host=getEl("truxDictationHistoryList");if(!host)return;host.replaceChildren();
      let rows=[];try{rows=JSON.parse(store.getItem("trux_dictation_history_items")||"[]");if(!Array.isArray(rows))rows=[];}catch{}
      const note=document.createElement("p");note.className="mrow-sub";note.textContent=store.getItem("trux_dictation_history")==="true"?"Saved locally on this device.":"History saving is off. Turn it on to keep future recognized phrases.";host.appendChild(note);
      rows.forEach(row=>{const item=document.createElement("p");item.className="dictation-history-item";item.textContent=(row.at?new Date(row.at).toLocaleString()+" — ":"")+String(row.text||"");host.appendChild(item);});
      if(rows.length){const clear=document.createElement("button");clear.type="button";clear.className="mbtn danger";clear.textContent="Delete dictation history";clear.onclick=()=>{store.removeItem("trux_dictation_history_items");showDictationHistory();};host.appendChild(clear);}
    }
    function applyTimeManagementSettings() {
      if(truxFocusReminderTimer){clearTimeout(truxFocusReminderTimer);truxFocusReminderTimer=null;}
      if(store.getItem("trux_focus_reminder")!=="true")return;
      const minutes=Math.max(5,Math.min(180,Number(store.getItem("trux_focus_interval")||45)));
      truxFocusReminderTimer=setTimeout(function tick(){if(!document.hidden)toast("Time for a short break. Stretch, rest your eyes, or step away briefly.","ok");applyTimeManagementSettings();},minutes*60000);
    }
    function openPluginsFromSettings() {
      closeProfileModal();
      if(typeof openPluginsPage==="function")openPluginsPage();else toast("Plugins are not available right now. Please refresh TruX.","err");
    }
    function updateTruxStorageSummary() {
      const host=getEl("truxStorageSummary");if(!host)return;
      let total=0,imageBytes=0,fileBytes=0,chats=0,archived=0;
      try{total=new Blob([JSON.stringify(chatSessions||{})]).size;Object.values(chatSessions||{}).forEach(chat=>{if(!chat||chat.incognito)return;if(chat.archived)archived++;chats++;(chat.messages||[]).forEach(message=>{if(message?.image)imageBytes+=String(message.image).length;if(message?.file)fileBytes+=String(message.file).length;});});}catch{}
      const fmt=n=>n<1024?n+" B":n<1048576?(n/1024).toFixed(1)+" KB":(n/1048576).toFixed(2)+" MB";
      host.textContent=cloudChatsReady ? "Account chat history (Firestore): approx. "+fmt(total)+" · "+chats+" chats · "+archived+" archived · image data "+fmt(imageBytes)+" · file data "+fmt(fileBytes)+". Conversation content is stored in your account, not device storage." : "Sign in to load account chat history from Firestore.";
    }
    function viewArchivedChats() {
      const host=getEl("archivedChatsList");if(!host)return;host.replaceChildren();
      const rows=Object.entries(chatSessions||{}).filter(([id,chat])=>chat&&chat.archived&&!chat.incognito);
      const title=document.createElement("p");title.className="mrow-sub";title.textContent=rows.length?"Archived conversations":"No archived chats.";host.appendChild(title);
      rows.forEach(([id,chat])=>{const row=document.createElement("div");row.className="archived-chat-row";const label=document.createElement("span");label.textContent=chat.title||"Untitled chat";const restore=document.createElement("button");restore.type="button";restore.className="mbtn";restore.textContent="Restore";restore.onclick=()=>restoreArchivedChat(id);row.append(label,restore);host.appendChild(row);});
      updateTruxStorageSummary();
    }
    function restoreArchivedChat(id) {
      const chat=chatSessions&&chatSessions[id];if(!chat||!chat.archived)return;
      chat.archived=false;saveChatSessions();renderSidebar();viewArchivedChats();toast("Chat restored to history.","ok");
    }
    function archiveAllHistory() {
      const entries=Object.entries(chatSessions||{}).filter(([id,chat])=>chat&&!chat.incognito&&!chat.archived);
      if(!entries.length){toast("There are no active chats to archive.");viewArchivedChats();return;}
      if(!confirm("Archive all regular chat history? You can restore archived chats later."))return;
      entries.forEach(([id,chat])=>{chat.archived=true;});saveChatSessions();
      if(currentChatId&&chatSessions[currentChatId]?.archived){currentChatId=null;startNewChat();}
      renderSidebar();viewArchivedChats();updateTruxStorageSummary();toast("Chat history archived.","ok");
    }

    function saveTTSRate(val) { store.setItem("trux_tts_rate", val); }
    function saveCustomInstructions() { store.setItem("trux_custom_instructions", getEl("customInstructions").value.trim()); toast("System instructions saved.", "ok"); }
    function loadCustomInstructions() { let el = getEl("customInstructions"); if(el) el.value = store.getItem("trux_custom_instructions") || ""; }
    function toggleAmbientGlow(el) { let bg = getEl("bg"); if(bg) bg.style.display = el.checked ? "block" : "none"; store.setItem("trux_ambient_glow", el.checked ? "true" : "false"); }
    function loadSettings() {
      let nT = getEl("neonGlowToggle"), aR = getEl("autoReadToggle"), tts = getEl("ttsRateSelect");
      if(nT) { nT.checked = store.getItem("trux_ambient_glow") !== "false"; toggleAmbientGlow(nT); }
      if(aR) aR.checked = store.getItem("trux_auto_read") === "true";
      if(tts) tts.value = store.getItem("trux_tts_rate") || "1.0";
      loadCustomInstructions();
      
      updateLocationSettingUI();
      updateNotificationSettingsUI();
      loadSupplementarySettings();
      applyTimeManagementSettings();
    }

    function exportChatData() {
      let a = document.createElement("a");
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(chatSessions, null, 2));
      a.download = `trux-omni-chat_${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove();
    }
    async function checkApiLatency() {
      let t = performance.now();
      try { await fetch("/api/chat", { cache: "no-store" }); toast(`Backend reachable - ${Math.round(performance.now() - t)} ms`, "ok"); } catch { toast("Backend check failed.", "err"); }
    }
    function resetAllSettings() { if(confirm("Reset all settings?")) { ["trux_custom_instructions","trux_auto_read","trux_ambient_glow","trux_tts_rate","trux_home_look","trux_location_enabled","trux_location_granted","trux_location_prompted","trux_avatar_override","trux_theme","trux_profile_display_name",...TRUX_PROFILE_PREFERENCES.map(k=>"trux_"+k),"trux_age_group","trux_dictation_language","trux_speech_voice","trux_dictation_history_items",...TRUX_NOTIFICATION_CATEGORIES.map(k=>"trux_notification_cat_"+k)].forEach(k => store.removeItem(k)); loadSettings(); } }
    async function clearAllHistory() {
      if(!confirm("Delete all chats saved to this TruX account? This cannot be undone.")) return;
      cloudChatLoadGeneration += 1;
      clearTimeout(cloudChatSyncTimer);
      const user = auth?.currentUser;
      chatSessions = {};
      cloudChatSyncedFingerprints.clear();
      pendingDeletedCloudChatIds.clear();
      currentChatId = null;
      cloudChatsReady = !!user && cloudChatsOwnerUid === user.uid;
      startNewChat();
      closeSettingsModal();
      if(!user) {
        toast("Sign in to clear account chat history.", "err");
        return;
      }
      const uid = user.uid;
      const task = cloudChatSyncChain.catch(() => {}).then(async () => {
        if(!auth?.currentUser || auth.currentUser.uid !== uid) return false;
        const response = await truxAuthenticatedFetch("/api/chat/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({ action: "clear" })
        }, user);
        if(!response.ok) throw new Error(await response.text().catch(() => "Cloud history could not be cleared."));
        return true;
      }).catch(error => {
        console.warn("Could not clear account cloud chat history:", error?.message || error);
        return false;
      });
      cloudChatSyncChain = task.then(() => undefined, () => undefined);
      const cleared = await task;
      if(cleared) toast("Account chat history cleared.", "ok");
      else toast("Cloud history could not be cleared. Please retry.", "err");
    }

    async function handleAuthAction() {
      if (!truxAuthStateReady) {
        const restoredUser = await waitForTruxAuthState();
        if (restoredUser === undefined && !truxAuthStateReady) {
          toast("Your sign-in session is still loading. Please try again.", "err");
          return;
        }
      }
      if (!auth?.currentUser) return openLoginWall();
      closeProfileOption();
      const user = auth.currentUser;
      updateTruxProfileUI(user);
      const plan = getEl("profilePlanText");
      if(plan) plan.innerText = isTruxDeveloper(user) ? "Owner" : (currentPlanTier === "pro" ? "Pro" : "Core");
      const model = getEl("profileModelText"); if(model) model.innerText = "Auto";
      const limit = getEl("profileLimitText"); if(limit) limit.innerText = "Unlimited";
      const modal = getEl("profileModal");
      if(modal){ modal.removeAttribute("data-settings-view"); modal.style.display = "flex"; modal.setAttribute("aria-hidden","false"); }
      void refreshTruxProfileInfo(user);
    }
    function closeProfileModal() {
      const modal=getEl("profileModal");
      if(!modal) return;
      modal.style.display="none";
      modal.removeAttribute("data-settings-view");
      modal.setAttribute("aria-hidden","true");
      closeProfileOption();
    }
    function switchSettingsSection(name) {
      if (String(name || "") === "home") { showSettingsHome(); return; }
      const validSections = ["general","appearance","voice","personalization","usage","data","account","developer"];
      const requested = String(name || "general");
      const hasSection = validSections.includes(requested) &&
        Array.from(document.querySelectorAll("[data-settings-content]")).some(section => section.getAttribute("data-settings-content") === requested);
      const activeSection = hasSection ? requested : "general";
      const settingsModal = getEl("profileModal");
      if (settingsModal) settingsModal.dataset.settingsView = "section";
      document.querySelectorAll("[data-settings-content]").forEach(section => {
        section.classList.toggle("active", section.getAttribute("data-settings-content") === activeSection);
      });
      document.querySelectorAll(".settings-nav button[data-settings-section]").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-settings-section") === activeSection);
      });
      const scroller = document.querySelector(".settings-main-scroll");
      if (scroller) scroller.scrollTop = 0;
      const mobileSelect=getEl("settingsMobileSelect"); if(mobileSelect) mobileSelect.value=activeSection;
      if (activeSection === "developer" && isTruxDeveloper(auth?.currentUser)) {
        void loadOwnerGeminiModels(false);
      }
    }
    function showSettingsHome() {
      closeSettingsModal();
    }
    function handleSettingsBack() {
      const modal = getEl("profileModal");
      if (modal && modal.dataset.settingsView === "section") {
        showSettingsHome();
        return;
      }
      closeSettingsModal();
    }
    function openSettingsModal(section) {
      const modal = getEl("profileModal");
      if (!modal) {
        toast("Settings could not load. Please refresh TruX and try again.", "err");
        return;
      }
      modal.style.display = "flex";
      modal.setAttribute("aria-hidden", "false");
      const requested = String(section || "home");
      try {
        if (requested === "home") closeSettingsModal();
        else switchSettingsSection(requested);
      } catch (error) {
        console.error("TruX Settings navigation failed:", error);
        try { showSettingsHome(); } catch {}
      }
      try { updateAllUsageUI(); } catch (error) { console.warn("Settings usage refresh deferred:", error); }
      try { loadSettings(); } catch (error) { console.warn("Settings preferences refresh deferred:", error); }
      try { updateLocationSettingUI(); } catch (error) { console.warn("Settings location refresh deferred:", error); }
      try { updateNotificationSettingsUI(); } catch (error) { console.warn("Settings notifications refresh deferred:", error); }
    }
    function closeSettingsModal() {
      const modal = getEl("profileModal");
      if (!modal) return;
      modal.removeAttribute("data-settings-view");
      modal.setAttribute("aria-hidden", "false");
      const scroller = document.querySelector(".settings-main-scroll");
      if (scroller) scroller.scrollTop = 0;
      closeProfileOption();
    }
    function confirmSignOut() { auth?.signOut().then(() => { closeProfileModal(); }); }

    function openCodeSandbox(codeId, extension) {
      const source = getEl(codeId);
      const frame = getEl("sandboxFrame");
      const codeText = source?.value || "";
      if (!source || !frame) return;

      // Preview runs in an opaque-origin iframe: scripts can run, but they
      // cannot read the parent app's DOM, Firebase session, or local storage.
      frame.setAttribute("sandbox", "allow-scripts");
      const ext = String(extension || source.dataset.extension || "html").toLowerCase();
      if (ext === "js") {
        // A bare JS code block is not an HTML document. Wrap it so the Run
        // button truly executes it and surfaces console output/runtime errors.
        const safeScript = codeText.replace(/<\/script/gi, "<\\/script");
        frame.srcdoc = [
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
          '<style>html,body{margin:0;min-height:100%;}body{box-sizing:border-box;padding:12px;font:13px/1.45 system-ui,sans-serif;color:#202124;background:#fff}#trux-code-console{margin-top:12px;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;background:#f1f2f4;color:#41444b;font:12px/1.5 ui-monospace,monospace}#trux-code-console:empty{display:none}</style></head><body>',
          '<pre id="trux-code-console" aria-live="polite"></pre>',
          '<script>(function(){var out=document.getElementById("trux-code-console");var fmt=function(v){try{return typeof v==="string"?v:JSON.stringify(v)}catch(e){return String(v)}};["log","info","warn","error"].forEach(function(key){var native=console[key].bind(console);console[key]=function(){native.apply(console,arguments);var line=Array.from(arguments).map(fmt).join(" ");out.textContent+=(out.textContent?"\\n":"")+line;};});window.addEventListener("error",function(e){out.textContent+=(out.textContent?"\\n":"")+"Error: "+String(e.message||"Script failed");});})();', 
          String.fromCharCode(10),
          safeScript,
          String.fromCharCode(10),
          '</' + 'script></body></html>'
        ].join("");
      } else {
        // Full HTML previews execute inside the same restricted iframe.
        frame.srcdoc = codeText;
      }
      getEl("sandboxModal").style.display = "flex";
    }
    function closeSandboxModal() { getEl("sandboxModal").style.display = "none"; }

    function pinInsight(text) {
      if(pinnedInsights.includes(text)) return toast("That insight is already pinned.");
      pinnedInsights.push(text);
      store.setItem("trux_pinned", JSON.stringify(pinnedInsights));
      toast("Pinned to insights.", "ok");
    }
    function openPinnedInsightsModal() {
      let list = getEl("pinnedList");
      if(!pinnedInsights.length) {
        list.innerHTML = '<div class="empty">No pinned insights yet.<br>Use <b>Pin</b> on any answer to save it here.</div>';
      } else {
        list.innerHTML = pinnedInsights.map((t, idx) => {
          let clean = plainPreview(t);
          return `<div class="pin-card"><p>${escapeHtml(clean.slice(0, 190))}${clean.length > 190 ? "…" : ""}</p><button class="pin-remove" onclick="removePinnedInsight(${idx})">${ICON.trash}Remove</button></div>`;
        }).join('');
      }
      getEl("pinnedModal").style.display = "flex";
    }
    function removePinnedInsight(idx) {
      pinnedInsights.splice(idx, 1);
      store.setItem("trux_pinned", JSON.stringify(pinnedInsights));
      openPinnedInsightsModal();
    }
    function closePinnedModal() { getEl("pinnedModal").style.display = "none"; }
    
    function setSidebarOpen(open) {
      const s = getEl("sidebarNode"), overlay = getEl("sidebarOverlay");
      if(!s) return;
      s.classList.toggle("open", !!open);
      overlay?.classList.toggle("active", !!open);
      document.body.classList.toggle("sidebar-open", !!open);
    }

    function toggleSidebar(e) {
      if(e) e.stopPropagation();
      const s = getEl("sidebarNode");
      setSidebarOpen(!s?.classList.contains("open"));
    }

    function closeSidebar() {
      setSidebarOpen(false);
      closeSidebarChatSearch();
    }

    function syncMobileSidebarState() {
      const s = getEl("sidebarNode"), overlay = getEl("sidebarOverlay");
      if(!s || !overlay) return;
      const open = s.classList.contains("open");
      overlay.classList.toggle("active", open);
      document.body.classList.toggle("sidebar-open", open);
    }
    addEventListener("resize", syncMobileSidebarState);

    function focusSidebarChatSearch() {
      const wrap = getEl("sidebarSearchWrap"), input = getEl("historySearch");
      if(!wrap || !input) return;
      wrap.hidden = false;
      requestAnimationFrame(() => input.focus());
    }

    function closeSidebarChatSearch() {
      const wrap = getEl("sidebarSearchWrap"), input = getEl("historySearch");
      if(!wrap) return;
      wrap.hidden = true;
      if(input && input.value) { input.value = ""; renderSidebar(); }
    }

    function bindChatScroll(container) {
      container?.addEventListener("scroll", function() {
        if(this !== getActiveChatContainer()) return;
        isScrolledUp = (this.scrollHeight - this.scrollTop - this.clientHeight) > 80;
        getEl("scrollDownBtn").classList.toggle("visible", isScrolledUp && this.children.length > 0);
        document.body.classList.toggle("scrolled", this.scrollTop > 4);
      });
    }
    bindChatScroll(getEl("chatContainer"));
    bindChatScroll(getEl("codeChatContainer"));
    function scrollToBottom() {
      const container = getActiveChatContainer();
      container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      getEl("scrollDownBtn").classList.remove("visible");
    }

    function detectCodeInInput(text) {
      if (!text) return false;
      let hasCodeBlock = text.includes("```");
      let hasCodePattern = /function\s*\w*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|class\s+\w+|import\s+.*from|def\s+\w+\(|<html|<div|public\s+class|select\s+.*from/i.test(text);
      let isLongStructure = text.split('\n').length > 5 || text.length > 280;
      return hasCodeBlock || (hasCodePattern && isLongStructure);
    }

    function shouldAttachPastedText(text) {
      return !!text && (text.split(/\r\n|\r|\n|\u2028|\u2029/).length > 15 || detectCodeInInput(text));
    }

    function getPasteText(e) {
      try {
        const clip = e?.clipboardData || e?.dataTransfer || window.clipboardData;
        return clip?.getData?.("text/plain") || clip?.getData?.("text") || "";
      } catch (_) {
        return "";
      }
    }

    /* Long paste handling:
       On Android the paste event's clipboardData can be empty, while
       beforeinput/input still exposes the actual edit. Keep the pre-paste
       value and recover the inserted text from the resulting textarea value. */
    let pendingPromptPaste = null;

    getEl("promptInput").addEventListener("beforeinput", e => {
      if(e.inputType !== "insertFromPaste") return;

      const p = e.target;
      const text = getPasteText(e);

      if(shouldAttachPastedText(text)) {
        e.preventDefault();
        pendingPromptPaste = null;
        attachCodeAsFile(text);
        return;
      }

      const start = typeof p.selectionStart === "number" ? p.selectionStart : p.value.length;
      const end = typeof p.selectionEnd === "number" ? p.selectionEnd : start;
      pendingPromptPaste = {
        value: p.value,
        start,
        end,
        timer: setTimeout(() => { pendingPromptPaste = null; }, 1000)
      };
    });

    getEl("promptInput").addEventListener("paste", e => {
      const p = e.target;
      const text = getPasteText(e);

      if(shouldAttachPastedText(text)) {
        e.preventDefault();
        if(pendingPromptPaste?.timer) clearTimeout(pendingPromptPaste.timer);
        pendingPromptPaste = null;
        attachCodeAsFile(text);
        return;
      }

      /* Some mobile WebViews fire paste but expose no clipboard payload.
         Capture the pre-paste selection here so the following input event
         can recover the inserted text from the textarea itself. */
      if(!text && !pendingPromptPaste) {
        const start = typeof p.selectionStart === "number" ? p.selectionStart : p.value.length;
        const end = typeof p.selectionEnd === "number" ? p.selectionEnd : start;
        pendingPromptPaste = {
          value: p.value,
          start,
          end,
          timer: setTimeout(() => { pendingPromptPaste = null; }, 1000)
        };
      }
    });

    /* Final fallback: some Android keyboards/WebViews expose paste only as
       a normal "input" edit. Compare the value before and after every input,
       so long pasted text is caught even when paste/beforeinput contain no
       clipboard data at all. */
    let lastPromptInputValue = getEl("promptInput").value || "";

    getEl("promptInput").addEventListener("input", e => {
      const p = e.target;
      const current = p.value;
      const pending = pendingPromptPaste;

      if(pending) {
        if(pending.timer) clearTimeout(pending.timer);
        pendingPromptPaste = null;

        const before = pending.value;
        const start = pending.start;
        const end = pending.end;
        const insertedLength = Math.max(0, current.length - before.length + (end - start));
        const inserted = current.slice(start, start + insertedLength);

        if(shouldAttachPastedText(inserted)) {
          p.value = before;
          lastPromptInputValue = before;
          attachCodeAsFile(inserted);
          handleInputChange();
          return;
        }
      }

      const before = lastPromptInputValue;
      lastPromptInputValue = current;

      if(!current || current === before) return;

      /* When the composer was empty, the whole new value is the inserted
         paste. This is the common Android case that the earlier fallback
         accidentally skipped. */
      let prefix = 0;
      const maxPrefix = Math.min(before.length, current.length);
      while(prefix < maxPrefix && before.charCodeAt(prefix) === current.charCodeAt(prefix)) prefix++;

      let suffix = 0;
      const maxSuffix = Math.min(before.length - prefix, current.length - prefix);
      while(suffix < maxSuffix &&
            before.charCodeAt(before.length - 1 - suffix) === current.charCodeAt(current.length - 1 - suffix)) suffix++;

      const inserted = current.slice(prefix, current.length - suffix);

      if(shouldAttachPastedText(inserted)) {
        p.value = before;
        lastPromptInputValue = before;
        attachCodeAsFile(inserted);
        handleInputChange();
      }
    });

    function attachCodeAsFile(text) {
      if(!text) return;
      let id = Date.now() + Math.floor(Math.random() * 1000);
      let cleanFirstLine = text.trim().split(/\r?\n/)[0].substring(0, 28).replace(/```/g, '');
      let fileType = /<html|<div/i.test(text) ? "HTML Code" : (/function|const|let|var|def|class\s/i.test(text) ? "Source Code" : "Text Attachment");
      let snippet = `${fileType}: ${cleanFirstLine || "Pasted content"}…`;
      pastedTextBlocks.push({ id, name: `pasted-${pastedTextBlocks.length + 1}.txt`, text, snippet });
      renderFileChips();
      handleInputChange();
    }

    function updateComposerAttachments() {
      const tray = getEl("composerAttachments");
      const hasFiles = pastedTextBlocks.length > 0 || fileAttachments.length > 0;
      const hasImage = !!getEl("imagePreviewContainer")?.classList.contains("visible");
      if (tray) tray.classList.toggle("has-items", hasFiles || hasImage);
    }
    function renderFileChips() {
      let c = getEl("chipContainer");
      let all = pastedTextBlocks.concat(fileAttachments);
      if(!all.length) { c.style.display = "none"; c.innerHTML = ""; updateComposerAttachments(); return; }
      c.style.display = "flex";
      c.innerHTML = all.map(b => {
        const label = b.processing ? (b.name || "Attachment") + " · Processing…" : (b.snippet || (b.name || "Attachment") + " · " + Math.ceil((b.size || (b.text || "").length) / 1024) + " KB");
        return `<div class="file-chip"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8L14 3.5Z"/><path d="M13.5 4v4.5H18"/></svg> ${escapeHtml(label)} <button type="button" aria-label="Remove attachment" onclick="removeFileChip(${b.id})">×</button></div>`;
      }).join('');
      updateComposerAttachments();
    }
    function removeFileChip(id) {
      pastedTextBlocks = pastedTextBlocks.filter(b => b.id !== id);
      fileAttachments = fileAttachments.filter(b => b.id !== id);
      renderFileChips();
      handleInputChange();
    }

    let sidebarSyncTimer = null;
    let cloudChatSyncTimer = null;
    let cloudChatRetryTimer = null;
    let cloudChatRetryDelayMs = 1500;
    function queueSidebarSync() {
      clearTimeout(sidebarSyncTimer);
      sidebarSyncTimer = setTimeout(() => {
        try {
          renderSidebar();
          if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
        } catch (e) { /* ignore */ }
      }, 120);
    }

    function isPersistableChatSession(chat) {
      return !!chat && typeof chat === "object" && !Array.isArray(chat) && chat.incognito !== true;
    }

    function updateCloudChatStatus(state, message = "") {
      const host = getEl("cloudChatStatus");
      if(!host) return;

      host.dataset.state = state;
      host.replaceChildren();
      const visible = state === "loading" || state === "error" || state === "sync-error";
      host.hidden = !visible;
      if(!visible) return;

      const copy = document.createElement("div");
      copy.className = "cloud-chat-status-copy";
      const heading = document.createElement("strong");
      const detail = document.createElement("span");
      if(state === "loading") {
        heading.textContent = "Loading account chats";
        detail.textContent = "Checking saved conversations for your signed-in account…";
      } else if(state === "sync-error") {
        heading.textContent = "Chat changes are not saved yet";
        detail.textContent = message || "The cloud save was not confirmed. Keep this page open and retry.";
      } else {
        heading.textContent = "Saved chats could not be loaded";
        detail.textContent = message || "TruX could not verify the saved history for this account.";
      }
      copy.append(heading, detail);

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "cloud-chat-status-retry";
      retry.textContent = "Retry";
      retry.onclick = () => {
        const user = auth?.currentUser;
        if(!user) {
          handleAuthAction();
          return;
        }
        if(state === "sync-error" && cloudChatsReady && cloudChatsOwnerUid === user.uid) {
          void syncChatsToCloud(true);
        } else {
          void loadChatsFromCloud(user, true);
        }
      };
      host.append(copy, retry);
    }

    function cloudChatLoadErrorMessage(error) {
      const status = Number(error?.status || 0);
      const message = String(error?.message || "");
      if(status === 401 || /invalid or expired authentication token|authentication required/i.test(message)) {
        return "The server rejected this sign-in token. Sign out, sign in again, then press Retry.";
      }
      if(status === 403 || /different account|account does not match/i.test(message)) {
        return "The signed-in account does not match the account authorized for this chat request. Your saved chats were not changed.";
      }
      if(status === 503 || /CHAT_HISTORY_UNREADABLE|could not be decoded/i.test(message)) {
        return "The database returned saved records it could not read. Those records were not deleted. Retry after checking the server connection.";
      }
      if(/different account/i.test(message)) {
        return "The chat service returned a different account identity. Your saved chats were not changed.";
      }
      return "Cloud history request failed" + (status ? " (HTTP " + status + ")" : "") +
        (message ? ": " + message.slice(0, 240) : ".") +
        " Your chats were not deleted by this screen.";
    }

    function scheduleCloudChatRetry(uid) {
      if(cloudChatRetryTimer || !uid) return;
      const delay = cloudChatRetryDelayMs;
      cloudChatRetryDelayMs = Math.min(30000, cloudChatRetryDelayMs * 2);
      cloudChatRetryTimer = setTimeout(() => {
        cloudChatRetryTimer = null;
        if(auth?.currentUser?.uid !== uid || cloudChatsOwnerUid !== uid) return;
        if(navigator.onLine === false) {
          scheduleCloudChatRetry(uid);
          return;
        }
        // A failed history read must be retried before normal sync can start.
        // Requiring cloudChatsReady here deadlocked the retry after one read error.
        if(!cloudChatsReady) {
          void loadChatsFromCloud(auth.currentUser, true);
          return;
        }
        void syncChatsToCloud(true);
      }, delay);
    }

    async function loadChatsFromCloud(user, isRetry = false) {
      if(!user?.uid) return false;
      const uid = String(user.uid);
      const sameAccount = cloudChatsOwnerUid === uid;
      const generation = ++cloudChatLoadGeneration;

      // Keep this account's in-memory state while refreshing it. Clearing it before
      // the read succeeds made a transient Storage/auth error look like data loss.
      cloudChatsReady = false;
      cloudChatsOwnerUid = uid;
      cloudChatLoadState = "loading";
      cloudChatStatusMessage = "";
      updateCloudChatStatus("loading");
      if(!sameAccount) {
        chatSessions = {};
        cloudChatSyncedFingerprints.clear();
        pendingDeletedCloudChatIds.clear();
        currentChatId = null;
        getEl("chatContainer")?.replaceChildren();
        getEl("codeChatContainer")?.replaceChildren();
        getEl("welcomeScreen")?.style.setProperty("display", "block", "important");
        document.body.classList.remove("chat-session-active", "coding-workspace");
        document.body.classList.add("home-active");
      }
      clearTimeout(cloudChatSyncTimer);
      renderSidebar();

      try {
        const response = await truxAuthenticatedFetch("/api/chat/sync", {
          method: "GET",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" }
        }, user);
        if(!response.ok) {
          const detail = await response.text().catch(() => "");
          const error = new Error(detail || "Cloud chat history could not be loaded (HTTP " + response.status + ").");
          error.status = response.status;
          throw error;
        }
        const result = await response.json();
        if(result?.ok !== true || !result.chats || typeof result.chats !== "object" || Array.isArray(result.chats)) {
          throw new Error("Cloud chat history returned an invalid response.");
        }
        if(String(result.userId || "") !== uid) {
          const error = new Error("Cloud history account ID did not match the signed-in account.");
          error.status = 403;
          throw error;
        }
        if(generation !== cloudChatLoadGeneration || auth?.currentUser?.uid !== uid) return false;

        const remoteChats = Object.fromEntries(
          Object.entries(result.chats).filter(([_, chat]) => isPersistableChatSession(chat))
        );

        // Preserve only in-memory edits made while this Firestore read was in flight.
        // Firestore is authoritative; a missing remote chat is not restored from device cache.
        const localUnsynced = new Map();
        for(const [id, chat] of Object.entries(chatSessions)) {
          if(!isPersistableChatSession(chat) || pendingDeletedCloudChatIds.has(id)) continue;
          if(cloudChatSyncedFingerprints.get(id) !== JSON.stringify(chat)) {
            localUnsynced.set(id, chat);
          }
        }

        const nextChats = { ...remoteChats };
        for(const [id, chat] of localUnsynced) nextChats[id] = chat;
        for(const id of pendingDeletedCloudChatIds) delete nextChats[id];

        chatSessions = Object.fromEntries(
          Object.entries(nextChats).filter(([_, chat]) => isPersistableChatSession(chat))
        );

        cloudChatSyncedFingerprints.clear();
        for(const [id, chat] of Object.entries(remoteChats)) {
          if(!pendingDeletedCloudChatIds.has(id)) {
            cloudChatSyncedFingerprints.set(id, JSON.stringify(chat));
          }
        }
        // Locally changed/new records intentionally keep the previous fingerprint
        // (or no fingerprint) so the normal sync path uploads them after load.
        clearTimeout(cloudChatRetryTimer);
        cloudChatRetryTimer = null;
        cloudChatRetryDelayMs = 1500;
        cloudChatsReady = true;
        cloudChatLoadState = "ready";
        cloudChatStatusMessage = "";
        updateCloudChatStatus("ready");
        renderSidebar();
        if(isRetry) toast("Cloud chat history restored.", "ok");
        updateTruxStorageSummary();
        if(Number(result.unreadableRecords || 0) > 0) {
          toast(
            "Restored the readable chats. " + Number(result.unreadableRecords) +
            " stored Firestore record(s) could not be read; those records were left untouched.",
            "err"
          );
        }

        const needsSync =
          Array.from(localUnsynced.keys()).some(id =>
            JSON.stringify(chatSessions[id]) !== cloudChatSyncedFingerprints.get(id)
          ) || pendingDeletedCloudChatIds.size > 0;
        if(needsSync) {
          const saved = await syncChatsToCloud(true);
          if(!saved) {
            toast("Your chats are shown, but cloud sync is still pending. Keep TruX open and check your connection.", "err");
            return true;
          }
        }

        // The conversation body was always cleared at startup, even after its
        // messages loaded successfully from Firestore. Restore the last
        // active conversation without keeping message content on this device.
        if(!currentChatId) {
          const activeKey = "trux_last_active_chat_id:" + uid;
          const suppressKey = "trux_suppress_latest_chat_restore:" + uid;
          const rememberedId = store.getItem(activeKey);
          const suppressLatest = store.getItem(suppressKey) === "1";
          const latestId = result.latestChatId;
          const restoreId = (rememberedId && chatSessions[rememberedId])
            ? rememberedId
            : (!suppressLatest && latestId && chatSessions[latestId] ? latestId : null);
          if(restoreId) loadChatSession(restoreId);
        }
        return true;
      } catch(error) {
        if(generation === cloudChatLoadGeneration && auth?.currentUser?.uid === uid) {
          // Never replace available in-memory history with an empty list on a
          // transient cloud read failure.
          cloudChatsReady = false;
          cloudChatLoadState = "error";
          cloudChatStatusMessage = cloudChatLoadErrorMessage(error);
          updateCloudChatStatus("error", cloudChatStatusMessage);
          renderSidebar();
          console.warn("TruX could not load account chat history from Firestore:", error?.status || "", error?.message || error);
          if(!isRetry) {
            toast("Cloud chat history could not be refreshed. Existing chats were preserved; retrying automatically.", "err");
          }
          scheduleCloudChatRetry(uid);
        }
        return false;
      }
    }

    async function syncChatsToCloud(immediate = false) {
      const currentUser = auth?.currentUser;
      if(!currentUser || !cloudChatsReady || cloudChatsOwnerUid !== currentUser.uid) return false;
      clearTimeout(cloudChatSyncTimer);

      const run = () => {
        const requestUser = auth?.currentUser;
        if(!requestUser || requestUser.uid !== cloudChatsOwnerUid) return Promise.resolve(false);
        const uid = requestUser.uid;
        const task = cloudChatSyncChain.catch(() => {}).then(async () => {
          if(!auth?.currentUser || auth.currentUser.uid !== uid || !cloudChatsReady || cloudChatsOwnerUid !== uid) return false;

          const changed = [];
          for(const [id, chat] of Object.entries(chatSessions)) {
            if(!isPersistableChatSession(chat)) continue;
            const serialized = JSON.stringify(chat);
            if(cloudChatSyncedFingerprints.get(id) !== serialized) changed.push({ id, serialized });
          }
          const deleted = Array.from(pendingDeletedCloudChatIds).filter(id => !Object.prototype.hasOwnProperty.call(chatSessions, id));
          if(!changed.length && !deleted.length) {
            if(cloudChatLoadState === "ready" && cloudChatStatusMessage && !cloudChatStatusMessage.includes("Cloud save failed")) {
              cloudChatStatusMessage = "";
              updateCloudChatStatus("ready");
            }
            cloudChatRetryDelayMs = 1500;
            clearTimeout(cloudChatRetryTimer);
            cloudChatRetryTimer = null;
            return true;
          }

          for(const item of changed) {
            if(!auth?.currentUser || auth.currentUser.uid !== uid) return false;
            const response = await truxAuthenticatedFetch("/api/chat/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
              body: JSON.stringify({ chatId: item.id, chat: JSON.parse(item.serialized) })
            }, requestUser);
            const result = await response.json().catch(() => null);
            if(!response.ok || result?.ok !== true || Number(result?.saved || 0) < 1) {
              const error = new Error(result?.error || "Cloud chat save was not confirmed (HTTP " + response.status + ").");
              error.status = response.status;
              throw error;
            }
            if(String(result.userId || "") !== uid) {
              throw new Error("Cloud chat save response did not match the signed-in account.");
            }
            if(JSON.stringify(chatSessions[item.id]) === item.serialized) {
              cloudChatSyncedFingerprints.set(item.id, item.serialized);
            }
          }

          for(const id of deleted) {
            if(!auth?.currentUser || auth.currentUser.uid !== uid) return false;
            const response = await truxAuthenticatedFetch("/api/chat/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
              body: JSON.stringify({ action: "delete", chatId: id })
            }, requestUser);
            const result = await response.json().catch(() => null);
            if(!response.ok || result?.ok !== true) {
              throw new Error(result?.error || "Cloud chat deletion was not confirmed.");
            }
            pendingDeletedCloudChatIds.delete(id);
            cloudChatSyncedFingerprints.delete(id);
          }
          cloudChatRetryDelayMs = 1500;
          clearTimeout(cloudChatRetryTimer);
          cloudChatRetryTimer = null;
          cloudChatStatusMessage = "";
          updateCloudChatStatus("ready");
          return true;
        }).catch(error => {
          cloudChatStatusMessage = "Cloud save failed" + (error?.status ? " (HTTP " + error.status + ")" : "") +
            ": " + String(error?.message || error || "Unknown error").slice(0, 240) +
            ". This change is still pending; it may not survive refresh until the save succeeds.";
          updateCloudChatStatus("sync-error", cloudChatStatusMessage);
          console.warn("TruX account chat sync failed:", error?.status || "", error?.message || error);
          scheduleCloudChatRetry(uid);
          return false;
        });
        cloudChatSyncChain = task.then(() => undefined, () => undefined);
        return task;
      };

      if(immediate) return run();
      return new Promise(resolve => {
        cloudChatSyncTimer = setTimeout(() => { void run().then(resolve); }, 250);
      });
    }

    // Send one small keepalive write on page exit for changes still waiting in the
    // debounce queue. Larger payloads are already uploaded incrementally while active.
    function flushSmallChatChangesOnPageHide() {
      const user = auth?.currentUser;
      if(!user || cloudChatsOwnerUid !== user.uid || incognitoMode) return;
      const changedChats = {};
      for(const [id, chat] of Object.entries(chatSessions)) {
        if(!isPersistableChatSession(chat)) continue;
        const serialized = JSON.stringify(chat);
        if(cloudChatSyncedFingerprints.get(id) !== serialized) changedChats[id] = chat;
      }
      const deletedChatIds = Array.from(pendingDeletedCloudChatIds)
        .filter(id => !Object.prototype.hasOwnProperty.call(chatSessions, id));
      if(!Object.keys(changedChats).length && !deletedChatIds.length) return;

      const body = JSON.stringify({ chats: changedChats, deletedChatIds });
      if(new TextEncoder().encode(body).byteLength > 60 * 1024) return;
      void getTruxIdToken(user).then(token => {
        if(auth?.currentUser?.uid !== user.uid) return;
        return fetch("/api/chat/sync", {
          method: "POST",
          keepalive: true,
          cache: "no-store",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          },
          body
        });
      }).catch(error => {
        console.warn("Final keepalive chat sync could not be started:", error?.message || error);
      });
    }

    function saveChatSessions() {
      if(incognitoMode || (currentChatId && chatSessions[currentChatId]?.incognito)) return;
      const user = auth?.currentUser;
      if(user && currentChatId && isPersistableChatSession(chatSessions[currentChatId])) {
        store.setItem("trux_last_active_chat_id:" + user.uid, currentChatId);
        store.removeItem("trux_suppress_latest_chat_restore:" + user.uid);
      }
      queueSidebarSync();
      void syncChatsToCloud();
    }

    function launchIncognitoChat() {
      /* Incognito is a memory-only Chat workspace.
         It intentionally never enters localStorage/cloud sync and is removed on exit. */
      if (isGenerating) {
        if (activeTurnContext) persistTurnDraft(activeTurnContext, activeTurnContext.latestText || "", true);
        generationEpoch += 1;
        activeTurnContext = null;
        try { activeAbortController?.abort(); } catch {}
        try { activeStreamer?.cancel(); } catch {}
      }

      incognitoMode = true;
      workspaceMode = "chat";
      currentChatId = "incognito_" + Date.now() + "_" + Math.random().toString(36).slice(2);

      // Keep this turn completely outside persistent chat state.
      chatSessions[currentChatId] = {
        title: "Incognito",
        mode: "chat",
        incognito: true,
        messages: []
      };

      activeAbortController = null;
      activeStreamer = null;
      isGenerating = false;
      activeTurnContext = null;
      generationStopRequested = false;
      pastedTextBlocks = [];
      fileAttachments = [];
      selectedImageBase64 = null;

      closeSidebar();
      closeAttachmentMenu();
      closeModelDropdown();

      document.body.classList.remove("plugins-page-active","coding-workspace","home-active");
      document.body.classList.add("chat-session-active","incognito-mode");
      document.body.dataset.workspaceMode = "chat";
      document.body.removeAttribute("data-media-mode");
      handleInputChange();

      const chat = getEl("chatContainer");
      const code = getEl("codeChatContainer");
      if (chat) { chat.innerHTML = ""; chat.style.display = "block"; }
      if (code) { code.innerHTML = ""; code.style.display = "none"; }
      getEl("welcomeScreen")?.style.setProperty("display","none","important");

      const input = getEl("promptInput");
      if (input) {
        input.value = "";
        input.placeholder = "Ask privately…";
      }

      const incognitoNotice = document.createElement("div");
      incognitoNotice.className = "incognito-session-banner";
      incognitoNotice.innerHTML = "<span class=\"incognito-session-dot\"></span><span><b>Incognito</b><small>This chat stays in memory only and is not saved to history.</small></span>";
      chat.appendChild(incognitoNotice);
      chat.scrollTop = chat.scrollHeight;

      renderFileChips();
      handleInputChange();
      renderSidebar();
    }

    function closeIncognitoChat() {
      const input = getEl("promptInput");
      if (input) {
        input.value = "";
        input.placeholder = "Ask anything…";
      }
      startNewChat();
    }

    function startNewChat() {
      if(currentChatId && chatSessions[currentChatId]?.incognito) delete chatSessions[currentChatId];
      const user = auth?.currentUser;
      if(user) {
        store.removeItem("trux_last_active_chat_id:" + user.uid);
        store.setItem("trux_suppress_latest_chat_restore:" + user.uid, "1");
      }
      incognitoMode = false;
      document.body.classList.remove("plugins-page-active","incognito-mode","notebook-open");
      closeSidebar();
      closeAttachmentMenu();
      closeModelDropdown();

      // Use the same state transition as the Chat/TruX-Code switch so a new
      // Chat always clears coding-workspace and restores the normal home UI.
      setWorkspaceMode("chat", {reload:false,preserveSession:false,forceReset:true});

      isScrolledUp = false;
      getEl("scrollDownBtn")?.classList.remove("visible");
      document.body.classList.remove("scrolled");
    }
    function quickPrompt(txt) { getEl("promptInput").value = txt; getEl("promptInput").focus(); handleInputChange(); }
    
    function handleInputChange() {
      const p = getEl("promptInput");
      const minComposerHeight = document.body.matches('body[data-media-mode="image"], body[data-media-mode="video"]') ? 60 : 44;
      p.style.setProperty("height", "auto", "important");
      p.style.setProperty("height", Math.max(minComposerHeight, Math.min(p.scrollHeight, 200)) + "px", "important");
      const bar = p.closest(".bar");
      if (bar) bar.classList.remove("multiline");

      const btn = getEl("actionBtn");
      const isCodeWorkspace = workspaceMode === "coding" ||
        document.body.classList.contains("coding-workspace") ||
        document.body.dataset.workspaceMode === "coding";
      const hasDraft = !!(p.value.trim() || selectedImageBase64 || pastedTextBlocks.length || fileAttachments.length);

      // While a request is live, always show a real Stop action. Stale idle/live
      // classes after mode switches used to override this button's visual state.
      if (btn && isGenerating) {
        btn.classList.remove("live", "live-active", "ready", "code-idle");
        btn.classList.add("stop");
        btn.dataset.actionMode = "stop";
        btn.title = "Stop generation";
        btn.setAttribute("aria-label", btn.title);
        const icon = getEl("btnIcon");
        if (icon) {
          icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>';
          icon.style.opacity = "1";
          icon.style.transform = "translateY(0) scale(1)";
        }
      } else if (btn) {
        const wasStopping = btn.classList.contains("stop");
        btn.classList.remove("stop");
        if (wasStopping || btn.dataset.actionMode === "stop") btn.dataset.actionMode = "";
        const liveActive = window.__truxLiveState === "live" || window.__truxLiveState === "connecting";
        const nextMode = hasDraft ? "send" : (isCodeWorkspace ? "code-idle" : (liveActive ? "live-stop" : "live"));
        btn.classList.toggle("ready", hasDraft);
        btn.classList.toggle("live", !hasDraft && !isCodeWorkspace);
        btn.classList.toggle("live-active", !hasDraft && !isCodeWorkspace && liveActive);
        btn.classList.toggle("code-idle", isCodeWorkspace && !hasDraft);
        btn.title = hasDraft ? "Send message" : (isCodeWorkspace ? "Enter a coding task" : (liveActive ? "Stop Live assistant" : "Start Live assistant"));
        btn.setAttribute("aria-label", btn.title);
        const icon = getEl("btnIcon");
        if (icon && btn.dataset.actionMode !== nextMode) {
          btn.dataset.actionMode = nextMode;
          const icons = {
            send: '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>',
            "code-idle": '<path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
            live: '<path d="M3 12h2l2-5 4 10 3-14 3 9h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
            "live-stop": '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>'
          };
          icon.style.opacity = "0";
          icon.style.transform = nextMode === "send" ? "translateY(3px) scale(.78)" : "translateY(-3px) scale(.78)";
          requestAnimationFrame(() => {
            if (!btn.isConnected || btn.dataset.actionMode !== nextMode) return;
            icon.innerHTML = icons[nextMode];
            requestAnimationFrame(() => {
              if (!btn.isConnected || btn.dataset.actionMode !== nextMode) return;
              icon.style.opacity = "1";
              icon.style.transform = "translateY(0) scale(1)";
            });
          });
        }
      }
      // Code is only auto-attached on PASTE now. Doing it while typing used to
      // swallow long normal messages into a “file” chip mid-sentence.
    }
    function toggleAttachmentMenu(e) {
      e?.preventDefault(); e?.stopPropagation();
      const menu = getEl("attachmentMenu"), button = getEl("attachBtn");
      if (!menu || !button) return;
      if (menu.classList.contains("open")) return closeAttachmentMenu();
      closeModelDropdown();
      menu.style.removeProperty("animation"); menu.style.removeProperty("transform");
      menu.style.removeProperty("opacity"); menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
      menu.scrollTop = 0;
      const modeRow = menu.querySelector(".trux-plus-grid");
      if (modeRow) modeRow.scrollLeft = 0;
      menu.classList.add("open"); button.classList.add("open"); button.setAttribute("aria-expanded", "true");
    }

    function closeAttachmentMenu() {
      const menu = getEl("attachmentMenu");
      if (menu) {
        menu.classList.remove("open");
        menu.style.removeProperty("animation"); menu.style.removeProperty("transform");
        menu.style.removeProperty("opacity"); menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
      }
      const button = getEl("attachBtn");
      button?.classList.remove("open"); button?.setAttribute("aria-expanded", "false");
    }

    (function bindPlusMenuGestures() {
      const menu = getEl("attachmentMenu"), handle = getEl("plusMenuHandle"), button = getEl("attachBtn");
      if (!menu || !handle || menu.dataset.gestureBound === "true") return;
      menu.dataset.gestureBound = "true";
      let gesture = null, suppressClickUntil = 0;

      function beginGesture(type, id, y, event) {
        if (!menu.classList.contains("open") || gesture || event?.isPrimary === false ||
            (type === "pointer" && typeof event?.button === "number" && event.button !== 0)) return;
        gesture = {type,id,startY:y,lastY:y,startedAt:Date.now(),startScrollTop:menu.scrollTop,dragging:false};
      }
      function moveGesture(y, event) {
        if (!gesture) return;
        gesture.lastY = y;
        const delta = y - gesture.startY;
        if (!gesture.dragging) {
          if (delta < 9 || gesture.startScrollTop > 1 || menu.scrollTop > 1) return;
          gesture.dragging = true; menu.style.transition = "none"; menu.style.willChange = "transform, opacity";
          if (gesture.type === "pointer") { try { menu.setPointerCapture(gesture.id); } catch {} }
        }
        if (delta < 0) return;
        if (event?.cancelable) event.preventDefault();
        const distance = Math.max(0,delta);
        menu.style.transform = "translateY(" + distance + "px)";
        menu.style.opacity = String(Math.max(.28,1-distance/Math.max(360,menu.offsetHeight*1.35)));
      }
      function finishGesture(finalY, event) {
        if (!gesture) return;
        if (gesture.type === "pointer" && event && event.pointerId !== gesture.id) return;
        if (typeof finalY === "number") gesture.lastY = finalY;
        const current = gesture; gesture = null;
        if (!current.dragging) return;
        const delta = Math.max(0,current.lastY-current.startY);
        const elapsed = Math.max(1,Date.now()-current.startedAt), velocity = delta/elapsed;
        suppressClickUntil = Date.now()+450;
        if (delta >= Math.max(72,menu.offsetHeight*.18) || (delta>26 && velocity>.62)) {
          menu.style.transition = "transform 250ms cubic-bezier(.2,.75,.25,1), opacity 180ms ease, visibility 180ms ease";
          menu.style.transform = "translateY("+Math.max(delta,menu.offsetHeight)+"px)";
          menu.style.opacity = "0"; menu.classList.remove("open");
          button?.classList.remove("open"); button?.setAttribute("aria-expanded","false");
          window.setTimeout(() => {
            if (!menu.classList.contains("open")) {
              menu.style.removeProperty("transform"); menu.style.removeProperty("opacity");
              menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
            }
          },320);
          return;
        }
        menu.style.transition = "transform 230ms cubic-bezier(.16,1,.3,1), opacity 180ms ease";
        menu.style.transform = "translateY(0)"; menu.style.opacity = "1";
        window.setTimeout(() => {
          if (menu.classList.contains("open")) { menu.style.removeProperty("transform"); menu.style.removeProperty("opacity"); }
          menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
        },270);
      }

      /* Touch scrolling stays native/momentum-based; down-drag works anywhere at scrollTop 0. */
      menu.addEventListener("touchstart", event => {
        if (event.touches.length!==1) { gesture=null; return; }
        beginGesture("touch",0,event.touches[0].clientY,event);
      },{passive:true});
      menu.addEventListener("touchmove", event => {
        if (!gesture || gesture.type!=="touch" || event.touches.length!==1) return;
        moveGesture(event.touches[0].clientY,event);
      },{passive:false});
      menu.addEventListener("touchend", event => {
        if (!gesture || gesture.type!=="touch") return;
        finishGesture(event.changedTouches?.[0]?.clientY,event);
      },{passive:true});
      menu.addEventListener("touchcancel", event => {
        if (gesture?.type==="touch") finishGesture(undefined,event);
      },{passive:true});

      /* Mouse/pen drag behavior for desktop without sacrificing button clicks. */
      menu.addEventListener("pointerdown", event => {
        if (event.pointerType==="touch") return;
        beginGesture("pointer",event.pointerId,event.clientY,event);
      });
      menu.addEventListener("pointermove", event => {
        if (!gesture || gesture.type!=="pointer" || event.pointerId!==gesture.id) return;
        moveGesture(event.clientY,event);
      });
      menu.addEventListener("pointerup", event => { if (gesture?.type==="pointer") finishGesture(event.clientY,event); });
      menu.addEventListener("pointercancel", event => { if (gesture?.type==="pointer") finishGesture(undefined,event); });
      menu.addEventListener("lostpointercapture", event => { if (gesture?.type==="pointer") finishGesture(undefined,event); });
      menu.addEventListener("click", event => {
        if (Date.now()>=suppressClickUntil) return;
        suppressClickUntil=0; event.preventDefault(); event.stopImmediatePropagation();
      },true);
      handle.addEventListener("click", event => {
        event.preventDefault();
        if (Date.now()>=suppressClickUntil) closeAttachmentMenu();
      });
    })();

    addEventListener("scroll", e => {
      if (e.target === chatContainer || e.target === document) closeAttachmentMenu();
    }, true);
    function openFileLibrary() {
      closeAttachmentMenu();
      getEl("fileUpload")?.click();
    }
    function openCamera() { closeAttachmentMenu(); getEl("cameraUpload").click(); }
    function openPhotoLibrary() { closeAttachmentMenu(); getEl("imageUpload").click(); }

    async function ingestLargeFile(file) {
      if(!auth?.currentUser) { openLoginWall(); throw new Error("Sign in before uploading files."); }
      const requestUser = auth.currentUser;
      const uploadResponse = await truxAuthenticatedFetch("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Trux-File-Name": encodeURIComponent(file.name) },
        body: file
      }, requestUser);
      const uploaded = await uploadResponse.json().catch(() => ({}));
      if(!uploadResponse.ok) throw new Error(uploaded.error || "File upload failed.");
      const processResponse = await truxAuthenticatedFetch("/api/files/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectKey: uploaded.objectKey, mimeType: uploaded.mimeType, name: uploaded.name })
      }, requestUser);
      const processed = await processResponse.json().catch(() => ({}));
      if(!processResponse.ok) throw new Error(processed.error || "File processing failed.");
      return {
        name: processed.file?.name || file.name,
        size: processed.file?.size || file.size,
        mimeType: processed.file?.mimeType || file.type || "application/octet-stream",
        objectKey: processed.file?.objectKey || uploaded.objectKey,
        processedKey: processed.file?.processedKey || null,
        kind: processed.file?.kind || "file",
        pages: processed.file?.pages ?? null,
        rows: processed.file?.rows ?? null,
        filesIncluded: processed.file?.filesIncluded ?? null,
        filesSkipped: processed.file?.filesSkipped ?? null,
        snippet: processed.file?.snippet || (file.name + " · " + Math.ceil(file.size / 1024) + " KB")
      };
    }

    async function handleFileUpload(e) {
      const files = Array.from(e.target.files || []).slice(0, 8);
      if(!files.length) return;
      if(!auth?.currentUser) { e.target.value = ""; openLoginWall(); return; }
      for (const file of files) {
        const id = Date.now() + Math.floor(Math.random() * 100000);
        if(file.type.startsWith("image/")) {
          await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = ev => { selectedImageBase64 = ev.target.result; getEl("imagePreview").src = ev.target.result; getEl("imagePreviewContainer").classList.add("visible"); resolve(); };
            reader.onerror = () => { toast("Could not read " + file.name + ".", "err"); resolve(); };
            reader.readAsDataURL(file);
          });
          continue;
        }
        const pending = { id, name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", processing: true, snippet: file.name + " · Uploading…" };
        fileAttachments.push(pending);
        renderFileChips(); handleInputChange();
        try {
          const processed = await ingestLargeFile(file);
          Object.assign(pending, processed, { processing: false });
          pending.snippet = processed.snippet;
          toast(file.name + " ready for analysis.", "ok");
        } catch(error) {
          fileAttachments = fileAttachments.filter(x => x.id !== id);
          toast(file.name + ": " + (error?.message || "processing failed"), "err");
        }
        renderFileChips(); handleInputChange();
      }
      e.target.value = "";
    }
        
    function handleImageUpload(e) {
      let f = e.target.files[0]; if(!f || !f.type.startsWith("image/")) return;
      let r = new FileReader();
      r.onload = x => { selectedImageBase64 = x.target.result; getEl("imagePreview").src = x.target.result; getEl("imagePreviewContainer").classList.add("visible"); updateComposerAttachments(); handleInputChange(); };
      r.readAsDataURL(f);
    }
    function removeImage() { selectedImageBase64 = null; getEl("imageUpload").value = ""; getEl("cameraUpload").value = ""; getEl("imagePreviewContainer").classList.remove("visible"); updateComposerAttachments(); handleInputChange(); }

    if("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      let SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognition = new SR(); recognition.continuous = false; recognition.interimResults = true; recognition.lang = store.getItem("trux_dictation_language") && store.getItem("trux_dictation_language") !== "auto" ? store.getItem("trux_dictation_language") : (navigator.language || "en-US");
      recognition.onstart = () => { isRecording = true; wasInputByVoice = true; getEl("voiceBtn").classList.add("recording"); };
      recognition.onresult = e => { let t = "", finalText = ""; for(let i = e.resultIndex; i < e.results.length; i++) { t += e.results[i][0].transcript; if(e.results[i].isFinal) finalText += e.results[i][0].transcript; } getEl("promptInput").value = t; if(finalText.trim()) storeDictationHistory(finalText); handleInputChange(); };
      recognition.onerror = stopVoiceInput; recognition.onend = stopVoiceInput;
    }
    function toggleVoiceInput() { if(!recognition) return toast("Speech recognition is not supported in this browser.", "err"); isRecording ? recognition.stop() : (wasInputByVoice = true, recognition.start()); }
    function stopVoiceInput() { isRecording = false; getEl("voiceBtn").classList.remove("recording"); }

    function escapeHtml(t) { return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
    function copyCodeToClipboard(b, id) { let e = getEl(id); if(e) navigator.clipboard.writeText(e.value).then(() => { let x = b.innerText; b.innerText = "Copied ✓"; setTimeout(() => b.innerText = x, 1500); }); }
    function downloadCode(id, filename) {
      let e = getEl(id); if(!e) return;
      let url = URL.createObjectURL(new Blob([e.value], { type: "text/plain;charset=utf-8" }));
      let a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    function codeFileExtension(language) {
      let map = { javascript: "js", js: "js", typescript: "ts", ts: "ts", html: "html", css: "css", json: "json", python: "py", java: "java", c: "c", cpp: "cpp", csharp: "cs", sql: "sql", bash: "sh", shell: "sh", markdown: "md", md: "md", xml: "xml", yaml: "yml", yml: "yml" };
      return map[String(language || "").toLowerCase()] || "txt";
    }

    /* =====================================================================
       MARKDOWN RENDERER
       Full block-level markdown: tables, headings, lists, quotes, rules,
       links and code files. The old renderer only understood bold/italic
       and code fences, which is exactly why tables came out as raw pipes.
       ===================================================================== */

    /* Lightweight, dependency-free tokeniser. Runs over ALREADY-escaped text
       in a single pass, so no span it emits can be re-matched. */
    const CODE_KEYWORDS = ("abstract as async await bool break case catch class const constructor continue "
      + "def default del delete do double elif else end enum except export extends false final finally float fn for "
      + "from func function global go if impl implements import in instanceof int interface is lambda let match mod "
      + "mut new nil none not null or package pass print private protected public raise range record return self "
      + "static str struct super switch template then this throw throws trait true try type typeof undefined union "
      + "unless until use var void when where while with yield and True False None NaN NULL Boolean String Number").split(" ");

    function highlightCode(escaped) {
      const kw = new RegExp("\\b(?:" + CODE_KEYWORDS.join("|") + ")\\b", "g");
      const re = new RegExp([
        "(&quot;(?:[^&\\n]|&(?!quot;))*&quot;|&#039;(?:[^&\\n]|&(?!#039;))*&#039;|`(?:[^`\\\\]|\\\\.)*`)",
        "(#[^\\n]*|\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|--[^\\n]*)",
        "(@[A-Za-z_]\\w*)",
        "\\b(\\d[\\d_]*(?:\\.\\d+)?)\\b",
        "([A-Za-z_]\\w*)(?=\\()"
      ].join("|"), "g");

      return escaped.replace(re, (m, str, com, dec, num, fn) => {
        if(str) return '<span class="tk-str">' + str + '</span>';
        if(com) return '<span class="tk-com">' + com + '</span>';
        if(dec) return '<span class="tk-dec">' + dec + '</span>';
        if(num) return '<span class="tk-num">' + num + '</span>';
        if(fn)  return kw.test(fn) ? '<span class="tk-key">' + fn + '</span>'
                                   : '<span class="tk-fn">' + fn + '</span>';
        return m;
      }).replace(/(<span[^>]*>[\s\S]*?<\/span>)|([A-Za-z_]\w*)/g, (m, span, word) => {
        if(span) return span;
        return CODE_KEYWORDS.indexOf(word) > -1 ? '<span class="tk-key">' + word + '</span>' : word;
      });
    }

    function toggleCodeCard(btn) {
      let card = btn.closest(".code-file");
      if(!card) return;
      let open = card.classList.toggle("collapsed");
      btn.querySelector("span").textContent = open ? ("Show all " + btn.dataset.lines + " lines") : "Collapse";
    }

    function buildCodeCard(lang, rawCode, isWriting) {
      let id = `code_${++codeBlockCounter}_${Math.random().toString(36).slice(2, 8)}`;
      let code = String(rawCode).replace(/\s+$/, "");
      let displayLang = (lang || "text").toLowerCase();
      let extension = codeFileExtension(lang);
      let filename = `trux-omni-output.${extension}`;
      let lineCount = code ? code.split("\n").length : 0;
      let runnable = (extension === "html" || extension === "js");

      let body = `<div class="code-body"><pre><code>${highlightCode(escapeHtml(code))}</code></pre></div>`;

      if (isWriting) {
        return `<div class="code-file writing"><div class="code-file-header"><div class="code-file-info">` +
          `<span class="code-file-icon">&lt;/&gt;</span><div class="code-file-meta"><b>${escapeHtml(filename)}</b>` +
          `<small>${escapeHtml(displayLang.toUpperCase())} · writing ${lineCount} lines…</small></div></div></div>` +
          body + `</div>`;
      }

      // Long files start folded so a single answer never buries the thread.
      let folded = lineCount > 18;
      let expander = folded
        ? `<button type="button" class="code-expand" data-lines="${lineCount}" onclick="toggleCodeCard(this)">` +
          `<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg><span>Show all ${lineCount} lines</span></button>`
        : ``;

      return `<div class="code-file${folded ? " collapsed" : ""}"><div class="code-file-header"><div class="code-file-info">` +
        `<span class="code-file-icon">&lt;/&gt;</span><div class="code-file-meta"><b>${escapeHtml(filename)}</b>` +
        `<small>${escapeHtml(displayLang.toUpperCase())} · ${lineCount} Lines</small></div></div>` +
        `<div class="code-actions">` +
        (runnable ? `<button type="button" onclick="openCodeSandbox('${id}','${extension}')"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>Run</button>` : ``) +
        `<button type="button" onclick="copyCodeToClipboard(this,'${id}')">Copy</button>` +
        `<button type="button" onclick="downloadCode('${id}','${filename}')">Download</button>` +
        `</div></div>` + body +
        `<textarea id="${id}" hidden>${escapeHtml(code)}</textarea>` + expander +
        `</div>`;
    }

    /* ============================================================
       ROBUST LATEX PROTECTION
       Keep LaTeX expressions intact while Markdown is converted.
       This avoids losing multiline/long equations when paragraphs are
       split or <br> tags are inserted before KaTeX runs.
       ============================================================ */
    function protectTruxMathSegments(source, segments) {
      const s = String(source);
      let out = "";
      let i = 0;

      function isBoundaryChar(ch) {
        return !ch || " \t\n,.;:!?()[]{}".includes(ch);
      }

      function add(raw) {
        const token = "\\uE000TRUXMATH" + segments.length + "\\uE001";
        segments.push(String(raw));
        return token;
      }

      while (i < s.length) {
        // Display math: $$ ... $$
        if (s.startsWith("$$", i)) {
          const end = s.indexOf("$$", i + 2);
          if (end !== -1) {
            const raw = s.slice(i, end + 2);
            out += add(raw);
            i = end + 2;
            continue;
          }
        }

        // Display math: \[ ... \]
        if (s.startsWith("\\[", i)) {
          const end = s.indexOf("\\]", i + 2);
          if (end !== -1) {
            const raw = s.slice(i, end + 2);
            out += add(raw);
            i = end + 2;
            continue;
          }
        }

        // Inline math: \( ... \)
        if (s.startsWith("\\(", i)) {
          const end = s.indexOf("\\)", i + 2);
          if (end !== -1) {
            const raw = s.slice(i, end + 2);
            out += add(raw);
            i = end + 2;
            continue;
          }
        }

        // Single-dollar inline math. Avoid treating obvious currency such as
        // "$20" or "$5.99" as TeX.
        if (s[i] === "$" && s[i + 1] !== "$") {
          let end = i + 1;
          while (end < s.length) {
            if (s[end] === "$" && s[end - 1] !== "\\") break;
            if (s[end] === "\n") { end = -1; break; }
            end++;
          }
          if (end > i + 1 && end < s.length) {
            const body = s.slice(i + 1, end);
            const before = i > 0 ? s[i - 1] : "";
            const after = end + 1 < s.length ? s[end + 1] : "";
            const looksLikeCurrency = /^\s*\d(?:[\d,.]*)(?:\s*[A-Za-z])?$/.test(body);
            if (!looksLikeCurrency && (isBoundaryChar(before) || before === "") &&
                (isBoundaryChar(after) || after === "")) {
              out += add(s.slice(i, end + 1));
              i = end + 1;
              continue;
            }
          }
        }

        out += s[i];
        i++;
      }
      return out;
    }

    function restoreTruxMathSegments(html, segments) {
      let out = String(html);
      segments.forEach((raw, index) => {
        const token = "\\uE000TRUXMATH" + index + "\\uE001";
        out = out.split(token).join(escapeHtml(raw));
      });
      return out;
    }

    /* Inline markdown, applied to text that is ALREADY html-escaped. */

    /* ============================================================
       KATEX MATH RENDERING
       The API may emit Markdown plus TeX; we render TeX in-browser.
       ============================================================ */
    const TRUX_MATH_OPTIONS = {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false }
      ],
      throwOnError: false,
      strict: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"]
    };

    function renderTruxMath(root) {
      if (!root || typeof window.renderMathInElement !== "function") return;
      try {
        window.renderMathInElement(root, TRUX_MATH_OPTIONS);
      } catch (err) {
        console.warn("TruX math render skipped:", err);
      }
    }

    function scheduleTruxMath(root) {
      if (!root) return;
      requestAnimationFrame(() => requestAnimationFrame(() => renderTruxMath(root)));
      // Streaming HTML can settle a frame late, so use one bounded final pass.
      setTimeout(() => { if (root.isConnected) renderTruxMath(root); }, 140);
    }

    function renderInline(escaped) {
      let codeSpans = [];
      let s = String(escaped);

      // `code` — pulled out first so nothing else mangles its contents.
      s = s.replace(/`([^`\n]+)`/g, (m, c) => {
        codeSpans.push(`<code>${c}</code>`);
        return `\u0000C${codeSpans.length - 1}\u0000`;
      });

      // [label](url) and bare urls
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

      s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><em>$1</em></b>");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>");

      return s.replace(/\u0000C(\d+)\u0000/g, (m, i) => codeSpans[Number(i)] || "");
    }

    function isTableSeparator(line) {
      return /^\s*\|?[\s]*:?-{2,}:?[\s]*(\|[\s]*:?-{2,}:?[\s]*)*\|?\s*$/.test(line) && line.includes("-");
    }

    function splitTableRow(line) {
      let s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
      let cells = [], cur = "";
      for (let i = 0; i < s.length; i++) {
        let ch = s[i];

        // A backslash only escapes a pipe in Markdown table syntax.
        // Preserve all other backslashes so LaTeX such as \\frac, \\sqrt,
        // \\alpha, etc. survives intact inside table cells.
        if (ch === "\\" && s[i + 1] === "|") {
          cur += "|";
          i++;
          continue;
        }

        if (ch === "|") {
          cells.push(cur);
          cur = "";
          continue;
        }

        cur += ch;
      }
      cells.push(cur);
      return cells.map(c => c.trim());
    }

    function buildTable(headerLine, alignLine, bodyLines) {
      let heads = splitTableRow(headerLine);
      let aligns = splitTableRow(alignLine).map(a => {
        let left = a.startsWith(":"), right = a.endsWith(":");
        if (left && right) return "col-center";
        if (right) return "col-right";
        return "";
      });

      let thead = "<tr>" + heads.map((h, i) =>
        `<th class="${aligns[i] || ""}">${renderInline(escapeHtml(h))}</th>`).join("") + "</tr>";

      let tbody = bodyLines.map(line => {
        let cells = splitTableRow(line);
        while (cells.length < heads.length) cells.push("");
        return "<tr>" + cells.slice(0, heads.length).map((c, i) =>
          `<td class="${aligns[i] || ""}">${renderInline(escapeHtml(c))}</td>`).join("") + "</tr>";
      }).join("");

      return `<div class="table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
    }

    function buildList(items, ordered) {
      // items: [{ indent, text, ordered }] — supports one level of nesting,
      // and the nested level may use a different marker type than its parent.
      let baseIndent = Math.min(...items.map(i => i.indent));
      let openTag = ordered ? "<ol>" : "<ul>";
      let closeTag = ordered ? "</ol>" : "</ul>";

      let html = openTag;
      let nestClose = null;   // closing tag of the open nested list, if any
      let liOpen = false;     // the parent <li> holding it is still unclosed

      items.forEach(item => {
        let nested = item.indent > baseIndent + 1;
        let li = `<li>${renderInline(escapeHtml(item.text))}`;

        if (nested) {
          // Nested lists must live INSIDE the preceding <li> to be valid HTML.
          let nOpen = item.ordered ? "<ol>" : "<ul>";
          let nClose = item.ordered ? "</ol>" : "</ul>";
          if (nestClose && nestClose !== nClose) { html += nestClose; nestClose = null; }
          if (!nestClose) { html += nOpen; nestClose = nClose; }
          html += li + "</li>";
        } else {
          if (nestClose) { html += nestClose; nestClose = null; }
          if (liOpen) { html += "</li>"; liOpen = false; }
          html += li;
          liOpen = true;
        }
      });

      if (nestClose) html += nestClose;
      if (liOpen) html += "</li>";
      return html + closeTag;
    }

    let truxMermaidRenderSequence = 0;
    let truxMermaidRenderQueue = Promise.resolve();
    let truxMermaidFallbackPromise = null;

    function normalizeTruxMermaidSource(raw){
      let source=String(raw||"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n")
        .replace(/[\u2018\u2019\u201A\u201B]/g,"'")
        .replace(/[\u201C\u201D\u201E\u201F]/g,'"').trim();
      const fence = String.fromCharCode(96).repeat(3);
      source=source.replace(new RegExp("^\\s*"+fence+"(?:[\\w+#.-]+)?[ \\t]*\\n?","i"),"").replace(new RegExp("\\n?\\s*"+fence+"\\s*$"),"").trim();
      source=source.replace(/&nbsp;/gi," ").replace(/<br\s*\/?\s*>/gi," ");
      const lines=source.split("\n");
      const first=lines.findIndex(line=>/^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|xychart-beta|block-beta|architecture-beta|gitGraph|sankey-beta|zenuml|requirementDiagram)\b/i.test(line));
      if(first>0) source=lines.slice(first).join("\n");
      return source.trim();
    }
    function repairTruxMermaidSource(raw){
      let source=normalizeTruxMermaidSource(raw);
      if(!/^(?:flowchart|graph)\b/i.test(source))return source;
      // Recover common model-generated flowchart slips without changing valid edge syntax.
      source=source.replace(/^(\s*(?:flowchart|graph))\s*$/im,"$1 TD");
      source=source.replace(/(?<![-.])-(?![-.])>/g,"-->");
      source=source.split("\n").map(line=>line.replace(
        /^(\s*[A-Za-z_][\w-]*\s*)\[([^\]\n]*)\](.*)$/,
        (whole,id,label,tail)=>{
          const value=label.trim();
          const alreadyQuoted=/^(?:"(?:\\.|[^"\\\\])*"|'(?:\\.|[^'\\\\])*'|`[^`]*`)$/.test(value);
          return /[():,;|{}]/.test(value)&&!alreadyQuoted
            ? id+"["+JSON.stringify(value)+"]"+tail : whole;
        }
      )).join("\n");
      return source;
    }
    function getTruxMermaidCandidates(raw){
      const original=String(raw||"").trim();
      const normalized=normalizeTruxMermaidSource(original);
      const repaired=repairTruxMermaidSource(normalized);
      return [...new Set([normalized,repaired,original].filter(Boolean))];
    }
    function renderTruxFallbackFlowchart(raw,svgSlot,stage){
      const source=normalizeTruxMermaidSource(raw);
      if(!/^(?:flowchart|graph)\b/i.test(source)||!svgSlot||!stage)return null;
      const NS="http://www.w3.org/2000/svg",nodes=new Map(),edges=[];
      const tokenPattern=/([A-Za-z_][\w-]*)\s*(\(\([^)\n]*\)\)|\(\[[^\]\n]*\]\)|\[[^\]\n]*\]|\{[^}\n]*\}|\([^)\n]*\))?/g;
      const hasEdge=/(?:-->|---|-.->|==>|--o|--x)/;
      const lines=source.split("\n");
      for(const rawLine of lines.slice(1)){
        const line=rawLine.trim();
        if(!line||line.startsWith("%%")||/^(?:subgraph|end|style|classDef|class|linkStyle|click|direction|accTitle|accDescr)\b/i.test(line))continue;
        const scan=line.replace(/--\s*[^-\n]+?\s*-->/g,"-->").replace(/-->\s*\|[^|]*\|/g,"-->");
        const matches=Array.from(scan.matchAll(tokenPattern)),ids=[];
        for(const m of matches){
          const id=m[1],shape=m[2]||"";
          let label=id,kind="rect";
          if(shape.startsWith("((")){label=shape.slice(2,-2);kind="circle";}
          else if(shape.startsWith("([")){label=shape.slice(2,-2);kind="round";}
          else if(shape.startsWith("[")){label=shape.slice(1,-1);}
          else if(shape.startsWith("{")){label=shape.slice(1,-1);kind="diamond";}
          else if(shape.startsWith("(")){label=shape.slice(1,-1);kind="round";}
          label=String(label).replace(/^["']|["']$/g,"").replace(/\\(["'])/g,"$1").trim()||id;
          if(!nodes.has(id))nodes.set(id,{id,label,kind});
          else if(shape&&nodes.get(id).label===id)Object.assign(nodes.get(id),{label,kind});
          ids.push(id);
        }
        if(hasEdge.test(scan)&&ids.length>1){
          for(let i=0;i<ids.length-1;i++){
            if(ids[i]!==ids[i+1]&&!edges.some(e=>e.from===ids[i]&&e.to===ids[i+1]))edges.push({from:ids[i],to:ids[i+1]});
          }
        }
      }
      if(!nodes.size)return null;
      const incoming=new Map(),outgoing=new Map();
      for(const id of nodes.keys()){incoming.set(id,0);outgoing.set(id,[]);}
      for(const e of edges){if(incoming.has(e.to)&&outgoing.has(e.from)){incoming.set(e.to,incoming.get(e.to)+1);outgoing.get(e.from).push(e.to);}}
      const level=new Map(),queue=[];
      for(const id of nodes.keys())if(incoming.get(id)===0){level.set(id,0);queue.push(id);}
      if(!queue.length){const first=nodes.keys().next().value;level.set(first,0);queue.push(first);}
      for(let i=0;i<queue.length;i++)for(const next of outgoing.get(queue[i])||[])if(!level.has(next)){level.set(next,(level.get(queue[i])||0)+1);queue.push(next);}
      for(const id of nodes.keys())if(!level.has(id))level.set(id,0);
      const grouped=new Map();
      for(const item of nodes.values()){const l=level.get(item.id)||0;if(!grouped.has(l))grouped.set(l,[]);grouped.get(l).push(item);}
      const layers=[...grouped.keys()].sort((a,b)=>a-b),fontSize=24,nodeGap=32,layerGap=86,margin=60;
      const wrapLabel=value=>{const out=[];let row="";for(const word of String(value).split(/\s+/)){if(row&&(row+" "+word).length>22){out.push(row);row=word;}else row=row?row+" "+word:word;}if(row)out.push(row);return out.length?out:[String(value)];};
      const dims=new Map();
      for(const item of nodes.values()){const rows=wrapLabel(item.label);dims.set(item.id,{rows,w:Math.max(150,Math.min(330,Math.max(...rows.map(x=>x.length))*fontSize*.62+42)),h:Math.max(68,rows.length*30+28)});}
      const rowWidths=layers.map(l=>grouped.get(l).reduce((sum,item)=>sum+dims.get(item.id).w,0)+nodeGap*Math.max(0,grouped.get(l).length-1));
      const width=Math.max(1440,...rowWidths.map(w=>w+margin*2));
      const height=margin*2+layers.reduce((sum,l)=>sum+Math.max(...grouped.get(l).map(item=>dims.get(item.id).h)),0)+layerGap*Math.max(0,layers.length-1);
      const positions=new Map();let y=margin;
      for(const l of layers){
        const items=grouped.get(l),rowH=Math.max(...items.map(item=>dims.get(item.id).h));
        let x=(width-rowWidths[layers.indexOf(l)])/2;
        for(const item of items){const d=dims.get(item.id);positions.set(item.id,{x:x+d.w/2,y:y+rowH/2,w:d.w,h:d.h,rows:d.rows,kind:item.kind});x+=d.w+nodeGap;}
        y+=rowH+layerGap;
      }
      const svg=document.createElementNS(NS,"svg");
      svg.setAttribute("xmlns",NS);svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("role","img");svg.setAttribute("aria-label","Diagram");
      svg.style.background="#151515";svg.style.backgroundColor="#151515";
      const defs=document.createElementNS(NS,"defs"),marker=document.createElementNS(NS,"marker"),arrow=document.createElementNS(NS,"path");
      marker.setAttribute("id","trux-fallback-arrow-"+(++truxMermaidRenderSequence));marker.setAttribute("markerWidth","10");marker.setAttribute("markerHeight","8");marker.setAttribute("refX","9");marker.setAttribute("refY","4");marker.setAttribute("orient","auto");
      arrow.setAttribute("d","M0,0 L10,4 L0,8 z");arrow.setAttribute("fill","#b4b4b4");marker.appendChild(arrow);defs.appendChild(marker);svg.appendChild(defs);
      const arrowRef="url(#"+marker.id+")";
      for(const e of edges){
        const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)continue;
        const x1=a.x,y1=a.y+a.h/2,x2=b.x,y2=b.y-b.h/2,mid=(y1+y2)/2;
        const pathNode=document.createElementNS(NS,"path");
        pathNode.setAttribute("class","flowchart-link");pathNode.setAttribute("d","M "+x1+" "+y1+" C "+x1+" "+mid+", "+x2+" "+mid+", "+x2+" "+y2);
        pathNode.setAttribute("fill","none");pathNode.setAttribute("stroke","#b4b4b4");pathNode.setAttribute("stroke-width","2.4");pathNode.setAttribute("marker-end",arrowRef);svg.appendChild(pathNode);
      }
      for(const item of nodes.values()){
        const p=positions.get(item.id),g=document.createElementNS(NS,"g");
        g.setAttribute("class","node");
        const title=document.createElementNS(NS,"title");title.textContent=item.id;g.appendChild(title);
        let shape;
        if(item.kind==="diamond"){
          shape=document.createElementNS(NS,"polygon");shape.setAttribute("points",p.x+","+(p.y-p.h/2)+" "+(p.x+p.w/2)+","+p.y+" "+p.x+","+(p.y+p.h/2)+" "+(p.x-p.w/2)+","+p.y);
        }else{
          shape=document.createElementNS(NS,item.kind==="circle"?"ellipse":"rect");
          if(item.kind==="circle"){shape.setAttribute("cx",p.x);shape.setAttribute("cy",p.y);shape.setAttribute("rx",p.w/2);shape.setAttribute("ry",p.h/2);}
          else{shape.setAttribute("x",p.x-p.w/2);shape.setAttribute("y",p.y-p.h/2);shape.setAttribute("width",p.w);shape.setAttribute("height",p.h);shape.setAttribute("rx",item.kind==="round"?"22":"10");}
        }
        shape.setAttribute("fill","#151515");shape.setAttribute("stroke","#818181");shape.setAttribute("stroke-width","2");g.appendChild(shape);
        const textNode=document.createElementNS(NS,"text");textNode.setAttribute("text-anchor","middle");textNode.setAttribute("fill","#d8d8d8");textNode.setAttribute("font-family","Arial,sans-serif");textNode.setAttribute("font-size",String(fontSize));
        const startY=p.y-((p.rows.length-1)*15);
        p.rows.forEach((line,i)=>{const tspan=document.createElementNS(NS,"tspan");tspan.setAttribute("x",String(p.x));tspan.setAttribute("y",String(startY+i*30));tspan.textContent=line;textNode.appendChild(tspan);});
        g.appendChild(textNode);svg.appendChild(g);
      }
      svgSlot.replaceChildren(svg);stage.style.width=width+"px";stage.style.minWidth=width+"px";
      return svg;
    }
    function truxFallbackSvg(width,height,label){
      const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("xmlns","http://www.w3.org/2000/svg");svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("role","img");svg.setAttribute("aria-label",label||"Diagram");svg.style.background="#151515";svg.style.backgroundColor="#151515";return svg;
    }
    function truxFallbackEl(parent,tag,attrs,text){
      const node=document.createElementNS("http://www.w3.org/2000/svg",tag);
      Object.entries(attrs||{}).forEach(([key,value])=>node.setAttribute(key,String(value)));
      if(text!==undefined&&text!==null)node.textContent=String(text);
      parent.appendChild(node);return node;
    }
    function truxFallbackText(svg,x,y,text,size=20,anchor="start",fill="#d8d8d8",weight="400"){
      return truxFallbackEl(svg,"text",{x,y,"font-family":"Arial,sans-serif","font-size":size,"text-anchor":anchor,fill,"font-weight":weight},text);
    }
    function truxFallbackInstall(svg,slot,stage){
      const width=Number(svg.getAttribute("width"))||1440;
      svg.style.setProperty("width","100%","important");svg.style.setProperty("min-width","100%","important");svg.style.setProperty("max-width","none","important");svg.style.setProperty("height","auto","important");svg.style.setProperty("min-height","460px","important");
      slot.replaceChildren(svg);stage.style.width=Math.max(1280,width)+"px";stage.style.minWidth=Math.max(1280,width)+"px";stage.style.minHeight=Math.max(460,Number(svg.getAttribute("height"))||460)+"px";return svg;
    }
    function renderTruxFallbackSequence(source,slot,stage){
      const rows=normalizeTruxMermaidSource(source).split("\n").slice(1),actors=new Map(),messages=[];
      for(const row of rows){
        let m=row.trim().match(/^(?:participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/i);
        if(m){if(!actors.has(m[1]))actors.set(m[1],(m[2]||m[1]).trim());continue;}
        m=row.trim().match(/^([\w.-]+)\s*(-->>|->>|-->|->|--x|--o|<<--|<<->)\s*([\w.-]+)\s*:\s*(.*)$/);
        if(m){if(!actors.has(m[1]))actors.set(m[1],m[1]);if(!actors.has(m[3]))actors.set(m[3],m[3]);messages.push({from:m[1],arrow:m[2],to:m[3],label:m[4]});}
        else if(/^note\s+(?:over|left of|right of)\b/i.test(row.trim()))messages.push({note:row.trim().replace(/^note\s+/i,"")});
      }
      if(!actors.size)return null;
      const list=[...actors.keys()],width=Math.max(1440,180+list.length*210),height=Math.max(460,150+messages.length*76+55),xPos=new Map();
      list.forEach((id,i)=>xPos.set(id,90+(width-180)*(list.length===1?0.5:i/Math.max(1,list.length-1))));
      const svg=truxFallbackSvg(width,height,"Sequence diagram"),defs=truxFallbackEl(svg,"defs",{});
      const markerId="trux-seq-arrow-"+(++truxMermaidRenderSequence),marker=truxFallbackEl(defs,"marker",{id:markerId,markerWidth:10,markerHeight:8,refX:9,refY:4,orient:"auto"});
      truxFallbackEl(marker,"path",{d:"M0,0 L10,4 L0,8 z",fill:"#b4b4b4"});
      list.forEach(id=>{
        const x=xPos.get(id);truxFallbackEl(svg,"rect",{x:x-76,y:34,width:152,height:48,rx:8,fill:"#1b1b1b",stroke:"#818181","stroke-width":2});
        truxFallbackText(svg,x,64,actors.get(id),19,"middle","#e2e2e2","600");
        truxFallbackEl(svg,"line",{x1:x,y1:82,x2:x,y2:height-28,stroke:"#777","stroke-width":1.6,"stroke-dasharray":"7 7"});
      });
      messages.forEach((msg,i)=>{
        const y=128+i*76;
        if(msg.note){
          truxFallbackEl(svg,"rect",{x:Math.max(24,width/2-150),y:y-18,width:300,height:42,rx:6,fill:"#202020",stroke:"#747474"});
          truxFallbackText(svg,width/2,y+8,msg.note.replace(/^over\s+/i,""),16,"middle");return;
        }
        const x1=xPos.get(msg.from),x2=xPos.get(msg.to),left=Math.min(x1,x2),right=Math.max(x1,x2),reverse=x1>x2;
        const line=truxFallbackEl(svg,"line",{x1:x1,y1:y,x2:x2,y2:y,stroke:"#b4b4b4","stroke-width":2,"marker-end":"url(#"+markerId+")"});
        if(msg.arrow.includes("--"))line.setAttribute("stroke-dasharray","7 5");
        if(msg.arrow==="--x"){truxFallbackEl(svg,"line",{x1:x2-7,y1:y-7,x2:x2+7,y2:y+7,stroke:"#b4b4b4","stroke-width":2});truxFallbackEl(svg,"line",{x1:x2+7,y1:y-7,x2:x2-7,y2:y+7,stroke:"#b4b4b4","stroke-width":2});}
        truxFallbackText(svg,(left+right)/2,y-10,msg.label||"",17,"middle");
      });
      return truxFallbackInstall(svg,slot,stage);
    }
    function renderTruxFallbackPie(source,slot,stage){
      const entries=normalizeTruxMermaidSource(source).split("\n").slice(1).map(line=>{
        const m=line.trim().match(/^["']?(.+?)["']?\s*:\s*(-?\d+(?:\.\d+)?)/);return m?{label:m[1].replace(/^["']|["']$/g,"").trim(),value:Number(m[2])}:null;
      }).filter(x=>x&&Number.isFinite(x.value)&&x.value>=0);
      if(!entries.length)return null;
      const total=entries.reduce((sum,x)=>sum+x.value,0);if(total<=0)return null;
      const width=1440,height=Math.max(500,entries.length*44+100),cx=330,cy=height/2,r=190,svg=truxFallbackSvg(width,height,"Pie chart");
      const colors=["#dedede","#bdbdbd","#9a9a9a","#777777","#5d5d5d","#424242","#eeeeee","#858585","#a8a8a8","#686868"];
      let angle=-Math.PI/2;
      entries.forEach((item,i)=>{
        const portion=item.value/total,next=angle+portion*Math.PI*2,large=next-angle>Math.PI?1:0;
        if(portion>=.999999)truxFallbackEl(svg,"circle",{cx,cy,r,fill:colors[i%colors.length],stroke:"#151515","stroke-width":2});
        else{
          const x1=cx+r*Math.cos(angle),y1=cy+r*Math.sin(angle),x2=cx+r*Math.cos(next),y2=cy+r*Math.sin(next);
          const d="M "+cx+" "+cy+" L "+x1+" "+y1+" A "+r+" "+r+" 0 "+large+" 1 "+x2+" "+y2+" Z";
          truxFallbackEl(svg,"path",{d,fill:colors[i%colors.length],stroke:"#151515","stroke-width":2});
        }
        angle=next;
        const ly=90+i*42;
        truxFallbackEl(svg,"rect",{x:620,y:ly-18,width:20,height:20,rx:3,fill:colors[i%colors.length]});
        truxFallbackText(svg,655,ly,item.label,20,"start");
        truxFallbackText(svg,1380,ly,String(item.value)+(item.value/total>0?"  ("+(item.value/total*100).toFixed(1)+"%)":""),18,"end","#bdbdbd");
      });
      return truxFallbackInstall(svg,slot,stage);
    }
    function renderTruxFallbackTimeline(source,slot,stage){
      const lines=normalizeTruxMermaidSource(source).split("\n").slice(1),events=[];let section="";
      for(const raw of lines){
        const line=raw.trim();if(!line||/^(?:title|accTitle|accDescr)\b/i.test(line))continue;
        const sec=line.match(/^section\s+(.+)$/i);if(sec){section=sec[1];continue;}
        const m=line.match(/^([^:]+?)\s*:\s*(.+)$/);
        if(m)events.push({date:m[1].trim(),label:m[2].trim(),section});
        else if(events.length)events[events.length-1].label+=" · "+line.replace(/^:\s*/,"");
      }
      if(!events.length)return null;
      const width=1440,height=Math.max(460,180+events.length*90),svg=truxFallbackSvg(width,height,"Timeline diagram"),x=115;
      truxFallbackEl(svg,"line",{x1:x,y1:86,x2:x,y2:height-48,stroke:"#777","stroke-width":3});
      events.forEach((e,i)=>{
        const y=112+i*90;
        truxFallbackEl(svg,"circle",{cx:x,cy:y,r:9,fill:"#d8d8d8",stroke:"#151515","stroke-width":3});
        truxFallbackText(svg,155,y-8,e.date,18,"start","#bdbdbd","600");
        truxFallbackText(svg,330,y+18,e.label,20,"start","#e1e1e1");
        if(e.section)truxFallbackText(svg,1310,y-8,e.section,14,"end","#888");
      });
      return truxFallbackInstall(svg,slot,stage);
    }
    function renderTruxFallbackGantt(source,slot,stage){
      const lines=normalizeTruxMermaidSource(source).split("\n").slice(1),tasks=[];let section="";
      for(const raw of lines){
        const line=raw.trim();if(!line||/^(?:title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|accTitle|accDescr)\b/i.test(line))continue;
        const sec=line.match(/^section\s+(.+)$/i);if(sec){section=sec[1];continue;}
        const at=line.indexOf(":");if(at<1)continue;
        const name=line.slice(0,at).trim(),rest=line.slice(at+1).trim(),date=rest.match(/\d{4}-\d{2}-\d{2}/),dur=rest.match(/(\d+(?:\.\d+)?)\s*(d|w|h|m)\b/i);
        let duration=dur?Number(dur[1])*(/w/i.test(dur[2])?7:/h/i.test(dur[2])?1/24:/m/i.test(dur[2])?1/1440:1):3;
        tasks.push({name,section,start:date?Date.parse(date[0])/86400000:null,duration:Math.max(.25,duration),raw:rest});
      }
      if(!tasks.length)return null;
      let nextDay=0;
      tasks.forEach(t=>{if(t.start==null)t.start=nextDay;nextDay=Math.max(nextDay,t.start+t.duration)+.25;});
      const minDay=Math.min(...tasks.map(t=>t.start)),maxDay=Math.max(...tasks.map(t=>t.start+t.duration)),scale=30,left=330,top=110,rowH=66;
      const width=Math.max(1440,left+Math.max(1,maxDay-minDay)*scale+150),height=top+tasks.length*rowH+40,svg=truxFallbackSvg(width,height,"Gantt timeline");
      truxFallbackText(svg,30,52,"Task schedule",24,"start","#e6e6e6","600");
      truxFallbackEl(svg,"line",{x1:left,y1:top-18,x2:width-45,y2:top-18,stroke:"#555","stroke-width":1});
      tasks.forEach((t,i)=>{
        const y=top+i*rowH,x=left+(t.start-minDay)*scale,w=Math.max(14,t.duration*scale);
        if(t.section&&(!i||tasks[i-1].section!==t.section))truxFallbackText(svg,30,y-12,t.section,14,"start","#8c8c8c","600");
        truxFallbackText(svg,30,y+24,t.name,18,"start","#d7d7d7");
        truxFallbackEl(svg,"rect",{x,y,width:w,height:28,rx:6,fill:/done|complete/i.test(t.raw)?"#858585":"#c4c4c4",stroke:"#ededed","stroke-width":1});
      });
      return truxFallbackInstall(svg,slot,stage);
    }
    function renderTruxFallbackXyChart(source,slot,stage){
      const lines=normalizeTruxMermaidSource(source).split("\n"),series=[],cats=[];
      for(const row of lines){
        let m=row.match(/^\s*x-axis\s+(?:["'][^"']*["']\s*)?\[([^\]]+)\]/i);
        if(m)cats.push(...m[1].split(",").map(x=>x.trim().replace(/^["']|["']$/g,"")));
        m=row.match(/^\s*(bar|line)\s+\[([^\]]+)\]/i);
        if(m)series.push({type:m[1].toLowerCase(),values:m[2].split(",").map(x=>Number(x.trim())).filter(Number.isFinite)});
      }
      if(!series.length||!series.some(x=>x.values.length))return null;
      const values=series.flatMap(x=>x.values),min=Math.min(0,...values),max=Math.max(1,...values),width=1440,height=560,left=110,right=65,top=75,bottom=100,plotW=width-left-right,plotH=height-top-bottom,svg=truxFallbackSvg(width,height,"Data chart");
      const mapY=v=>top+(max-v)/(max-min||1)*plotH;
      for(let i=0;i<=5;i++){const value=min+(max-min)*i/5,y=mapY(value);truxFallbackEl(svg,"line",{x1:left,y1:y,x2:width-right,y2:y,stroke:"#343434","stroke-width":1});truxFallbackText(svg,left-14,y+6,String(Number(value.toFixed(2))),15,"end","#a0a0a0");}
      truxFallbackEl(svg,"line",{x1:left,y1:top,x2:left,y2:top+plotH,stroke:"#999","stroke-width":2});
      truxFallbackEl(svg,"line",{x1:left,y1:top+plotH,x2:width-right,y2:top+plotH,stroke:"#999","stroke-width":2});
      const count=Math.max(cats.length,...series.map(x=>x.values.length),1),band=plotW/count;
      if(!cats.length)for(let i=0;i<count;i++)cats.push(String(i+1));
      const palette=["#dedede","#999999","#bdbdbd","#747474"];
      series.forEach((item,si)=>{
        if(item.type==="bar"){
          const bw=Math.min(42,band*.7/series.length);
          item.values.forEach((v,i)=>{const x=left+band*(i+.5)+(si-(series.length-1)/2)*bw,y=mapY(v);truxFallbackEl(svg,"rect",{x:x-bw*.42,y,width:bw*.84,height:Math.max(1,top+plotH-y),rx:3,fill:palette[si%palette.length]});});
        }else{
          const points=item.values.map((v,i)=>({x:left+band*(i+.5),y:mapY(v)}));
          for(let i=1;i<points.length;i++)truxFallbackEl(svg,"line",{x1:points[i-1].x,y1:points[i-1].y,x2:points[i].x,y2:points[i].y,stroke:palette[si%palette.length],"stroke-width":4,"stroke-linecap":"round"});
          points.forEach(p=>truxFallbackEl(svg,"circle",{cx:p.x,cy:p.y,r:6,fill:palette[si%palette.length],stroke:"#151515","stroke-width":2}));
        }
        truxFallbackText(svg,left+si*145,35,item.type,16,"start",palette[si%palette.length],"600");
      });
      cats.slice(0,count).forEach((label,i)=>truxFallbackText(svg,left+band*(i+.5),top+plotH+30,label,15,"middle","#bdbdbd"));
      return truxFallbackInstall(svg,slot,stage);
    }
    function renderTruxFallbackQuadrant(source,slot,stage){
      const lines=normalizeTruxMermaidSource(source).split("\n"),points=[],quadrants=[];
      let xLabel="X",yLabel="Y";
      for(const row of lines){
        let m=row.match(/^\s*x-axis\s+(.+?)\s*-->\s*(.+)$/i);if(m)xLabel=m[1].replace(/^["']|["']$/g,"")+" — "+m[2].replace(/^["']|["']$/g,"");
        m=row.match(/^\s*y-axis\s+(.+?)\s*-->\s*(.+)$/i);if(m)yLabel=m[1].replace(/^["']|["']$/g,"")+" — "+m[2].replace(/^["']|["']$/g,"");
        m=row.match(/^\s*quadrant-([1-4])\s+(.+)$/i);if(m)quadrants[Number(m[1])-1]=m[2].trim();
        m=row.match(/^\s*point\s+["']?(.+?)["']?\s*:\s*\[?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]?/i);if(m)points.push({label:m[1].replace(/^["']|["']$/g,""),x:Number(m[2]),y:Number(m[3])});
      }
      if(!points.length)return null;
      const width=1440,height=600,left=150,top=70,pw=width-280,ph=height-170,cx=left+pw/2,cy=top+ph/2,svg=truxFallbackSvg(width,height,"Quadrant chart");
      truxFallbackEl(svg,"rect",{x:left,y:top,width:pw/2,height:ph/2,fill:"#1c1c1c"});truxFallbackEl(svg,"rect",{x:cx,y:top,width:pw/2,height:ph/2,fill:"#181818"});
      truxFallbackEl(svg,"rect",{x:left,y:cy,width:pw/2,height:ph/2,fill:"#181818"});truxFallbackEl(svg,"rect",{x:cx,y:cy,width:pw/2,height:ph/2,fill:"#1c1c1c"});
      truxFallbackEl(svg,"line",{x1:cx,y1:top,x2:cx,y2:top+ph,stroke:"#777","stroke-width":2});truxFallbackEl(svg,"line",{x1:left,y1:cy,x2:left+pw,y2:cy,stroke:"#777","stroke-width":2});
      truxFallbackText(svg,cx,26,xLabel,16,"middle","#bdbdbd");truxFallbackText(svg,30,top+ph/2,yLabel,16,"middle","#bdbdbd");
      const centers=[{x:cx+pw/4,y:top+26},{x:left+pw/4,y:top+26},{x:left+pw/4,y:top+ph-12},{x:cx+pw/4,y:top+ph-12}];
      quadrants.forEach((label,i)=>{if(label)truxFallbackText(svg,centers[i].x,centers[i].y,label,17,"middle","#888","600");});
      points.forEach((p,i)=>{const x=left+Math.max(0,Math.min(1,p.x))*pw,y=top+(1-Math.max(0,Math.min(1,p.y)))*ph;truxFallbackEl(svg,"circle",{cx:x,cy:y,r:8,fill:"#dedede",stroke:"#151515","stroke-width":3});truxFallbackText(svg,x+13,y-10,p.label,16,"start","#e0e0e0");});
      return truxFallbackInstall(svg,slot,stage);
    }
    function truxFallbackGraphSource(raw,type){
      const source=normalizeTruxMermaidSource(raw),lines=source.split("\n").slice(1),nodes=[],edges=[],byId=new Map();
      const clean=value=>String(value||"").replace(/[\[\]{}]/g," ").replace(/["']/g,"").replace(/\s+/g," ").trim().slice(0,120);
      const add=(id,label)=>{id=String(id||"").replace(/[^A-Za-z0-9_-]/g,"_")||("N"+(nodes.length+1));if(!byId.has(id)){const item={id,label:clean(label)||id};byId.set(id,item);nodes.push(item);}else if(label&&byId.get(id).label===id)byId.get(id).label=clean(label);return id;};
      const link=(a,b,label)=>{a=add(a,a);b=add(b,b);if(a!==b&&!edges.some(e=>e.from===a&&e.to===b))edges.push({from:a,to:b,label:clean(label)});};
      if(/^stateDiagram/i.test(source)){
        for(const line0 of lines){const line=line0.trim();const m=line.match(/^(.+?)\s+(?:-->|--\s*>|-\.\->|==>)\s*(.+?)(?:\s*:\s*(.+))?$/);if(!m)continue;const a=m[1].replace(/^\[\*\]$/,"Start"),b=m[2].replace(/^\[\*\]$/,"Final");link(a,a);link(b,b);link(a,b,m[3]);}
      }else if(/^classDiagram/i.test(source)){
        let current=null;
        for(const line0 of lines){const line=line0.trim();let m=line.match(/^class\s+([\w.]+)(?:\s*\{)?/i);if(m){current=add(m[1],m[1]);continue;}if(current&&line==="}"){current=null;continue;}if(current&&line){byId.get(current).label=clean(byId.get(current).label+" · "+line.replace(/[+~-]/g,"").replace(/\([^)]*\)/g,""));continue;}
          m=line.match(/^([\w.]+)\s*(<\|--|--\|>|<\.\.|\.{2}|[*o]?--|--[*o]?|-->|<--)\s*([\w.]+)(?:\s*:\s*(.*))?/);if(m)link(m[1],m[3],m[4]||m[2]);}
      }else if(/^erDiagram/i.test(source)){
        let current=null;for(const line0 of lines){const line=line0.trim();let m=line.match(/^([\w-]+)\s*\{$/);if(m){current=add(m[1],m[1]);continue;}if(line==="}"){current=null;continue;}if(current&&line&&!line.startsWith("%%")){byId.get(current).label=clean(byId.get(current).label+" · "+line.replace(/\s+/g," "));continue;}
          m=line.match(/^([\w-]+)\s+([|o}{.]+)--([|o}{.]+)\s+([\w-]+)(?:\s*:\s*(.*))?$/);if(m)link(m[1],m[4],m[5]||"relationship");}
      }else if(/^mindmap/i.test(source)){
        const stack=[];for(const line0 of lines){if(!line0.trim())continue;const indent=(line0.match(/^\s*/)||[""])[0].replace(/\t/g,"  ").length,label=clean(line0.trim().replace(/^root\s*\(\((.*?)\)\)$/i,"$1").replace(/^\(\((.*?)\)\)$/,"$1").replace(/^[()]+|[()]+$/g,""));if(!label)continue;while(stack.length&&stack[stack.length-1].indent>=indent)stack.pop();const id="M"+(nodes.length+1);add(id,label);if(stack.length)link(stack[stack.length-1].id,id);stack.push({id,indent});}
      }else if(/^journey/i.test(source)){
        let idx=0;for(const line0 of lines){const line=line0.trim();if(!line||/^(?:title|section)\b/i.test(line))continue;const m=line.match(/^(.+?):\s*(\d+)\s*:\s*(.*)$/);if(m){const id="J"+(++idx);add(id,m[1]+" · score "+m[2]+" · "+m[3]);if(idx>1)link("J"+(idx-1),id);}}
      }else if(/^architecture-beta/i.test(source)){
        for(const line0 of lines){const line=line0.trim();let m=line.match(/^(?:service|group|junction|container)\s+([\w-]+)(?:\([^)]*\))?\s*\[([^\]]+)\]/i);if(m)add(m[1],m[2]);m=line.match(/([\w-]+):[NESW]\s*--\s*[NESW]:([\w-]+)/i);if(m)link(m[1],m[2]);}
      }else if(/^sankey-beta/i.test(source)){
        for(const line0 of lines){const m=line0.trim().match(/^([^,]+),([^,]+),\s*([\d.]+)/);if(m)link(m[1],m[2],m[3]);}
      }else if(/^block-beta/i.test(source)){
        for(const line0 of lines){const line=line0.trim();let m=line.match(/^block\s+([\w-]+)(?:\[([^\]]+)\])?/i);if(m)add(m[1],m[2]||m[1]);m=line.match(/^([\w-]+)\s*(?:-->|---|<--)\s*([\w-]+)/);if(m)link(m[1],m[2]);}
      }else if(/^gitgraph/i.test(source)){
        let previous=null,i=0;for(const line0 of lines){const line=line0.trim();const m=line.match(/^commit(?:\s+id:\s*([\w-]+))?(?:\s*:\s*["']?([^"']+)["']?)?/i);if(m){const id=m[1]||("Commit_"+(++i));add(id,m[2]||id);if(previous)link(previous,id);previous=id;}}
      }else{
        for(const line0 of lines){const line=line0.trim();const m=line.match(/^([\w-]+)\s*(-->|---|<--)\s*([\w-]+)(?:\s*:\s*(.*))?/);if(m)link(m[1],m[3],m[4]);}
      }
      if(!nodes.length)return null;
      if(!edges.length&&nodes.length>1)for(let i=1;i<nodes.length;i++)link(nodes[i-1].id,nodes[i].id);
      let output="flowchart TD\n";
      for(const node of nodes)output+=node.id+"["+node.label+"]\n";
      let relCount=0;
      for(const edge of edges){
        if(edge.label){
          const relationId="REL_"+(++relCount);
          output+=relationId+"["+clean(edge.label)+"]\n";
          output+=edge.from+" --> "+relationId+"\n"+relationId+" --> "+edge.to+"\n";
        }else output+=edge.from+" --> "+edge.to+"\n";
      }
      return output;
    }
    function renderTruxFallbackDiagram(raw,slot,stage){
      const source=normalizeTruxMermaidSource(raw);
      if(/^(?:flowchart|graph)\b/i.test(source))return renderTruxFallbackFlowchart(source,slot,stage);
      if(/^sequenceDiagram\b/i.test(source))return renderTruxFallbackSequence(source,slot,stage);
      if(/^pie\b/i.test(source))return renderTruxFallbackPie(source,slot,stage);
      if(/^timeline\b/i.test(source))return renderTruxFallbackTimeline(source,slot,stage);
      if(/^gantt\b/i.test(source))return renderTruxFallbackGantt(source,slot,stage);
      if(/^xychart-beta\b/i.test(source))return renderTruxFallbackXyChart(source,slot,stage);
      if(/^quadrantChart\b/i.test(source))return renderTruxFallbackQuadrant(source,slot,stage);
      if(/^(?:stateDiagram(?:-v2)?|classDiagram|erDiagram|mindmap|journey|architecture-beta|sankey-beta|block-beta|gitGraph|requirementDiagram|zenuml)\b/i.test(source)){
        const graph=truxFallbackGraphSource(source,source.split(/\s/)[0]);
        return graph?renderTruxFallbackFlowchart(graph,slot,stage):null;
      }
      return null;
    }
    const TRUX_SVG_ELEMENTS = new Set([
      "svg","g","defs","path","line","polyline","polygon","rect","circle","ellipse","text","tspan","textpath","title","desc",
      "clippath","mask","lineargradient","radialgradient","stop","marker","pattern","symbol","use",
      "filter","fegaussianblur","feoffset","femerge","femergenode","fecolormatrix","fecomponenttransfer",
      "fefunca","fefuncr","fefuncg","fefuncb","feblend","feflood","fecomposite","fedropshadow"
    ]);
    const TRUX_SVG_ATTRIBUTES = new Set((
      "xmlns viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points transform " +
      "fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray " +
      "stroke-dashoffset stroke-opacity stroke-miterlimit opacity vector-effect pathLength font-family font-size " +
      "font-style font-weight text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing " +
      "textLength lengthAdjust dx dy rotate offset stop-color stop-opacity gradientUnits gradientTransform " +
      "spreadMethod fx fy fr clip-path clip-rule mask maskUnits maskContentUnits marker-start marker-mid marker-end " +
      "markerUnits markerWidth markerHeight refX refY orient patternUnits patternContentUnits patternTransform href " +
      "filter filterUnits primitiveUnits in in2 result stdDeviation type values operator k1 k2 k3 k4 scale slope " +
      "intercept tableValues mode flood-color flood-opacity color-interpolation-filters baseFrequency numOctaves " +
      "seed stitchTiles edgeMode lighting-color surfaceScale diffuseConstant specularConstant specularExponent " +
      "azimuth elevation xml:space role aria-label"
    ).split(/\s+/).map(x=>x.toLowerCase()));
    const TRUX_SVG_TAG_NAMES = {textpath:"textPath",clippath:"clipPath",lineargradient:"linearGradient",radialgradient:"radialGradient",fegaussianblur:"feGaussianBlur",feoffset:"feOffset",femerge:"feMerge",femergenode:"feMergeNode",fecolormatrix:"feColorMatrix",fecomponenttransfer:"feComponentTransfer",fefunca:"feFuncA",fefuncr:"feFuncR",fefuncg:"feFuncG",fefuncb:"feFuncB",feblend:"feBlend",feflood:"feFlood",fecomposite:"feComposite",fedropshadow:"feDropShadow"};
    function normalizeTruxSvgSource(raw){
      let source=String(raw||"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").trim();
      const fence=String.fromCharCode(96).repeat(3);
      source=source.replace(new RegExp("^\\s*"+fence+"(?:svg|xml)?[ \\t]*\\n?","i"),"")
        .replace(new RegExp("\\n?\\s*"+fence+"\\s*$"),"").trim();
      const start=source.search(/<(?:[A-Za-z_][\w.-]*:)?svg\b/i);
      if(start>0)source=source.slice(start).trim();
      return source;
    }
    function isTruxSvgDrawing(raw){
      return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:[A-Za-z_][\w.-]*:)?svg\b/i.test(normalizeTruxSvgSource(raw));
    }
    function isTruxDiagram(lang, code) {
      const label=String(lang||"").trim().toLowerCase(), source=String(code||"").trim();
      if(label==="mermaid" || label==="svg") return true;
      if(label==="xml" && isTruxSvgDrawing(source)) return true;
      if(!label && isTruxSvgDrawing(source)) return true;
      return /^(?:flowchart|graph|sequencediagram|classdiagram|statediagram(?:-v2)?|erdiagram|journey|gantt|pie(?:\s|$)|mindmap|timeline|quadrantchart|xychart-beta|block-beta|architecture-beta|gitgraph|sankey-beta|zenuml|requirementdiagram)\b/i.test(source);
    }
    function sanitizeTruxSvgNode(sourceNode, context, depth){
      if(depth>64)throw new Error("SVG drawing nesting is too deep");
      if(sourceNode.nodeType===3)return document.createTextNode(sourceNode.nodeValue||"");
      if(sourceNode.nodeType!==1)return null;
      if(++context.nodes>12000)throw new Error("SVG drawing has too many elements");
      const tag=String(sourceNode.localName||sourceNode.nodeName||"").toLowerCase();
      if(!TRUX_SVG_ELEMENTS.has(tag))return null;
      const clean=document.createElementNS(context.namespace,TRUX_SVG_TAG_NAMES[tag]||tag);
      for(const attribute of Array.from(sourceNode.attributes||[])){
        const name=String(attribute.name||"");
        const lower=name.toLowerCase();
        let value=String(attribute.value||"").trim();
        if(!TRUX_SVG_ATTRIBUTES.has(lower)||value.length>16000)continue;
        if(lower==="href" && !/^#[A-Za-z_][\w.-]*$/.test(value))continue;
        if(lower==="id" && !/^[A-Za-z_][\w.-]*$/.test(value))continue;
        if(/url\s*\(/i.test(value)){
          const urls=value.match(/url\s*\([^)]*\)/gi)||[];
          if(!urls.length||urls.some(item=>!/^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/i.test(item.trim())))continue;
        }else if(/(?:javascript:|data:|https?:\/\/|\/\/)/i.test(value)){
          continue;
        }
        if(lower==="viewbox"){
          const parts=value.split(/[\s,]+/).map(Number);
          if(parts.length!==4||!parts.every(Number.isFinite)||parts[2]<=0||parts[3]<=0)continue;
        }
        clean.setAttribute(name,value);
      }
      for(const child of Array.from(sourceNode.childNodes||[])){
        const safeChild=sanitizeTruxSvgNode(child,context,depth+1);
        if(safeChild)clean.appendChild(safeChild);
      }
      return clean;
    }
    function renderTruxSvgDrawing(raw, slot, stage){
      if(!slot||!stage)throw new Error("Drawing surface is unavailable");
      const source=normalizeTruxSvgSource(raw);
      if(!source||source.length>350000)throw new Error("SVG source is empty or exceeds the drawing size limit");
      const parsed=new DOMParser().parseFromString(source,"image/svg+xml");
      const sourceRoot=parsed.documentElement;
      if(!sourceRoot||String(sourceRoot.localName||"").toLowerCase()!=="svg"||parsed.querySelector("parsererror")){
        throw new Error("The SVG drawing is invalid XML or has no SVG root");
      }
      const namespace="http://www.w3.org/2000/svg";
      const context={namespace,nodes:0};
      const svg=sanitizeTruxSvgNode(sourceRoot,context,0);
      if(!svg||String(svg.localName||"").toLowerCase()!=="svg")throw new Error("The SVG drawing could not be sanitized");
      const numberLength=(value,fallback)=>{
        const text=String(value||"").trim();
        if(!text||/%$/.test(text))return fallback;
        const n=Number.parseFloat(text);
        return Number.isFinite(n)&&n>0&&n<=50000?n:fallback;
      };
      let vx=0,vy=0,vw=numberLength(sourceRoot.getAttribute("width"),1600),vh=numberLength(sourceRoot.getAttribute("height"),900);
      const rawViewBox=String(sourceRoot.getAttribute("viewBox")||"").trim();
      const vb=rawViewBox.split(/[\s,]+/).map(Number);
      if(vb.length===4&&vb.every(Number.isFinite)&&vb[2]>0&&vb[3]>0&&vb[2]<=50000&&vb[3]<=50000){
        vx=vb[0];vy=vb[1];vw=vb[2];vh=vb[3];
      }
      svg.setAttribute("xmlns",namespace);
      svg.setAttribute("viewBox",[vx,vy,vw,vh].join(" "));
      svg.setAttribute("width",String(vw));
      svg.setAttribute("height",String(vh));
      svg.setAttribute("role","img");
      if(!svg.getAttribute("aria-label"))svg.setAttribute("aria-label","Custom vector drawing");
      svg.style.background="#151515";
      svg.style.backgroundColor="#151515";
      svg.style.setProperty("width","100%","important");
      svg.style.setProperty("min-width","100%","important");
      svg.style.setProperty("max-width","none","important");
      svg.style.setProperty("height","auto","important");
      svg.style.setProperty("min-height","460px","important");
      svg.style.overflow="visible";
      const drawable=Array.from(svg.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse,text,use"))
        .filter(node=>!node.closest("defs,clippath,mask,marker,pattern,symbol,filter"));
      if(!drawable.length)throw new Error("The SVG contains no visible drawing elements");
      const coversCanvas=(node)=>{
        const x=Number.parseFloat(node.getAttribute("x")||"0"),y=Number.parseFloat(node.getAttribute("y")||"0");
        const w=String(node.getAttribute("width")||""),h=String(node.getAttribute("height")||"");
        const covers=(raw,viewSize)=>/%$/.test(raw)?Number.parseFloat(raw)>=99:Number.parseFloat(raw)>=viewSize*.99;
        return Math.abs(x-vx)<1&&Math.abs(y-vy)<1&&covers(w,vw)&&covers(h,vh);
      };
      let background=Array.from(svg.children).find(node=>String(node.localName||"").toLowerCase()==="rect"&&coversCanvas(node));
      if(background){
        background.setAttribute("fill","#151515");
        background.setAttribute("stroke","none");
        background.setAttribute("class","trux-canvas-background");
        svg.insertBefore(background,svg.firstChild);
      }else{
        background=document.createElementNS(namespace,"rect");
        background.setAttribute("x",String(vx));background.setAttribute("y",String(vy));
        background.setAttribute("width",String(vw));background.setAttribute("height",String(vh));
        background.setAttribute("fill","#151515");background.setAttribute("stroke","none");
        background.setAttribute("class","trux-canvas-background");
        svg.insertBefore(background,svg.firstChild);
      }
      const stageWidth=Math.max(1440,Math.min(2200,vw));
      const stageHeight=Math.max(460,Math.min(3200,stageWidth*vh/vw));
      stage.style.width=stageWidth+"px";
      stage.style.minWidth=stageWidth+"px";
      stage.style.minHeight=stageHeight+"px";
      slot.replaceChildren(svg);
      return svg;
    }
    function buildTruxDiagramCard(source,pending=false) {
      return '<div class="trux-diagram" data-trux-diagram'+(pending?' data-trux-diagram-pending="true"':'')+'>'+
        '<div class="trux-diagram-toolbar"><button type="button" data-trux-diagram-action="edit" aria-label="Edit diagram source">Edit diagram</button></div>'+
        '<div class="trux-diagram-editor" hidden><textarea spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Editable vector drawing or diagram source"></textarea>'+
        '<div class="trux-diagram-editor-actions"><button type="button" data-trux-diagram-action="cancel">Cancel</button><button type="button" data-trux-diagram-action="apply">Apply changes</button></div></div>'+
        '<div class="trux-diagram-stage"><div class="trux-diagram-svg"></div>'+
        '<img class="trux-diagram-cursor" src="/icon-grey.png" alt="" aria-hidden="true" draggable="false"></div>'+
        '<pre class="trux-diagram-source" hidden>'+escapeHtml(String(source||""))+'</pre>'+
        '<div class="trux-diagram-error" hidden></div></div>';
    }
    function toggleTruxDiagramEditor(button){
      const card=button&&button.closest(".trux-diagram");if(!card)return;
      const editor=card.querySelector(".trux-diagram-editor"),textarea=editor&&editor.querySelector("textarea"),source=card.querySelector(".trux-diagram-source");
      if(!editor||!textarea||!source)return;
      textarea.value=source.textContent||"";
      editor.hidden=false;
      textarea.focus();
    }
    function cancelTruxDiagramEditor(button){
      const card=button&&button.closest(".trux-diagram");if(!card)return;
      const editor=card.querySelector(".trux-diagram-editor");if(editor)editor.hidden=true;
    }
    function applyTruxDiagramEditor(button){
      const card=button&&button.closest(".trux-diagram");if(!card)return;
      const editor=card.querySelector(".trux-diagram-editor"),textarea=editor&&editor.querySelector("textarea");
      const source=card.querySelector(".trux-diagram-source"),svgSlot=card.querySelector(".trux-diagram-svg");
      const errorNode=card.querySelector(".trux-diagram-error"),cursor=card.querySelector(".trux-diagram-cursor");
      if(!textarea||!source||!svgSlot)return;
      const value=normalizeTruxMermaidSource(textarea.value);
      if(!value){if(errorNode){errorNode.hidden=false;errorNode.textContent="Add a diagram declaration and content before applying.";}return;}
      source.textContent=value;
      if(editor)editor.hidden=true;
      if(errorNode){errorNode.hidden=true;errorNode.textContent="";}
      svgSlot.replaceChildren();
      if(cursor)cursor.hidden=false;
      delete card.dataset.truxDiagramPending;delete card.dataset.truxDiagramRendered;delete card.dataset.truxDiagramRendering;
      delete card.dataset.truxDiagramFailed;delete card.dataset.truxDiagramFallback;delete card.dataset.truxDiagramRetry;
      renderTruxDiagramElement(card);
    }
    document.addEventListener("click",function(event){
      const button=event.target&&event.target.closest?event.target.closest("[data-trux-diagram-action]"):null;
      if(!button)return;
      const action=button.getAttribute("data-trux-diagram-action");
      if(action==="edit")toggleTruxDiagramEditor(button);
      else if(action==="cancel")cancelTruxDiagramEditor(button);
      else if(action==="apply")applyTruxDiagramEditor(button);
    });
    function getTruxMermaidApi(){
      const root=window.mermaid;
      if(root?.default && typeof root.default.render==="function") return root.default;
      if(root && typeof root.render==="function") return root;
      return null;
    }
    async function waitForTruxMermaidApi(element){
      let api=getTruxMermaidApi();
      if(api||!element?.isConnected)return api;
      const primaryScript=document.querySelector('script[src*="mermaid.min.js"]');
      let primaryFailed=false;
      if(primaryScript)primaryScript.addEventListener("error",()=>{primaryFailed=true},{once:true});
      const deadline=Date.now()+15000;
      while(!api&&element.isConnected&&!primaryFailed&&Date.now()<deadline){
        await new Promise(resolve=>window.setTimeout(resolve,100));
        api=getTruxMermaidApi();
      }
      if(api||!element.isConnected)return api;
      // The deferred jsDelivr bundle can fail or arrive after the app's inline script.
      // Try a second CDN once rather than permanently failing every diagram in this turn.
      if(!truxMermaidFallbackPromise){
        truxMermaidFallbackPromise=new Promise(resolve=>{
          const script=document.createElement("script");
          script.src="https://unpkg.com/mermaid@11/dist/mermaid.min.js";
          script.async=true;
          script.onload=()=>resolve(getTruxMermaidApi());
          script.onerror=()=>resolve(null);
          document.head.appendChild(script);
        });
      }
      return await truxMermaidFallbackPromise;
    }
    function truxSvgLength(shape){try{return typeof shape.getTotalLength==="function"?Math.max(0,shape.getTotalLength()):0}catch(_){return 0}}
    function truxSvgPointToStage(svg,stage,p){
      const r=svg.getBoundingClientRect(),s=stage.getBoundingClientRect(),v=svg.viewBox&&svg.viewBox.baseVal;
      return {x:r.left-s.left+(p.x-(v?v.x:0))*r.width/Math.max(1,v&&v.width?v.width:r.width),
        y:r.top-s.top+(p.y-(v?v.y:0))*r.height/Math.max(1,v&&v.height?v.height:r.height)};
    }
    function animateTruxDiagramDrawing(stage,svg,cursor){
      const labels=Array.from(svg.querySelectorAll("text,foreignObject,.edgeLabel,.nodeLabel,.cluster-label"));
      labels.forEach(x=>x.style.visibility="hidden");
      const shapes=Array.from(svg.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse"))
        .filter(x=>!x.classList.contains("trux-canvas-background")&&
          !x.closest("defs,marker,.edgeLabel,.labelBkg,.label-container")&&truxSvgLength(x)>0);
      const edges=shapes.filter(x=>/(edge|flowchart-link|messageLine|transition|mindmap-link|relationship|dependency|section)/i.test(
        String(x.getAttribute("class")||"")+" "+String(x.parentElement?.getAttribute("class")||"")));
      const nodes=shapes.filter(x=>!edges.includes(x)&&!!x.closest(".node,.cluster,.actor,.section"));
      const ordered=(edges.length?edges:shapes).concat(edges.length?nodes:[]);
      const segments=ordered.map(shape=>{
        const dash=shape.style.strokeDasharray,offset=shape.style.strokeDashoffset;
        const originalFillOpacity=shape.style.fillOpacity,originalStroke=shape.style.stroke,originalStrokeWidth=shape.style.strokeWidth;
        let computedStroke="none",computedFill="none";
        try{const computed=window.getComputedStyle(shape);computedStroke=computed.stroke;computedFill=computed.fill;}catch(_){}
        const hasFill=!!computedFill&&computedFill!=="none"&&computedFill!=="rgba(0, 0, 0, 0)";
        const needsTemporaryStroke=(!computedStroke||computedStroke==="none"||computedStroke==="rgba(0, 0, 0, 0)");
        if(hasFill)shape.style.fillOpacity="0";
        if(needsTemporaryStroke){shape.style.stroke=hasFill?computedFill:"#b4b4b4";shape.style.strokeWidth=originalStrokeWidth||"2";}
        const length=truxSvgLength(shape);
        shape.style.strokeDasharray=length+" "+length;shape.style.strokeDashoffset=String(length);shape.style.transition="none";
        return {shape,length,duration:Math.max(160,Math.min(520,length*1.35)),dash,offset,
          originalFillOpacity,originalStroke,originalStrokeWidth,hasFill,needsTemporaryStroke};
      }).filter(x=>x.length>0);
      if(!segments.length){cursor.hidden=true;labels.forEach(x=>x.style.visibility="");return}
      function restoreSegment(seg){
        seg.shape.style.strokeDasharray=seg.dash;seg.shape.style.strokeDashoffset=seg.offset;seg.shape.style.transition="";
        if(seg.hasFill)seg.shape.style.fillOpacity=seg.originalFillOpacity;
        if(seg.needsTemporaryStroke){seg.shape.style.stroke=seg.originalStroke;seg.shape.style.strokeWidth=seg.originalStrokeWidth;}
      }
      const started=performance.now();
      function finish(){segments.forEach(restoreSegment);labels.forEach(x=>x.style.visibility="");cursor.hidden=true}
      function tick(now){
        if(!stage.isConnected||!svg.isConnected)return;
        let elapsed=now-started,active=null;
        for(const seg of segments){
          if(elapsed<=seg.duration){active=seg;break}
          restoreSegment(seg);elapsed-=seg.duration;
        }
        if(!active){finish();return}
        const p=Math.max(0,Math.min(1,elapsed/active.duration));active.shape.style.strokeDashoffset=String(active.length*(1-p));
        try{const pos=truxSvgPointToStage(svg,stage,active.shape.getPointAtLength(active.length*p));
          cursor.style.transform="translate("+(pos.x-cursor.offsetWidth/2)+"px,"+(pos.y-cursor.offsetHeight/2)+"px)"}catch(_){}
        requestAnimationFrame(tick);
      }
      try{const pos=truxSvgPointToStage(svg,stage,segments[0].shape.getPointAtLength(0));
        cursor.style.transform="translate("+(pos.x-cursor.offsetWidth/2)+"px,"+(pos.y-cursor.offsetHeight/2)+"px)"}catch(_){}
      requestAnimationFrame(tick);
    }

    async function renderTruxDiagramElement(element){
      if(!element||!element.isConnected||element.dataset.truxDiagramPending==="true"||element.dataset.truxDiagramRendered==="true"||element.dataset.truxDiagramRendering==="true"||element.dataset.truxDiagramFailed==="true")return;
      element.dataset.truxDiagramRendering="true";
      const sourceNode=element.querySelector(".trux-diagram-source"),svgSlot=element.querySelector(".trux-diagram-svg");
      const stage=element.querySelector(".trux-diagram-stage"),cursor=element.querySelector(".trux-diagram-cursor");
      const source=sourceNode?sourceNode.textContent:"";
      try{
        if(isTruxSvgDrawing(source)){
          const drawing=renderTruxSvgDrawing(source,svgSlot,stage);
          if(!element.isConnected)return;
          element.dataset.truxDiagramRendered="true";
          delete element.dataset.truxDiagramRendering;
          requestAnimationFrame(()=>{if(element.isConnected)animateTruxDiagramDrawing(stage,drawing,cursor)});
          return;
        }
        const mermaidApi=await waitForTruxMermaidApi(element);
        if(!element.isConnected)return;
        if(!mermaidApi)throw Error("Mermaid renderer could not be loaded from either CDN");
        if(!source.trim())throw Error("Mermaid source is empty");
        if(!window.__truxMermaidInitialized){
          mermaidApi.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:{
            background:"#151515",primaryColor:"#151515",primaryTextColor:"#d8d8d8",primaryBorderColor:"#818181",
            lineColor:"#b4b4b4",secondaryColor:"#151515",tertiaryColor:"#151515",mainBkg:"#151515",
            clusterBkg:"#151515",clusterBorder:"#515151",edgeLabelBackground:"#151515",
            noteBkgColor:"#151515",noteTextColor:"#d8d8d8",noteBorderColor:"#818181",
            textColor:"#d8d8d8",fontFamily:"Arial, sans-serif",fontSize:"26px"
          },flowchart:{htmlLabels:false,useMaxWidth:false,curve:"basis",nodeSpacing:100,rankSpacing:120,diagramPadding:36}});
          window.__truxMermaidInitialized=true;
        }
        // Mermaid keeps shared parser/render state; serialize renders so diagrams that
        // arrive together during streaming cannot collide intermittently.
        const renderJob=async()=>{
          let lastError=null;
          for(const candidate of getTruxMermaidCandidates(source)){
            try{
              // Validate before render, then try the next normalized variant on parser errors.
              if(typeof mermaidApi.parse==="function") await mermaidApi.parse(candidate);
              const result=await mermaidApi.render("trux-mermaid-"+(++truxMermaidRenderSequence),candidate);
              return {result,source:candidate};
            }catch(error){lastError=error;}
          }
          throw lastError||Error("Mermaid rejected all normalized source variants");
        };
        const renderPromise=truxMermaidRenderQueue.then(renderJob,renderJob);
        truxMermaidRenderQueue=renderPromise.then(()=>undefined,()=>undefined);
        const rendered=await renderPromise;
        const result=rendered.result;
        if(!element.isConnected)return;if(!svgSlot||!stage||!cursor)throw Error("Diagram surface unavailable");
        svgSlot.innerHTML=result.svg;const svg=svgSlot.querySelector("svg");if(!svg)throw Error("Mermaid returned no SVG");
        // Override Mermaid's generated max-width/width values; keep full-resolution content visible in the large stage.
        svg.style.setProperty("width","100%","important");
        svg.style.setProperty("min-width","100%","important");
        svg.style.setProperty("max-width","none","important");
        svg.style.setProperty("height","auto","important");
        svg.style.setProperty("min-height","460px","important");
        svg.style.background="#151515";svg.style.backgroundColor="#151515";
        element.dataset.truxDiagramRendered="true";delete element.dataset.truxDiagramRendering;
        if(typeof result.bindFunctions==="function")result.bindFunctions(svgSlot);
        requestAnimationFrame(()=>{if(element.isConnected)animateTruxDiagramDrawing(stage,svg,cursor)});
      }catch(error){
        if(!element.isConnected)return;
        const fallbackSvg=renderTruxFallbackDiagram(source,svgSlot,stage);
        if(fallbackSvg){
          element.dataset.truxDiagramRendered="true";
          element.dataset.truxDiagramFallback="flowchart";
          delete element.dataset.truxDiagramRendering;
          requestAnimationFrame(()=>{if(element.isConnected)animateTruxDiagramDrawing(stage,fallbackSvg,cursor)});
          console.warn("TruX used native SVG flowchart fallback:",String(error&&error.message||error||"Mermaid error"));
          return;
        }
        delete element.dataset.truxDiagramRendering;
        const retries=Number(element.dataset.truxDiagramRetry||0);
        if(retries<2){
          element.dataset.truxDiagramRetry=String(retries+1);
          window.setTimeout(()=>renderTruxDiagramElement(element),300*(retries+1));
          console.warn("TruX diagram render retry",retries+1,error);
          return;
        }
        element.dataset.truxDiagramFailed="true";
        if(cursor)cursor.hidden=true;
        const errorNode=element.querySelector(".trux-diagram-error");
        if(errorNode){
          const reason=String(error&&error.message||error||"Unknown rendering error").replace(/\s+/g," ").trim().slice(0,220);
          errorNode.hidden=false;
          errorNode.textContent="Diagram render error: "+(reason||"Unknown Mermaid error");
        }
        console.warn("TruX diagram render failed:",{message:String(error&&error.message||error||"Unknown error"),sourceLength:source.length});
      }
    }
    function renderTruxDiagrams(root){
      if(!root||typeof root.querySelectorAll!=="function")return;
      const diagrams=[];if(root instanceof Element&&root.matches(".trux-diagram[data-trux-diagram]"))diagrams.push(root);
      root.querySelectorAll(".trux-diagram[data-trux-diagram]").forEach(el=>diagrams.push(el));
      diagrams.forEach(renderTruxDiagramElement);
    }

    /*
     * allowOpenFence: when streaming, the tail of the text may contain a
     * fence that hasn't been closed yet. We render that as a live
     * "writing file…" card instead of leaking backticks into the chat.
     */
    function renderFormattedText(t, allowOpenFence) {
      if (t === null || t === undefined || t === "") return "";

      let src = String(t).replace(/\r\n/g, "\n");
      let cards = [];
      if (!src.includes("```") && isTruxDiagram("", src)) return buildTruxDiagramCard(src, false);

      src = src.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (m, lang, code) => {
        cards.push(isTruxDiagram(lang, code) ? buildTruxDiagramCard(code, false) : buildCodeCard(lang, code, false));
        return `\n\n\u0000F${cards.length - 1}\u0000\n\n`;
      });

      // A single unterminated fence left over (streaming in progress).
      let openFence = src.indexOf("```");
      if (openFence !== -1) {
        let rest = src.slice(openFence + 3);
        let nl = rest.indexOf("\n");
        let lang = (nl === -1 ? rest : rest.slice(0, nl)).trim();
        let code = nl === -1 ? "" : rest.slice(nl + 1);
        cards.push(isTruxDiagram(lang, code) ? buildTruxDiagramCard(code, true) : buildCodeCard(lang, code, !!allowOpenFence));
        src = src.slice(0, openFence) + `\n\n\u0000F${cards.length - 1}\u0000\n`;
      }

      // Only the non-code Markdown stream is protected.
      const mathSegments = [];
      src = protectTruxMathSegments(src, mathSegments);

      let lines = src.split("\n");
      let out = [];
      let para = [];
      let quote = [];
      let list = null;

      function flushPara() {
        if (!para.length) return;
        out.push(`<p>${renderInline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br>")}</p>`);
        para = [];
      }
      function flushQuote() {
        if (!quote.length) return;
        out.push(`<blockquote><p>${renderInline(escapeHtml(quote.join("\n"))).replace(/\n/g, "<br>")}</p></blockquote>`);
        quote = [];
      }
      function flushList() {
        if (!list) return;
        out.push(buildList(list.items, list.ordered));
        list = null;
      }
      function flushAll() { flushPara(); flushQuote(); flushList(); }

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let trimmed = line.trim();

        // code-file placeholder
        let ph = trimmed.match(/^\u0000F(\d+)\u0000$/);
        if (ph) { flushAll(); out.push(cards[Number(ph[1])] || ""); continue; }

        if (!trimmed) { flushAll(); continue; }

        // horizontal rule
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push("<hr>"); continue; }

        // heading
        let h = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
          flushAll();
          let level = Math.min(h[1].length, 4);
          out.push(`<h${level}>${renderInline(escapeHtml(h[2].replace(/\s*#+\s*$/, "")))}</h${level}>`);
          continue;
        }

        // table: header row followed by an alignment row
        if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          flushAll();
          let body = [];
          let j = i + 2;
          while (j < lines.length && lines[j].trim().includes("|") && lines[j].trim()) {
            body.push(lines[j]);
            j++;
          }
          out.push(buildTable(trimmed, lines[i + 1], body));
          i = j - 1;
          continue;
        }

        // blockquote
        if (/^>\s?/.test(trimmed)) {
          flushPara(); flushList();
          quote.push(trimmed.replace(/^>\s?/, ""));
          continue;
        }
        flushQuote();

        // list items
        let indent = line.match(/^\s*/)[0].replace(/\t/g, "  ").length;
        let ul = trimmed.match(/^[-*+]\s+(.*)$/);
        let ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);

        if (ul || ol) {
          flushPara();
          let ordered = !!ol;
          let text = ul ? ul[1] : ol[2];
          // An indented item of the OTHER marker type is a nested list, not a
          // new one — flushing there used to restart "1." after the sublist.
          let isNested = list && indent > list.baseIndent + 1;
          if (list && list.ordered !== ordered && !isNested) flushList();
          if (!list) list = { ordered, baseIndent: indent, items: [] };
          list.items.push({ indent, text, ordered });
          continue;
        }

        // continuation of the previous list item
        if (list && indent >= 2) {
          list.items[list.items.length - 1].text += " " + trimmed;
          continue;
        }
        flushList();

        para.push(trimmed);
      }

      flushAll();
      return restoreTruxMathSegments(out.join(""), mathSegments);
    }

    function speakText(t) {
      if(!("speechSynthesis" in window)) return; speechSynthesis.cancel();
      let ut = new SpeechSynthesisUtterance(t.replace(/```[\s\S]*?```/g,"Code file attached.").replace(/\*\*(.*?)\*\*/g,"$1").replace(/\*(.*?)\*/g,"$1").replace(/`/g,""));
      ut.rate = parseFloat(store.getItem("trux_tts_rate") || "1.0");
      const preferredVoice = store.getItem("trux_speech_voice") || "";
      if (preferredVoice) { const match = speechSynthesis.getVoices().find(voice => voice.name === preferredVoice); if (match) ut.voice = match; }
      speechSynthesis.speak(ut);
    }
    
    function copyTextMessage(txt, btn) {
      navigator.clipboard.writeText(txt).then(() => {
        let prev = btn.innerHTML;
        btn.classList.add("done");
        btn.innerHTML = ICON.check + "Copied";
        setTimeout(() => { btn.innerHTML = prev; btn.classList.remove("done"); }, 1500);
      }).catch(() => toast("Clipboard unavailable.", "err"));
    }

    const BOLT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 3 5.5 13.5H11l-1 7.5 8-10.5h-5.5l1-7.5Z"/></svg>';
    const SPARK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>';

    /* Inline icon set - keeps the action bar in the same visual language
       as the rest of the chrome instead of mixed-metric emoji. */
    const ICON = (() => {
      const w = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
      return {
        speak:  w('<path d="M11 5 6.5 9H4v6h2.5L11 19V5Z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
        copy:   w('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/>'),
        edit:   w('<path d="m4.5 16.8-.9 3.6 3.6-.9L18.7 8a2.2 2.2 0 0 0-3.1-3.1L4.5 16.8Z"/><path d="m14.5 6.5 3 3"/>'),
        pin:    w('<path d="M7 4.5h10v15l-5-3.8-5 3.8v-15Z"/>'),
        redo:   w('<path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 4.5V11h-6"/>'),
        down:   w('<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/>'),
        check:  w('<path d="m5 13 4.5 4.5L19 7"/>'),
        trash:  w('<path d="M5 7h14M10 7V5h4v2M7 7l.8 12a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1L17 7"/>')
      };
    })();

    /* Assistant rows are text-only; app icons remain PWA/metadata assets. */
    const BRAND_LABEL = 'TruX-Omni';

    /* Grounding URIs come back as Vertex redirect links, so the readable domain
       lives in the title. Prefer a real hostname when the URI has one. */
    function sourceDomain(src) {
      const cleanDomain = value => {
        const raw = String(value || "").trim();
        if (!raw) return "";
        try {
          const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw;
          return new URL(candidate).hostname.replace(/^www\./i, "").toLowerCase();
        } catch (e) {
          return raw.split(/[/?#]/)[0].replace(/^www\./i, "").toLowerCase();
        }
      };
      const explicitDomain = cleanDomain(src?.domain);
      if (explicitDomain && !/vertexaisearch|googleapis|grounding-api-redirect/i.test(explicitDomain)) {
        return explicitDomain;
      }
      const host = cleanDomain(src?.uri);
      if (host && !/vertexaisearch|googleapis|grounding-api-redirect|(^|\.)google\.com$/i.test(host)) {
        return host;
      }
      const title = String(src?.title || "");
      const match = title.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
      return match ? match[1].replace(/^www\./i, "").toLowerCase() : "";
    }
    function buildSourcesStrip(sources) {
      if(!Array.isArray(sources) || !sources.length) return null;
      const wrap = document.createElement("div");
      wrap.className = "sources";
      const seen = new Set();
      sources.slice(0, 12).forEach(function(src) {
        if(!src || !src.uri || seen.has(src.uri)) return;
        seen.add(src.uri);
        const dom = sourceDomain(src);
        const a = document.createElement("a");
        a.className = "source-chip";
        /* Keep the exact grounded URL so a tap opens that source, not a
           reconstructed homepage or a generic search results page. */
        a.href = src.uri;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", "Open source website");
        const ico = document.createElement("img");
        ico.src = dom
          ? "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(dom)
          : "https://www.google.com/s2/favicons?sz=64&domain_url=" + encodeURIComponent(src.uri);
        ico.alt = "";
        ico.loading = "lazy";
        ico.referrerPolicy = "no-referrer";
        /* Retry with a second favicon provider before using a neutral fallback. */
        ico.onerror = function() {
          if (dom && !ico.dataset.directFallback) {
            ico.dataset.directFallback = "1";
            ico.src = "https://icons.duckduckgo.com/ip3/" + encodeURIComponent(dom) + ".ico";
            return;
          }
          const dot = document.createElement("span");
          dot.className = "sc-dot";
          dot.setAttribute("aria-hidden", "true");
          ico.replaceWith(dot);
        };
        a.appendChild(ico);
        wrap.appendChild(a);
      });
      return wrap.children.length ? wrap : null;
    }
    /* Sources sit between the answer and its action row. */
    function attachSources(row, sources) {
      if(!row) return;
      row.querySelector(".sources")?.remove();
      const strip = buildSourcesStrip(sources);
      if(!strip) return;

      /* .actions is nested inside .trux-response-stack, not a direct child
         of the outer .row. Insert relative to its actual parent; otherwise
         insertBefore throws NotFoundError and aborts response finalization. */
      const actions = row.querySelector(".actions");
      if(actions?.parentNode) actions.parentNode.insertBefore(strip, actions);
      else row.appendChild(strip);
    }

    function findStoppedMessageIndex(userRow, fallbackText = "") {
      const session = chatSessions[currentChatId];
      if (!session?.messages) return -1;
      const indexed = Number(userRow?.dataset?.messageIndex);
      if (Number.isInteger(indexed) && indexed >= 0 && indexed < session.messages.length) {
        const candidate = session.messages[indexed];
        if (candidate?.role === "user") return indexed;
      }
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m?.role === "user" && String(m.text || "") === String(fallbackText || "")) return i;
      }
      return -1;
    }

    function attachUserMessageActions(userRow, messageIndex, promptText) {
      if (!userRow) return;
      userRow.classList.remove("user-actions-visible");
      userRow.querySelector(".user-message-actions")?.remove();
      userRow.querySelector(".user-stopped-actions")?.remove();
      const index = Number.isInteger(messageIndex) ? messageIndex : findStoppedMessageIndex(userRow, promptText);
      const actions = document.createElement("div");
      actions.className = "actions user-message-actions user-stopped-actions";

      const getPromptText = () => {
        const message = chatSessions[currentChatId]?.messages?.[index];
        if (message?.role === "user") return String(message.text || "");
        return String(promptText ?? userRow.querySelector(".user-bubble")?.innerText ?? "");
      };

      const copyBtn = document.createElement("button");
      copyBtn.className = "act";
      copyBtn.type = "button";
      copyBtn.title = "Copy your message";
      copyBtn.innerHTML = ICON.copy + "Copy";
      copyBtn.onclick = () => copyTextMessage(getPromptText(), copyBtn);

      const resendBtn = document.createElement("button");
      resendBtn.className = "act";
      resendBtn.type = "button";
      resendBtn.title = "Resend this message";
      resendBtn.innerHTML = ICON.redo + "Resend";
      resendBtn.onclick = () => {
        if (isGenerating) return toast("Stop the current generation first.", "err");
        const session = chatSessions[currentChatId];
        const message = session?.messages?.[index];
        if (!message || message.role !== "user") {
          return toast("This message is no longer available.", "err");
        }

        const text = String(message.text || "");
        const savedAttachments = (Array.isArray(message.attachments) ? message.attachments : [])
          .filter(item => item && item.objectKey);
        if (!text.trim() && !savedAttachments.length) {
          return toast("This message has no text or saved attachments to resend.", "err");
        }

        // Replace this turn and any later turns, then submit the same prompt
        // again so the transcript never contains duplicate user messages.
        store.removeItem("trux_turn_draft_" + currentChatId);
        session.messages.splice(index);
        saveChatSessions();
        let node = userRow;
        while (node) {
          const next = node.nextElementSibling;
          node.remove();
          node = next;
        }

        selectedImageBase64 = null;
        pastedTextBlocks = [];
        fileAttachments = savedAttachments.map(item => ({
          name: String(item.name || "attachment"),
          size: Number(item.size || 0),
          mimeType: String(item.mimeType || "application/octet-stream"),
          objectKey: String(item.objectKey),
          processedKey: item.processedKey || null,
          processing: false
        }));
        const input = getEl("promptInput");
        input.value = text;
        renderFileChips();
        handleInputChange();
        sendPrompt();
      };

      actions.append(copyBtn, resendBtn);
      userRow.appendChild(actions);

      if (userRow.dataset.longPressActionsBound !== "true") {
        userRow.dataset.longPressActionsBound = "true";
        let holdTimer = null;
        let holdStartX = 0;
        let holdStartY = 0;
        const clearHoldTimer = () => {
          if (holdTimer !== null) clearTimeout(holdTimer);
          holdTimer = null;
        };

        userRow.addEventListener("pointerdown", event => {
          const target = event.target;
          if (target instanceof Element && target.closest(".user-message-actions")) return;
          if (event.isPrimary === false || (typeof event.button === "number" && event.button !== 0)) return;
          clearHoldTimer();
          holdStartX = event.clientX;
          holdStartY = event.clientY;
          holdTimer = window.setTimeout(() => {
            holdTimer = null;
            document.querySelectorAll(".user-row.user-actions-visible").forEach(other => {
              if (other !== userRow) other.classList.remove("user-actions-visible");
            });
            userRow.classList.add("user-actions-visible");
            if (event.pointerType === "touch" && typeof navigator.vibrate === "function") {
              navigator.vibrate(12);
            }
          }, 450);
        });
        userRow.addEventListener("pointermove", event => {
          if (holdTimer !== null &&
              (Math.abs(event.clientX - holdStartX) > 12 || Math.abs(event.clientY - holdStartY) > 12)) {
            clearHoldTimer();
          }
        });
        userRow.addEventListener("pointerup", clearHoldTimer);
        userRow.addEventListener("pointercancel", clearHoldTimer);
        userRow.addEventListener("pointerleave", clearHoldTimer);
        userRow.addEventListener("contextmenu", event => {
          const target = event.target;
          if (target instanceof Element && target.closest(".user-bubble")) event.preventDefault();
        });
      }

      if (!window.__truxUserActionDismissBound) {
        window.__truxUserActionDismissBound = true;
        document.addEventListener("pointerdown", event => {
          const target = event.target;
          if (target instanceof Element &&
              (target.closest(".user-message-actions") || target.closest(".user-row.user-actions-visible"))) return;
          document.querySelectorAll(".user-row.user-actions-visible").forEach(row => {
            row.classList.remove("user-actions-visible");
          });
        }, true);
      }
    }

    function markPromptMessageStopped(assistantRow) {
      const session = chatSessions[currentChatId];
      const container = getActiveChatContainer();
      let userRow = assistantRow?.previousElementSibling;
      if (!userRow?.classList.contains("user-row")) {
        const userRows = Array.from(container?.querySelectorAll(".row.user-row") || []);
        userRow = userRows[userRows.length - 1] || null;
      }
      if (!userRow || !session?.messages) return;
      const index = findStoppedMessageIndex(userRow);
      if (index < 0) return;
      session.messages[index].stopped = true;
      saveChatSessions();
      userRow.dataset.messageIndex = String(index);
      attachUserMessageActions(userRow, index, String(session.messages[index].text || ""));
    }

    function appendMessageRow(label, text, rc, bc, imageUrl, animate, sources, videoUrl, messageMeta = null) {
      let chatContainer = getActiveChatContainer(), r = document.createElement("div");
      r.className = `row ${rc}` + (animate ? " appear" : "");
      let textContent = typeof text === "string" ? text : text?.text || "";

      if(rc.includes("user-row")) {
        // No stray newlines inside the bubble: it is white-space: pre-wrap,
        // so template indentation would render as blank lines.
        r.dataset.chatId = currentChatId || "";
        const userMessageIndex = Number.isInteger(messageMeta?.messageIndex)
          ? Number(messageMeta.messageIndex)
          : findStoppedMessageIndex(r, textContent);
        if (Number.isInteger(userMessageIndex) && userMessageIndex >= 0) r.dataset.messageIndex = String(userMessageIndex);
        r.innerHTML = `<div class="label">You</div><div class="bubble user-bubble">${escapeHtml(textContent).replace(/\n/g, "<br>")}</div>`;
        attachUserMessageActions(r, userMessageIndex, textContent);
      } else {
        r.innerHTML = `<div class="bubble ${bc}"></div><div class="actions"></div>`;
        let bubble = r.querySelector(".bubble");
        let actions = r.querySelector(".actions");

        bubble.innerHTML = renderFormattedText(textContent, false);
        renderTruxDiagrams(bubble);
        scheduleTruxMath(bubble);

        if(imageUrl) {
          let wrap = document.createElement("div"); wrap.className = "gen-image-wrap";
          let img = document.createElement("img"); img.src = imageUrl; img.alt = "Generated image";
          img.onload = () => img.classList.add("loaded");
          if(img.complete) img.classList.add("loaded");
          wrap.appendChild(img); bubble.appendChild(wrap);

          let dlBtn = document.createElement("button"); dlBtn.className = "act"; dlBtn.title = "Download image"; dlBtn.innerHTML = ICON.down + "Download";
          dlBtn.onclick = () => { let l = document.createElement("a"); l.href = imageUrl; l.download = `trux-omni-image-${Date.now()}.png`; l.click(); };
          actions.appendChild(dlBtn);
        }

        if(videoUrl) {
          let wrap = document.createElement("div");
          wrap.className = "gen-video-wrap";
          let video = document.createElement("video");
          video.src = videoUrl; video.controls = true; video.preload = "metadata"; video.playsInline = true;
          wrap.appendChild(video);
          bubble.appendChild(wrap);
          let openBtn = document.createElement("button");
          openBtn.className = "act"; openBtn.title = "Open video"; openBtn.textContent = "Open";
          openBtn.onclick = () => window.open(videoUrl, "_blank", "noopener");
          actions.appendChild(openBtn);
        }

        let readBtn = document.createElement("button"); readBtn.className = "act"; readBtn.title = "Read aloud"; readBtn.innerHTML = ICON.speak + "Read"; readBtn.onclick = () => speakText(textContent);
        let copyBtn = document.createElement("button"); copyBtn.className = "act"; copyBtn.title = "Copy answer"; copyBtn.innerHTML = ICON.copy + "Copy"; copyBtn.onclick = () => copyTextMessage(textContent, copyBtn);
        let pinBtn = document.createElement("button"); pinBtn.className = "act"; pinBtn.title = "Pin to insights"; pinBtn.innerHTML = ICON.pin + "Pin"; pinBtn.onclick = () => pinInsight(textContent);
        let regenBtn = document.createElement("button"); regenBtn.className = "act"; regenBtn.title = "Regenerate this answer"; regenBtn.innerHTML = ICON.redo + "Retry"; regenBtn.onclick = () => regenerateLast();

        if (!messageMeta?.incomplete) actions.append(readBtn, copyBtn, pinBtn, regenBtn);
        attachSources(r, sources);
      }

      chatContainer.appendChild(r); chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    /* =====================================================================
       PROGRESSIVE LINE-BATCH STREAM RENDERER

       Reveal complete display lines in small animation-frame batches. Markdown
       blocks that are complete are committed once; only the active block is
       refreshed. Each new line gets a subtle fade, with no synthetic cursor.
       ===================================================================== */

    function isNearBottom(el, slack) {
      return (el.scrollHeight - el.scrollTop - el.clientHeight) <= (slack || 120);
    }

    /* Split into top-level blocks on blank lines, but never inside a fence. */
    function splitStreamBlocks(text) {
      let lines = text.split("\n");
      let blocks = [];
      let cur = [];
      let inFence = false;

      for (let line of lines) {
        if (/^\s*```/.test(line)) {
          cur.push(line);
          if (inFence) { blocks.push(cur.join("\n")); cur = []; inFence = false; }
          else inFence = true;
          continue;
        }
        if (!inFence && !line.trim()) {
          if (cur.length) { blocks.push(cur.join("\n")); cur = []; }
          continue;
        }
        cur.push(line);
      }
      if (cur.length) blocks.push(cur.join("\n"));
      return blocks;
    }

    function createStreamRenderer(bubble) {
      /* Replace the existing renderer in place. No second layer or duplicate host. */
      bubble.innerHTML = '<div class="md-stream md-stream-fade-active"></div>';
      const host = bubble.firstElementChild;

      let target = "";
      let shown = 0;
      let settled = 0;
      let liveEl = null;
      let liveHtml = "";
      let finished = false;
      let stopped = false;
      let rafId = null;
      let doneCb = null;
      let lastRevealAt = -Infinity;

      const REVEAL_INTERVAL_MS = 24;
      const MAX_LINES_PER_TICK = 2;
      const measureCanvas = document.createElement("canvas");
      const measureContext = measureCanvas.getContext("2d");

      function nextLineEnd(text, from) {
        if (from >= text.length) return -1;

        const style = window.getComputedStyle(bubble);
        if (measureContext) {
          measureContext.font = style.font || (style.fontSize + " " + style.fontFamily);
        }
        const width = Math.max(80, (host.clientWidth || bubble.clientWidth || 360) - 10);
        let lastSpace = -1;

        for (let i = from; i < text.length; i++) {
          const ch = text[i];
          if (ch === "\n") return i + 1;

          const sample = text.slice(from, i + 1).replace(/[*_~]/g, "");
          const sampleWidth = measureContext
            ? measureContext.measureText(sample).width
            : sample.length * 8;

          if (sampleWidth > width && i > from) {
            return lastSpace >= from ? lastSpace + 1 : i;
          }
          if (/\s/.test(ch)) lastSpace = i;
        }

        /* A complete sentence is a natural release point for short prose lines. */
        const rest = text.slice(from);
        const punctuation = /[.!?]\s+/.exec(rest);
        const sentenceThreshold = Math.min(24, Math.floor(width / 8));
        if (punctuation && punctuation.index >= sentenceThreshold) {
          return from + punctuation.index + punctuation[0].length;
        }
        return -1;
      }

      function nextRevealOffset() {
        let cursor = shown;
        let end = shown;
        let lineCount = 0;

        while (cursor < target.length && lineCount < MAX_LINES_PER_TICK) {
          let boundary = nextLineEnd(target, cursor);
          if (boundary <= cursor) {
            /* Only flush an incomplete short final line after stream completion. */
            if (finished) boundary = target.length;
            else break;
          }
          end = boundary;
          cursor = boundary;
          lineCount++;
        }
        return end;
      }

      function commitBlock(html, isLive) {
        const el = document.createElement("div");
        el.className = "md-block" + (isLive ? " live" : "");
        el.innerHTML = html;
        host.appendChild(el);
        renderTruxDiagrams(el);
        return el;
      }

      function paint() {
        const visible = target.slice(0, shown);
        const blocks = splitStreamBlocks(visible);
        if (!blocks.length) return false;

        /* Commit completed Markdown blocks once; refresh only the active tail. */
        while (settled < blocks.length - 1) {
          if (liveEl) {
            if (liveEl.parentNode === host) host.removeChild(liveEl);
            liveEl = null;
            liveHtml = "";
          }
          const el = commitBlock(renderFormattedText(blocks[settled], false), false);
          setTimeout(() => el.classList.add("settled"), 400);
          settled++;
        }

        const tail = blocks[blocks.length - 1];
        const html = renderFormattedText(tail, !finished);
        if (html === liveHtml) return false;
        liveHtml = html;

        if (!liveEl) liveEl = commitBlock(html, true);
        else {
          const currentPending = liveEl.querySelector('.trux-diagram[data-trux-diagram-pending="true"]');
          if (currentPending) {
            const parsed = document.createElement("div"); parsed.innerHTML = html;
            const nextPending = parsed.querySelector('.trux-diagram[data-trux-diagram-pending="true"]');
            if (nextPending) {
              const oldSource = currentPending.querySelector(".trux-diagram-source");
              const newSource = nextPending.querySelector(".trux-diagram-source");
              if (oldSource && newSource) oldSource.textContent = newSource.textContent;
            } else liveEl.innerHTML = html;
          } else liveEl.innerHTML = html;
        }

        renderTruxDiagrams(liveEl);
        liveEl.classList.toggle("single-line", liveEl.offsetHeight < 46);
        return true;
      }

      function tick(timestamp) {
        rafId = null;
        if (stopped) return;
        if (!bubble.isConnected) {
          stopped = true;
          return;
        }

        /* A real, visible cadence is intentional: don't dump the final payload. */
        if (timestamp - lastRevealAt < REVEAL_INTERVAL_MS) {
          rafId = requestAnimationFrame(tick);
          return;
        }

        const container = getActiveChatContainer();
        const stick = isNearBottom(container);
        const nextShown = nextRevealOffset();
        let advanced = false;

        if (nextShown > shown) {
          shown = nextShown;
          lastRevealAt = timestamp;
          advanced = paint();
          if (stick) container.scrollTop = container.scrollHeight;
        }

        if (finished && shown >= target.length) {
          /* Keep the last lines fading gently after completion; resolve to crisp
             text over 2.6 seconds instead of clearing the mask abruptly. */
          host.classList.add("md-stream-fade-settling");
          host.innerHTML = renderFormattedText(target, false);
          renderTruxDiagrams(host);
          scheduleTruxMath(host);
          if (stick) container.scrollTop = container.scrollHeight;
          if (doneCb) {
            const callback = doneCb;
            doneCb = null;
            callback();
          }
          return;
        }

        /* Continue only while a full line is ready, or while draining a finished stream. */
        if (nextRevealOffset() > shown || finished) {
          rafId = requestAnimationFrame(tick);
        }
      }

      function start() {
        if (rafId === null && !stopped) rafId = requestAnimationFrame(tick);
      }

      return {
        push(chunk) {
          target += chunk;
          start();
        },
        setText(text) {
          target = String(text || "");
          /* Never let an updated authoritative payload expose half a word. */
          shown = Math.min(shown, target.length);
          while (shown > 0 && shown < target.length && !/\s/.test(target.charAt(shown - 1))) {
            shown--;
          }
          start();
        },
        finish(cb) {
          finished = true;
          doneCb = cb || null;
          if (!bubble.isConnected) {
            stopped = true;
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = null;
            return;
          }
          stopped = false;
          start();
        },
        cancel() {
          stopped = true;
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = null;
          host.classList.add("md-stream-fade-settling");
        },
        get received() { return target; }
      };
    }
    function formatCodexElapsed(ms) {
      const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours) return hours + "h " + minutes + "m " + seconds + "s";
      if (minutes) return minutes + "m " + seconds + "s";
      return seconds + "s";
    }

    function restoreCompletedCodeSteps(responseRow, message) {
      const stack = responseRow?.querySelector(".trux-response-stack");
      const bubble = responseRow?.querySelector(".trux-bubble");
      if (!stack || !bubble || stack.querySelector(".trux-thinking-panel")) return;
      const steps = Array.isArray(message?.toolEvents) ? message.toolEvents : [];
      if (!steps.length) return;
      const thid = "restored_th_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      const tsid = "restored_ts_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      const panel = document.createElement("div");
      panel.className = "trux-thinking-panel trux-code-thinking completed";
      panel.id = thid;
      panel.setAttribute("aria-label", "Executed steps");
      panel.innerHTML =
        '<div class="trux-thinking-bar">' +
          '<span class="trux-thinking-spark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 1.5C13.45 7.95 16.05 10.55 22.5 12C16.05 13.45 13.45 16.05 12 22.5C10.55 16.05 7.95 12 1.5 12C7.95 10.55 10.55 7.95 12 1.5Z"/></svg></span>' +
          '<div class="trux-thinking-copy"><span class="status-msg" role="status" aria-live="polite"><span class="thinking-status-line compact"></span><span class="thinking-status-line full"></span></span></div>' +
          '<button type="button" class="trux-thinking-toggle" hidden aria-expanded="false" aria-label="Show executed steps" title="Show executed steps"><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg></button>' +
        '</div>' +
        '<div class="trux-thinking-details" id="' + tsid + '" hidden></div>';
      const summary = "Worked for this response";
      panel.querySelectorAll(".thinking-status-line").forEach(line => {
        line.textContent = summary;
        line.title = summary;
      });
      panel.querySelector(".status-msg")?.setAttribute("aria-label", summary);
      stack.insertBefore(panel, bubble);
      const toggle = panel.querySelector(".trux-thinking-toggle");
      if (toggle) toggle.onclick = () => toggleThinkingDetails(thid);
      for (const event of steps) {
        if (event?.type === "tool_status") {
          appendToolStatusLine(tsid, event.tool || "TruX-Code", event.status || "", event.phase || "complete", event.details || null);
        } else if ((event?.type === "ai_step" || event?.type === "status") && (event.status || event.text)) {
          appendThinkingHistory(panel, event.status || event.text);
        }
      }
      const details = getEl(tsid);
      const toggleAfterRestore = panel.querySelector(".trux-thinking-toggle");
      if (toggleAfterRestore) toggleAfterRestore.hidden = !details?.children.length;
    }

    function persistTurnDraft(context, text, force = false) {
      if (!context?.chatId || incognitoMode || chatSessions[context.chatId]?.incognito) return;
      const value = String(text == null ? "" : text);
      context.latestText = value;
      const now = Date.now();
      if (!force && now - Number(context.lastPersistAt || 0) < 350) return;
      context.lastPersistAt = now;

      const session = chatSessions[context.chatId];
      if (!session?.messages) return;
      let draft = session.messages.find(message =>
        message?.role === "trux" && message.draftTurnId === context.turnKey
      );
      if (!draft) {
        if (!value) return;
        const insertAt = Math.min(Number(context.userMessageIndex) + 1, session.messages.length);
        draft = { role: "trux", text: "", incomplete: true, draftTurnId: context.turnKey };
        session.messages.splice(insertAt, 0, draft);
      }
      draft.text = value;
      draft.incomplete = true;

      // Keep the active response in memory and periodically persist it to the account's
      // cloud chat object. Device-local drafts never override the cloud snapshot.
      if(force || now - Number(context.lastCloudPersistAt || 0) >= 2500) {
        context.lastCloudPersistAt = now;
        void syncChatsToCloud(!!force);
      }
    }

    function restorePersistedTurnDraft(chatId) {
      // Any saved partial response is already part of the account cloud snapshot.
      // Remove a legacy local draft without ever reading it back into chat history.
      store.removeItem("trux_turn_draft_" + chatId);
    }

    function finalizeResponse(id, aid, text, prompt, voice, streamer, sources, turnContext = null) {
      let b = getEl(id);
      const responseRow = b?.closest(".row");
      const codingTurn = (turnContext?.mode || workspaceMode) === "coding";

      if (codingTurn && responseRow) {
        const panel = responseRow.querySelector(".trux-thinking-panel");
        if (panel) {
          panel.classList.add("completed");
          panel.removeAttribute("data-thinking-visible");
          panel.setAttribute("aria-label", "Executed steps");
          const summary = "Worked for this response";
          panel.querySelectorAll(".thinking-status-line").forEach(line => {
            line.textContent = summary;
            line.title = summary;
          });
          panel.querySelector(".status-msg")?.setAttribute("aria-label", summary);
          const toggle = panel.querySelector(".trux-thinking-toggle");
          if (toggle) {
            toggle.setAttribute("aria-label", "Show executed steps");
            toggle.title = "Show executed steps";
          }
          panel.querySelectorAll(".thinking-tool-item.active").forEach(item => {
            item.classList.remove("active");
            item.classList.add("completed");
          });
          const details = panel.querySelector(".trux-thinking-details");
          if (toggle && details) toggle.hidden = !details.children.length;
        }
      }

      if (b) {
        b.classList.remove("thinking");
        if (streamer) {
          streamer.setText(text);
          streamer.finish();
        } else {
          b.innerHTML = renderFormattedText(text, false);
          renderTruxDiagrams(b);
          scheduleTruxMath(b);
        }
      }

      let cleanSources = Array.isArray(sources) ? sources.filter(x => x && x.uri).slice(0, 6) : [];
      const resultChatId = turnContext?.chatId || currentChatId;
      const resultSession = chatSessions[resultChatId];
      if (resultSession?.messages) {
        let responseMessage = turnContext
          ? resultSession.messages.find(message =>
              message?.role === "trux" && message?.draftTurnId === turnContext.turnKey
            )
          : null;
        if (!responseMessage) {
          responseMessage = { role: "trux", text };
          const userIndex = Number.isInteger(turnContext?.userMessageIndex)
            ? turnContext.userMessageIndex
            : -1;
          const userMessage = userIndex >= 0 ? resultSession.messages[userIndex] : null;
          const userPosition = userMessage?.role === "user"
            ? resultSession.messages.indexOf(userMessage)
            : -1;
          if (userPosition >= 0) resultSession.messages.splice(userPosition + 1, 0, responseMessage);
          else resultSession.messages.push(responseMessage);
        }
        responseMessage.role = "trux";
        responseMessage.text = text;
        responseMessage.incomplete = false;
        delete responseMessage.draftTurnId;
        if (cleanSources.length) responseMessage.sources = cleanSources;
        else delete responseMessage.sources;
        if (codingTurn) {
          responseMessage.durationMs = durationMs;
          responseMessage.toolEvents = Array.isArray(turnContext?.toolEvents) ? turnContext.toolEvents : [];
        }
        if (turnContext) store.removeItem("trux_turn_draft_" + resultChatId);
        queueSidebarSync();
        void syncChatsToCloud(true).then(saved => {
          if(!saved && auth?.currentUser?.uid === cloudChatsOwnerUid) {
            toast("This reply is visible, but its cloud save was not confirmed. Keep TruX open and retry before leaving.", "err");
          }
        });
      }
      if(b) attachSources(b.closest(".row"), cleanSources);

      let tokensUsed = Math.ceil((prompt.length + text.length) / 4);
      if(currentPlanTier === "pro") recordProTokens(tokensUsed);
      if(currentPlanTier === "base") recordCoreTokens(tokensUsed);

      let a = getEl(aid);
      if(a) {
        a.innerHTML = "";
        let readBtn = document.createElement("button"); readBtn.className = "act"; readBtn.title = "Read aloud"; readBtn.innerHTML = ICON.speak + "Read"; readBtn.onclick = () => speakText(text);
        let copyBtn = document.createElement("button"); copyBtn.className = "act"; copyBtn.title = "Copy answer"; copyBtn.innerHTML = ICON.copy + "Copy"; copyBtn.onclick = () => copyTextMessage(text, copyBtn);
        let editBtn = document.createElement("button"); editBtn.className = "act"; editBtn.title = "Edit prompt"; editBtn.innerHTML = ICON.edit + "Edit"; editBtn.onclick = () => editPromptFromAssistantRow(responseRow);
        let pinBtn = document.createElement("button"); pinBtn.className = "act"; pinBtn.title = "Pin to insights"; pinBtn.innerHTML = ICON.pin + "Pin"; pinBtn.onclick = () => pinInsight(text);
        let regenBtn = document.createElement("button"); regenBtn.className = "act"; regenBtn.title = "Regenerate this answer"; regenBtn.innerHTML = ICON.redo + "Retry"; regenBtn.onclick = () => regenerateLast();
        a.append(readBtn, copyBtn, editBtn, pinBtn, regenBtn);
      }

      if (!turnContext || turnContext.turnId === generationEpoch) {
        isGenerating = false;
        activeAbortController = null;
        if (activeTurnContext === turnContext) activeTurnContext = null;
        getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>';
        getEl("actionBtn").classList.remove("stop");
        handleInputChange();
      }
      if(voice || getEl("autoReadToggle")?.checked) speakText(text);
    }

    /* ============ Image generation now works from ANY model (no separate model) ============ */
    /* opts.row        - reuse an existing assistant row (model-routed turn)
       opts.reuseTurn   - the user message/row already exist, don't add them again
       opts.imagePrompt - the prompt the MODEL wrote for the picture */
    async function generateImage(basePrompt, opts) {
      opts = opts || {};
      const turnId = ++generationEpoch;
      let imagePrompt = opts.imagePrompt || basePrompt;
      enterChatWorkspace();
      document.body.removeAttribute("data-media-mode");
      isGenerating = true; isScrolledUp = false;
      getEl("btnIcon").innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>'; getEl("actionBtn").classList.add("stop"); getEl("actionBtn").classList.remove("ready");
      handleInputChange();

      if(!currentChatId) { currentChatId = "chat_" + Date.now(); chatSessions[currentChatId] = { title: basePrompt ? basePrompt.slice(0, 32) : "Image", mode: workspaceMode, notebookId: notebookIdForNewChat(), messages: [] }; }
      if(!opts.reuseTurn) {
        chatSessions[currentChatId].messages.push({ role: "user", text: basePrompt });
        saveChatSessions();
      }

      getEl("welcomeScreen").style.display = "none";
      let chatContainer = getActiveChatContainer(); chatContainer.style.display = "block";

      if(!opts.reuseTurn) {
        appendMessageRow("You", basePrompt, "user-row", "user-bubble", null, true);
        getEl("promptInput").value = ""; handleInputChange();
      }

      let row = opts.row || document.createElement("div");
      row.className = "row trux-row appear";
      let aid = "a_" + Date.now();
      row.innerHTML = `<div class="label">${BRAND_LABEL}</div><div class="bubble trux-bubble">
          <div class="gen-image-card">
            <div class="gen-image-particles"><div class="dot-ring"><span></span><span></span><span></span></div></div>
            <div class="gen-image-label">Creating your image…</div>
          </div>
        </div><div class="actions" id="${aid}"></div>`;
      if(!opts.row) chatContainer.appendChild(row);
      chatContainer.scrollTop = chatContainer.scrollHeight;

      activeAbortController = new AbortController();
      try {
        const imageUser = auth?.currentUser;
        let res = await truxAuthenticatedFetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: activeAbortController.signal,
          body: JSON.stringify({ message: imagePrompt, tier: currentPlanTier, mode: "image", generateImage: true, userId: imageUser?.uid || null, userEmail: imageUser?.email || "" })
        }, imageUser);
        let payload = await res.json().catch(() => ({}));

        if(payload.imageLimitReached || !payload.imageGenerated || !payload.image?.dataUrl) {
          throw Error(payload.reply || "Image generation failed.");
        }

        let bubble = row.querySelector(".bubble");
        let replyText = payload.reply || "Your image is ready.";
        bubble.innerHTML = renderFormattedText(replyText, false);
        renderTruxDiagrams(bubble);
        let wrap = document.createElement("div"); wrap.className = "gen-image-wrap";
        let img = document.createElement("img"); img.src = payload.image.dataUrl; img.alt = payload.image.alt || "Generated image";
        img.onload = () => img.classList.add("loaded");
        if(img.complete) img.classList.add("loaded");
        wrap.appendChild(img); bubble.appendChild(wrap);

        chatSessions[currentChatId].messages.push({ role: "trux", text: replyText, image: payload.image.dataUrl });
        await saveGeneratedMedia({ type:"image", dataUrl:payload.image.dataUrl, prompt:imagePrompt, mimeType:"image/png" });
        saveChatSessions();

        let a = getEl(aid);
        if(a) {
          let dlBtn = document.createElement("button"); dlBtn.className = "act"; dlBtn.title = "Download image"; dlBtn.innerHTML = ICON.down + "Download";
          dlBtn.onclick = () => { let l = document.createElement("a"); l.href = payload.image.dataUrl; l.download = `trux-omni-image-${Date.now()}.png`; l.click(); };
          a.append(dlBtn);
        }

        let iu = getImageUsageData();
        iu.count = typeof payload.imageGenerationsUsed === "number" ? payload.imageGenerationsUsed : iu.count + 1;
        store.setItem("trux_image_usage", JSON.stringify(iu));
        updateAllUsageUI();
      } catch(e) {
        if (turnId !== generationEpoch) return;
        let bubble = row.querySelector(".bubble");
        bubble.innerHTML = e.name === "AbortError" ? "Generation stopped." : "Error: " + escapeHtml(e.message);
      } finally {
        if (turnId !== generationEpoch) return;
        isGenerating = false; activeAbortController = null;
        getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>'; getEl("actionBtn").classList.remove("stop"); handleInputChange();
      }
    }


    function githubProposalPreview(text) {
      const clean = String(text || "");
      if (clean.length <= 1400) return clean;
      return clean.slice(0, 1400) + "\n…";
    }

    function renderGithubProposalCard(container, proposal) {
      if(!container || !proposal) return;
      container.querySelector(".github-proposal-card")?.remove();

      const card = document.createElement("div");
      card.className = "github-proposal-card";
      card.dataset.chatId = currentChatId || "";

      const title = document.createElement("div");
      title.className = "github-proposal-title";
      title.textContent = "GitHub changes ready for review";

      const summary = document.createElement("div");
      summary.className = "github-proposal-summary";
      summary.textContent = proposal.summary || "TruX-Code prepared repository changes.";

      const files = document.createElement("div");
      files.className = "github-proposal-files";

      const proposalEdits = Array.isArray(proposal.edits) ? proposal.edits : [];
      const duplicatePaths = [];

      (proposalEdits).forEach(edit => {
        const file = document.createElement("div");
        file.className = "github-proposal-file";

        const name = document.createElement("div");
        name.className = "github-proposal-file-name";
        name.textContent = edit.path || "unknown file";

        const stats = document.createElement("div");
        stats.className = "github-proposal-file-stats";
        stats.textContent = `Replace ${Number(edit.oldChars || String(edit.oldText || "").length).toLocaleString()} chars → ${Number(edit.newChars || String(edit.newText || "").length).toLocaleString()} chars`;

        const details = document.createElement("details");
        const summaryEl = document.createElement("summary");
        summaryEl.textContent = "Review exact change";
        const diff = document.createElement("div");
        diff.className = "github-proposal-diff";

        const oldBox = document.createElement("pre");
        oldBox.textContent = "OLD\n" + githubProposalPreview(edit.oldText);
        const newBox = document.createElement("pre");
        newBox.textContent = "NEW\n" + githubProposalPreview(edit.newText);

        diff.append(oldBox, newBox);
        details.append(summaryEl, diff);
        file.append(name, stats, details);
        files.appendChild(file);
      });

      const actions = document.createElement("div");
      actions.className = "github-proposal-actions";

      const apply = document.createElement("button");
      apply.className = "github-proposal-apply";
      apply.textContent = "Apply changes";
      apply.onclick = () => applyGithubProposal(proposal, card, apply, cancel, status);

      const cancel = document.createElement("button");
      cancel.className = "github-proposal-cancel";
      cancel.textContent = "Cancel";
      cancel.onclick = () => {
        apply.disabled = true;
        cancel.disabled = true;
        status.textContent = "Changes were not applied.";
      };

      const status = document.createElement("div");
      status.className = "github-proposal-status";
      status.textContent = `Nothing has been written yet · review the changes, then tap Apply changes · ${proposal.repository || "GitHub"}${proposal.branch ? " · " + proposal.branch : ""}`;

      if(duplicatePaths.length) {
        apply.disabled = true;
        cancel.disabled = true;
        status.textContent = "This proposal contains an invalid edit path.";
      }

      actions.append(apply, cancel);
      card.append(title, summary, files, actions, status);
      container.appendChild(card);
    }

    function appendGithubCommitResponse(proposal, commit, chatId = currentChatId) {
      if (!commit?.sha) return;
      if (proposal?.__commitResponseShown) return;

      const targetChatId = chatId || currentChatId;
      const session = targetChatId ? chatSessions[targetChatId] : null;
      if(!session?.messages) return;

      proposal.__commitResponseShown = true;

      const shortSha = commit.shortSha || String(commit.sha).slice(0, 7);
      const fileCount = Array.isArray(proposal?.edits) ? proposal.edits.length : 0;
      const responseText =
        `Done — I applied the reviewed changes to ${proposal.repository || "your GitHub repository"} and verified the saved result.

**Commit:** \`${shortSha}\`
**Files:** ${fileCount}
**Message:** ${commit.message || proposal.commitMessage || "Update files with TruX-Code"}

[View commit on GitHub](${commit.url || `https://github.com/${proposal.repository}/commit/${commit.sha}`})`;

      session.messages.push({
        role: "trux",
        text: responseText,
        githubCommit: {
          sha: commit.sha,
          url: commit.url || "",
          message: commit.message || ""
        }
      });
      saveChatSessions();

      appendMessageRow("TruX-Omni", responseText, "trux-row", "trux-bubble", null, true);
    }

    async function applyGithubProposal(proposal, card, apply, cancel, status) {
      if(!proposal || !Array.isArray(proposal.edits) || !proposal.edits.length) return;
      if(card?.dataset.applied === "true" || card?.dataset.applying === "true") return;

      card.dataset.applying = "true";
      apply.disabled = true;
      cancel.disabled = true;
      status.textContent = "Validating the reviewed changes against the current repository…";

      try {
        const r = await truxAuthenticatedFetch("/api/github/apply-edits", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repository: proposal.repository,
            branch: proposal.branch || "",
            edits: proposal.edits,
            message: proposal.commitMessage || "Update files with TruX-Code",
            confirmed: true
          })
        }, auth?.currentUser);
        const d = await r.json().catch(() => ({}));

        if(!r.ok || d.ok !== true || d.applied !== true || d.verified !== true || !d.commit?.sha) {
          throw Error(d.error || "GitHub did not confirm a verified apply.");
        }

        const shortSha = d.commit.shortSha || String(d.commit.sha).slice(0, 7);
        status.textContent = `Applied & verified · one commit ${shortSha} created.`;
        card.dataset.applied = "true";
        delete card.dataset.applying;
        apply.textContent = "Applied";
        appendGithubCommitResponse(proposal, d.commit, card?.dataset.chatId || currentChatId);
      } catch(e) {
        delete card.dataset.applying;
        status.textContent = e.message || "The changes could not be safely applied.";
        apply.disabled = false;
        cancel.disabled = false;
      }
    }

    function appendToolStatusLine(toolId, tool, detail, phase = "complete", details = null) {
      const wrap = getEl(toolId);
      if (!wrap) return;
      const toolName = String(tool || "External tool").trim();
      const text = String(detail || "");
      const callId = String(details?.id || "");
      const serializedArgs = details?.args && typeof details.args === "object"
        ? JSON.stringify(details.args)
        : "";
      const signature = callId || (toolName + "||" + serializedArgs);

      let item = Array.from(wrap.querySelectorAll(".thinking-tool-item")).find(el => el.dataset.signature === signature);
      if (!item && phase === "start") {
        item = document.createElement("div");
        item.className = "thinking-tool-item active";
        item.dataset.signature = signature;
        wrap.appendChild(item);
      }
      if (!item) {
        item = wrap.querySelector(".thinking-tool-item.active:last-child") || wrap.lastElementChild;
        if (!item) {
          item = document.createElement("div");
          item.className = "thinking-tool-item";
          item.dataset.signature = signature;
          wrap.appendChild(item);
        }
      }

      const target = String(details?.target || toolName).trim() || toolName;
      const failureText = /failed|error|authorization required|configuration error/i.test(text);
      const succeeded = typeof details?.ok === "boolean" ? details.ok : !failureText;
      item.classList.toggle("active", phase === "start");
      item.classList.toggle("completed", phase !== "start" && succeeded);
      item.classList.toggle("failed", phase !== "start" && !succeeded);

      let head = item.querySelector(".thinking-tool-head");
      if (!head) { head = document.createElement("div"); head.className = "thinking-tool-head"; item.appendChild(head); }
      head.textContent = target;

      // Keep the thinking bar compact: never print raw tool arguments or large
      // provider responses here. Terminal commands and their output are rendered
      // separately in the TruX-Code terminal.
      item.querySelector(".thinking-tool-meta")?.remove();
      item.querySelector(".thinking-tool-result")?.remove();
      let status = item.querySelector(".thinking-tool-status");
      if (!status) {
        status = document.createElement("div");
        status.className = "thinking-tool-status";
        item.appendChild(status);
      }
      status.classList.toggle("failed", phase !== "start" && !succeeded);
      status.textContent = phase === "start" ? "(running…)" : (succeeded ? "(success)" : "(failed)");

      const panel = wrap.closest(".trux-thinking-panel");
      panel?.classList.add("has-tools");
      const toggle = panel?.querySelector(".trux-thinking-toggle");
      if (toggle) toggle.hidden = false;

      const container = getActiveChatContainer();
      if (phase === "start" && container && isNearBottom(container, 140)) {
        requestAnimationFrame(() => {
          if (container === getActiveChatContainer()) container.scrollTop = container.scrollHeight;
        });
      }
    }

    function settleThinkingDetails(toolId) {
      const wrap = getEl(toolId);
      if(!wrap) return;
      wrap.querySelectorAll(".thinking-tool-item.active").forEach(item => item.classList.remove("active"));
      if(!wrap.children.length) {
        wrap.hidden = true;
        wrap.style.display = "none";
      }
    }

    /* Re-runs the last user turn: drops the trailing assistant message from
       history and its row from the DOM, then re-sends. */
    function regenerateLast() {
      if(isGenerating) return toast("Still generating - stop it first.");
      let msgs = chatSessions[currentChatId]?.messages;
      if(!msgs || !msgs.length) return;
      let lastUser = [...msgs].reverse().find(m => m.role === "user");
      if(!lastUser?.text) return toast("Nothing to regenerate.");
      while(msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
      msgs.pop();
      saveChatSessions();
      let rows = getActiveChatContainer().querySelectorAll(".row");
      for(let i = rows.length - 1; i >= 0; i--) {
        let isUser = rows[i].classList.contains("user-row");
        rows[i].remove();
        if(isUser) break;
      }
      getEl("promptInput").value = lastUser.text;
      handleInputChange();
      sendPrompt();
    }

    function normalizeAiActivity(text) {
      return String(text == null ? "" : text)
        .replace(/[\u0000-\u001F]/g," ")
        .replace(/\s+/g," ")
        .trim()
        .slice(0,300);
    }

    function compactAiActivity(text) {
      const clean = normalizeAiActivity(text);
      if (!clean) return "";
      const words = clean.split(/\s+/).filter(Boolean);
      if (words.length <= 4) return clean;
      return words.slice(0,4).join(" ").replace(/[,:;.!?…]+$/,"") + "…";
    }

    function appendThinkingHistory(panel, text) {
      const details = panel?.querySelector?.(".trux-thinking-details");
      if (!details || !text) return;
      if (Array.from(details.children).some(item => item.dataset?.activity === text)) return;
      const item = document.createElement("div");
      item.className = "thinking-status-step";
      item.dataset.activity = text;
      item.textContent = text;
      details.appendChild(item);
      const toggle = panel.querySelector(".trux-thinking-toggle");
      if (toggle) toggle.hidden = false;
    }

    function toggleThinkingDetails(panelId) {
      const panel = getEl(panelId);
      if (!panel) return;
      const details = panel.querySelector(".trux-thinking-details");
      const toggle = panel.querySelector(".trux-thinking-toggle");
      if (!details || !toggle) return;
      const expanded = !panel.classList.contains("expanded");
      panel.classList.toggle("expanded", expanded);
      details.hidden = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      const completed = panel.classList.contains("completed");
      const expandedLabel = completed ? "Hide executed steps" : "Minimize AI activity";
      const collapsedLabel = completed ? "Show executed steps" : "Expand AI activity";
      toggle.setAttribute("aria-label", expanded ? expandedLabel : collapsedLabel);
      toggle.title = expanded ? expandedLabel : collapsedLabel;
      if (expanded) requestAnimationFrame(() => { details.scrollTop = completed ? 0 : details.scrollHeight; });
    }

    function dismissThinkingPanel(row) {
      const panel = row?.querySelector?.(".trux-thinking-panel");
      if (!panel) return;
      panel.classList.add("thinking-dismissed");
      panel.setAttribute("aria-hidden", "true");
      setTimeout(() => panel.remove(), 140);
    }

    function getAssistantTurnUserRow(responseRow) {
      if (!responseRow) return null;
      let userRow = responseRow.previousElementSibling;
      if (userRow?.classList.contains("user-row")) return userRow;
      const rows = getActiveChatContainer()?.querySelectorAll(".row.user-row") || [];
      return rows[rows.length - 1] || null;
    }

    function editPromptFromAssistantRow(responseRow) {
      if (isGenerating) return toast("Stop the current generation first.", "err");
      const session = chatSessions[currentChatId];
      const userRow = getAssistantTurnUserRow(responseRow);
      if (!userRow || !session?.messages) return toast("The original prompt is unavailable.", "err");
      const index = findStoppedMessageIndex(userRow, userRow.querySelector(".user-bubble")?.textContent || "");
      if (index < 0) return toast("The original prompt is unavailable.", "err");
      const promptText = String(session.messages[index]?.text || "");
      session.messages.splice(index, 1);
      if (session.messages[index]?.role === "trux") session.messages.splice(index, 1);
      saveChatSessions();
      responseRow.remove();
      userRow.remove();
      const input = getEl("promptInput");
      input.value = promptText;
      input.focus();
      handleInputChange();
    }

    function renderBrowserPreview(responseRow, event) {
      if (!responseRow || !event?.screenshotBase64) return;
      const stack = responseRow.querySelector(".trux-response-stack");
      if (!stack) return;
      const sourceUrl = String(event.url || "");
      let preview = Array.from(stack.querySelectorAll("[data-trux-browser-preview]"))
        .find(node => node.dataset.previewUrl === sourceUrl);
      if (!preview) {
        preview = document.createElement("section");
        preview.className = "trux-browser-preview";
        preview.dataset.truxBrowserPreview = "1";
        preview.dataset.previewUrl = sourceUrl;
        const header = document.createElement("div");
        header.className = "trux-browser-preview-head";
        const heading = document.createElement("strong");
        heading.className = "trux-browser-preview-title";
        const meta = document.createElement("span");
        meta.className = "trux-browser-preview-meta";
        header.append(heading, meta);
        const image = document.createElement("img");
        image.className = "trux-browser-preview-image";
        image.alt = "Live rendered website screenshot";
        image.loading = "lazy";
        image.decoding = "async";
        const link = document.createElement("a");
        link.className = "trux-browser-preview-link";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open website";
        preview.append(header, image, link);
        preview._title = heading; preview._meta = meta; preview._image = image; preview._link = link;
        stack.insertBefore(preview, stack.querySelector("[data-trux-terminal-window]") || stack.querySelector(".bubble"));
      }
      if (preview._title) preview._title.textContent = String(event.title || "Live website preview").slice(0, 240);
      if (preview._meta) preview._meta.textContent =
        (event.httpStatus == null ? "Browser-rendered" : "HTTP " + String(event.httpStatus)) +
        " · " + (event.viewport === "mobile" ? "Mobile" : "Desktop");
      if (preview._image) preview._image.src =
        "data:" + String(event.screenshotMimeType || "image/jpeg") + ";base64," + String(event.screenshotBase64);
      if (preview._link && /^https?:\/\//i.test(sourceUrl)) preview._link.href = sourceUrl;
    }

    function escapeTerminalText(value) {
      return escapeHtml(String(value == null ? "" : value));
    }

    function ensureTruxTerminal(responseRow) {
      const stack = responseRow?.querySelector?.(".trux-response-stack");
      if (!stack) return null;
      let win = stack.querySelector("[data-trux-terminal-window]");
      if (!win) {
        win = document.createElement("div");
        win.className = "trux-terminal-window";
        win.setAttribute("data-trux-terminal-window", "1");
        win.hidden = true;
        stack.insertBefore(win, stack.querySelector(".bubble"));
      }
      if (!win.querySelector(".trux-terminal-head")) {
        win.innerHTML =
          '<div class="trux-terminal-head">' +
            '<span class="trux-terminal-dots"><i></i><i></i><i></i></span>' +
            '<span class="trux-terminal-title">TruX Terminal</span>' +
            '<button type="button" class="trux-terminal-toggle" onclick="toggleTruxTerminal(this)" aria-label="Collapse terminal">COLLAPSE</button>' +
          '</div>' +
          '<div class="trux-terminal-body"></div>';
      }
      win.hidden = false;
      return win;
    }

    function toggleTruxTerminal(button) {
      const win = button?.closest?.(".trux-terminal-window");
      if (!win) return;
      const collapsed = !win.classList.contains("collapsed");
      win.classList.toggle("collapsed", collapsed);
      button.textContent = collapsed ? "EXPAND" : "COLLAPSE";
      button.setAttribute("aria-label", collapsed ? "Expand terminal" : "Collapse terminal");
    }

    function renderTerminalEvent(responseRow, event) {
      if (!responseRow || workspaceMode !== "coding") return;
      const win = ensureTruxTerminal(responseRow);
      if (!win) return;
      const body = win.querySelector(".trux-terminal-body");
      if (!body) return;

      if (event.phase === "start") {
        const entry = document.createElement("div");
        entry.className = "trux-terminal-entry";
        entry.innerHTML =
          '<div class="trux-terminal-command">' +
            '<span class="trux-terminal-prompt">›</span>' +
            '<code>' + escapeTerminalText(event.command || "") + '</code>' +
          '</div>' +
          '<div class="trux-terminal-output"></div>';
        body.appendChild(entry);
        responseRow._activeTerminalEntry = entry;
      } else if (event.phase === "output") {
        const entry = responseRow._activeTerminalEntry || body.lastElementChild;
        const output = entry?.querySelector?.(".trux-terminal-output");
        if (output && event.text) {
          output.textContent += String(event.text);
        }
      } else if (event.phase === "complete") {
        const entry = responseRow._activeTerminalEntry || body.lastElementChild;
        const output = entry?.querySelector?.(".trux-terminal-output");
        if (output) {
          if (event.stderr && !output.textContent.includes(event.stderr)) {
            output.textContent += (output.textContent ? "\n" : "") + String(event.stderr);
          }
          if (!output.textContent && event.stdout) output.textContent = String(event.stdout);
          output.classList.toggle("error", !event.success);
        }
        if (entry) {
          const exit = document.createElement("div");
          exit.className = "trux-terminal-exit";
          exit.textContent =
            (event.success ? "Process finished" : "Process failed") +
            " · exit " + String(event.code ?? 1) +
            " · " + String(event.durationMs || 0) + " ms";
          entry.appendChild(exit);
        }
        responseRow._activeTerminalEntry = null;
      }

      body.scrollTop = body.scrollHeight;
    }

    function setThinkingStatus(statusId, text) {
      const el = getEl(statusId);
      if (!el) return;
      const next = normalizeAiActivity(text);
      if (!next) return;
      const compact = compactAiActivity(next);
      const compactLine = el.querySelector(".thinking-status-line.compact");
      const fullLine = el.querySelector(".thinking-status-line.full");
      const currentLine = fullLine || compactLine;
      const previous = String(fullLine?.textContent || currentLine?.textContent || "").trim();
      const panel = el.closest(".trux-thinking-panel");
      if (panel?.classList.contains("completed")) return;
      const activityKey = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (panel && !(panel._seenThinkingActivities instanceof Set)) {
        panel._seenThinkingActivities = new Set();
      }
      const seenActivities = panel?._seenThinkingActivities;
      const isPlaceholderActivity = value => /^(?:thinking|working|processing)(?:[ .…]*)?$/i.test(String(value || "").trim());
      const previousKey = activityKey(previous);
      const nextKey = activityKey(next);
      if (seenActivities && previousKey) seenActivities.add(previousKey);
      if (previous === next || (seenActivities && nextKey && seenActivities.has(nextKey))) return;
      if (seenActivities && nextKey) seenActivities.add(nextKey);
      if (previous && !isPlaceholderActivity(previous)) appendThinkingHistory(panel, previous);
      if (compactLine) compactLine.textContent = compact;
      if (fullLine) { fullLine.textContent = next; fullLine.title = next; }
      else {
        currentLine.textContent = compact;
        currentLine.title = next;
      }
      if (panel) {
        panel.classList.add("has-activity");
        if (!isPlaceholderActivity(next)) appendThinkingHistory(panel, next);
        const details = panel.querySelector(".trux-thinking-details");
        if (details && panel.classList.contains("expanded")) {
          requestAnimationFrame(() => { details.scrollTop = details.scrollHeight; });
        }
      }
    }

    let truxHomeGreetingTimers = [];
    let truxHomePromptRequest = null;
    let truxHomePromptLastLoadedAt = 0;
    let truxHomePromptRetryCount = 0;
    function clearHomeGreetingTimers() {
      truxHomeGreetingTimers.forEach(id => clearTimeout(id));
      truxHomeGreetingTimers = [];
    }

    function renderHomePrompts(prompts) {
      const panel = getEl("truxHomePrompts");
      if (!panel || !Array.isArray(prompts)) return false;
      const cleanPrompts = [...new Set(prompts
        .map(prompt => String(prompt || "").replace(/\s+/g, " ").trim())
        .filter(prompt => prompt.length >= 8 && prompt.length <= 100))];
      if (cleanPrompts.length !== 3) return false;

      const buttons = cleanPrompts.map(cleanPrompt => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "trux-home-prompt";
        const mark = document.createElement("span");
        mark.className = "trux-home-prompt-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "↗";
        const label = document.createElement("span");
        label.className = "trux-home-prompt-label";
        label.textContent = cleanPrompt;
        button.append(mark, label);
        button.addEventListener("click", () => quickPrompt(cleanPrompt));
        return button;
      });
      panel.replaceChildren(...buttons);
      panel.hidden = false;
      return true;
    }

    async function loadHomePrompts() {
      if (!document.body.classList.contains("home-active")) return;
      if (truxHomePromptRequest) return truxHomePromptRequest;
      if (truxHomePromptLastLoadedAt && Date.now() - truxHomePromptLastLoadedAt < 4 * 60 * 1000) return;
      const panel = getEl("truxHomePrompts");
      if (!panel) return;

      truxHomePromptRequest = (async () => {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ mode: "home-prompts" })
        });
        if (!response.ok) throw new Error("Home prompt generation unavailable.");
        const payload = await response.json().catch(() => ({}));
        if (!document.body.classList.contains("home-active")) return;
        if (!Array.isArray(payload.prompts) || payload.prompts.length !== 3 || !renderHomePrompts(payload.prompts)) {
          throw new Error("Home prompts response did not contain three usable suggestions.");
        }
        if (panel.children.length === 3) {
          truxHomePromptLastLoadedAt = Date.now();
          truxHomePromptRetryCount = 0;
        }
      })().catch(error => {
        console.debug("TruX home prompts unavailable:", error?.message || error);
        if (
          document.body.classList.contains("home-active") &&
          !truxHomePromptLastLoadedAt &&
          truxHomePromptRetryCount < 2
        ) {
          truxHomePromptRetryCount += 1;
          const retryDelay = 1200 * truxHomePromptRetryCount;
          const timer = setTimeout(() => {
            if (document.body.classList.contains("home-active")) void loadHomePrompts();
          }, retryDelay);
          truxHomeGreetingTimers.push(timer);
        }
      }).finally(() => {
        truxHomePromptRequest = null;
      });
      return truxHomePromptRequest;
    }

    function startHomeGreetingPulse() {
      clearHomeGreetingTimers();
      const text = getEl("truxHomeSequenceText");
      if (!text) return;

      text.hidden = false;
      text.textContent = "Hello";
      text.classList.remove("is-visible", "is-replacing");
      requestAnimationFrame(() => {
        if (document.body.classList.contains("home-active")) text.classList.add("is-visible");
      });

      const schedule = (fn, ms) => {
        const timer = setTimeout(fn, ms);
        truxHomeGreetingTimers.push(timer);
        return timer;
      };

      schedule(() => {
        if (!document.body.classList.contains("home-active")) return;
        text.classList.add("is-replacing");
        schedule(() => {
          if (!document.body.classList.contains("home-active")) return;
          text.textContent = "I am TruX";
          text.classList.remove("is-replacing");
          text.classList.add("is-visible");
        }, 180);
      }, 1500);

      schedule(() => {
        if (!document.body.classList.contains("home-active")) return;
        text.classList.remove("is-visible");
        text.classList.add("is-replacing");
        schedule(() => {
          if (!document.body.classList.contains("home-active")) return;
          text.textContent = "How can I help you?";
          text.classList.remove("is-replacing");
          text.classList.add("is-visible");
        }, 180);
      }, 3000);

      void loadHomePrompts();
    }

    const TRUX_CODE_IDLE_LINES = [
      "Hello",
      "What should we build today?",
      "Let's build something useful."
    ];
    let truxCodeIdleIndex = 0;
    let truxCodeIdleTimer = null;
    let truxCodeGreetingSwapTimer = null;
    function startTruxCodeIdlePulse() {
      if (truxCodeIdleTimer) clearInterval(truxCodeIdleTimer);
      if (truxCodeGreetingSwapTimer) clearTimeout(truxCodeGreetingSwapTimer);
      truxCodeIdleTimer = null;
      truxCodeGreetingSwapTimer = null;
      const transcript = getEl("codeChatContainer");
      const el = getEl("truxCodeGreeting");
      if (!el || !document.body.classList.contains("coding-workspace") ||
          currentChatId || (transcript && transcript.children.length)) return;
      const pulse = () => {
        if (!el.isConnected || !document.body.classList.contains("coding-workspace") ||
            currentChatId || (transcript && transcript.children.length)) {
          if (truxCodeIdleTimer) clearInterval(truxCodeIdleTimer);
          if (truxCodeGreetingSwapTimer) clearTimeout(truxCodeGreetingSwapTimer);
          truxCodeIdleTimer = null;
          truxCodeGreetingSwapTimer = null;
          return;
        }
        const next = TRUX_CODE_IDLE_LINES[truxCodeIdleIndex++ % TRUX_CODE_IDLE_LINES.length];
        el.classList.remove("is-visible");
        el.classList.add("is-replacing");
        truxCodeGreetingSwapTimer = setTimeout(() => {
          if (!el.isConnected || !document.body.classList.contains("coding-workspace") ||
              currentChatId || (transcript && transcript.children.length)) return;
          el.textContent = next;
          el.classList.remove("is-replacing");
          el.classList.add("is-visible");
          truxCodeGreetingSwapTimer = null;
        }, 180);
      };
      truxCodeIdleIndex = 1;
      el.textContent = TRUX_CODE_IDLE_LINES[0];
      el.classList.remove("is-replacing");
      el.classList.add("is-visible");
      truxCodeIdleTimer = setInterval(pulse, 3200);
    }


    function isNetworkFailure(error) {
      if (!error || error.name === "AbortError") return false;
      const msg = String(error.message || error || "").toLowerCase();
      return navigator.onLine === false ||
        /failed to fetch|networkerror|network error|load failed|err_internet_disconnected|err_network_changed|connection reset|connection closed|fetch failed/i.test(msg);
    }

    function waitForInternet(statusId) {
      return new Promise(resolve => {
        let pulse;
        const finish = (restored = true) => {
          cleanup();
          if (restored) setThinkingStatus(statusId, "Internet connection restored — continuing…");
          resolve();
        };
        const cleanup = () => {
          window.removeEventListener("online", finishOnline);
          if (pulse) clearInterval(pulse);
        };
        const finishOnline = () => finish(true);

        setThinkingStatus(statusId, "Waiting for internet connection…");
        window.addEventListener("online", finishOnline, { once: true });

        pulse = setInterval(() => {
          if (!isGenerating) {
            finish(false);
          } else if (navigator.onLine) {
            finish(true);
          } else {
            setThinkingStatus(statusId, "Still waiting for internet connection…");
          }
        }, 1500);
      });
    }

    function looksLikeImageGenerationRequest(text) {
      const value = String(text || "").trim().toLowerCase();
      if (!value) return false;

      // Diagrams are native rendered SVG, not image-generation requests.
      if (/\b(?:diagram|flowchart|sequence diagram|architecture diagram|mind ?map|er diagram|uml|state diagram|gantt chart|class diagram|process flow|network topology)\b/i.test(value)) return false;

      // Do not hijack requests that are clearly asking about an existing image.
      if (/\b(analy[sz]e|describe|explain|read|ocr|identify|interpret|what(?:'s| is) in)\b/.test(value)) {
        return false;
      }

      const imageNoun = /\b(image|picture|photo|poster|wallpaper|illustration|artwork|logo|avatar)\b/.test(value);
      const generationVerb = /\b(generate|create|draw|make|design|render|paint|illustrate)\b/.test(value);
      return generationVerb && (imageNoun || /\b(draw|generate|create|paint|illustrate)\b/.test(value));
    }

    async function sendPromptImpl() {
      // Prime Android's user-activation-gated Vibration API inside the send gesture.
      try {
        if (typeof navigator.vibrate === "function") navigator.vibrate(0);
      } catch (_) {}
      // Wait for Firebase to restore a saved session before showing sign-in.
      if (!truxAuthStateReady) {
        const restoredUser = await waitForTruxAuthState();
        if (restoredUser === undefined && !truxAuthStateReady) {
          toast("Still restoring your sign-in session. Please try sending again.", "err");
          return;
        }
      }
      if (!auth?.currentUser) { openLoginWall(); return; }

      let promptInput = getEl("promptInput");
      let basePrompt = promptInput.value.trim();
      let prompt = basePrompt;
      const allAttachments = pastedTextBlocks.map(b => ({ kind: "text", name: b.name || "pasted.txt", text: b.text, mimeType: "text/plain" }))
        .concat(fileAttachments.map(b => ({
          kind: b.objectKey ? "stored" : (b.dataUrl ? "file" : "text"),
          name: b.name,
          text: b.text,
          dataUrl: b.dataUrl,
          mimeType: b.mimeType,
          size: b.size,
          objectKey: b.objectKey || null,
          processedKey: b.processedKey || null
        })));
      let attachmentLabel = allAttachments.length ? `\n\n[${allAttachments.length} file${allAttachments.length === 1 ? "" : "s"} attached]` : "";
      if(!prompt && !selectedImageBase64 && !allAttachments.length) return;

      const owner = isTruxDeveloper(auth?.currentUser);
      const month = new Date().toISOString().slice(0, 7);
      const modeUsage = store.json("trux_mode_usage", { month, codingTokens: 0, deepResearchRuns: 0 });
      if(modeUsage.month !== month) { modeUsage.month = month; modeUsage.codingTokens = 0; modeUsage.deepResearchRuns = 0; store.setItem("trux_mode_usage", JSON.stringify(modeUsage)); }
      if(!owner && workspaceMode === "coding" && modeUsage.codingTokens >= 150000) return toast("TruX-Code monthly limit reached (150k tokens).", "err");
      if(!owner && workspaceMode === "deep-research" && modeUsage.deepResearchRuns >= 1) return toast("Deep Research is limited to one run per month.", "err");
      if(!owner && currentPlanTier === "pro" && workspaceMode !== "coding" && getProUsageData().tokensUsed >= 1000000) return toast("TruX Pro monthly limit reached.", "err");
      if(workspaceMode === "video") {
        if(!owner && !auth?.currentUser) return toast("Sign in to use Video generation.", "err");
        if(!owner && currentPlanTier !== "pro") return toast("Video generation is available to Pro accounts and Owner access.", "err");
        return generateVideo(basePrompt || prompt);
      }

      if(workspaceMode === "image" && !selectedImageBase64) return generateImage(basePrompt || "Create a high-quality image", {explicitMode:true});

      if(workspaceMode === "chat" && !selectedImageBase64 && !allAttachments.length && looksLikeImageGenerationRequest(prompt)) {
        return generateImage(basePrompt, { imagePrompt: basePrompt });
      }

      /* Request GPS only for prompts that need local/current-location context. */
      const needsTurnLocation = /\b(?:near me|nearby|around me|around here|in my area|my location|where am i|closest|nearest|local weather|weather near|restaurants?|cafes?|coffee|shops?|stores?|malls?|gas stations?|doctors?|hospitals?|pharmacies?|events?|things to do|what(?:'s| is) open|directions|sunrise|sunset)\b/i
        .test(String(prompt || ""));
      const locationPromise = needsTurnLocation
        ? getTruxLocationForTurn()
        : Promise.resolve(null);

      /* No keyword gate here any more. Every turn goes to the model, and the
         model answers with an "[[IMAGE]] <prompt>" line when it judges that a
         picture is what was asked for — see the image routing below. */
      
      enterChatWorkspace();
      closeModelDropdown();
      closeAttachmentMenu();
      generationStopRequested = false;
      const turnId = ++generationEpoch;
      // Every stream renderer belongs to one assistant bubble. Dispose of any
      // stale renderer before this turn starts, so old answers cannot be reused.
      if (activeStreamer) {
        try { activeStreamer.cancel(); } catch (_) {}
        activeStreamer = null;
      }
      let turnStreamer = null;
      const clearTurnStreamer = (cancel = false) => {
        const ownedStreamer = turnStreamer;
        if (cancel && ownedStreamer) {
          try { ownedStreamer.cancel(); } catch (_) {}
        }
        if (activeStreamer === ownedStreamer) activeStreamer = null;
        turnStreamer = null;
      };
      /* Dedicated TruX-Code transcript replaces its own landing surface for the active turn. */
      isGenerating = true; isScrolledUp = false;
      getEl("btnIcon").innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>'; getEl("actionBtn").classList.add("stop"); getEl("actionBtn").classList.remove("ready");
      handleInputChange();
      let voice = wasInputByVoice; wasInputByVoice = false;

      if(!currentChatId) { currentChatId = "chat_" + Date.now(); chatSessions[currentChatId] = { title: basePrompt ? basePrompt.slice(0, 32) : "Query", mode: workspaceMode, notebookId: notebookIdForNewChat(), messages: [] }; }
      const turnChatId = currentChatId;
      const turnMode = workspaceMode;
      chatSessions[turnChatId].mode = turnMode;
      chatSessions[turnChatId].messages.push({
        role: "user",
        text: prompt,
        attachments: allAttachments.map(a => ({
          name: a.name,
          size: a.size || null,
          mimeType: a.mimeType || "",
          kind: a.kind || "file",
          objectKey: a.objectKey || null,
          processedKey: a.processedKey || null
        }))
      });
      const sentMessageIndex = chatSessions[turnChatId].messages.length - 1;
      const turnContext = {
        turnId,
        turnKey: "turn_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10),
        chatId: turnChatId,
        userMessageIndex: sentMessageIndex,
        mode: turnMode,
        latestText: "",
        lastPersistAt: 0,
        toolEvents: []
      };
      activeTurnContext = turnContext;
      saveChatSessions();

      getEl("welcomeScreen").style.display = "none";
      let chatContainer = getActiveChatContainer(); chatContainer.style.display = "block";
      
      appendMessageRow("You", basePrompt + attachmentLabel + (selectedImageBase64 ? "\n[Image Attached]" : ""), "user-row", "user-bubble", null, true, undefined, undefined, { messageIndex: sentMessageIndex });
      promptInput.value = ""; let img = selectedImageBase64; removeImage(); pastedTextBlocks = []; fileAttachments = []; renderFileChips(); handleInputChange();

      const codingTurn = workspaceMode === "coding";
      let id = "b_" + Date.now(), aid = "a_" + Date.now(), sid = "s_" + Date.now(), row = document.createElement("div");
      row.className = "row trux-row appear";
      const tsid = "ts_" + Date.now();
      const thid = "th_" + Date.now();
      const thinkingMarkup = `
        <div class="trux-thinking-panel ${codingTurn ? "trux-code-thinking" : "trux-chat-thinking"}" id="${thid}" data-thinking-visible="true">
          <div class="trux-thinking-bar">
            <span class="trux-thinking-spark trux-thinking-chat-spark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M12 1.5C13.45 7.95 16.05 10.55 22.5 12C16.05 13.45 13.45 16.05 12 22.5C10.55 16.05 7.95 13.45 1.5 12C7.95 10.55 10.55 7.95 12 1.5Z"/></svg></span>
            <div class="trux-thinking-copy"><span class="status-msg" id="${sid}" role="status" aria-live="polite"><span class="thinking-status-line compact"></span><span class="thinking-status-line full"></span></span></div>

            <button type="button" class="trux-thinking-toggle" hidden onclick="toggleThinkingDetails('${thid}')" aria-expanded="false" aria-label="Expand AI activity" title="Expand AI activity"><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg></button>
          </div>
          <div class="trux-thinking-details" id="${tsid}" hidden></div>
        </div>`;
      row.innerHTML = `<div class="trux-response-stack">
        ${thinkingMarkup}
        ${codingTurn ? '<div class="trux-terminal-window" data-trux-terminal-window hidden></div>' : ''}
        <div class="bubble trux-bubble ${codingTurn ? "thinking" : ""}" id="${id}"></div>
        <div class="actions" id="${aid}"></div>
      </div>`;

      chatContainer.appendChild(row);
      chatContainer.scrollTop = chatContainer.scrollHeight;

      row._startedAt = codingTurn ? Date.now() : 0;

      // TruX-Code defaults to Gemini 3.1 Pro Preview; owner overrides are validated server-side.

      const requestBody = {
        message: prompt,
        tier: (workspaceMode === "deep-research" || workspaceMode === "coding") ? "ultra" : currentPlanTier,
        mode: workspaceMode,
        advancedThinking: advancedThinkingLevel === "extended" || workspaceMode === "deep-research",
        thinkingLevel: advancedThinkingLevel,
        incognito: !!incognitoMode,
        history: (() => {
          const prior = (chatSessions[turnChatId]?.messages || []).slice(0, sentMessageIndex);
          const deepMode = workspaceMode === "coding" || workspaceMode === "deep-research";
          const selected = [];
          const maxMessages = deepMode ? 24 : advancedThinkingLevel === "extended" ? 18 : advancedThinkingLevel === "medium" ? 14 : 12;
          const maxChars = deepMode ? 80000 : advancedThinkingLevel === "extended" ? 60000 : advancedThinkingLevel === "medium" ? 45000 : 36000;
          let usedChars = 0;
          for (let index = prior.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
            const message = prior[index];
            const raw = String(message?.text || "");
            if (!raw.trim()) continue;
            const remaining = maxChars - usedChars;
            if (remaining <= 0) break;
            if (raw.length > remaining) {
              const marker = "\n[… earlier context trimmed for speed …]\n";
              const contentBudget = remaining - marker.length;
              if (contentBudget >= 64) {
                const headLength = Math.min(320, Math.floor(contentBudget * 0.25));
                const tailLength = Math.max(0, contentBudget - headLength);
                selected.unshift({
                  role: message.role,
                  text: raw.slice(0, headLength) + marker + raw.slice(-tailLength)
                });
              }
              break;
            }
            selected.unshift({ role: message.role, text: raw });
            usedChars += raw.length;
          }
          return selected;
        })(),
        image: img,
        attachments: allAttachments,
        systemInstruction: getTruxSystemInstruction(),
        userId: auth?.currentUser?.uid || null,
        userEmail: auth?.currentUser?.email || "",
        location: needsTurnLocation
          ? await Promise.race([
              locationPromise,
              new Promise(resolve => setTimeout(() => resolve(null), 900))
            ])
          : null,
        ...(owner ? { ownerModel: store.getItem("trux_owner_gemini_model") || "auto" } : {}),
        notifyOnComplete: true
      };

      // Chat and TruX-Code share the same direct, cancellable Vertex stream.
      // Closing the client aborts this request; partial text is checkpointed locally.
      while (true) {
        if (turnId !== generationEpoch || generationStopRequested || !isGenerating) return;
        if (navigator.onLine === false) {
          await waitForInternet(sid);
          if (!isGenerating) return;
        }

        activeAbortController = new AbortController();
        const requestController = activeAbortController;
        try {
          const requestUser = auth?.currentUser;
          if (!requestUser) throw Error("Your session ended. Sign in again to continue.");
          const requestOptions = {
            method: "POST",
            cache: incognitoMode ? "no-store" : "default",
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            signal: requestController.signal,
            body: JSON.stringify(requestBody)
          };
          const res = await truxAuthenticatedFetch("/api/chat", requestOptions, requestUser);
        if(!res.ok) {
          let errorPayload = await res.json().catch(() => ({}));
          const detail = errorPayload.detail || errorPayload.reply || errorPayload.error;
          throw Error(detail || "Backend Error (" + res.status + ")");
        }

        if(!res.body) throw Error("Streaming body unavailable.");
        
        let rd = res.body.getReader(), dec = new TextDecoder(), buf = "", full = "", fin = null;
        let streamDone = false, finalizedEarly = false, finalizedOnFinal = false;
        // SSE heartbeats keep long-running tool work connected. There is no client-side
        // inactivity timeout; Cloud Run's configured request lifetime is the outer boundary.
        let responseStartVibrated = false;
        function vibrateWhenResponseStarts() {
          if (responseStartVibrated) return;
          responseStartVibrated = true;
          try {
            if (document.visibilityState === "visible" &&
                typeof navigator.vibrate === "function") {
              navigator.vibrate(24);
            }
          } catch (_) {
            /* Haptics are optional; a missing device/browser API must not affect streaming. */
          }
        }
        let githubProposal = null;
        let toolInProgress = false;
        /* Web pages the model actually consulted when it ran a Google search. */
        let turnSources = [];

        /* Image routing: the model answers with "[[IMAGE]] <prompt>" when it
           decides the turn wants a picture. Hold the first few characters back
           until we know which it is, so the tag never flashes on screen. */
        const IMG_TAGS = ["[[IMAGE]]", "[IMAGE]"];
        let imageRoute = false, routeSettled = false;
        function extractImageRoutePrompt(value, fallbackPrompt) {
          const textValue = String(value || "").trim();
          const marker = textValue.match(/^[\s\u0060>*_]*\[\[?\s*IMAGE\s*\]\]?\s*/i);
          if (!marker) return null;
          return textValue.slice(marker[0].length).replace(/\u0060/g, "").trim() || String(fallbackPrompt || "").trim();
        }
        function sniffRoute() {
          if (routeSettled) return;
          let head = full.replace(/^[\s\u0060>*_]+/, "");
          if (!head) return;
          const up = head.toUpperCase();
          if (IMG_TAGS.some(tag => up.startsWith(tag))) {
            imageRoute = true;
            routeSettled = true;
            let st = getEl(sid);
            if (st) st.innerText = "Composing your image…";
            return;
          }
          if (IMG_TAGS.some(tag => up.length < tag.length && tag.startsWith(up))) return;
          routeSettled = true;
        }

        // The renderer is created lazily on the very first token, so the
        // thinking indicator stays visible until real content exists.
        function ensureStreamer() {
          if (turnStreamer) return turnStreamer;
          if (finalizedEarly || finalizedOnFinal) return null;
          let bubble = getEl(id);
          if (!bubble) return null;
          const responseRow = bubble.closest(".row");
          if (!codingTurn) dismissThinkingPanel(responseRow);
          bubble.classList.remove("thinking");
          turnStreamer = createStreamRenderer(bubble);
          activeStreamer = turnStreamer;
          return turnStreamer;
        }

        function ev(raw) {
          if (turnId !== generationEpoch || generationStopRequested || requestController.signal.aborted) return;
          if(!raw) return; let j; try { j = JSON.parse(raw); } catch { return; }
          // Once a final payload has been accepted, late text frames must not
          // create a new draft or mutate a completed answer.
          if ((finalizedEarly || finalizedOnFinal) && (j.type === "chunk" || j.type === "final")) return;
          if(j.type === "progress") {
            return;
          }
          else if(j.type === "chunk") {
            let piece = j.text || "";
            if (!piece) return;
            full += piece;
            sniffRoute();
            if (!routeSettled || imageRoute) return;
            vibrateWhenResponseStarts();
            persistTurnDraft(turnContext, full);
            let s = ensureStreamer();
            if (s) {
              if (!s.received) s.setText(full);
              else s.push(piece);
            }
          }
          else if(j.type === "final") {
            fin = j.text || "";
            // Detect routing tags in the authoritative final payload before
            // the normal Chat finalizer can briefly render them as plain text.
            if (extractImageRoutePrompt(fin, prompt) !== null) {
              imageRoute = true;
              routeSettled = true;
              const status = getEl(sid);
              if (status) status.innerText = "Composing your image…";
            }
            if (fin && !imageRoute) {
              if (codingTurn && !finalizedEarly) {
                finalizedEarly = true;
                finalizeResponse(id, aid, fin, prompt, voice, turnStreamer, turnSources, turnContext);
                if (activeStreamer === turnStreamer) activeStreamer = null;
                try { rd.cancel(); } catch {}
              } else if (!codingTurn && !finalizedOnFinal) {
                if (!turnStreamer && !codingTurn) dismissThinkingPanel(getEl(id)?.closest(".row"));
                finalizeResponse(id, aid, fin, prompt, voice, turnStreamer, turnSources, turnContext);
                /* Only mark complete after finalization succeeds. If it throws,
                   the catch path must still reset the Stop control and live renderer. */
                finalizedOnFinal = true;
                if (activeStreamer === turnStreamer) activeStreamer = null;
              }
            }
          }
          else if(j.type === "status") {
            setThinkingStatus(sid, j.status || "");
            if (codingTurn && turnContext) {
              const activityStatus = normalizeAiActivity(j.status || "");
              const placeholder = /^(?:thinking|working|processing)(?:[ .…]*)?$/i.test(activityStatus);
              if (activityStatus && !placeholder) {
                appendThinkingHistory(getEl(thid), activityStatus);
                const events = turnContext.toolEvents || (turnContext.toolEvents = []);
                if (!events.some(event => event.type === "status" && event.status === activityStatus)) {
                  events.push({ type: "status", status: activityStatus });
                }
              }
            }
          }
          else if(j.type === "ai_step") {
            if (codingTurn && turnContext) {
              const activityStatus = normalizeAiActivity(j.status || j.text || "");
              if (activityStatus) {
                setThinkingStatus(sid, activityStatus);
                appendThinkingHistory(getEl(thid), activityStatus);
                const events = turnContext.toolEvents || (turnContext.toolEvents = []);
                if (!events.some(event => event.type === "ai_step" && event.status === activityStatus)) {
                  events.push({ type: "ai_step", status: activityStatus });
                }
              }
            }
          }
          else if(j.type === "browser_preview") {
            const responseRow = getEl(id)?.closest(".row");
            renderBrowserPreview(responseRow, j);
          }
          else if(j.type === "terminal") {
            const responseRow = getEl(id)?.closest(".row");
            renderTerminalEvent(responseRow, j);
          }
          else if(j.type === "done") {
            streamDone = true;
            /* A clean EOF is authoritative even if the server omitted a final frame.
               Finalize once here so the caret and Stop control cannot be left active. */
            if (!finalizedEarly && !finalizedOnFinal && !imageRoute) {
              const completedText = String(fin !== null ? fin : full).trim();
              if (completedText) {
                finalizeResponse(id, aid, completedText, prompt, voice, turnStreamer, turnSources, turnContext);
                finalizedOnFinal = true;
                if (activeStreamer === turnStreamer) activeStreamer = null;
              }
            }
          }
          else if(j.type === "tool_status") {
            const phase = j.phase || "complete";
            if (codingTurn) setThinkingStatus(sid, j.status || j.tool || "");
            appendToolStatusLine(tsid, j.tool, j.status, phase, j.details || null);
            if (codingTurn && turnContext) {
              const safeDetails = {};
              if (j.details?.id) safeDetails.id = String(j.details.id).slice(0, 120);
              if (j.details?.target) safeDetails.target = String(j.details.target).slice(0, 180);
              if (typeof j.details?.ok === "boolean") safeDetails.ok = j.details.ok;
              const events = turnContext.toolEvents || (turnContext.toolEvents = []);
              events.push({
                type: "tool_status",
                tool: String(j.tool || "TruX-Code").slice(0, 120),
                status: String(j.status || "").slice(0, 240),
                phase: String(phase).slice(0, 24),
                ...(Object.keys(safeDetails).length ? { details: safeDetails } : {})
              });
            }
            if(phase === "start") {
              toolInProgress = true;
            } else {
              toolInProgress = false;
            }
          }
          else if(j.type === "plugin_auth_required") {
            setThinkingStatus(sid, j.message || ((j.pluginName || "Plugin") + " authorization is required."));
            const actions = getEl(aid);
            if (actions && j.redirectUrl) {
              const existing = actions.querySelector("[data-plugin-reauth]");
              if (!existing) {
                const btn = document.createElement("button");
                btn.className = "act";
                btn.type = "button";
                btn.setAttribute("data-plugin-reauth", "1");
                btn.textContent = "Reconnect " + (j.pluginName || "plugin");
                btn.onclick = function() { window.location.assign(j.redirectUrl); };
                actions.appendChild(btn);
              }
            }
          }
          else if(j.type === "plugin_config_error") {
            setThinkingStatus(sid, j.message || "Plugin execution is not configured correctly.");
          }
          else if(j.type === "plugin_action_unavailable") {
            setThinkingStatus(sid, j.message || "The requested integration action is unavailable.");
          }
          else if(j.type === "heartbeat") {
            /* Keepalive only. The last real AI activity remains visible. */
          }
          else if(j.type === "github_commit") {
            const commit = j.commit;
            const proposal = j.proposal || {};
            proposal.commit = commit;
            githubProposal = proposal;
            appendGithubCommitResponse(proposal, commit, currentChatId);
          }
          else if(j.type === "github_proposal") {
            githubProposal = j.proposal || null;
            const proposalSession = chatSessions[currentChatId];
            if (proposalSession && githubProposal) {
              proposalSession.pendingGithubProposal = githubProposal;
              saveChatSessions();
            }
            if (githubProposal?.commit) {
              appendGithubCommitResponse(githubProposal, githubProposal.commit, currentChatId);
            } else {
              let st = getEl(sid);
              if (st) st.innerText = "GitHub changes ready for review…";
              const bubble = getEl(id);
              const host = bubble?.closest(".trux-response-stack") || bubble;
              if (host && githubProposal) renderGithubProposalCard(host, githubProposal);
            }
          }
          else if(j.type === "grounding") {
            const incomingSources = (j.grounding && Array.isArray(j.grounding.sources)) ? j.grounding.sources : [];
            const mergedSources = [...turnSources, ...incomingSources];
            const uniqueSources = new Map();
            for (const source of mergedSources) {
              if (source?.uri && !uniqueSources.has(source.uri)) uniqueSources.set(source.uri, source);
            }
            turnSources = Array.from(uniqueSources.values()).slice(0, 12);
            const responseRow = getEl(id)?.closest(".row");
            if (responseRow && responseRow.querySelector(".bubble:not(.user-bubble)")) {
              attachSources(responseRow, turnSources);
            }
          }
          else if(j.type === "usage" && j.kind === "pro") {
            let u = getProUsageData();
            u.tokensUsed = Math.min(1000000, Number(j.tokensUsed) || u.tokensUsed);
            store.setItem("trux_pro_usage", JSON.stringify(u));
            updateAllUsageUI();
          }
          else if(j.type === "error") throw Error(j.error || "Streaming error.");
        }

        while(1) {
          if (turnId !== generationEpoch || generationStopRequested) {
            try { await rd.cancel(); } catch {}
            return;
          }
          if (requestController.signal.aborted) {
            try { await rd.cancel(); } catch {}
            return;
          }
          let { value, done } = await rd.read();
          if (turnId !== generationEpoch || generationStopRequested) {
            try { await rd.cancel(); } catch {}
            return;
          }
          if (requestController.signal.aborted) {
            try { await rd.cancel(); } catch {}
            return;
          }
          if(done) break;
          buf += dec.decode(value, { stream: true });
          let es = buf.split(/\r?\n\r?\n/); buf = es.pop() || "";
          for(let x of es) {
            let ls = x.split(/\r?\n/).filter(l => l.startsWith("data:"));
            if(ls.length) ev(ls.map(l => l.slice(5).trimStart()).join("\n"));
            if (finalizedEarly || streamDone) break;
          }
          if (finalizedEarly || streamDone) {
            try { await rd.cancel(); } catch {}
            break;
          }
        }
        buf += dec.decode();
        if (buf.trim()) {
          const trailingFrames = buf.split(/\r?\n\r?\n/);
          for (const frame of trailingFrames) {
            const ls = frame.split(/\r?\n/).filter(l => l.startsWith("data:"));
            if (ls.length) ev(ls.map(l => l.slice(5).trimStart()).join("\n"));
          }
        }
        if (finalizedEarly) {
          return;
        }

        let text = (fin !== null ? fin : full).trim();
         if(!text) throw Error("The model completed the request without returning a final response.");
        sniffRoute();
        const routedImagePrompt = extractImageRoutePrompt(text, prompt);
        if (routedImagePrompt !== null) imageRoute = true;

        /* The model asked for a picture — hand this turn to the image model,
           reusing the row that is already on screen. */
        if(imageRoute && !img) {
          let imagePrompt = routedImagePrompt || extractImageRoutePrompt(full, prompt) || prompt;
          clearTurnStreamer(true);
          activeAbortController = null;
          if(!isTruxDeveloper(auth?.currentUser) && getImageUsageData().count >= 15) {
            isGenerating = false;
            getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>';
            getEl("actionBtn").classList.remove("stop"); handleInputChange();
            row.remove();
            return toast("Image generation monthly limit reached.", "err");
          }
          return generateImage(basePrompt, { row: row, reuseTurn: true, imagePrompt: imagePrompt });
        }
        /* Defensive: never show the routing tag if it slipped into prose. */
        text = text.replace(/^[\s\u0060>*_]*\[\[?\s*IMAGE\s*\]\]?\s*/i, "").replace(/\[\[IMAGE\]\]/gi, "").replace(/^\[image\]\s*/i, "").trim();

        if (!finalizedOnFinal && !finalizedEarly) {
          let streamer = turnStreamer || ensureStreamer();
          finalizeResponse(id, aid, text, prompt, voice, streamer, turnSources, turnContext);
        }
        if(githubProposal) {
          const session = chatSessions[currentChatId];
          const lastMessage = session?.messages?.[session.messages.length - 1];
          if (lastMessage?.role === "trux") {
            lastMessage.githubProposal = githubProposal;
            delete session.pendingGithubProposal;
            saveChatSessions();
          }
          const bubble = getEl(id);
          const host = bubble?.closest(".trux-response-stack") || bubble;
          if(host) renderGithubProposalCard(host, githubProposal);
        }
        clearTurnStreamer(false);
        return;
        } catch(e) {
          if (turnId !== generationEpoch) return;
          if (row._backgroundHandover) return;
          // The authoritative answer has already been rendered; a late stream
          // close/error must not overwrite it or create a duplicate partial draft.
          if (finalizedOnFinal || finalizedEarly) {
            clearTurnStreamer(false);
            activeAbortController = null;
            return;
          }
          persistTurnDraft(turnContext, full, true);
          if (isNetworkFailure(e) && isGenerating) {
            // Do not silently issue a second full Vertex request after a broken
            // stream; preserve the partial text and let the user explicitly resend.
            clearTurnStreamer(true);

            const b = getEl(id);
            if (b) {
              b.classList.remove("thinking");
              if (full.trim()) {
                b.innerHTML = renderFormattedText(full, false);
                renderTruxDiagrams(b);
                scheduleTruxMath(b);
              } else {
                b.innerHTML = "Error: " + escapeHtml(e.message || "The connection was lost.");
              }
            }

            const session = chatSessions[turnContext.chatId];
            const draft = session?.messages?.find(message => message?.draftTurnId === turnContext.turnKey);
            if (draft) {
              delete draft.draftTurnId;
              draft.incomplete = true;
              store.removeItem("trux_turn_draft_" + turnContext.chatId);
              saveChatSessions();
            }
            isGenerating = false;
            activeAbortController = null;
            if (activeTurnContext === turnContext) activeTurnContext = null;
            getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>';
            getEl("actionBtn").classList.remove("stop");
            handleInputChange();
            return;
          }

          const failedRow = getEl(id)?.closest(".row");
          settleThinkingDetails(tsid);
          clearTurnStreamer(true);
          let b = getEl(id);
          if(b) {
            b.classList.remove("thinking");
            let partial = e.name === "AbortError" && b.innerText.trim() ? b.innerHTML : "";
            b.innerHTML = partial
              ? partial + '<div class="stream-stopped">Generation stopped.</div>'
              : (e.name === "AbortError" ? "Generation stopped." : "Error: " + escapeHtml(e.message));
          }
          isGenerating = false; activeAbortController = null; getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>'; getEl("actionBtn").classList.remove("stop"); handleInputChange();
          return;
        }
      }
    }
    async function generateVideo(basePrompt) {
      const turnId = ++generationEpoch;
      const owner=isTruxDeveloper(auth?.currentUser);
      if(!owner && !auth?.currentUser) return toast("Sign in to use Video generation.","err");
      if(!owner && currentPlanTier!=="pro") return toast("Video generation is available to Pro accounts and Owner access.","err");

      enterChatWorkspace();
      document.body.removeAttribute("data-media-mode");
      isGenerating=true; isScrolledUp=false;
      getEl("btnIcon").innerHTML='<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>';
      getEl("actionBtn").classList.add("stop"); getEl("actionBtn").classList.remove("ready");
      handleInputChange();
      if(!currentChatId) {
        currentChatId="chat_"+Date.now();
        chatSessions[currentChatId]={title:(basePrompt||"Video").slice(0,32),mode:"video",notebookId:notebookIdForNewChat(),messages:[]};
      }
      chatSessions[currentChatId].mode="video";
      chatSessions[currentChatId].messages.push({role:"user",text:basePrompt});
      saveChatSessions();
      getEl("welcomeScreen").style.display="none";
      const chatContainer=getActiveChatContainer(); chatContainer.style.display="block";
      appendMessageRow("You",basePrompt,"user-row","user-bubble",null,true);

      const row=document.createElement("div"); row.className="row trux-row appear";
      const id="v_"+Date.now(), aid="a_"+Date.now(), sid="s_"+Date.now();
      row.innerHTML='<div class="label">'+BRAND_LABEL+'</div><div class="bubble trux-bubble" id="'+id+'"><div class="gen-video-card"><div class="gen-image-label" id="'+sid+'">Generating video…</div><span class="video-shimmer"></span></div></div><div class="actions" id="'+aid+'"></div>';
      chatContainer.appendChild(row); chatContainer.scrollTop=chatContainer.scrollHeight; row._startedAt=Date.now();
      activeAbortController=new AbortController();
      const timer=setInterval(()=>{ const el=getEl(sid); if(el) el.textContent="Generating video · "+formatCodexElapsed(Date.now()-row._startedAt); },1000);

      try {
        const videoUser = auth?.currentUser;
        const res=await truxAuthenticatedFetch("/api/chat",{
          method:"POST",
          headers:{"Content-Type":"application/json","Accept":"text/event-stream"},
          signal:activeAbortController.signal,
          body:JSON.stringify({message:basePrompt,tier:currentPlanTier,mode:"video",userId:videoUser?.uid||null,userEmail:videoUser?.email||"",notifyOnComplete:true})
        }, videoUser);
        if(!res.ok){ const p=await res.json().catch(()=>({})); throw Error(p.error||p.reply||"Video generation failed."); }
        if(!res.body) throw Error("Video streaming body unavailable.");
        const reader=res.body.getReader(), decoder=new TextDecoder();
        let buffer="", result=null;
        const parseFrame=raw=>{ if(!raw) return; let j; try{j=JSON.parse(raw);}catch{return;} if(j.type==="status"){const el=getEl(sid); if(el&&j.status) el.textContent=j.status;} else if(j.type==="result"){result=j;} else if(j.type==="error"){throw Error(j.error||"Video generation failed.");} };
        while(true){
          const part=await reader.read(); if(part.done) break;
          buffer+=decoder.decode(part.value,{stream:true});
          const frames=buffer.split(/\r?\n\r?\n/); buffer=frames.pop()||"";
          for(const frame of frames){ const lines=frame.split(/\r?\n/).filter(x=>x.startsWith("data:")); if(lines.length) parseFrame(lines.map(x=>x.slice(5).trimStart()).join("\n")); }
        }
        buffer+=decoder.decode();
        if(buffer.trim()){ const lines=buffer.split(/\r?\n/).filter(x=>x.startsWith("data:")); if(lines.length) parseFrame(lines.map(x=>x.slice(5).trimStart()).join("\n")); }
        if(!result?.video?.url) throw Error("Video generation returned no playable video.");

        const bubble=getEl(id);
        bubble.innerHTML=renderFormattedText(result.reply||"Your video is ready.",false); renderTruxDiagrams(bubble); scheduleTruxMath(bubble);
        const wrap=document.createElement("div"); wrap.className="gen-video-wrap";
        const video=document.createElement("video"); video.src=result.video.url; video.controls=true; video.preload="metadata"; video.playsInline=true; wrap.appendChild(video); bubble.appendChild(wrap);
        const reply=result.reply||"Your video is ready.";
        chatSessions[currentChatId].messages.push({role:"trux",text:reply,video:result.video.url});
        saveChatSessions();
        await saveGeneratedMedia({type:"video",url:result.video.url,prompt:basePrompt,mimeType:result.video.mimeType||"video/mp4"});
        const actions=getEl(aid); if(actions){ const openBtn=document.createElement("button"); openBtn.className="act"; openBtn.textContent="Open"; openBtn.onclick=()=>window.open(result.video.url,"_blank","noopener"); actions.appendChild(openBtn); }
      } catch(e) {
        if (turnId !== generationEpoch) return;
        const bubble=getEl(id); if(bubble) bubble.innerHTML=e.name==="AbortError"?"Generation stopped.":"Error: "+escapeHtml(e.message);
      } finally {
        clearInterval(timer);
        if (turnId !== generationEpoch) return;
        isGenerating=false; activeAbortController=null;
        getEl("btnIcon").innerHTML='<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15-2z"/>';
        getEl("actionBtn").classList.remove("stop"); handleInputChange();
      }
    }

    let mediaDbPromise = null;
    function openTruxMediaDB() {
      if(mediaDbPromise) return mediaDbPromise;
      mediaDbPromise = new Promise((resolve,reject) => {
        if(!window.indexedDB) return reject(new Error("IndexedDB is unavailable."));
        const request = indexedDB.open("trux_media_library",1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if(!db.objectStoreNames.contains("media")) db.createObjectStore("media",{keyPath:"id"});
        };
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error || new Error("Media library unavailable."));
      });
      return mediaDbPromise;
    }
    async function saveGeneratedMedia(item) {
      try {
        const db=await openTruxMediaDB();
        await new Promise((resolve,reject)=>{
          const tx=db.transaction("media","readwrite");
          tx.objectStore("media").put({
            id:item.id || ("media_"+Date.now()+"_"+Math.random().toString(36).slice(2,8)),
            type:item.type, dataUrl:item.dataUrl || null, url:item.url || null,
            prompt:String(item.prompt || "").slice(0,1200), mimeType:item.mimeType || "", createdAt:item.createdAt || Date.now()
          });
          tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error || new Error("Library write failed."));
        });
      } catch(e) {}
    }
    async function listGeneratedMedia(filter) {
      try {
        const db=await openTruxMediaDB();
        return await new Promise((resolve,reject)=>{
          const tx=db.transaction("media","readonly");
          const req=tx.objectStore("media").getAll();
          req.onsuccess=()=>{
            let rows=Array.isArray(req.result)?req.result:[];
            rows.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
            if(filter && filter!=="all") rows=rows.filter(x=>x.type===filter);
            resolve(rows);
          };
          req.onerror=()=>reject(req.error || new Error("Library read failed."));
        });
      } catch(e) { return []; }
    }
    async function deleteGeneratedMedia(id) {
      try {
        const db=await openTruxMediaDB();
        await new Promise((resolve,reject)=>{
          const tx=db.transaction("media","readwrite");
          tx.objectStore("media").delete(id); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
        });
        renderMediaLibrary(currentMediaFilter);
      } catch(e) {}
    }

    async function downloadGeneratedMedia(item){
      const url=item && (item.url || item.dataUrl);
      if(!url) return toast("Media is not available for download.","err");
      try{
        const response=await fetch(url,{credentials:"same-origin"});
        if(!response.ok) throw Error("Media request failed.");
        const blob=await response.blob(), objectUrl=URL.createObjectURL(blob), a=document.createElement("a");
        a.href=objectUrl; a.download=(item.type==="video"?"trux-video-":"trux-image-")+Date.now()+(item.type==="video"?".mp4":".png");
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(objectUrl);},1200);
      }catch(e){
        const a=document.createElement("a"); a.href=url; a.target="_blank"; a.rel="noopener"; a.click();
      }
    }
    let currentMediaFilter="all";
    async function openMediaLibrary(filter) {
      currentMediaFilter=filter || "all";
      const modal=getEl("mediaLibraryModal"), grid=getEl("mediaLibraryGrid");
      if(!modal || !grid) return;
      setSidebarOpen(false);
      modal.classList.add("open");
      document.querySelectorAll("[data-media-filter]").forEach(x=>x.classList.toggle("active",x.dataset.mediaFilter===currentMediaFilter));
      await renderMediaLibrary(currentMediaFilter);
    }
    async function renderMediaLibrary(filter) {
      const grid=getEl("mediaLibraryGrid"); if(!grid) return;
      grid.innerHTML="<div class=\"media-empty\">Loading library…</div>";
      const rows=await listGeneratedMedia(filter);
      if(!rows.length) { grid.innerHTML="<div class=\"media-empty\">No generated media yet.<br>Create an image or video and it will appear here.</div>"; return; }
      grid.innerHTML="";
      rows.forEach((m,index)=>{
        const card=document.createElement("article"); card.className="media-card"; card.style.animationDelay=Math.min(index*25,300)+"ms";
        const mediaHost=document.createElement("div");
        if(m.type==="image" && m.dataUrl) { const img=document.createElement("img"); img.className="media-card-media"; img.src=m.dataUrl; img.alt=m.prompt || "Generated image"; mediaHost.appendChild(img); }
        else if(m.type==="video" && m.url) { const v=document.createElement("video"); v.className="media-card-media"; v.src=m.url; v.controls=true; v.preload="metadata"; v.playsInline=true; mediaHost.appendChild(v); }
        card.appendChild(mediaHost);
        const body=document.createElement("div"); body.className="media-card-body";
        const kind=document.createElement("div"); kind.className="media-card-kind"; kind.textContent=m.type==="video"?"VIDEO":"IMAGE";
        const p=document.createElement("div"); p.className="media-card-prompt"; p.textContent=m.prompt || "Generated media";
        const actions=document.createElement("div"); actions.className="media-card-actions";
        const openBtn=document.createElement("button"); openBtn.textContent="Open"; openBtn.onclick=()=>{ const u=m.url || m.dataUrl; if(u) window.open(u,"_blank","noopener"); };
        const downloadBtn=document.createElement("button"); downloadBtn.textContent="Download"; downloadBtn.onclick=()=>downloadGeneratedMedia(m);
        const delBtn=document.createElement("button"); delBtn.textContent="Delete"; delBtn.onclick=()=>deleteGeneratedMedia(m.id);
        actions.append(openBtn,downloadBtn,delBtn); body.append(kind,p,actions); card.appendChild(body); grid.appendChild(card);
      });
    }
    function closeMediaLibrary(){ getEl("mediaLibraryModal")?.classList.remove("open"); }

    function markGenerationStopped(row, id, sid, tsid) {
      settleThinkingDetails(tsid);
      dismissThinkingPanel(row);

      const bubble = getEl(id);
      const responseText = bubble
        ? String(bubble.innerText || "")
            .replace(/Generation stopped\.?$/i, "")
            .trim()
        : "";

      if(bubble){
        const wasThinking = bubble.classList.contains("thinking");

        if(wasThinking){
          bubble.classList.remove("thinking");
          bubble.innerHTML = '<span class="generation-stopped">Generation stopped.</span>';
        }else{
          const stopLine = document.createElement("div");
          stopLine.className = "generation-stopped";
          stopLine.textContent = "Generation stopped.";
          bubble.appendChild(stopLine);
        }
      }

      const actions = row?.querySelector?.(".actions");
      actions?.replaceChildren();
      markPromptMessageStopped(row);
    }

    function handleActionButton() {
      if (sendPromptInFlight && !isGenerating) return;
      if (isGenerating) {
        const context = activeTurnContext;
        if (context) persistTurnDraft(context, context.latestText || "", true);
        generationStopRequested = true;
        generationEpoch += 1;
        activeTurnContext = null;

        const assistantRows = Array.from(getActiveChatContainer()?.querySelectorAll(".row.trux-row") || []);
        const activeRow = assistantRows[assistantRows.length - 1] || null;
        const bubble = activeRow?.querySelector(".bubble");
        const sid = activeRow?.querySelector(".status-msg")?.id || "";
        const tsid = activeRow?.querySelector(".trux-thinking-details")?.id || "";

        try { activeAbortController?.abort(); } catch {}
        if (activeStreamer) {
          try { activeStreamer.cancel(); } catch {}
          activeStreamer = null;
        }

        markGenerationStopped(activeRow, bubble?.id || "", sid, tsid);
        isGenerating = false;
        activeAbortController = null;
        getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>';
        getEl("actionBtn").classList.remove("stop");
        handleInputChange();
        return;
      }
      const promptInput = getEl("promptInput");
      const hasContent = !!(promptInput?.value.trim() || selectedImageBase64 || pastedTextBlocks.length || fileAttachments.length);
      if (!hasContent) {
        // The visible workspace is authoritative; a stale JS mode must never launch Live.
        const codeWorkspaceVisible = workspaceMode === "coding" ||
          document.body.classList.contains("coding-workspace") ||
          document.body.dataset.workspaceMode === "coding";
        if (codeWorkspaceVisible) return;
        startTruxLiveAssistant();
        return;
      }
      sendPrompt();
    }

    function openTruXNativeIntent(route, extraKey, extraValue) {
      const fallbackUrl = new URL(location.href);
      fallbackUrl.searchParams.set("truxNativeMissing", "1");
      const extra = extraKey ? ";S." + extraKey + "=" + encodeURIComponent(String(extraValue || "")) : "";
      const intentUrl = "intent://" + route +
        "#Intent;scheme=truxnative;package=website.trux.omni" +
        extra +
        ";S.browser_fallback_url=" + encodeURIComponent(fallbackUrl.toString()) +
        ";end";
      location.href = intentUrl;
    }

    function startTruxLiveAssistant() {
      const nativeAssistant = window.TruXNativeAssistant;
      if (nativeAssistant && typeof nativeAssistant.startLiveSession === "function") {
        try {
          if (typeof nativeAssistant.isLiveSessionActive === "function" && nativeAssistant.isLiveSessionActive()) {
            nativeAssistant.stopLiveSession();
            return;
          }
          if (!auth?.currentUser) {
            openLoginWall();
            return;
          }
          auth.currentUser.getIdToken().then(token => {
            if (!window.TruXNativeAssistant || !token) throw new Error("Authentication token unavailable");
            window.TruXNativeAssistant.startLiveSession(token);
          }).catch(() => toast("Could not authenticate or start Live. Please sign in again.", "err"));
          return;
        } catch (_) {
          toast("Could not start the Live assistant.", "err");
          return;
        }
      }

      if (/Android/i.test(navigator.userAgent)) {
        if (!auth?.currentUser) {
          openLoginWall();
          return;
        }
        auth.currentUser.getIdToken().then(token => {
          if (!token) throw new Error("Authentication token unavailable");
          // This explicit-package Android intent only delivers the token to the
          // installed TruX companion. Chrome falls back to this page if absent.
          openTruXNativeIntent("live", "trux_firebase_token", token);
        }).catch(() => toast("Could not authenticate or start Live. Please sign in again.", "err"));
        return;
      }
      toast("Whole-screen Live needs the native TruX Android companion. A browser tab alone cannot share your other apps while minimized.", "err");
    }

    function requestTruXAndroidAssistant() {
      closeChatContextMenu();
      const bridge = window.TruXNativeAssistant;
      if (bridge && typeof bridge.requestAssistantRole === "function") {
        try { bridge.requestAssistantRole(); }
        catch (_) { toast("Android assistant setup could not be opened.", "err"); }
        return;
      }
      if (/Android/i.test(navigator.userAgent)) {
        openTruXNativeIntent("assistant", "", "");
        return;
      }
      toast("Install the native TruX Android companion to enable Android assistant integration.", "err");
    }

    window.__truxLiveState = "idle";
    window.onTruxLiveState = function (state) {
      const nextState = typeof state === "string" ? state : String(state?.state || "idle");
      window.__truxLiveState = nextState;
      handleInputChange();
      if (nextState === "live") toast("TruX Live is active. Screen and microphone sharing are on.", "ok");
      else if (nextState === "stopped") toast("TruX Live stopped.", "");
      else if (nextState === "error") toast("TruX Live could not connect. Check your network and sign-in.", "err");
    };

    addEventListener("pagehide", () => {
      if (activeTurnContext) {
        persistTurnDraft(activeTurnContext, activeTurnContext.latestText || "", true);
      }
      flushSmallChatChangesOnPageHide();
      // Closing or navigating away aborts the one live request. No detached
      // worker remains generating after the UI is gone.
      if (isGenerating) {
        generationEpoch += 1;
        generationStopRequested = true;
        activeTurnContext = null;
        try { activeAbortController?.abort(); } catch {}
        try { activeStreamer?.cancel(); } catch {}
        activeAbortController = null;
        activeStreamer = null;
        isGenerating = false;
      }
    });
    addEventListener("pageshow", () => {
      generationStopRequested = false;
      // Keep Stop-class and icon reconciliation in one routine; removing
      // the class first would hide the stale-icon signal from that routine.
      handleInputChange();
    });

    async function sendPrompt() {
      if(sendPromptInFlight) return;
      sendPromptInFlight=true;
      // sendPromptImpl runs synchronously until its first await, so this
      // captures the generation that this serialized send owns.
      const sendPromise = sendPromptImpl();
      const ownedEpoch = generationEpoch;
      const ownedTurnContext = activeTurnContext;
      try {
        return await sendPromise;
      } finally {
        sendPromptInFlight=false;
        // This wrapper is the terminal boundary for the request started by
        // this send, including Chat, TruX-Code, image routing, and video.
        // Some branches can return after the stream has ended without passing
        // through finalizeResponse. Only repair state when this send still
        // owns the epoch, or when it was already invalidated/stopped. Never
        // clear a newer generation that has taken ownership.
        if (generationEpoch === ownedEpoch || !isGenerating) {
          isGenerating=false;
          activeAbortController=null;
          if (activeTurnContext === ownedTurnContext) activeTurnContext=null;
          // handleInputChange must see the stale Stop class so it can
          // also force the icon back into the current idle/send mode.
          handleInputChange();
        }
      }
    }

    /* Chat ids are "chat_<epoch ms>", so the timestamp is free - use it to
       group history the way every serious assistant UI does. */
    function chatBucket(id) {
      let ms = Number(String(id).replace("chat_", ""));
      if(!ms || Number.isNaN(ms)) return { rank: 3, label: "Earlier" };
      let start = new Date(); start.setHours(0, 0, 0, 0);
      let day = 864e5, diff = start.getTime() - ms;
      if(diff <= 0) return { rank: 0, label: "Today" };
      if(diff <= day) return { rank: 1, label: "Yesterday" };
      if(diff <= day * 7) return { rank: 2, label: "Previous 7 days" };
      return { rank: 3, label: "Earlier" };
    }

    function plainPreview(t) {
      return String(t || "")
        .replace(/```[\s\S]*?```/g, " code block ")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\|.*\|\s*$/gm, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s*(-{3,}|\*{3,})\s*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    const TRUX_NOTEBOOKS_KEY = "trux_notebooks";

    function getNotebooks() {
      const fallback = [{ id:"notebook_trux", title:"TruX-AI" }];
      const value = store.json(TRUX_NOTEBOOKS_KEY, null);
      return Array.isArray(value) ? value : fallback;
    }

    function getActiveNotebookId() {
      const active = store.getItem("trux_active_notebook");
      return getNotebooks().some(n => n && n.id === active) ? active : null;
    }

    function notebookIdForNewChat() {
      const notebooks = getNotebooks();
      const active = getActiveNotebookId();
      return active || (notebooks[0] && notebooks[0].id) || null;
    }

    function ensureNotebookAssignments() {
      const notebooks = getNotebooks();
      if(!notebooks.length) return false;
      const fallbackId = notebooks[0].id;
      let changed = false;
      Object.keys(chatSessions).forEach(id => {
        const chat = chatSessions[id];
        if(!chat || chat.incognito || chat.notebookUnassigned) return;
        if(!chat.notebookId || !notebooks.some(n => n && n.id === chat.notebookId)) {
          chat.notebookId = fallbackId;
          changed = true;
        }
      });
      if(changed) saveChatSessions();
      return changed;
    }

    function renderNotebooks() {
      const host = getEl("notebookList");
      if(!host) return;
      host.innerHTML = "";
      const activeId = getActiveNotebookId();
      getNotebooks().forEach(n => {
        const item = document.createElement("div");
        item.className = "notebook-item" + (n.id === activeId ? " active" : "");
        item.setAttribute("role","button");
        item.tabIndex = 0;
        item.setAttribute("aria-label","Open notebook " + n.title);
        item.setAttribute("aria-current", n.id === activeId ? "page" : "false");
        item.onclick = () => openNotebook(n.id);
        item.onkeydown = e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); openNotebook(n.id); } };

        const icon = document.createElement("span");
        icon.className = "notebook-icon";
        icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h8.5L18.5 9v10A1.5 1.5 0 0 1 17 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M13 4.5V9h5"/></svg>';

        const label = document.createElement("b");
        label.textContent = n.title;
        label.title = n.title;

        const del = document.createElement("button");
        del.type = "button";
        del.className = "notebook-delete";
        del.setAttribute("aria-label","Delete " + n.title);
        del.title = "Delete notebook";
        del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v5M14 11v5"/></svg>';
        del.onclick = e => { e.preventDefault(); e.stopPropagation(); deleteNotebook(n.id); };

        item.append(icon, label, del);
        host.appendChild(item);
      });
      if(!host.children.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No notebooks yet. Create one to organize chats.";
        host.appendChild(empty);
      }
    }

    function createNotebook() {
      const title = prompt("Notebook name");
      const clean = String(title || "").trim().slice(0,60);
      if(!clean) return;
      const notebooks = getNotebooks();
      notebooks.push({ id:"notebook_" + Date.now(), title:clean });
      store.setItem(TRUX_NOTEBOOKS_KEY, JSON.stringify(notebooks));
      ensureNotebookAssignments();
      renderSidebar();
      toast("Notebook created.", "ok");
    }

    function deleteNotebook(id) {
      const notebook = getNotebooks().find(n => n && n.id === id);
      if(!notebook) return;
      if(!confirm("Delete " + JSON.stringify(notebook.title) + "? Chats will be kept and moved to another notebook when possible.")) return;

      const wasActive = store.getItem("trux_active_notebook") === id;
      const notebooks = getNotebooks().filter(n => n && n.id !== id);
      const replacementId = notebooks[0] ? notebooks[0].id : null;
      Object.keys(chatSessions).forEach(chatId => {
        const chat = chatSessions[chatId];
        if(!chat || chat.incognito || chat.notebookId !== id) return;
        if(replacementId) { chat.notebookId = replacementId; chat.notebookUnassigned = false; }
        else { delete chat.notebookId; chat.notebookUnassigned = true; }
      });
      store.setItem(TRUX_NOTEBOOKS_KEY, JSON.stringify(notebooks));
      if(wasActive && replacementId) store.setItem("trux_active_notebook", replacementId);
      else if(wasActive) store.removeItem("trux_active_notebook");

      saveChatSessions();
      renderSidebar();
      if(wasActive) {
        if(replacementId) openNotebook(replacementId);
        else {
          document.body.classList.remove("notebook-open");
          startNewChat();
        }
      } else if(document.body.classList.contains("notebook-open")) {
        renderNotebookWorkspace(getActiveNotebookId());
      }
      toast("Notebook deleted. Chats were kept.", "ok");
    }

    function renderNotebookWorkspace(id) {
      const host = getEl("notebookWorkspace");
      if(!host) return;
      ensureNotebookAssignments();
      const notebook = getNotebooks().find(n => n && n.id === id);
      if(!notebook) {
        host.innerHTML = '<div class="notebook-workspace-inner"><div class="notebook-empty"><strong>Notebook unavailable</strong>This notebook may have been deleted. Choose another notebook from the sidebar.</div></div>';
        return;
      }

      host.innerHTML = "";
      const inner = document.createElement("div");
      inner.className = "notebook-workspace-inner";

      const header = document.createElement("header");
      header.className = "notebook-workspace-head";
      const copy = document.createElement("div");
      copy.style.minWidth = "0";
      const eyebrow = document.createElement("div");
      eyebrow.className = "notebook-workspace-eyebrow";
      eyebrow.textContent = "Notebook";
      const title = document.createElement("h1");
      title.textContent = notebook.title;
      const description = document.createElement("p");
      description.textContent = "Chats saved here stay together. Open a conversation or start a new one in this notebook.";
      copy.append(eyebrow, title, description);

      const actions = document.createElement("div");
      actions.className = "notebook-workspace-actions";
      const newChat = document.createElement("button");
      newChat.type = "button";
      newChat.className = "notebook-primary-btn";
      newChat.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>New chat here</span>';
      newChat.onclick = () => startNotebookChat(notebook.id);
      actions.appendChild(newChat);
      header.append(copy, actions);

      const list = document.createElement("div");
      list.className = "notebook-chat-list";
      const ids = Object.keys(chatSessions).filter(chatId => {
        const chat = chatSessions[chatId];
        return chat && !chat.incognito && chat.notebookId === notebook.id;
      }).reverse();

      if(!ids.length) {
        const empty = document.createElement("div");
        empty.className = "notebook-empty";
        const emptyTitle = document.createElement("strong");
        emptyTitle.textContent = "No chats in this notebook yet";
        const emptyText = document.createElement("div");
        emptyText.textContent = "Start a chat here, or move an existing conversation into this notebook from its chat menu.";
        const emptyAction = document.createElement("button");
        emptyAction.type = "button";
        emptyAction.className = "notebook-primary-btn";
        emptyAction.textContent = "Start a chat";
        emptyAction.onclick = () => startNotebookChat(notebook.id);
        empty.append(emptyTitle, emptyText, emptyAction);
        list.appendChild(empty);
      } else {
        ids.forEach(chatId => {
          const chat = chatSessions[chatId];
          const row = document.createElement("div");
          row.className = "nb-chat-row";

          const open = document.createElement("button");
          open.type = "button";
          open.className = "nb-chat-open";
          const chatTitle = document.createElement("span");
          chatTitle.className = "nb-chat-title";
          chatTitle.textContent = chat.title || "Untitled chat";
          const messages = Array.isArray(chat.messages) ? chat.messages : [];
          const lastMessage = messages.length ? messages[messages.length - 1] : null;
          const preview = document.createElement("span");
          preview.className = "nb-chat-preview";
          const previewText = String(lastMessage && lastMessage.text || "").replace(/\s+/g, " ").trim();
          preview.textContent = previewText || (messages.length ? "Conversation" : "Empty conversation");
          open.append(chatTitle, preview);
          open.onclick = () => loadChatSession(chatId);
          open.oncontextmenu = e => {
            e.preventDefault();
            showChatContextMenu(chatId, e.clientX, e.clientY);
          };

          const more = document.createElement("button");
          more.type = "button";
          more.className = "hist-menu-btn notebook-chat-menu";
          more.textContent = "⋮";
          more.setAttribute("aria-label", "Chat actions for " + (chat.title || "Untitled chat"));
          more.title = "Chat actions";
          more.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            const rect = more.getBoundingClientRect();
            showChatContextMenu(chatId, rect.right - 190, rect.bottom + 4);
          };
          row.append(open, more);
          list.appendChild(row);
        });
      }

      inner.append(header, list);
      host.appendChild(inner);
    }

    function openNotebook(id) {
      const notebook = getNotebooks().find(n => n && n.id === id);
      if(!notebook) return;
      store.setItem("trux_active_notebook", notebook.id);
      closeSidebar();
      getEl("contextMenu").style.display = "none";
      document.body.classList.remove("home-active","chat-session-active","coding-workspace","plugins-page-active","incognito-mode");
      document.body.removeAttribute("data-media-mode");
      document.body.classList.add("notebook-open");
      const welcome = getEl("welcomeScreen");
      if(welcome) welcome.style.display = "none";
      renderNotebookWorkspace(notebook.id);
      renderSidebar();
    }

    function startNotebookChat(id) {
      const notebook = getNotebooks().find(n => n && n.id === id);
      if(!notebook) return;
      store.setItem("trux_active_notebook", notebook.id);
      document.body.classList.remove("notebook-open");
      startNewChat();
      toast("New chat will be saved to " + notebook.title + ".", "ok");
    }

    async function shareChatConversation(id) {
      const chat = chatSessions[id];
      if(!chat || chat.incognito) return;
      const title = chat.title || "Untitled chat";
      const transcript = (Array.isArray(chat.messages) ? chat.messages : []).map(message => {
        const text = String(message?.text || "").trim();
        if(!text) return "";
        return (message.role === "user" ? "You" : "TruX-Omni") + ":\n" + text;
      }).filter(Boolean).join("\n\n");
      const shareText = "TruX-Omni conversation: " + title + "\n\n" + (transcript || "This conversation has no text messages yet.");
      if(navigator.share) {
        try {
          await navigator.share({ title: title, text: shareText });
          toast("Share sheet opened.", "ok");
          return;
        } catch(error) {
          if(error?.name === "AbortError") return;
        }
      }
      try {
        if(!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(shareText);
        toast("Conversation copied. Paste it anywhere to share.", "ok");
      } catch(error) {
        prompt("Copy your conversation text to share it:", shareText);
      }
    }

    function togglePinChat(id) {
      const chat = chatSessions[id];
      if(!chat || chat.incognito) return;
      chat.pinned = !chat.pinned;
      saveChatSessions();
      renderSidebar();
      if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
      toast(chat.pinned ? "Chat pinned to the top of Recent." : "Chat unpinned.", "ok");
    }

    function renameChat(id) {
      const chat = chatSessions[id];
      if(!chat || chat.incognito) return;
      const nextTitle = prompt("Rename conversation", chat.title || "Untitled chat");
      if(nextTitle === null) return;
      const cleanTitle = String(nextTitle).trim().slice(0, 80);
      if(!cleanTitle) return toast("Chat title cannot be empty.", "err");
      chat.title = cleanTitle;
      saveChatSessions();
      renderSidebar();
      if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
      toast("Conversation renamed.", "ok");
    }

    function removeChatFromNotebook(id) {
      const chat = chatSessions[id];
      if(!chat || chat.incognito || !chat.notebookId) return;
      const notebook = getNotebooks().find(item => item && item.id === chat.notebookId);
      delete chat.notebookId;
      chat.notebookUnassigned = true;
      saveChatSessions();
      closeChatContextMenu();
      renderSidebar();
      if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
      toast('Removed "' + (chat.title || "Untitled chat") + '" from ' + (notebook?.title || "the notebook") + ". The chat is still in Recent.", "ok");
    }

    function openChatHelp() {
      closeChatContextMenu();
      const oldHelp = getEl("chatHelpModal");
      if (oldHelp) oldHelp.style.display = "none";
      closeSettingsModal();
      const profileModal = getEl("profileModal");
      if (!profileModal) return toast("The Help page could not be opened. Please refresh TruX and try again.", "err");
      closeProfileOption();
      profileModal.style.display = "flex";
      openProfileOption("help");
    }

    function closeChatHelp() {
      const modal = getEl("chatHelpModal");
      if(modal) modal.style.display = "none";
    }

    function openConversationFeedback(id) {
      closeChatContextMenu();
      const chat = id && chatSessions[id] && !chatSessions[id].incognito ? chatSessions[id] : null;
      openChatHelp();
      setTimeout(() => {
        const body = getEl("profileDetailBody");
        const section = body?.querySelector("#helpFeedbackSection");
        if (!section) return;
        const subjectField = section.querySelector('[name="subject"]');
        if (chat && subjectField && !subjectField.value.trim()) {
          subjectField.value = 'Feedback about "' + (chat.title || "Untitled chat") + '"';
        }
        section.scrollIntoView({ behavior: "smooth", block: "start" });
        section.querySelector('[name="message"]')?.focus({ preventScroll: true });
      }, 0);
    }

    function closeChatContextMenu() {
      const menu = getEl("contextMenu");
      if(menu) menu.style.display = "none";
      getEl("topbarMoreBtn")?.setAttribute("aria-expanded", "false");
    }

    function toggleTopbarMoreMenu(event) {
      event?.preventDefault();
      event?.stopPropagation();
      const menu = getEl("contextMenu");
      if(menu && menu.style.display === "block" && menu.dataset.source === "topbar") {
        closeChatContextMenu();
        return;
      }
      const onNonChatPage = document.body.classList.contains("home-active") ||
        document.body.classList.contains("notebook-open") ||
        document.body.hasAttribute("data-media-mode") ||
        document.body.classList.contains("plugins-page-active");
      showChatContextMenu(onNonChatPage ? null : currentChatId, 0, 0, "topbar");
    }

    function showChatContextMenu(id, x, y, source) {
      source = source || "chat";
      const menu = getEl("contextMenu");
      if(!menu) return;
      const candidate = id && chatSessions[id];
      const chat = candidate && !candidate.incognito ? candidate : null;
      if(source !== "topbar" && !chat) return;
      contextMenuTargetId = chat ? id : null;
      menu.dataset.source = source;

      const hasChat = !!chat;
      const hasNotebook = !!(chat && chat.notebookId && getNotebooks().some(notebook => notebook && notebook.id === chat.notebookId));
      ["contextMenuShareBtn","contextMenuPinBtn","contextMenuMoveBtn","contextMenuRenameBtn","contextMenuDeleteBtn"].forEach(actionId => {
        const action = getEl(actionId);
        if(action) action.style.display = hasChat ? "flex" : "none";
      });
      const removeNotebook = getEl("contextMenuRemoveNotebookBtn");
      if(removeNotebook) removeNotebook.style.display = hasNotebook ? "flex" : "none";
      const pinLabel = getEl("contextMenuPinBtn")?.querySelector(".context-label");
      if(pinLabel) pinLabel.textContent = chat?.pinned ? "Unpin" : "Pin";
      const incognitoLabel = getEl("contextMenuIncognitoBtn")?.querySelector(".context-label");
      if(incognitoLabel) incognitoLabel.textContent = source === "topbar" && incognitoMode ? "Exit incognito chat" : "New incognito chat";
      const hasNativeAssistant = !!((window.TruXNativeAssistant && typeof window.TruXNativeAssistant.requestAssistantRole === "function") || /Android/i.test(navigator.userAgent));
      const androidAssistantButton = getEl("contextMenuAndroidAssistantBtn");
      const androidAssistantSeparator = getEl("contextMenuAssistantSeparator");
      if(androidAssistantButton) androidAssistantButton.style.display = hasNativeAssistant ? "flex" : "none";
      if(androidAssistantSeparator) androidAssistantSeparator.style.display = hasNativeAssistant ? "block" : "none";

      menu.style.display = "block";
      const width = menu.offsetWidth || 258;
      const height = menu.offsetHeight || 360;
      let left = Number(x) || 8;
      let top = Number(y) || 8;
      if(source === "topbar") {
        const button = getEl("topbarMoreBtn");
        const rect = button?.getBoundingClientRect();
        if(rect) {
          left = rect.right - width;
          top = rect.bottom + 7;
          if(top + height > innerHeight - 8) top = rect.top - height - 7;
        }
      }
      menu.style.left = Math.max(8, Math.min(left, innerWidth - width - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(top, innerHeight - Math.min(height, innerHeight - 16) - 8)) + "px";
      getEl("topbarMoreBtn")?.setAttribute("aria-expanded", source === "topbar" ? "true" : "false");
    }

    function openMoveChatToNotebook(chatId) {
      const chat = chatSessions[chatId];
      if(!chat || chat.incognito) return;
      ensureNotebookAssignments();
      notebookMoveTargetId = chatId;
      const host = getEl("notebookMoveChoices");
      const subtitle = getEl("notebookMoveSubtitle");
      if(subtitle) subtitle.textContent = 'Choose a notebook for "' + (chat.title || "Untitled chat") + '".';
      if(host) {
        host.innerHTML = "";
        const notebooks = getNotebooks();
        notebooks.forEach(notebook => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "notebook-choice" + (chat.notebookId === notebook.id ? " current" : "");
          const icon = document.createElement("span");
          icon.className = "notebook-choice-icon";
          icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5h8.5L18.5 9v10A1.5 1.5 0 0 1 17 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M13 4.5V9h5"/></svg>';
          const copy = document.createElement("span");
          copy.className = "notebook-choice-copy";
          const title = document.createElement("span");
          title.className = "notebook-choice-title";
          title.textContent = notebook.title;
          const count = Object.keys(chatSessions).filter(id => {
            const item = chatSessions[id];
            return item && !item.incognito && item.notebookId === notebook.id;
          }).length;
          const meta = document.createElement("span");
          meta.className = "notebook-choice-meta";
          meta.textContent = count + (count === 1 ? " chat" : " chats") + (chat.notebookId === notebook.id ? " · Current notebook" : "");
          copy.append(title, meta);
          button.append(icon, copy);
          button.onclick = () => moveChatToNotebook(chatId, notebook.id);
          host.appendChild(button);
        });
        if(!notebooks.length) {
          const empty = document.createElement("div");
          empty.className = "notebook-choice-empty";
          empty.textContent = "There are no notebooks yet. Create one from the sidebar, then move this chat.";
          const create = document.createElement("button");
          create.type = "button";
          create.className = "notebook-primary-btn";
          create.textContent = "Create notebook";
          create.onclick = () => { closeNotebookMoveModal(); createNotebook(); };
          host.append(empty, create);
        }
      }
      const modal = getEl("notebookMoveModal");
      if(modal) {
        modal.classList.add("active");
        modal.setAttribute("aria-hidden","false");
      }
    }

    function closeNotebookMoveModal() {
      const modal = getEl("notebookMoveModal");
      if(modal) {
        modal.classList.remove("active");
        modal.setAttribute("aria-hidden","true");
      }
      notebookMoveTargetId = null;
    }

    function moveChatToNotebook(chatId, notebookId) {
      const chat = chatSessions[chatId];
      const notebook = getNotebooks().find(n => n && n.id === notebookId);
      if(!chat || chat.incognito || !notebook) return closeNotebookMoveModal();
      const previousNotebookId = chat.notebookId;
      chat.notebookId = notebook.id;
      chat.notebookUnassigned = false;
      saveChatSessions();
      closeNotebookMoveModal();
      renderSidebar();
      if(document.body.classList.contains("notebook-open")) {
        renderNotebookWorkspace(getActiveNotebookId());
      }
      if(previousNotebookId === notebook.id) toast("This chat is already in " + notebook.title + ".", "ok");
      else toast('Moved "' + (chat.title || "Untitled chat") + '" to ' + notebook.title + ".", "ok");
    }

    function renderSidebar() {
      ensureNotebookAssignments();
      renderNotebooks();
      let hL = getEl("historyList"); if(!hL) return;
      let q = (getEl("historySearch")?.value || "").trim().toLowerCase();
      let ids = Object.keys(chatSessions).filter(id => !chatSessions[id]?.incognito).reverse();
      if(q) ids = ids.filter(id => (chatSessions[id]?.title || "").toLowerCase().includes(q));

      hL.innerHTML = "";
      if(!ids.length) {
        if(q) {
          hL.innerHTML = '<div class="empty">No chats match <b>' + escapeHtml(q) + '</b>.</div>';
        } else if(auth?.currentUser && cloudChatLoadState === "loading") {
          hL.innerHTML = '<div class="empty">Loading chats from your TruX account…</div>';
        } else if(auth?.currentUser && cloudChatLoadState === "error") {
          hL.innerHTML = '<div class="empty">Could not load your saved chats. TruX is retrying the cloud connection. Your chats have not been deleted.</div>';
        } else {
          hL.innerHTML = '<div class="empty">Your chats will appear here.<br>Start a new chat to begin.</div>';
        }
        return;
      }

      let lastLabel = null;
      ids.sort((a, b) => {
        const pinOrder = Number(!!chatSessions[b]?.pinned) - Number(!!chatSessions[a]?.pinned);
        return pinOrder || chatBucket(a).rank - chatBucket(b).rank;
      });
      ids.forEach(id => {
        let label = chatSessions[id]?.pinned ? "Pinned" : chatBucket(id).label;
        if(label !== lastLabel) {
          let h = document.createElement("div"); h.className = "history-head"; h.textContent = label;
          hL.appendChild(h); lastLabel = label;
        }
        const row = document.createElement("div");
        row.className = "hist-row";

        const x = document.createElement("div");
        x.className = "hist" + (id === currentChatId ? " active" : "");
        x.textContent = chatSessions[id].title || "Untitled chat";
        x.title = chatSessions[id].title || "Untitled chat";
        x.setAttribute("role","button");
        x.tabIndex = 0;
        x.onclick = () => loadChatSession(id);
        x.onkeydown = e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); loadChatSession(id); } };
        x.oncontextmenu = e => { e.preventDefault(); showChatContextMenu(id, e.clientX, e.clientY); };

        const more = document.createElement("button");
        more.type = "button";
        more.className = "hist-menu-btn";
        more.textContent = "⋯";
        more.setAttribute("aria-label", "Chat actions for " + (chatSessions[id].title || "Untitled chat"));
        more.title = "Move or delete chat";
        more.onclick = e => {
          e.preventDefault();
          e.stopPropagation();
          const rect = more.getBoundingClientRect();
          showChatContextMenu(id, rect.right - 190, rect.bottom + 4);
        };
        row.append(x, more);
        hL.appendChild(row);
      });
    }
    function enterChatWorkspace() {
      const codingSession = workspaceMode === "coding";
      const body = document.body;
      const welcomeForExit = getEl("welcomeScreen");
      const leavingHome = body.classList.contains("home-active") && !codingSession && !!welcomeForExit;
      if (leavingHome) {
        const rect = welcomeForExit.getBoundingClientRect();
        if (window.__truxHomeExitTimer) clearTimeout(window.__truxHomeExitTimer);
        body.classList.remove("home-exiting-fade");
        body.classList.add("home-exiting");
        welcomeForExit.style.setProperty("--trux-home-exit-left", rect.left + "px");
        welcomeForExit.style.setProperty("--trux-home-exit-top", rect.top + "px");
        welcomeForExit.style.setProperty("--trux-home-exit-width", rect.width + "px");
        welcomeForExit.style.setProperty("--trux-home-exit-height", rect.height + "px");
        welcomeForExit.style.removeProperty("opacity");
        welcomeForExit.style.removeProperty("transform");
        // Resolve the visible exit state first, then begin the fade on the next
        // paint. A single RAF can coalesce both class changes before paint,
        // making the prompts and home glow appear to vanish instantly.
        void welcomeForExit.offsetWidth;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (body.classList.contains("home-exiting")) body.classList.add("home-exiting-fade");
          });
        });
        window.__truxHomeExitTimer = setTimeout(() => {
          const returnedHome = body.classList.contains("home-active");
          body.classList.remove("home-exiting", "home-exiting-fade");
          [
            "--trux-home-exit-left",
            "--trux-home-exit-top",
            "--trux-home-exit-width",
            "--trux-home-exit-height"
          ].forEach(property => welcomeForExit.style.removeProperty(property));
          welcomeForExit.style.removeProperty("opacity");
          welcomeForExit.style.removeProperty("transform");
          if (returnedHome) welcomeForExit.style.removeProperty("display");
          else welcomeForExit.style.setProperty("display", "none");
          window.__truxHomeExitTimer = null;
        }, 1050);
      }

      body.classList.remove("home-active");
      body.classList.toggle("chat-session-active", !codingSession);
      body.classList.toggle("coding-workspace", codingSession);
      body.removeAttribute("data-media-mode");

      const welcome = getEl("welcomeScreen");
      if (welcome) welcome.style.display = "none";

      const active = getActiveChatContainer();
      ["chatContainer", "codeChatContainer"].forEach(function(id) {
        const el = getEl(id);
        if (!el) return;
        el.style.display = el === active ? "block" : "none";
      });

      if (codingSession) {
        // #truxCodeWorkspace contains #codeChatContainer; keep this parent
        // visible while the assistant row is appended and streamed.
        const codeHome = getEl("truxCodeWorkspace");
        if (codeHome) {
          codeHome.style.removeProperty("display");
          codeHome.style.removeProperty("opacity");
          codeHome.style.removeProperty("transform");
        }
      }

      if (active) {
        active.classList.add("chat-session-view");
      }
      return active;
    }

    function loadChatSession(id) {
      if(!chatSessions[id]) return;
      if (activeTurnContext) persistTurnDraft(activeTurnContext, activeTurnContext.latestText || "", true);
      if(currentChatId && isPersistableChatSession(chatSessions[currentChatId])) void syncChatsToCloud(true);
      generationEpoch += 1;
      activeTurnContext = null;
      try { activeAbortController?.abort(); } catch {}
      try { activeStreamer?.cancel(); } catch {}
      activeStreamer = null;
      isGenerating = false;
      activeAbortController = null;
      handleInputChange();
      document.body.classList.remove("notebook-open");
      incognitoMode = false;
      currentChatId = id;
      if(auth?.currentUser) {
        store.setItem("trux_last_active_chat_id:" + auth.currentUser.uid, id);
        store.removeItem("trux_suppress_latest_chat_restore:" + auth.currentUser.uid);
      }
      restorePersistedTurnDraft(id);
      generationStopRequested = false;
      setWorkspaceMode(chatSessions[id].mode || "chat", {reload:false,preserveSession:true});
      getEl("btnIcon").innerHTML = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>';
      getEl("actionBtn").classList.remove("stop");
      const welcome = getEl("welcomeScreen");
      if(welcome) welcome.style.display = "none";
      getEl("chatContainer").innerHTML = "";
      getEl("codeChatContainer").innerHTML = "";
      const cC = enterChatWorkspace();
       chatSessions[id].messages.forEach((m, index) => {
         appendMessageRow(m.role === "user" ? "You" : "TruX-Omni", m.text, m.role === "user" ? "user-row" : "trux-row", m.role === "user" ? "user-bubble" : "trux-bubble", m.image, false, m.sources, m.video, { messageIndex: index, stopped: m.role === "user" && m.stopped === true, incomplete: m.role === "trux" && m.incomplete === true });
         if (workspaceMode === "coding" && m.role === "trux" && Number.isFinite(Number(m.durationMs))) {
           const rows = getActiveChatContainer()?.querySelectorAll(".row.trux-row") || [];
           const restoredRow = rows[rows.length - 1];
           restoreCompletedCodeSteps(restoredRow, m);
         }
         if (m.githubProposal) {
           const rows = getActiveChatContainer()?.querySelectorAll(".row.trux-row") || [];
           const lastRow = rows[rows.length - 1];
           const host = lastRow?.querySelector(".trux-response-stack") || lastRow;
           if (host) renderGithubProposalCard(host, m.githubProposal);
         }
       });
      // Partial direct-request output is restored from the account's cloud history; no worker is reattached.
      renderSidebar(); if(innerWidth <= 768) closeSidebar(); else setSidebarOpen(true);
    }
    function deleteChat(id) {
      if(!confirm("Delete this chat?")) return;
      const notebookWasOpen = document.body.classList.contains("notebook-open");
      const openNotebookId = getActiveNotebookId();
      const deletedChat = chatSessions[id];
      delete chatSessions[id];
      store.removeItem("trux_turn_draft_" + id);
      if(deletedChat && !deletedChat.incognito && auth?.currentUser) pendingDeletedCloudChatIds.add(id);
      cloudChatSyncedFingerprints.delete(id);
      saveChatSessions();
      if(currentChatId === id) {
        if(notebookWasOpen) {
          try { activeAbortController?.abort(); } catch {}
          try { activeStreamer?.cancel(); } catch {}
          activeStreamer = null;
          isGenerating = false;
          generationStopRequested = true;
          currentChatId = null;
        } else {
          startNewChat();
        }
      }
      renderSidebar();
      if(notebookWasOpen) renderNotebookWorkspace(openNotebookId);
    }

    function bindContextMenuAction(id, handler) {
      const item = getEl(id);
      if(!item) return;
      const activate = event => {
        event?.preventDefault();
        event?.stopPropagation();
        const targetId = contextMenuTargetId;
        closeChatContextMenu();
        handler(targetId);
      };
      item.onclick = activate;
      item.onkeydown = event => {
        if(event.key === "Enter" || event.key === " ") activate(event);
      };
    }

    bindContextMenuAction("contextMenuShareBtn", id => { if(id) void shareChatConversation(id); });
    bindContextMenuAction("contextMenuPinBtn", id => { if(id) togglePinChat(id); });
    bindContextMenuAction("contextMenuMoveBtn", id => { if(id) openMoveChatToNotebook(id); });
    bindContextMenuAction("contextMenuRemoveNotebookBtn", id => { if(id) removeChatFromNotebook(id); });
    bindContextMenuAction("contextMenuRenameBtn", id => { if(id) renameChat(id); });
    bindContextMenuAction("contextMenuHelpBtn", () => openChatHelp());
    bindContextMenuAction("contextMenuFeedbackBtn", id => openConversationFeedback(id));
    bindContextMenuAction("contextMenuIncognitoBtn", () => {
      if(incognitoMode) closeIncognitoChat();
      else launchIncognitoChat();
    });
    bindContextMenuAction("contextMenuDeleteBtn", id => {
      if(id) deleteChat(id);
      contextMenuTargetId = null;
    });
    
    addEventListener("click", e => {
      let ctx = getEl("contextMenu"); if(ctx && !ctx.contains(e.target)) closeChatContextMenu();
      let menu = getEl("attachmentMenu"); if(menu && !menu.contains(e.target) && !getEl("attachBtn").contains(e.target)) closeAttachmentMenu();
      let modelPicker = getEl("modelDropdown"), modelPickerBtn = getEl("modelPickerBtn"); if(modelPicker && modelPickerBtn && !modelPicker.contains(e.target) && !modelPickerBtn.contains(e.target)) closeModelDropdown();
    });

    getEl("promptInput").addEventListener("keydown", e => {
      if(e.key === "Enter" && !e.shiftKey) {
        let isMobile = window.innerWidth <= 768 || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
        if(isMobile) return;
        e.preventDefault();
        handleActionButton();
      }
    });

    getEl("profileModal").addEventListener("click", e => { if(e.target === getEl("profileModal")) closeProfileModal(); });
    getEl("sandboxModal")?.addEventListener("click", e => { if(e.target === getEl("sandboxModal")) closeSandboxModal(); });
    getEl("pinnedModal")?.addEventListener("click", e => { if(e.target === getEl("pinnedModal")) closePinnedModal(); });
    getEl("loginWallModal")?.addEventListener("click", e => { if(e.target === getEl("loginWallModal")) closeLoginWall(); });
    
    addEventListener("keydown", e => { if(e.key === "Escape") { closeMediaLibrary(); closeProfileModal(); closeSettingsModal(); closeSandboxModal(); closePinnedModal(); closeLoginWall(); closeChatContextMenu(); closeChatHelp(); closeSidebar(); closeModelDropdown(); closeAttachmentMenu(); } });


    /* SETTINGS / PROFILE EVENT DELEGATION */
    const settingsModalNode=getEl("profileModal");
    if(settingsModalNode){
      settingsModalNode.addEventListener("click",function(event){
        const nav=event.target && event.target.closest ? event.target.closest("[data-settings-section]") : null;
        if(nav && settingsModalNode.contains(nav)){
          event.preventDefault();
          event.stopPropagation();
          switchSettingsSection(nav.getAttribute("data-settings-section"));
        }
      },true);
    }

    const profileModalNode=getEl("profileModal");
    if(profileModalNode){
      profileModalNode.addEventListener("click",function(event){
        const route=event.target && event.target.closest ? event.target.closest("[data-profile-page]") : null;
        if(route && profileModalNode.contains(route)){
          event.preventDefault();
          event.stopPropagation();
          openProfileOption(route.getAttribute("data-profile-page"));
        }
      },true);
    }

    const startupWorkspaceMode = "chat";
    try {
      currentChatId = null;
      document.body.classList.remove("chat-session-active","coding-workspace","plugins-page-active");
      document.body.removeAttribute("data-media-mode");
      document.body.classList.add("home-active");
      loadSettings();
      renderNotebooks();
      renderSidebar();
      updateAllUsageUI();
      handleInputChange();
      setWorkspaceMode(startupWorkspaceMode, {reload:false,preserveSession:false});
      startTruxCodeIdlePulse();
    } catch (startupError) {
      window.__truxRecoverBoot(startupError);
    } finally {
      window.__truxBootFinished = true;
      document.body?.classList.remove("trux-boot-recovered");
    }
  

    let truxSubscriptionReturnState = null;
    function refreshSubscriptionPage() {
      const supportedTiers = ["base", "plus", "pro", "edge"];
      const activePlan = supportedTiers.includes(currentPlanTier) ? currentPlanTier : "base";
      document.querySelectorAll("[data-subscription-plan]").forEach(card => {
        const tier = card.getAttribute("data-subscription-plan");
        const isCurrent = tier === activePlan;
        card.classList.toggle("current", isCurrent);
        const button = card.querySelector(".subscription-plan-action");
        if (!button) return;
        if (tier === "base") button.textContent = isCurrent ? "Current plan" : "Choose Free";
        else if (tier === "pro" && isCurrent) button.textContent = "Current plan";
        else button.textContent = "Coming Dec 1, 2026";
      });
    }
    function openSubscriptionPage() {
      // Capture the active workspace once, so repeated taps cannot overwrite
      // the destination used by the page's Back action.
      if (!document.body.classList.contains("subscription-page-active")) {
        truxSubscriptionReturnState = { mode: workspaceMode, chatId: currentChatId };
      }

      closeAttachmentMenu(); closeModelDropdown(); closeChatContextMenu();

      // Plans is a standalone screen, not an overlay on top of Chat/Code.
      // Clear mode-specific visibility flags while keeping workspaceMode and
      // currentChatId untouched; closeSubscriptionPage restores them via
      // setWorkspaceMode() using the saved state above.
      document.body.classList.remove(
        "home-active",
        "chat-session-active",
        "coding-workspace",
        "plugins-page-active",
        "notebook-open",
        "scrolled"
      );
      document.body.removeAttribute("data-media-mode");
      document.body.classList.add("subscription-page-active");

      getEl("subscriptionWorkspace")?.scrollTo({ top: 0, behavior: "instant" });
      refreshSubscriptionPage();
    }
    function closeSubscriptionPage() {
      const state = truxSubscriptionReturnState || { mode: "chat", chatId: currentChatId };
      document.body.classList.remove("subscription-page-active");
      currentChatId = state.chatId || currentChatId;
      setWorkspaceMode(state.mode || "chat", { reload: false, preserveSession: true });
      truxSubscriptionReturnState = null;
    }
    function selectSubscriptionPlan(plan) {
      const planNames = { base: "Free", plus: "Plus", pro: "Pro", edge: "TruX AI Edge" };
      if (!Object.prototype.hasOwnProperty.call(planNames, plan)) {
        return toast("That plan is not available.");
      }
      if (plan === currentPlanTier) {
        return toast("You already have " + planNames[plan] + " access. Updated pricing and limits take effect December 1, 2026.");
      }
      if (plan !== "base") {
        return toast(planNames[plan] + " pricing and updated limits are scheduled for December 1, 2026. Plan changes are not active yet.");
      }
      toast("Plan selection is managed through your TruX account.");
    }
    function openSubscriptionSupport() {
      toast("Subscription support is being prepared. Please use Help & feedback to contact the TruX team.");
    }
    function syncFloatingChromeFade() {
      const container = getActiveChatContainer();
      const amount = container ? Math.min(1, Math.max(0, container.scrollTop / 140)) : 0;
      document.body.style.setProperty("--trux-chrome-fade", String(amount));
    }
    ["chatContainer", "codeChatContainer"].forEach(id => getEl(id)?.addEventListener("scroll", syncFloatingChromeFade, { passive: true }));
