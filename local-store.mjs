const DB_NAME = "mealfit-prototype";
const DB_VERSION = 2;
let databasePromise;

const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stateKey = userId => `state:${userId || "anonymous"}`;
const keyOf = (userId, type, id) => `${userId || "anonymous"}:${type}:${id}`;

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

export async function readState(fallback, userId) {
  const db = await openLocalDb();
  const record = await requestValue(db.transaction("state", "readonly").objectStore("state").get(stateKey(userId)));
  return record?.value ? clone(record.value) : clone(fallback);
}

export async function writeStateSnapshot(value, userId) {
  const db = await openLocalDb();
  const tx = db.transaction("state", "readwrite");
  tx.objectStore("state").put({ key: stateKey(userId), value: clone(value), updatedAt: Date.now() });
  await complete(tx);
}

function entityChanges(previous, next) {
  const changes = [];
  for (const type of ["order", "session"]) {
    const property = type === "order" ? "orders" : "sessions";
    const idOf = item => type === "order" ? item.id : item.id;
    const before = new Map((previous[property] || []).map(item => [idOf(item), item]));
    const after = new Map((next[property] || []).map(item => [idOf(item), item]));
    for (const [id, value] of after) {
      const oldValue = before.get(id);
      if (!same(oldValue, value)) changes.push({ type, id, before: oldValue, value });
    }
    for (const [id, oldValue] of before) if (!after.has(id)) changes.push({ type, id, before: oldValue, value: null });
  }
  return changes;
}

export async function commitState(nextState, previousState, userId) {
  const db = await openLocalDb();
  const tx = db.transaction(["state", "outbox"], "readwrite");
  const stateStore = tx.objectStore("state");
  const outboxStore = tx.objectStore("outbox");
  const previous = previousState || { orders: [], sessions: [] };
  stateStore.put({ key: stateKey(userId), value: clone(nextState), updatedAt: Date.now() });
  for (const change of entityChanges(previous, nextState)) {
    const value = change.value || (change.type === "session" ? {
      ...change.before,
      status: "cancelled",
      pausedAt: null,
      completedAt: change.before?.completedAt || Date.now(),
      deleted: true,
      deletedAt: Date.now()
    } : null);
    if (!value) continue;
    const entityKey = keyOf(userId, change.type, change.id);
    const existing = await requestValue(outboxStore.index("entityKey").getAll(entityKey));
    const queued = existing.filter(item => item.status === "queued").sort((a, b) => a.createdAt - b.createdAt).at(-1);
    const baseRevision = Number(change.before?.serverRevision || 0);
    if (queued) {
      queued.payload = clone(value);
      queued.updatedAt = Date.now();
      outboxStore.put(queued);
    } else {
      const item = {
        id: crypto.randomUUID(),
        ownerId: userId,
        type: change.type,
        entityId: change.id,
        entityKey,
        baseRevision,
        payload: clone(value),
        createdAt: Date.now(),
        status: "queued"
      };
      outboxStore.put(item);
    }
  }
  await complete(tx);
}

export async function mergeRemote({ orders = [], sessions = [] }, userId) {
  const db = await openLocalDb();
  const tx = db.transaction(["state", "outbox"], "readwrite");
  const stateStore = tx.objectStore("state");
  const outbox = tx.objectStore("outbox");
  const record = await requestValue(stateStore.get(stateKey(userId)));
  const state = record?.value || { orders: [], sessions: [], activeSessionId: null };
  const merge = async (type, incoming, property) => {
    const items = new Map((state[property] || []).map(item => [item.id, item]));
    for (const item of incoming) {
      const key = keyOf(userId, type, item.id);
      const pending = await requestValue(outbox.index("entityKey").getAll(key));
      const current = items.get(item.id);
      const blocked = pending.filter(operation => operation.status !== "done");
      if (blocked.some(operation => operation.status !== "conflict")) continue;
      if (blocked.length && Number(item.serverRevision || 0) <= Number(current?.serverRevision || 0)) continue;
      if (blocked.length) for (const operation of blocked) outbox.delete(operation.id);
      if (type === "session" && item.deleted) { items.delete(item.id); continue; }
      if (!current || Number(item.serverRevision || 0) >= Number(current.serverRevision || 0)) items.set(item.id, clone(item));
    }
    state[property] = [...items.values()];
  };
  await merge("order", orders, "orders");
  await merge("session", sessions, "sessions");
  if (!state.sessions.some(session => session.id === state.activeSessionId && ["notStarted", "active", "paused"].includes(session.status))) {
    state.activeSessionId = state.sessions.find(session => ["notStarted", "active", "paused"].includes(session.status))?.id || null;
  }
  stateStore.put({ key: stateKey(userId), value: state, updatedAt: Date.now() });
  await complete(tx);
  return clone(state);
}

export async function nextOutboxBatch(userId, limit = 40) {
  const db = await openLocalDb();
  const tx = db.transaction("outbox", "readwrite");
  const store = tx.objectStore("outbox");
  const values = (await requestValue(store.getAll())).filter(item => item.ownerId === userId).sort((a, b) => a.createdAt - b.createdAt);
  const now = Date.now();
  for (const item of values) if (shouldRetryInflight(item, now)) { item.status = "queued"; store.put(item); }
  const used = new Set();
  const batch = [];
  for (const item of values) {
    if (item.status === "conflict") { used.add(item.entityKey); continue; }
    if (used.has(item.entityKey)) continue;
    if (item.status !== "queued") continue;
    used.add(item.entityKey);
    item.status = "inflight";
    item.updatedAt = now;
    store.put(item);
    batch.push(clone(item));
    if (batch.length >= limit) break;
  }
  await complete(tx);
  return batch;
}

export async function ackOutbox(operationId, revision) {
  const db = await openLocalDb();
  const tx = db.transaction(["state", "outbox"], "readwrite");
  const stateStore = tx.objectStore("state");
  const outbox = tx.objectStore("outbox");
  const item = await requestValue(outbox.get(operationId));
  if (!item) { await complete(tx); return; }
  const record = await requestValue(stateStore.get(stateKey(item.ownerId)));
  const state = record?.value;
  const property = item.type === "order" ? "orders" : "sessions";
  const entity = state?.[property]?.find(value => value.id === item.entityId);
  if (entity) entity.serverRevision = Number(revision);
  if (state) stateStore.put({ key: stateKey(item.ownerId), value: state, updatedAt: Date.now() });
  outbox.delete(operationId);
  const remaining = await requestValue(outbox.index("entityKey").getAll(item.entityKey));
  const next = remaining.sort((a, b) => a.createdAt - b.createdAt)[0];
  if (next) { next.baseRevision = Number(revision); next.status = "queued"; outbox.put(next); }
  await complete(tx);
}

export async function failOutbox(operationId, conflict = false) {
  const db = await openLocalDb();
  const tx = db.transaction("outbox", "readwrite");
  const store = tx.objectStore("outbox");
  const item = await requestValue(store.get(operationId));
  if (item) { item.status = conflict ? "conflict" : "queued"; store.put(item); }
  await complete(tx);
}

export async function getOutbox(userId) {
  const db = await openLocalDb();
  const values = await requestValue(db.transaction("outbox", "readonly").objectStore("outbox").getAll());
  return values.filter(item => item.ownerId === userId).sort((a, b) => a.createdAt - b.createdAt);
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
