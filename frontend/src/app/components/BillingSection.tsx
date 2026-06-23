"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import styles from "@/app/page.module.css";
import { CreditTopupRequest, User } from "../types";

interface BillingSectionProps {
  token: string;
  user: User | null;
  refreshUser: (token: string) => Promise<void>;
  showToast: (type: "success" | "error", message: string) => void;
}

const AMOUNT_PRESETS = [50000, 100000, 200000, 500000];

export default function BillingSection({ token, user, refreshUser, showToast }: BillingSectionProps) {
  const [amount, setAmount] = useState(100000);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeQr, setActiveQr] = useState<{ qrUrl: string; orderCode: string; amount: number; credits: number } | null>(null);
  const [requests, setRequests] = useState<CreditTopupRequest[]>([]);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMyRequests = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/billing/my-requests", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (response.ok) {
        setRequests(await response.json());
      }
    } catch (err) {
      console.error("Error fetching topup requests:", err);
    }
  }, []);

  useEffect(() => {
    if (token) {
      fetchMyRequests(token);
    }
  }, [token, fetchMyRequests]);

  // Poll while there's a PENDING request, and refresh the user's credits once it resolves.
  useEffect(() => {
    const hasPending = requests.some((r) => r.status === "PENDING");

    if (token && hasPending) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(() => {
          fetchMyRequests(token);
          refreshUser(token);
        }, 5000);
      }
    } else if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [requests, token, fetchMyRequests, refreshUser]);

  const handleCreateTopup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || amount < 10000) {
      showToast("error", "Số tiền nạp tối thiểu là 10.000đ");
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch("http://localhost:3001/billing/topup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount }),
      });
      const data = await response.json();
      if (response.ok) {
        setActiveQr({ qrUrl: data.qrUrl, orderCode: data.orderCode, amount: data.amount, credits: data.credits });
        fetchMyRequests(token);
        showToast("success", "Đã tạo yêu cầu nạp. Vui lòng chuyển khoản theo mã QR.");
      } else {
        showToast("error", data.message || "Không thể tạo yêu cầu nạp credits");
      }
    } catch {
      showToast("error", "Lỗi kết nối server khi tạo yêu cầu nạp!");
    } finally {
      setIsSubmitting(false);
    }
  };

  const badgeClassFor = (status: CreditTopupRequest["status"]) =>
    status === "PENDING" ? styles.badgePending : status === "CONFIRMED" ? styles.badgeCompleted : styles.badgeFailed;

  return (
    <div className={styles.card} style={{ marginTop: "2rem", width: "100%" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>💳 Nạp Credits</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Quét mã QR chuyển khoản ngân hàng (giữ đúng nội dung chuyển khoản) — credits được cộng sau khi admin xác nhận đã nhận tiền.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem" }}>
        <form onSubmit={handleCreateTopup} style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: "280px", flex: 1 }}>
          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Số tiền nạp (VND)</span>
            <input
              type="number"
              min={10000}
              step={1000}
              className={styles.input}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {AMOUNT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={styles.authSwitchLink}
                style={{ border: "1px solid var(--card-border)", borderRadius: "6px", padding: "0.35rem 0.75rem" }}
                onClick={() => setAmount(preset)}
              >
                {preset.toLocaleString("vi-VN")}đ
              </button>
            ))}
          </div>

          <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            ≈ {Math.floor(amount / 1000)} Credits
          </p>

          <button type="submit" className={styles.translateButton} disabled={isSubmitting}>
            {isSubmitting ? "Đang xử lý..." : "Tạo yêu cầu nạp"}
          </button>
        </form>

        {activeQr && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem", minWidth: "220px" }}>
            <div style={{ backgroundColor: "white", padding: "12px", borderRadius: "8px" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={activeQr.qrUrl} alt="VietQR" style={{ display: "block", width: "200px", height: "200px" }} />
            </div>
            <p style={{ fontSize: "0.85rem", textAlign: "center" }}>
              Chuyển khoản <b>{activeQr.amount.toLocaleString("vi-VN")}đ</b> ({activeQr.credits} Credits)
              <br />
              Nội dung CK:{" "}
              <code style={{ color: "var(--accent)", fontWeight: 700 }}>{activeQr.orderCode}</code>
            </p>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "center" }}>
              Giữ đúng nội dung chuyển khoản để admin xác nhận nhanh hơn.
            </p>
          </div>
        )}
      </div>

      {requests.length > 0 && (
        <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <h3 style={{ fontSize: "1rem", fontWeight: 600 }}>Lịch sử nạp credits</h3>
          {requests.map((r) => (
            <div key={r.id} className={styles.jobItem}>
              <div className={styles.jobHeader}>
                <span className={styles.jobTitle}>
                  {r.amount.toLocaleString("vi-VN")}đ — {r.credits} Credits ({r.orderCode})
                </span>
                <span className={`${styles.badge} ${badgeClassFor(r.status)}`}>{r.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {user?.role === "ADMIN" && (
        <p style={{ marginTop: "1.5rem", fontSize: "0.875rem" }}>
          Bạn là Admin —{" "}
          <Link href="/admin" style={{ color: "var(--accent)", fontWeight: 600 }}>
            Quản lý yêu cầu nạp credits →
          </Link>
        </p>
      )}
    </div>
  );
}
