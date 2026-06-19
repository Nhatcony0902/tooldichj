# CLAUDE.md — Hướng dẫn dự án tooldichj (Next.js & NestJS)

Tài liệu này định nghĩa cấu trúc thư mục, công nghệ/framework sử dụng và các quy tắc phát triển dành cho dự án **tooldichj**.

---

## 🛠️ Công nghệ & Framework sử dụng

Dự án được xây dựng theo kiến trúc Client-Server chuyên nghiệp:

*   **Frontend**: **Next.js** (React, TypeScript, App Router).
    *   Giao diện: CSS thuần (Premium UI, Glassmorphism, Dark Mode).
*   **Backend**: **NestJS** (Node.js framework, TypeScript).
    *   Đảm nhiệm: Xử lý logic dịch thuật, điều hướng API, giới hạn lượt gọi (Rate Limiting), và caching.
*   **Database (Tùy chọn)**: **PostgreSQL** hoặc **SQLite** sử dụng **Prisma ORM**.
    *   Mục đích: Lưu tài khoản, lưu lịch sử dịch thuật, lưu các bản dịch cũ để cache (tiết kiệm chi phí gọi Gemini API).
*   **AI Integration**: Tích hợp **Gemini API** thông qua Google Gen AI SDK ở phía Backend.

---

## 📂 Cấu trúc thư mục (Proposed Structure)

```text
tooldichj/
├── frontend/          # Next.js Application (Port 3000)
│   ├── src/
│   │   ├── app/       # App Router (pages & layouts)
│   │   ├── components/# Reusable UI Components
│   │   └── styles/    # Global CSS & Design Tokens
│   ├── package.json
│   └── tsconfig.json
│
├── backend/           # NestJS Application (Port 3001)
│   ├── src/
│   │   ├── translation/ # Module xử lý dịch thuật (Gemini / Free API)
│   │   ├── cache/       # Module cache bản dịch
│   │   └── main.ts
│   ├── prisma/        # Cấu hình DB và Migrations (nếu có DB)
│   ├── package.json
│   └── tsconfig.json
│
├── CLAUDE.md          # Tài liệu hướng dẫn phát triển (File này)
└── .claude/           # Cấu hình rule, hook và skill của TheOneKit
```

---

## 💻 Hướng dẫn chạy & Phát triển

### Khởi chạy Backend (NestJS):
```bash
cd backend
npm run start:dev
```

### Khởi chạy Frontend (Next.js):
```bash
cd frontend
npm run dev
```

---

## 📐 Quy tắc phát triển (Conventions)

1.  **TypeScript Strict**: Luôn sử dụng kiểu dữ liệu rõ ràng, tránh dùng `any`.
2.  **Độc lập Frontend/Backend**: Next.js không gọi trực tiếp API bên thứ 3 (Gemini). Mọi request dịch thuật phải đi qua NestJS (để bảo mật API Key và thực hiện caching/rate limiting).
3.  **UI Premium**: Giao diện Next.js thiết kế theo chuẩn tối giản hiện đại, hỗ trợ Dark Mode mượt mà, hạn chế placeholder thô.
4.  **Báo lỗi tường minh**: NestJS phải trả về mã lỗi HTTP chuẩn (400, 429, 500) kèm thông báo chi tiết thay vì để crash ngầm.
