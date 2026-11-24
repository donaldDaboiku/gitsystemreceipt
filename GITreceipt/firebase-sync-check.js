const {
  parseFirebaseConfig,
  sanitizeWorkspaceId,
  mergeReceiptFromCloud,
  pickListByUpdatedAt,
  mergeSettingsFromCloud,
  mergeEstateLists,
  applyEstateDeletions,
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

check(
  "keeps the newer copy of a category and unions the rest",
  mergeEstateLists(
    [{ id: 1, name: "Local", updatedAt: 5 }, { id: 3, name: "Only local", updatedAt: 1 }],
    [{ id: 1, name: "Cloud", updatedAt: 2 }, { id: 2, name: "Only cloud", updatedAt: 1 }],
  ),
  [
    { id: 1, name: "Local", updatedAt: 5 },
    { id: 2, name: "Only cloud", updatedAt: 1 },
    { id: 3, name: "Only local", updatedAt: 1 },
  ],
);

check(
  "drops a category deleted after it was edited",
  applyEstateDeletions(
    [{ id: 1, name: "A", updatedAt: 5 }, { id: 2, name: "B", updatedAt: 9 }],
    { 1: 8 },
  ),
  [{ id: 2, name: "B", updatedAt: 9 }],
);

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("firebase-sync checks passed");
