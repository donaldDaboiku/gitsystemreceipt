const FIREBASE_SYNC_KEY = "firebaseSync";

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
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Invalid Firebase config");
    const jsonish = match[0]
      .replace(/\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/(['"])?([a-zA-Z0-9_]+)\1\s*:/g, '"$2":')
      .replace(/'/g, '"');
    try {
      return JSON.parse(jsonish);
    } catch {
      throw new Error("Could not parse Firebase config. Paste the JSON from Project settings.");
    }
  }
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
  copy.updatedAt = Date.now();
  return toFirestoreValue(copy);
}

async function connectFirebase(options = {}) {
  const showAlerts = options.alert !== false;
  loadFirebaseSyncSettings();

  if (!firebaseSync.configJson || !firebaseSync.workspaceId) {
    firestoreDb = null;
    setFirebaseStatus("Not connected", "");
    return false;
  }

  if (firebaseSync.workspaceId.trim().length < 8) {
    firestoreDb = null;
    setFirebaseStatus("Workspace ID must be at least 8 characters", "error");
    if (showAlerts) alert("Workspace ID must be at least 8 characters");
    return false;
  }

  if (typeof firebase === "undefined") {
    firestoreDb = null;
    setFirebaseStatus("Firebase SDK not loaded (need internet once to download it)", "error");
    return false;
  }

  try {
    const config = parseFirebaseConfig(firebaseSync.configJson);
    if (!config.apiKey || !config.projectId) {
      throw new Error("Config must include apiKey and projectId");
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
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
  await workspaceDoc().collection("receipts").doc(receipt.receiptNo).set(stripReceiptForCloud(receipt));
}

async function deleteReceiptFromCloud(receiptNo) {
  if (!firestoreDb || !firebaseSync.enabled || !receiptNo) return;
  await workspaceDoc().collection("receipts").doc(receiptNo).delete();
}

async function syncEstatesToCloud(estatesList) {
  if (!firestoreDb || !firebaseSync.enabled) return;
  await workspaceDoc().collection("meta").doc("estates").set({
    list: toFirestoreValue(estatesList || []),
    updatedAt: Date.now(),
  });
}

async function syncSettingsToCloud(settingsObj) {
  if (!firestoreDb || !firebaseSync.enabled) return;
  const { logo, signature, ...rest } = settingsObj || {};
  await workspaceDoc().collection("meta").doc("settings").set({
    ...toFirestoreValue(rest),
    updatedAt: Date.now(),
  });
}

async function pullFromCloud() {
  if (!firestoreDb || !firebaseSync.enabled) return { receipts: 0 };

  const receiptsSnap = await workspaceDoc().collection("receipts").get();
  let receipts = 0;
  for (const doc of receiptsSnap.docs) {
    const data = doc.data();
    if (!data?.receiptNo) continue;
    await saveReceiptToIndexedDB(data);
    receipts += 1;
  }

  const estatesSnap = await workspaceDoc().collection("meta").doc("estates").get();
  if (estatesSnap.exists) {
    const list = estatesSnap.data().list;
    if (Array.isArray(list)) {
      localStorage.setItem("estates", JSON.stringify(list));
    }
  }

  const settingsSnap = await workspaceDoc().collection("meta").doc("settings").get();
  if (settingsSnap.exists) {
    const cloudSettings = settingsSnap.data() || {};
    delete cloudSettings.updatedAt;
    const local = JSON.parse(localStorage.getItem("businessSettings") || "{}");
    localStorage.setItem("businessSettings", JSON.stringify({
      ...local,
      ...cloudSettings,
      logo: local.logo || "",
      signature: local.signature || "",
    }));
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

async function saveAndConnectFirebase() {
  firebaseSync.configJson = document.getElementById("firebaseConfigJson")?.value.trim() || "";
  firebaseSync.workspaceId = document.getElementById("firebaseWorkspaceId")?.value.trim() || "";
  saveFirebaseSyncSettings();

  const connected = await connectFirebase({ alert: true });
  if (!connected) return;

  try {
    setFirebaseStatus("Uploading local data...", "ok");
    const pushed = await pushAllToCloud();
    const pulled = await pullFromCloud();
    if (typeof loadSettings === "function") loadSettings();
    if (typeof loadEstates === "function") loadEstates();
    if (typeof loadHistory === "function") loadHistory();
    if (typeof loadDashboard === "function") loadDashboard();
    setFirebaseStatus(`Connected. Synced ${Math.max(pushed.receipts, pulled.receipts)} receipts.`, "ok");
    alert("Firebase connected. Receipts and categories will sync to the cloud.");
  } catch (error) {
    console.error(error);
    setFirebaseStatus(error.message || "Sync failed", "error");
    alert("Connected, but sync failed: " + error.message + "\nCheck Firestore is enabled and your rules allow this workspace.");
  }
}

async function syncNow() {
  const connected = firestoreDb || await connectFirebase({ alert: true });
  if (!connected) {
    alert("Connect Firebase first in Settings.");
    return;
  }
  try {
    setFirebaseStatus("Syncing...", "ok");
    await pushAllToCloud();
    const pulled = await pullFromCloud();
    if (typeof loadSettings === "function") loadSettings();
    if (typeof loadEstates === "function") loadEstates();
    if (typeof loadHistory === "function") loadHistory();
    if (typeof loadDashboard === "function") loadDashboard();
    setFirebaseStatus(`Sync complete (${pulled.receipts} receipts in cloud).`, "ok");
    alert("Sync complete.");
  } catch (error) {
    console.error(error);
    setFirebaseStatus(error.message || "Sync failed", "error");
    alert("Sync failed: " + error.message);
  }
}
