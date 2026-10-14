# Vận hành Mealfit Shipping

Local: `npm run dev` chạy Vite; để chạy Vercel Functions bằng `npm run dev:vercel`, cài CLI toàn cục bằng `npm i -g vercel`.

## Database và môi trường

Tạo database Postgres riêng cho app rồi chạy `db/migrations/001_initial.sql`. Đặt các biến sau ở Vercel và local:

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

- `GET /shipping-orders?sheet_id=…&limit=…&cursor=…&since=…` trả `{ data: [], nextCursor: null }`; phân trang bằng mã đơn ổn định, `since` lọc theo `updated_at`, và gồm cả `Đã huỷ đơn`.
- `GET /shipping-order?sheet_id=…&code=…` trả một dòng theo đúng các cột trong Sheet.
- `POST /shipping-order` nhận đủ `sheet_id`, `code`, `shipper`, `total`, `payment_staus`, `shipping_status`, `note`, và `expected_revision`. `total` là số đã thanh toán lũy kế. Phản hồi phải có `revision` mới; trả HTTP 409 nếu `expected_revision` đã cũ.
- `POST /upload-medias` nhận multipart `sheet_id`, `folder_id`, `code`, `name`, `message`, `media_id`, `files`; chỉ trả thành công sau khi file đã được lưu. `media_id` là khóa idempotency.
- Mọi webhook yêu cầu n8n Header Auth credential có header name `Authorization` và giá trị `Bearer <N8N_API_KEY>`; gắn credential này vào cả bốn Webhook node. Export không chứa credential. `N8N_BASE_URL` test chỉ hoạt động khi workflow đang nghe test event; production URL chỉ hoạt động sau khi publish workflow.

Vercel app không kết nối trực tiếp Google Sheets: mọi đọc/ghi đều đi qua webhook n8n. Kiểm tra workflow n8n đang triển khai có hỗ trợ idempotency khi cập nhật cùng một mã đơn; workflow export trong `docs/api/n8n.json` có thể khác workflow đang chạy. Khi publish workflow, kiểm tra GET, POST, phân trang và upload nhiều file trên Sheet test trước.

Giá trị hợp lệ: giao hàng `Chưa giao hàng`, `Đang giao hàng`, `Đã giao hàng`, `Đã huỷ đơn`; thanh toán `Chưa thanh toán`, `Đã thanh toán`; số đã thanh toán không âm; `note` có thể rỗng. Sheet status quyết định nút thanh toán. Số còn thu lệch với status cần được rà soát.

## Đồng bộ và khôi phục

- UI xác nhận thay đổi sau khi IndexedDB ghi xong; bản ghi đồng bộ cục bộ giữ cùng operation ID và body trong mỗi lần retry. App kiểm tra thay đổi từ Sheet mỗi phút; endpoint server dùng cửa sổ sửa đổi có overlap để không bỏ lỡ cập nhật gần thời điểm đồng bộ.
- API dùng revision ở Postgres, hàng đợi theo thứ tự phiên bản và idempotency key khi đẩy n8n. Worker giữ khóa advisory Postgres trong lúc gửi, giãn các lần gọi tối thiểu 1,1 giây, nên các cập nhật `shipping-order` từ nhiều instance Vercel được xử lý lần lượt; bản ghi worker bị ngắt được thử lại sau 2 phút. Admin xử lý xung đột ở mục **Xung đột**.
- Vercel Blob lưu ảnh riêng tư trước khi upload n8n. Ảnh và hàng đợi trên thiết bị được giữ khi mất mạng; cần mở lại app có mạng để thử đồng bộ.
- Cron mỗi ngày nhập thay đổi từ Sheet, chạy hàng đợi và lưu snapshot JSON riêng tư. Cron Hobby chỉ chạy tối đa một lần/ngày và trễ theo giờ; nâng Pro để có lịch nền dày hơn. Sao chép backup sang vị trí độc lập, giới hạn quyền đọc, và thử khôi phục định kỳ.
- Khôi phục database từ snapshot cần tạo database/branch mới, kiểm tra JSON và nạp lại theo dependency: orders, sessions, operations, payments, outbox, media, conflicts, audit, auth attempts, sync metadata. Không ghi đè production khi chưa kiểm tra backup.

## Trước khi bật production

1. Cấp `N8N_FOLDER_ID` production, API key và webhook secret; bật workflow production đã publish.
2. Chọn PIN sáu chữ số và cấu hình secrets ở Production, không để ở Git.
3. Nâng Vercel lên Pro, thêm domain HTTPS, cấu hình Neon và Vercel Blob, chạy migration.
4. Kiểm tra tài khoản, phân quyền, nhận đơn nguyên tử, đồng bộ lặp lại, xung đột, camera/upload, tải lại offline, backup và khôi phục.
5. Xoay token Zalo cũ nếu còn dùng bot Zalo; token đã có trong export cũ cần thay ở hệ thống Zalo trước khi bật lại integration.

PIN được dùng chung giữa các tài khoản nên audit xác định user đăng nhập, không chứng minh người đang cầm thiết bị. Khi offline, thay đổi trên thiết bị chỉ đồng bộ sau khi có mạng; không hứa đồng bộ thiết bị chéo tức thời.
