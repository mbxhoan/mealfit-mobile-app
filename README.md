# Mealfit Shipping

Ứng dụng web mobile ưu tiên xem đơn và giao hàng theo phiên. Dữ liệu thao tác được ghi vào IndexedDB trước, sau đó đồng bộ qua Vercel Functions, Postgres và n8n. Bản phát hành không có dữ liệu đơn mẫu.

## Chạy local

1. Cài dependencies: `npm install`.
2. Tạo `.env.local` từ `.env.example`; đặt `DATABASE_URL`, `SESSION_SECRET`, `N8N_API_KEY` và cấu hình Blob.
3. Áp dụng lần lượt `db/migrations/001_initial.sql` và `db/migrations/002_account_directory.sql` vào database test.
4. Chạy `npm run dev:vercel` để mở app đầy đủ cùng Vercel Functions và API đăng nhập. `npm run dev` hoặc `npm run dev:vite` chỉ mở giao diện Vite, không có API đăng nhập. PIN local mặc định là `1234`.

`N8N_BASE_URL` local dùng `/webhook-test` và Sheet test. Production phải dùng `/webhook` và Sheet production. Không đưa `.env.local` hoặc dữ liệu Sheet vào Git.

## Kiểm tra

```sh
npm test
npm run build
```

## Triển khai và vận hành

Xem [docs/OPERATIONS.md](docs/OPERATIONS.md) để tạo project Vercel riêng, cấu hình Neon và Blob, chuẩn bị workflow n8n, backup, khôi phục và các điều kiện trước khi dùng dữ liệu đơn thật. Project dùng một cron bảo trì mỗi ngày; thao tác đồng bộ thông thường chạy ngay sau khi ghi Postgres và trên client khi có mạng.
