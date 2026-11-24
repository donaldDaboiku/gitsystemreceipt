const PLAN_CATALOG = {
  free: { id: "free", name: "Free", monthly: 0, annual: 0, receiptLimit: 5 },
  starter: { id: "starter", name: "Starter", monthly: 1500, annual: 15000, receiptLimit: 0 },
  professional: { id: "professional", name: "Professional", monthly: 2500, annual: 25000, receiptLimit: 0 },
  business: { id: "business", name: "Business", monthly: 5000, annual: 50000, receiptLimit: 0 },
};

function planCatalog(stored) {
  const catalog = JSON.parse(JSON.stringify(PLAN_CATALOG));
  const plans = stored && stored.plans;
  if (!plans) return catalog;
  Object.keys(catalog).forEach((id) => {
    const row = plans[id];
    if (!row) return;
    if (id !== "free" && Number(row.monthly) >= 100) catalog[id].monthly = Number(row.monthly);
    if (id !== "free" && Number(row.annual) >= 100) catalog[id].annual = Number(row.annual);
  });
  return catalog;
}

function billingDays(cycle) {
  return cycle === "annual" ? 365 : 30;
}

function planQuote(catalog, planId, cycle) {
  const plan = catalog[planId];
  const normalized = cycle === "annual" ? "annual" : "monthly";
  if (!plan || planId === "free") return null;
  const amount = normalized === "annual" ? Number(plan.annual) : Number(plan.monthly);
  if (!(amount >= 100)) return null;
  return { planId, cycle: normalized, amount, periodDays: billingDays(normalized) };
}

function paidPlanActive(account, now) {
  if (!account || account.status !== "subscriber") return false;
  return Number(account.paidUntil) > (Number(now) || Date.now());
}

function effectivePlan(account, now) {
  if (!account) return "none";
  if (account.status === "pending" || account.status === "suspended" || account.status === "cancelled") return "none";
  if (paidPlanActive(account, now)) return account.plan || "starter";
  if (account.status === "free" || account.status === "subscriber") return "free";
  return "none";
}

function isAccessAllowed(account, now) {
  return effectivePlan(account, now) !== "none";
}

function receiptLimit(planId) {
  if (planId === "free") return 5;
  if (planId === "none") return 0;
  return Infinity;
}

function canUsePaidTools(planId) {
  return planId === "starter" || planId === "professional" || planId === "business";
}

function countReceiptsInMonth(receipts, now) {
  const time = new Date(Number(now) || Date.now());
  const prefix = time.getFullYear() + "-" + String(time.getMonth() + 1).padStart(2, "0");
  return (receipts || []).filter((receipt) => String(receipt && receipt.paymentDate || "").startsWith(prefix)).length;
}

function extendPaidUntil(currentPaidUntil, now, periodDays) {
  const days = Math.min(366, Math.max(1, Number(periodDays) || 30));
  const start = Math.max(Number(currentPaidUntil) || 0, Number(now) || Date.now());
  return start + days * 24 * 60 * 60 * 1000;
}

function accountLabel(account, now) {
  const time = Number(now) || Date.now();
  if (!account) return "Pending";
  if (account.status === "suspended") return "Suspended";
  if (account.status === "cancelled") return "Cancelled";
  if (account.status === "free") return "Free";
  if (paidPlanActive(account, time)) {
    const plan = PLAN_CATALOG[account.plan];
    return plan ? plan.name : "Subscriber";
  }
  if (account.status === "subscriber") return "Expired";
  return "Pending";
}

function applySuccessfulPayment(account, reference, periodDays, now, extra) {
  const base = account && typeof account === "object" ? account : {};
  const details = extra && typeof extra === "object" ? extra : {};
  if (reference && base.lastReference === reference) {
    return { account: base, changed: false };
  }
  const history = Array.isArray(base.paymentHistory) ? base.paymentHistory.slice(-19) : [];
  if (reference) {
    history.push({
      reference,
      amount: Number(details.amount) || 0,
      planId: details.planId || base.plan || "starter",
      cycle: details.cycle || "monthly",
      at: Number(now) || Date.now(),
    });
  }
  return {
    changed: true,
    account: {
      ...base,
      status: "subscriber",
      plan: details.planId || base.plan || "starter",
      billingCycle: details.cycle || base.billingCycle || "monthly",
      amount: Number(details.amount) || base.amount || 0,
      paidUntil: extendPaidUntil(base.paidUntil, now, periodDays),
      lastReference: reference || base.lastReference || "",
      lastPaidAt: Number(now) || Date.now(),
      paymentHistory: history,
    },
  };
}

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PLAN_CATALOG,
    planCatalog,
    billingDays,
    planQuote,
    paidPlanActive,
    effectivePlan,
    isAccessAllowed,
    receiptLimit,
    canUsePaidTools,
    countReceiptsInMonth,
    extendPaidUntil,
    accountLabel,
    applySuccessfulPayment,
    formatNaira,
  };
}
