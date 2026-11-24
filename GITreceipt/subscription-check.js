const {
  isAccessAllowed,
  extendPaidUntil,
  accountLabel,
  applySuccessfulPayment,
} = require("./subscription.js");

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.error("FAIL", name, { actual, expected });
  }
}

const now = 1_000_000;
check("pending cannot use the app", isAccessAllowed({ status: "pending" }, now), false);
check("free can use the app", isAccessAllowed({ status: "free" }, now), true);
check("subscriber can use the app before expiry", isAccessAllowed({ status: "subscriber", paidUntil: now + 10 }, now), true);
check("expired subscriber is blocked", isAccessAllowed({ status: "subscriber", paidUntil: now - 1 }, now), false);
check("extends from the later of now and the current end", extendPaidUntil(now + 5000, now, 1), now + 5000 + 86400000);
check("labels an expired subscriber", accountLabel({ status: "subscriber", paidUntil: now - 1 }, now), "Expired");

const first = applySuccessfulPayment({ status: "pending", email: "a@b.co" }, "ref-1", 30, now);
check("payment marks the account subscribed", first.changed, true);
check("same reference does not add another period", applySuccessfulPayment(first.account, "ref-1", 30, now).changed, false);
check(
  "a new reference extends the period",
  applySuccessfulPayment(first.account, "ref-2", 30, now).account.paidUntil > first.account.paidUntil,
  true,
);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("subscription checks passed");
