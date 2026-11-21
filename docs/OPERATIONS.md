# Vận hành Mealfit Shipping

Local: `npm run dev` chạy Vite; để chạy Vercel Functions bằng `npm run dev:vercel`, cài CLI toàn cục bằng `npm i -g vercel`.

## Database và môi trường

Tạo database Postgres riêng cho app rồi chạy lần lượt `db/migrations/001_initial.sql`, `002_account_directory.sql` và `003_server_authoritative.sql` (cộng thêm cột `delivered_at`, `delivery_method` và cho phép lệnh trong sổ idempotency). Migration `004_one_open_session.sql` (mỗi shipper tối đa 1 phiên mở) chỉ chạy **sau** `scripts/repair-owner.mjs --apply`; nó tự dừng nếu còn shipper có nhiều phiên mở. Chạy migration trước khi deploy code mới. Đặt các biến sau ở Vercel và local:

| Biến | Giá trị / mục đích |
| --- | --- |
| `DATABASE_URL` | Pooled connection cho local/Production; Production dự phòng sang `POSTGRES_URL` do Neon integration cấp. |
| `MEALFIT_PREVIEW_DATABASE_URL` | Pooled connection riêng cho Preview; nếu thiếu, API Preview từ chối truy cập database thay vì dùng chung URL của Production. |
| `SESSION_SECRET` | Secret ngẫu nhiên tối thiểu 32 byte; dùng ký cookie và băm PIN. |
| `MEALFIT_PIN` | Local demo PIN: `1234`; Production: set one six digit PIN. The server derives and compares its scrypt hash using `SESSION_SECRET`. |
| `MEALFIT_PIN_HASH` | Optional legacy Production scrypt hash. Leave unset when using `MEALFIT_PIN`. |
| `N8N_BASE_URL` | Local test: `https://n8n.delfi.vn/webhook-test`; production: `https://n8n.delfi.vn/webhook`. |
| `N8N_API_KEY` | Bearer key cho các webhook n8n. |
| `N8N_SHEET_ID` | Local/Preview: `1kReBUO9v68J7rw3lrMQD3otsdTPrFvn2qof0F7VuIvo`; Production: `1kReBUO9v68J7rw3lrMQD3otsdTPrFvn2qof0F7Vu123`. |
| `N8N_FOLDER_ID` | Thư mục Google Drive đích. ID production chưa được cấp; không bật upload production khi thiếu biến này. |
| `BLOB_READ_WRITE_TOKEN` | Private Vercel Blob để giữ ảnh trước khi n8n nhận và lưu backup database. |
| `CRON_SECRET` | Secret Bearer bảo vệ cron tại `/api/refresh`; đường dẫn cũ `/api/cron/maintenance` vẫn được rewrite tương thích. |

Vercel app chỉ gọi API webhook n8n; không cần Apps Script URL/secret trong biến môi trường Vercel.
Không dùng chung database, Blob token, PIN hay webhook secret giữa Preview và Production. Tạo Vercel project riêng `mealfit-shipping`; không liên kết vào các project Mealfit hiện có. Production cần Vercel Pro vì đây là ứng dụng vận hành thương mại. Hobby chỉ dùng cho thử nghiệm cá nhân.

## Hợp đồng n8n

Vercel là nơi duy nhất gọi n8n. Workflow cần cung cấp:

- `GET /shipping-orders?sheet_id=…&shipper=…&limit=…&cursor=…&since=…` trả `{ data: [], nextCursor: null }`; phân trang theo mã đơn, `since` lọc theo `updated_at`. Khi có `shipper`, trả tất cả hàng có mã đơn được gán tên đó, kể cả thiếu tên khách và mọi trạng thái giao hàng. Không truyền `shipper` thì trả tất cả shipper.
- `GET /shipping-order?sheet_id=…&code=…` trả một dòng theo đúng các cột trong Sheet.
- `POST /shipping-order` nhận đủ `sheet_id`, `code`, `shipper`, `total`, `payment_staus`, `shipping_status`, `note`, `expected_revision`, và `operation_id`. Khi chuyển trạng thái thanh toán sang `Đã thanh toán`, gửi thêm `method` với một trong `Chuyển khoản`, `Tiền mặt`, `Khác`. `total` là số đã thanh toán lũy kế. Workflow cập nhật dòng có `Mã đơn` khớp và trả `{ status: "ok", revision, row }`; revision tiếp tục trong outbox/API, không thêm cột vào Sheet.
- `POST /shipping-orders/batch` nhận `{ "orders": [<payload của POST /shipping-order>] }` với 1–20 mã đơn khác nhau; mỗi payload phải có thêm `remaining_due` không âm và `operation_id` riêng. Chỉ cập nhật các cột Shipper, Đã thanh toán, Trạng thái đơn, Trạng thái giao hàng, Ghi chú bởi shipper và Phương thức thanh toán nếu có `method`. Dòng không tìm thấy không được tạo mới; mã trùng trong Sheet trả `conflict`, mã không có trả `not-found`, còn mã hợp lệ được cập nhật và trả `{ "status": "ok", "results": [{ "code": "…", "status": "ok|conflict|not-found", "revision": 1, "row": {…} }] }`. Payload sai bị từ chối toàn bộ trước khi ghi. App chỉ đánh dấu đã gửi sau khi đối chiếu từng `row`; thao tác chưa xác nhận vẫn ở outbox.
- Import export n8n ở trạng thái chưa bật, gắn cùng Header Auth credential như webhook đơn, rồi thử `/webhook-test/shipping-orders/batch` trên Sheet test. Workflow dùng Google Sheets OAuth credential có sẵn và không cần Apps Script hoặc thêm cột metadata. Chỉ publish production sau khi kiểm tra kết quả đọc lại và thử gửi lại cùng `operation_id`.
- `POST /upload-medias` nhận multipart `sheet_id`, `folder_id`, `code`, `name`, `message`, `media_id`, `files`; chỉ trả thành công sau khi file đã được lưu. `media_id` là khóa idempotency.
- Mọi webhook của app yêu cầu n8n Header Auth credential có header name `Authorization` và giá trị `Bearer <N8N_API_KEY>`; gắn credential này vào các Webhook node của app, gồm webhook batch. Export không chứa giá trị bí mật. `N8N_BASE_URL` test chỉ hoạt động khi workflow đang nghe test event; production URL chỉ hoạt động sau khi publish workflow.

Vercel app không kết nối trực tiếp Google Sheets: mọi đọc/ghi đều đi qua webhook n8n. Kiểm tra workflow n8n đang triển khai có hỗ trợ idempotency khi cập nhật cùng một mã đơn; workflow export trong `docs/api/n8n.json` có thể khác workflow đang chạy. Khi publish workflow, kiểm tra GET, POST, phân trang và upload nhiều file trên Sheet test trước.

Giá trị hợp lệ: giao hàng `Chưa giao hàng`, `Đang giao hàng`, `Đã giao hàng`, `Đã huỷ đơn`; thanh toán `Chưa thanh toán`, `Đã thanh toán`; số đã thanh toán không âm; `note` có thể rỗng. Sheet status quyết định nút thanh toán. Số còn thu lệch với status cần được rà soát.

## Đồng bộ và khôi phục

Máy chủ là nguồn dữ liệu chung: mọi thiết bị dùng cùng tài khoản đọc cùng một trạng thái từ Postgres.

- **Ghi (`POST /api/commands`)**: mỗi thao tác (giao, thu tiền, tạo/bắt đầu/tạm dừng/hủy/xóa/hoàn tất phiên, thêm/bỏ/sắp xếp đơn, ghi chú...) là một lệnh idempotent (`commandId` do máy sinh, giữ nguyên khi thử lại). Máy chủ khóa theo tài khoản (10 máy cùng tài khoản xếp hàng tuần tự), chạy cùng hàm `domain.mjs` với giờ máy chủ, sửa các bất biến (`server-lib/invariants.mjs`) rồi commit Postgres. Giao diện chỉ báo "đã lưu" khi máy chủ xác nhận; mất mạng thì báo lỗi, không có hàng đợi trên máy. Lệnh từ màn hình cũ lặp lại thao tác đã xảy ra sẽ thành công (no-op) và trả trạng thái mới nhất.
- **Bất biến máy chủ**: mỗi shipper tối đa 1 phiên mở; phiên mở mà mọi đơn đã giao/hủy tự chuyển `Hoàn tất`; phiên mở rỗng tự hủy; hủy/xóa/gỡ chỉ giải phóng đơn chưa kết thúc (không đụng đơn đã giao/đã huỷ); đơn "Đang giao hàng" ngoài phiên mở được sửa theo bằng chứng của phiên (phiên hoàn tất có điểm giao → `Đã giao hàng`; phiên đã hủy/không còn → `Chưa giao hàng`); đơn không có `session_id` được giữ nguyên để người dùng chọn tay.
- **Đọc**: mở app chỉ đọc Postgres (`GET /api/orders`, `GET /api/sessions`), không gọi n8n. Dữ liệu do máy khác thay đổi chỉ về khi bấm Đồng bộ; không có polling, không tự làm mới.
- **Nút Đồng bộ (`POST /api/refresh`)**: đọc Google Sheet qua n8n, nhập vào Postgres (Sheet là chuẩn cho dữ liệu đơn), sửa các bất biến cho các shipper bị ảnh hưởng, rồi máy tải lại. Đơn có dòng outbox chưa gửi hoặc vừa gửi trong lúc đang đọc Sheet **không bị ghi đè** (giá trị app thắng cho tới khi Sheet xác nhận). Lệnh gọi lại trong 20 giây sau lần trước được trả thành công mà không gọi n8n.
- **Đẩy Sheet (outbox bền)**: sau mỗi lệnh, server đẩy nền (`waitUntil`) trạng thái tuyệt đối mới nhất của từng đơn lên n8n (batch ≤20, idempotency key, `expected_revision` đọc lúc gửi, backoff tối đa 5 phút). Không còn trạng thái `conflict` treo: n8n/Sheet từ chối phiên bản thì server lấy phiên bản Sheet hiện tại và gửi lại, giá trị app thắng. n8n lỗi thì dữ liệu vẫn ở Postgres, Sheet cập nhật ở lần thử lại (sau lệnh kế tiếp, khi bấm Đồng bộ, hoặc cron). Cron Hobby chạy 1 lần/ngày; nâng Pro nếu cần flush dày hơn.
- Vercel Blob lưu ảnh riêng tư trước khi upload n8n. Ảnh chưa gửi vẫn giữ trên máy khi mất mạng và được gửi lại sau lệnh giao hoặc khi bấm Đồng bộ.
- Cron mỗi ngày nhập thay đổi từ Sheet, chạy hàng đợi, sửa bất biến cho mọi shipper và lưu snapshot JSON riêng tư. Sao chép backup sang vị trí độc lập, giới hạn quyền đọc, và thử khôi phục định kỳ.
- Khôi phục database từ snapshot cần tạo database/branch mới, kiểm tra JSON và nạp lại theo dependency: orders, sessions, operations, payments, outbox, media, conflicts, audit, auth attempts, sync metadata. Không ghi đè production khi chưa kiểm tra backup.

### Chuyển từ phiên bản cũ (offline-first)

1. Backup database. Cho các thiết bị còn bản cũ bấm Đồng bộ đến khi hết thay đổi chờ.
2. Chạy migration 003 trên DB đích, deploy server + client mới cùng lúc. Bản mới tự gửi một lần các thao tác còn trong outbox cũ trên máy (qua `/api/operations`, giữ lại một phiên bản) rồi không dùng IndexedDB cũ nữa (không bị xóa).
3. `DATABASE_URL=... node scripts/repair-owner.mjs` (dry-run, đọc báo cáo) → khi được duyệt: `--apply` → chạy `004_one_open_session.sql`. **Không chạy trên Production khi chưa được cho phép rõ ràng.**
4. Phiên bản sau: xóa `api/operations.js`, `claim.js`, `changes.js` (kiểm `mealfit_audit_log` có `operation='claim'` trước) và UI xung đột admin.

## Trước khi bật production

1. Cấp `N8N_FOLDER_ID` production, API key và webhook secret; bật workflow production đã publish.
2. Chọn PIN sáu chữ số và cấu hình secrets ở Production, không để ở Git.
3. Nâng Vercel lên Pro, thêm domain HTTPS, cấu hình Neon và Vercel Blob, chạy migration.
4. Kiểm tra tài khoản, phân quyền, nhận đơn nguyên tử, đồng bộ lặp lại, xung đột, camera/upload, tải lại offline, backup và khôi phục.
5. Xoay token Zalo cũ nếu còn dùng bot Zalo; token đã có trong export cũ cần thay ở hệ thống Zalo trước khi bật lại integration.

PIN được dùng chung giữa các tài khoản nên audit xác định user đăng nhập, không chứng minh người đang cầm thiết bị. Ứng dụng cần mạng để ghi; thay đổi từ máy khác chỉ hiện sau khi bấm Đồng bộ, không có đồng bộ thiết bị chéo tức thời.
