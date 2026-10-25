# HƯỚNG DẪN KHỞI ĐỘNG VÀ KIỂM TRA DỰ ÁN (BACKEND & FRONTEND)

Tài liệu này cung cấp các câu lệnh đơn giản, nhanh gọn nhất để khởi động và kiểm tra **Backend (BE)** cùng **Frontend (FE)** trên Windows.

---

## ⚡ Cách 1: Nhanh nhất (Click đúp chuột - 1 Click)

Dự án đã tạo sẵn các file chạy tự động, bạn chỉ cần click đúp chuột:

1. **Chạy Backend**: Click đúp vào file `run_backend.bat` ở thư mục gốc.
2. **Chạy Frontend**: Click đúp vào file `run_frontend.bat` ở thư mục gốc.

---

## 🐚 Cách 2: Chạy trong Git Bash

Nếu bạn đang dùng **Git Bash**, có 2 cách rất đơn giản:

### Cách 2.1: Gọi trực tiếp file `.bat` trong Git Bash
- **Chạy Backend**:
  ```bash
  ./run_backend.bat
  # hoặc: cmd //c run_backend.bat
  ```
- **Chạy Frontend**:
  ```bash
  ./run_frontend.bat
  # hoặc: cmd //c run_frontend.bat
  ```
*(Mẹo: Nếu muốn mở ra một cửa sổ đen CMD riêng biệt để không chiếm cửa sổ Git Bash hiện tại, bạn gõ: `cmd //c start run_backend.bat` và `cmd //c start run_frontend.bat`)*.

### Cách 2.2: Dùng file script chuẩn Git Bash (`.sh`)
Dự án đã tạo sẵn 2 file shell script:
- **Chạy Backend**:
  ```bash
  ./run_backend.sh
  ```
- **Chạy Frontend**:
  ```bash
  ./run_frontend.sh
  ```

---

## 💻 Cách 3: Chạy bằng Terminal (PowerShell hoặc CMD)

Nếu bạn muốn mở qua cửa sổ dòng lệnh (Terminal / VS Code / Command Prompt):

### 1. Khởi động Backend (BE)
Mở **Terminal thứ 1** (tại thư mục gốc `frameweaver`):

```powershell
.venv\Scripts\python.exe -m agent.main
```

> **Ghi chú:** Gọi trực tiếp `.venv\Scripts\python.exe` giúp chạy ngay trên PowerShell mà không bao giờ bị lỗi chính sách bảo mật (*ExecutionPolicy*).

---

### 2. Khởi động Frontend (FE)
Mở **Terminal thứ 2**:

```powershell
cd dashboard
npm run dev
```

---

## 🔍 Cách kiểm tra BE và FE đã chạy thành công chưa?

### 1. Kiểm tra Backend (Cổng 8100 & 9222)
Mở thêm một cửa sổ dòng lệnh hoặc tab trình duyệt:

- **Kiểm tra bằng lệnh (Health Check):**
  ```powershell
  curl http://127.0.0.1:8100/health
  ```
  **Kết quả thành công sẽ trả về JSON:**
  ```json
  {"status":"ok","extension_connected":true}
  ```
  *(Nếu `extension_connected` là `false`, xem mục Extension bên dưới)*.

- **Kiểm tra trên trình duyệt:**
  Truy cập: [http://127.0.0.1:8100/docs](http://127.0.0.1:8100/docs)  
  Nếu hiển thị trang tài liệu API Swagger UI là Backend đang hoạt động hoàn hảo.

---

### 2. Kiểm tra Frontend (Cổng 5173)
- Mở trình duyệt truy cập: [http://localhost:5173](http://localhost:5173)
- **Kết quả thành công:** Giao diện **FrameWeaver Studio Dashboard** hiển thị đầy đủ các mục (Dự án, Timeline, Nhân vật, Phong cách...).

---

## 🔌 Bước quan trọng: Kết nối Chrome Extension (Cổng WebSocket 9222)

Backend cần Chrome Extension kết nối với tài khoản Google Flow để sinh ảnh và video.

1. Mở trình duyệt Google Chrome, truy cập:
   ```text
   chrome://extensions
   ```
2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Bấm nút **Load unpacked** (Tải tiện ích đã giải nén) -> Chọn thư mục `extension` nằm trong thư mục dự án `frameweaver`.
4. Mở một tab Chrome mới, truy cập [https://flow.google.com/](https://flow.google.com/) và đăng nhập tài khoản Google của bạn. Giữ tab này luôn mở.
5. Kiểm tra lại bằng lệnh:
   ```powershell
   curl http://127.0.0.1:8100/health
   ```
   Khi thấy `"extension_connected": true` là hệ thống đã sẵn sàng 100% để tạo ảnh và render video.

---

## 📋 Tóm tắt các cổng (Ports) sử dụng

| Cổng (Port) | Dịch vụ | Chức năng | URL kiểm tra |
| :--- | :--- | :--- | :--- |
| **8100** | Backend (FastAPI / Uvicorn) | Xử lý dữ liệu, API, sinh video, TTS | `http://127.0.0.1:8100/health` |
| **9222** | WebSocket Server | Cầu nối giữa Backend và Chrome Extension | `ws://127.0.0.1:9222` |
| **5173** | Frontend (Vite + React) | Giao diện Dashboard người dùng | `http://localhost:5173` |

---

## 🛠️ Xử lý lỗi thường gặp (Troubleshooting)

1. **Lỗi `Address already in use` (Cổng 8100 hoặc 5173 bị kẹt):**
   Nếu tiến trình cũ chưa thoát, mở Terminal tìm và tắt:
   ```powershell
   # Tìm PID của tiến trình đang chiếm cổng 8100
   netstat -ano | findstr :8100
   # Tắt tiến trình theo PID vừa tìm được (thay 12345 bằng PID thật)
   taskkill /PID 12345 /F
   ```

2. **Extension báo `extension_connected: false`:**
   - Kiểm tra xem Backend đã bật chưa (cổng 9222).
   - Bấm nút **Reload** (biểu tượng mũi tên xoay tròn) của extension FrameWeaver trong trang `chrome://extensions`.
   - F5 lại tab Google Flow (`https://flow.google.com/`).
