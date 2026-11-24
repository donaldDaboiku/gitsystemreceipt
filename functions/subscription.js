function isAccessAllowed(account, now) {
  if (!account) return false;
  const time = Number(now) || Date.now();
  if (account.status === "free") return true;
  if (account.status === "subscriber") return Number(account.paidUntil) > time;
  return false;
}

function extendPaidUntil(currentPaidUntil, now, periodDays) {
  const days = Math.min(366, Math.max(1, Number(periodDays) || 30));
  const start = Math.max(Number(currentPaidUntil) || 0, Number(now) || Date.now());
  return start + days * 24 * 60 * 60 * 1000;
}

function accountLabel(account, now) {
  const time = Number(now) || Date.now();
  if (!account) return "Pending";
  if (account.status === "free") return "Free";
  if (account.status === "subscriber" && Number(account.paidUntil) > time) return "Subscriber";
  if (account.status === "subscriber") return "Expired";
  return "Pending";
}

function applySuccessfulPayment(account, reference, periodDays, now) {
  const base = account && typeof account === "object" ? account : {};
  if (reference && base.lastReference === reference) {
    return { account: base, changed: false };
  }
  return {
    changed: true,
    account: {
      ...base,
      status: "subscriber",
      paidUntil: extendPaidUntil(base.paidUntil, now, periodDays),
      lastReference: reference || base.lastReference || "",
      lastPaidAt: Number(now) || Date.now(),
    },
  };
}

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG");
}

module.exports = {
  isAccessAllowed,
  extendPaidUntil,
  accountLabel,
  applySuccessfulPayment,
  formatNaira,
};
