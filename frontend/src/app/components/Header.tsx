"use client";

import styles from "@/app/page.module.css";
import { User } from "../types";

interface HeaderProps {
  isLoggedIn: boolean;
  user: User | null;
  onLogout: () => void;
}

export default function Header({ isLoggedIn, user, onLogout }: HeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.logoContainer}>
        <div className={styles.logoIcon}>J</div>
        <div>
          <h1 className={styles.title}>
            ToolDich<span className="gradient-text">J</span>
          </h1>
          <p className={styles.subtitle}>Kiến trúc B2B SaaS dịch văn bản & video AI cao cấp</p>
        </div>
      </div>

      {/* User Info & Logout (Hiển thị khi đã Đăng nhập) */}
      {isLoggedIn && user && (
        <div className={styles.userInfo}>
          <div className={styles.creditsBadge} title="Số dư credits để dịch thuật">
            💎 <span>{user.credits} Credits</span>
          </div>
          <span className={styles.userEmail} title={`${user.name} (${user.email})`}>
            👤 {user.name}
          </span>
          <button className={styles.logoutButton} onClick={onLogout}>
            Đăng xuất
          </button>
        </div>
      )}
    </header>
  );
}
