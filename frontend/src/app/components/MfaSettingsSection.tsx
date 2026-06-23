"use client";

import styles from "@/app/page.module.css";
import { User } from "../types";

interface MfaSettingsSectionProps {
  user: User | null;
  mfaSetupData: { secret: string; qrCode: string } | null;
  setMfaSetupData: (data: { secret: string; qrCode: string } | null) => void;
  mfaSetupCode: string;
  setMfaSetupCode: (code: string) => void;
  isSettingMfa: boolean;
  handleMfaSetupInit: () => void;
  handleMfaSetupVerify: (e: React.FormEvent) => void;
  handleMfaDisable: (code: string) => void;
}

export default function MfaSettingsSection({
  user,
  mfaSetupData,
  setMfaSetupData,
  mfaSetupCode,
  setMfaSetupCode,
  isSettingMfa,
  handleMfaSetupInit,
  handleMfaSetupVerify,
  handleMfaDisable,
}: MfaSettingsSectionProps) {
  return (
    <div className={styles.card} style={{ marginTop: "2rem", width: "100%" }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>🔒 Bảo mật tài khoản (MFA)</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Kích hoạt xác thực 2 lớp (MFA) bằng mã OTP động (Google Authenticator, Authy, v.v.) để bảo mật tối đa cho tài khoản của bạn.
      </p>

      {user && user.mfaEnabled ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--success)", fontWeight: 600 }}>
            <span>🛡️</span>
            <span>Trạng thái: Đang hoạt động (Bảo vệ tài khoản ở mức cao nhất)</span>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const formData = new FormData(form);
              const code = formData.get("mfaDisableCode") as string;
              handleMfaDisable(code);
              form.reset();
            }}
            style={{ display: "flex", gap: "1rem", alignItems: "flex-end", maxWidth: "450px" }}
          >
            <div className={styles.inputGroup} style={{ flex: 1, marginBottom: 0 }}>
              <span className={styles.inputLabel}>Nhập mã OTP 6 số để tắt MFA</span>
              <input
                name="mfaDisableCode"
                type="text"
                maxLength={6}
                className={styles.input}
                placeholder="000000"
                required
              />
            </div>
            <button
              type="submit"
              className={styles.translateButton}
              style={{ backgroundColor: "var(--error)", border: "none" }}
              disabled={isSettingMfa}
            >
              Tắt bảo mật MFA
            </button>
          </form>
        </div>
      ) : (
        <div>
          {!mfaSetupData ? (
            <button onClick={handleMfaSetupInit} className={styles.translateButton} disabled={isSettingMfa}>
              {isSettingMfa ? "Đang xử lý..." : "Cấu hình xác thực 2 lớp (MFA) 🚀"}
            </button>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem", marginTop: "1rem" }}>
              <div
                style={{
                  backgroundColor: "white",
                  padding: "12px",
                  borderRadius: "8px",
                  display: "inline-block",
                  alignSelf: "flex-start",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mfaSetupData.qrCode}
                  alt="MFA QR Code"
                  style={{ display: "block", width: "180px", height: "180px" }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", flex: 1, minWidth: "300px" }}>
                <div>
                  <p style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.25rem" }}>Bước 1: Quét mã QR bảo mật</p>
                  <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: "1.4" }}>
                    Dùng camera điện thoại hoặc ứng dụng quản lý bảo mật như Google Authenticator / Authy để quét mã QR bên cạnh.
                  </p>
                  <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
                    Hoặc copy mã thiết lập thủ công:{" "}
                    <code
                      style={{
                        color: "var(--accent)",
                        padding: "2px 6px",
                        backgroundColor: "rgba(255,255,255,0.05)",
                        borderRadius: "4px",
                        fontSize: "0.9rem",
                        fontWeight: "600",
                      }}
                    >
                      {mfaSetupData.secret}
                    </code>
                  </p>
                </div>

                <div>
                  <p style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.5rem" }}>Bước 2: Xác thực & Kích hoạt</p>
                  <form onSubmit={handleMfaSetupVerify} style={{ display: "flex", gap: "1rem", alignItems: "flex-end", maxWidth: "450px" }}>
                    <div className={styles.inputGroup} style={{ flex: 1, marginBottom: 0 }}>
                      <span className={styles.inputLabel}>Mã xác thực OTP 6 số</span>
                      <input
                        type="text"
                        maxLength={6}
                        className={styles.input}
                        placeholder="123456"
                        value={mfaSetupCode}
                        onChange={(e) => setMfaSetupCode(e.target.value.replace(/\D/g, ""))}
                        required
                      />
                    </div>
                    <button type="submit" className={styles.translateButton} disabled={isSettingMfa}>
                      Kích hoạt ngay
                    </button>
                  </form>
                </div>

                <button
                  className={styles.authSwitchLink}
                  style={{ alignSelf: "flex-start", marginTop: "0.5rem" }}
                  onClick={() => setMfaSetupData(null)}
                >
                  Hủy thiết lập
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
