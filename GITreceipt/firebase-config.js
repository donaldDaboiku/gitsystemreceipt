// One Firebase project for every client.
// APP_ADMIN_EMAIL must be lowercase and must match isAdmin() in ../firestore.rules.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBOxTmB-__8uMc7If1CJMw1AeDooYiTI9A",
  authDomain: "gitsystemreceipt.firebaseapp.com",
  projectId: "gitsystemreceipt",
  storageBucket: "gitsystemreceipt.firebasestorage.app",
  messagingSenderId: "443676222911",
  appId: "1:443676222911:web:05d1122de579f347922d0a",
  measurementId: "G-7TWJJM36P5",
};

const APP_ADMIN_EMAIL = "gitsystemng@gmail.com";
const FUNCTION_REGION = "us-central1";

function firebaseProjectReady() {
  return Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

function isAdminEmail(email) {
  return String(email || "").trim().toLowerCase() === String(APP_ADMIN_EMAIL || "").trim().toLowerCase();
}
