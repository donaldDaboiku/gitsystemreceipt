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
    status: "free",
    plan: "free",
    createdAt: Date.now(),
  };
  await ref.set(profile);
  return profile;
}

async function loadPlanCatalog() {
  try {
    const snap = await firestoreDb.collection("config").doc("plans").get();
    window.planCatalog = planCatalog(snap.exists ? snap.data() : null);
  } catch (error) {
    window.planCatalog = planCatalog(null);
  }
  return window.planCatalog;
}

function rememberPlan(account) {
  window.currentAccount = account || null;
  window.currentPlan = effectivePlan(account, Date.now());
}

function toggleAdminNav(show) {
  const link = document.getElementById("adminNav");
  if (link) link.hidden = !show;
  const openBtn = document.getElementById("openAdminBtn");
  if (openBtn) openBtn.hidden = !show;
}

function renderAccountSummary(user, account) {
  const el = document.getElementById("accountSummary");
  if (!el) return;
  if (!user) {
    el.textContent = "Not signed in";
    return;
  }
  const label = accountLabel(account, Date.now());
  const until = account && paidPlanActive(account, Date.now())
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
    ? `Your ${accountLabel(account, Date.now())} plan ends in ${days} day${days === 1 ? "" : "s"}. Renew to keep unlimited receipts, PDF, and WhatsApp.`
    : "Your paid plan has ended. You are on Free, with 5 receipts this month.";
}

async function showSubscribe() {
  const host = document.getElementById("planChoices");
  const catalog = await loadPlanCatalog();
  const cycle = window.billingCycle === "annual" ? "annual" : "monthly";
  if (!host) return;
  host.innerHTML = ["starter", "professional", "business"].map((id) => {
    const plan = catalog[id];
    const amount = cycle === "annual" ? plan.annual : plan.monthly;
    const recommended = id === "professional" ? " recommended" : "";
    return `<article class="plan-choice${recommended}">
      <h3>${escapeHtml(plan.name)}${id === "professional" ? " · Recommended" : ""}</h3>
      <p class="plan-price">${formatNaira(amount)}<span>/${cycle === "annual" ? "year" : "month"}</span></p>
      <button type="button" class="choose-plan-btn" data-plan="${id}">Subscribe</button>
    </article>`;
  }).join("");
  host.querySelectorAll(".choose-plan-btn").forEach((button) => {
    button.addEventListener("click", () => startPaystack(button.getAttribute("data-plan")));
  });
}

async function enterApp(account) {
  window.accountLock = null;
  rememberPlan(account);
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
    rememberPlan(null);
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
  rememberPlan(account);
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

async function startPaystack(planId) {
  if (!firebaseProjectReady()) {
    alert("This copy of the app is not connected to the cloud yet.");
    return;
  }
  const catalog = window.planCatalog || planCatalog(null);
  const cycle = window.billingCycle === "annual" ? "annual" : "monthly";
  const requested = planId && planId !== "free" ? planId : (window.currentAccount && window.currentAccount.plan) || "professional";
  const quote = planQuote(catalog, requested === "free" ? "professional" : requested, cycle);
  if (!quote) {
    alert("Choose Starter, Professional, or Business.");
    return;
  }
  const planName = catalog[quote.planId] ? catalog[quote.planId].name : quote.planId;
  if (!confirm(`Pay ${formatNaira(quote.amount)} for ${planName} (${quote.cycle})?`)) return;
  try {
    const data = await callFunction("createPayment", {
      planId: quote.planId,
      cycle: quote.cycle,
      callbackUrl: location.origin + location.pathname,
    });
    if (!data.authorization_url) throw new Error("Paystack did not return a payment link");
    location.href = data.authorization_url;
  } catch (error) {
    alert(error.message || "Payment could not start. Deploy the Paystack function and set PAYSTACK_SECRET.");
  }
}

async function signOutAndLock() {
  await signOutFirebase();
  localStorage.removeItem(ACCESS_CACHE_KEY);
  window.accountLock = "auth";
  window.isAppAdmin = false;
  rememberPlan(null);
  toggleAdminNav(false);
  renderAccountSummary(null, null);
  showSection("auth");
}

async function savePrice() {
  const plans = {
    starter: {
      monthly: Number(document.getElementById("starterMonthly").value),
      annual: Number(document.getElementById("starterAnnual").value),
    },
    professional: {
      monthly: Number(document.getElementById("professionalMonthly").value),
      annual: Number(document.getElementById("professionalAnnual").value),
    },
    business: {
      monthly: Number(document.getElementById("businessMonthly").value),
      annual: Number(document.getElementById("businessAnnual").value),
    },
  };
  const status = document.getElementById("priceStatus");
  const amounts = Object.values(plans).flatMap((plan) => [plan.monthly, plan.annual]);
  if (amounts.some((amount) => !(amount >= 100))) {
    if (status) status.textContent = "Each paid price must be at least ₦100.";
    return;
  }
  await firestoreDb.collection("config").doc("plans").set({ plans, updatedAt: Date.now() });
  window.planCatalog = planCatalog({ plans });
  if (status) status.textContent = "Prices saved.";
}

async function loadAdmin() {
  const catalog = await loadPlanCatalog();
  const fields = {
    starterMonthly: catalog.starter.monthly,
    starterAnnual: catalog.starter.annual,
    professionalMonthly: catalog.professional.monthly,
    professionalAnnual: catalog.professional.annual,
    businessMonthly: catalog.business.monthly,
    businessAnnual: catalog.business.annual,
  };
  Object.keys(fields).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = fields[id];
  });
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
  const history = Array.isArray(client.paymentHistory) ? client.paymentHistory : [];
  const payments = document.getElementById("reviewPayments");
  if (payments) {
    payments.textContent = history.length
      ? history.slice().reverse().map((payment) => `${formatNaira(payment.amount)} · ${payment.planId || "plan"} · ${payment.cycle || ""}`).join("\n")
      : "No Paystack payments recorded on this account.";
  }
}

async function updateReviewedClient(status) {
  const panel = document.getElementById("clientReview");
  const uid = panel?.dataset.uid;
  if (!uid) return;
  const ref = firestoreDb.collection("users").doc(uid);
  const snap = await ref.get();
  const current = snap.data() || {};
  const pricingDays = 30;
  const patch = {
    status,
    reviewNote: document.getElementById("reviewNote").value.trim(),
    reviewedAt: Date.now(),
  };
  if (status === "subscriber") {
    patch.plan = document.getElementById("grantPlan")?.value || "professional";
    patch.billingCycle = "monthly";
    patch.paidUntil = extendPaidUntil(current.paidUntil, Date.now(), pricingDays);
  }
  if (status === "free" || status === "pending" || status === "suspended") {
    patch.paidUntil = 0;
    if (status === "free") patch.plan = "free";
  }
  await ref.update(patch);
  showNotice(status === "free" ? "Client is on Free" : status === "subscriber" ? "Subscription granted" : status === "suspended" ? "Client suspended" : "Client set to pending");
  await loadAdmin();
  const updated = (await ref.get()).data();
  openClientReview({ id: uid, ...updated });
}

function bindAccountEvents() {
  if (bindAccountEvents.done) return;
  bindAccountEvents.done = true;
  document.getElementById("registerBtn")?.addEventListener("click", onRegister);
  document.getElementById("signInBtn")?.addEventListener("click", onSignIn);
  document.getElementById("cycleMonthly")?.addEventListener("click", () => {
    window.billingCycle = "monthly";
    document.getElementById("cycleMonthly")?.classList.add("active");
    document.getElementById("cycleAnnual")?.classList.remove("active");
    showSubscribe().catch((error) => alert(error.message));
  });
  document.getElementById("cycleAnnual")?.addEventListener("click", () => {
    window.billingCycle = "annual";
    document.getElementById("cycleAnnual")?.classList.add("active");
    document.getElementById("cycleMonthly")?.classList.remove("active");
    showSubscribe().catch((error) => alert(error.message));
  });
  document.getElementById("upgradePlanBtn")?.addEventListener("click", () => showSection("subscribe"));
  document.getElementById("openAdminBtn")?.addEventListener("click", () => showSection("admin"));
  document.getElementById("renewBannerBtn")?.addEventListener("click", () => startPaystack());
  document.getElementById("settingsRenewBtn")?.addEventListener("click", () => startPaystack());
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
  document.getElementById("suspendBtn")?.addEventListener("click", () => {
    updateReviewedClient("suspended").catch((error) => alert(error.message));
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
