# Mealfit Shipping

Ứng dụng web mobile ưu tiên xem đơn và giao hàng theo phiên. Máy chủ là nguồn dữ liệu chung: mỗi thao tác là một lệnh gửi tới Vercel Functions và được lưu vào Postgres ngay, rồi server tự đẩy Sheet qua n8n ở nền. Mọi thiết bị dùng cùng tài khoản thấy cùng dữ liệu; dữ liệu từ máy khác chỉ về khi bấm Đồng bộ. Ứng dụng cần mạng để ghi. Bản phát hành không có dữ liệu đơn mẫu.

## Chạy local

1. Cài dependencies: `npm install`.
2. Tạo `.env.local` từ `.env.example`; đặt `DATABASE_URL`, `SESSION_SECRET`, `N8N_API_KEY` và cấu hình Blob.
3. Áp dụng lần lượt `db/migrations/001_initial.sql`, `002_account_directory.sql` và `003_server_authoritative.sql` vào database test (`004_one_open_session.sql` chỉ sau khi chạy `scripts/repair-owner.mjs`).
4. Chạy `npm run dev:vercel` để mở app đầy đủ cùng Vercel Functions và API đăng nhập. `npm run dev` hoặc `npm run dev:vite` chỉ mở giao diện Vite, không có API đăng nhập. PIN local mặc định là `1234`.

`N8N_BASE_URL` local dùng `/webhook-test` và Sheet test. Production phải dùng `/webhook` và Sheet production. Không đưa `.env.local` hoặc dữ liệu Sheet vào Git.

## Kiểm tra

```sh
npm test
npm run build
```

## Triển khai và vận hành

Xem [docs/OPERATIONS.md](docs/OPERATIONS.md) để tạo project Vercel riêng, cấu hình Neon và Blob, chuẩn bị workflow n8n, backup, khôi phục và các điều kiện trước khi dùng dữ liệu đơn thật. Sheet là nguồn chuẩn của dữ liệu đơn khi bấm Đồng bộ; Postgres lưu trạng thái giao hàng/phiên mà mọi thiết bị đọc chung. Thay đổi chưa đẩy được lên Sheet vẫn nằm trong Postgres và được thử lại, không chặn thao tác của shipper.
