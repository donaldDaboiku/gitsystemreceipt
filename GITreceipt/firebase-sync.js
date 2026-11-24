const FIREBASE_SYNC_KEY = "firebaseSync";
const ESTATES_UPDATED_AT_KEY = "estatesUpdatedAt";

let firebaseSync = {
  enabled: false,
  configJson: "",
  workspaceId: "",
  email: "",
};

let firestoreDb = null;

function loadFirebaseSyncSettings() {
  const saved = localStorage.getItem(FIREBASE_SYNC_KEY);
  if (!saved) return;
  try {
    firebaseSync = { ...firebaseSync, ...JSON.parse(saved) };
  } catch (error) {
    console.error("Error parsing Firebase settings", error);
  }
}

function saveFirebaseSyncSettings() {
  localStorage.setItem(FIREBASE_SYNC_KEY, JSON.stringify({
    enabled: firebaseSync.enabled,
    configJson: firebaseSync.configJson,
    workspaceId: firebaseSync.workspaceId,
    email: firebaseSync.email || "",
  }));
}

function fillFirebaseSettingsForm() {
  const configEl = document.getElementById("firebaseConfigJson");
  const emailEl = document.getElementById("firebaseEmail");
  if (configEl) configEl.value = firebaseSync.configJson || "";
  if (emailEl && !emailEl.value) emailEl.value = firebaseSync.email || "";
  setFirebaseStatus(
    firestoreDb ? `Signed in as ${firebaseSync.email || "your account"}` : "Not signed in",
    firestoreDb ? "ok" : "",
  );
}

function setFirebaseStatus(message, kind) {
  const el = document.getElementById("firebaseStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

function parseFirebaseConfig(raw) {
  const text = (raw || "").trim();
  if (!text) throw new Error("Paste your Firebase web config");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Invalid Firebase config");
    const jsonish = match[0]
      .replace(/\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/(['"])?([a-zA-Z0-9_]+)\1\s*:/g, '"$2":')
      .replace(/'/g, '"');
    try {
      config = JSON.parse(jsonish);
    } catch {
      throw new Error("Could not parse Firebase config. Paste the JSON from Project settings.");
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Firebase config must be a JSON object");
  }
  if (!config.apiKey || !config.projectId) {
    throw new Error("Config must include apiKey and projectId");
  }
  return config;
}

function sanitizeWorkspaceId(id) {
  const trimmed = String(id || "").trim();
  if (trimmed.length < 8) throw new Error("Workspace ID must be at least 8 characters");
  if (trimmed.length > 64) throw new Error("Workspace ID must be 64 characters or fewer");
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("Workspace ID can only use letters, numbers, hyphen, and underscore");
  }
  return trimmed;
}

function isNewerThan(left, right) {
  return (Number(left) || 0) > (Number(right) || 0);
}

function mergeReceiptFromCloud(local, cloud) {
  if (!cloud || !cloud.receiptNo) return local || null;
  if (local && isNewerThan(local.updatedAt, cloud.updatedAt)) return local;
  return {
    ...cloud,
    signature: (local && local.signature) || cloud.signature || "",
  };
}

function pickListByUpdatedAt(localList, localAt, cloudList, cloudAt) {
  const local = Array.isArray(localList) ? localList : [];
  const cloud = Array.isArray(cloudList) ? cloudList : [];
  if (isNewerThan(cloudAt, localAt)) return cloud;
  if (isNewerThan(localAt, cloudAt)) return local;
  if (!local.length) return cloud;
  if (!cloud.length) return local;
  if (!(Number(localAt) || 0) && !(Number(cloudAt) || 0)) {
    const map = new Map();
    for (const item of cloud) {
      if (item && item.id != null) map.set(item.id, item);
    }
    for (const item of local) {
      if (item && item.id != null) map.set(item.id, item);
    }
    return [...map.values()];
  }
  return local;
}

const RECEIPT_DELETIONS_KEY = "receiptDeletions";
const ESTATE_DELETIONS_KEY = "estateDeletions";

function loadJsonMap(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadDeletions() {
  return loadJsonMap(RECEIPT_DELETIONS_KEY);
}

function saveDeletions(map) {
  localStorage.setItem(RECEIPT_DELETIONS_KEY, JSON.stringify(map));
}

function recordLocalDeletion(receiptNo) {
  if (!receiptNo) return;
  const map = loadDeletions();
  map[String(receiptNo)] = Date.now();
  saveDeletions(map);
}

function loadEstateDeletions() {
  return loadJsonMap(ESTATE_DELETIONS_KEY);
}

function recordEstateDeletion(id) {
  if (id == null) return;
  const map = loadEstateDeletions();
  map[String(id)] = Date.now();
  localStorage.setItem(ESTATE_DELETIONS_KEY, JSON.stringify(map));
}

function mergeDeletionMaps(left, right) {
  const out = { ...(left || {}) };
  for (const [key, value] of Object.entries(right || {})) {
    out[key] = Math.max(Number(out[key]) || 0, Number(value) || 0);
  }
  return out;
}

function preferEstate(current, incoming) {
  if (!current) return incoming;
  if (isNewerThan(incoming.updatedAt, current.updatedAt)) return incoming;
  if (isNewerThan(current.updatedAt, incoming.updatedAt)) return current;
  return incoming;
}

function mergeEstateLists(localList, cloudList) {
  const map = new Map();
  for (const item of cloudList || []) {
    if (item && item.id != null) map.set(item.id, item);
  }
  for (const item of localList || []) {
    if (item && item.id != null) map.set(item.id, preferEstate(map.get(item.id), item));
  }
  return [...map.values()];
}

function applyEstateDeletions(list, deletions) {
  return (list || []).filter((item) => {
    if (!item || item.id == null) return false;
    const deletedAt = Number((deletions || {})[String(item.id)] || 0);
    if (!deletedAt) return true;
    return isNewerThan(item.updatedAt, deletedAt);
  });
}

function mergeSettingsFromCloud(local, cloud) {
  const base = local && typeof local === "object" ? local : {};
  if (!cloud || typeof cloud !== "object") return base;
  if (!isNewerThan(cloud.updatedAt, base.updatedAt)) {
    return {
      ...base,
      logo: base.logo || "",
      signature: base.signature || "",
    };
  }
  const { updatedAt, logo, signature, ...cloudRest } = cloud;
  return {
    ...base,
    ...cloudRest,
    logo: base.logo || "",
    signature: base.signature || "",
    updatedAt,
  };
}

function workspaceDoc() {
  return firestoreDb.collection("workspaces").doc(firebaseSync.workspaceId);
}

function toFirestoreValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripReceiptForCloud(receipt) {
  const copy = { ...receipt };
  delete copy.signature;
  copy.updatedAt = receipt.updatedAt || Date.now();
  return toFirestoreValue(copy);
}

async function ensureFirebaseApp(config) {
  if (firebase.apps.length) {
    const current = firebase.app().options;
    if (current.projectId === config.projectId && current.apiKey === config.apiKey) {
      return;
    }
    await firebase.app().delete();
  }
  firebase.initializeApp(config);
}

async function connectFirebase(options = {}) {
  const showAlerts = options.alert !== false;
  const mode = options.mode;
  loadFirebaseSyncSettings();

  if (typeof firebaseProjectReady !== "function" || !firebaseProjectReady()) {
    firestoreDb = null;
    setFirebaseStatus("Cloud project is not configured", "error");
    return false;
  }

  if (typeof firebase === "undefined" || typeof firebase.auth !== "function") {
    firestoreDb = null;
    setFirebaseStatus("Firebase SDK not loaded (need internet once to download it)", "error");
    return false;
  }

  try {
    await ensureFirebaseApp(FIREBASE_CONFIG);
    const auth = firebase.auth();
    let user = null;

    if (mode === "signin" || mode === "signup") {
      const email = String(options.email || "").trim();
      const password = String(options.password || "");
      if (!email || password.length < 6) {
        throw new Error("Use an email and a password of at least 6 characters");
      }
      const cred = mode === "signup"
        ? await auth.createUserWithEmailAndPassword(email, password)
        : await auth.signInWithEmailAndPassword(email, password);
      user = cred.user;
    } else {
      user = await new Promise((resolve) => {
        const unsub = auth.onAuthStateChanged((next) => {
          unsub();
          resolve(next || null);
        });
      });
    }

    if (!user) {
      firestoreDb = null;
      firebaseSync.enabled = false;
      saveFirebaseSyncSettings();
      setFirebaseStatus("Not signed in", "");
      if (showAlerts) alert("Sign in before syncing.");
      return false;
    }

    firebaseSync.workspaceId = sanitizeWorkspaceId(user.uid);
    firebaseSync.email = user.email || "";
    firebaseSync.enabled = true;
    saveFirebaseSyncSettings();
    firestoreDb = firebase.firestore();
    setFirebaseStatus(`Signed in as ${firebaseSync.email || "your account"}`, "ok");
    return true;
  } catch (error) {
    firestoreDb = null;
    firebaseSync.enabled = false;
    setFirebaseStatus(error.message || "Could not connect", "error");
    if (mode) throw error;
    if (showAlerts) alert("Firebase sign-in failed: " + error.message);
    return false;
  }
}

async function syncReceiptToCloud(receipt) {
  if (!firestoreDb || !firebaseSync.enabled || !receipt?.receiptNo) return;
  const ref = workspaceDoc().collection("receipts").doc(String(receipt.receiptNo));
  const payload = stripReceiptForCloud(receipt);
  if ((window.currentPlan || "free") !== "free") {
    await ref.set(payload);
    return;
  }
  const usageRef = workspaceDoc().collection("meta").doc("usage");
  await firestoreDb.runTransaction(async (tx) => {
    const usageSnap = await tx.get(usageRef);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const stored = usageSnap.exists ? usageSnap.data() : {};
    let ids = Array.isArray(stored.ids) ? stored.ids.map(String) : [];
    if (stored.year !== year || stored.month !== month) ids = [];
    const id = String(receipt.receiptNo);
    if (!ids.includes(id)) {
      if (ids.length >= 5) throw new Error("Free plan allows 5 receipts this month");
      ids = ids.concat(id);
    }
    tx.set(usageRef, { year, month, ids });
    tx.set(ref, payload);
  });
}

async function deleteReceiptFromCloud(receiptNo) {
  if (!firestoreDb || !firebaseSync.enabled || !receiptNo) return;
  const deletedAt = Number(loadDeletions()[String(receiptNo)] || Date.now());
  await workspaceDoc().collection("deletions").doc(String(receiptNo)).set({
    receiptNo: String(receiptNo),
    deletedAt,
  });
  await workspaceDoc().collection("receipts").doc(String(receiptNo)).delete();
}

async function syncEstatesToCloud(estatesList) {
  if (!firestoreDb || !firebaseSync.enabled) return;
  const updatedAt = Number(localStorage.getItem(ESTATES_UPDATED_AT_KEY)) || Date.now();
  await workspaceDoc().collection("meta").doc("estates").set({
    list: toFirestoreValue(estatesList || []),
    deletions: toFirestoreValue(loadEstateDeletions()),
    updatedAt,
  });
}

async function syncSettingsToCloud(settingsObj) {
  if (!firestoreDb || !firebaseSync.enabled) return;
  const { logo, signature, ...rest } = settingsObj || {};
  await workspaceDoc().collection("meta").doc("settings").set({
    ...toFirestoreValue(rest),
    updatedAt: settingsObj?.updatedAt || Date.now(),
  });
}

async function pullFromCloud() {
  if (!firestoreDb || !firebaseSync.enabled) return { receipts: 0 };

  const delSnap = await workspaceDoc().collection("deletions").get();
  const deletions = loadDeletions();
  delSnap.forEach((doc) => {
    const data = doc.data() || {};
    const receiptNo = data.receiptNo || doc.id;
    if (!receiptNo) return;
    deletions[String(receiptNo)] = Math.max(
      Number(deletions[String(receiptNo)]) || 0,
      Number(data.deletedAt) || 0,
    );
  });
  saveDeletions(deletions);

  const receiptsSnap = await workspaceDoc().collection("receipts").get();
  let receipts = 0;
  for (const doc of receiptsSnap.docs) {
    const data = doc.data();
    if (!data?.receiptNo) continue;
    const deletedAt = Number(deletions[String(data.receiptNo)] || 0);
    const local = await getReceipt(data.receiptNo);
    const blocked = deletedAt && deletedAt >= (Number(data.updatedAt) || 0)
      && (!local || deletedAt >= (Number(local.updatedAt) || 0));
    if (blocked) {
      if (local) await deleteReceiptFromIndexedDB(data.receiptNo);
      continue;
    }
    const merged = mergeReceiptFromCloud(local, data);
    if (merged && merged !== local) {
      await saveReceiptToIndexedDB(merged);
    }
    receipts += 1;
  }

  for (const [receiptNo, deletedAt] of Object.entries(deletions)) {
    const local = await getReceipt(receiptNo);
    if (local && Number(deletedAt) >= (Number(local.updatedAt) || 0)) {
      await deleteReceiptFromIndexedDB(receiptNo);
    }
  }

  const estatesSnap = await workspaceDoc().collection("meta").doc("estates").get();
  if (estatesSnap.exists) {
    const cloud = estatesSnap.data() || {};
    const localList = JSON.parse(localStorage.getItem("estates") || "[]");
    const deletionsMap = mergeDeletionMaps(loadEstateDeletions(), cloud.deletions || {});
    localStorage.setItem(ESTATE_DELETIONS_KEY, JSON.stringify(deletionsMap));
    const next = applyEstateDeletions(mergeEstateLists(localList, cloud.list), deletionsMap);
    localStorage.setItem("estates", JSON.stringify(next));
    const newest = Math.max(
      Number(localStorage.getItem(ESTATES_UPDATED_AT_KEY) || 0),
      Number(cloud.updatedAt) || 0,
    );
    localStorage.setItem(ESTATES_UPDATED_AT_KEY, String(newest || Date.now()));
  }

  const settingsSnap = await workspaceDoc().collection("meta").doc("settings").get();
  if (settingsSnap.exists) {
    const local = JSON.parse(localStorage.getItem("businessSettings") || "{}");
    const merged = mergeSettingsFromCloud(local, settingsSnap.data() || {});
    localStorage.setItem("businessSettings", JSON.stringify(merged));
  }

  return { receipts };
}

async function pushAllToCloud() {
  if (!firestoreDb || !firebaseSync.enabled) return { receipts: 0 };
  const deletions = loadDeletions();
  for (const [receiptNo, deletedAt] of Object.entries(deletions)) {
    await workspaceDoc().collection("deletions").doc(String(receiptNo)).set({
      receiptNo: String(receiptNo),
      deletedAt,
    });
    await workspaceDoc().collection("receipts").doc(String(receiptNo)).delete();
  }
  const receipts = await getAllReceipts();
  let pushed = 0;
  for (const receipt of receipts) {
    if (deletions[String(receipt.receiptNo)]) continue;
    try {
      await syncReceiptToCloud(receipt);
      pushed += 1;
    } catch (error) {
      console.warn("Skipped cloud receipt", receipt.receiptNo, error);
    }
  }
  const savedEstates = JSON.parse(localStorage.getItem("estates") || "[]");
  await syncEstatesToCloud(savedEstates);
  const savedSettings = JSON.parse(localStorage.getItem("businessSettings") || "{}");
  await syncSettingsToCloud(savedSettings);
  return { receipts: pushed };
}

async function syncBothWays() {
  const pulled = await pullFromCloud();
  const pushed = await pushAllToCloud();
  return { pulled, pushed };
}

function refreshViewsAfterSync() {
  if (typeof loadSettings === "function") loadSettings();
  if (typeof loadEstates === "function") loadEstates();
  if (typeof loadHistory === "function") loadHistory();
  if (typeof loadDashboard === "function") loadDashboard();
}

async function saveAndConnectFirebase(mode) {
  firebaseSync.configJson = document.getElementById("firebaseConfigJson")?.value.trim() || "";
  firebaseSync.email = document.getElementById("firebaseEmail")?.value.trim() || "";
  saveFirebaseSyncSettings();

  const connected = await connectFirebase({ alert: true, mode: mode || "signin" });
  if (!connected) return;

  try {
    setFirebaseStatus("Syncing your account...", "ok");
    const { pulled, pushed } = await syncBothWays();
    refreshViewsAfterSync();
    setFirebaseStatus(`Signed in. Synced ${Math.max(pushed.receipts, pulled.receipts)} receipts.`, "ok");
    if (typeof showNotice === "function") showNotice("Cloud sync is on for this account");
  } catch (error) {
    console.error(error);
    setFirebaseStatus(error.message || "Sync failed", "error");
    alert("Signed in, but sync failed: " + error.message + "\nPublish the Firestore rules from Settings, and enable Cloud Firestore.");
  }
}

async function signOutFirebase() {
  try {
    if (typeof firebase !== "undefined" && firebase.apps && firebase.apps.length) {
      await firebase.auth().signOut();
    }
  } catch (error) {
    console.warn("Sign out failed", error);
  }
  firestoreDb = null;
  firebaseSync.enabled = false;
  firebaseSync.workspaceId = "";
  saveFirebaseSyncSettings();
  const passEl = document.getElementById("firebasePassword");
  if (passEl) passEl.value = "";
  setFirebaseStatus("Signed out", "");
}

async function syncNow() {
  const connected = await connectFirebase({ alert: true });
  if (!connected) {
    alert("Connect Firebase first in Settings.");
    return;
  }
  try {
    setFirebaseStatus("Syncing...", "ok");
    const { pulled } = await syncBothWays();
    refreshViewsAfterSync();
    setFirebaseStatus(`Sync complete (${pulled.receipts} receipts in cloud).`, "ok");
    if (typeof showNotice === "function") showNotice("Sync complete");
  } catch (error) {
    console.error(error);
    setFirebaseStatus(error.message || "Sync failed", "error");
    alert("Sync failed: " + error.message);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseFirebaseConfig,
    sanitizeWorkspaceId,
    isNewerThan,
    mergeReceiptFromCloud,
    pickListByUpdatedAt,
    mergeSettingsFromCloud,
    mergeEstateLists,
    mergeDeletionMaps,
    applyEstateDeletions,
  };
}
