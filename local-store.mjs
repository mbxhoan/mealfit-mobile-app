const DB_NAME = "mealfit-prototype";
const DB_VERSION = 3;
let databasePromise;

const clone = value => JSON.parse(JSON.stringify(value));

export function openLocalDb() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("photos")) {
        const photos = db.createObjectStore("photos", { keyPath: "id" });
        photos.createIndex("orderId", "orderId", { unique: false });
      }
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state", { keyPath: "key" });
      if (!db.objectStoreNames.contains("outbox")) {
        const outbox = db.createObjectStore("outbox", { keyPath: "id" });
        outbox.createIndex("entityKey", "entityKey", { unique: false });
        outbox.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("logs")) db.createObjectStore("logs", { keyPath: "id" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error("Không mở được dữ liệu trên thiết bị."));
  });
  return databasePromise;
}

export function shouldRetryInflight(item, now = Date.now()) {
  const startedAt = Number(item?.updatedAt || item?.createdAt);
  return item?.status === "inflight" && Number.isFinite(startedAt) && now - startedAt >= 60_000;
}

export function appLogRetryDelay(attempts) {
  return Math.min(300_000, 1_000 * (2 ** Math.min(Math.max(0, Number(attempts) || 0), 8)));
}

function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Không ghi được dữ liệu trên thiết bị."));
    transaction.onabort = () => reject(transaction.error || new Error("Không ghi được dữ liệu trên thiết bị."));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Before the server became the single source of truth, edits waited in this device's outbox. The new app never writes
// there; it only sends what is left once (see drainLegacyOutbox in app.js) so no earlier edit is lost.
export async function getLegacyOutbox(userId) {
  const db = await openLocalDb();
  const values = await requestValue(db.transaction("outbox", "readonly").objectStore("outbox").getAll());
  return values.filter(item => item.ownerId === userId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteLegacyOutboxItems(ids) {
  const db = await openLocalDb();
  const tx = db.transaction("outbox", "readwrite");
  for (const id of ids) tx.objectStore("outbox").delete(id);
  await complete(tx);
}

export async function enqueueAppLog(log, ownerId) {
  if (!["info", "error"].includes(log?.type)) throw new Error("Loại log không hợp lệ.");
  const db = await openLocalDb();
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").put({
    id: crypto.randomUUID(), ownerId, type: log.type,
    api: String(log.api || "app").slice(0, 120),
    description: String(log.description || "Hoạt động ứng dụng").slice(0, 240),
    details: log.details && typeof log.details === "object" && !Array.isArray(log.details) ? clone(log.details) : {},
    createdAt: Date.now(), status: "queued", attempts: 0, nextAttemptAt: 0
  });
  await complete(tx);
}

export async function nextAppLog(ownerId, now = Date.now()) {
  const db = await openLocalDb();
  const tx = db.transaction("logs", "readwrite");
  const store = tx.objectStore("logs");
  const all = await requestValue(store.getAll());
  for (const item of all) if (shouldRetryInflight(item, now)) { item.status = "queued"; store.put(item); }
  if (all.some(item => item.status === "inflight")) { await complete(tx); return null; }
  const values = all.filter(item => item.ownerId === ownerId).sort((a, b) => a.createdAt - b.createdAt);
  for (const value of values) if (value.type === "info") store.delete(value.id);
  const item = values.find(value => value.type === "error" && value.status === "queued" && Number(value.nextAttemptAt || 0) <= now);
  if (item) { item.status = "inflight"; item.updatedAt = now; store.put(item); }
  await complete(tx);
  return item ? clone(item) : null;
}

export async function ackAppLog(id) {
  const db = await openLocalDb();
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").delete(id);
  await complete(tx);
}

export async function failAppLog(id) {
  const db = await openLocalDb();
  const tx = db.transaction("logs", "readwrite");
  const store = tx.objectStore("logs");
  const item = await requestValue(store.get(id));
  let retryAfter = 1_000;
  if (item) {
    item.attempts = Number(item.attempts || 0) + 1;
    retryAfter = appLogRetryDelay(item.attempts);
    item.status = "queued";
    item.nextAttemptAt = Date.now() + retryAfter;
    store.put(item);
  }
  await complete(tx);
  return retryAfter;
}

export async function getMeta(key) {
  const db = await openLocalDb();
  return (await requestValue(db.transaction("meta", "readonly").objectStore("meta").get(key)))?.value;
}

export async function setMeta(key, value) {
  const db = await openLocalDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ key, value, updatedAt: Date.now() });
  await complete(tx);
}

export async function getOrderPhotos(orderId) {
  const db = await openLocalDb();
  const values = await requestValue(db.transaction("photos", "readonly").objectStore("photos").index("orderId").getAll(orderId));
  return values.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPendingPhotos() {
  const db = await openLocalDb();
  const values = await requestValue(db.transaction("photos", "readonly").objectStore("photos").getAll());
  return values.filter(item => item.syncState === "pending").sort((a, b) => a.createdAt - b.createdAt);
}

export async function putPhoto(photo) {
  const db = await openLocalDb();
  const tx = db.transaction("photos", "readwrite");
  tx.objectStore("photos").put(photo);
  await complete(tx);
}

export async function deletePhoto(id) {
  const db = await openLocalDb();
  const tx = db.transaction("photos", "readwrite");
  tx.objectStore("photos").delete(id);
  await complete(tx);
}
