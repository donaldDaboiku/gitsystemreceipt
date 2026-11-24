const ACCESS_CACHE_KEY = "accountAccess";
const OFFLINE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

function cacheAccount(account) {
  localStorage.setItem(ACCESS_CACHE_KEY, JSON.stringify({
    status: account.status || "pending",
    paidUntil: Number(account.paidUntil) || 0,
    checkedAt: Date.now(),
  }));
}

function readCachedAccount() {
  try {
    return JSON.parse(localStorage.getItem(ACCESS_CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

function offlineGraceOk(account) {
  if (!account || !account.checkedAt) return false;
  if (Date.now() - Number(account.checkedAt) > OFFLINE_GRACE_MS) return false;
  return isAccessAllowed(account, Date.now());
}

function functionUrl(name) {
  return `https://${FUNCTION_REGION}-${FIREBASE_CONFIG.projectId}.cloudfunctions.net/${name}`;
}

async function callFunction(name, body) {
  const user = firebase.auth().currentUser;
  if (!user) throw new Error("Sign in required");
  const token = await user.getIdToken();
  const response = await fetch(functionUrl(name), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function ensureUserProfile(user) {
  const ref = firestoreDb.collection("users").doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
  const profile = {
    email: user.email,
    status: "pending",
    createdAt: Date.now(),
  };
  await ref.set(profile);
  return profile;
}

async function readPricing() {
  const snap = await firestoreDb.collection("config").doc("pricing").get();
  if (!snap.exists) return null;
  return snap.data();
}

function toggleAdminNav(show) {
  const link = document.getElementById("adminNav");
  if (link) link.hidden = !show;
}

function renderAccountSummary(user, account) {
  const el = document.getElementById("accountSummary");
  if (!el) return;
  if (!user) {
    el.textContent = "Not signed in";
    return;
  }
  const label = accountLabel(account, Date.now());
  const until = account && account.status === "subscriber" && account.paidUntil
    ? ` until ${new Date(Number(account.paidUntil)).toLocaleDateString()}`
    : "";
  el.textContent = `${user.email} · ${label}${until}`;
}

function renderRenewalBanner(account) {
  const banner = document.getElementById("renewBanner");
  const text = document.getElementById("renewBannerText");
  if (!banner || !text) return;
  if (!account || account.status !== "subscriber") {
    banner.hidden = true;
    return;
  }
  const days = Math.ceil((Number(account.paidUntil) - Date.now()) / 86400000);
  if (days > 7) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  text.textContent = days > 0
    ? `Your subscription ends in ${days} day${days === 1 ? "" : "s"}. Renew to keep cloud backup.`
    : "Your subscription has ended. Renew to keep cloud backup.";
}

async function showSubscribe() {
  const priceEl = document.getElementById("subscribePrice");
  const payBtn = document.getElementById("payBtn");
  try {
    const pricing = await readPricing();
    if (!pricing) {
      if (priceEl) priceEl.textContent = "The subscription price is not set yet. Contact the app owner.";
      if (payBtn) payBtn.disabled = true;
      return;
    }
    if (priceEl) {
      priceEl.textContent = `${formatNaira(pricing.amount)} for ${pricing.periodDays} days. Paystack handles the card or transfer.`;
    }
    if (payBtn) payBtn.disabled = false;
  } catch (error) {
    if (priceEl) priceEl.textContent = "Could not load the price. Check your connection and try again.";
    if (payBtn) payBtn.disabled = true;
  }
}

async function enterApp(account) {
  window.accountLock = null;
  renderRenewalBanner(account);
  showSection("dashboard");
  try {
    await syncBothWays();
    loadSettings();
    loadEstates();
    loadDashboard();
    loadHistory();
  } catch (error) {
    console.warn("Cloud sync skipped", error);
  }
}

async function refreshAccountGate() {
  const user = firebase.auth().currentUser;
  if (!user) {
    window.accountLock = "auth";
    window.isAppAdmin = false;
    toggleAdminNav(false);
    renderAccountSummary(null, null);
    showSection("auth");
    return;
  }

  let account = null;
  try {
    account = await ensureUserProfile(user);
    cacheAccount(account);
  } catch (error) {
    const cached = readCachedAccount();
    if (offlineGraceOk(cached)) {
      window.isAppAdmin = isAdminEmail(user.email);
      toggleAdminNav(window.isAppAdmin);
      renderAccountSummary(user, cached);
      await enterApp(cached);
      return;
    }
    window.accountLock = "subscribe";
    const priceEl = document.getElementById("subscribePrice");
    if (priceEl) priceEl.textContent = "You are offline. Connect once to confirm your subscription.";
    showSection("subscribe");
    return;
  }

  let adminDoc = false;
  try {
    const adminSnap = await firestoreDb.collection("admins").doc(user.uid).get();
    adminDoc = adminSnap.exists;
  } catch (error) {
    adminDoc = false;
  }
  window.isAppAdmin = isAdminEmail(user.email) || adminDoc;
  toggleAdminNav(window.isAppAdmin);
  renderAccountSummary(user, account);
  renderRenewalBanner(account);

  if (!isAccessAllowed(account, Date.now())) {
    window.accountLock = "subscribe";
    await showSubscribe();
    showSection("subscribe");
    return;
  }
  await enterApp(account);
}

async function verifyReturnedPayment() {
  const params = new URLSearchParams(location.search);
  const reference = params.get("reference") || params.get("trxref");
  if (!reference || !firebase.auth().currentUser) return;
  try {
    await callFunction("verifyPayment", { reference });
    showNotice("Payment received. Your subscription is active.");
  } catch (error) {
    alert("Payment could not be confirmed yet: " + error.message);
  } finally {
    history.replaceState({}, "", location.pathname);
  }
}

async function bootAccount() {
  window.accountLock = "auth";
  bindAccountEvents();
  if (!firebaseProjectReady()) {
    const warn = document.getElementById("configWarning");
    if (warn) warn.hidden = false;
    showSection("auth");
    return;
  }
  const connected = await connectFirebase({ alert: false });
  if (connected) await verifyReturnedPayment();
  await refreshAccountGate();
}

function authFields() {
  return {
    email: document.getElementById("authEmail")?.value.trim() || "",
    password: document.getElementById("authPassword")?.value || "",
  };
}

function authMessage(error) {
  const code = error && error.code;
  if (code === "auth/email-already-in-use") return "That email is already registered. Sign in instead.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "Email or password is incorrect.";
  }
  if (code === "auth/invalid-email") return "Enter a valid email address.";
  if (code === "auth/weak-password") return "Use a password of at least 6 characters.";
  return error.message || "Could not sign in.";
}

async function onRegister() {
  if (!firebaseProjectReady()) {
    alert("This copy of the app is not connected to the cloud yet.");
    return;
  }
  const fields = authFields();
  try {
    const connected = await connectFirebase({ alert: false, mode: "signup", ...fields });
    if (!connected) return;
    document.getElementById("authPassword").value = "";
    await refreshAccountGate();
  } catch (error) {
    alert(authMessage(error));
  }
}

async function onSignIn() {
  if (!firebaseProjectReady()) {
    alert("This copy of the app is not connected to the cloud yet.");
    return;
  }
  const fields = authFields();
  try {
    const connected = await connectFirebase({ alert: false, mode: "signin", ...fields });
    if (!connected) return;
    document.getElementById("authPassword").value = "";
    await refreshAccountGate();
  } catch (error) {
    alert(authMessage(error));
  }
}

async function startPaystack() {
  const payBtn = document.getElementById("payBtn");
  if (payBtn) payBtn.disabled = true;
  try {
    const data = await callFunction("createPayment", {
      callbackUrl: location.origin + location.pathname,
    });
    if (!data.authorization_url) throw new Error("Paystack did not return a payment link");
    location.href = data.authorization_url;
  } catch (error) {
    alert(error.message || "Payment could not start. Deploy the Paystack function and set PAYSTACK_SECRET.");
    if (payBtn) payBtn.disabled = false;
  }
}

async function signOutAndLock() {
  await signOutFirebase();
  localStorage.removeItem(ACCESS_CACHE_KEY);
  window.accountLock = "auth";
  window.isAppAdmin = false;
  toggleAdminNav(false);
  renderAccountSummary(null, null);
  showSection("auth");
}

async function savePrice() {
  const amount = Number(document.getElementById("priceAmount").value);
  const periodDays = Number(document.getElementById("priceDays").value);
  const status = document.getElementById("priceStatus");
  if (!(amount >= 100) || !(periodDays >= 1) || periodDays > 366) {
    if (status) status.textContent = "Use at least ₦100 and 1 to 366 days.";
    return;
  }
  await firestoreDb.collection("config").doc("pricing").set({
    amount,
    periodDays: Math.round(periodDays),
    currency: "NGN",
    updatedAt: Date.now(),
  });
  if (status) status.textContent = `Price saved: ${formatNaira(amount)} for ${Math.round(periodDays)} days.`;
}

async function loadAdmin() {
  const pricing = await readPricing();
  const amountEl = document.getElementById("priceAmount");
  const daysEl = document.getElementById("priceDays");
  if (amountEl && pricing) amountEl.value = pricing.amount;
  if (daysEl) daysEl.value = pricing ? pricing.periodDays : 30;
  const snap = await firestoreDb.collection("users").get();
  const clients = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  clients.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const list = document.getElementById("clientList");
  if (!list) return;
  if (!clients.length) {
    list.innerHTML = "<p>No clients have registered yet.</p>";
    return;
  }
  const now = Date.now();
  list.innerHTML = clients.map((client) => `
    <div class="client-row">
      <div>
        <strong>${escapeHtml(client.email || client.id)}</strong>
        <span class="status-pill status-${escapeHtml(accountLabel(client, now).toLowerCase())}">${escapeHtml(accountLabel(client, now))}</span>
      </div>
      <button type="button" class="secondary-btn review-client-btn" data-uid="${escapeHtml(client.id)}">Review</button>
    </div>
  `).join("");
  list.querySelectorAll(".review-client-btn").forEach((button) => {
    button.addEventListener("click", () => openClientReview(clients.find((client) => client.id === button.getAttribute("data-uid"))));
  });
}

function openClientReview(client) {
  const panel = document.getElementById("clientReview");
  if (!panel || !client) return;
  panel.hidden = false;
  panel.dataset.uid = client.id;
  const now = Date.now();
  document.getElementById("reviewEmail").textContent = client.email || client.id;
  document.getElementById("reviewMeta").textContent =
    `${accountLabel(client, now)} · joined ${client.createdAt ? new Date(Number(client.createdAt)).toLocaleDateString() : "unknown"}` +
    (client.paidUntil ? ` · paid until ${new Date(Number(client.paidUntil)).toLocaleDateString()}` : "");
  document.getElementById("reviewNote").value = client.reviewNote || "";
}

async function updateReviewedClient(status) {
  const panel = document.getElementById("clientReview");
  const uid = panel?.dataset.uid;
  if (!uid) return;
  const ref = firestoreDb.collection("users").doc(uid);
  const snap = await ref.get();
  const current = snap.data() || {};
  const pricing = await readPricing();
  const patch = {
    status,
    reviewNote: document.getElementById("reviewNote").value.trim(),
    reviewedAt: Date.now(),
  };
  if (status === "subscriber") {
    patch.paidUntil = extendPaidUntil(current.paidUntil, Date.now(), pricing ? pricing.periodDays : 30);
  }
  if (status === "free" || status === "pending") patch.paidUntil = 0;
  await ref.update(patch);
  showNotice(status === "free" ? "Client is free" : status === "subscriber" ? "Subscription granted" : "Client set to pending");
  await loadAdmin();
  const updated = (await ref.get()).data();
  openClientReview({ id: uid, ...updated });
}

function bindAccountEvents() {
  if (bindAccountEvents.done) return;
  bindAccountEvents.done = true;
  document.getElementById("registerBtn")?.addEventListener("click", onRegister);
  document.getElementById("signInBtn")?.addEventListener("click", onSignIn);
  document.getElementById("payBtn")?.addEventListener("click", startPaystack);
  document.getElementById("renewBannerBtn")?.addEventListener("click", startPaystack);
  document.getElementById("settingsRenewBtn")?.addEventListener("click", startPaystack);
  document.getElementById("accountSignOutBtn")?.addEventListener("click", signOutAndLock);
  document.getElementById("settingsSignOutBtn")?.addEventListener("click", signOutAndLock);
  document.getElementById("savePriceBtn")?.addEventListener("click", () => {
    savePrice().catch((error) => alert(error.message));
  });
  document.getElementById("makeFreeBtn")?.addEventListener("click", () => {
    updateReviewedClient("free").catch((error) => alert(error.message));
  });
  document.getElementById("grantSubBtn")?.addEventListener("click", () => {
    updateReviewedClient("subscriber").catch((error) => alert(error.message));
  });
  document.getElementById("revokeBtn")?.addEventListener("click", () => {
    updateReviewedClient("pending").catch((error) => alert(error.message));
  });
  const authPassword = document.getElementById("authPassword");
  authPassword?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") onSignIn();
  });
}

window.bootAccount = bootAccount;
window.loadAdmin = loadAdmin;
