# Phân tích ảnh vệ tinh TpHCM bằng Google Earth Engine

Dự án này đã được refactor từ mã nguồn Script GEE truyền thống thành một cấu trúc dự án Web (Node.js/Vite) hiện đại, chuẩn Clean Code, để sẵn sàng đẩy lên GitHub và triển khai trên Vercel.

## Cấu trúc thư mục

- `src/config.js`: Lưu trữ các hằng số cấu hình như tọa độ, thời gian, và thông số hiển thị.
- `src/geeService.js`: Chứa các hàm xử lý logic tách biệt (lấy dữ liệu, tính NDVI, tính LST). Đảm bảo tính tái sử dụng và dễ test.
- `src/main.js`: File entry point kết nối các hàm lại với nhau, giả lập quá trình phân tích dữ liệu trên nền Web.
- `index.html`: Giao diện Web hiển thị kết quả cơ bản.
- `package.json`: Chứa các scripts quản lý dự án (Vite) và các thư viện cần thiết (`@google/earthengine`).

## Hướng dẫn chạy nội bộ (Local Development)

1. Cài đặt các thư viện (Yêu cầu Node.js cài sẵn trong máy):
   ```bash
   npm install
   ```

2. Chạy server phát triển (Vite):
   ```bash
   npm run start
   ```

## Hướng dẫn triển khai lên GitHub & Vercel

1. **Đẩy lên GitHub:**
   - Mở terminal trong thư mục này.
   - Chạy các lệnh sau:
     ```bash
     git init
     git add .
     git commit -m "Initial commit - Refactored GEE script"
     git branch -M main
     git remote add origin <URL_GITHUB_REPO_CUA_BAN>
     git push -u origin main
     ```

2. **Triển khai lên Vercel:**
   - Đăng nhập vào [Vercel](https://vercel.com/).
   - Thêm dự án mới (Add New Project) và kết nối với repository GitHub của bạn.
   - Vercel sẽ tự động nhận diện dự án sử dụng Vite.
   - Nhấn **Deploy**!

## Ghi chú quan trọng về Google Earth Engine API
Để bản đồ và số liệu thực sự tải được trên môi trường Web, bạn cần thiết lập cơ chế **Authentication** cho GEE (thường là Service Account để backend tự xác thực, hoặc hiển thị popup OAuth cho người dùng). Tham khảo [Google Earth Engine REST API](https://developers.google.com/earth-engine/apidocs).
