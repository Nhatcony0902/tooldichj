"use client";

import styles from "@/app/page.module.css";

interface ToastProps {
  type: "success" | "error" | null;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export default function Toast({ type, message, actionLabel, onAction }: ToastProps) {
  if (!type) return null;

  return (
    <div className={`${styles.toast} ${type === "error" ? styles.toastError : ""}`}>
      <span>{type === "success" ? "✅" : "⚠️"}</span>
      <span>{message}</span>
      {actionLabel && onAction && (
        <button onClick={onAction} className={styles.toastAction}>{actionLabel}</button>
      )}
    </div>
  );
}
