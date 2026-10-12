# Mealfit mobile prototype

Giao diện web dành cho màn hình điện thoại. Tài khoản demo: `admin`, `nhanvien`, `shipper`; PIN `1234`.

Chạy từ thư mục gốc của dự án:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Mở `http://127.0.0.1:8000/mobile-app/`. Trạng thái đơn và phiên được lưu trong `localStorage`; ảnh bằng chứng lưu trong `IndexedDB` của trình duyệt.

Kiểm tra luồng trạng thái:

```sh
node --test mobile-app/domain.test.mjs
```

Đây là bản trình diễn cục bộ, chưa kết nối API, bản đồ hoặc xác thực thật. Dữ liệu khách là giả; xóa dữ liệu trang web sẽ xóa trạng thái và ảnh đã lưu.
