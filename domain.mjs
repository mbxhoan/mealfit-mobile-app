export const DELIVERY_METHODS = ["Be", "GreenSM", "Grab", "Shipper"];
export const PAYMENT_METHODS = ["Tiền mặt", "Chuyển khoản", "Khác"];
export const SHIFT_OPTIONS = ["Sáng", "Chiều", "Tối"];
export const MAX_PHOTOS_PER_ORDER = 5;

const OPEN_SESSION_STATUSES = ["notStarted", "active", "paused"];

export function classifyNetworkSignal(online, connection = {}) {
  if (!online || connection.type === "none") return "offline";
  return ["slow-2g", "2g", "3g"].includes(connection.effectiveType)
    || (Number.isFinite(connection.downlink) && connection.downlink < 1.5)
    || (Number.isFinite(connection.rtt) && connection.rtt > 500)
    ? "weak"
    : "stable";
}

export function allowedPhotoCount(existingCount, requestedCount) {
  return Math.max(0, Math.min(Math.floor(requestedCount), MAX_PHOTOS_PER_ORDER - Math.floor(existingCount)));
}

export const dueAmount = order => order.paymentStatus === "Đã thanh toán"
  ? 0
  : Math.max(0, Number.isFinite(Number(order.remainingDue)) ? Number(order.remainingDue) : order.total - order.paidAmount);

export function missingCriticalOrderFields(order) {
  const raw = order?.raw && typeof order.raw === "object" ? order.raw : null;
  const amount = raw
    ? ["Tổng CÓ SHIP", "Sau giảm (đ)", "Tổng CHƯA SHIP"].map(key => raw[key]).find(value => value != null && String(value).trim() !== "")
    : order?.total;
  const parsedAmount = Number(String(amount ?? "").replace(/,/g, ""));
  const hasAmount = amount != null && String(amount).trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount >= 0;
  const missing = [];
  if (!String(order?.customer ?? "").trim()) missing.push("tên khách");
  if (!String(order?.phone ?? "").replace(/\D/g, "")) missing.push("SĐT");
  if (!String(order?.address ?? "").trim()) missing.push("địa chỉ");
  if (!hasAmount) missing.push("số tiền");
  if (!(raw ? ["Chưa thanh toán", "Đã thanh toán"].includes(raw["Trạng thái đơn"]) : ["Chưa thanh toán", "Đã thanh toán"].includes(order?.paymentStatus))) missing.push("trạng thái thanh toán");
  if (!(raw ? ["Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"].includes(raw["Trạng thái giao hàng"]) : ["Chưa giao hàng", "Đang giao hàng", "Đã giao hàng", "Đã huỷ đơn"].includes(order?.deliveryStatus))) missing.push("trạng thái giao hàng");
  return missing;
}

const shiftRank = shift => {
  const rank = SHIFT_OPTIONS.indexOf(shift);
  return rank < 0 ? SHIFT_OPTIONS.length : rank;
};

function sortPendingByShift(orderIds, shifts, legs) {
  const completed = orderIds.filter(id => legs[id]?.completedAt);
  const pending = orderIds.filter(id => !legs[id]?.completedAt);
  return [...completed, ...pending.sort((a, b) => shiftRank(shifts[a]) - shiftRank(shifts[b]))];
}

export function normalizeState(state) {
  const sessions = state.sessions.map(session => {
    const status = ["notStarted", "active", "paused", "completed", "cancelled"].includes(session.status)
      ? session.status
      : session.status === "completed" ? "completed" : session.startedAt ? "active" : "notStarted";
    const normalized = {
      ...session,
      status,
      createdAt: session.createdAt ?? session.startedAt ?? null,
      orderIds: Array.isArray(session.orderIds) ? session.orderIds : [],
      shifts: session.shifts || {},
      legs: session.legs || {},
      stopStarts: session.stopStarts || {},
      pauseIntervals: session.pauseIntervals || [],
      pausedAt: session.pausedAt ?? null,
      completedAt: session.completedAt ?? null
    };
    normalized.orderIds = sortPendingByShift(normalized.orderIds, normalized.shifts, normalized.legs);
    return normalized;
  });
  const active = sessions.find(session => session.id === state.activeSessionId && OPEN_SESSION_STATUSES.includes(session.status))
    || sessions.find(session => OPEN_SESSION_STATUSES.includes(session.status));
  return { ...state, sessions, activeSessionId: active?.id ?? null };
}

const updateOrder = (state, orderId, update) => ({
  ...state,
  orders: state.orders.map(order => order.id === orderId ? update(order) : order)
});

const getOrder = (state, orderId) => state.orders.find(order => order.id === orderId);
const getActiveSession = state => state.sessions.find(session => session.id === state.activeSessionId && OPEN_SESSION_STATUSES.includes(session.status));
const validShift = shift => shift == null || SHIFT_OPTIONS.includes(shift);

export function setOrderNote(state, orderId, note) {
  if (!getOrder(state, orderId)) throw new Error("Không tìm thấy đơn hàng.");
  return updateOrder(state, orderId, order => ({ ...order, note: String(note ?? "").trim() }));
}

export function normalizeGoogleMapsLink(link) {
  const value = String(link ?? "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    const googleMapsHost = ["maps.app.goo.gl", "google.com", "www.google.com", "maps.google.com"].includes(url.hostname);
    const hasMapPath = /\/maps(?:\/|$)/.test(url.pathname) || ["q", "query", "ll", "daddr"].some(key => url.searchParams.has(key));
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && googleMapsHost && (url.hostname === "maps.app.goo.gl" || hasMapPath)) return value;
  } catch {}
  throw new Error("Nhập link Google Maps hợp lệ bắt đầu bằng https://.");
}

export function setOrderMapsLink(state, orderId, link) {
  if (!getOrder(state, orderId)) throw new Error("Không tìm thấy đơn hàng.");
  const mapsLink = normalizeGoogleMapsLink(link);
  return updateOrder(state, orderId, order => ({ ...order, mapsLink }));
}

function editableSession(state) {
  const session = getActiveSession(state);
  if (!session || session.status === "paused") throw new Error("Tiếp tục phiên trước khi chỉnh sửa lộ trình.");
  return session;
}

function appendPause(session, resumedAt) {
  if (!session.pausedAt) return session.pauseIntervals;
  return [...session.pauseIntervals, { startedAt: session.pausedAt, resumedAt }];
}

function activeDuration(startedAt, completedAt, intervals = []) {
  const pausedMs = intervals.reduce((sum, interval) => {
    const start = Math.max(startedAt, interval.startedAt);
    const end = Math.min(completedAt, interval.resumedAt ?? completedAt);
    return sum + Math.max(0, end - start);
  }, 0);
  return Math.max(0, completedAt - startedAt - pausedMs);
}

export function startSingleDelivery(state, orderId, method, shippingFee) {
  const order = getOrder(state, orderId);
  if (!order || order.deliveryStatus !== "Chưa giao hàng") throw new Error("Đơn hàng không còn trong danh sách chờ giao.");
  if (!DELIVERY_METHODS.includes(method)) throw new Error("Vui lòng chọn hình thức giao hàng.");
  if (!Number.isFinite(shippingFee) || shippingFee < 0) throw new Error("Phí ship phải từ 0đ trở lên.");
  return updateOrder(state, orderId, current => ({
    ...current,
    shippingFee,
    total: current.subtotal + shippingFee,
    deliveryMethod: method,
    deliveryStatus: "Đang giao hàng"
  }));
}

export function markPaid(state, orderId, method, paidAt = Date.now()) {
  if (!PAYMENT_METHODS.includes(method)) throw new Error("Vui lòng chọn phương thức thanh toán.");
  const order = getOrder(state, orderId);
  if (!order || order.paymentStatus === "Đã thanh toán" || (dueAmount(order) === 0 && order.paymentStatus !== "Chưa thanh toán")) throw new Error("Đơn hàng không còn khoản cần thu.");
  let sessionId = null;
  if (order.sessionId) {
    const session = getActiveSession(state);
    if (!session || session.id !== order.sessionId || session.status !== "active" || !session.orderIds.includes(orderId)) throw new Error("Phiên đang tạm dừng hoặc không còn hoạt động.");
    sessionId = session.id;
  }
  const amount = dueAmount(order);
  return updateOrder(state, orderId, current => ({
    ...current,
    paidAmount: current.total,
    remainingDue: 0,
    paymentStatus: "Đã thanh toán",
    paymentMethod: method,
    payments: [...(current.payments || []), { method, amount, paidAt, ...(sessionId ? { sessionId } : {}) }]
  }));
}

export function createSession(state, orderIds, shiftsByOrder = {}, createdAt = Date.now(), notesByOrder = {}, mapsLinksByOrder = {}) {
  if (getActiveSession(state)) throw new Error("Đã có một phiên giao hàng đang hoạt động.");
  const ids = [...new Set(orderIds)];
  if (!ids.length) throw new Error("Chọn ít nhất một đơn hàng.");
  if (ids.some(id => getOrder(state, id)?.deliveryStatus !== "Chưa giao hàng")) throw new Error("Một số đơn đã được giao hoặc đã có người nhận.");
  const shifts = Object.fromEntries(ids.map(id => {
    const shift = typeof shiftsByOrder === "string" ? shiftsByOrder : shiftsByOrder[id] ?? null;
    if (!validShift(shift)) throw new Error("Chọn ca sáng, chiều hoặc tối cho mỗi đơn.");
    return [id, shift];
  }));
  const mapsLinks = Object.fromEntries(ids.filter(id => Object.hasOwn(mapsLinksByOrder, id)).map(id => [id, normalizeGoogleMapsLink(mapsLinksByOrder[id])]));
  const session = {
    id: `PS-${createdAt}-${state.sessions.length + 1}`,
    status: "notStarted",
    orderIds: sortPendingByShift(ids, shifts, {}),
    shifts,
    createdAt,
    startedAt: null,
    legs: {},
    stopStarts: {},
    pauseIntervals: [],
    pausedAt: null,
    completedAt: null
  };
  return {
    ...state,
    activeSessionId: session.id,
    sessions: [...state.sessions, session],
    orders: state.orders.map(order => ids.includes(order.id)
      ? { ...order, ...(Object.hasOwn(notesByOrder, order.id) ? { note: String(notesByOrder[order.id] ?? "").trim() } : {}), ...(Object.hasOwn(mapsLinks, order.id) ? { mapsLink: mapsLinks[order.id] } : {}), deliveryStatus: "Đang giao hàng", deliveryMethod: "Phiên giao hàng", sessionId: session.id }
      : order)
  };
}

export function startSession(state, startedAt = Date.now()) {
  const session = getActiveSession(state);
  if (!session || session.status !== "notStarted") throw new Error("Phiên này đã bắt đầu hoặc không còn hoạt động.");
  if (!session.orderIds.length) throw new Error("Thêm ít nhất một đơn trước khi bắt đầu.");
  if (session.orderIds.some(id => !SHIFT_OPTIONS.includes(session.shifts?.[id]))) throw new Error("Phân ca cho tất cả đơn trước khi bắt đầu.");
  return {
    ...state,
    sessions: state.sessions.map(item => item.id === session.id ? { ...item, status: "active", startedAt } : item)
  };
}

export function pauseSession(state, pausedAt = Date.now()) {
  const session = getActiveSession(state);
  if (!session || session.status !== "active") throw new Error("Chỉ có thể tạm dừng phiên đang giao.");
  return { ...state, sessions: state.sessions.map(item => item.id === session.id ? { ...item, status: "paused", pausedAt } : item) };
}

export function resumeSession(state, resumedAt = Date.now()) {
  const session = getActiveSession(state);
  if (!session || session.status !== "paused") throw new Error("Phiên này không ở trạng thái tạm dừng.");
  return {
    ...state,
    sessions: state.sessions.map(item => item.id === session.id ? {
      ...item,
      status: "active",
      pauseIntervals: appendPause(item, resumedAt),
      pausedAt: null
    } : item)
  };
}

export function cancelSession(state, cancelledAt = Date.now()) {
  const session = getActiveSession(state);
  if (!session) throw new Error("Không có phiên để hủy.");
  const intervals = session.status === "paused"
    ? [...session.pauseIntervals, { startedAt: session.pausedAt, resumedAt: cancelledAt }]
    : session.pauseIntervals;
  return {
    ...state,
    activeSessionId: null,
    sessions: state.sessions.map(item => item.id === session.id ? { ...item, status: "cancelled", pausedAt: null, pauseIntervals: intervals, completedAt: cancelledAt } : item),
    orders: state.orders.map(order => order.sessionId === session.id && order.deliveryStatus !== "Đã giao hàng"
      ? { ...order, deliveryStatus: "Chưa giao hàng", deliveryMethod: null, sessionId: null }
      : order)
  };
}

export function addOrdersToSession(state, orderIds, shift = null, notesByOrder = {}, mapsLinksByOrder = {}) {
  const session = editableSession(state);
  if (!validShift(shift) || !shift) throw new Error("Chọn ca cho các đơn được thêm.");
  const ids = [...new Set(orderIds)].filter(id => !session.orderIds.includes(id));
  if (!ids.length) throw new Error("Chọn đơn chưa có trong phiên.");
  if (ids.some(id => getOrder(state, id)?.deliveryStatus !== "Chưa giao hàng")) throw new Error("Một số đơn không còn ở trạng thái chưa giao.");
  const mapsLinks = Object.fromEntries(ids.filter(id => Object.hasOwn(mapsLinksByOrder, id)).map(id => [id, normalizeGoogleMapsLink(mapsLinksByOrder[id])]));
  const stopStarts = { ...session.stopStarts };
  ids.forEach(id => delete stopStarts[id]);
  return {
    ...state,
    sessions: state.sessions.map(item => item.id === session.id ? {
      ...item,
      orderIds: sortPendingByShift([...item.orderIds, ...ids], { ...item.shifts, ...Object.fromEntries(ids.map(id => [id, shift])) }, item.legs),
      shifts: { ...item.shifts, ...Object.fromEntries(ids.map(id => [id, shift])) },
      stopStarts
    } : item),
    orders: state.orders.map(order => ids.includes(order.id)
      ? { ...order, ...(Object.hasOwn(notesByOrder, order.id) ? { note: String(notesByOrder[order.id] ?? "").trim() } : {}), ...(Object.hasOwn(mapsLinks, order.id) ? { mapsLink: mapsLinks[order.id] } : {}), deliveryStatus: "Đang giao hàng", deliveryMethod: "Phiên giao hàng", sessionId: session.id }
      : order)
  };
}

export function removeOrderFromSession(state, orderId) {
  const session = editableSession(state);
  if (!session.orderIds.includes(orderId)) throw new Error("Đơn hàng không nằm trong phiên đang hoạt động.");
  if (session.legs[orderId]?.completedAt) throw new Error("Không thể bỏ điểm đã giao khỏi lịch sử phiên.");
  const orderIds = session.orderIds.filter(id => id !== orderId);
  const shifts = { ...session.shifts };
  const stopStarts = { ...session.stopStarts };
  delete shifts[orderId];
  delete stopStarts[orderId];
  return {
    ...state,
    sessions: state.sessions.map(item => item.id === session.id ? { ...item, orderIds, shifts, stopStarts } : item),
    orders: state.orders.map(order => order.id === orderId
      ? { ...order, deliveryStatus: "Chưa giao hàng", deliveryMethod: null, sessionId: null }
      : order)
  };
}

export function setSessionOrderShift(state, orderId, shift) {
  const session = editableSession(state);
  if (!session.orderIds.includes(orderId) || !validShift(shift) || !shift) throw new Error("Chọn một ca hợp lệ cho đơn hàng.");
  if (session.legs[orderId]?.completedAt) throw new Error("Không thể đổi ca của điểm đã giao.");
  const shifts = { ...session.shifts, [orderId]: shift };
  const orderIds = sortPendingByShift([...session.orderIds.filter(id => id !== orderId), orderId], shifts, session.legs);
  return {
    ...state,
    sessions: state.sessions.map(item => item.id === session.id ? { ...item, shifts, orderIds } : item)
  };
}

export function reorderOrderInSession(state, orderId, targetIndex) {
  const session = editableSession(state);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= session.orderIds.length) throw new Error("Không thể đổi thứ tự điểm giao.");
  const completedCount = session.orderIds.filter(id => session.legs[id]?.completedAt).length;
  const index = session.orderIds.indexOf(orderId);
  if (index < 0) throw new Error("Đơn hàng không có trong phiên giao hàng.");
  if (index < completedCount) throw new Error("Không thể di chuyển điểm đã giao.");
  if (targetIndex < completedCount) return state;
  if (index === targetIndex) return state;
  if (session.shifts?.[session.orderIds[targetIndex]] !== session.shifts?.[orderId]) throw new Error("Chỉ có thể sắp xếp đơn trong cùng một ca.");
  const orderIds = [...session.orderIds];
  orderIds.splice(index, 1);
  orderIds.splice(targetIndex, 0, orderId);
  return { ...state, sessions: state.sessions.map(item => item.id === session.id ? { ...item, orderIds } : item) };
}

export function moveOrderInSession(state, orderId, offset) {
  const session = editableSession(state);
  if (![-1, 1].includes(offset)) throw new Error("Không thể đổi thứ tự điểm giao.");
  const index = session.orderIds.indexOf(orderId);
  const targetIndex = index + offset;
  const completedCount = session.orderIds.filter(id => session.legs[id]?.completedAt).length;
  if (index < completedCount || targetIndex < completedCount || targetIndex < 0 || targetIndex >= session.orderIds.length) return state;
  if (session.shifts?.[session.orderIds[targetIndex]] !== session.shifts?.[orderId]) return state;
  return reorderOrderInSession(state, orderId, targetIndex);
}

export function markDelivered(state, orderId, deliveredAt = Date.now()) {
  const order = getOrder(state, orderId);
  if (!order || order.deliveryStatus !== "Đang giao hàng") throw new Error("Đơn hàng không ở trạng thái đang giao.");
  const session = getActiveSession(state);
  if (order.sessionId && (!session || session.id !== order.sessionId || session.status !== "active")) throw new Error("Tiếp tục phiên giao hàng trước khi xác nhận.");
  if (order.sessionId && !session.orderIds.includes(orderId)) throw new Error("Đơn hàng không còn trong phiên giao hàng này.");
  let next = updateOrder(state, orderId, current => ({ ...current, deliveryStatus: "Đã giao hàng", deliveredAt }));
  if (!session || !order.sessionId) return next;
  const previousCompletedAt = Math.max(0, ...Object.values(session.legs).map(leg => leg.completedAt || 0));
  const startedAt = session.stopStarts[orderId] ?? (previousCompletedAt || session.startedAt);
  if (!startedAt) throw new Error("Bắt đầu phiên trước khi xác nhận điểm giao.");
  const legs = {
    ...session.legs,
    [orderId]: { startedAt, completedAt: deliveredAt, durationMs: activeDuration(startedAt, deliveredAt, session.pauseIntervals) }
  };
  const stopStarts = { ...session.stopStarts };
  delete stopStarts[orderId];
  const done = session.orderIds.every(id => legs[id]?.completedAt);
  next = {
    ...next,
    activeSessionId: done ? null : next.activeSessionId,
    sessions: next.sessions.map(item => item.id === session.id
      ? { ...item, legs, stopStarts, status: done ? "completed" : item.status, completedAt: done ? deliveredAt : item.completedAt }
      : item)
  };
  return next;
}

export function reopenDeliveredOrder(state, orderId, deliveryStatus, shift, reopenedAt = Date.now()) {
  const order = getOrder(state, orderId);
  if (!order || order.deliveryStatus !== "Đã giao hàng") throw new Error("Chỉ có thể sửa đơn đã giao.");
  if (!["Đang giao hàng", "Chưa giao hàng"].includes(deliveryStatus)) throw new Error("Chọn trạng thái giao hàng hợp lệ.");
  const oldSession = state.sessions.find(session => session.id === order.sessionId);
  const current = getActiveSession(state);
  if (current?.status === "paused") throw new Error("Tiếp tục phiên đang chạy trước khi sửa trạng thái đơn.");

  if (current) {
    if (!validShift(shift) || !shift) throw new Error("Chọn ca cho đơn cần giao lại.");
    const orderIds = current.orderIds.filter(id => id !== orderId);
    const legs = { ...current.legs };
    delete legs[orderId];
    const stopStarts = { ...current.stopStarts, [orderId]: current.status === "notStarted" ? null : reopenedAt };
    const shifts = { ...current.shifts, [orderId]: shift };
    return {
      ...state,
      sessions: state.sessions.map(item => item.id === current.id ? {
        ...item,
        orderIds: sortPendingByShift([...orderIds, orderId], shifts, legs),
        legs,
        stopStarts,
        shifts,
        completedAt: null
      } : item),
      orders: state.orders.map(item => item.id === orderId ? { ...item, deliveryStatus: "Đang giao hàng", deliveryMethod: "Phiên giao hàng", sessionId: current.id, deliveredAt: null } : item)
    };
  }

  if (deliveryStatus === "Chưa giao hàng" && oldSession?.status !== "completed") {
    let next = updateOrder(state, orderId, item => ({ ...item, deliveryStatus, deliveryMethod: null, sessionId: null, deliveredAt: null }));
    if (oldSession) {
      next = {
        ...next,
        sessions: next.sessions.map(item => item.id === oldSession.id ? {
          ...item,
          orderIds: item.orderIds.filter(id => id !== orderId),
          shifts: Object.fromEntries(Object.entries(item.shifts).filter(([id]) => id !== orderId)),
          legs: Object.fromEntries(Object.entries(item.legs).filter(([id]) => id !== orderId))
        } : item)
      };
    }
    return next;
  }

  if (oldSession && oldSession.status === "completed") {
    const orderIds = [...oldSession.orderIds.filter(id => id !== orderId), orderId];
    const legs = { ...oldSession.legs };
    delete legs[orderId];
    if (!validShift(shift) || !shift) throw new Error("Chọn ca cho đơn cần giao lại.");
    return {
      ...state,
      activeSessionId: oldSession.id,
      sessions: state.sessions.map(item => item.id === oldSession.id ? {
        ...item,
        status: "active",
        orderIds: sortPendingByShift(orderIds, { ...oldSession.shifts, [orderId]: shift }, legs),
        legs,
        shifts: { ...item.shifts, [orderId]: shift },
        stopStarts: { ...item.stopStarts, [orderId]: reopenedAt },
        completedAt: null
      } : item),
      orders: state.orders.map(item => item.id === orderId ? { ...item, deliveryStatus: "Đang giao hàng", deliveryMethod: "Phiên giao hàng", sessionId: oldSession.id, deliveredAt: null } : item)
    };
  }

  if (!oldSession || oldSession.status === "cancelled") {
    if (!validShift(shift) || !shift) throw new Error("Chọn ca cho đơn cần giao lại.");
    const pending = updateOrder(state, orderId, item => ({ ...item, deliveryStatus: "Chưa giao hàng", deliveryMethod: null, sessionId: null, deliveredAt: null }));
    return createSession(pending, [orderId], { [orderId]: shift }, reopenedAt);
  }

  return updateOrder(state, orderId, item => ({ ...item, deliveryStatus, deliveredAt: null }));
}

export function getSessionStats(state, sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return { cashCollected: 0, transferCollected: 0, remainingCount: 0, totalValue: 0, amountToCollect: 0, shifts: [] };
  const orders = session.orderIds.map(id => getOrder(state, id)).filter(Boolean);
  const payments = orders.flatMap(order => (order.payments || []).filter(payment => payment.sessionId === session.id));
  const stopIsDone = id => Boolean(session.legs[id]?.completedAt);
  const shiftStats = SHIFT_OPTIONS.map(shift => {
    const orderIds = session.orderIds.filter(id => session.shifts?.[id] === shift);
    return {
      shift,
      total: orderIds.length,
      completed: orderIds.filter(stopIsDone).length,
      done: orderIds.length > 0 && orderIds.every(stopIsDone)
    };
  }).filter(item => item.total);
  return {
    cashCollected: payments.filter(payment => payment.method === "Tiền mặt").reduce((sum, payment) => sum + payment.amount, 0),
    transferCollected: payments.filter(payment => payment.method === "Chuyển khoản").reduce((sum, payment) => sum + payment.amount, 0),
    remainingCount: session.status === "cancelled" ? 0 : orders.filter(order => !stopIsDone(order.id)).length,
    totalValue: orders.reduce((sum, order) => sum + order.total, 0),
    amountToCollect: orders.reduce((sum, order) => sum + dueAmount(order), 0),
    shifts: shiftStats
  };
}
