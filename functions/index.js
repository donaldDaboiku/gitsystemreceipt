const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { applySuccessfulPayment } = require("./subscription");

initializeApp();

const PAYSTACK_SECRET = defineSecret("PAYSTACK_SECRET");
const region = "us-central1";

function db() {
  return getFirestore();
}

async function readPricing() {
  const snap = await db().collection("config").doc("pricing").get();
  if (!snap.exists) {
    throw new Error("Set the subscription price on the admin page first");
  }
  const data = snap.data() || {};
  const amount = Number(data.amount);
  const periodDays = Number(data.periodDays);
  if (!(amount >= 100) || !(periodDays >= 1)) {
    throw new Error("Subscription price is incomplete");
  }
  return { amount, periodDays: Math.round(periodDays) };
}

async function userFromRequest(req) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new Error("Sign in required");
  return getAuth().verifyIdToken(token);
}

async function paystack(secret, path, method, body) {
  const response = await fetch("https://api.paystack.co" + path, {
    method,
    headers: {
      Authorization: "Bearer " + secret,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.status === false) {
    throw new Error(data.message || "Paystack request failed");
  }
  return data;
}

async function grantPayment(reference, secret) {
  const paymentRef = db().collection("payments").doc(reference);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw new Error("Unknown payment");
  const payment = paymentSnap.data();
  if (payment.applied) return { alreadyApplied: true };

  const verified = await paystack(secret, "/transaction/verify/" + encodeURIComponent(reference), "GET");
  const tx = verified.data || {};
  if (tx.status !== "success") throw new Error("Payment is not successful yet");
  if (Number(tx.amount) !== Number(payment.amountKobo)) throw new Error("Payment amount does not match");
  if ((tx.metadata && tx.metadata.uid) !== payment.uid) throw new Error("Payment does not match this account");

  const userRef = db().collection("users").doc(payment.uid);
  let alreadyApplied = false;
  await db().runTransaction(async (transaction) => {
    const freshPayment = await transaction.get(paymentRef);
    if (!freshPayment.exists) throw new Error("Unknown payment");
    if (freshPayment.data().applied) {
      alreadyApplied = true;
      return;
    }
    const userSnap = await transaction.get(userRef);
    const result = applySuccessfulPayment(userSnap.data() || {}, reference, payment.periodDays, Date.now());
    if (result.changed) transaction.set(userRef, result.account, { merge: true });
    transaction.set(paymentRef, { applied: true, appliedAt: Date.now() }, { merge: true });
  });
  return { alreadyApplied };
}

const httpOptions = { region, cors: true, secrets: [PAYSTACK_SECRET], invoker: "public" };

exports.createPayment = onRequest(httpOptions, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("POST only");
    return;
  }
  try {
    const user = await userFromRequest(req);
    const pricing = await readPricing();
    const amountKobo = Math.round(pricing.amount * 100);
    const callbackUrl = typeof req.body?.callbackUrl === "string" ? req.body.callbackUrl : "";
    const created = await paystack(PAYSTACK_SECRET.value(), "/transaction/initialize", "POST", {
      email: user.email,
      amount: amountKobo,
      currency: "NGN",
      callback_url: callbackUrl || undefined,
      metadata: { uid: user.uid },
    });
    const reference = created.data.reference;
    await db().collection("payments").doc(reference).set({
      uid: user.uid,
      amountKobo,
      periodDays: pricing.periodDays,
      createdAt: Date.now(),
      applied: false,
    });
    res.json({ authorization_url: created.data.authorization_url, reference });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not start payment" });
  }
});

exports.verifyPayment = onRequest(httpOptions, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("POST only");
    return;
  }
  try {
    const user = await userFromRequest(req);
    const reference = String(req.body?.reference || "");
    if (!reference) throw new Error("Missing payment reference");
    const paymentSnap = await db().collection("payments").doc(reference).get();
    if (!paymentSnap.exists || paymentSnap.data().uid !== user.uid) {
      throw new Error("Payment not found for this account");
    }
    await grantPayment(reference, PAYSTACK_SECRET.value());
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not verify payment" });
  }
});

exports.paystackWebhook = onRequest(
  { region, cors: false, secrets: [PAYSTACK_SECRET], invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("POST only");
      return;
    }
    const crypto = require("crypto");
    const signature = req.get("x-paystack-signature") || "";
    const digest = crypto.createHmac("sha512", PAYSTACK_SECRET.value()).update(req.rawBody).digest("hex");
    if (signature !== digest) {
      res.status(401).send("Invalid signature");
      return;
    }
    const event = req.body || {};
    if (event.event !== "charge.success") {
      res.status(200).send("ignored");
      return;
    }
    try {
      await grantPayment(event.data.reference, PAYSTACK_SECRET.value());
      res.status(200).send("ok");
    } catch (error) {
      console.error(error);
      res.status(400).send(error.message || "failed");
    }
  },
);
