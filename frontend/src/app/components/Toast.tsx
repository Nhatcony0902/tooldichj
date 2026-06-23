"use client";

import styles from "@/app/page.module.css";

interface ToastProps {
  type: "success" | "error" | null;
  message: string;
}

export default function Toast({ type, message }: ToastProps) {
  if (!type) return null;

  return (
    <div className={`${styles.toast} ${type === "error" ? styles.toastError : ""}`}>
      <span>{type === "success" ? "✅" : "⚠️"}</span>
      <span>{message}</span>
    </div>
  );
}
