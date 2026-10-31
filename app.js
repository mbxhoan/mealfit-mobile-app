import {
  addOrdersToSession,
  allowedPhotoCount,
  cancelSession,
  classifyNetworkSignal,
  createSession,
  deleteSession,
  dueAmount,
  getSessionStats,
  isAssignedPendingOrder,
  isOrphanInTransitOrder,
  isEdgeBackSwipe,
  missingCriticalOrderFields,
  markDelivered,
  markPaid,
  normalizeState,
  normalizeGoogleMapsLink,
  paymentsForSession,
  pauseSession,
  removeOrderFromSession,
  reorderOrderInSession,
  resolveOrphanDelivery,
  reopenDeliveredOrder,
  resumeSession,
  setOrderNote,
  setOrderMapsLink,
  setSessionOrderShift,
  SHIFT_OPTIONS,
  startSession,
  startSingleDelivery
} from "./domain.mjs";
import imageCompression from "browser-image-compression";
import Webcam from "webcam-easy";
import { apiRequest as sendApiRequest } from "./api-client.mjs";
import {
  ackAppLog, ackOutbox, commitState, deletePhoto as deleteLocalPhoto, enqueueAppLog, failAppLog, failOutbox, getMeta, getOutbox,
  getOrderPhotos as loadOrderPhotos, getPendingPhotos, mergeRemote,
  nextAppLog, retryDeliveryConflict,
  nextOutboxBatch, openLocalDb, putPhoto as storeLocalPhoto, readState, rebaseOutbox, setMeta, writeStateSnapshot
} from "./local-store.mjs";
import { inject } from '@vercel/analytics';

const defaultAccounts = [
  { id: "admin", name: "Admin", role: "admin" }, { id: "user", name: "Nhân viên", role: "user" },
  { id: "hieu", name: "Hiếu", role: "shipper" }, { id: "hoan", name: "Hoàn", role: "shipper" },
  { id: "shipper", name: "Shipper", role: "shipper" }
];
let accounts = Object.fromEntries(defaultAccounts.map(account => [account.id, account]));
const emptyState = () => ({ orders: [], sessions: [], activeSessionId: null });

let state = emptyState();
let lastPersistedState = emptyState();
let role = null;
let user = null;
let viewStack = [{ name: "login" }];
let orderFilter = "Tất cả";
let orderListLimit = 50;
let routeSelectionLimit = 50;
let sessionTab = "route";
let selectedOrderId = null;
let selectedPayment = null;
let modal = null;
let sessionDefaultShift = "Sáng";
let addOrdersShift = "Sáng";
let routeAnnouncement = "";
let routeNoteOrderId = null;
let orderNoteEditId = null;
let edgeTouch = null;
let routeDrag = null;
let routeDragFrame = null;
let toastTimer = null;
let retryCountdownTimer = null;
let networkProbeTimer = null;
let syncRunning = false;
let syncKickTimer = null;
let syncRetryDelay = 1_500;
let sheetSyncPendingNoticeFor = null;
let appLogRunning = false;
let photoSyncRunning = false;
let sheetSyncRunning = false;
let orderSyncRunningId = null;
let syncErrorShown = false;
let stateWriteRunning = false;
let lastServerRtt = null;
let lastSyncAt = null;
let conflictCount = 0;
let changesPullRunning = false;
let activityKind = "api";
let activityRows = [];
let activityCursor = "";
let activityHasMore = false;
let activityLoading = false;
let activityError = "";
let appInitialized = false;
let webhookRetryFailures = 0;
let webhookRetryAt = 0;
let webcam = null;
const photoUrls = new Map();
let hydratedOrderId = null;
const app = document.querySelector("#app");

const currentView = () => viewStack.at(-1);
const orderById = id => state.orders.find(order => order.id === id);
const activeSession = () => state.sessions.find(session => session.id === state.activeSessionId && !session.syncConflict && ["notStarted", "active", "paused"].includes(session.status));
const isStaff = () => role === "admin" || role === "user";
const canSeeOrder = order => role !== "shipper" || (Array.isArray(state.visibleOrderIds)
  ? state.visibleOrderIds.includes(order.id)
  : !order.assignedUserId || order.assignedUserId === user?.id);
const money = amount => `${Math.round(Number(amount) || 0).toLocaleString("vi-VN")}đ`;
const callNumber = order => String(order?.phone ?? "").replace(/\D/g, "");

function orderWarning(order) {
  const missing = missingCriticalOrderFields(order);
  return missing.length ? `<span class="order-warning" role="note">Thiếu thông tin: ${missing.map(safe).join(", ")}</span>` : "";
}
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const addressLabel = value => safe(String(value ?? "").replace(/^Địa chỉ\s+/i, ""));
const paymentRecipient = { bank: "VIB", account: "865884858", name: "Phạm Thị Linh Uyên" };
const dateLabel = value => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
const timeLabel = value => new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

function recordClientLog(type, api, description, details = {}) {
  if (!user || api === "/api/log") return;
  void enqueueAppLog({ type, api, description, details }, user.id).catch(() => {});
}

async function apiRequest(path, options = {}) {
  const api = String(path).split("?", 1)[0];
  const method = String(options.method || "GET").toUpperCase();
  const startedAt = performance.now();
  try {
    return await sendApiRequest(path, options);
  } catch (error) {
    if (api !== "/api/log" && Number(error.status) === 0) {
      recordClientLog("error", `${method} ${api}`, "Yêu cầu ứng dụng thất bại", {
        status: Number(error.status) || 0,
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: String(error.code || "API_ERROR")
      });
    }
    throw error;
  }
}

const iconPaths = {
  arrow: '<path d="m15 18-6-6 6-6"/><path d="M20 12H9"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
  orders: '<path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 12h8M8 16h5"/>',
  dish: '<path d="M3 3v7a4 4 0 0 0 4 4h1V3M6 3v18M14 3v7a4 4 0 0 0 4 4h1V3M17 3v18"/>',
  delivery: '<path d="M3 7h11v11H3zM14 11h4l3 3v4h-7z"/><circle cx="7.5" cy="19" r="1.5"/><circle cx="17.5" cy="19" r="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7l.4 2.8a2 2 0 0 1-.6 1.7L8 11a16 16 0 0 0 5 5l1.8-1.9a2 2 0 0 1 1.7-.6l2.8.4a2 2 0 0 1 1.7 2z"/>',
  mapPin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M6 6h1M17 6h1M6 17h1M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
  camera: '<path d="M14 5h-4L8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 14v5h14v-5"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h3a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  signal: '<path d="M4 20v-4M9 20v-7M14 20V9M19 20V4"/>',
  activity: '<path d="M4 19V5M4 19h17"/><path d="m7 14 4-4 3 2 5-6"/><circle cx="7" cy="14" r="1"/><circle cx="11" cy="10" r="1"/><circle cx="14" cy="12" r="1"/>',
  grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>'
};

function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;
}

const networkConnection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
const networkLabels = { offline: "Mạng mất kết nối", weak: "Tín hiệu mạng yếu", stable: "Tín hiệu mạng ổn định" };
const networkSignal = () => {
  if (!navigator.onLine || lastServerRtt === Infinity) return "offline";
  if (lastServerRtt === null) return classifyNetworkSignal(navigator.onLine, networkConnection || {});
  return lastServerRtt > 700 || classifyNetworkSignal(true, networkConnection || {}) === "weak" ? "weak" : "stable";
};
const networkIndicator = () => {
  const signal = networkSignal();
  return user
    ? `<button type="button" class="network-indicator signal-${signal}" data-action="test-api" aria-label="Kiểm tra API · ${networkLabels[signal]}" title="Kiểm tra API">${icon("signal", 18)}</button>`
    : `<span class="network-indicator signal-${signal}" role="status" aria-label="${networkLabels[signal]}">${icon("signal", 18)}</span>`;
};
function updateNetworkIndicator() {
  const indicator = document.querySelector(".network-indicator");
  if (!indicator) return;
  const signal = networkSignal();
  indicator.className = `network-indicator signal-${signal}`;
  indicator.setAttribute("aria-label", user ? `Kiểm tra API · ${networkLabels[signal]}` : networkLabels[signal]);
}
window.addEventListener("online", () => { updateNetworkIndicator(); scheduleQueuedSync(0); });
window.addEventListener("offline", updateNetworkIndicator);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && user) scheduleQueuedSync(0);
});
networkConnection?.addEventListener?.("change", updateNetworkIndicator);

async function probeNetwork() {
  if (!navigator.onLine) { lastServerRtt = Infinity; updateNetworkIndicator(); return; }
  const startedAt = performance.now();
  try {
    await apiRequest("/api/ping", { method: "GET", timeout: 5_000 });
    lastServerRtt = performance.now() - startedAt;
  } catch {
    lastServerRtt = Infinity;
  }
  updateNetworkIndicator();
}

function mapsButton(link, label = "Mở vị trí trên Google Maps") {
  try { const url = normalizeGoogleMapsLink(link); return url ? `<a class="maps-link-button" href="${safe(url)}" target="_blank" rel="noopener noreferrer" aria-label="${safe(label)}">${icon("mapPin", 18)}</a>` : ""; }
  catch { return ""; }
}

function statusBadge(status, kind = "delivery") {
  const className = status === "Đã giao hàng" || status === "Đã thanh toán" ? (kind === "payment" ? "paid" : "delivered")
    : status === "Đang giao hàng" ? "transit" : status === "Chưa thanh toán" ? "unpaid" : "pending";
  return `<span class="status ${className}">${safe(status)}</span>`;
}

const sessionStatus = {
  notStarted: ["Chưa bắt đầu", "pending"],
  active: ["Đang giao", "transit"],
  paused: ["Tạm dừng", "paused"],
  completed: ["Hoàn tất", "delivered"],
  cancelled: ["Đã hủy", "cancelled"]
};

function sessionBadge(status) {
  const [label, color] = sessionStatus[status] || ["Chưa phân loại", "pending"];
  return `<span class="status ${color}">${label}</span>`;
}

function appShell(content, { title = "", back = false } = {}) {
  const left = back
    ? `<button class="back-button" data-action="back" aria-label="Quay lại">${icon("arrow", 18)}<span>${safe(title)}</span></button>`
    : `<span class="topbar-spacer" aria-hidden="true"></span>`;
  const detailOrderId = currentView()?.name === "order" ? currentView().orderId : "";
  const syncing = syncRunning || sheetSyncRunning || Boolean(orderSyncRunningId);
  const tools = `${networkIndicator()}<button class="icon-button" data-action="${detailOrderId ? "refresh-order" : "refresh"}" data-id="${safe(detailOrderId)}" aria-label="${syncing ? "Đang đồng bộ đơn hàng" : detailOrderId ? `Đồng bộ đơn ${safe(detailOrderId)}` : "Đồng bộ đơn hàng"}" ${syncing ? "disabled" : ""}>${syncing ? '<span class="spinner" aria-hidden="true"></span>' : icon("refresh")}</button><button class="role-chip" data-action="logout" aria-label="Đổi tài khoản hoặc đăng xuất">${safe(user?.name || "")}</button>`;
  const loading = syncRunning || sheetSyncRunning || Boolean(orderSyncRunningId);
  const loadingLabel = sheetSyncRunning ? "Đang chờ lượt đồng bộ danh sách đơn…" : orderSyncRunningId ? `Đang tải đơn ${safe(orderSyncRunningId)}…` : "Đang đồng bộ thay đổi…";
  const loadingBanner = loading && currentView()?.name !== "home" ? `<div class="request-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span>${loadingLabel}</span><i aria-hidden="true"></i></div>` : "";
  return `<div class="app-shell"><header class="topbar">${left}<img class="topbar-brand" src="/logo-transparent.png" alt="Mealfit"/><div class="topbar-tools">${tools}</div></header>${loadingBanner}${content}</div>${renderModal()}`;
}

function loginScreen() {
  return `<main class="login-page">
    <header class="login-topbar"><span aria-hidden="true"></span><img src="/logo-transparent.png" alt="Mealfit"/>${networkIndicator()}</header>
    <form class="login-form" id="login-form">
      <div class="form-field"><label for="username">Tài khoản</label><select class="select" id="username" name="username" autocomplete="username" required><option value="">Chọn tài khoản</option>${Object.values(accounts).map(account => `<option value="${safe(account.id)}">${safe(account.name)}</option>`).join("")}</select></div>
      <div class="form-field"><label for="pin">Mã PIN</label><input class="input pin-input" id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" placeholder="Nhập PIN" autocomplete="current-password" required /></div>
      <p class="login-error" id="login-error" aria-live="polite"></p>
      <button class="button full" type="submit">Đăng nhập ${icon("chevron", 18)}</button>
    </form>
  </main>${renderModal()}`;
}

function orderCounts() {
  const visibleOrders = role === "shipper" && Array.isArray(state.visibleOrderIds) ? state.orders.filter(canSeeOrder) : state.orders;
  return {
    pending: visibleOrders.filter(order => order.deliveryStatus === "Chưa giao hàng").length,
    transit: visibleOrders.filter(order => order.deliveryStatus === "Đang giao hàng").length,
    delivered: visibleOrders.filter(order => order.deliveryStatus === "Đã giao hàng").length
  };
}

function homeScreen() {
  const counts = orderCounts();
  const menu = [
    { title: "Đơn hàng", count: `${counts.pending + counts.transit + counts.delivered} đơn`, icon: "orders", action: "orders" },
    { title: role === "shipper" ? "Giao hàng" : "Phiên giao hàng", count: role === "shipper" ? (activeSession() ? "Tiếp tục phiên" : "Tạo phiên") : "Theo dõi tuyến", icon: "delivery", action: role === "shipper" ? "delivery" : "session-overview" },
    ...(role === "admin" ? [
      { title: "Hoạt động", count: "API · ứng dụng", icon: "activity", action: "activity" },
      { title: "Tài khoản", count: "User · shipper", icon: "user", action: "accounts" }
    ] : [])
  ];
  return `<main class="page">
    <p class="home-date">${lastSyncAt ? `Đồng bộ ${timeLabel(lastSyncAt)}` : "Chưa đồng bộ đơn hàng"}</p>
    <div class="home-summary" aria-label="Tóm tắt đơn hàng">
      <div class="summary-cell"><span class="summary-number">${counts.pending}</span><span class="summary-label">Chưa giao</span></div>
      <div class="summary-cell"><span class="summary-number">${counts.transit}</span><span class="summary-label">Đang giao</span></div>
      <div class="summary-cell"><span class="summary-number">${counts.delivered}</span><span class="summary-label">Đã giao</span></div>
    </div>
    <div class="menu-grid">${menu.map(item => `<button class="menu-card" data-action="open-${item.action}"><span class="menu-icon">${icon(item.icon, 23)}</span><span><span class="menu-label">${item.title}</span><span class="menu-count">${item.count}</span></span></button>`).join("")}${role === "admin" && conflictCount ? `<button class="menu-card" data-action="open-conflicts"><span class="menu-icon">${icon("orders", 23)}</span><span><span class="menu-label">Xung đột</span><span class="menu-count">${conflictCount} đơn cần xử lý</span></span></button>` : ""}</div>
    ${!state.orders.length ? `<div class="empty-state" style="margin-top:14px">Chưa tải được đơn hàng.<button class="button secondary full" style="margin-top:12px" data-action="refresh">Thử đồng bộ</button></div>` : ""}
    ${syncRunning || sheetSyncRunning ? `<div class="sync-loading" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><div class="sync-loading-copy"><strong>Đang đồng bộ đơn hàng</strong><span class="sync-loading-skeleton" aria-hidden="true"><i></i><i></i><i></i></span></div></div>` : `<p class="sync-state" aria-live="polite">${navigator.onLine ? "Đã lưu trên thiết bị" : "Ngoại tuyến · Chờ bạn đồng bộ khi có mạng"}</p>`}
    ${activeSession() && role === "shipper" ? `<div class="divider"></div><button class="button full" data-action="open-session">Tiếp tục phiên giao hàng ${icon("chevron", 18)}</button>` : ""}
  </main>`;
}

function activityScreen() {
  if (role !== "admin") return `<main class="page"><div class="empty-state">Chỉ admin được xem lịch sử hệ thống.</div></main>`;
  return `<main class="page">
    <div class="filter-row" role="tablist" aria-label="Loại lịch sử">
      <button class="filter-chip ${activityKind === "api" ? "active" : ""}" role="tab" aria-selected="${activityKind === "api"}" data-action="activity-kind" data-kind="api" ${activityLoading ? "disabled" : ""}>API</button>
      <button class="filter-chip ${activityKind === "activity" ? "active" : ""}" role="tab" aria-selected="${activityKind === "activity"}" data-action="activity-kind" data-kind="activity" ${activityLoading ? "disabled" : ""}>Ứng dụng</button>
    </div>
    ${activityError ? `<div class="empty-state"><strong>Không tải được lịch sử</strong>${safe(activityError)}<button class="button secondary full" style="margin-top:12px" data-action="reload-activity">Thử lại</button></div>` : ""}
    <div class="list">${activityRows.map(item => {
      const detail = item.detail || {};
      const isApi = item.entityType === "api";
      const status = Number(detail.status) || Number(item.operation.match(/\s(\d{3})$/)?.[1]) || 0;
      const actor = accounts[item.actorId]?.name || item.actorId || "Hệ thống";
      return `<article class="list-card activity-card">
        <div class="card-top"><strong>${safe(item.entityId)}</strong><span class="activity-status ${status >= 400 || detail.errorCode ? "failed" : "ok"}">${safe(item.operation)}</span></div>
        <p class="activity-meta">${safe(actor)} · ${safe(dateLabel(item.createdAt))} ${safe(timeLabel(item.createdAt))}${detail.durationMs != null ? ` · ${Math.max(0, Number(detail.durationMs))} ms` : ""}</p>
        ${detail.stage ? `<p class="activity-meta">Bước: ${safe(detail.stage)}${detail.received != null ? ` · Nhận ${detail.received}` : ""}${detail.imported != null ? ` · Nhập ${detail.imported}` : ""}${detail.pages != null ? ` · ${detail.pages} trang` : ""}</p>` : ""}
        ${detail.rowCount != null ? `<p class="activity-meta">${safe(String(detail.rowCount))} dòng nhận từ webhook</p>` : ""}
        ${detail.errorCode || detail.errorMessage ? `<p class="activity-error">${safe(detail.errorCode || "Lỗi")}${detail.errorMessage ? ` · ${safe(detail.errorMessage)}` : ""}</p>` : ""}
        ${isApi && item.operationId ? `<small class="activity-trace">ID: ${safe(item.operationId)}</small>` : ""}
      </article>`;
    }).join("")}</div>
    ${activityLoading ? `<div class="empty-state"><span class="spinner" aria-label="Đang tải"></span></div>` : !activityRows.length && !activityError ? `<div class="empty-state">Chưa có lịch sử ${activityKind === "api" ? "API" : "hoạt động"}.</div>` : ""}
    ${activityHasMore ? `<button class="button secondary full" data-action="load-more-activity" ${activityLoading ? "disabled" : ""}>${activityLoading ? "Đang tải…" : "Tải thêm"}</button>` : ""}
  </main>`;
}

function accountsScreen() {
  if (role !== "admin") return `<main class="page"><div class="empty-state">Chỉ admin được quản lý tài khoản.</div></main>`;
  const roleNames = { admin: "Admin", user: "Nhân viên", shipper: "Shipper" };
  return `<main class="page"><form id="accounts-form">
    <p class="field-help">Đổi tên không thay đổi ID đăng nhập. Tên shipper cũ vẫn được dùng để đồng bộ các đơn đã ghi trên Sheet. Shipper mới dùng PIN chung hiện tại.</p>
    <div class="account-list">${Object.values(accounts).map(account => `<label class="account-edit-row"><span><strong>${safe(roleNames[account.role] || account.role)}</strong><small>${safe(account.id)}</small></span><input class="input" name="name-${safe(account.id)}" data-account-id="${safe(account.id)}" data-account-base-name="${safe(account.name)}" value="${safe(account.name)}" maxlength="80" required aria-label="Tên ${safe(account.id)}" /></label>`).join("")}</div>
    <label class="form-field"><span class="account-new-label">Thêm shipper mới</span><input class="input" name="newShipperName" maxlength="80" placeholder="Tên shipper" autocomplete="off" /></label>
    <button class="button full" type="submit">Lưu tài khoản</button>
  </form></main>`;
}

async function loadActivity(reset = false) {
  if (role !== "admin" || activityLoading) return;
  const cursor = reset ? "" : activityCursor;
  if (reset) { activityRows = []; activityCursor = ""; activityHasMore = false; }
  activityError = "";
  activityLoading = true;
  if (currentView()?.name === "activity") render();
  try {
    const params = new URLSearchParams({ view: "logs", kind: activityKind, limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const result = await apiRequest(`/api/diagnostics?${params}`);
    activityRows = reset ? (result.data || []) : [...activityRows, ...(result.data || [])];
    activityCursor = result.nextCursor || "";
    activityHasMore = Boolean(result.hasMore);
  } catch (error) { activityError = error.message; }
  finally {
    activityLoading = false;
    if (currentView()?.name === "activity") render();
  }
}

function orderCard(order, clickable = true, selected = false) {
  const due = dueAmount(order);
  return `<div class="list-card ${clickable ? "clickable" : ""} ${selected ? "select-order selected" : ""}" ${clickable ? `data-action="open-order" data-id="${safe(order.id)}"` : ""}>
    ${selected ? '<span class="checkmark" aria-hidden="true"></span>' : ""}
    <div style="flex:1;min-width:0">
      <div class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.deliveryStatus)}</div>
      <p class="order-customer">${safe(order.customer)}</p><p class="order-address">${addressLabel(order.address)}</p>${customerNoteLine(order)}${orderWarning(order)}
      <div class="order-subline">${dateLabel(order.date)} · ${statusBadge(order.paymentStatus || (due ? "Chưa thanh toán" : "Đã thanh toán"), "payment")}</div>
      <div class="card-bottom"><span class="money">${money(order.total)}${due ? `<small class="money-sub">Còn thu ${money(due)}</small>` : ""}</span><span>${icon("chevron", 18)}</span></div>
    </div>
  </div>`;
}

function customerNoteLine(order) {
  const note = String(order.customerNote || "").trim();
  return note ? `<span class="order-customer-note"><strong>Ghi chú:</strong> ${safe(note)}</span>` : "";
}

function ordersScreen() {
  const filters = ["Tất cả", "Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"];
  const visibleOrders = state.orders.filter(canSeeOrder);
  const orders = orderFilter === "Tất cả" ? visibleOrders : visibleOrders.filter(order => order.deliveryStatus === orderFilter);
  const shownOrders = orders.slice(0, orderListLimit);
  return `<main class="page">
    <div class="filter-row">${filters.map(filter => `<button class="filter-chip ${orderFilter === filter ? "active" : ""}" data-action="filter-orders" data-filter="${safe(filter)}">${safe(filter)}</button>`).join("")}</div>
    <div class="list">${shownOrders.length ? shownOrders.map(order => orderCard(order)).join("") : '<div class="empty-state"><strong>Chưa có đơn trong mục này</strong>Đơn hàng sẽ xuất hiện tại đây khi có dữ liệu.</div>'}</div>
    ${orders.length > shownOrders.length ? `<button class="button secondary full list-more" data-action="load-more-orders">Tải thêm ${Math.min(50, orders.length - shownOrders.length)} đơn · còn ${orders.length - shownOrders.length}</button>` : ""}
  </main>`;
}

function dishesScreen() {
  return `<main class="page"><div class="empty-state">API chưa cung cấp danh sách món.</div></main>`;
}

function paymentSummary(order) {
  const due = dueAmount(order);
  return `<div class="detail-row"><span>Trạng thái</span><span>${statusBadge(order.paymentStatus || (due ? "Chưa thanh toán" : "Đã thanh toán"), "payment")}</span></div>
    <div class="detail-row"><span>Đã thanh toán</span><span>${money(order.paidAmount)}</span></div>
    <div class="detail-row collect-due ${due ? "has-due" : "settled"}"><strong>Còn phải thu</strong><strong>${money(due)}</strong></div>${order.paymentMethod ? `<div class="detail-row"><span>Phương thức gần nhất</span><span>${safe(order.paymentMethod)}</span></div>` : ""}`;
}

function photoSection(order, locked = false) {
  return `<details class="photo-disclosure" open><summary>Ảnh xác nhận <span data-photo-count>…/5</span></summary><div class="photo-content">
    <p class="fine-print">Tối đa 5 ảnh, mỗi ảnh tối đa 15 MB.</p>
    <div class="photo-grid" data-photo-order="${safe(order.id)}"><span class="photo-loading" role="status"><i></i><i></i><small>Đang tải ảnh…</small></span></div>
    <div class="photo-tools"><button class="button secondary small" data-action="choose-photo" data-source="camera" ${locked ? "disabled" : ""}>${icon("camera", 18)} Chụp ảnh</button><button class="button secondary small" data-action="choose-photo" data-source="upload" ${locked ? "disabled" : ""}>${icon("upload", 18)} Tải ảnh</button></div>
    ${locked ? '<p class="fine-print">Tiếp tục phiên để thay đổi ảnh.</p>' : ""}
    <input class="hidden-input" id="camera-input" type="file" accept="image/*" capture="environment" data-photo-kind="proof" ${locked ? "disabled" : ""} />
    <input class="hidden-input" id="upload-input" type="file" accept="image/*" multiple data-photo-kind="proof" ${locked ? "disabled" : ""} />
  </div></details>`;
}

function deliveryInfoEditor(order, scope, saveAction) {
  return `<div class="route-note-editor"><label for="${scope}-note-${safe(order.id)}">Ghi chú bởi shipper</label><textarea id="${scope}-note-${safe(order.id)}" data-${scope}-note rows="2" placeholder="Ví dụ: Giao trước 10:00, gọi trước khi đến">${safe(order.note || "")}</textarea><label for="${scope}-maps-${safe(order.id)}">Link Google Maps</label><input class="input maps-input" id="${scope}-maps-${safe(order.id)}" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/..." value="${safe(order.mapsLink || "")}" data-${scope}-maps /><div class="route-note-buttons"><button class="button small" data-action="${saveAction}" data-id="${safe(order.id)}">Lưu</button></div></div>`;
}

function orderDetailScreen(view) {
  const order = orderById(view.orderId);
  if (!order) return `<main class="page"><div class="empty-state">Không tìm thấy đơn hàng.</div></main>`;
  const items = Array.isArray(order.items) ? order.items : [];
  const fromSession = Boolean(view.fromSession && role === "shipper");
  const phone = callNumber(order);
  const due = dueAmount(order);
  const session = activeSession();
  const sessionPaused = session?.status === "paused";
  const canEditDeliveryInfo = isStaff() || (role === "shipper" && !(sessionPaused && session?.id === order.sessionId));
  const deliveryInfo = !canEditDeliveryInfo ? "" : orderNoteEditId === order.id
    ? deliveryInfoEditor(order, "detail", "save-detail-note")
    : `<button class="route-note-toggle" data-action="edit-detail-note" data-id="${safe(order.id)}">${order.note || order.mapsLink ? "Sửa ghi chú / vị trí" : "+ Ghi chú / vị trí"}</button>`;
  const inSession = fromSession && session?.orderIds.includes(order.id) && session.id === order.sessionId;
  const orphanDelivery = isOrphanInTransitOrder(state, order, user?.id);
  const actions = inSession && !sessionPaused && session?.status === "active" && order.deliveryStatus === "Đang giao hàng"
    ? `<div class="bottom-actions ${due ? "" : "single"}">${due ? `<button class="button secondary" data-action="pay-order" data-id="${safe(order.id)}">Đã thanh toán</button>` : ""}<button class="button ${due ? "" : "full"}" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao hàng</button></div>`
    : orphanDelivery ? `<div class="bottom-actions single"><button class="button full" data-action="choose-orphan-status" data-id="${safe(order.id)}" data-status="Đã giao hàng">Đã giao hàng</button></div>`
    : inSession && sessionPaused && order.deliveryStatus === "Đang giao hàng" ? `<div class="bottom-actions ${due ? "" : "single"}">${due ? '<button class="button secondary" disabled>Đã thanh toán</button>' : ""}<button class="button ${due ? "" : "full"}" disabled>Đã giao hàng</button></div><p class="fine-print">Tiếp tục phiên để giao hàng.</p>` : "";
  const mayCorrect = order.deliveryStatus === "Đã giao hàng" && (isStaff() || role === "shipper") && !sessionPaused;
  const productLine = item => `<div class="product-line"><span>${safe(item.name)}</span><span class="product-price">${money(item.total ?? item.unitPrice * item.quantity)}</span><small>${safe(item.details || item.weight || "")} · ${item.quantity} phần × ${money(item.unitPrice)}</small></div>`;
  return `<main class="page ${sessionPaused ? "paused" : ""} order-page"><div class="order-meta"><p class="eyebrow">${safe(order.id)} · ${dateLabel(order.date)}</p>${statusBadge(order.deliveryStatus)}</div>
    <div class="detail-card order-detail">
      <section class="detail-section customer-section"><div class="customer-line"><strong>${safe(order.customer)}</strong><span class="customer-phone">${safe(order.phone || "Chưa có SĐT")}</span></div><div class="customer-address-line"><div class="customer-address">${addressLabel(order.address)}</div>${mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}</div>${orderWarning(order)}${customerNoteLine(order)}${order.note ? `<div class="customer-note"><strong>Ghi chú bởi shipper:</strong> ${safe(order.note)}</div>` : ""}${deliveryInfo}</section>
      ${items.length ? `<section class="detail-section product-section"><h2>Sản phẩm <span>${items.length}</span></h2>${productLine(items[0])}${items.length > 1 ? `<details class="product-more"><summary><span>Xem thêm ${items.length - 1} món</span><span>Thu gọn</span></summary>${items.slice(1).map(productLine).join("")}</details>` : ""}</section>` : ""}
      <section class="detail-section payment-section"><h2>Thanh toán</h2><div class="detail-row"><span>Tiền hàng · ship</span><span>${money(order.subtotal)} · ${money(order.shippingFee)}</span></div><div class="detail-row total"><span>Tổng đơn</span><span>${money(order.total)}</span></div>${paymentSummary(order)}<button class="button secondary full qr-payment-button" data-action="show-payment-qr" data-id="${safe(order.id)}">${icon("qr", 18)} Hiện QR thanh toán</button></section>
      ${(order.deliveryMethod && order.deliveryMethod !== "Phiên giao hàng") || order.deliveredAt ? `<section class="detail-section delivery-section"><h2>Giao hàng</h2>${order.deliveryMethod && order.deliveryMethod !== "Phiên giao hàng" ? `<div class="detail-row"><span>Hình thức</span><span>${safe(order.deliveryMethod)}</span></div>` : ""}${order.deliveredAt ? `<div class="detail-row"><span>Đã giao lúc</span><span>${timeLabel(order.deliveredAt)} · ${dateLabel(order.deliveredAt)}</span></div>` : ""}</section>` : ""}
      ${photoSection(order, sessionPaused)}
    </div>${mayCorrect ? `<button class="button secondary full" style="margin-top:10px" data-action="reopen-order-status" data-id="${safe(order.id)}">Sửa trạng thái giao hàng</button>` : ""}
    ${phone || actions ? `<div class="detail-actions-dock">${phone ? `<a class="button call-customer-full" href="tel:${safe(phone)}" aria-label="Gọi ${safe(order.customer)}">${icon("phone", 18)} Gọi khách · ${safe(order.phone)}</a>` : ""}${actions}</div>` : ""}
  </main>`;
}

function staffSessionsScreen() {
  const sessions = [...state.sessions].sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
  return `<main class="page">
    <div class="list">${sessions.map(session => {
      const stats = getSessionStats(state, session.id);
      const timestamp = session.startedAt || session.createdAt;
      return `<button class="list-card clickable" data-action="open-session-history" data-id="${safe(session.id)}"><div class="card-top"><span class="order-number">${dateLabel(timestamp)} · ${session.startedAt ? timeLabel(timestamp) : "Chưa bắt đầu"}</span>${sessionBadge(session.status)}</div><p class="order-customer">${stats.remainingCount} đơn còn giao · ${stats.totalValue ? money(stats.totalValue) : "0đ"}</p><p class="order-address">${session.orderIds.map(id => safe(orderById(id)?.customer || id)).join(" · ") || "Chưa có điểm giao"}</p></button>`;
    }).join("") || '<div class="empty-state">Chưa có phiên giao hàng.</div>'}</div>
  </main>`;
}

function singleDeliveryScreen() {
  if (!isStaff()) return `<main class="page"><div class="empty-state"><strong>Không có quyền truy cập</strong>Giao lẻ dành cho admin và nhân viên.</div></main>`;
  const pending = state.orders.filter(order => canSeeOrder(order) && order.deliveryStatus === "Chưa giao hàng");
  const transit = state.orders.filter(order => order.deliveryStatus === "Đang giao hàng" && !order.sessionId);
  const selected = orderById(selectedOrderId);
  return `<main class="page">
    <button class="button secondary full" style="margin-bottom:18px" data-action="open-session-overview">Tình hình phiên giao hàng ${icon("chevron", 18)}</button>
    <h2 class="section-title" style="margin-top:0">Đơn chưa giao <small>${pending.length} đơn</small></h2>
    <div class="list">${pending.map(order => `<button class="list-card select-order ${selectedOrderId === order.id ? "selected" : ""}" aria-pressed="${selectedOrderId === order.id}" data-action="select-single-order" data-id="${safe(order.id)}"><span class="checkmark" aria-hidden="true"></span><span style="flex:1"><span class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(dueAmount(order) ? "Chưa thanh toán" : "Đã thanh toán", "payment")}</span><span class="order-customer">${safe(order.customer)}</span><span class="order-address">${addressLabel(order.address)}</span><span class="order-subline">Tổng hiện tại ${money(order.total)}${dueAmount(order) ? ` · Còn thu ${money(dueAmount(order))}` : ""}</span></span></button>`).join("") || '<div class="empty-state">Không còn đơn đang chờ giao.</div>'}</div>
    ${selected ? `<form id="single-form" class="detail-card" style="margin-top:16px;padding:16px"><div class="form-field"><label for="delivery-method">Hình thức giao hàng</label><select class="select" id="delivery-method" name="method">${["Be", "GreenSM", "Grab", "Shipper"].map((method, index) => `<option ${index === 0 ? "selected" : ""}>${method}</option>`).join("")}</select></div><div class="form-field"><label for="shipping-fee">Phí ship thực tế</label><input class="input" id="shipping-fee" name="shippingFee" type="number" min="0" step="1000" inputmode="numeric" value="${selected.shippingFee}" required /></div><button class="button full" type="submit">Bắt đầu giao ${icon("chevron", 18)}</button></form>` : ""}
    <h2 class="section-title">Đang giao <small>${transit.length} đơn giao lẻ</small></h2>
    <div class="list">${transit.map(order => `<div class="list-card"><div class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.deliveryStatus)}</div><p class="order-customer">${safe(order.customer)}</p><p class="order-address">${addressLabel(order.address)}</p><div class="card-bottom"><span><span class="money">${money(order.total)}</span><small class="money-sub">${safe(order.deliveryMethod || "")}</small></span><div class="button-row" style="width:auto"><button class="button secondary small" data-action="open-order" data-id="${safe(order.id)}">Chi tiết</button><button class="button small" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao</button></div></div></div>`).join("") || '<div class="empty-state">Chưa có đơn giao lẻ nào đang đi.</div>'}</div>
  </main>`;
}

function orderSelectionButton(order, selected, action) {
  const itemCount = order.items?.length || 0;
  return `<button class="select-order ${selected ? "selected" : ""}" aria-pressed="${selected}" data-action="${action}" data-id="${safe(order.id)}"><span class="checkmark" aria-hidden="true"></span><span class="selection-copy"><span class="selection-card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.paymentStatus || (dueAmount(order) ? "Chưa thanh toán" : "Đã thanh toán"), "payment")}</span><span class="selection-customer-line"><span class="order-customer">${safe(order.customer)}</span><strong class="selection-price">${money(order.total)}</strong></span><span class="order-address">${addressLabel(order.address)}</span>${customerNoteLine(order)}${itemCount ? `<span class="order-subline">${itemCount} sản phẩm</span>` : ""}${orderWarning(order)}</span></button>`;
}

function orphanDeliveryPanel() {
  if (role !== "shipper") return "";
  const orders = state.orders.filter(order => isOrphanInTransitOrder(state, order, user?.id));
  if (!orders.length) return "";
  return `<section class="orphan-recovery"><div class="orphan-recovery-heading"><h2>Đơn đang giao ngoài lộ trình</h2><p>${orders.length} đơn đang gán cho bạn nhưng không thuộc phiên đang hoạt động.</p></div><div class="orphan-recovery-list">${orders.map(order => `<article class="orphan-order-card"><div class="orphan-order-summary"><strong>${safe(order.id)} · ${safe(order.customer || "Chưa có tên khách")}</strong><span>${money(order.total)} · ${safe(order.address || "Chưa có địa chỉ")}</span></div><div class="orphan-order-actions"><button class="button secondary small" data-action="choose-orphan-status" data-id="${safe(order.id)}" data-status="Chưa giao hàng">Trả về đơn chờ</button><button class="button small" data-action="choose-orphan-status" data-id="${safe(order.id)}" data-status="Đã giao hàng">Đã giao</button><button class="button danger small" data-action="choose-orphan-status" data-id="${safe(order.id)}" data-status="Đã huỷ đơn">Hủy đơn</button></div></article>`).join("")}</div></section>`;
}

function selectionNoteEditor(flow, order) {
  const notes = flow === "session" ? window._sessionNotes : window._addNotes;
  const value = notes?.[order.id] ?? order.note ?? "";
  const mapLinks = flow === "session" ? window._sessionMaps : window._addMaps;
  const mapsLink = mapLinks?.[order.id] ?? order.mapsLink ?? "";
  const shift = flow === "session" ? window._sessionShifts?.[order.id] || sessionDefaultShift : addOrdersShift;
  return `<details class="selection-details"><summary><span class="selection-details-copy"><strong data-selection-shift-label>Ca ${safe(shift)}</strong><small data-selection-details-status>${value.trim() ? "Có ghi chú shipper" : "Thêm ghi chú shipper"} · ${mapsLink.trim() ? "Có vị trí" : "Thêm Google Maps"}</small></span>${icon("chevron", 16)}</summary><div class="selection-details-body">${flow === "session" ? `<select class="shift-select" aria-label="Ca giao đơn ${safe(order.id)}" data-shift-selection="${safe(order.id)}">${SHIFT_OPTIONS.map(item => `<option ${item === shift ? "selected" : ""}>${item}</option>`).join("")}</select>` : ""}<div class="selection-note"><label for="${flow}-note-${safe(order.id)}">Ghi chú bởi shipper</label><textarea id="${flow}-note-${safe(order.id)}" data-selection-note="${safe(order.id)}" data-note-flow="${flow}" rows="2" placeholder="Ví dụ: Giao trước 10:00, gọi trước khi đến">${safe(value)}</textarea><button class="note-clear" type="button" data-action="clear-selection-note" data-id="${safe(order.id)}" data-flow="${flow}" ${value.trim() ? "" : "disabled"}>Xóa ghi chú</button><label for="${flow}-maps-${safe(order.id)}">Link Google Maps (không bắt buộc)</label><input class="input maps-input" id="${flow}-maps-${safe(order.id)}" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/..." value="${safe(mapsLink)}" data-selection-maps="${safe(order.id)}" data-map-flow="${flow}" /><button class="note-clear" type="button" data-action="clear-selection-map" data-id="${safe(order.id)}" data-flow="${flow}" ${mapsLink.trim() ? "" : "disabled"}>Xóa link</button></div></div></details>`;
}

function selectionDefaultShift(id, label, value) {
  return `<details class="selection-default-shift"><summary><span>${label}</span><strong data-default-shift-label>${safe(value)}</strong>${icon("chevron", 16)}</summary><select class="select" id="${id}">${SHIFT_OPTIONS.map(shift => `<option ${shift === value ? "selected" : ""}>${shift}</option>`).join("")}</select></details>`;
}

function updateSelectionDetailsStatus(details) {
  const note = details?.querySelector("[data-selection-note]")?.value.trim();
  const map = details?.querySelector("[data-selection-maps]")?.value.trim();
  const status = details?.querySelector("[data-selection-details-status]");
  if (status) status.textContent = `${note ? "Có ghi chú" : "Thêm ghi chú"} · ${map ? "Có vị trí" : "Thêm Google Maps"}`;
}

function sessionCreateScreen() {
  if (role !== "shipper") return `<main class="page"><div class="empty-state">Phiên giao hàng dành cho shipper.</div></main>`;
  if (activeSession()) return sessionScreen();
  const pending = state.orders.filter(order => isAssignedPendingOrder(order, user?.id));
  const eligibleIds = new Set(pending.map(order => order.id));
  const selectedIds = (window._sessionSelection || []).filter(id => eligibleIds.has(id));
  window._sessionSelection = selectedIds;
  const shownOrders = pending.slice(0, routeSelectionLimit);
  return `<main class="page">
    ${selectionDefaultShift("default-shift", "Ca mặc định", sessionDefaultShift)}
    ${orphanDeliveryPanel()}
    <div class="list">${shownOrders.map(order => {
      const selected = selectedIds.includes(order.id);
      return `<div class="list-card shift-selection-row ${selected ? "selected" : ""}">${orderSelectionButton(order, selected, "toggle-session-order")}${selected ? selectionNoteEditor("session", order) : ""}</div>`;
    }).join("") || '<div class="empty-state">Không có đơn để giao.</div>'}</div>
    ${pending.length > shownOrders.length ? `<button class="button secondary full list-more" data-action="load-more-route-orders">Tải thêm ${Math.min(50, pending.length - shownOrders.length)} đơn · còn ${pending.length - shownOrders.length}</button>` : ""}
    <div class="bottom-actions single"><div class="selection-count">Đã chọn ${selectedIds.length} đơn</div><button class="button" data-action="create-session" ${selectedIds.length ? "" : "disabled"}>Tạo phiên</button></div>
  </main>`;
}

function elapsedLabel(durationMs) {
  if (durationMs < 30_000) return "Dưới 1 phút";
  return `${Math.max(1, Math.round(durationMs / 60_000))} phút`;
}

function sessionScreen() {
  const view = currentView();
  const session = (view.sessionId && state.sessions.find(item => item.id === view.sessionId)) || activeSession();
  if (session?.syncConflict) return `<main class="page"><div class="empty-state"><strong>Phiên cũ cần làm mới</strong><p>Phiên có ${session.orderIds.length} điểm giao không còn được gán đầy đủ cho tài khoản này. Dữ liệu phiên vẫn được giữ trên thiết bị.</p><button class="button full" data-action="new-session">Tạo phiên giao hàng mới</button></div></main>`;
  if (!session) {
    if (isStaff()) return staffSessionsScreen();
    const history = [...state.sessions].sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
    return `<main class="page">${orphanDeliveryPanel()}<button class="button full" data-action="new-session">Tạo phiên giao hàng ${icon("chevron", 18)}</button>
      <h2 class="section-title">Phiên gần đây <small>${history.length}</small></h2><div class="list">${history.map(item => `<button class="list-card clickable" data-action="open-session-history" data-id="${safe(item.id)}"><div class="card-top"><span class="order-number">${dateLabel(item.startedAt || item.createdAt)} ${item.startedAt ? `· ${timeLabel(item.startedAt)}` : ""}</span>${sessionBadge(item.status)}</div><p class="order-customer">${item.orderIds.length} điểm giao</p><p class="order-address">${item.orderIds.map(orderId => safe(orderById(orderId)?.customer || orderId)).join(" · ")}</p></button>`).join("") || '<div class="empty-state">Chưa có phiên giao hàng.</div>'}</div>
    </main>`;
  }
  const editable = role === "shipper" && ["notStarted", "active"].includes(session.status);
  const canDeleteSession = role === "admin" || (role === "shipper" && (!session.ownerId || session.ownerId === user?.id));
  const deleteSessionButton = canDeleteSession ? `<button class="button danger full" style="margin-top:12px" data-action="delete-session" data-id="${safe(session.id)}">Xóa phiên</button>` : "";
  const delivering = role === "shipper" && session.status === "active";
  const orders = session.orderIds.map(orderById).filter(Boolean);
  const isDone = order => Boolean(order && session.legs[order.id]?.completedAt);
  const routeStatus = order => isDone(order) ? "Đã giao hàng" : order.deliveryStatus;
  const completed = orders.filter(isDone).length;
  const stats = getSessionStats(state, session.id);
  const collectedLabel = order => paymentsForSession(order, session.id)
    .map(payment => `${payment.method} ${money(Number(payment.amount))}`).join(" · ");
  const collectionLine = order => {
    const label = collectedLabel(order);
    return label ? `<span class="session-collection">Đã thu: ${safe(label)}</span>` : "";
  };
  const nextId = session.orderIds.find(id => !isDone(orderById(id)));
  const current = orderById(nextId);
  const shiftSelect = order => editable && !isDone(order)
    ? `<select class="shift-select stop-shift" aria-label="Ca giao đơn ${safe(order.id)}" data-session-shift="${safe(order.id)}">${SHIFT_OPTIONS.map(shift => `<option ${shift === session.shifts?.[order.id] ? "selected" : ""}>${shift}</option>`).join("")}</select>`
    : `<span class="shift-label">${safe(session.shifts?.[order.id] || "Chưa phân ca")}</span>`;
  const noteTools = order => routeNoteOrderId === order.id
    ? deliveryInfoEditor(order, "route", "save-route-note")
    : `<button class="route-note-toggle" data-action="edit-route-note" data-id="${safe(order.id)}">${order.note || order.mapsLink ? "Sửa ghi chú / vị trí" : "+ Ghi chú / vị trí"}</button>`;
  const stopCard = (order, index) => {
    const done = isDone(order);
    const currentStop = order.id === nextId;
    const leg = session.legs[order.id];
    const phone = callNumber(order);
    return `<div class="route-stop ${done ? "done" : currentStop ? "current" : ""}" data-order-id="${safe(order.id)}" data-completed="${done}" data-shift="${safe(session.shifts?.[order.id] || "")}"><div class="stop-mark">${done ? icon("check", 17) : index + 1}</div><div class="stop-card" data-action="open-order-session" data-id="${safe(order.id)}" tabindex="-1">
      <button class="stop-open" data-action="open-order-session" data-id="${safe(order.id)}"><span class="stop-primary"><span class="stop-title">${safe(order.customer)} <small>· ${safe(order.id)}</small></span><span class="stop-total">${money(order.total)}<small class="money-sub">${dueAmount(order) ? `Thu ${money(dueAmount(order))}` : "Đã thanh toán"}</small></span></span><span class="stop-caption">${addressLabel(order.address)}</span>${collectionLine(order)}${customerNoteLine(order)}${order.note ? `<span class="stop-note">Ghi chú bởi shipper: ${safe(order.note)}</span>` : ""}</button>
      ${orderWarning(order)}${editable && !done ? noteTools(order) : ""}
      <div class="stop-bottom">${shiftSelect(order)}<div class="stop-tools">${mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}${phone ? `<a class="stop-call" href="tel:${safe(phone)}" aria-label="Gọi ${safe(order.customer)}">${icon("phone", 18)}</a>` : ""}${editable && !done ? `<button class="mini-button drag-handle" type="button" data-drag-order="${safe(order.id)}" aria-label="Kéo để sắp xếp ${safe(order.customer)} trong ca ${safe(session.shifts?.[order.id] || "chưa phân ca")}; dùng phím mũi tên lên hoặc xuống" aria-keyshortcuts="ArrowUp ArrowDown">${icon("grip", 18)}</button><button class="mini-button" data-action="remove-stop" data-id="${safe(order.id)}" aria-label="Bỏ ${safe(order.id)} khỏi phiên">${icon("close", 17)}</button>` : ""}</div></div>
      ${leg ? `<div class="leg-time">${icon("clock", 14)} Chặng này: ${elapsedLabel(leg.durationMs)} · ${timeLabel(leg.completedAt)}</div>` : ""}
      ${!done && session.status === "paused" ? `<div class="stop-actions ${dueAmount(order) ? "" : "single"}">${dueAmount(order) ? '<button class="button secondary small" disabled>Đã thanh toán</button>' : ""}<button class="button small ${dueAmount(order) ? "" : "full"}" disabled>Đã giao hàng</button></div>` : ""}
      ${!done && delivering ? `<div class="stop-actions ${dueAmount(order) ? "" : "single"}">${dueAmount(order) ? `<button class="button secondary small" data-action="pay-order" data-id="${safe(order.id)}">Đã thanh toán</button>` : ""}<button class="button small ${dueAmount(order) ? "" : "full"}" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao hàng</button></div>` : ""}</div></div>`;
  };
  const controls = role === "shipper" && session.status === "notStarted"
    ? `<div class="session-controls"><button class="button full" data-action="start-session">Bắt đầu giao</button><button class="button danger full" data-action="cancel-session">Hủy lộ trình</button></div>`
    : role === "shipper" && session.status === "active"
      ? `<div class="session-controls"><button class="button secondary full" data-action="pause-session">Tạm dừng</button><button class="button danger full" data-action="cancel-session">Hủy lộ trình</button></div>`
      : role === "shipper" && session.status === "paused"
        ? `<div class="paused-note">Các thao tác giao hàng đang khóa.</div><div class="session-controls"><button class="button full" data-action="resume-session">Tiếp tục</button><button class="button danger full" data-action="cancel-session">Hủy lộ trình</button></div>`
        : role === "shipper" && ["completed", "cancelled"].includes(session.status) && !activeSession()
          ? `<button class="button full" style="margin:16px 0" data-action="new-session">Tạo phiên mới</button>` : "";
  const unassigned = session.orderIds.filter(id => !session.shifts?.[id]).length;
  const orderListCard = (order, index) => {
    const done = isDone(order);
    return `<div class="session-order ${done ? "done" : ""}" data-order-id="${safe(order.id)}" data-completed="${done}" data-shift="${safe(session.shifts?.[order.id] || "")}"><button class="session-order-open" data-action="open-order-session" data-id="${safe(order.id)}"><span class="session-order-top"><strong>${index + 1}. ${safe(order.customer)} · ${safe(order.id)}</strong>${statusBadge(routeStatus(order))}</span><span class="order-address">${addressLabel(order.address)}</span>${collectionLine(order)}${customerNoteLine(order)}${orderWarning(order)}${order.note ? `<span class="stop-note">Ghi chú bởi shipper: ${safe(order.note)}</span>` : ""}<span class="session-order-total">${money(order.total)} · ${dueAmount(order) ? `Còn thu ${money(dueAmount(order))}` : "Đã thanh toán"}</span></button>${editable && !done ? `<div class="session-order-tools">${mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}<button class="mini-button drag-handle" type="button" data-drag-order="${safe(order.id)}" aria-label="Kéo để sắp xếp ${safe(order.customer)} trong ca ${safe(session.shifts?.[order.id] || "chưa phân ca")}; dùng phím mũi tên lên hoặc xuống" aria-keyshortcuts="ArrowUp ArrowDown">${icon("grip", 18)}</button><button class="mini-button" data-action="remove-stop" data-id="${safe(order.id)}" aria-label="Bỏ ${safe(order.id)} khỏi phiên">${icon("close", 17)}</button></div>${noteTools(order)}` : mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}</div>`;
  };
  const groupedOrders = [...SHIFT_OPTIONS, "Chưa phân ca"].map(shift => ({
    shift,
    orders: orders.filter(order => (session.shifts?.[order.id] || "Chưa phân ca") === shift)
  })).filter(group => group.orders.length);
  const renderOrderGroups = (renderCard, kind) => groupedOrders.map(group => {
    const doneOrders = group.orders.filter(isDone);
    const pendingOrders = group.orders.filter(order => !isDone(order));
    const shiftTotal = group.orders.length;
    const shiftDone = !pendingOrders.length;
    const label = `${group.shift} ${doneOrders.length}/${shiftTotal}`;
    if (shiftDone) return `<details class="shift-group shift-complete"><summary><span>${icon("check", 14)} ${label} · Hoàn tất</span><small>Mở lại</small></summary><div class="${kind}-done-list">${doneOrders.map(order => renderCard(order, session.orderIds.indexOf(order.id))).join("")}</div></details>`;
    return `<section class="shift-group"><div class="shift-heading">${label}</div>${doneOrders.length ? `<details class="completed-stops"><summary><span>${icon("check", 13)} Đã giao ${doneOrders.length} đơn</span><small>Xem lại</small></summary><div class="${kind}-done-list">${doneOrders.map(order => renderCard(order, session.orderIds.indexOf(order.id))).join("")}</div></details>` : ""}<div class="${kind}-stop-list" data-route-shift="${safe(group.shift)}">${pendingOrders.map(order => renderCard(order, session.orderIds.indexOf(order.id))).join("")}</div></section>`;
  }).join("");
  const continueButton = delivering && current ? `<button class="button secondary full continue-route" data-action="continue-route" hidden>${icon("route", 17)} Tiếp tục giao</button>` : "";
  return `<main class="page route-page">${orphanDeliveryPanel()}<div class="session-meta"><span>${safe(session.id)} · ${dateLabel(session.startedAt || session.createdAt)}</span>${sessionBadge(session.status)}</div>
    <div class="route-progress"><strong>${completed} / ${orders.length} điểm</strong><div class="shift-summary-list">${stats.shifts.map(item => `<span class="shift-summary ${item.done ? "done" : ""}">${item.done ? icon("check", 13) : ""}${item.shift} ${item.completed}/${item.total}</span>`).join("")}${unassigned ? `<span class="shift-summary">Chưa phân ca ${unassigned}</span>` : ""}</div></div>
    <div class="route-stats">${session.startedAt ? `<div><span>Tiền mặt</span><strong>${money(stats.cashCollected)}</strong></div><div><span>Chuyển khoản</span><strong>${money(stats.transferCollected)}</strong></div><div><span>Còn giao</span><strong>${stats.remainingCount}</strong></div><div><span>Tổng tuyến</span><strong>${money(stats.totalValue)}</strong></div>` : `<div><span>Tổng cần thu</span><strong>${money(stats.amountToCollect)}</strong></div><div><span>Tổng tuyến</span><strong>${money(stats.totalValue)}</strong></div>`}</div>
    ${continueButton}${controls}${deleteSessionButton}
    <div class="route-tabs"><button class="route-tab ${sessionTab === "route" ? "active" : ""}" data-action="session-tab" data-tab="route">Tuyến</button><button class="route-tab ${sessionTab === "orders" ? "active" : ""}" data-action="session-tab" data-tab="orders">Đơn trong phiên</button></div>
    <div class="sr-only" role="status" aria-live="polite">${safe(routeAnnouncement)}</div>
    ${sessionTab === "route" ? `<div class="route-list">${renderOrderGroups(stopCard, "route") || '<div class="empty-state">Phiên này chưa có điểm giao.</div>'}</div>` : `<div class="session-order-list">${renderOrderGroups(orderListCard, "session-order")}</div>`}
    ${editable ? `<button class="button secondary full" style="margin-top:16px" data-action="add-session-orders">${icon("plus", 18)} Thêm đơn vào phiên</button>` : ""}
  </main>`;
}

function addOrdersScreen() {
  const session = activeSession();
  if (role !== "shipper" || !session || !["active", "notStarted"].includes(session.status)) return `<main class="page"><div class="empty-state">Tiếp tục phiên trước khi thêm đơn.</div></main>`;
  const pending = state.orders.filter(order => isAssignedPendingOrder(order, user?.id));
  const eligibleIds = new Set(pending.map(order => order.id));
  const selectedIds = (window._addSelection || []).filter(id => eligibleIds.has(id));
  window._addSelection = selectedIds;
  const shownOrders = pending.slice(0, routeSelectionLimit);
  return `<main class="page">
    ${selectionDefaultShift("add-shift", "Ca giao", addOrdersShift)}
    ${orphanDeliveryPanel()}
    <div class="list">${shownOrders.map(order => {
      const selected = selectedIds.includes(order.id);
      return `<div class="list-card shift-selection-row ${selected ? "selected" : ""}">${orderSelectionButton(order, selected, "toggle-add-order")}${selected ? selectionNoteEditor("add", order) : ""}</div>`;
    }).join("") || '<div class="empty-state">Không có đơn chưa giao để thêm.</div>'}</div>
    ${pending.length > shownOrders.length ? `<button class="button secondary full list-more" data-action="load-more-route-orders">Tải thêm ${Math.min(50, pending.length - shownOrders.length)} đơn · còn ${pending.length - shownOrders.length}</button>` : ""}
    <div class="bottom-actions single"><div class="selection-count">Đã chọn ${selectedIds.length} đơn</div><button class="button" data-action="confirm-add-orders" ${selectedIds.length ? "" : "disabled"}>Thêm vào tuyến</button></div>
  </main>`;
}

function renderModal() {
  if (!modal) return "";
  if (modal.type === "api-check") {
    const rows = [
      ["API ứng dụng", modal.result.appApi],
      ["Database", modal.result.database],
      ["Webhook danh sách đơn", modal.result.ordersApi]
    ];
    return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Kiểm tra kết nối</h2><div class="api-check-list">${rows.map(([label, result]) => `<div class="api-check-row"><span><i class="api-check-dot ${result.ok ? "ok" : "failed"}"></i>${label}</span><strong>${result.ok ? "Kết nối tốt" : result.status ? `Lỗi HTTP ${result.status}` : "Không kết nối"} · ${result.durationMs} ms</strong>${result.message ? `<small>${safe(result.message)}</small>` : ""}${result.errorCode ? `<small>Mã lỗi: ${safe(result.errorCode)}</small>` : ""}</div>`).join("")}</div><div class="modal-actions"><button class="button secondary" data-action="close-modal">Đóng</button><button class="button" data-action="test-api">Kiểm tra lại</button></div></section></div>`;
  }
  if (modal.type === "payment") {
    const order = orderById(modal.orderId);
    if (!order) return "";
    const due = dueAmount(order);
  return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Xác nhận thanh toán</h2><p>Chọn phương thức nhận ${money(due)} từ ${safe(order.customer)}.</p>${["Tiền mặt", "Chuyển khoản", "Khác"].map(method => `<button class="modal-option ${modal.method === method ? "selected" : ""}" aria-pressed="${modal.method === method}" data-action="choose-payment" data-method="${safe(method)}"><span>${method}${method !== "Khác" ? ` · ${money(due)}` : ""}</span><span>${modal.method === method ? icon("check", 18) : ""}</span></button>`).join("")}<div class="modal-actions"><button class="button secondary" data-action="close-modal">Hủy</button><button class="button" data-action="confirm-payment" ${modal.method ? "" : "disabled"}>Xác nhận</button></div></section></div>`;
  }
  if (modal.type === "payment-qr") {
    const order = orderById(modal.orderId);
    if (!order) return "";
    const due = dueAmount(order);
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal payment-qr-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">QR chuyển khoản</h2><p>${due ? `Số tiền cần thanh toán: <strong>${money(due)}</strong>` : "Đơn hàng đã thanh toán đủ."}</p><img class="payment-qr-image" src="/mealfit-payment-qr.png" alt="Mã VietQR tĩnh nhận tiền vào tài khoản ${paymentRecipient.bank} ${paymentRecipient.account}"/><div class="payment-recipient"><strong>${paymentRecipient.name}</strong><span>${paymentRecipient.bank} · ${paymentRecipient.account}</span></div><p class="payment-qr-hint">Mã QR không điền sẵn số tiền. Nhờ khách nhập đúng số tiền hiển thị khi chuyển khoản.</p><div class="modal-actions">${modal.confirmPayment ? `<button class="button secondary" data-action="back-to-payment">Quay lại</button><button class="button" data-action="confirm-transfer-payment">Xác nhận đã nhận</button>` : `<button class="button secondary full" data-action="close-modal">Đóng</button>`}</div></section></div>`;
  }
  if (modal.type === "deliver-unpaid") {
    const order = orderById(modal.orderId);
    if (!order) return "";
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Đơn hàng chưa thanh toán</h2><p>Cần thu ${money(dueAmount(order))} bằng tiền mặt hoặc chuyển khoản. Xác nhận giao đơn khi còn khoản phải thu?</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Quay lại</button><button class="button" data-action="confirm-delivery-unpaid">Đã giao, còn phải thu</button></div></section></div>`;
  }
  if (modal.type === "orphan-delivery") {
    const order = orderById(modal.orderId);
    if (!order || !isOrphanInTransitOrder(state, order, user?.id)) return "";
    const details = {
      "Chưa giao hàng": ["Trả đơn về danh sách chờ?", "Đơn sẽ được phép chọn vào lộ trình mới."],
      "Đã giao hàng": ["Đánh dấu đơn đã giao?", "Đơn sẽ được chuyển sang Đã giao hàng để bỏ qua."],
      "Đã huỷ đơn": ["Hủy đơn này?", "Đơn sẽ được chuyển sang trạng thái Đã huỷ đơn."]
    }[modal.status];
    if (!details) return "";
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">${details[0]}</h2><p>${safe(order.id)} · ${safe(order.customer)}. ${details[1]}</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Quay lại</button><button class="button ${modal.status === "Đã huỷ đơn" ? "danger" : ""}" data-action="confirm-orphan-status">Xác nhận</button></div></section></div>`;
  }
  if (modal.type === "remove-stop") {
    const order = orderById(modal.orderId);
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Bỏ đơn khỏi phiên?</h2><p>${safe(order?.id)} sẽ trở về danh sách “Chưa giao hàng”.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Giữ lại</button><button class="button danger" data-action="confirm-remove-stop">Bỏ khỏi phiên</button></div></section></div>`;
  }
  if (modal.type === "cancel-session") {
    const session = activeSession();
    const remaining = session?.orderIds.filter(id => !session.legs[id]?.completedAt).length || 0;
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Hủy lộ trình?</h2><p>${remaining} đơn chưa giao sẽ trở về danh sách chờ. Các đơn đã giao được giữ nguyên.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Quay lại</button><button class="button danger" data-action="confirm-cancel-session">Hủy lộ trình</button></div></section></div>`;
  }
  if (modal.type === "delete-session") {
    const session = state.sessions.find(item => item.id === modal.sessionId);
    if (!session) return "";
    const resetCount = session.orderIds.filter(id => orderById(id)?.deliveryStatus === "Đang giao hàng").length;
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Xóa phiên giao hàng?</h2><p>${resetCount} đơn đang giao sẽ chuyển về “Chưa giao hàng”. Trạng thái các đơn còn lại được giữ nguyên.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Quay lại</button><button class="button danger" data-action="confirm-delete-session" data-id="${safe(session.id)}">Xóa phiên</button></div></section></div>`;
  }
  if (modal.type === "reopen-order") {
    const order = orderById(modal.orderId);
    if (!order) return "";
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Sửa trạng thái ${safe(order.id)}</h2><p>Thanh toán và ảnh xác nhận sẽ được giữ lại.</p><div class="form-field"><label for="reopen-shift">Ca giao lại</label><select class="select" id="reopen-shift">${SHIFT_OPTIONS.map(shift => `<option ${shift === (modal.shift || "Sáng") ? "selected" : ""}>${shift}</option>`).join("")}</select></div><div class="modal-actions"><button class="button secondary" data-action="confirm-reopen-order" data-status="Chưa giao hàng">Chưa giao</button><button class="button" data-action="confirm-reopen-order" data-status="Đang giao hàng">Đang giao</button></div></section></div>`;
  }
  if (modal.type === "error") {
    const retrySeconds = Math.max(0, Math.ceil(((modal.retryAt || 0) - Date.now()) / 1000));
    return `<div class="modal-backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Chưa hoàn tất</h2><p>${safe(modal.message)}</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Đóng</button><button class="button" data-action="retry-sync" ${retrySeconds ? "disabled" : ""}>${retrySeconds ? `Chờ ${retrySeconds} giây` : "Thử lại"}</button></div></section></div>`;
  }
  if (modal.type === "camera") return `<div class="modal-backdrop"><section class="modal camera-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Chụp ảnh đơn hàng</h2><video id="camera-video" autoplay playsinline></video><canvas id="camera-canvas" class="hidden-input"></canvas><p class="fine-print" data-camera-message>Đang mở camera…</p><div class="modal-actions"><button class="button secondary" data-action="close-camera">Đóng</button><button class="button" data-action="capture-photo" disabled>Chụp ảnh</button></div></section></div>`;
  if (modal.type === "conflicts") return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Xung đột đồng bộ</h2><p>${safe(modal.message || "Dữ liệu từ Google Sheet là nguồn chuẩn.")}</p>${(modal.items || []).map(item => `<div class="conflict-row"><strong>${safe(item.orderCode)}</strong><div class="modal-actions"><button class="button" data-action="resolve-conflict" data-id="${safe(item.conflictId)}" data-choice="sheet">Tải lại từ Sheet</button></div></div>`).join("") || '<p>Không còn xung đột cần xử lý.</p>'}<div class="modal-actions"><button class="button secondary" data-action="close-modal">Đóng</button><button class="button" data-action="retry-sync">Làm mới</button></div></section></div>`;
  return "";
}

function render() {
  if (routeDrag) cancelRouteDrag();
  if (!appInitialized) {
    app.innerHTML = startupScreen();
    return;
  }
  const view = currentView();
  if (!role || view.name === "login") {
    hydratedOrderId = null;
    app.innerHTML = loginScreen();
    return;
  }
  let content;
  let options = { back: view.name !== "home", title: "" };
  switch (view.name) {
    case "home": content = homeScreen(); options.back = false; break;
    case "orders": content = ordersScreen(); options.title = "Đơn hàng"; break;
    case "activity": content = activityScreen(); options.title = "Hoạt động"; break;
    case "accounts": content = accountsScreen(); options.title = "Tài khoản"; break;
    case "dishes": content = dishesScreen(); options.title = "Món"; break;
    case "delivery": content = singleDeliveryScreen(); options.title = "Giao lẻ"; break;
    case "sessions-overview": content = staffSessionsScreen(); options.title = "Phiên giao hàng"; break;
    case "session-create": content = sessionCreateScreen(); options.title = "Tạo phiên"; break;
    case "session": content = sessionScreen(); options.title = "Phiên giao"; break;
    case "add-orders": content = addOrdersScreen(); options.title = "Thêm đơn"; break;
    case "order": content = orderDetailScreen(view); options.title = "Chi tiết đơn"; break;
    default: content = homeScreen(); options.back = false;
  }
  app.innerHTML = appShell(content, options);
  if (view.name === "session") routeAnnouncement = "";
  if (view.name === "order") {
    if (hydratedOrderId !== view.orderId) {
      hydratedOrderId = view.orderId;
      void hydratePhotos(view.orderId);
    }
  } else hydratedOrderId = null;
  requestAnimationFrame(updateContinueRouteButton);
}

function persistLastView() {
  if (!user) return;
  void setMeta(`lastView:${user.id}`, viewStack).catch(() => showError("Không lưu được màn hình gần nhất trên thiết bị."));
}

function navigate(view) {
  modal = null;
  viewStack.push(view);
  render();
  persistLastView();
  window.scrollTo?.(0, 0);
}

function back() {
  if (modal) { modal = null; render(); return; }
  if (viewStack.length > 1) {
    viewStack.pop();
  }
  render();
  persistLastView();
}

window.addEventListener("touchstart", event => {
  if (routeDrag || event.touches.length !== 1 || event.target.closest("input, textarea, select, [contenteditable='true'], [data-drag-order]")) {
    edgeTouch = null;
    return;
  }
  const touch = event.touches[0];
  edgeTouch = touch.clientX <= 24 ? { x: touch.clientX, y: touch.clientY, side: "left" }
    : touch.clientX >= window.innerWidth - 24 ? { x: touch.clientX, y: touch.clientY, side: "right" }
      : null;
}, { passive: true });

window.addEventListener("touchmove", event => {
  if (!edgeTouch || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const dx = touch.clientX - edgeTouch.x;
  const dy = touch.clientY - edgeTouch.y;
  const inward = edgeTouch.side === "left" ? dx > 0 : dx < 0;
  if (inward && Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy) * 1.5) event.preventDefault();
  else if (Math.abs(dy) > 12 || Math.abs(dx) > 24) edgeTouch = null;
}, { passive: false });

window.addEventListener("touchend", event => {
  if (!edgeTouch) return;
  const start = edgeTouch;
  edgeTouch = null;
  const touch = event.changedTouches[0];
  if (touch && (modal || viewStack.length > 1)
    && isEdgeBackSwipe({ x: start.x, y: start.y }, { x: touch.clientX, y: touch.clientY }, window.innerWidth)) back();
}, { passive: true });

window.addEventListener("touchcancel", () => { edgeTouch = null; }, { passive: true });

function showSessionHistory(sessionId) {
  const routeView = [...viewStack].reverse().find(view => view.name === "session");
  if (routeView) routeView.sessionId = sessionId;
}

function flash(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function startupScreen() {
  return `<main class="startup-splash" role="status" aria-live="polite"><img src="/logo-transparent.png" alt="Mealfit"/><span class="spinner" aria-hidden="true"></span><strong>Đang mở Mealfit</strong><small>Đang khôi phục dữ liệu trên thiết bị</small></main>`;
}

function cloneState(value) { return JSON.parse(JSON.stringify(value)); }

function showError(error) {
  clearInterval(retryCountdownTimer);
  const message = typeof error === "string" ? error : error?.message;
  const retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || Number(error?.retryAfterSeconds) * 1000 || 0);
  modal = { type: "error", message: String(message || "Không thể hoàn tất thao tác."), retryAt: retryAfterMs ? Date.now() + retryAfterMs : 0 };
  render();
  if (retryAfterMs) {
    retryCountdownTimer = setInterval(() => {
      const button = document.querySelector('[data-action="retry-sync"]');
      if (!modal || modal.type !== "error" || !button) { clearInterval(retryCountdownTimer); retryCountdownTimer = null; return; }
      const seconds = Math.max(0, Math.ceil((modal.retryAt - Date.now()) / 1000));
      button.disabled = seconds > 0;
      button.textContent = seconds ? `Chờ ${seconds} giây` : "Thử lại";
      if (!seconds) { clearInterval(retryCountdownTimer); retryCountdownTimer = null; }
    }, 1000);
  }
}

function assertWebhookRetryAllowed() {
  const waitMs = webhookRetryAt - Date.now();
  if (waitMs <= 0) return;
  const seconds = Math.ceil(waitMs / 1000);
  const error = new Error(`Để tránh gửi dồn yêu cầu, vui lòng chờ ${seconds} giây rồi thử lại.`);
  error.status = 429;
  error.retryAfterMs = waitMs;
  throw error;
}

function applyWebhookRetryCooldown(error) {
  if (error.status && error.status !== 429 && error.status < 500) return error;
  webhookRetryFailures = Math.min(webhookRetryFailures + 1, 6);
  const delayMs = Math.max(Number(error.retryAfterMs) || 0, Math.min(30_000, 1_500 * (2 ** (webhookRetryFailures - 1))));
  webhookRetryAt = Date.now() + delayMs;
  error.retryAfterMs = delayMs;
  return error;
}

function resetWebhookRetryCooldown() {
  webhookRetryFailures = 0;
  webhookRetryAt = 0;
}

async function updateState(next, message) {
  if (!user) throw new Error("Đăng nhập lại để tiếp tục.");
  if (stateWriteRunning) throw new Error("Đang lưu thao tác trước đó. Thử lại sau giây lát.");
  const normalized = normalizeState(next);
  stateWriteRunning = true;
  document.querySelector(".app-shell")?.classList.add("saving");
  try {
    await commitState(normalized, state, user.id);
  } catch (error) {
    showError("Không lưu được dữ liệu trên thiết bị. Kiểm tra dung lượng hoặc quyền lưu của trình duyệt.");
    throw error;
  } finally {
    stateWriteRunning = false;
    document.querySelector(".app-shell")?.classList.remove("saving");
  }
  state = normalized;
  lastPersistedState = cloneState(state);
  render();
  if (message) flash(`${message} · Đã lưu trên thiết bị`);
  scheduleQueuedSync();
}

function scheduleQueuedSync(delay = 120) {
  if (!user || !navigator.onLine) return;
  clearTimeout(syncKickTimer);
  syncKickTimer = setTimeout(async () => {
    syncKickTimer = null;
    if (!user || !navigator.onLine) return;
    if (syncRunning || sheetSyncRunning) { scheduleQueuedSync(350); return; }
    try {
      const result = await syncQueued();
      syncRetryDelay = 1_500;
      sheetSyncPendingNoticeFor = null;
      if (result.webhookPending) flash(`Đã lưu thay đổi · webhook n8n đang cập nhật ${result.webhookPending} đơn.`);
      else if (result.confirmedOrders) flash(`Google Sheet đã xác nhận ${result.confirmedOrders} đơn.`);
    } catch (error) {
      if (error.status === 401) { void logout(); return; }
      if (error.code === "SESSION_ORDERS_PENDING") { scheduleQueuedSync(error.retryAfterMs || 5_000); return; }
      if (error.code === "SHEET_SYNC_PENDING") {
        if (sheetSyncPendingNoticeFor !== user.id) {
          sheetSyncPendingNoticeFor = user.id;
          flash(error.message);
        }
        scheduleQueuedSync(error.retryAfterMs || 5_000);
        return;
      }
      if ([400, 403, 404, 409].includes(error.status)) {
        if (!syncErrorShown) { syncErrorShown = true; showError(error); }
        return;
      }
      const retryIn = syncRetryDelay;
      syncRetryDelay = Math.min(30_000, syncRetryDelay * 2);
      scheduleQueuedSync(retryIn);
      if (!syncErrorShown) { syncErrorShown = true; showError(error); }
    }
  }, delay);
}

async function syncQueued() {
  if (!user || !navigator.onLine) throw new Error("Cần kết nối mạng để đồng bộ các thay đổi đang chờ.");
  if (syncRunning) throw new Error("Đang đồng bộ thay đổi khác. Vui lòng đợi hoàn tất rồi thử lại.");
  syncRunning = true;
  render();
  let hasOperations = false;
  let syncFailure = null;
  let webhookPending = 0;
  let confirmedOrders = 0;
  const sessionConflicts = new Set();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const batch = await nextOutboxBatch(user.id, 40);
      if (!batch.length) break;
      hasOperations = true;
      const operations = batch.map(item => ({ operationId: item.id, type: item.type, entityId: item.entityId, baseRevision: item.baseRevision, payload: item.payload }));
      try {
        if (user.role === "shipper") {
          const claimCodes = [...new Set(batch.filter(item => item.type === "session")
            .flatMap(item => item.payload.orderIds || [])
            .filter(code => !orderById(code)?.assignedUserId))];
          for (let offset = 0; offset < claimCodes.length; offset += 50) {
            const claim = await apiRequest("/api/claim", { method: "POST", body: { codes: claimCodes.slice(offset, offset + 50) }, timeout: 60_000 });
            const revisions = new Map((claim.data || []).filter(order => order.claimed).map(order => [order.id, Number(order.serverRevision)]));
            for (const item of batch) {
              const revision = revisions.get(item.entityId);
              if (item.type !== "order" || !Number.isSafeInteger(revision)) continue;
              item.baseRevision = revision;
              const operation = operations.find(value => value.operationId === item.id);
              if (operation) operation.baseRevision = revision;
              await rebaseOutbox(item.id, revision);
            }
          }
        }
        const result = await apiRequest("/api/operations", { method: "POST", body: { operations }, timeout: 270_000 });
        webhookPending += Number(result.upstreamPending) || 0;
        const byId = new Map((result.results || []).map(item => [item.id, item]));
        for (const item of batch) {
          const acknowledgement = byId.get(item.id);
          if (acknowledgement) {
            await ackOutbox(item.id, acknowledgement.revision);
            if (item.type === "order") confirmedOrders++;
          }
          else await failOutbox(item.id);
        }
      } catch (error) {
        const results = error.details?.results || [];
        const byId = new Map(results.map(item => [item.id, item]));
        let retryingDeliveryConflict = false;
        let unresolvedConflict = false;
        for (const item of batch) {
          const result = byId.get(item.id);
          if (result?.conflict && error.code === "REVISION_CONFLICT" && !result.errorCode) {
            const retried = await retryDeliveryConflict(item.id);
            retryingDeliveryConflict = retried || retryingDeliveryConflict;
            if (retried) continue;
          }
          if (result?.conflict) {
            unresolvedConflict = true;
            await failOutbox(item.id, true);
            if (result.errorCode === "SESSION_ORDER_FORBIDDEN" && result.sessionId) sessionConflicts.add(result.sessionId);
          }
          else if (result) await ackOutbox(item.id, result.revision);
          else {
            unresolvedConflict = true;
            await failOutbox(item.id, error.status === 409);
          }
        }
        if (retryingDeliveryConflict) { syncFailure = unresolvedConflict ? error : null; continue; }
        const onlyStaleSessionConflicts = error.code === "SESSION_ORDER_FORBIDDEN"
          && results.some(result => result.errorCode === "SESSION_ORDER_FORBIDDEN")
          && results.every(result => !result.conflict || result.errorCode === "SESSION_ORDER_FORBIDDEN");
        syncFailure = onlyStaleSessionConflicts ? null : error;
        break;
      }
    }
    void syncPendingPhotos();
    void syncPendingMediaDeletes().catch(() => {});
    if (hasOperations) {
      if (sessionConflicts.size) {
        const snapshot = await readState(emptyState(), user.id);
        snapshot.sessions = snapshot.sessions.map(session => sessionConflicts.has(session.id) ? { ...session, syncConflict: true } : session);
        if (sessionConflicts.has(snapshot.activeSessionId)) snapshot.activeSessionId = null;
        await writeStateSnapshot(snapshot, user.id);
      }
      state = normalizeState(await readState(emptyState(), user.id));
      lastPersistedState = cloneState(state);
      syncErrorShown = false;
    }
  } catch (error) {
    syncFailure ||= error;
  } finally {
    syncRunning = false;
    render();
  }
  const pending = (await getOutbox(user.id)).filter(item => !["done", "conflict"].includes(item.status));
  if (syncFailure) throw syncFailure;
  if (pending.length) throw new Error(`Còn ${pending.length} thay đổi chưa gửi được. Thử đồng bộ lại trước khi tải danh sách đơn.`);
  return { sessionConflicts: [...sessionConflicts], webhookPending, confirmedOrders };
}

async function syncQueuedAppLog() {
  if (!user || !navigator.onLine || syncRunning || appLogRunning) return;
  const ownerId = user.id;
  appLogRunning = true;
  try {
    const operations = await getOutbox(ownerId);
    if (operations.some(item => !["conflict", "done"].includes(item.status))) return;
    if ((await getPendingPhotos()).length || (await getMeta(`media-deletes:${ownerId}`) || []).length) return;
    let lastSent = Number(await getMeta(`lastAppLogSentAt:${ownerId}`)) || 0;
    for (let sent = 0; sent < 10; sent++) {
      if (syncRunning || sheetSyncRunning) return;
      const wait = 1_100 - (Date.now() - lastSent);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      const item = await nextAppLog(ownerId);
      if (!item) return;
      try {
        await sendApiRequest("/api/log", {
          method: "POST",
          body: { type: item.type, api: item.api, description: item.description, details: item.details }
        });
        lastSent = Date.now();
        await setMeta(`lastAppLogSentAt:${ownerId}`, lastSent);
        await ackAppLog(item.id);
      } catch {
        await failAppLog(item.id);
        return;
      }
    }
  } catch {} finally { appLogRunning = false; }
}

async function syncPendingPhotos() {
  if (!user || !navigator.onLine || photoSyncRunning) return;
  photoSyncRunning = true;
  try {
    const photos = await getPendingPhotos();
    for (const photo of photos.slice(0, 5)) {
      try {
        const query = new URLSearchParams({ code: photo.orderId, id: photo.id, name: photo.name || `${photo.id}.jpg` });
        const result = await apiRequest(`/api/media?${query}`, { method: "POST", headers: { "content-type": photo.blob.type || "image/jpeg" }, body: photo.blob, timeout: 30_000 });
        await putPhoto({ ...photo, syncState: result.status === "sent" ? "synced" : "pending", syncedAt: result.status === "sent" ? Date.now() : null });
      } catch (error) {
        if (!syncErrorShown) { syncErrorShown = true; showError(error); }
        break;
      }
    }
  } finally {
    photoSyncRunning = false;
  }
}

async function syncPendingMediaDeletes() {
  if (!user || !navigator.onLine) return;
  const key = `media-deletes:${user.id}`;
  const ids = await getMeta(key) || [];
  const remaining = [];
  for (const id of ids) {
    try { await apiRequest(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    catch { remaining.push(id); }
  }
  await setMeta(key, remaining);
}

async function pullRemoteOrders({ sheet = false } = {}) {
  if (!user) return;
  if (!navigator.onLine) throw new Error("Cần kết nối mạng để đồng bộ danh sách đơn hàng.");
  if (sheet) assertWebhookRetryAllowed();
  if (sheet && sheetSyncRunning) return;
  if (sheet) { sheetSyncRunning = true; render(); }
  let pendingUpstream = 0;
  let syncError = null;
  let sessionConflicts = [];
  try {
    if (sheet) {
      const accountsRequest = refreshAccounts().catch(() => {});
      try { sessionConflicts = (await syncQueued()).sessionConflicts; }
      catch (error) { if (error.status === 401) throw error; syncError = error; }
      await accountsRequest;
      const cursorKey = `changeCursor:${user.id}`;
      if (await getMeta(cursorKey) == null) {
        const baseline = await apiRequest("/api/changes?baseline=1");
        await setMeta(cursorKey, baseline.cursor || "0");
      }
      const refreshed = await apiRequest("/api/refresh", { method: "POST", body: {}, timeout: 330_000 });
      pendingUpstream = Number(refreshed.pendingUpstream) || 0;
    }
    let cursor = null;
    let first = true;
    let shipperSnapshot = false;
    const visibleOrderIds = new Set();
    const params = new URLSearchParams({ limit: "100" });
    const [firstPage, sessions] = await Promise.all([
      apiRequest(`/api/orders?${params}`, { timeout: 60_000 }),
      apiRequest("/api/sessions", { timeout: 60_000 })
    ]);
    let page = firstPage;
    do {
      if (first) { shipperSnapshot = page.shipperSnapshot === true; first = false; }
      if (shipperSnapshot) for (const order of page.data || []) if (order?.id) visibleOrderIds.add(order.id);
      state = normalizeState(await mergeRemote({ orders: page.data || [], sheetAuthoritative: sheet }, user.id));
      lastPersistedState = cloneState(state);
      cursor = page.nextCursor;
      render();
      if (cursor) {
        const nextParams = new URLSearchParams({ limit: "100", cursor });
        page = await apiRequest(`/api/orders?${nextParams}`, { timeout: 60_000 });
      }
    } while (cursor);
    const remoteSessions = sessions.data || [];
    const conflictedSessionIds = new Set([
      ...sessionConflicts,
      ...state.sessions.filter(session => session.syncConflict).map(session => session.id)
    ]);
    state = normalizeState(await mergeRemote({ sessions: remoteSessions }, user.id));
    if (role === "shipper" && shipperSnapshot) {
      if (conflictedSessionIds.size) {
        state.sessions = state.sessions.map(session => conflictedSessionIds.has(session.id) ? { ...session, syncConflict: true } : session);
        if (conflictedSessionIds.has(state.activeSessionId)) state.activeSessionId = null;
        state = normalizeState(state);
      }
      for (const session of remoteSessions) {
        if (!conflictedSessionIds.has(session.id) && ["notStarted", "active", "paused"].includes(session.status) && !session.syncConflict) {
          for (const id of session.orderIds || []) visibleOrderIds.add(id);
        }
      }
      state.visibleOrderIds = [...visibleOrderIds];
      await writeStateSnapshot(state, user.id);
    }
    if (sheet) await pullChanges({ silent: true, allowDuringRefresh: true });
    lastPersistedState = cloneState(state);
    if (role === "admin") {
      try { conflictCount = (await apiRequest("/api/conflicts")).data.length; }
      catch { conflictCount = 0; }
    }
    lastSyncAt = Date.now();
    await setMeta(`lastSync:${user.id}`, lastSyncAt);
    if (sheet) resetWebhookRetryCooldown();
    render();
  } catch (error) {
    if (sheet) throw applyWebhookRetryCooldown(error);
    throw error;
  } finally {
    if (sheet) { sheetSyncRunning = false; render(); }
  }
  return { pendingUpstream, syncError, sessionConflicts };
}

async function pullChanges({ silent = false, allowDuringRefresh = false } = {}) {
  if (!user || !navigator.onLine || syncRunning || (sheetSyncRunning && !allowDuringRefresh)) return;
  if (changesPullRunning) {
    if (!allowDuringRefresh) return;
    while (changesPullRunning) await new Promise(resolve => setTimeout(resolve, 25));
    return pullChanges({ silent, allowDuringRefresh });
  }
  changesPullRunning = true;
  try {
    const cursorKey = `changeCursor:${user.id}`;
    let cursor = await getMeta(cursorKey);
    if (cursor == null) {
      const baseline = await apiRequest("/api/changes?baseline=1");
      await pullRemoteOrders();
      await setMeta(cursorKey, baseline.cursor || "0");
      return;
    }
    let changed = false;
    for (let pass = 0; pass < 10; pass++) {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const page = await apiRequest(`/api/changes?${params}`);
      if (page.orders?.length || page.sessions?.length) {
        state = normalizeState(await mergeRemote({ orders: page.orders || [], sessions: page.sessions || [] }, user.id));
        if (role === "shipper" && Array.isArray(state.visibleOrderIds)) {
          const visibleOrderIds = new Set(state.visibleOrderIds);
          for (const order of page.orders || []) if (order?.id) visibleOrderIds.add(order.id);
          for (const session of page.sessions || []) {
            if (!session.syncConflict && ["notStarted", "active", "paused"].includes(session.status)) {
              for (const id of session.orderIds || []) visibleOrderIds.add(id);
            }
          }
          state.visibleOrderIds = [...visibleOrderIds];
          await writeStateSnapshot(state, user.id);
        }
        lastPersistedState = cloneState(state);
        changed = true;
      }
      cursor = page.nextCursor || cursor;
      if (page.nextCursor) await setMeta(`changeCursor:${user.id}`, page.nextCursor);
      if (!page.hasMore) break;
    }
    if (!silent) syncErrorShown = false;
    if (changed) render();
  } catch (error) {
    if (error.status === 401) void logout();
    else if (!silent && !syncErrorShown) { syncErrorShown = true; showError(error); }
  } finally {
    changesPullRunning = false;
  }
}

async function syncOrderDetail(orderId) {
  if (!navigator.onLine || !user) throw new Error("Cần kết nối mạng để đồng bộ đơn hàng.");
  assertWebhookRetryAllowed();
  try {
    await syncQueued();
    const result = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}?refresh=1`);
    state = normalizeState(await mergeRemote({ orders: [result.data] }, user.id));
    lastPersistedState = cloneState(state);
    resetWebhookRetryCooldown();
    render();
  } catch (error) {
    throw applyWebhookRetryCooldown(error);
  }
}

function startNetworkMonitor() {
  clearInterval(networkProbeTimer);
  if (!user) return;
  void probeNetwork();
  networkProbeTimer = setInterval(() => {
    if (document.visibilityState === "visible") void probeNetwork();
  }, 12_000);
}

const validViewNames = new Set(["home", "orders", "sessions-overview", "session-create", "session", "add-orders", "order", "accounts"]);

async function refreshAccounts() {
  const result = await apiRequest("/api/auth?action=accounts");
  if (!Array.isArray(result.data) || !result.data.length) throw new Error("Danh sách tài khoản không hợp lệ.");
  accounts = Object.fromEntries(result.data.map(account => [account.id, account]));
  await setMeta("accountDirectory", result.data);
  if (user && accounts[user.id]) user = { ...user, ...accounts[user.id] };
}

async function activateUser(nextUser, { restoreView = true, refresh = true } = {}) {
  user = nextUser;
  role = nextUser.role;
  accounts[user.id] = { id: user.id, name: user.name, role: user.role };
  await setMeta("lastUser", user.id);
  state = normalizeState(await readState(emptyState(), user.id));
  lastPersistedState = cloneState(state);
  const savedStack = restoreView ? await getMeta(`lastView:${user.id}`) : null;
  viewStack = Array.isArray(savedStack) && savedStack.length && savedStack.every(view => validViewNames.has(view?.name))
    ? savedStack : [{ name: "home" }];
  lastSyncAt = await getMeta(`lastSync:${user.id}`) || null;
  appInitialized = true;
  render();
  startNetworkMonitor();
  if (refresh && navigator.onLine) {
    try { await pullRemoteOrders({ sheet: true }); }
    catch (error) { showError(error); }
  }
  if (navigator.onLine) scheduleQueuedSync(0);
}

async function restoreOfflineUser(userId) {
  const account = accounts[userId];
  if (!account) return false;
  await activateUser(account, { refresh: false });
  flash("Đang dùng dữ liệu đã lưu trên thiết bị · Ngoại tuyến");
  return true;
}

async function logout() {
  clearInterval(networkProbeTimer);
  try { await apiRequest("/api/auth/logout", { method: "POST", body: {} }); } catch { /* local logout must work offline */ }
  await setMeta("lastUser", null);
  role = null;
  user = null;
  modal = null;
  viewStack = [{ name: "login" }];
  render();
}

async function initializeApp() {
  try {
    inject();
    await openLocalDb();
    const cachedAccounts = await getMeta("accountDirectory");
    if (Array.isArray(cachedAccounts) && cachedAccounts.length) accounts = Object.fromEntries(cachedAccounts.map(account => [account.id, account]));
    const cachedUserId = await getMeta("lastUser");
    if (navigator.onLine) {
      try { await refreshAccounts(); } catch { /* retain the cached login directory while offline or during an API outage */ }
      try {
        const result = await apiRequest("/api/auth/session");
        if (result.user) { await activateUser(result.user); return; }
      } catch {
        if (cachedUserId && await restoreOfflineUser(cachedUserId)) return;
      }
    } else if (cachedUserId) {
      if (await restoreOfflineUser(cachedUserId)) return;
    }
    appInitialized = true;
    render();
  } catch (error) {
    appInitialized = true;
    render();
    showError(error || "Không thể khôi phục dữ liệu trên thiết bị.");
  }
}

function focusDragHandle(orderId) {
  requestAnimationFrame(() => document.querySelector(`[data-drag-order="${CSS.escape(orderId)}"]`)?.focus());
}

function updateContinueRouteButton() {
  const button = document.querySelector(".continue-route");
  const nextStop = document.querySelector(".route-stop.current .stop-card");
  if (!button || !nextStop) return;
  const bounds = nextStop.getBoundingClientRect();
  button.hidden = bounds.top < innerHeight && bounds.bottom > 0;
}

function announceOrderPosition(orderId, position) {
  const order = orderById(orderId);
  routeAnnouncement = `${order?.customer || orderId}, vị trí ${position + 1}.`;
}

async function reorderWithKeyboard(orderId, offset) {
  if (role !== "shipper") return;
  const session = activeSession();
  if (!session || !["notStarted", "active"].includes(session.status)) return;
  const index = session.orderIds.indexOf(orderId);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= session.orderIds.length) return;
  if (session.shifts?.[session.orderIds[targetIndex]] !== session.shifts?.[orderId]) return;
  try {
    const next = reorderOrderInSession(state, orderId, targetIndex);
    if (next === state) return;
    announceOrderPosition(orderId, targetIndex);
    await updateState(next, "Đã sắp xếp lộ trình.");
    focusDragHandle(orderId);
  } catch (error) { flash(error.message); }
}

function dragRows(parent) {
  return [...parent.querySelectorAll(":scope > [data-order-id]")];
}

function placeDraggedStop(clientY) {
  const drag = routeDrag;
  if (!drag?.active) return;
  const rows = dragRows(drag.parent).filter(row => row !== drag.element && row.dataset.completed !== "true");
  const before = rows.find(row => {
    const rect = row.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  if (before && drag.element.nextElementSibling !== before) drag.parent.insertBefore(drag.element, before);
  else if (!before && drag.element.nextElementSibling) drag.parent.append(drag.element);
}

function routeDragInBounds(drag) {
  const rect = drag.parent.getBoundingClientRect();
  return drag.lastX >= rect.left - 32 && drag.lastX <= rect.right + 32
    && drag.lastY >= rect.top - 40 && drag.lastY <= rect.bottom + 40;
}

function runRouteDragFrame() {
  routeDragFrame = null;
  const drag = routeDrag;
  if (!drag?.active) return;
  if (!drag.parent.isConnected || drag.element.parentElement !== drag.parent
    || (drag.element.dataset.shift || "Chưa phân ca") !== drag.parent.dataset.routeShift) {
    cancelRouteDrag();
    return;
  }
  const left = Math.max(8, Math.min(drag.lastX - drag.gripOffsetX, innerWidth - drag.ghostWidth - 8));
  const top = Math.max(8, Math.min(drag.lastY - 28, innerHeight - 76));
  drag.ghost.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  const edge = 80;
  const y = drag.lastY;
  const delta = y < edge ? -Math.min(16, Math.ceil((edge - y) / 5))
    : y > innerHeight - edge ? Math.min(16, Math.ceil((y - innerHeight + edge) / 5)) : 0;
  const previousScroll = window.scrollY;
  if (delta && routeDragInBounds(drag)) window.scrollBy(0, delta);
  if (routeDragInBounds(drag)) placeDraggedStop(y);
  if (window.scrollY !== previousScroll) routeDragFrame = requestAnimationFrame(runRouteDragFrame);
}

function scheduleRouteDragFrame() {
  if (!routeDragFrame) routeDragFrame = requestAnimationFrame(runRouteDragFrame);
}

function activateRouteDrag(drag) {
  const order = orderById(drag.id);
  const rect = drag.element.getBoundingClientRect();
  const ghost = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("small");
  title.textContent = `${order?.customer || drag.id} · ${drag.id}`;
  detail.textContent = order ? `${order.address || "Chưa có địa chỉ"} · ${money(order.total)}` : "";
  ghost.className = "route-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.append(title, detail);
  drag.ghostWidth = Math.min(rect.width, innerWidth - 16);
  drag.gripOffsetX = Math.min(drag.startX - rect.left, drag.ghostWidth - 16);
  ghost.style.width = `${drag.ghostWidth}px`;
  document.body.append(ghost);
  drag.ghost = ghost;
  drag.active = true;
  drag.element.classList.add("dragging");
  drag.parent.classList.add("route-drag-active");
  drag.handle.classList.add("dragging");
  document.body.classList.add("route-dragging");
  window.getSelection()?.removeAllRanges();
  scheduleRouteDragFrame();
}

function cancelRouteDrag(restore = true) {
  const drag = routeDrag;
  if (!drag) return;
  routeDrag = null;
  clearTimeout(drag.holdTimer);
  if (routeDragFrame) cancelAnimationFrame(routeDragFrame);
  routeDragFrame = null;
  if (restore && drag.element.parentElement === drag.parent && drag.element.nextElementSibling !== drag.originalNext) {
    drag.parent.insertBefore(drag.element, drag.originalNext?.parentElement === drag.parent ? drag.originalNext : null);
  }
  drag.ghost?.remove();
  drag.element.classList.remove("dragging");
  drag.parent.classList.remove("route-drag-active");
  drag.handle.classList.remove("dragging");
  document.body.classList.remove("route-dragging");
  if (drag.pointerId != null && app.hasPointerCapture?.(drag.pointerId)) app.releasePointerCapture(drag.pointerId);
}

function beginRouteDrag(event) {
  if (event.pointerType === "touch") return;
  const handle = event.target.closest("[data-drag-order]");
  if (routeDrag || !handle || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
  const session = activeSession();
  const element = handle.closest("[data-order-id]");
  const parent = element?.parentElement;
  if (role !== "shipper" || !session || !["notStarted", "active"].includes(session.status) || !element || !parent?.dataset.routeShift || element.dataset.completed === "true") return;
  event.preventDefault();
  edgeTouch = null;
  routeDrag = { id: handle.dataset.dragOrder, handle, element, parent, originalNext: element.nextElementSibling,
    pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, active: false };
  app.setPointerCapture?.(event.pointerId);
}

function beginTouchRouteDrag(event) {
  const handle = event.target.closest("[data-drag-order]");
  if (routeDrag || !handle || event.touches.length !== 1) return;
  const session = activeSession();
  const element = handle.closest("[data-order-id]");
  const parent = element?.parentElement;
  if (role !== "shipper" || !session || !["notStarted", "active"].includes(session.status) || !element || !parent?.dataset.routeShift || element.dataset.completed === "true") return;
  const touch = event.touches[0];
  edgeTouch = null;
  const drag = routeDrag = { id: handle.dataset.dragOrder, handle, element, parent, originalNext: element.nextElementSibling,
    pointerId: null, touchId: touch.identifier, touch: true, startX: touch.clientX, startY: touch.clientY,
    lastX: touch.clientX, lastY: touch.clientY, active: false };
  drag.holdTimer = setTimeout(() => {
    if (routeDrag === drag) activateRouteDrag(drag);
  }, 1500);
}

function updateRouteDrag(event) {
  if (!routeDrag || event.pointerId !== routeDrag.pointerId) return;
  event.preventDefault();
  routeDrag.lastX = event.clientX;
  routeDrag.lastY = event.clientY;
  if (!routeDrag.active && Math.hypot(event.clientX - routeDrag.startX, event.clientY - routeDrag.startY) >= 8) activateRouteDrag(routeDrag);
  if (routeDrag.active) scheduleRouteDragFrame();
}

function updateTouchRouteDrag(event) {
  const drag = routeDrag;
  if (!drag?.touch) return;
  if (event.touches.length !== 1) { cancelRouteDrag(); return; }
  const touch = [...event.touches].find(item => item.identifier === drag.touchId);
  if (!touch) { cancelRouteDrag(); return; }
  if (!drag.active) {
    if (Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) >= 8) cancelRouteDrag();
    return;
  }
  event.preventDefault();
  drag.lastX = touch.clientX;
  drag.lastY = touch.clientY;
  scheduleRouteDragFrame();
}

async function finishRouteDrag(event, cancelled = false) {
  if (!routeDrag || event.pointerId !== routeDrag.pointerId) return;
  const drag = routeDrag;
  drag.lastX = event.clientX ?? drag.lastX;
  drag.lastY = event.clientY ?? drag.lastY;
  if (!cancelled && drag.active && routeDragInBounds(drag)) placeDraggedStop(drag.lastY);
  const valid = !cancelled && drag.active && routeDragInBounds(drag);
  const session = activeSession();
  const rowIds = dragRows(drag.parent).map(row => row.dataset.orderId);
  const shiftSlots = session?.orderIds.map((id, index) => ({ id, index }))
    .filter(item => (session.shifts?.[item.id] || "Chưa phân ca") === drag.parent.dataset.routeShift && !session.legs[item.id]?.completedAt)
    .map(item => item.index) || [];
  const localIndex = rowIds.indexOf(drag.id);
  const targetIndex = shiftSlots[localIndex] ?? -1;
  const originalIndex = session?.orderIds.indexOf(drag.id) ?? -1;
  cancelRouteDrag(!valid || targetIndex < 0 || targetIndex === originalIndex);
  if (!valid || targetIndex < 0 || targetIndex === originalIndex) return;
  try {
    const next = reorderOrderInSession(state, drag.id, targetIndex);
    if (next === state) { render(); return; }
    announceOrderPosition(drag.id, targetIndex);
    await updateState(next, "Đã sắp xếp lộ trình.");
  } catch (error) { render(); flash(error.message); }
}

function finishTouchRouteDrag(event, cancelled = false) {
  const drag = routeDrag;
  if (!drag?.touch) return;
  const touch = [...event.changedTouches].find(item => item.identifier === drag.touchId);
  if (cancelled || !touch) { cancelRouteDrag(); return; }
  void finishRouteDrag({ pointerId: null, clientX: touch.clientX, clientY: touch.clientY });
}

function setButtonBusy(button, busy) {
  if (busy) {
    if (button.disabled) return false;
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Đang xử lý</span>';
    return true;
  }
  if (!button.dataset.originalHtml) return false;
  button.innerHTML = button.dataset.originalHtml;
  delete button.dataset.originalHtml;
  button.disabled = false;
  button.removeAttribute("aria-busy");
  return true;
}

async function deliverOrder(orderId) {
  const order = orderById(orderId);
  const session = order?.sessionId ? activeSession() : null;
  if (!order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { flash("Tài khoản này không có quyền cập nhật đơn hàng."); return; }
  if (!order || order.deliveryStatus !== "Đang giao hàng") { flash("Đơn hàng không còn ở trạng thái đang giao."); return; }
  if (dueAmount(order) > 0) {
    modal = { type: "deliver-unpaid", orderId };
    render();
    return;
  }
  try {
    const next = markDelivered(state, orderId);
    if (!next.activeSessionId && order.sessionId) showSessionHistory(order.sessionId);
    await updateState(next, "Đã ghi nhận giao hàng.");
    await syncDeliveryUpdate();
  } catch (error) { flash(error.message); }
}

async function syncDeliveryUpdate() {
  if (!navigator.onLine || syncRunning || sheetSyncRunning) return;
  try {
    const result = await syncQueued();
    if (result.webhookPending) flash(`Đã lưu thay đổi · webhook n8n đang cập nhật ${result.webhookPending} đơn.`);
    else if (result.confirmedOrders) flash(`Google Sheet đã xác nhận ${result.confirmedOrders} đơn.`);
  } catch (error) {
    if (error.status === 401) { void logout(); return; }
    if (!syncErrorShown) { syncErrorShown = true; showError(error); }
  }
}

function openPayment(orderId) {
  const order = orderById(orderId);
  const session = order?.sessionId ? activeSession() : null;
  if (!order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { flash("Tài khoản này không có quyền cập nhật thanh toán."); return; }
  if (!order || dueAmount(order) <= 0) { flash("Đơn hàng không còn khoản cần thu."); return; }
  modal = { type: "payment", orderId, method: null };
  render();
}

const getOrderPhotos = loadOrderPhotos;
const putPhoto = storeLocalPhoto;

async function deletePhoto(id) {
  const photos = await getOrderPhotos(currentView().orderId);
  const photo = photos.find(item => item.id === id);
  if (!photo) return;
  await deleteLocalPhoto(id);
  if (photo.remoteId) {
    const key = `media-deletes:${user.id}`;
    await setMeta(key, [...new Set([...(await getMeta(key) || []), photo.remoteId])]);
  }
}

async function hydratePhotos(orderId) {
  if (!document.querySelector(`[data-photo-order="${CSS.escape(orderId)}"]`)) return;
  try {
    let photos = await getOrderPhotos(orderId);
    if (navigator.onLine && user) {
      try {
        const remote = await apiRequest(`/api/media?code=${encodeURIComponent(orderId)}`);
        for (const item of remote.data || []) {
          const existing = photos.find(photo => photo.id === item.id);
          if (existing) {
            existing.remoteId = item.id;
            existing.syncState = item.status === "sent" ? "synced" : "pending";
            await putPhoto(existing);
            continue;
          }
          const response = await fetch(`/api/media/${encodeURIComponent(item.id)}`, { credentials: "same-origin", cache: "no-store" });
          if (!response.ok) continue;
          const photo = { ...item, orderId, remoteId: item.id, syncState: item.status === "sent" ? "synced" : "pending", blob: await response.blob(), createdAt: new Date(item.createdAt).valueOf() || Date.now() };
          await putPhoto(photo);
          photos.push(photo);
        }
      } catch { /* keep the local photo cache available offline */ }
    }
    photos.sort((a, b) => a.createdAt - b.createdAt);
    const target = document.querySelector(`[data-photo-order="${CSS.escape(orderId)}"]`);
    if (!target) return;
    if (!target.isConnected) return;
    const count = target.closest(".photo-disclosure")?.querySelector("[data-photo-count]");
    if (count) count.textContent = `${photos.length}/5`;
    if (!photos.length) { target.innerHTML = '<span class="fine-print">Chưa có ảnh.</span>'; return; }
    target.innerHTML = photos.map(photo => {
      if (!photoUrls.has(photo.id)) photoUrls.set(photo.id, URL.createObjectURL(photo.blob));
      const locked = activeSession()?.status === "paused";
      return `<div class="photo-tile"><img src="${photoUrls.get(photo.id)}" alt="Ảnh xác nhận"/><button class="photo-remove" data-action="delete-photo" data-id="${safe(photo.id)}" aria-label="Xóa ảnh" ${locked ? "disabled" : ""}>${icon("close", 15)}</button></div>`;
    }).join("");
  } catch {
    const target = document.querySelector(`[data-photo-order="${CSS.escape(orderId)}"]`);
    if (target?.isConnected) target.innerHTML = '<span class="fine-print">Không tải được ảnh đã lưu.</span>';
  }
}

async function resizeImage(file) {
  try {
    return await imageCompression(file, { maxSizeMB: 0.8, maxWidthOrHeight: 1600, useWebWorker: true, fileType: "image/jpeg" });
  } catch { /* browser canvas fallback below */ }
  if (typeof createImageBitmap !== "function") return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { return file; }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob || file), "image/jpeg", 0.84));
}

async function savePhotoFiles(orderId, files) {
  if (activeSession()?.status === "paused") { flash("Tiếp tục phiên trước khi thêm ảnh."); return; }
  if (!files.length) return;
  try {
    const existing = await getOrderPhotos(orderId);
    const validFiles = files.filter(file => {
      if (!file.type.startsWith("image/")) { flash("Chỉ nhận tệp hình ảnh."); return false; }
      // shortcut: reject photos over 15 MB before resizing, raise the cap if users need RAW originals.
      if (file.size > 15 * 1024 * 1024) { flash("Ảnh cần nhỏ hơn 15 MB."); return false; }
      return true;
    });
    if (!validFiles.length) return;
    const allowedCount = allowedPhotoCount(existing.length, validFiles.length);
    if (!allowedCount) { flash("Mỗi đơn chỉ lưu tối đa 5 ảnh."); return; }
    let saved = 0;
    for (const file of validFiles.slice(0, allowedCount)) {
      try {
        const blob = await resizeImage(file);
        if (blob.size > 2 * 1024 * 1024) throw new Error("Ảnh sau khi nén vẫn lớn hơn 2 MB.");
        const photo = { id: crypto.randomUUID(), orderId, name: file.name, blob, createdAt: Date.now(), syncState: "pending" };
        await putPhoto(photo);
        saved++;
      } catch (error) { flash(error.message || `Không đọc được ảnh ${file.name}.`); }
    }
    await hydratePhotos(orderId);
    if (validFiles.length > allowedCount) flash("Chỉ 5 ảnh được lưu cho mỗi đơn.");
    else if (saved) flash(`${saved} ảnh đã lưu trên thiết bị.`);
  } catch { flash("Không lưu được ảnh trên thiết bị này."); }
}

async function saveProofFiles(input) {
  const files = [...(input.files || [])];
  input.value = "";
  await savePhotoFiles(currentView().orderId, files);
}

async function openCamera() {
  if (activeSession()?.status === "paused") { flash("Tiếp tục phiên trước khi chụp ảnh."); return; }
  modal = { type: "camera" };
  render();
  try {
    const video = document.querySelector("#camera-video");
    const canvas = document.querySelector("#camera-canvas");
    webcam = new Webcam(video, "environment", canvas);
    await webcam.start();
    const button = document.querySelector('[data-action="capture-photo"]');
    if (button) button.disabled = false;
  } catch {
    if (webcam) webcam.stop();
    webcam = null;
    modal = null;
    render();
    document.querySelector("#camera-input")?.click();
    flash("Không mở được camera. Hãy chọn ảnh từ thiết bị.");
  }
}

async function capturePhoto() {
  if (!webcam) return;
  const dataUrl = webcam.snap();
  webcam.stop();
  webcam = null;
  modal = null;
  render();
  const response = await fetch(dataUrl);
  const file = new File([await response.blob()], `mealfit-${Date.now()}.jpg`, { type: "image/jpeg" });
  await savePhotoFiles(currentView().orderId, [file]);
}

app.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (stateWriteRunning) return;
  if (button.classList.contains("stop-card") || button.classList.contains("session-order")) {
    if (event.target.closest("button, a, select, input, textarea, summary")) return;
  }
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "backdrop" && event.target === button) { clearInterval(retryCountdownTimer); retryCountdownTimer = null; modal = null; render(); return; }
  if (action === "test-api") {
    if (!setButtonBusy(button, true)) return;
    try {
      const result = await apiRequest("/api/diagnostics", { method: "GET", timeout: 20_000 });
      modal = { type: "api-check", result };
      render();
    } catch (error) { showError(error); }
    finally { if (button.isConnected) setButtonBusy(button, false); }
    return;
  }
  if (action === "back") { back(); return; }
  if (action === "logout") { await logout(); return; }
  if (action === "refresh") {
    if (syncRunning || sheetSyncRunning || orderSyncRunningId) return;
    if (!setButtonBusy(button, true)) return;
    try {
      const result = await pullRemoteOrders({ sheet: true });
      void syncQueuedAppLog();
      if (result.syncError) showError(result.syncError);
      else if (result.sessionConflicts.length) flash("Đã làm mới danh sách đơn. Phiên cũ được giữ trong lịch sử trên thiết bị.");
      else if (result.conflicts) flash(`Đã tải dữ liệu từ Sheet · còn ${result.conflicts} xung đột cần Admin xử lý.`);
      else flash(result.pendingUpstream ? `Đã làm mới từ Sheet · còn ${result.pendingUpstream} cập nhật chưa được webhook xác nhận.` : "Đã làm mới dữ liệu từ Sheet qua webhook n8n.");
    }
    catch (error) { showError(error); }
    finally { setButtonBusy(button, false); }
    return;
  }
  if (action === "refresh-order") {
    if (syncRunning || sheetSyncRunning || orderSyncRunningId) return;
    orderSyncRunningId = id;
    render();
    try { await syncOrderDetail(id); flash(`Đã đồng bộ đơn ${id}.`); }
    catch (error) { if (error.status === 401) void logout(); else showError(error); }
    finally { orderSyncRunningId = null; render(); }
    return;
  }
  if (action === "retry-sync") {
    if (syncRunning || sheetSyncRunning || orderSyncRunningId) return;
    const detailOrderId = currentView()?.name === "order" ? currentView().orderId : null;
    if (detailOrderId) orderSyncRunningId = detailOrderId;
    modal = null; render();
    try {
      if (detailOrderId) { await syncOrderDetail(detailOrderId); flash(`Đã đồng bộ đơn ${detailOrderId}.`); }
      else {
        const result = await pullRemoteOrders({ sheet: true });
        void syncQueuedAppLog();
        if (result.syncError) showError(result.syncError);
        else if (result.sessionConflicts.length) flash("Đã làm mới danh sách đơn. Phiên cũ được giữ trong lịch sử trên thiết bị.");
        else if (result.conflicts) flash(`Đã tải dữ liệu từ Sheet · còn ${result.conflicts} xung đột cần Admin xử lý.`);
        else flash(result.pendingUpstream ? `Đã làm mới từ Sheet · còn ${result.pendingUpstream} cập nhật chưa được webhook xác nhận.` : "Đồng bộ từ Sheet qua webhook n8n đã hoàn tất.");
      }
    } catch (error) { if (error.status === 401) void logout(); else showError(error); }
    finally { if (detailOrderId) { orderSyncRunningId = null; render(); } }
    return;
  }
  if (action === "open-conflicts") {
    try {
      const result = await apiRequest("/api/conflicts");
      modal = { type: "conflicts", items: (result.data || []).map(item => ({ ...item, conflictId: item.id, orderCode: item.code })) };
    } catch (error) { modal = { type: "error", message: error.message }; }
    render(); return;
  }
  if (action === "resolve-conflict") {
    if (!setButtonBusy(button, true)) return;
    try {
      await apiRequest("/api/conflicts", { method: "POST", body: { id, resolution: button.dataset.choice } });
      conflictCount = Math.max(0, conflictCount - 1);
      const result = await apiRequest("/api/conflicts");
      modal = { type: "conflicts", items: (result.data || []).map(item => ({ ...item, conflictId: item.id, orderCode: item.code })) };
      render();
      await pullChanges();
    } catch (error) { showError(error); }
    return;
  }
  if (action === "close-camera") { webcam?.stop(); webcam = null; modal = null; render(); return; }
  if (action === "capture-photo") {
    if (!setButtonBusy(button, true)) return;
    try { await capturePhoto(); } catch (error) { showError(error); webcam?.stop(); webcam = null; modal = null; render(); }
    return;
  }
  if (action === "open-orders") { orderFilter = "Tất cả"; navigate({ name: "orders" }); return; }
  if (action === "open-activity") {
    if (role !== "admin") { flash("Chỉ admin được xem lịch sử hệ thống."); return; }
    activityKind = "api"; navigate({ name: "activity" }); void loadActivity(true); return;
  }
  if (action === "open-accounts") {
    if (role !== "admin") { flash("Chỉ admin được quản lý tài khoản."); return; }
    navigate({ name: "accounts" }); return;
  }
  if (action === "activity-kind") { activityKind = button.dataset.kind === "activity" ? "activity" : "api"; void loadActivity(true); return; }
  if (action === "load-more-activity") { void loadActivity(false); return; }
  if (action === "reload-activity") { void loadActivity(true); return; }
  if (action === "open-dishes") { navigate({ name: "dishes" }); return; }
  if (action === "open-delivery") {
    if (role === "shipper") {
      if (activeSession()) { sessionTab = "route"; navigate({ name: "session" }); }
      else { navigate({ name: "session" }); }
    } else if (isStaff()) navigate({ name: "sessions-overview" });
    else flash("Tài khoản này không có quyền giao hàng.");
    return;
  }
  if (action === "open-session-overview") { navigate({ name: "sessions-overview" }); return; }
  if (action === "open-session") { sessionTab = "route"; navigate({ name: "session" }); return; }
  if (action === "open-session-history") { sessionTab = "route"; navigate({ name: "session", sessionId: id }); return; }
  if (action === "open-order") { navigate({ name: "order", orderId: id, fromSession: false }); return; }
  if (action === "open-order-session") { navigate({ name: "order", orderId: id, fromSession: true }); return; }
  if (action === "filter-orders") { orderFilter = button.dataset.filter; orderListLimit = 50; render(); return; }
  if (action === "load-more-orders") { orderListLimit += 50; render(); return; }
  if (action === "load-more-route-orders") { routeSelectionLimit += 50; render(); return; }
  if (action === "select-single-order") { selectedOrderId = selectedOrderId === id ? null : id; render(); return; }
  if (action === "clear-selection-note") {
    const notes = button.dataset.flow === "session" ? (window._sessionNotes || {}) : (window._addNotes || {});
    notes[id] = "";
    if (button.dataset.flow === "session") window._sessionNotes = notes;
    else window._addNotes = notes;
    render(); return;
  }
  if (action === "clear-selection-map") {
    const links = button.dataset.flow === "session" ? (window._sessionMaps || {}) : (window._addMaps || {});
    links[id] = "";
    if (button.dataset.flow === "session") window._sessionMaps = links;
    else window._addMaps = links;
    render(); return;
  }
  if (action === "edit-detail-note") {
    const order = orderById(id);
    const session = activeSession();
    if (!order || (!isStaff() && role !== "shipper") || (role === "shipper" && session?.status === "paused" && session.id === order.sessionId)) { flash("Không thể sửa ghi chú hoặc vị trí lúc này."); return; }
    orderNoteEditId = id; render(); return;
  }
  if (action === "save-detail-note") {
    const order = orderById(id);
    const session = activeSession();
    if (!order || (!isStaff() && role !== "shipper") || (role === "shipper" && session?.status === "paused" && session.id === order.sessionId)) { flash("Không thể sửa ghi chú hoặc vị trí lúc này."); return; }
    try {
      const note = document.querySelector("[data-detail-note]")?.value || "";
      const mapsLink = document.querySelector("[data-detail-maps]")?.value || "";
      const next = setOrderMapsLink(setOrderNote(state, id, note), id, mapsLink);
      orderNoteEditId = null;
      await updateState(next, note.trim() || mapsLink.trim() ? "Đã lưu ghi chú và vị trí đơn hàng." : "Đã xóa ghi chú và vị trí đơn hàng.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "edit-route-note") { routeNoteOrderId = id; render(); return; }
  if (action === "save-route-note") {
    const session = activeSession();
    if (role !== "shipper" || !session || !["active", "notStarted"].includes(session.status) || !session.orderIds.includes(id)) { flash("Không thể sửa ghi chú trong phiên này."); return; }
    try {
      const note = document.querySelector("[data-route-note]")?.value || "";
      const mapsLink = document.querySelector("[data-route-maps]")?.value || "";
      const next = setOrderMapsLink(setOrderNote(state, id, note), id, mapsLink);
      routeNoteOrderId = null;
      await updateState(next, note.trim() || mapsLink.trim() ? "Đã lưu ghi chú và vị trí đơn hàng." : "Đã xóa ghi chú và vị trí đơn hàng.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "create-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể tạo phiên giao hàng."); return; }
    try {
      const selected = (window._sessionSelection || []).filter(id => isAssignedPendingOrder(orderById(id), user?.id));
      await updateState(createSession(state, selected, window._sessionShifts || {}, Date.now(), window._sessionNotes || {}, window._sessionMaps || {}), "Phiên đã tạo · Sắp xếp tuyến trước khi bắt đầu.");
      window._sessionSelection = [];
      window._sessionShifts = {};
      window._sessionNotes = {};
      window._sessionMaps = {};
      viewStack[viewStack.length - 1] = { name: "session" };
      persistLastView();
      sessionTab = "route"; render();
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "new-session") {
    if (role !== "shipper") { flash("Phiên giao hàng dành cho shipper."); return; }
    if (activeSession()) { flash("Hoàn tất phiên hiện tại trước khi tạo phiên mới."); return; }
    if (currentView().name === "session" && viewStack.length > 1) viewStack.pop();
    window._sessionSelection = []; window._sessionShifts = {}; window._sessionNotes = {}; window._sessionMaps = {}; routeSelectionLimit = 50; sessionDefaultShift = "Sáng"; navigate({ name: "session-create" }); return;
  }
  if (action === "toggle-session-order") {
    const selected = new Set(window._sessionSelection || []);
    const shifts = window._sessionShifts || {};
    if (selected.has(id)) { selected.delete(id); delete shifts[id]; }
    else { selected.add(id); shifts[id] = sessionDefaultShift; const notes = window._sessionNotes ||= {}; if (!Object.hasOwn(notes, id)) notes[id] = orderById(id)?.note || ""; const maps = window._sessionMaps ||= {}; if (!Object.hasOwn(maps, id)) maps[id] = orderById(id)?.mapsLink || ""; }
    window._sessionSelection = [...selected]; render(); return;
  }
  if (action === "start-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể bắt đầu phiên."); return; }
    try {
      await updateState(startSession(state), "Bắt đầu giao hàng.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "pause-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể tạm dừng phiên."); return; }
    try { await updateState(pauseSession(state), "Đã tạm dừng lộ trình."); } catch (error) { flash(error.message); }
    return;
  }
  if (action === "resume-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể tiếp tục phiên."); return; }
    try { await updateState(resumeSession(state), "Đã tiếp tục lộ trình."); } catch (error) { flash(error.message); }
    return;
  }
  if (action === "cancel-session") {
    if (role !== "shipper" || !activeSession()) { flash("Chỉ shipper có thể hủy phiên đang mở."); return; }
    modal = { type: "cancel-session" }; render(); return;
  }
  if (action === "delete-session") {
    const session = state.sessions.find(item => item.id === id);
    const allowed = role === "admin" || (role === "shipper" && (!session?.ownerId || session.ownerId === user?.id));
    if (!session || !allowed) { flash("Tài khoản này không có quyền xóa phiên."); return; }
    modal = { type: "delete-session", sessionId: id }; render(); return;
  }
  if (action === "confirm-delete-session") {
    const sessionId = modal?.sessionId;
    if (!sessionId || (role !== "admin" && role !== "shipper")) { modal = null; render(); flash("Tài khoản này không có quyền xóa phiên."); return; }
    try {
      const next = deleteSession(state, sessionId);
      modal = null;
      await updateState(next, "Đã xóa phiên lộ trình.");
    } catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "confirm-cancel-session") {
    if (role !== "shipper") { modal = null; render(); flash("Chỉ shipper có thể hủy phiên."); return; }
    try {
      const sessionId = activeSession()?.id;
      const next = cancelSession(state);
      if (sessionId) showSessionHistory(sessionId);
      modal = null; await updateState(next, "Đã hủy lộ trình.");
    }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "session-tab") { sessionTab = button.dataset.tab; render(); return; }
  if (action === "continue-route") {
    const target = document.querySelector(".route-stop.current .stop-card");
    if (!target) return;
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    target.scrollIntoView({ behavior, block: "center" });
    target.focus({ preventScroll: true });
    updateContinueRouteButton();
    return;
  }
  if (action === "remove-stop") { if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; } modal = { type: "remove-stop", orderId: id }; render(); return; }
  if (action === "confirm-remove-stop") {
    if (role !== "shipper") { modal = null; render(); flash("Chỉ shipper có thể chỉnh sửa phiên."); return; }
    try { await updateState(removeOrderFromSession(state, modal.orderId), "Đơn đã trở về danh sách chưa giao."); modal = null; render(); }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "reopen-order-status") {
    const order = orderById(id);
    if (!order || order.deliveryStatus !== "Đã giao hàng" || (!isStaff() && role !== "shipper")) { flash("Tài khoản này không thể sửa trạng thái đơn."); return; }
    if (activeSession()?.status === "paused") { flash("Tiếp tục phiên trước khi sửa đơn."); return; }
    modal = { type: "reopen-order", orderId: id, shift: state.sessions.find(session => session.id === order.sessionId)?.shifts?.[id] || "Sáng" }; render(); return;
  }
  if (action === "confirm-reopen-order") {
    const orderId = modal?.orderId;
    const deliveryStatus = button.dataset.status;
    if ((!isStaff() && role !== "shipper") || !orderId) { modal = null; render(); flash("Tài khoản này không thể sửa trạng thái đơn."); return; }
    try {
      const next = reopenDeliveredOrder(state, orderId, deliveryStatus, document.querySelector("#reopen-shift")?.value || modal.shift);
      modal = null;
      await updateState(next, deliveryStatus === "Đang giao hàng" ? "Đơn đã được thêm lại vào tuyến." : "Đơn đã trở về danh sách chưa giao.");
      const readded = activeSession() && orderById(orderId)?.sessionId === activeSession().id;
      if (readded) flash("Đơn đã được thêm cuối ca vào phiên hiện có.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "add-session-orders") { if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; } window._addSelection = []; window._addNotes = {}; window._addMaps = {}; routeSelectionLimit = 50; navigate({ name: "add-orders" }); return; }
  if (action === "toggle-add-order") {
    const selected = new Set(window._addSelection || []);
    if (selected.has(id)) selected.delete(id);
    else { selected.add(id); const notes = window._addNotes ||= {}; if (!Object.hasOwn(notes, id)) notes[id] = orderById(id)?.note || ""; const maps = window._addMaps ||= {}; if (!Object.hasOwn(maps, id)) maps[id] = orderById(id)?.mapsLink || ""; }
    window._addSelection = [...selected]; render(); return;
  }
  if (action === "confirm-add-orders") {
    if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; }
    try {
      const selected = (window._addSelection || []).filter(id => isAssignedPendingOrder(orderById(id), user?.id));
      await updateState(addOrdersToSession(state, selected, addOrdersShift, window._addNotes || {}, window._addMaps || {}), "Đã thêm đơn vào phiên.");
      window._addSelection = []; window._addNotes = {}; window._addMaps = {}; viewStack.pop(); sessionTab = "route"; render();
      persistLastView();
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "pay-order") { openPayment(id); return; }
  if (action === "show-payment-qr") { modal = { type: "payment-qr", orderId: id }; render(); return; }
  if (action === "choose-payment") { modal.method = button.dataset.method; render(); return; }
  if (action === "confirm-payment") {
    if (modal?.method === "Chuyển khoản") { modal = { type: "payment-qr", orderId: modal.orderId, confirmPayment: true }; render(); return; }
    const order = modal && orderById(modal.orderId);
    const session = order?.sessionId ? activeSession() : null;
    if (!role || !order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { modal = null; render(); flash("Tài khoản này không có quyền cập nhật thanh toán."); return; }
    try {
      const next = markPaid(state, modal.orderId, modal.method);
      modal = null;
      await updateState(next, "Đã ghi nhận thanh toán.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "back-to-payment") { modal = { type: "payment", orderId: modal.orderId, method: "Chuyển khoản" }; render(); return; }
  if (action === "confirm-transfer-payment") {
    const order = modal && orderById(modal.orderId);
    const session = order?.sessionId ? activeSession() : null;
    if (!role || !order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { modal = null; render(); flash("Tài khoản này không có quyền cập nhật thanh toán."); return; }
    try {
      const next = markPaid(state, modal.orderId, "Chuyển khoản");
      modal = null;
      await updateState(next, "Đã ghi nhận thanh toán chuyển khoản.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "choose-orphan-status") {
    const order = orderById(id);
    if (role !== "shipper" || !isOrphanInTransitOrder(state, order, user?.id)) { flash("Đơn không còn thuộc danh sách xử lý của bạn."); return; }
    modal = { type: "orphan-delivery", orderId: id, status: button.dataset.status };
    render(); return;
  }
  if (action === "confirm-orphan-status") {
    const { orderId, status } = modal?.type === "orphan-delivery" ? modal : {};
    if (role !== "shipper" || !orderId) { modal = null; render(); flash("Tài khoản này không thể sửa trạng thái đơn."); return; }
    try {
      const next = resolveOrphanDelivery(state, orderId, user?.id, status);
      modal = null;
      const message = status === "Chưa giao hàng" ? "Đơn đã trở về danh sách chờ giao."
        : status === "Đã giao hàng" ? "Đã đánh dấu đơn đã giao."
          : "Đã hủy đơn.";
      await updateState(next, message);
    } catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "deliver-order") { await deliverOrder(id); return; }
  if (action === "confirm-delivery-unpaid") {
    const orderId = modal.orderId;
    const order = orderById(orderId);
    const session = order?.sessionId ? activeSession() : null;
    if (!order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { modal = null; render(); flash("Tài khoản này không có quyền cập nhật đơn hàng."); return; }
    try {
      const next = markDelivered(state, orderId);
      if (!next.activeSessionId && order.sessionId) showSessionHistory(order.sessionId);
      modal = null;
      await updateState(next, "Đã giao hàng, khoản phải thu vẫn được ghi nhận.");
      await syncDeliveryUpdate();
    }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "close-modal") { clearInterval(retryCountdownTimer); retryCountdownTimer = null; modal = null; render(); return; }
  if (action === "choose-photo") {
    if (button.dataset.source === "camera") await openCamera();
    else document.querySelector("#upload-input")?.click();
    return;
  }
  if (action === "delete-photo") {
    if (activeSession()?.status === "paused") { flash("Tiếp tục phiên trước khi thay đổi ảnh."); return; }
    if (!setButtonBusy(button, true)) return;
    try { await deletePhoto(id); if (photoUrls.has(id)) { URL.revokeObjectURL(photoUrls.get(id)); photoUrls.delete(id); } await hydratePhotos(currentView().orderId); flash("Đã xóa ảnh."); }
    catch { flash("Không xóa được ảnh."); }
    finally { setButtonBusy(button, false); }
    return;
  }
});

app.addEventListener("pointerdown", beginRouteDrag);
app.addEventListener("pointermove", updateRouteDrag);
app.addEventListener("pointerup", event => finishRouteDrag(event));
app.addEventListener("pointercancel", event => finishRouteDrag(event, true));
app.addEventListener("lostpointercapture", event => finishRouteDrag(event, true));
app.addEventListener("touchstart", beginTouchRouteDrag, { passive: true });
app.addEventListener("touchmove", updateTouchRouteDrag, { passive: false });
app.addEventListener("touchend", event => finishTouchRouteDrag(event));
app.addEventListener("touchcancel", event => finishTouchRouteDrag(event, true), { passive: true });
app.addEventListener("selectstart", event => {
  if (routeDrag || event.target.closest("[data-drag-order]")) event.preventDefault();
});
app.addEventListener("contextmenu", event => {
  if (routeDrag || event.target.closest("[data-drag-order]")) event.preventDefault();
});
app.addEventListener("dragstart", event => {
  if (routeDrag || event.target.closest("[data-drag-order]")) event.preventDefault();
});
window.addEventListener("blur", () => cancelRouteDrag());
document.addEventListener("visibilitychange", () => { if (document.hidden) cancelRouteDrag(); });
window.addEventListener("keydown", event => {
  if (event.key === "Escape" && routeDrag) { event.preventDefault(); cancelRouteDrag(); }
});
window.addEventListener("scroll", updateContinueRouteButton, { passive: true });
window.addEventListener("resize", updateContinueRouteButton);
app.addEventListener("keydown", event => {
  const handle = event.target.closest("[data-drag-order]");
  if (!handle) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    reorderWithKeyboard(handle.dataset.dragOrder, event.key === "ArrowUp" ? -1 : 1);
  }
});

app.addEventListener("change", async event => {
  if (event.target.matches("#default-shift")) {
    sessionDefaultShift = event.target.value;
    event.target.closest("details")?.querySelector("[data-default-shift-label]")?.replaceChildren(document.createTextNode(event.target.value));
    app.querySelectorAll("[data-shift-selection]").forEach(select => {
      if (window._sessionShifts?.[select.dataset.shiftSelection]) return;
      select.value = event.target.value;
      const label = select.closest(".selection-details")?.querySelector("[data-selection-shift-label]");
      if (label) label.textContent = `Ca ${event.target.value}`;
    });
    return;
  }
  if (event.target.matches("#add-shift")) {
    addOrdersShift = event.target.value;
    event.target.closest("details")?.querySelector("[data-default-shift-label]")?.replaceChildren(document.createTextNode(event.target.value));
    app.querySelectorAll("[data-selection-shift-label]").forEach(label => label.textContent = `Ca ${event.target.value}`);
    return;
  }
  if (event.target.matches("[data-shift-selection]")) {
    const shifts = window._sessionShifts || {};
    shifts[event.target.dataset.shiftSelection] = event.target.value;
    window._sessionShifts = shifts;
    const label = event.target.closest(".selection-details")?.querySelector("[data-selection-shift-label]");
    if (label) label.textContent = `Ca ${event.target.value}`;
    return;
  }
  if (event.target.matches("[data-session-shift]")) {
    if (role !== "shipper") return;
    try { await updateState(setSessionOrderShift(state, event.target.dataset.sessionShift, event.target.value)); }
    catch (error) { flash(error.message); }
    return;
  }
  if (event.target.matches("[data-photo-kind]")) {
    const buttons = [...(document.querySelector(".photo-tools")?.querySelectorAll("button") || [])];
    const busy = buttons.map(button => [button, setButtonBusy(button, true)]);
    await saveProofFiles(event.target);
    busy.forEach(([button, wasBusy]) => { if (wasBusy) setButtonBusy(button, false); });
  }
});

app.addEventListener("input", event => {
  if (event.target.matches("[data-selection-note]")) {
    const notes = event.target.dataset.noteFlow === "session" ? (window._sessionNotes || {}) : (window._addNotes || {});
    notes[event.target.dataset.selectionNote] = event.target.value;
    if (event.target.dataset.noteFlow === "session") window._sessionNotes = notes;
    else window._addNotes = notes;
    const clearButton = event.target.parentElement.querySelector('[data-action="clear-selection-note"]');
    if (clearButton) clearButton.disabled = !event.target.value.trim();
    updateSelectionDetailsStatus(event.target.closest(".selection-details"));
  } else if (event.target.matches("[data-selection-maps]")) {
    const links = event.target.dataset.mapFlow === "session" ? (window._sessionMaps || {}) : (window._addMaps || {});
    links[event.target.dataset.selectionMaps] = event.target.value;
    if (event.target.dataset.mapFlow === "session") window._sessionMaps = links;
    else window._addMaps = links;
    const clearButton = event.target.parentElement.querySelector('[data-action="clear-selection-map"]');
    if (clearButton) clearButton.disabled = !event.target.value.trim();
    updateSelectionDetailsStatus(event.target.closest(".selection-details"));
  }
});

app.addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "login-form") {
    const data = new FormData(event.target);
    const username = data.get("username");
    const pin = String(data.get("pin") || "");
    const submit = event.target.querySelector('[type="submit"]');
    if (!accounts[username] || !/^\d{4,6}$/.test(pin)) {
      document.querySelector("#login-error").textContent = "Tài khoản hoặc PIN chưa đúng.";
      return;
    }
    if (!setButtonBusy(submit, true)) return;
    try {
      const result = await apiRequest("/api/auth/login", { method: "POST", body: { username, pin } });
      if (!result.user) throw new Error("Không thể tạo phiên đăng nhập.");
      await activateUser(result.user, { restoreView: false });
    } catch (error) {
      const cachedUser = await getMeta("lastUser");
      if ((error.status === 0 || error.status >= 500 || !navigator.onLine) && cachedUser === username) {
        await restoreOfflineUser(username);
      } else {
        const target = document.querySelector("#login-error");
        if (target) target.textContent = error.message;
      }
    } finally {
      if (submit?.isConnected) setButtonBusy(submit, false);
    }
  } else if (event.target.id === "accounts-form") {
    if (role !== "admin") { flash("Chỉ admin được quản lý tài khoản."); return; }
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    const data = new FormData(form);
    const updates = [...form.querySelectorAll("[data-account-id]")].map(input => ({ id: input.dataset.accountId, baseName: input.dataset.accountBaseName, name: input.value }));
    if (!setButtonBusy(submit, true)) return;
    try {
      const result = await apiRequest("/api/auth?action=accounts", { method: "POST", body: { accounts: updates, newShipperName: data.get("newShipperName") } });
      accounts = Object.fromEntries((result.data || []).map(account => [account.id, account]));
      await setMeta("accountDirectory", result.data || []);
      user = accounts[user.id] || user;
      render();
      flash("Đã lưu danh sách tài khoản.");
    } catch (error) { showError(error); }
    finally { if (submit?.isConnected) setButtonBusy(submit, false); }
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && modal) { modal = null; render(); }
});

void initializeApp();
