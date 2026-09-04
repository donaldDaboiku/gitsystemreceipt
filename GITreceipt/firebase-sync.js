const FIREBASE_SYNC_KEY = "firebaseSync";
const ESTATES_UPDATED_AT_KEY = "estatesUpdatedAt";

let firebaseSync = {
  enabled: false,
  configJson: "",
  workspaceId: "",
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
  }));
}

function fillFirebaseSettingsForm() {
  const configEl = document.getElementById("firebaseConfigJson");
  const workspaceEl = document.getElementById("firebaseWorkspaceId");
  if (configEl) configEl.value = firebaseSync.configJson || "";
  if (workspaceEl) workspaceEl.value = firebaseSync.workspaceId || "";
  setFirebaseStatus(firestoreDb ? "Connected" : "Not connected", firestoreDb ? "ok" : "");
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
  loadFirebaseSyncSettings();

  if (!firebaseSync.configJson || !firebaseSync.workspaceId) {
    firestoreDb = null;
    setFirebaseStatus("Not connected", "");
    return false;
  }

  try {
    firebaseSync.workspaceId = sanitizeWorkspaceId(firebaseSync.workspaceId);
  } catch (error) {
    firestoreDb = null;
    setFirebaseStatus(error.message, "error");
    if (showAlerts) alert(error.message);
    return false;
  }

  if (typeof firebase === "undefined") {
    firestoreDb = null;
    setFirebaseStatus("Firebase SDK not loaded (need internet once to download it)", "error");
    return false;
  }

  try {
    const config = parseFirebaseConfig(firebaseSync.configJson);
    await ensureFirebaseApp(config);
    firestoreDb = firebase.firestore();
    firebaseSync.enabled = true;
    saveFirebaseSyncSettings();
    setFirebaseStatus(`Connected to ${config.projectId}`, "ok");
    return true;
  } catch (error) {
    firestoreDb = null;
    firebaseSync.enabled = false;
    setFirebaseStatus(error.message || "Could not connect", "error");
    if (showAlerts) alert("Firebase connect failed: " + error.message);
    return false;
  }
}

async function syncReceiptToCloud(receipt) {
  if (!firestoreDb || !firebaseSync.enabled || !receipt?.receiptNo) return;
  await workspaceDoc().collection("receipts").doc(String(receipt.receiptNo)).set(stripReceiptForCloud(receipt));
}

async function deleteReceiptFromCloud(receiptNo) {
  if (!firestoreDb || !firebaseSync.enabled || !receiptNo) return;
  await workspaceDoc().collection("receipts").doc(String(receiptNo)).delete();
}

async function syncEstatesToCloud(estatesList) {
  if (!firestoreDb || !firebaseSync.enabled) return;
  const updatedAt = Number(localStorage.getItem(ESTATES_UPDATED_AT_KEY)) || Date.now();
  await workspaceDoc().collection("meta").doc("estates").set({
    list: toFirestoreValue(estatesList || []),
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

  const receiptsSnap = await workspaceDoc().collection("receipts").get();
  let receipts = 0;
  for (const doc of receiptsSnap.docs) {
    const data = doc.data();
    if (!data?.receiptNo) continue;
    const local = await getReceipt(data.receiptNo);
    const merged = mergeReceiptFromCloud(local, data);
    if (merged !== local) {
      await saveReceiptToIndexedDB(merged);
    }
    receipts += 1;
  }

  const estatesSnap = await workspaceDoc().collection("meta").doc("estates").get();
  if (estatesSnap.exists) {
    const cloud = estatesSnap.data() || {};
    const localList = JSON.parse(localStorage.getItem("estates") || "[]");
    const localAt = Number(localStorage.getItem(ESTATES_UPDATED_AT_KEY) || 0);
    const next = pickListByUpdatedAt(localList, localAt, cloud.list, cloud.updatedAt);
    localStorage.setItem("estates", JSON.stringify(next));
    if (isNewerThan(cloud.updatedAt, localAt)) {
      localStorage.setItem(ESTATES_UPDATED_AT_KEY, String(cloud.updatedAt));
    }
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
  const receipts = await getAllReceipts();
  for (const receipt of receipts) {
    await syncReceiptToCloud(receipt);
  }
  const savedEstates = JSON.parse(localStorage.getItem("estates") || "[]");
  await syncEstatesToCloud(savedEstates);
  const savedSettings = JSON.parse(localStorage.getItem("businessSettings") || "{}");
  await syncSettingsToCloud(savedSettings);
  return { receipts: receipts.length };
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

async function saveAndConnectFirebase() {
  firebaseSync.configJson = document.getElementById("firebaseConfigJson")?.value.trim() || "";
  firebaseSync.workspaceId = document.getElementById("firebaseWorkspaceId")?.value.trim() || "";
  saveFirebaseSyncSettings();

  const connected = await connectFirebase({ alert: true });
  if (!connected) return;

  try {
    setFirebaseStatus("Uploading local data...", "ok");
    const { pulled, pushed } = await syncBothWays();
    refreshViewsAfterSync();
    setFirebaseStatus(`Connected. Synced ${Math.max(pushed.receipts, pulled.receipts)} receipts.`, "ok");
    alert("Firebase connected. Receipts and categories will sync to the cloud.");
  } catch (error) {
    console.error(error);
    setFirebaseStatus(error.message || "Sync failed", "error");
    alert("Connected, but sync failed: " + error.message + "\nCheck Firestore is enabled and your rules allow this workspace.");
  }
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
    alert("Sync complete.");
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
  };
}
