export class ApiError extends Error {
  constructor(message, status = 0, code = "API_ERROR", details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 12_000);
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof ArrayBuffer)) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(body);
  }
  try {
    const response = await fetch(path, { ...options, body, headers, credentials: "same-origin", cache: "no-store", signal: controller.signal });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const problem = payload.error || {};
      const error = new ApiError(problem.message || "Không thể hoàn tất thao tác. Dữ liệu trên thiết bị vẫn được giữ.", response.status, problem.code || "API_ERROR", payload);
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.name === "AbortError" ? "Máy chủ phản hồi chậm. Thao tác đã giữ trên thiết bị và sẽ thử lại." : "Mất kết nối máy chủ. Thao tác đã giữ trên thiết bị và sẽ thử lại.", 0, error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}
