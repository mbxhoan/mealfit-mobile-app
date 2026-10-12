import {
  addOrdersToSession,
  allowedPhotoCount,
  cancelSession,
  createSession,
  dueAmount,
  getSessionStats,
  markDelivered,
  markPaid,
  moveOrderInSession,
  normalizeState,
  pauseSession,
  removeOrderFromSession,
  reopenDeliveredOrder,
  resumeSession,
  setSessionOrderShift,
  SHIFT_OPTIONS,
  startSession,
  startSingleDelivery
} from "./domain.mjs";

const STORAGE_KEY = "mealfit-prototype-v3";
const DEMO_PIN = "1234";
const roles = { admin: "Admin", nhanvien: "Nhân viên", shipper: "Shipper" };
const roleNames = { admin: "Admin", nhanvien: "Nhân viên", shipper: "Shipper" };

const dishes = [
  { id: "cajun-100", name: "Ức gà cajun", weight: "100g", sale: 25000, cost: 17067, margin: 31.7 },
  { id: "cajun-150", name: "Ức gà cajun", weight: "150g", sale: 36000, cost: 25600, margin: 28.9 },
  { id: "cajun-200", name: "Ức gà cajun", weight: "200g", sale: 48000, cost: 34134, margin: 28.9 },
  { id: "nguvi-100", name: "Ức gà ngũ vị", weight: "100g", sale: 25000, cost: 16833, margin: 32.7 },
  { id: "nguvi-150", name: "Ức gà ngũ vị", weight: "150g", sale: 36000, cost: 25249, margin: 29.9 },
  { id: "nguvi-200", name: "Ức gà ngũ vị", weight: "200g", sale: 48000, cost: 33666, margin: 29.9 },
  { id: "sachanh-100", name: "Ức gà sả chanh", weight: "100g", sale: 25000, cost: 16474, margin: 34.1 },
  { id: "sachanh-150", name: "Ức gà sả chanh", weight: "150g", sale: 36000, cost: 24712, margin: 31.4 }
];

const demoCustomers = [
  { name: "Khách demo 01", phone: "000 000 0001", address: "Địa chỉ demo 01, P. Thảo Điền, TP.HCM" },
  { name: "Khách demo 02", phone: "000 000 0002", address: "Địa chỉ demo 02, P. Bình Thạnh, TP.HCM" },
  { name: "Khách demo 03", phone: "000 000 0003", address: "Địa chỉ demo 03, P. An Phú, TP.HCM" },
  { name: "Khách demo 04", phone: "000 000 0004", address: "Địa chỉ demo 04, P. Thảo Điền, TP.HCM" },
  { name: "Khách demo 05", phone: "000 000 0005", address: "Địa chỉ demo 05, P. Bình An, TP.HCM" },
  { name: "Khách demo 06", phone: "000 000 0006", address: "Địa chỉ demo 06, P. An Khánh, TP.HCM" },
  { name: "Khách demo 07", phone: "000 000 0007", address: "Địa chỉ demo 07, P. Bình Thạnh, TP.HCM" },
  { name: "Khách demo 08", phone: "000 000 0008", address: "Địa chỉ demo 08, P. Thảo Điền, TP.HCM" }
];

const line = (name, weight, quantity, unitPrice) => ({ name, weight, quantity, unitPrice });
const seedOrders = () => {
  const raw = [
    { id: "DH1001", customer: 0, items: [line("Combo giữ dáng", "Combo", 1, 219000)], shippingFee: 0, paidAmount: 219000, deliveryStatus: "Đã giao hàng", paymentMethod: "Chuyển khoản" },
    { id: "DH1002", customer: 1, items: [line("Ức gà cajun", "100g", 2, 25000)], shippingFee: 30000, paidAmount: 0, deliveryStatus: "Đã giao hàng", paymentMethod: null },
    { id: "DH1003", customer: 2, items: [line("Ức gà cajun", "200g", 1, 48000), line("Ức gà ngũ vị", "100g", 1, 25000)], shippingFee: 0, paidAmount: 0, deliveryStatus: "Chưa giao hàng", paymentMethod: null },
    { id: "DH1004", customer: 3, items: [line("Combo giảm cân", "Combo", 1, 345000)], shippingFee: 0, paidAmount: 0, deliveryStatus: "Chưa giao hàng", paymentMethod: null },
    { id: "DH1005", customer: 4, items: [line("Ức gà sả chanh", "150g", 2, 36000), line("Ức gà ngũ vị", "100g", 1, 25000)], shippingFee: 40000, paidAmount: 62000, deliveryStatus: "Chưa giao hàng", paymentMethod: "Tiền mặt" },
    { id: "DH1006", customer: 5, items: [line("Ức gà cajun", "150g", 1, 36000), line("Ức gà sả chanh", "100g", 2, 25000)], shippingFee: 35000, paidAmount: 0, deliveryStatus: "Đang giao hàng", deliveryMethod: "Grab", paymentMethod: null },
    { id: "DH1007", customer: 6, items: [line("Ức gà ngũ vị", "150g", 2, 36000)], shippingFee: 0, paidAmount: 72000, deliveryStatus: "Chưa giao hàng", paymentMethod: "Chuyển khoản" },
    { id: "DH1008", customer: 7, items: [line("Combo tăng cơ", "Combo", 1, 395000)], shippingFee: 0, paidAmount: 395000, deliveryStatus: "Chưa giao hàng", paymentMethod: "Chuyển khoản" }
  ];
  return raw.map((order, index) => {
    const customer = demoCustomers[order.customer];
    const subtotal = order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    return {
      ...order,
      ...customer,
      customer: customer.name,
      date: Date.now() - index * 18 * 60 * 60 * 1000,
      subtotal,
      total: subtotal + order.shippingFee,
      note: index === 4 ? "Gọi trước khi giao (ghi chú demo)" : "",
      sessionId: null,
      deliveredAt: order.deliveryStatus === "Đã giao hàng" ? Date.now() - index * 60 * 60 * 1000 : null,
      payments: order.paidAmount ? [{ method: order.paymentMethod, amount: order.paidAmount, paidAt: Date.now() - index * 60 * 60 * 1000 }] : []
    };
  });
};

const newDemoState = () => ({ orders: seedOrders(), sessions: [], activeSessionId: null });
let state = loadState();
let role = null;
let viewStack = [{ name: "login" }];
let orderFilter = "Tất cả";
let sessionTab = "route";
let selectedOrderId = null;
let selectedPayment = null;
let modal = null;
let sessionDefaultShift = "Sáng";
let addOrdersShift = "Sáng";
let toastTimer = null;
let photoDbPromise = null;
const photoUrls = new Map();
const app = document.querySelector("#app");

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return newDemoState();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed.orders) || !Array.isArray(parsed.sessions)) return newDemoState();
    return normalizeState(parsed);
  } catch {
    return newDemoState();
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

const currentView = () => viewStack.at(-1);
const orderById = id => state.orders.find(order => order.id === id);
const activeSession = () => state.sessions.find(session => session.id === state.activeSessionId && ["notStarted", "active", "paused"].includes(session.status));
const isStaff = () => role === "admin" || role === "nhanvien";
const money = amount => `${Math.round(Number(amount) || 0).toLocaleString("vi-VN")}đ`;
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
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
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
  camera: '<path d="M14 5h-4L8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 14v5h14v-5"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h3a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>'
};

function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;
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
    : `<div class="brand"><img src="../logo-transparent.png" alt="Logo" /></div>`;
  const tools = `${refresh ? `<button class="icon-button" data-action="refresh" aria-label="Làm mới thông tin">${icon("refresh")}</button>` : ""}<button class="role-chip" data-action="logout" aria-label="Đổi tài khoản hoặc đăng xuất">${safe(roleNames[role] || "")}</button>`;
  return `<div class="app-shell"><header class="topbar">${left}<div class="topbar-tools">${tools}</div></header>${content}</div>${renderModal()}`;
}

function loginScreen() {
  return `<main class="login-page">
    <div class="login-brand"><img src="../logo-transparent.png" alt="Logo"/></div>
    <form class="login-form" id="login-form">
      <div class="form-field"><label for="username">Tài khoản</label><select class="select" id="username" name="username" required><option value="">Chọn tài khoản demo</option><option value="admin">Admin</option><option value="nhanvien">Nhân viên</option><option value="shipper">Shipper</option></select></div>
      <div class="form-field"><label for="pin">Mã PIN</label><input class="input" id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="Nhập PIN 4 số" autocomplete="off" required /></div>
      <p class="login-error" id="login-error" aria-live="polite"></p>
      <button class="button full" type="submit">Đăng nhập ${icon("chevron", 18)}</button>
      <div class="demo-note"><strong>Tài khoản trình diễn</strong><br/>admin · nhanvien · shipper<br/>PIN: 1234</div>
      <p class="fine-print" style="text-align:center">Dữ liệu đơn hàng và khách hàng trong bản này đều là dữ liệu giả.</p>
    </form>
  </main>`;
}

function orderCounts() {
  return {
    pending: state.orders.filter(order => order.deliveryStatus === "Chưa giao hàng").length,
    transit: state.orders.filter(order => order.deliveryStatus === "Đang giao hàng").length,
    delivered: state.orders.filter(order => order.deliveryStatus === "Đã giao hàng").length
  };
}

function homeScreen() {
  const counts = orderCounts();
  const menu = [
    { title: "Đơn hàng", count: `${state.orders.length} đơn mẫu`, icon: "orders", action: "orders" },
    { title: "Món", count: `${dishes.length} mức giá`, icon: "dish", action: "dishes" },
    { title: "Giao hàng", count: role === "shipper" ? (activeSession() ? "Tiếp tục phiên giao" : "Tạo phiên giao") : "Giao lẻ · Theo dõi phiên", icon: "delivery", action: "delivery" }
  ];
  return `<main class="page">
    <p class="home-date">${dateLabel(Date.now())} · Dữ liệu trình diễn</p>
    <div class="page-heading"><div><h1>Xin chào</h1><p>${safe(roleNames[role])}, hôm nay mình xử lý đơn nào?</p></div></div>
    <div class="home-summary" aria-label="Tóm tắt đơn hàng">
      <div class="summary-cell"><span class="summary-number">${counts.pending}</span><span class="summary-label">Chưa giao</span></div>
      <div class="summary-cell"><span class="summary-number">${counts.transit}</span><span class="summary-label">Đang giao</span></div>
      <div class="summary-cell"><span class="summary-number">${counts.delivered}</span><span class="summary-label">Đã giao</span></div>
    </div>
    <h2 class="section-title">Menu</h2>
    <div class="menu-grid">${menu.map(item => `<button class="menu-card" data-action="open-${item.action}"><span class="menu-icon">${icon(item.icon, 23)}</span><span><span class="menu-label">${item.title}</span><span class="menu-count">${item.count}</span></span></button>`).join("")}</div>
    ${activeSession() && role === "shipper" ? `<div class="divider"></div><button class="button full" data-action="open-session">Tiếp tục phiên giao hàng ${icon("chevron", 18)}</button>` : ""}
  </main>`;
}

function orderCard(order, clickable = true, selected = false) {
  const due = dueAmount(order);
  return `<div class="list-card ${clickable ? "clickable" : ""} ${selected ? "select-order selected" : ""}" ${clickable ? `data-action="open-order" data-id="${safe(order.id)}"` : ""}>
    ${selected ? '<span class="checkmark" aria-hidden="true"></span>' : ""}
    <div style="flex:1;min-width:0">
      <div class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.deliveryStatus)}</div>
      <p class="order-customer">${safe(order.customer)}</p><p class="order-address">${safe(order.address)}</p>
      <div class="order-subline">${order.items.reduce((sum, item) => sum + item.quantity, 0)} món · ${dateLabel(order.date)} · ${statusBadge(due ? "Chưa thanh toán" : "Đã thanh toán", "payment")}</div>
      <div class="card-bottom"><span class="money">${money(order.total)}${due ? `<small class="money-sub">Còn thu ${money(due)}</small>` : ""}</span><span>${icon("chevron", 18)}</span></div>
    </div>
  </div>`;
}

function ordersScreen() {
  const filters = ["Tất cả", "Chưa giao hàng", "Đang giao hàng", "Đã giao hàng"];
  const orders = orderFilter === "Tất cả" ? state.orders : state.orders.filter(order => order.deliveryStatus === orderFilter);
  return `<main class="page"><div class="page-heading"><div><h1>Đơn hàng</h1><p>Danh sách đơn mẫu, chỉ xem</p></div></div>
    <div class="filter-row">${filters.map(filter => `<button class="filter-chip ${orderFilter === filter ? "active" : ""}" data-action="filter-orders" data-filter="${safe(filter)}">${safe(filter)}</button>`).join("")}</div>
    <div class="list">${orders.length ? orders.map(order => orderCard(order)).join("") : '<div class="empty-state"><strong>Chưa có đơn trong mục này</strong>Đơn hàng sẽ xuất hiện tại đây khi có dữ liệu.</div>'}</div>
  </main>`;
}

function dishesScreen() {
  return `<main class="page"><div class="page-heading"><div><h1>Món</h1><p>Bảng giá mẫu theo khẩu phần</p></div></div>
    <div class="detail-card"><div class="detail-section"><h2>Tên món · khẩu phần</h2>${dishes.map(dish => `<div class="dish-row"><div><div class="dish-name">${safe(dish.name)}</div><div class="dish-meta">${safe(dish.weight)}${isStaff() ? ` · Vốn ${money(dish.cost)}` : ""}</div></div><div class="dish-price">${money(dish.sale)}${isStaff() ? `<small class="profit">Lãi ${dish.margin.toFixed(1)}%</small>` : ""}</div></div>`).join("")}</div></div>
    <p class="fine-print" style="margin-top:12px">Giá tham khảo từ danh mục món trong workbook. Dữ liệu trong prototype không đồng bộ với file.</p>
  </main>`;
}

function paymentSummary(order) {
  const due = dueAmount(order);
  return `<div class="detail-row"><span>Trạng thái</span><span>${statusBadge(due ? "Chưa thanh toán" : "Đã thanh toán", "payment")}</span></div>
    <div class="detail-row"><span>Đã thanh toán</span><span>${money(order.paidAmount)}</span></div>
    <div class="detail-row"><span>Còn phải thu</span><span class="${due ? "" : "profit"}">${money(due)}</span></div>${order.paymentMethod ? `<div class="detail-row"><span>Phương thức gần nhất</span><span>${safe(order.paymentMethod)}</span></div>` : ""}`;
}

function photoSection(order, locked = false) {
  return `<section class="detail-section"><h2>Ảnh xác nhận <span class="fine-print">(tối đa 5 ảnh)</span></h2><p class="fine-print">Có thể chụp ảnh đơn hàng hoặc ảnh thanh toán. Mỗi ảnh tối đa 15 MB.</p>
    <div class="photo-grid" data-photo-order="${safe(order.id)}"><span class="fine-print">Đang tải ảnh…</span></div>
    <div class="form-field"><label for="photo-kind">Loại ảnh</label><select class="select" id="photo-kind" ${locked ? "disabled" : ""}><option value="order">Ảnh đơn hàng</option><option value="payment">Ảnh xác nhận thanh toán</option></select></div>
    <div class="photo-tools"><button class="button secondary small" data-action="choose-photo" data-source="camera" ${locked ? "disabled" : ""}>${icon("camera", 18)} Chụp ảnh</button><button class="button secondary small" data-action="choose-photo" data-source="upload" ${locked ? "disabled" : ""}>${icon("upload", 18)} Tải ảnh</button></div>
    ${locked ? '<p class="fine-print">Tiếp tục phiên để thay đổi ảnh.</p>' : ""}
    <input class="hidden-input" id="camera-input" type="file" accept="image/*" capture="environment" data-photo-kind="order" ${locked ? "disabled" : ""} />
    <input class="hidden-input" id="upload-input" type="file" accept="image/*" multiple data-photo-kind="payment" ${locked ? "disabled" : ""} />
  </section>`;
}

function orderDetailScreen(view) {
  const order = orderById(view.orderId);
  if (!order) return `<main class="page"><div class="empty-state">Không tìm thấy đơn hàng.</div></main>`;
  const fromSession = Boolean(view.fromSession && role === "shipper");
  const due = dueAmount(order);
  const session = activeSession();
  const sessionPaused = session?.status === "paused";
  const isNextStop = !session || session.orderIds.find(id => !session.legs[id]?.completedAt) === order.id;
  const actions = fromSession && !sessionPaused && session?.status === "active" && order.deliveryStatus === "Đang giao hàng" && isNextStop
    ? `<div class="bottom-actions ${due ? "" : "single"}">${due ? `<button class="button secondary" data-action="pay-order" data-id="${safe(order.id)}">Đã thanh toán</button>` : ""}<button class="button ${due ? "" : "full"}" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao hàng</button></div>`
    : fromSession && order.deliveryStatus === "Đang giao hàng" ? `<div class="bottom-actions single"><p class="fine-print">${sessionPaused ? "Tiếp tục phiên để giao hàng." : "Hoàn tất điểm giao hiện tại trước khi xác nhận đơn này."}</p></div>` : "";
  const mayCorrect = order.deliveryStatus === "Đã giao hàng" && (isStaff() || role === "shipper") && !sessionPaused;
  return `<main class="page ${sessionPaused ? "paused" : ""}"><div class="page-heading"><div><p class="eyebrow">${safe(order.id)} · ${dateLabel(order.date)}</p><h1>Chi tiết đơn</h1></div>${statusBadge(order.deliveryStatus)}</div>
    <div class="detail-card">
      <section class="detail-section"><h2>Khách hàng</h2><div class="detail-row"><span>Tên khách</span><span>${safe(order.customer)}</span></div><div class="detail-row"><span>Điện thoại</span><span><a class="inline-link" href="tel:${safe(order.phone.replace(/\D/g, ""))}">${icon("phone", 15)} ${safe(order.phone)}</a></span></div><div class="detail-row"><span>Địa chỉ</span><span>${safe(order.address)}</span></div>${order.note ? `<div class="detail-row"><span>Ghi chú</span><span>${safe(order.note)}</span></div>` : ""}</section>
      <section class="detail-section"><h2>Sản phẩm</h2>${order.items.map(item => `<div class="product-line"><span>${safe(item.name)}</span><span class="product-price">${money(item.unitPrice * item.quantity)}</span><small>${safe(item.weight)} · ${item.quantity} phần × ${money(item.unitPrice)}</small></div>`).join("")}</section>
      <section class="detail-section"><h2>Thanh toán</h2><div class="detail-row"><span>Tiền hàng</span><span>${money(order.subtotal)}</span></div><div class="detail-row"><span>Phí ship</span><span>${money(order.shippingFee)}</span></div><div class="detail-row total"><span>Tổng đơn</span><span>${money(order.total)}</span></div>${paymentSummary(order)}</section>
      <section class="detail-section"><h2>Giao hàng</h2><div class="detail-row"><span>Hình thức</span><span>${safe(order.deliveryMethod || "Chưa chọn")}</span></div><div class="detail-row"><span>Trạng thái</span><span>${statusBadge(order.deliveryStatus)}</span></div>${order.deliveredAt ? `<div class="detail-row"><span>Đã giao lúc</span><span>${timeLabel(order.deliveredAt)} · ${dateLabel(order.deliveredAt)}</span></div>` : ""}</section>
      ${photoSection(order, sessionPaused)}
    </div>${mayCorrect ? `<button class="button secondary full" style="margin-top:12px" data-action="reopen-order-status" data-id="${safe(order.id)}">Sửa trạng thái giao hàng</button>` : ""}${actions}
  </main>`;
}

function staffSessionsScreen() {
  const sessions = [...state.sessions].sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
  return `<main class="page"><div class="page-heading"><div><h1>Phiên giao hàng</h1><p>Theo dõi tiến độ các tuyến</p></div></div>
    <div class="list">${sessions.map(session => {
      const stats = getSessionStats(state, session.id);
      const timestamp = session.startedAt || session.createdAt;
      return `<button class="list-card clickable" data-action="open-session-history" data-id="${safe(session.id)}"><div class="card-top"><span class="order-number">${dateLabel(timestamp)} · ${session.startedAt ? timeLabel(timestamp) : "Chưa bắt đầu"}</span>${sessionBadge(session.status)}</div><p class="order-customer">${stats.remainingCount} đơn còn giao · ${stats.totalValue ? money(stats.totalValue) : "0đ"}</p><p class="order-address">${session.orderIds.map(id => safe(orderById(id)?.customer || id)).join(" · ") || "Chưa có điểm giao"}</p></button>`;
    }).join("") || '<div class="empty-state">Chưa có phiên giao hàng.</div>'}</div>
  </main>`;
}

function singleDeliveryScreen() {
  if (!isStaff()) return `<main class="page"><div class="empty-state"><strong>Không có quyền truy cập</strong>Giao lẻ dành cho admin và nhân viên.</div></main>`;
  const pending = state.orders.filter(order => order.deliveryStatus === "Chưa giao hàng");
  const transit = state.orders.filter(order => order.deliveryStatus === "Đang giao hàng" && !order.sessionId);
  const selected = orderById(selectedOrderId);
  return `<main class="page"><div class="page-heading"><div><h1>Giao lẻ</h1><p>Chọn đơn và ghi phí ship thực tế</p></div></div>
    <button class="button secondary full" style="margin-bottom:18px" data-action="open-session-overview">Tình hình phiên giao hàng ${icon("chevron", 18)}</button>
    <h2 class="section-title" style="margin-top:0">Đơn chưa giao <small>${pending.length} đơn</small></h2>
    <div class="list">${pending.map(order => `<button class="list-card select-order ${selectedOrderId === order.id ? "selected" : ""}" aria-pressed="${selectedOrderId === order.id}" data-action="select-single-order" data-id="${safe(order.id)}"><span class="checkmark" aria-hidden="true"></span><span style="flex:1"><span class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(dueAmount(order) ? "Chưa thanh toán" : "Đã thanh toán", "payment")}</span><span class="order-customer">${safe(order.customer)}</span><span class="order-address">${safe(order.address)}</span><span class="order-subline">Tổng hiện tại ${money(order.total)}${dueAmount(order) ? ` · Còn thu ${money(dueAmount(order))}` : ""}</span></span></button>`).join("") || '<div class="empty-state">Không còn đơn đang chờ giao.</div>'}</div>
    ${selected ? `<form id="single-form" class="detail-card" style="margin-top:16px;padding:16px"><h2 style="margin:0 0 6px">Bắt đầu giao · ${safe(selected.id)}</h2><div class="form-field"><label for="delivery-method">Hình thức giao hàng</label><select class="select" id="delivery-method" name="method">${["Be", "GreenSM", "Grab", "Shipper"].map((method, index) => `<option ${index === 0 ? "selected" : ""}>${method}</option>`).join("")}</select></div><div class="form-field"><label for="shipping-fee">Phí ship thực tế</label><input class="input" id="shipping-fee" name="shippingFee" type="number" min="0" step="1000" inputmode="numeric" value="${selected.shippingFee}" required /></div><button class="button full" type="submit">Bắt đầu giao ${icon("chevron", 18)}</button></form>` : ""}
    <h2 class="section-title">Đang giao <small>${transit.length} đơn giao lẻ</small></h2>
    <div class="list">${transit.map(order => `<div class="list-card"><div class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(order.deliveryStatus)}</div><p class="order-customer">${safe(order.customer)}</p><p class="order-address">${safe(order.address)}</p><div class="card-bottom"><span><span class="money">${money(order.total)}</span><small class="money-sub">${safe(order.deliveryMethod || "")}</small></span><div class="button-row" style="width:auto"><button class="button secondary small" data-action="open-order" data-id="${safe(order.id)}">Chi tiết</button><button class="button small" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao</button></div></div></div>`).join("") || '<div class="empty-state">Chưa có đơn giao lẻ nào đang đi.</div>'}</div>
  </main>`;
}

function sessionCreateScreen() {
  if (role !== "shipper") return `<main class="page"><div class="empty-state">Phiên giao hàng dành cho shipper.</div></main>`;
  if (activeSession()) return sessionScreen();
  const pending = state.orders.filter(order => order.deliveryStatus === "Chưa giao hàng");
  const selectedIds = window._sessionSelection || [];
  const shifts = window._sessionShifts || {};
  const shiftOptions = (selected, id) => `<select class="shift-select" aria-label="Ca giao đơn ${safe(id)}" data-shift-selection="${safe(id)}">${SHIFT_OPTIONS.map(shift => `<option ${shift === selected ? "selected" : ""}>${shift}</option>`).join("")}</select>`;
  return `<main class="page"><div class="page-heading"><div><h1>Tạo phiên</h1><p>Chọn đơn hàng cho tuyến giao này</p></div></div>
    <div class="form-field"><label for="default-shift">Ca mặc định</label><select class="select" id="default-shift">${SHIFT_OPTIONS.map(shift => `<option ${shift === sessionDefaultShift ? "selected" : ""}>${shift}</option>`).join("")}</select></div>
    <div class="list">${pending.map(order => {
      const selected = selectedIds.includes(order.id);
      return `<div class="list-card shift-selection-row"><button class="select-order ${selected ? "selected" : ""}" aria-pressed="${selected}" data-action="toggle-session-order" data-id="${safe(order.id)}"><span class="checkmark" aria-hidden="true"></span><span style="flex:1"><span class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(dueAmount(order) ? "Chưa thanh toán" : "Đã thanh toán", "payment")}</span><span class="order-customer">${safe(order.customer)}</span><span class="order-address">${safe(order.address)}</span><span class="order-subline">${order.items.length} dòng · ${money(order.total)}</span></span></button>${selected ? shiftOptions(shifts[order.id] || sessionDefaultShift, order.id) : ""}</div>`;
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
  const stopCard = (order, index) => {
    const done = isDone(order);
    const currentStop = order.id === nextId;
    const leg = session.legs[order.id];
    const detail = `<button class="stop-detail-link" data-action="open-order-session" data-id="${safe(order.id)}">Xem chi tiết đơn ${icon("chevron", 14)}</button>`;
    return `<div class="route-stop ${done ? "done" : currentStop ? "current" : ""}"><div class="stop-mark">${done ? icon("check", 17) : index + 1}</div><div class="stop-card"><div class="stop-head"><div style="min-width:0"><p class="stop-title">${safe(order.customer)}</p><p class="stop-caption">${safe(order.id)} · ${safe(order.address)}</p>${shiftSelect(order)}</div><div class="stop-tools">${editable && !done ? `<button class="mini-button" data-action="move-stop" data-id="${safe(order.id)}" data-offset="-1" aria-label="Đưa ${safe(order.id)} lên">${icon("up", 17)}</button><button class="mini-button" data-action="move-stop" data-id="${safe(order.id)}" data-offset="1" aria-label="Đưa ${safe(order.id)} xuống">${icon("down", 17)}</button><button class="mini-button" data-action="remove-stop" data-id="${safe(order.id)}" aria-label="Bỏ ${safe(order.id)} khỏi phiên">${icon("close", 17)}</button>` : ""}</div></div>
      <div class="stop-total">${money(order.total)} ${dueAmount(order) ? `<small class="money-sub">Còn thu ${money(dueAmount(order))}</small>` : `<small class="money-sub">Đã thanh toán</small>`}</div>
      <a class="button secondary small stop-call" href="tel:${safe(order.phone.replace(/\D/g, ""))}" aria-label="Gọi ${safe(order.customer)}">${icon("phone", 16)} Gọi khách</a>
      ${leg ? `<div class="leg-time">${icon("clock", 14)} Chặng này: ${elapsedLabel(leg.durationMs)} · ${timeLabel(leg.completedAt)}</div>` : ""}
      ${currentStop && session.status === "paused" ? `<div class="stop-actions"><button class="button secondary small" disabled>Đã thanh toán</button><button class="button small" disabled>Đã giao hàng</button></div>` : ""}
      ${currentStop && delivering ? `<div class="stop-actions">${dueAmount(order) ? `<button class="button secondary small" data-action="pay-order" data-id="${safe(order.id)}">Đã thanh toán</button>` : ""}<button class="button small ${dueAmount(order) ? "" : "full"}" data-action="deliver-order" data-id="${safe(order.id)}">Đã giao hàng</button></div>` : ""}${detail}</div></div>`;
  };
  const controls = role === "shipper" && session.status === "notStarted"
    ? `<div class="session-controls"><button class="button full" data-action="start-session">Bắt đầu giao</button><button class="button danger full" data-action="cancel-session">Hủy lộ trình</button></div>`
    : role === "shipper" && session.status === "active"
      ? `<div class="session-controls"><button class="button secondary full" data-action="pause-session">Tạm dừng</button><button class="button danger full" data-action="cancel-session">Hủy lộ trình</button></div>`
      : role === "shipper" && session.status === "paused"
        ? `<div class="paused-note">Các thao tác giao hàng đang khóa.</div><div class="session-controls"><button class="button full" data-action="resume-session">Tiếp tục</button><button class="button danger full" data-action="cancel-session">Hủy lộ trình</button></div>`
        : role === "shipper" && ["completed", "cancelled"].includes(session.status) && !activeSession()
          ? `<button class="button full" style="margin:16px 0" data-action="new-session">Tạo phiên mới</button>` : "";
  const shiftSummary = stats.shifts.map(item => `<span class="shift-summary ${item.done ? "done" : ""}">${item.done ? icon("check", 14) : ""}${item.shift} ${item.completed}/${item.total}</span>`).join("");
  const unassigned = session.orderIds.filter(id => !session.shifts?.[id]).length;
  return `<main class="page"><div class="page-heading"><div><p class="eyebrow">${safe(session.id)} · ${dateLabel(session.startedAt || session.createdAt)}</p><h1>Lộ trình</h1></div>${sessionBadge(session.status)}</div>
    <div class="route-progress"><div><strong>${completed} / ${orders.length} điểm</strong><br/><span>${session.startedAt ? `Bắt đầu ${timeLabel(session.startedAt)}` : "Chưa bắt đầu"}</span></div></div>
    <div class="route-stats"><div><span>Tiền mặt</span><strong>${money(stats.cashCollected)}</strong></div><div><span>Chuyển khoản</span><strong>${money(stats.transferCollected)}</strong></div><div><span>Còn giao</span><strong>${stats.remainingCount}</strong></div><div><span>Tổng tuyến</span><strong>${money(stats.totalValue)}</strong></div></div>
    <div class="shift-summary-list">${shiftSummary}${unassigned ? `<span class="shift-summary">Chưa phân ca ${unassigned}</span>` : ""}</div>${controls}
    <div class="route-tabs"><button class="route-tab ${sessionTab === "route" ? "active" : ""}" data-action="session-tab" data-tab="route">Lộ trình</button><button class="route-tab ${sessionTab === "orders" ? "active" : ""}" data-action="session-tab" data-tab="orders">Đơn trong phiên</button></div>
    ${sessionTab === "route" ? `<div class="route-list">${orders.map((order, index) => stopCard(order, index)).join("") || '<div class="empty-state">Phiên này chưa có điểm giao.</div>'}</div>` : `<div class="list">${orders.map((order, index) => `<div class="list-card"><div class="card-top"><span class="order-number">${index + 1}. ${safe(order.id)}</span>${statusBadge(routeStatus(order))}</div><p class="order-customer">${safe(order.customer)}</p><p class="order-address">${safe(order.address)}</p><div class="card-bottom"><span class="money">${money(order.total)}<small class="money-sub">${dueAmount(order) ? `Còn thu ${money(dueAmount(order))}` : "Đã thanh toán"}</small></span><button class="button secondary small" data-action="open-order-session" data-id="${safe(order.id)}">Chi tiết</button></div><div class="stop-tools" style="margin-top:10px">${editable && !isDone(order) ? `<button class="button secondary small" data-action="move-stop" data-id="${safe(order.id)}" data-offset="-1">${icon("up", 15)} Lên</button><button class="button secondary small" data-action="move-stop" data-id="${safe(order.id)}" data-offset="1">${icon("down", 15)} Xuống</button><button class="button danger small" data-action="remove-stop" data-id="${safe(order.id)}">Bỏ đơn</button>` : isDone(order) ? `<span class="leg-time">${elapsedLabel(session.legs[order.id].durationMs)}</span>` : ""}</div></div>`).join("")}</div>`}
    ${editable ? `<button class="button secondary full" style="margin-top:16px" data-action="add-session-orders">${icon("plus", 18)} Thêm đơn vào phiên</button>` : ""}
  </main>`;
}

function addOrdersScreen() {
  const session = activeSession();
  if (role !== "shipper" || !session || !["active", "notStarted"].includes(session.status)) return `<main class="page"><div class="empty-state">Tiếp tục phiên trước khi thêm đơn.</div></main>`;
  const pending = state.orders.filter(order => order.deliveryStatus === "Chưa giao hàng");
  const selectedIds = window._addSelection || [];
  return `<main class="page"><div class="page-heading"><div><h1>Thêm đơn</h1><p>Đơn mới sẽ được nối cuối tuyến</p></div></div>
    <div class="form-field"><label for="add-shift">Ca giao</label><select class="select" id="add-shift">${SHIFT_OPTIONS.map(shift => `<option ${shift === addOrdersShift ? "selected" : ""}>${shift}</option>`).join("")}</select></div>
    <div class="list">${pending.map(order => `<button class="list-card select-order ${selectedIds.includes(order.id) ? "selected" : ""}" aria-pressed="${selectedIds.includes(order.id)}" data-action="toggle-add-order" data-id="${safe(order.id)}"><span class="checkmark" aria-hidden="true"></span><span style="flex:1"><span class="card-top"><span class="order-number">${safe(order.id)}</span>${statusBadge(dueAmount(order) ? "Chưa thanh toán" : "Đã thanh toán", "payment")}</span><span class="order-customer">${safe(order.customer)}</span><span class="order-address">${safe(order.address)}</span><span class="order-subline">${money(order.total)}</span></span></button>`).join("") || '<div class="empty-state">Không có đơn chưa giao để thêm.</div>'}</div>
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
  if (view.name === "order") hydratePhotos(view.orderId);
}

function navigate(view) {
  modal = null;
  viewStack.push(view);
  render();
  window.scrollTo?.(0, 0);
}

function back() {
  if (modal) { modal = null; render(); return; }
  if (viewStack.length > 1) viewStack.pop();
  render();
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

function updateState(next, message) {
  state = next;
  const saved = persist();
  render();
  if (!saved) flash("Không lưu được dữ liệu trên thiết bị. Kiểm tra dung lượng trình duyệt.");
  else if (message) flash(message);
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

function deliverOrder(orderId) {
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
    updateState(next, "Đã ghi nhận giao hàng.");
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

async function openPhotoDb() {
  if (!("indexedDB" in window)) throw new Error("Trình duyệt này chưa hỗ trợ lưu ảnh trên thiết bị.");
  if (!photoDbPromise) photoDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("mealfit-prototype", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("photos")) {
        const store = db.createObjectStore("photos", { keyPath: "id" });
        store.createIndex("orderId", "orderId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Không mở được kho ảnh."));
  });
  return photoDbPromise;
}

async function getOrderPhotos(orderId) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("photos", "readonly").objectStore("photos").index("orderId").getAll(orderId);
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.createdAt - b.createdAt));
    request.onerror = () => reject(request.error);
  });
}

async function putPhoto(photo) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("photos", "readwrite").objectStore("photos").put(photo);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deletePhoto(id) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("photos", "readwrite").objectStore("photos").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function hydratePhotos(orderId) {
  const target = document.querySelector(`[data-photo-order="${CSS.escape(orderId)}"]`);
  if (!target) return;
  try {
    const photos = await getOrderPhotos(orderId);
    if (!target.isConnected) return;
    if (!photos.length) { target.innerHTML = '<span class="fine-print">Chưa có ảnh.</span>'; return; }
    target.innerHTML = photos.map(photo => {
      if (!photoUrls.has(photo.id)) photoUrls.set(photo.id, URL.createObjectURL(photo.blob));
      const locked = activeSession()?.status === "paused";
      return `<div class="photo-tile"><img src="${photoUrls.get(photo.id)}" alt="Ảnh ${safe(photo.kind === "payment" ? "xác nhận thanh toán" : "đơn hàng")}"/><button class="photo-remove" data-action="delete-photo" data-id="${safe(photo.id)}" aria-label="Xóa ảnh" ${locked ? "disabled" : ""}>${icon("close", 15)}</button><span class="photo-label">${photo.kind === "payment" ? "Ảnh thanh toán" : "Ảnh đơn hàng"}</span></div>`;
    }).join("");
  } catch {
    if (target.isConnected) target.innerHTML = '<span class="fine-print">Không tải được ảnh đã lưu.</span>';
  }
}

async function resizeImage(file) {
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

async function saveProofFiles(input) {
  if (activeSession()?.status === "paused") { input.value = ""; flash("Tiếp tục phiên trước khi thêm ảnh."); return; }
  const orderId = currentView().orderId;
  const kind = input.dataset.photoKind;
  const files = [...(input.files || [])];
  input.value = "";
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
        const photo = { id: crypto.randomUUID(), orderId, kind, name: file.name, blob, createdAt: Date.now() };
        await putPhoto(photo);
        saved++;
      } catch { flash(`Không đọc được ảnh ${file.name}.`); }
    }
    await hydratePhotos(orderId);
    if (validFiles.length > allowedCount) flash("Chỉ 5 ảnh được lưu cho mỗi đơn.");
    else if (saved) flash(`${saved} ảnh đã lưu trên thiết bị.`);
  } catch { flash("Không lưu được ảnh trên thiết bị này."); }
}

app.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "backdrop" && event.target === button) { modal = null; render(); return; }
  if (action === "back") { back(); return; }
  if (action === "logout") {
    role = null; viewStack = [{ name: "login" }]; modal = null; render(); return;
  }
  if (action === "refresh") {
    state = loadState(); render(); flash("Đã tải dữ liệu trên thiết bị · Chưa kết nối API."); return;
  }
  if (action === "open-orders") { orderFilter = "Tất cả"; navigate({ name: "orders" }); return; }
  if (action === "open-dishes") { navigate({ name: "dishes" }); return; }
  if (action === "open-delivery") {
    if (role === "shipper") {
      if (activeSession()) { sessionTab = "route"; navigate({ name: "session" }); }
      else { navigate({ name: "session" }); }
    } else if (isStaff()) { selectedOrderId = null; navigate({ name: "delivery" }); }
    else flash("Tài khoản này không có quyền giao hàng.");
    return;
  }
  if (action === "open-session-overview") { navigate({ name: "sessions-overview" }); return; }
  if (action === "open-session") { sessionTab = "route"; navigate({ name: "session" }); return; }
  if (action === "open-session-history") { sessionTab = "route"; navigate({ name: "session", sessionId: id }); return; }
  if (action === "open-order") { navigate({ name: "order", orderId: id, fromSession: false }); return; }
  if (action === "open-order-session") { navigate({ name: "order", orderId: id, fromSession: true }); return; }
  if (action === "filter-orders") { orderFilter = button.dataset.filter; render(); return; }
  if (action === "select-single-order") { selectedOrderId = selectedOrderId === id ? null : id; render(); return; }
  if (action === "create-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể tạo phiên giao hàng."); return; }
    try {
      updateState(createSession(state, window._sessionSelection || [], window._sessionShifts || {}), "Phiên đã tạo · Sắp xếp tuyến trước khi bắt đầu.");
      window._sessionSelection = [];
      window._sessionShifts = {};
      viewStack[viewStack.length - 1] = { name: "session" };
      sessionTab = "route"; render();
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "new-session") {
    if (role !== "shipper") { flash("Phiên giao hàng dành cho shipper."); return; }
    if (activeSession()) { flash("Hoàn tất phiên hiện tại trước khi tạo phiên mới."); return; }
    if (currentView().name === "session" && viewStack.length > 1) viewStack.pop();
    window._sessionSelection = []; window._sessionShifts = {}; sessionDefaultShift = "Sáng"; navigate({ name: "session-create" }); return;
  }
  if (action === "toggle-session-order") {
    const selected = new Set(window._sessionSelection || []);
    const shifts = window._sessionShifts || {};
    if (selected.has(id)) { selected.delete(id); delete shifts[id]; }
    else { selected.add(id); shifts[id] = sessionDefaultShift; }
    window._sessionSelection = [...selected]; render(); return;
  }
  if (action === "start-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể bắt đầu phiên."); return; }
    try { updateState(startSession(state), "Bắt đầu giao hàng."); } catch (error) { flash(error.message); }
    return;
  }
  if (action === "pause-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể tạm dừng phiên."); return; }
    try { updateState(pauseSession(state), "Đã tạm dừng lộ trình."); } catch (error) { flash(error.message); }
    return;
  }
  if (action === "resume-session") {
    if (role !== "shipper") { flash("Chỉ shipper có thể tiếp tục phiên."); return; }
    try { updateState(resumeSession(state), "Đã tiếp tục lộ trình."); } catch (error) { flash(error.message); }
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
      modal = null; updateState(next, "Đã hủy lộ trình.");
    }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "session-tab") { sessionTab = button.dataset.tab; render(); return; }
  if (action === "move-stop") {
    if (role !== "shipper") { flash("Chỉ shipper có thể sắp xếp tuyến."); return; }
    try { updateState(moveOrderInSession(state, id, Number(button.dataset.offset))); } catch (error) { flash(error.message); }
    return;
  }
  if (action === "remove-stop") { if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; } modal = { type: "remove-stop", orderId: id }; render(); return; }
  if (action === "confirm-remove-stop") {
    if (role !== "shipper") { modal = null; render(); flash("Chỉ shipper có thể chỉnh sửa phiên."); return; }
    try { updateState(removeOrderFromSession(state, modal.orderId), "Đơn đã trở về danh sách chưa giao."); modal = null; render(); }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "reopen-order-status") {
    const order = orderById(id);
    if (!order || order.deliveryStatus !== "Đã giao hàng" || (!isStaff() && role !== "shipper")) { flash("Tài khoản này không thể sửa trạng thái đơn."); return; }
    if (activeSession()?.status === "paused") { flash("Tiếp tục phiên trước khi sửa đơn."); return; }
    modal = { type: "reopen-order", orderId: id, shift: "Sáng" }; render(); return;
  }
  if (action === "confirm-reopen-order") {
    const orderId = modal?.orderId;
    const deliveryStatus = button.dataset.status;
    if ((!isStaff() && role !== "shipper") || !orderId) { modal = null; render(); flash("Tài khoản này không thể sửa trạng thái đơn."); return; }
    try {
      state = reopenDeliveredOrder(state, orderId, deliveryStatus, document.querySelector("#reopen-shift")?.value || modal.shift);
      const saved = persist(); modal = null; render();
      flash(saved ? deliveryStatus === "Đang giao hàng" ? "Đơn đã được thêm lại vào tuyến." : "Đơn đã trở về danh sách chưa giao." : "Không lưu được dữ liệu trên thiết bị.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "add-session-orders") { if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; } window._addSelection = []; navigate({ name: "add-orders" }); return; }
  if (action === "toggle-add-order") {
    const selected = new Set(window._addSelection || []);
    selected.has(id) ? selected.delete(id) : selected.add(id);
    window._addSelection = [...selected]; render(); return;
  }
  if (action === "confirm-add-orders") {
    if (role !== "shipper") { flash("Chỉ shipper có thể chỉnh sửa phiên."); return; }
    try {
      updateState(addOrdersToSession(state, window._addSelection || [], addOrdersShift), "Đã thêm đơn vào phiên.");
      window._addSelection = []; viewStack.pop(); sessionTab = "route"; render();
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "pay-order") { openPayment(id); return; }
  if (action === "choose-payment") { modal.method = button.dataset.method; render(); return; }
  if (action === "confirm-payment") {
    const order = modal && orderById(modal.orderId);
    const session = order?.sessionId ? activeSession() : null;
    if (!role || !order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { modal = null; render(); flash("Tài khoản này không có quyền cập nhật thanh toán."); return; }
    try {
      state = markPaid(state, modal.orderId, modal.method);
      const saved = persist(); modal = null; render(); flash(saved ? "Đã ghi nhận thanh toán." : "Không lưu được dữ liệu trên thiết bị.");
    } catch (error) { flash(error.message); }
    return;
  }
  if (action === "deliver-order") { deliverOrder(id); return; }
  if (action === "confirm-delivery-unpaid") {
    const orderId = modal.orderId;
    const order = orderById(orderId);
    const session = order?.sessionId ? activeSession() : null;
    if (!order || (order.sessionId ? role !== "shipper" || session?.id !== order.sessionId || session.status !== "active" : !isStaff())) { modal = null; render(); flash("Tài khoản này không có quyền cập nhật đơn hàng."); return; }
    try {
      const next = markDelivered(state, orderId);
      if (!next.activeSessionId && order.sessionId) showSessionHistory(order.sessionId);
      state = next; const saved = persist(); modal = null; render(); flash(saved ? "Đã giao hàng, khoản phải thu vẫn được ghi nhận." : "Không lưu được dữ liệu trên thiết bị.");
    }
    catch (error) { modal = null; render(); flash(error.message); }
    return;
  }
  if (action === "close-modal") { modal = null; render(); return; }
  if (action === "choose-photo") {
    const input = button.dataset.source === "camera" ? document.querySelector("#camera-input") : document.querySelector("#upload-input");
    input.dataset.photoKind = document.querySelector("#photo-kind")?.value || "order";
    input?.click(); return;
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
    try { updateState(setSessionOrderShift(state, event.target.dataset.sessionShift, event.target.value)); }
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

app.addEventListener("submit", event => {
  event.preventDefault();
  if (event.target.id === "login-form") {
    const data = new FormData(event.target);
    const username = data.get("username");
    if (!Object.hasOwn(roles, username) || data.get("pin") !== DEMO_PIN) {
      document.querySelector("#login-error").textContent = "Tài khoản hoặc PIN chưa đúng.";
      return;
    }
    role = username;
    viewStack = [{ name: "home" }];
    render();
    return;
  }
  if (event.target.id === "single-form") {
    if (!isStaff()) { flash("Chỉ admin và nhân viên có thể giao lẻ."); return; }
    const data = new FormData(event.target);
    const fee = Number(data.get("shippingFee"));
    const orderId = selectedOrderId;
    try {
      const next = startSingleDelivery(state, orderId, data.get("method"), fee);
      selectedOrderId = null;
      updateState(next, "Đơn đã chuyển sang đang giao.");
    } catch (error) { flash(error.message); }
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && modal) { modal = null; render(); }
});

window.addEventListener("storage", event => {
  if (event.key === STORAGE_KEY && event.newValue) { state = loadState(); render(); }
});

persist();
render();
