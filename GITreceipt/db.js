const DB_NAME = "EstateReceiptDB";
const DB_VERSION = 1;
const STORE_NAME = "receipts";

let db;

function initDB() {

    return new Promise((resolve, reject) => {

        const request =
            indexedDB.open(
                DB_NAME,
                DB_VERSION
            );

        request.onupgradeneeded = function(e){

            db = e.target.result;

            if(
                !db.objectStoreNames.contains(
                    STORE_NAME
                )
            ){

                db.createObjectStore(
                    STORE_NAME,
                    {
                        keyPath:"receiptNo"
                    }
                );
            }
        };

        request.onsuccess = function(e){

            db = e.target.result;

            resolve();
        };

        request.onerror = function(){

            reject(
                "Database failed to open"
            );
        };
    });
}

function saveReceiptToIndexedDB(receipt){

    return new Promise((resolve, reject)=>{

        const tx =
            db.transaction(
                STORE_NAME,
                "readwrite"
            );

        tx.objectStore(STORE_NAME)
            .put(receipt);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function saveReceipt(receipt){
    if (receipt) {
        receipt.updatedAt = Date.now();
    }

    return saveReceiptToIndexedDB(receipt).then(() => {
        if (typeof syncReceiptToCloud === "function") {
            Promise.resolve(syncReceiptToCloud(receipt)).catch((err) => {
                console.warn("Cloud sync failed", err);
            });
        }
    });
}

function getReceipt(receiptNo){

    return new Promise((resolve, reject)=>{

        if (!db) {
            resolve(undefined);
            return;
        }

        const tx =
            db.transaction(
                STORE_NAME,
                "readonly"
            );

        const request =
            tx.objectStore(STORE_NAME)
              .get(receiptNo);

        request.onsuccess =
            () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getAllReceipts(){

    return new Promise((resolve, reject)=>{

        if (!db) {
            resolve([]);
            return;
        }

        const tx =
            db.transaction(
                STORE_NAME,
                "readonly"
            );

        const request =
            tx.objectStore(STORE_NAME)
              .getAll();

        request.onsuccess =
            () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

function deleteReceiptFromIndexedDB(receiptNo){

    return new Promise((resolve)=>{

        const tx =
            db.transaction(
                STORE_NAME,
                "readwrite"
            );

        tx.objectStore(STORE_NAME)
          .delete(receiptNo);

        tx.oncomplete =
            () => resolve();
    });
}

function deleteReceipt(receiptNo){
    if (typeof recordLocalDeletion === "function") {
        recordLocalDeletion(receiptNo);
    }

    return deleteReceiptFromIndexedDB(receiptNo).then(() => {
        if (typeof deleteReceiptFromCloud === "function") {
            Promise.resolve(deleteReceiptFromCloud(receiptNo)).catch((err) => {
                console.warn("Cloud delete failed", err);
            });
        }
    });
}
