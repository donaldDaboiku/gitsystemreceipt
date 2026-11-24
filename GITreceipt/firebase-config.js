// One Firebase project for every client. Fill this in before you ship the app.
// adminEmail must be lowercase and must match isAdmin() in ../firestore.rules.
const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

const APP_ADMIN_EMAIL = "owner@example.com";
const FUNCTION_REGION = "us-central1";

function firebaseProjectReady() {
  return Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

function isAdminEmail(email) {
  return String(email || "").trim().toLowerCase() === String(APP_ADMIN_EMAIL || "").trim().toLowerCase();
}
