"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import styles from "@/app/page.module.css";
import { CreditTopupRequest, User } from "../types";

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pending, setPending] = useState<CreditTopupRequest[]>([]);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const fetchPending = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/billing/admin/pending", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (response.ok) {
        setPending(await response.json());
      }
    } catch (err) {
      console.error("Error fetching pending topup requests:", err);
    }
  }, []);

  useEffect(() => {
    const savedToken = localStorage.getItem("tooldichj_token");
    if (!savedToken) {
      setIsLoading(false);
      return;
    }
    setToken(savedToken);
    (async () => {
      try {
        const response = await fetch("http://localhost:3001/auth/me", {
          headers: { Authorization: `Bearer ${savedToken}` },
        });
        if (response.ok) {
          const me = await response.json();
          setUser(me);
          if (me.role === "ADMIN") {
            await fetchPending(savedToken);
          }
        }
      } catch (err) {
        console.error("Error fetching current user:", err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [fetchPending]);

  const handleAction = async (id: string, action: "confirm" | "reject") => {
    if (!token) return;
    setActioningId(id);
    try {
      const response = await fetch(`http://localhost:3001/billing/admin/${id}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        await fetchPending(token);
      } else {
        const data = await response.json().catch(() => ({}));
        alert(data.message || "Hành động thất bại");
      }
    } catch {
      alert("Lỗi kết nối server");
    } finally {
      setActioningId(null);
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p>Đang tải...</p>
      </div>
    );
  }

  if (!token || !user || user.role !== "ADMIN") {
    return (
      <div className={styles.container} style={{ minHeight: "100vh" }}>
        <div className={styles.card} style={{ marginTop: "3rem" }}>
          <h2>🚫 Truy cập bị từ chối</h2>
          <p style={{ color: "var(--text-secondary)" }}>Trang này chỉ dành cho quản trị viên (Admin).</p>
          <Link href="/" style={{ color: "var(--accent)", fontWeight: 600 }}>
            ← Về trang chủ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container} style={{ minHeight: "100vh" }}>
      <div className={styles.card} style={{ marginTop: "2rem", width: "100%" }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          🛡️ Quản lý yêu cầu nạp Credits
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
          Đối chiếu với sao kê/ứng dụng ngân hàng của bạn theo nội dung chuyển khoản (mã đơn), sau đó xác nhận hoặc từ chối.
        </p>

        {pending.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
            Không có yêu cầu nạp credits nào đang chờ xử lý.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {pending.map((req) => (
              <div key={req.id} className={styles.jobItem}>
                <div className={styles.jobHeader}>
                  <span className={styles.jobTitle}>
                    {req.user?.name} ({req.user?.email})
                  </span>
                  <span className={`${styles.badge} ${styles.badgePending}`}>{req.status}</span>
                </div>
                <p style={{ fontSize: "0.9rem" }}>
                  <b>{req.amount.toLocaleString("vi-VN")}đ</b> → {req.credits} Credits — Mã đơn:{" "}
                  <code style={{ color: "var(--accent)", fontWeight: 700 }}>{req.orderCode}</code>
                </p>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Tạo lúc: {new Date(req.createdAt).toLocaleString("vi-VN")}
                </p>
                <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
                  <button
                    className={styles.translateButton}
                    disabled={actioningId === req.id}
                    onClick={() => handleAction(req.id, "confirm")}
                  >
                    ✅ Xác nhận đã nhận tiền
                  </button>
                  <button
                    className={styles.translateButton}
                    style={{ backgroundColor: "var(--error)", border: "none" }}
                    disabled={actioningId === req.id}
                    onClick={() => handleAction(req.id, "reject")}
                  >
                    ❌ Từ chối
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
