const {
  parseFirebaseConfig,
  sanitizeWorkspaceId,
  mergeReceiptFromCloud,
  pickListByUpdatedAt,
  mergeSettingsFromCloud,
} = require("./firebase-sync.js");

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.error("FAIL", name, { actual, expected });
  }
}

check(
  "parses JS-style firebase config",
  parseFirebaseConfig("const firebaseConfig = { apiKey: 'A', projectId: 'p', };"),
  { apiKey: "A", projectId: "p" },
);

check("sanitizes workspace id", sanitizeWorkspaceId("  shop-001  "), "shop-001");

let threw = false;
try {
  sanitizeWorkspaceId("bad/id");
} catch {
  threw = true;
}
check("rejects slash in workspace id", threw, true);

check(
  "keeps newer local receipt and its signature",
  mergeReceiptFromCloud(
    { receiptNo: "R1", amount: 20, updatedAt: 20, signature: "sig" },
    { receiptNo: "R1", amount: 10, updatedAt: 10 },
  ),
  { receiptNo: "R1", amount: 20, updatedAt: 20, signature: "sig" },
);

check(
  "takes newer cloud receipt but keeps local signature",
  mergeReceiptFromCloud(
    { receiptNo: "R1", amount: 10, updatedAt: 10, signature: "sig" },
    { receiptNo: "R1", amount: 30, updatedAt: 30 },
  ),
  { receiptNo: "R1", amount: 30, updatedAt: 30, signature: "sig" },
);

check(
  "unions estates when both lack timestamps",
  pickListByUpdatedAt(
    [{ id: 1, name: "Local" }],
    0,
    [{ id: 2, name: "Cloud" }],
    0,
  ),
  [{ id: 2, name: "Cloud" }, { id: 1, name: "Local" }],
);

check(
  "prefers newer cloud settings without taking cloud images",
  mergeSettingsFromCloud(
    { businessName: "Old", logo: "local-logo", updatedAt: 1 },
    { businessName: "New", logo: "cloud-logo", updatedAt: 9 },
  ),
  { businessName: "New", logo: "local-logo", updatedAt: 9, signature: "" },
);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("firebase-sync checks passed");
