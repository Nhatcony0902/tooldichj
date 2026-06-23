"use client";

import { useState } from "react";
import styles from "@/app/page.module.css";
import { User } from "../types";

interface ProfileSectionProps {
  token: string;
  user: User | null;
  refreshUser: (token: string) => Promise<void>;
  showToast: (type: "success" | "error", message: string) => void;
}

export default function ProfileSection({ token, user, refreshUser, showToast }: ProfileSectionProps) {
  const [name, setName] = useState(user?.name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? "");
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [avatarPreviewBroken, setAvatarPreviewBroken] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast("error", "Họ và tên không được để trống");
      return;
    }

    setIsSavingProfile(true);
    try {
      const response = await fetch("http://localhost:3001/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: trimmedName,
          phone: phone.trim(),
          avatarUrl: avatarUrl.trim(),
        }),
      });
      const data = await response.json();
      if (response.ok) {
        await refreshUser(token);
        showToast("success", "Đã cập nhật thông tin hồ sơ");
      } else {
        showToast("error", data.message || "Không thể cập nhật hồ sơ");
      }
    } catch {
      showToast("error", "Lỗi kết nối server khi cập nhật hồ sơ!");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    if (newPassword !== confirmNewPassword) {
      showToast("error", "Mật khẩu mới và xác nhận mật khẩu không khớp");
      return;
    }

    setIsChangingPassword(true);
    try {
      const response = await fetch("http://localhost:3001/auth/change-password", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();
      if (response.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmNewPassword("");
        showToast("success", "Đã đổi mật khẩu thành công");
      } else {
        showToast("error", data.message || "Không thể đổi mật khẩu");
      }
    } catch {
      showToast("error", "Lỗi kết nối server khi đổi mật khẩu!");
    } finally {
      setIsChangingPassword(false);
    }
  };

  return (
    <div className={styles.card} style={{ marginTop: "2rem", width: "100%" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>👤 Hồ sơ cá nhân</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Chỉnh sửa thông tin cá nhân và đổi mật khẩu tài khoản của bạn.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem" }}>
        {/* Form 1: thông tin cá nhân */}
        <form
          onSubmit={handleProfileSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: "280px", flex: 1 }}
        >
          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Họ và tên</span>
            <input
              type="text"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Số điện thoại</span>
            <input
              type="text"
              className={styles.input}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0901234567"
            />
          </div>

          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Link ảnh đại diện (URL)</span>
            <input
              type="text"
              className={styles.input}
              value={avatarUrl}
              onChange={(e) => {
                setAvatarUrl(e.target.value);
                setAvatarPreviewBroken(false);
              }}
              placeholder="https://..."
            />
          </div>

          {avatarUrl.trim() && !avatarPreviewBroken && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl.trim()}
                alt="Avatar preview"
                style={{ width: "56px", height: "56px", borderRadius: "50%", objectFit: "cover" }}
                onError={() => setAvatarPreviewBroken(true)}
              />
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Xem trước ảnh đại diện</span>
            </div>
          )}

          <button type="submit" className={styles.translateButton} disabled={isSavingProfile}>
            {isSavingProfile ? "Đang lưu..." : "Lưu thông tin"}
          </button>
        </form>

        {/* Form 2: đổi mật khẩu */}
        <form
          onSubmit={handlePasswordSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: "280px", flex: 1 }}
        >
          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Mật khẩu hiện tại</span>
            <input
              type="password"
              className={styles.input}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>

          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Mật khẩu mới</span>
            <input
              type="password"
              className={styles.input}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>

          <div className={styles.inputGroup} style={{ marginBottom: 0 }}>
            <span className={styles.inputLabel}>Xác nhận mật khẩu mới</span>
            <input
              type="password"
              className={styles.input}
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>

          <button type="submit" className={styles.translateButton} disabled={isChangingPassword}>
            {isChangingPassword ? "Đang xử lý..." : "Đổi mật khẩu"}
          </button>
        </form>
      </div>
    </div>
  );
}
