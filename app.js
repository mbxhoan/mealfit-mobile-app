import {
  addOrdersToSession,
  allowedPhotoCount,
  cancelSession,
  classifyNetworkSignal,
  createSession,
  dueAmount,
  getSessionStats,
  markDelivered,
  markPaid,
  normalizeState,
  normalizeGoogleMapsLink,
  pauseSession,
  removeOrderFromSession,
  reorderOrderInSession,
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
import { ApiError, apiRequest } from "./api-client.mjs";
import {
  ackOutbox, commitState, deletePhoto as deleteLocalPhoto, failOutbox, getMeta,
  getOrderPhotos as loadOrderPhotos, getPendingPhotos, mergeRemote,
  nextOutboxBatch, openLocalDb, putPhoto as storeLocalPhoto, readState, setMeta, writeStateSnapshot
} from "./local-store.mjs";

const accounts = { admin: "Admin", user: "Nhân viên", hieu: "Hiếu", hoan: "Hoàn", shipper: "Shipper" };
const emptyState = () => ({ orders: [], sessions: [], activeSessionId: null });

let state = emptyState();
let lastPersistedState = emptyState();
let role = null;
let user = null;
let viewStack = [{ name: "login" }];
let orderFilter = "Tất cả";
let sessionTab = "route";
let selectedOrderId = null;
let selectedPayment = null;
let modal = null;
let sessionDefaultShift = "Sáng";
let addOrdersShift = "Sáng";
let routeAnnouncement = "";
let routeNoteOrderId = null;
let orderNoteEditId = null;
let routeDrag = null;
let routeDragFrame = null;
let toastTimer = null;
let syncTimer = null;
let syncRunning = false;
let syncErrorShown = false;
let lastSheetRefreshAt = 0;
let stateWriteRunning = false;
let lastServerRtt = null;
let serverCounts = {};
let lastSyncAt = null;
let conflictCount = 0;
let webcam = null;
const photoUrls = new Map();
const app = document.querySelector("#app");

const currentView = () => viewStack.at(-1);
const orderById = id => state.orders.find(order => order.id === id);
const activeSession = () => state.sessions.find(session => session.id === state.activeSessionId && ["notStarted", "active", "paused"].includes(session.status));
const isStaff = () => role === "admin" || role === "user";
const canSeeOrder = order => role !== "shipper" || !order.assignedUserId || order.assignedUserId === user?.id;
const money = amount => `${Math.round(Number(amount) || 0).toLocaleString("vi-VN")}đ`;
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const addressLabel = value => safe(String(value ?? "").replace(/^Địa chỉ\s+/i, ""));
const paymentRecipient = { bank: "VIB", account: "865884858", name: "Phạm Thị Linh Uyên" };
const dateLabel = value => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
const timeLabel = value => new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

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
  return `<span class="network-indicator signal-${signal}" role="status" aria-label="${networkLabels[signal]}">${icon("signal", 18)}</span>`;
};
function updateNetworkIndicator() {
  const indicator = document.querySelector(".network-indicator");
  if (!indicator) return;
  const signal = networkSignal();
  indicator.className = `network-indicator signal-${signal}`;
  indicator.setAttribute("aria-label", networkLabels[signal]);
}
window.addEventListener("online", updateNetworkIndicator);
window.addEventListener("offline", updateNetworkIndicator);
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

function appShell(content, { title = "", back = false, refresh = false } = {}) {
  const left = back
    ? `<button class="back-button" data-action="back" aria-label="Quay lại">${icon("arrow", 18)}<span>${safe(title)}</span></button>`
    : `<span class="topbar-spacer" aria-hidden="true"></span>`;
  const tools = `${networkIndicator()}${refresh ? `<button class="icon-button" data-action="refresh" aria-label="Làm mới thông tin">${icon("refresh")}</button>` : ""}<button class="role-chip" data-action="logout" aria-label="Đổi tài khoản hoặc đăng xuất">${safe(user?.name || "")}</button>`;
  return `<div class="app-shell"><header class="topbar">${left}<img class="topbar-brand" src="/logo-transparent.png" alt="Mealfit"/><div class="topbar-tools">${tools}</div></header>${content}</div>${renderModal()}`;
}

function loginScreen() {
  return `<main class="login-page">
    <header class="login-topbar"><span aria-hidden="true"></span><img src="/logo-transparent.png" alt="Mealfit"/>${networkIndicator()}</header>
    <form class="login-form" id="login-form">
      <div class="form-field"><label for="username">Tài khoản</label><select class="select" id="username" name="username" required><option value="">Chọn tài khoản</option>${Object.entries(accounts).map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}</select></div>
      <div class="form-field"><label for="pin">Mã PIN</label><input class="input pin-input" id="pin" name="pin" type="text" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" placeholder="Nhập PIN" autocomplete="off" required /></div>
      <p class="login-error" id="login-error" aria-live="polite"></p>
      <button class="button full" type="submit">Đăng nhập ${icon("chevron", 18)}</button>
    </form>
  </main>${renderModal()}`;
}

function orderCounts() {
  return {
    pending: serverCounts["Chưa giao hàng"] ?? state.orders.filter(order => order.deliveryStatus === "Chưa giao hàng").length,
    transit: serverCounts["Đang giao hàng"] ?? state.orders.filter(order => order.deliveryStatus === "Đang giao hàng").length,
    delivered: serverCounts["Đã giao hàng"] ?? state.orders.filter(order => order.deliveryStatus === "Đã giao hàng").length
  };
}

function homeScreen() {
  const counts = orderCounts();
  const menu = [
    { title: "Đơn hàng", count: `${counts.pending + counts.transit + counts.delivered} đơn`, icon: "orders", action: "orders" },
    { title: role === "shipper" ? "Giao hàng" : "Phiên giao hàng", count: role === "shipper" ? (activeSession() ? "Tiếp tục phiên" : "Tạo phiên") : "Theo dõi tuyến", icon: "delivery", action: role === "shipper" ? "delivery" : "session-overview" }
  ];
  return `<main class="page">
    <p class="home-date">${lastSyncAt ? `Đồng bộ ${timeLabel(lastSyncAt)}` : "Đơn hàng sẽ tải khi có kết nối"}</p>
    <div class="home-summary" aria-label="Tóm tắt đơn hàng">
      <div class="summary-cell"><span class="summary-number">${counts.pending}</span><span class="summary-label">Chưa giao</span></div>
      <div class="summary-cell"><span class="summary-number">${counts.transit}</span><span class="summary-label">Đang giao</span></div>
      <div class="summary-cell"><span class="summary-number">${counts.delivered}</span><span class="summary-label">Đã giao</span></div>
    </div>
    <div class="menu-grid">${menu.map(item => `<button class="menu-card" data-action="open-${item.action}"><span class="menu-icon">${icon(item.icon, 23)}</span><span><span class="menu-label">${item.title}</span><span class="menu-count">${item.count}</span></span></button>`).join("")}${role === "admin" && conflictCount ? `<button class="menu-card" data-action="open-conflicts"><span class="menu-icon">${icon("orders", 23)}</span><span><span class="menu-label">Xung đột</span><span class="menu-count">${conflictCount} đơn cần xử lý</span></span></button>` : ""}</div>
    ${!state.orders.length ? `<div class="empty-state" style="margin-top:14px">Chưa tải được đơn hàng.<button class="button secondary full" style="margin-top:12px" data-action="refresh">Thử đồng bộ</button></div>` : ""}
    <p class="sync-state" aria-live="polite">${syncRunning ? "Đang đồng bộ" : (navigator.onLine ? "Đã lưu trên thiết bị" : "Ngoại tuyến · Sẽ đồng bộ khi có mạng")}</p>
    ${activeSession() && role === "shipper" ? `<div class="divider"></div><button class="button full" data-action="open-session">Tiếp tục phiên giao hàng ${icon("chevron", 18)}</button>` : ""}
  </main>`;
}

function orderCard(order, clickable = true, selected = false) {
  const due = dueAmount(order);
  return `<div class="list-card ${clickable ? "clickable" : ""} ${selected ? "select-order selected" : ""}" ${clickable ? `data-action="open-order" data-id="${safe(order.id)}"` : ""}>
    ${selected ? '<span class="checkmark" aria-hidden="true"></span>' : ""}
    <div style="flex:1;min-width:0">
      <div class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.deliveryStatus)}</div>
      <p class="order-customer">${safe(order.customer)}</p><p class="order-address">${addressLabel(order.address)}</p>
      <div class="order-subline">${dateLabel(order.date)} · ${statusBadge(order.paymentStatus || (due ? "Chưa thanh toán" : "Đã thanh toán"), "payment")}</div>
      <div class="card-bottom"><span class="money">${money(order.total)}${due ? `<small class="money-sub">Còn thu ${money(due)}</small>` : ""}</span><span>${icon("chevron", 18)}</span></div>
    </div>
  </div>`;
}

function ordersScreen() {
  const filters = ["Tất cả", "Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"];
  const visibleOrders = state.orders.filter(canSeeOrder);
  const orders = orderFilter === "Tất cả" ? visibleOrders : visibleOrders.filter(order => order.deliveryStatus === orderFilter);
  return `<main class="page">
    <div class="filter-row">${filters.map(filter => `<button class="filter-chip ${orderFilter === filter ? "active" : ""}" data-action="filter-orders" data-filter="${safe(filter)}">${safe(filter)}</button>`).join("")}</div>
    <div class="list">${orders.length ? orders.map(order => orderCard(order)).join("") : '<div class="empty-state"><strong>Chưa có đơn trong mục này</strong>Đơn hàng sẽ xuất hiện tại đây khi có dữ liệu.</div>'}</div>
  </main>`;
}

function dishesScreen() {
  return `<main class="page"><div class="empty-state">API chưa cung cấp danh sách món.</div></main>`;
}

function paymentSummary(order) {
  const due = dueAmount(order);
  return `<div class="detail-row"><span>Trạng thái</span><span>${statusBadge(order.paymentStatus || (due ? "Chưa thanh toán" : "Đã thanh toán"), "payment")}</span></div>
    <div class="detail-row"><span>Đã thanh toán</span><span>${money(order.paidAmount)}</span></div>
    <div class="detail-row"><span>Còn phải thu</span><span class="${due ? "" : "profit"}">${money(due)}</span></div>${order.paymentMethod ? `<div class="detail-row"><span>Phương thức gần nhất</span><span>${safe(order.paymentMethod)}</span></div>` : ""}`;
}

function photoSection(order, locked = false) {
  return `<details class="photo-disclosure" open><summary>Ảnh xác nhận <span data-photo-count>…/5</span></summary><div class="photo-content">
    <p class="fine-print">Tối đa 5 ảnh, mỗi ảnh tối đa 15 MB.</p>
    <div class="photo-grid" data-photo-order="${safe(order.id)}"><span class="fine-print">Đang tải ảnh…</span></div>
    <div class="photo-tools"><button class="button secondary small" data-action="choose-photo" data-source="camera" ${locked ? "disabled" : ""}>${icon("camera", 18)} Chụp ảnh</button><button class="button secondary small" data-action="choose-photo" data-source="upload" ${locked ? "disabled" : ""}>${icon("upload", 18)} Tải ảnh</button></div>
    ${locked ? '<p class="fine-print">Tiếp tục phiên để thay đổi ảnh.</p>' : ""}
    <input class="hidden-input" id="camera-input" type="file" accept="image/*" capture="environment" data-photo-kind="proof" ${locked ? "disabled" : ""} />
    <input class="hidden-input" id="upload-input" type="file" accept="image/*" multiple data-photo-kind="proof" ${locked ? "disabled" : ""} />
  </div></details>`;
}

function deliveryInfoEditor(order, scope, saveAction) {
  return `<div class="route-note-editor"><label for="${scope}-note-${safe(order.id)}">Ghi chú giao hàng</label><textarea id="${scope}-note-${safe(order.id)}" data-${scope}-note rows="2" placeholder="Ví dụ: Giao trước 10:00, gọi trước khi đến">${safe(order.note || "")}</textarea><label for="${scope}-maps-${safe(order.id)}">Link Google Maps</label><input class="input maps-input" id="${scope}-maps-${safe(order.id)}" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/..." value="${safe(order.mapsLink || "")}" data-${scope}-maps /><div class="route-note-buttons"><button class="button small" data-action="${saveAction}" data-id="${safe(order.id)}">Lưu</button></div></div>`;
}

function orderDetailScreen(view) {
  const order = orderById(view.orderId);
  if (!order) return `<main class="page"><div class="empty-state">Không tìm thấy đơn hàng.</div></main>`;
  const items = Array.isArray(order.items) ? order.items : [];
  const fromSession = Boolean(view.fromSession && role === "shipper");
  const due = dueAmount(order);
  const session = activeSession();
  const sessionPaused = session?.status === "paused";
  const canEditDeliveryInfo = isStaff() || (role === "shipper" && !(sessionPaused && session?.id === order.sessionId));
  const deliveryInfo = !canEditDeliveryInfo ? "" : orderNoteEditId === order.id
    ? deliveryInfoEditor(order, "detail", "save-detail-note")
    : `<button class="route-note-toggle" data-action="edit-detail-note" data-id="${safe(order.id)}">${order.note || order.mapsLink ? "Sửa ghi chú / vị trí" : "+ Ghi chú / vị trí"}</button>`;
  const inSession = fromSession && session?.orderIds.includes(order.id) && session.id === order.sessionId;
  const actions = inSession && !sessionPaused && session?.status === "active" && order.deliveryStatus === "Đang giao hàng"
    ? `<div class="bottom-actions ${due ? "" : "single"}">${due ? `<button class="button secondary" data-action="pay-order" data-id="${safe(order.id)}">Đã thanh toán</button>` : ""}<button class="button ${due ? "" : "full"}" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao hàng</button></div>`
    : inSession && sessionPaused && order.deliveryStatus === "Đang giao hàng" ? `<div class="bottom-actions ${due ? "" : "single"}">${due ? '<button class="button secondary" disabled>Đã thanh toán</button>' : ""}<button class="button ${due ? "" : "full"}" disabled>Đã giao hàng</button></div><p class="fine-print">Tiếp tục phiên để giao hàng.</p>` : "";
  const mayCorrect = order.deliveryStatus === "Đã giao hàng" && (isStaff() || role === "shipper") && !sessionPaused;
  const productLine = item => `<div class="product-line"><span>${safe(item.name)}</span><span class="product-price">${money(item.total ?? item.unitPrice * item.quantity)}</span><small>${safe(item.details || item.weight || "")} · ${item.quantity} phần × ${money(item.unitPrice)}</small></div>`;
  return `<main class="page ${sessionPaused ? "paused" : ""} order-page"><div class="order-meta"><p class="eyebrow">${safe(order.id)} · ${dateLabel(order.date)}</p>${statusBadge(order.deliveryStatus)}</div>
    <div class="detail-card order-detail">
      <section class="detail-section customer-section"><div class="customer-line"><strong>${safe(order.customer)}</strong><span class="customer-phone">${safe(order.phone)}</span></div><div class="customer-address-line"><div class="customer-address">${addressLabel(order.address)}</div>${mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}</div>${order.note ? `<div class="customer-note">${safe(order.note)}</div>` : ""}${deliveryInfo}</section>
      ${items.length ? `<section class="detail-section product-section"><h2>Sản phẩm <span>${items.length}</span></h2>${productLine(items[0])}${items.length > 1 ? `<details class="product-more"><summary><span>Xem thêm ${items.length - 1} món</span><span>Thu gọn</span></summary>${items.slice(1).map(productLine).join("")}</details>` : ""}</section>` : ""}
      <section class="detail-section payment-section"><h2>Thanh toán</h2><div class="detail-row"><span>Tiền hàng · ship</span><span>${money(order.subtotal)} · ${money(order.shippingFee)}</span></div><div class="detail-row total"><span>Tổng đơn</span><span>${money(order.total)}</span></div>${paymentSummary(order)}<button class="button secondary full qr-payment-button" data-action="show-payment-qr" data-id="${safe(order.id)}">${icon("qr", 18)} Hiện QR thanh toán</button></section>
      ${(order.deliveryMethod && order.deliveryMethod !== "Phiên giao hàng") || order.deliveredAt ? `<section class="detail-section delivery-section"><h2>Giao hàng</h2>${order.deliveryMethod && order.deliveryMethod !== "Phiên giao hàng" ? `<div class="detail-row"><span>Hình thức</span><span>${safe(order.deliveryMethod)}</span></div>` : ""}${order.deliveredAt ? `<div class="detail-row"><span>Đã giao lúc</span><span>${timeLabel(order.deliveredAt)} · ${dateLabel(order.deliveredAt)}</span></div>` : ""}</section>` : ""}
      ${photoSection(order, sessionPaused)}
    </div>${mayCorrect ? `<button class="button secondary full" style="margin-top:10px" data-action="reopen-order-status" data-id="${safe(order.id)}">Sửa trạng thái giao hàng</button>` : ""}
    <div class="detail-actions-dock"><a class="button call-customer-full" href="tel:${safe(order.phone.replace(/\D/g, ""))}" aria-label="Gọi ${safe(order.customer)}">${icon("phone", 18)} Gọi khách · ${safe(order.phone)}</a>${actions}</div>
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
  return `<button class="select-order ${selected ? "selected" : ""}" aria-pressed="${selected}" data-action="${action}" data-id="${safe(order.id)}"><span class="checkmark" aria-hidden="true"></span><span class="selection-copy"><span class="selection-card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.paymentStatus || (dueAmount(order) ? "Chưa thanh toán" : "Đã thanh toán"), "payment")}</span><span class="selection-customer-line"><span class="order-customer">${safe(order.customer)}</span><strong class="selection-price">${money(order.total)}</strong></span><span class="order-address">${addressLabel(order.address)}</span><span class="order-subline">${(order.items || []).length} dòng</span></span></button>`;
}

function selectionNoteEditor(flow, order) {
  const notes = flow === "session" ? window._sessionNotes : window._addNotes;
  const value = notes?.[order.id] ?? order.note ?? "";
  const mapLinks = flow === "session" ? window._sessionMaps : window._addMaps;
  const mapsLink = mapLinks?.[order.id] ?? order.mapsLink ?? "";
  return `<div class="selection-note"><label for="${flow}-note-${safe(order.id)}">Ghi chú giao hàng</label><textarea id="${flow}-note-${safe(order.id)}" data-selection-note="${safe(order.id)}" data-note-flow="${flow}" rows="2" placeholder="Ví dụ: Giao trước 10:00, gọi trước khi đến">${safe(value)}</textarea><button class="note-clear" type="button" data-action="clear-selection-note" data-id="${safe(order.id)}" data-flow="${flow}" ${value.trim() ? "" : "disabled"}>Xóa ghi chú</button><label for="${flow}-maps-${safe(order.id)}">Link Google Maps (không bắt buộc)</label><input class="input maps-input" id="${flow}-maps-${safe(order.id)}" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/..." value="${safe(mapsLink)}" data-selection-maps="${safe(order.id)}" data-map-flow="${flow}" /><button class="note-clear" type="button" data-action="clear-selection-map" data-id="${safe(order.id)}" data-flow="${flow}" ${mapsLink.trim() ? "" : "disabled"}>Xóa link</button></div>`;
}

function sessionCreateScreen() {
  if (role !== "shipper") return `<main class="page"><div class="empty-state">Phiên giao hàng dành cho shipper.</div></main>`;
  if (activeSession()) return sessionScreen();
  const pending = state.orders.filter(order => canSeeOrder(order) && order.deliveryStatus === "Chưa giao hàng");
  const selectedIds = window._sessionSelection || [];
  const shifts = window._sessionShifts || {};
  const shiftOptions = (selected, id) => `<select class="shift-select" aria-label="Ca giao đơn ${safe(id)}" data-shift-selection="${safe(id)}">${SHIFT_OPTIONS.map(shift => `<option ${shift === selected ? "selected" : ""}>${shift}</option>`).join("")}</select>`;
  return `<main class="page">
    <div class="form-field"><label for="default-shift">Ca mặc định</label><select class="select" id="default-shift">${SHIFT_OPTIONS.map(shift => `<option ${shift === sessionDefaultShift ? "selected" : ""}>${shift}</option>`).join("")}</select></div>
    <div class="list">${pending.map(order => {
      const selected = selectedIds.includes(order.id);
      return `<div class="list-card shift-selection-row">${orderSelectionButton(order, selected, "toggle-session-order")}${selected ? `${shiftOptions(shifts[order.id] || sessionDefaultShift, order.id)}${selectionNoteEditor("session", order)}` : ""}</div>`;
    }).join("") || '<div class="empty-state">Không có đơn để giao.</div>'}</div>
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
  if (!session) {
    if (isStaff()) return staffSessionsScreen();
    const history = [...state.sessions].sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
    return `<main class="page"><button class="button full" data-action="new-session">Tạo phiên giao hàng ${icon("chevron", 18)}</button>
      <h2 class="section-title">Phiên gần đây <small>${history.length}</small></h2><div class="list">${history.map(item => `<button class="list-card clickable" data-action="open-session-history" data-id="${safe(item.id)}"><div class="card-top"><span class="order-number">${dateLabel(item.startedAt || item.createdAt)} ${item.startedAt ? `· ${timeLabel(item.startedAt)}` : ""}</span>${sessionBadge(item.status)}</div><p class="order-customer">${item.orderIds.length} điểm giao</p><p class="order-address">${item.orderIds.map(orderId => safe(orderById(orderId)?.customer || orderId)).join(" · ")}</p></button>`).join("") || '<div class="empty-state">Chưa có phiên giao hàng.</div>'}</div>
    </main>`;
  }
  const editable = role === "shipper" && ["notStarted", "active"].includes(session.status);
  const delivering = role === "shipper" && session.status === "active";
  const orders = session.orderIds.map(orderById).filter(Boolean);
  const isDone = order => Boolean(order && session.legs[order.id]?.completedAt);
  const routeStatus = order => isDone(order) ? "Đã giao hàng" : order.deliveryStatus;
  const completed = orders.filter(isDone).length;
  const stats = getSessionStats(state, session.id);
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
    return `<div class="route-stop ${done ? "done" : currentStop ? "current" : ""}" data-order-id="${safe(order.id)}" data-completed="${done}" data-shift="${safe(session.shifts?.[order.id] || "")}"><div class="stop-mark">${done ? icon("check", 17) : index + 1}</div><div class="stop-card" data-action="open-order-session" data-id="${safe(order.id)}" tabindex="-1">
      <button class="stop-open" data-action="open-order-session" data-id="${safe(order.id)}"><span class="stop-primary"><span class="stop-title">${safe(order.customer)} <small>· ${safe(order.id)}</small></span><span class="stop-total">${money(order.total)}<small class="money-sub">${dueAmount(order) ? `Thu ${money(dueAmount(order))}` : "Đã thanh toán"}</small></span></span><span class="stop-caption">${addressLabel(order.address)}</span>${order.note ? `<span class="stop-note">${safe(order.note)}</span>` : ""}</button>
      ${editable && !done ? noteTools(order) : ""}
      <div class="stop-bottom">${shiftSelect(order)}<div class="stop-tools">${mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}<a class="stop-call" href="tel:${safe(order.phone.replace(/\D/g, ""))}" aria-label="Gọi ${safe(order.customer)}">${icon("phone", 18)}</a>${editable && !done ? `<button class="mini-button drag-handle" type="button" data-drag-order="${safe(order.id)}" aria-label="Kéo để sắp xếp ${safe(order.customer)} trong ca ${safe(session.shifts?.[order.id] || "chưa phân ca")}; dùng phím mũi tên lên hoặc xuống" aria-keyshortcuts="ArrowUp ArrowDown">${icon("grip", 18)}</button><button class="mini-button" data-action="remove-stop" data-id="${safe(order.id)}" aria-label="Bỏ ${safe(order.id)} khỏi phiên">${icon("close", 17)}</button>` : ""}</div></div>
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
    return `<div class="session-order ${done ? "done" : ""}" data-order-id="${safe(order.id)}" data-completed="${done}" data-shift="${safe(session.shifts?.[order.id] || "")}"><button class="session-order-open" data-action="open-order-session" data-id="${safe(order.id)}"><span class="session-order-top"><strong>${index + 1}. ${safe(order.customer)} · ${safe(order.id)}</strong>${statusBadge(routeStatus(order))}</span><span class="order-address">${addressLabel(order.address)}</span>${order.note ? `<span class="order-address">${safe(order.note)}</span>` : ""}<span class="session-order-total">${money(order.total)} · ${dueAmount(order) ? `Còn thu ${money(dueAmount(order))}` : "Đã thanh toán"}</span></button>${editable && !done ? `<div class="session-order-tools">${mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}<button class="mini-button drag-handle" type="button" data-drag-order="${safe(order.id)}" aria-label="Kéo để sắp xếp ${safe(order.customer)} trong ca ${safe(session.shifts?.[order.id] || "chưa phân ca")}; dùng phím mũi tên lên hoặc xuống" aria-keyshortcuts="ArrowUp ArrowDown">${icon("grip", 18)}</button><button class="mini-button" data-action="remove-stop" data-id="${safe(order.id)}" aria-label="Bỏ ${safe(order.id)} khỏi phiên">${icon("close", 17)}</button></div>${noteTools(order)}` : mapsButton(order.mapsLink, `Mở vị trí của ${order.customer} trên Google Maps`)}</div>`;
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
  return `<main class="page route-page"><div class="session-meta"><span>${safe(session.id)} · ${dateLabel(session.startedAt || session.createdAt)}</span>${sessionBadge(session.status)}</div>
    <div class="route-progress"><strong>${completed} / ${orders.length} điểm</strong><div class="shift-summary-list">${stats.shifts.map(item => `<span class="shift-summary ${item.done ? "done" : ""}">${item.done ? icon("check", 13) : ""}${item.shift} ${item.completed}/${item.total}</span>`).join("")}${unassigned ? `<span class="shift-summary">Chưa phân ca ${unassigned}</span>` : ""}</div></div>
    <div class="route-stats">${session.startedAt ? `<div><span>Tiền mặt</span><strong>${money(stats.cashCollected)}</strong></div><div><span>Chuyển khoản</span><strong>${money(stats.transferCollected)}</strong></div><div><span>Còn giao</span><strong>${stats.remainingCount}</strong></div><div><span>Tổng tuyến</span><strong>${money(stats.totalValue)}</strong></div>` : `<div><span>Tổng cần thu</span><strong>${money(stats.amountToCollect)}</strong></div><div><span>Tổng tuyến</span><strong>${money(stats.totalValue)}</strong></div>`}</div>
    ${continueButton}${controls}
    <div class="route-tabs"><button class="route-tab ${sessionTab === "route" ? "active" : ""}" data-action="session-tab" data-tab="route">Tuyến</button><button class="route-tab ${sessionTab === "orders" ? "active" : ""}" data-action="session-tab" data-tab="orders">Đơn trong phiên</button></div>
    <div class="sr-only" role="status" aria-live="polite">${safe(routeAnnouncement)}</div>
    ${sessionTab === "route" ? `<div class="route-list">${renderOrderGroups(stopCard, "route") || '<div class="empty-state">Phiên này chưa có điểm giao.</div>'}</div>` : `<div class="session-order-list">${renderOrderGroups(orderListCard, "session-order")}</div>`}
    ${editable ? `<button class="button secondary full" style="margin-top:16px" data-action="add-session-orders">${icon("plus", 18)} Thêm đơn vào phiên</button>` : ""}
  </main>`;
}

function addOrdersScreen() {
  const session = activeSession();
  if (role !== "shipper" || !session || !["active", "notStarted"].includes(session.status)) return `<main class="page"><div class="empty-state">Tiếp tục phiên trước khi thêm đơn.</div></main>`;
  const pending = state.orders.filter(order => order.deliveryStatus === "Chưa giao hàng");
  const selectedIds = window._addSelection || [];
  return `<main class="page">
    <div class="form-field"><label for="add-shift">Ca giao</label><select class="select" id="add-shift">${SHIFT_OPTIONS.map(shift => `<option ${shift === addOrdersShift ? "selected" : ""}>${shift}</option>`).join("")}</select></div>
    <div class="list">${pending.map(order => {
      const selected = selectedIds.includes(order.id);
      return `<div class="list-card shift-selection-row">${orderSelectionButton(order, selected, "toggle-add-order")}${selected ? selectionNoteEditor("add", order) : ""}</div>`;
    }).join("") || '<div class="empty-state">Không có đơn chưa giao để thêm.</div>'}</div>
    <div class="bottom-actions single"><div class="selection-count">Đã chọn ${selectedIds.length} đơn</div><button class="button" data-action="confirm-add-orders" ${selectedIds.length ? "" : "disabled"}>Thêm vào tuyến</button></div>
  </main>`;
}

function renderModal() {
  if (!modal) return "";
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
  if (modal.type === "remove-stop") {
    const order = orderById(modal.orderId);
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Bỏ đơn khỏi phiên?</h2><p>${safe(order?.id)} sẽ trở về danh sách “Chưa giao hàng”.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Giữ lại</button><button class="button danger" data-action="confirm-remove-stop">Bỏ khỏi phiên</button></div></section></div>`;
  }
  if (modal.type === "cancel-session") {
    const session = activeSession();
    const remaining = session?.orderIds.filter(id => !session.legs[id]?.completedAt).length || 0;
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Hủy lộ trình?</h2><p>${remaining} đơn chưa giao sẽ trở về danh sách chờ. Các đơn đã giao được giữ nguyên.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Quay lại</button><button class="button danger" data-action="confirm-cancel-session">Hủy lộ trình</button></div></section></div>`;
  }
  if (modal.type === "reopen-order") {
    const order = orderById(modal.orderId);
    if (!order) return "";
    return `<div class="modal-backdrop" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Sửa trạng thái ${safe(order.id)}</h2><p>Thanh toán và ảnh xác nhận sẽ được giữ lại.</p><div class="form-field"><label for="reopen-shift">Ca giao lại</label><select class="select" id="reopen-shift">${SHIFT_OPTIONS.map(shift => `<option ${shift === (modal.shift || "Sáng") ? "selected" : ""}>${shift}</option>`).join("")}</select></div><div class="modal-actions"><button class="button secondary" data-action="confirm-reopen-order" data-status="Chưa giao hàng">Chưa giao</button><button class="button" data-action="confirm-reopen-order" data-status="Đang giao hàng">Đang giao</button></div></section></div>`;
  }
  if (modal.type === "error") return `<div class="modal-backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Chưa hoàn tất</h2><p>${safe(modal.message)}</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Đóng</button><button class="button" data-action="retry-sync">Thử lại</button></div></section></div>`;
  if (modal.type === "camera") return `<div class="modal-backdrop"><section class="modal camera-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Chụp ảnh đơn hàng</h2><video id="camera-video" autoplay playsinline></video><canvas id="camera-canvas" class="hidden-input"></canvas><p class="fine-print" data-camera-message>Đang mở camera…</p><div class="modal-actions"><button class="button secondary" data-action="close-camera">Đóng</button><button class="button" data-action="capture-photo" disabled>Chụp ảnh</button></div></section></div>`;
  if (modal.type === "conflicts") return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Xung đột đồng bộ</h2><p>${safe(modal.message || "Chọn dữ liệu cần giữ cho từng đơn.")}</p>${(modal.items || []).map(item => `<div class="conflict-row"><strong>${safe(item.orderCode)}</strong><div class="modal-actions"><button class="button secondary" data-action="resolve-conflict" data-id="${safe(item.conflictId)}" data-choice="sheet">Giữ Sheet</button><button class="button" data-action="resolve-conflict" data-id="${safe(item.conflictId)}" data-choice="app">Giữ ứng dụng</button></div></div>`).join("") || '<p>Không còn xung đột cần xử lý.</p>'}<div class="modal-actions"><button class="button secondary" data-action="close-modal">Đóng</button><button class="button" data-action="retry-sync">Làm mới</button></div></section></div>`;
  return "";
}

function render() {
  const view = currentView();
  if (!role || view.name === "login") {
    app.innerHTML = loginScreen();
    return;
  }
  let content;
  let options = { back: view.name !== "home", title: "" };
  switch (view.name) {
    case "home": content = homeScreen(); options.back = false; break;
    case "orders": content = ordersScreen(); options.title = "Đơn hàng"; break;
    case "dishes": content = dishesScreen(); options.title = "Món"; break;
    case "delivery": content = singleDeliveryScreen(); options.title = "Giao lẻ"; break;
    case "sessions-overview": content = staffSessionsScreen(); options.title = "Phiên giao hàng"; options.refresh = true; break;
    case "session-create": content = sessionCreateScreen(); options.title = "Tạo phiên"; break;
    case "session": content = sessionScreen(); options.title = "Phiên giao"; options.refresh = true; break;
    case "add-orders": content = addOrdersScreen(); options.title = "Thêm đơn"; break;
    case "order": content = orderDetailScreen(view); options.title = "Chi tiết đơn"; options.refresh = true; break;
    default: content = homeScreen(); options.back = false;
  }
  app.innerHTML = appShell(content, options);
  if (view.name === "session") routeAnnouncement = "";
  if (view.name === "order") hydratePhotos(view.orderId);
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
  if (viewStack.length > 1) viewStack.pop();
  render();
  persistLastView();
}

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

function cloneState(value) { return JSON.parse(JSON.stringify(value)); }

function showError(message) {
  modal = { type: "error", message: String(message || "Không thể hoàn tất thao tác.") };
  render();
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
  void syncQueued();
}

async function syncQueued() {
  if (!user || !navigator.onLine || syncRunning) return;
  syncRunning = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const batch = await nextOutboxBatch(user.id, 40);
      if (!batch.length) break;
      const operations = batch.map(item => ({ operationId: item.id, type: item.type, entityId: item.entityId, baseRevision: item.baseRevision, payload: item.payload }));
      try {
        const result = await apiRequest("/api/operations", { method: "POST", body: { operations } });
        const byId = new Map((result.results || []).map(item => [item.id, item]));
        for (const item of batch) {
          const acknowledgement = byId.get(item.id);
          if (acknowledgement) await ackOutbox(item.id, acknowledgement.revision);
          else await failOutbox(item.id);
        }
      } catch (error) {
        const results = error.details?.results || [];
        const byId = new Map(results.map(item => [item.id, item]));
        for (const item of batch) {
          const result = byId.get(item.id);
          if (result?.conflict) await failOutbox(item.id, true);
          else if (result) await ackOutbox(item.id, result.revision);
          else await failOutbox(item.id, error.status === 409);
        }
        if (error.status === 409) showError(error.message);
        else if (!syncErrorShown) { syncErrorShown = true; showError(error.message); }
        break;
      }
    }
    await syncPendingPhotos();
    await syncPendingMediaDeletes();
    state = normalizeState(await readState(emptyState(), user.id));
    lastPersistedState = cloneState(state);
    syncErrorShown = false;
    render();
  } catch (error) {
    if (!syncErrorShown) { syncErrorShown = true; showError(error.message); }
  } finally {
    syncRunning = false;
  }
}

async function syncPendingPhotos() {
  if (!user || !navigator.onLine) return;
  const photos = await getPendingPhotos();
  for (const photo of photos.slice(0, 5)) {
    try {
      const query = new URLSearchParams({ code: photo.orderId, id: photo.id, name: photo.name || `${photo.id}.jpg` });
      const result = await apiRequest(`/api/media?${query}`, { method: "POST", headers: { "content-type": photo.blob.type || "image/jpeg" }, body: photo.blob, timeout: 30_000 });
      await putPhoto({ ...photo, syncState: result.status === "sent" ? "synced" : "pending", syncedAt: result.status === "sent" ? Date.now() : null });
    } catch (error) {
      if (!syncErrorShown) { syncErrorShown = true; showError(error.message); }
      break;
    }
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
  if (!user || !navigator.onLine) return;
  if (sheet) await apiRequest("/api/refresh", { method: "POST", body: {}, timeout: 120_000 });
  let cursor = null;
  let first = true;
  do {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const page = await apiRequest(`/api/orders?${params}`);
    if (first) { serverCounts = page.counts || {}; first = false; }
    state = normalizeState(await mergeRemote({ orders: page.data || [] }, user.id));
    lastPersistedState = cloneState(state);
    cursor = page.nextCursor;
    render();
  } while (cursor);
  const [sessions] = await Promise.all([apiRequest("/api/sessions")]);
  state = normalizeState(await mergeRemote({ sessions: sessions.data || [] }, user.id));
  lastPersistedState = cloneState(state);
  if (role === "admin") {
    try { conflictCount = (await apiRequest("/api/conflicts")).data.length; } catch { conflictCount = 0; }
  }
  lastSyncAt = Date.now();
  await setMeta(`lastSync:${user.id}`, lastSyncAt);
  render();
}

async function pullChanges() {
  if (!user || !navigator.onLine) return;
  try {
    let cursor = await getMeta(`changeCursor:${user.id}`) || "";
    for (let pass = 0; pass < 10; pass++) {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const page = await apiRequest(`/api/changes?${params}`);
      state = normalizeState(await mergeRemote({ orders: page.orders || [], sessions: page.sessions || [] }, user.id));
      lastPersistedState = cloneState(state);
      cursor = page.nextCursor || cursor;
      if (page.nextCursor) await setMeta(`changeCursor:${user.id}`, page.nextCursor);
      if (!page.hasMore) break;
    }
    syncErrorShown = false;
    render();
  } catch (error) {
    if (error.status === 401) void logout();
    else if (!syncErrorShown) { syncErrorShown = true; showError(error.message); }
  }
}

async function refreshRemoteChanges() {
  if (!user || !navigator.onLine || Date.now() - lastSheetRefreshAt < 60_000) return;
  lastSheetRefreshAt = Date.now();
  try {
    const result = await apiRequest("/api/refresh", { method: "POST", body: {}, timeout: 120_000 });
    if (result.imported > 0) await pullChanges();
  } catch (error) {
    if (!syncErrorShown) { syncErrorShown = true; showError(error.message); }
  }
}

async function hydrateOrderDetail(orderId) {
  if (!navigator.onLine || !user) return;
  try {
    const result = await apiRequest(`/api/orders/${encodeURIComponent(orderId)}?refresh=1`);
    state = normalizeState(await mergeRemote({ orders: [result.data] }, user.id));
    lastPersistedState = cloneState(state);
    render();
  } catch (error) {
    if (error.status === 401) void logout();
    else if (!syncErrorShown) { syncErrorShown = true; showError(error.message); }
  }
}

function startBackgroundSync() {
  clearInterval(syncTimer);
  if (!user) return;
  void syncQueued();
  void pullChanges();
  void probeNetwork();
  syncTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      void syncQueued();
      void pullChanges();
      void probeNetwork();
      void refreshRemoteChanges();
    }
  }, 12_000);
}

const validViewNames = new Set(["home", "orders", "sessions-overview", "session-create", "session", "add-orders", "order"]);

async function activateUser(nextUser, { restoreView = true, refresh = true } = {}) {
  user = nextUser;
  role = nextUser.role;
  await setMeta("lastUser", user.id);
  state = normalizeState(await readState(emptyState(), user.id));
  lastPersistedState = cloneState(state);
  const savedStack = restoreView ? await getMeta(`lastView:${user.id}`) : null;
  viewStack = Array.isArray(savedStack) && savedStack.length && savedStack.every(view => validViewNames.has(view?.name))
    ? savedStack : [{ name: "home" }];
  lastSyncAt = await getMeta(`lastSync:${user.id}`) || null;
  render();
  startBackgroundSync();
  if (refresh && navigator.onLine) {
    try { await pullRemoteOrders({ sheet: true }); }
    catch (error) { showError(error.message); }
  }
}

async function restoreOfflineUser(userId) {
  const account = accounts[userId];
  const roleName = userId === "admin" || userId === "user" ? userId : "shipper";
  if (!account) return false;
  await activateUser({ id: userId, name: account, role: roleName }, { refresh: false });
  flash("Đang dùng dữ liệu đã lưu trên thiết bị · Ngoại tuyến");
  return true;
}

async function logout() {
  clearInterval(syncTimer);
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
    await openLocalDb();
    const cachedUserId = await getMeta("lastUser");
    if (navigator.onLine) {
      try {
        const result = await apiRequest("/api/auth/session");
        if (result.user) { await activateUser(result.user); return; }
      } catch {
        if (cachedUserId) { await restoreOfflineUser(cachedUserId); return; }
      }
    } else if (cachedUserId) {
      await restoreOfflineUser(cachedUserId);
      return;
    }
    render();
  } catch (error) {
    showError(error.message || "Không thể khôi phục dữ liệu trên thiết bị.");
  }
}

async function claimUnassignedOrders(codes) {
  const unassigned = codes.filter(code => !orderById(code)?.assignedUserId);
  if (!unassigned.length) return state;
  if (!navigator.onLine) throw new Error("Cần có mạng để nhận đơn chưa phân công.");
  const result = await apiRequest("/api/claim", { method: "POST", body: { codes: unassigned } });
  const next = cloneState(state);
  for (const claimed of result.data || []) {
    const order = next.orders.find(item => item.id === claimed.id);
    if (order) Object.assign(order, { assignedUserId: claimed.assignedUserId, shipperName: claimed.shipperName, serverRevision: claimed.serverRevision });
  }
  await writeStateSnapshot(next, user.id);
  state = next;
  lastPersistedState = cloneState(next);
  render();
  return next;
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

function placeDraggedStop(clientX, clientY) {
  const drag = routeDrag;
  if (!drag) return;
  const rows = dragRows(drag.parent);
  const movable = rows.filter(row => row.dataset.completed !== "true");
  const first = movable[0];
  const last = movable.at(-1);
  if (!first || !last) return;
  if (clientY <= first.getBoundingClientRect().top) {
    drag.parent.insertBefore(drag.element, first);
    return;
  }
  if (clientY >= last.getBoundingClientRect().bottom) {
    drag.parent.append(drag.element);
    return;
  }
  const target = document.elementFromPoint(clientX, clientY)?.closest("[data-order-id]");
  if (!target || target.parentElement !== drag.parent || target.dataset.completed === "true" || target === drag.element) return;
  const rect = target.getBoundingClientRect();
  drag.parent.insertBefore(drag.element, clientY < rect.top + rect.height / 2 ? target : target.nextElementSibling);
}

function runDragAutoScroll() {
  if (!routeDrag) return;
  const edge = 72;
  const y = routeDrag.lastY;
  const delta = y < edge ? -Math.ceil((edge - y) / 5) : y > innerHeight - edge ? Math.ceil((y - innerHeight + edge) / 5) : 0;
  if (delta) {
    window.scrollBy(0, delta);
    placeDraggedStop(routeDrag.lastX, routeDrag.lastY);
    routeDragFrame = requestAnimationFrame(runDragAutoScroll);
  } else routeDragFrame = null;
}

function beginRouteDrag(event) {
  const handle = event.target.closest("[data-drag-order]");
  if (!handle || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
  const session = activeSession();
  const element = handle.closest("[data-order-id]");
  const parent = element?.parentElement;
  if (role !== "shipper" || !session || !["notStarted", "active"].includes(session.status) || !element || element.dataset.completed === "true") return;
  event.preventDefault();
  routeDrag = { id: handle.dataset.dragOrder, handle, element, parent, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  element.classList.add("dragging");
  handle.classList.add("dragging");
  handle.setPointerCapture?.(event.pointerId);
}

function updateRouteDrag(event) {
  if (!routeDrag || event.pointerId !== routeDrag.pointerId) return;
  event.preventDefault();
  routeDrag.lastX = event.clientX;
  routeDrag.lastY = event.clientY;
  placeDraggedStop(event.clientX, event.clientY);
  if (!routeDragFrame) routeDragFrame = requestAnimationFrame(runDragAutoScroll);
}

async function finishRouteDrag(event, cancelled = false) {
  if (!routeDrag || event.pointerId !== routeDrag.pointerId) return;
  const drag = routeDrag;
  routeDrag = null;
  if (routeDragFrame) cancelAnimationFrame(routeDragFrame);
  routeDragFrame = null;
  drag.element.classList.remove("dragging");
  drag.handle.classList.remove("dragging");
  const session = activeSession();
  const rowIds = dragRows(drag.parent).map(row => row.dataset.orderId);
  const shiftSlots = session?.orderIds.map((id, index) => ({ id, index }))
    .filter(item => (session.shifts?.[item.id] || "Chưa phân ca") === drag.parent.dataset.routeShift && !session.legs[item.id]?.completedAt)
    .map(item => item.index) || [];
  const localIndex = rowIds.indexOf(drag.id);
  const targetIndex = shiftSlots[localIndex] ?? -1;
  const originalIndex = session?.orderIds.indexOf(drag.id) ?? -1;
  if (cancelled || targetIndex < 0 || targetIndex === originalIndex) { render(); return; }
  try {
    const next = reorderOrderInSession(state, drag.id, targetIndex);
    if (next === state) { render(); return; }
    announceOrderPosition(drag.id, targetIndex);
    await updateState(next, "Đã sắp xếp lộ trình.");
  } catch (error) { render(); flash(error.message); }
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
  } catch (error) { flash(error.message); }
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
    void syncPendingMediaDeletes();
  }
}

async function hydratePhotos(orderId) {
  const target = document.querySelector(`[data-photo-order="${CSS.escape(orderId)}"]`);
  if (!target) return;
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
    if (target.isConnected) target.innerHTML = '<span class="fine-print">Không tải được ảnh đã lưu.</span>';
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
    if (saved && navigator.onLine) void syncPendingPhotos();
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
  if (action === "backdrop" && event.target === button) { modal = null; render(); return; }
  if (action === "back") { back(); return; }
  if (action === "logout") { await logout(); return; }
  if (action === "refresh") {
    if (!setButtonBusy(button, true)) return;
    try { await syncQueued(); await apiRequest("/api/refresh", { method: "POST", body: { force: true }, timeout: 120_000 }); await pullRemoteOrders(); flash("Đã làm mới dữ liệu đơn hàng."); }
    catch (error) { showError(error.message); }
    finally { setButtonBusy(button, false); }
    return;
  }
  if (action === "retry-sync") {
    modal = null; render();
    try { await syncQueued(); await apiRequest("/api/refresh", { method: "POST", body: { force: true }, timeout: 120_000 }); await pullRemoteOrders(); flash("Đồng bộ đã hoàn tất."); }
    catch (error) { showError(error.message); }
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
    } catch (error) { showError(error.message); }
    return;
  }
  if (action === "close-camera") { webcam?.stop(); webcam = null; modal = null; render(); return; }
  if (action === "capture-photo") {
    if (!setButtonBusy(button, true)) return;
    try { await capturePhoto(); } catch (error) { showError(error.message); webcam?.stop(); webcam = null; modal = null; render(); }
    return;
  }
  if (action === "open-orders") { orderFilter = "Tất cả"; navigate({ name: "orders" }); return; }
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
  if (action === "open-order") { navigate({ name: "order", orderId: id, fromSession: false }); void hydrateOrderDetail(id); return; }
  if (action === "open-order-session") { navigate({ name: "order", orderId: id, fromSession: true }); void hydrateOrderDetail(id); return; }
  if (action === "filter-orders") { orderFilter = button.dataset.filter; render(); return; }
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
      const selected = window._sessionSelection || [];
      const claimed = await claimUnassignedOrders(selected);
      await updateState(createSession(claimed, selected, window._sessionShifts || {}, Date.now(), window._sessionNotes || {}, window._sessionMaps || {}), "Phiên đã tạo · Sắp xếp tuyến trước khi bắt đầu.");
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
    window._sessionSelection = []; window._sessionShifts = {}; window._sessionNotes = {}; window._sessionMaps = {}; sessionDefaultShift = "Sáng"; navigate({ name: "session-create" }); return;
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
    try { await updateState(startSession(state), "Bắt đầu giao hàng."); } catch (error) { flash(error.message); }
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
  if (action === "add-session-orders") { if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; } window._addSelection = []; window._addNotes = {}; window._addMaps = {}; navigate({ name: "add-orders" }); return; }
  if (action === "toggle-add-order") {
    const selected = new Set(window._addSelection || []);
    if (selected.has(id)) selected.delete(id);
    else { selected.add(id); const notes = window._addNotes ||= {}; if (!Object.hasOwn(notes, id)) notes[id] = orderById(id)?.note || ""; const maps = window._addMaps ||= {}; if (!Object.hasOwn(maps, id)) maps[id] = orderById(id)?.mapsLink || ""; }
    window._addSelection = [...selected]; render(); return;
  }
  if (action === "confirm-add-orders") {
    if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; }
    try {
      const selected = window._addSelection || [];
      const claimed = await claimUnassignedOrders(selected);
      await updateState(addOrdersToSession(claimed, selected, addOrdersShift, window._addNotes || {}, window._addMaps || {}), "Đã thêm đơn vào phiên.");
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
    }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "close-modal") { modal = null; render(); return; }
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
  if (event.target.matches("#default-shift")) { sessionDefaultShift = event.target.value; return; }
  if (event.target.matches("#add-shift")) { addOrdersShift = event.target.value; return; }
  if (event.target.matches("[data-shift-selection]")) {
    const shifts = window._sessionShifts || {};
    shifts[event.target.dataset.shiftSelection] = event.target.value;
    window._sessionShifts = shifts;
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
  } else if (event.target.matches("[data-selection-maps]")) {
    const links = event.target.dataset.mapFlow === "session" ? (window._sessionMaps || {}) : (window._addMaps || {});
    links[event.target.dataset.selectionMaps] = event.target.value;
    if (event.target.dataset.mapFlow === "session") window._sessionMaps = links;
    else window._addMaps = links;
    const clearButton = event.target.parentElement.querySelector('[data-action="clear-selection-map"]');
    if (clearButton) clearButton.disabled = !event.target.value.trim();
  }
});

app.addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "login-form") {
    const data = new FormData(event.target);
    const username = data.get("username");
    const pin = String(data.get("pin") || "");
    const submit = event.target.querySelector('[type="submit"]');
    if (!Object.hasOwn(accounts, username) || !/^\d{4,6}$/.test(pin)) {
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
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && modal) { modal = null; render(); }
});

void initializeApp();
