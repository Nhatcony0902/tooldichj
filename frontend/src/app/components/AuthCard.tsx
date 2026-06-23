"use client";

import styles from "@/app/page.module.css";

interface AuthCardProps {
  authMode: "login" | "register";
  setAuthMode: (mode: "login" | "register") => void;
  authEmail: string;
  setAuthEmail: (email: string) => void;
  authPassword: string;
  setAuthPassword: (password: string) => void;
  authName: string;
  setAuthName: (name: string) => void;
  authPhone: string;
  setAuthPhone: (phone: string) => void;
  authConfirmPassword: string;
  setAuthConfirmPassword: (confirmPassword: string) => void;
  authError: string;
  setAuthError: (err: string) => void;
  verifyRequired: boolean;
  setVerifyRequired: (req: boolean) => void;
  pendingVerifyEmail: string;
  setPendingVerifyEmail: (email: string) => void;
  verifyOtp: string;
  setVerifyOtp: (otp: string) => void;
  resendCooldown: number;
  mfaRequired: boolean;
  setMfaRequired: (req: boolean) => void;
  mfaCode: string;
  setMfaCode: (code: string) => void;
  handleVerifyEmailSubmit: (e: React.FormEvent) => void;
  handleResendOtp: () => void;
  handleAuthSubmit: (e: React.FormEvent) => void;
  handleMfaLoginSubmit: (e: React.FormEvent) => void;
}

export default function AuthCard({
  authMode,
  setAuthMode,
  authEmail,
  setAuthEmail,
  authPassword,
  setAuthPassword,
  authName,
  setAuthName,
  authPhone,
  setAuthPhone,
  authConfirmPassword,
  setAuthConfirmPassword,
  authError,
  setAuthError,
  verifyRequired,
  setVerifyRequired,
  pendingVerifyEmail,
  setPendingVerifyEmail,
  verifyOtp,
  setVerifyOtp,
  resendCooldown,
  mfaRequired,
  setMfaRequired,
  mfaCode,
  setMfaCode,
  handleVerifyEmailSubmit,
  handleResendOtp,
  handleAuthSubmit,
  handleMfaLoginSubmit,
}: AuthCardProps) {
  return (
    <div className={styles.authContainer}>
      {verifyRequired ? (
        <div className={styles.authCard}>
          <h2 className={styles.authTitle}>Xác thực email</h2>
          <p className={styles.authSubtitle}>
            Nhập mã xác thực 6 chữ số đã được gửi tới <strong>{pendingVerifyEmail}</strong>.
          </p>

          {authError && (
            <div style={{ color: "var(--error)", fontSize: "0.875rem", textAlign: "center", marginBottom: "1rem" }}>
              ⚠️ {authError}
            </div>
          )}

          <form onSubmit={handleVerifyEmailSubmit} className={styles.authForm}>
            <div className={styles.inputGroup}>
              <span className={styles.inputLabel}>Mã xác thực OTP</span>
              <input
                type="text"
                maxLength={6}
                pattern="\d{6}"
                className={styles.input}
                placeholder="123456"
                value={verifyOtp}
                onChange={(e) => setVerifyOtp(e.target.value.replace(/\D/g, ""))}
                required
              />
            </div>
            <button type="submit" className={styles.authButton}>
              Xác thực email
            </button>
          </form>

          <div className={styles.authSwitch}>
            <button
              className={styles.authSwitchLink}
              onClick={handleResendOtp}
              disabled={resendCooldown > 0}
            >
              {resendCooldown > 0 ? `Gửi lại mã (${resendCooldown}s)` : "Gửi lại mã xác thực"}
            </button>
          </div>

          <div className={styles.authSwitch}>
            <button
              className={styles.authSwitchLink}
              onClick={() => {
                setVerifyRequired(false);
                setPendingVerifyEmail("");
                setVerifyOtp("");
                setAuthError("");
              }}
            >
              Quay lại đăng nhập
            </button>
          </div>
        </div>
      ) : mfaRequired ? (
        <div className={styles.authCard}>
          <h2 className={styles.authTitle}>Xác thực 2 lớp (MFA)</h2>
          <p className={styles.authSubtitle}>
            Nhập mã xác thực 6 chữ số từ ứng dụng Authenticator của bạn (Google Authenticator, Authy, v.v.).
          </p>

          {authError && (
            <div style={{ color: "var(--error)", fontSize: "0.875rem", textAlign: "center", marginBottom: "1rem" }}>
              ⚠️ {authError}
            </div>
          )}

          <form onSubmit={handleMfaLoginSubmit} className={styles.authForm}>
            <div className={styles.inputGroup}>
              <span className={styles.inputLabel}>Mã xác thực OTP</span>
              <input
                type="text"
                maxLength={6}
                pattern="\d{6}"
                className={styles.input}
                placeholder="123456"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                required
              />
            </div>
            <button type="submit" className={styles.authButton}>
              Xác minh & Đăng nhập
            </button>
          </form>

          <div className={styles.authSwitch}>
            <button
              className={styles.authSwitchLink}
              onClick={() => {
                setMfaRequired(false);
                setMfaCode("");
                setAuthError("");
              }}
            >
              Quay lại đăng nhập
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.authCard}>
          <h2 className={styles.authTitle}>
            {authMode === "login" ? "Chào mừng quay lại" : "Tạo tài khoản mới"}
          </h2>
          <p className={styles.authSubtitle}>
            {authMode === "login"
              ? "Đăng nhập để tiếp tục dịch thuật"
              : "Đăng ký nhận ngay 100 Credits dịch thuật miễn phí"}
          </p>

          {authError && (
            <div style={{ color: "var(--error)", fontSize: "0.875rem", textAlign: "center" }}>
              ⚠️ {authError}
              {authMode === "login" && pendingVerifyEmail && (
                <>
                  {" "}
                  <button
                    type="button"
                    className={styles.authSwitchLink}
                    onClick={() => {
                      setVerifyRequired(true);
                      setVerifyOtp("");
                      setAuthError("");
                    }}
                  >
                    Xác thực ngay
                  </button>
                </>
              )}
            </div>
          )}

          <form onSubmit={handleAuthSubmit} className={styles.authForm}>
            {authMode === "register" ? (
              <>
                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Họ và tên</span>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Nguyễn Văn A"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    required
                  />
                </div>

                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Số điện thoại (tùy chọn)</span>
                  <input
                    type="tel"
                    className={styles.input}
                    placeholder="0987654321"
                    value={authPhone}
                    onChange={(e) => setAuthPhone(e.target.value)}
                  />
                </div>

                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Địa chỉ Email</span>
                  <input
                    type="email"
                    className={styles.input}
                    placeholder="name@example.com"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    required
                  />
                </div>

                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Mật khẩu</span>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="••••••••"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    required
                  />
                </div>

                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Xác nhận mật khẩu</span>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="••••••••"
                    value={authConfirmPassword}
                    onChange={(e) => setAuthConfirmPassword(e.target.value)}
                    required
                  />
                </div>
              </>
            ) : (
              <>
                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Địa chỉ Email</span>
                  <input
                    type="email"
                    className={styles.input}
                    placeholder="name@example.com"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    required
                  />
                </div>

                <div className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Mật khẩu</span>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="••••••••"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            <button type="submit" className={styles.authButton}>
              {authMode === "login" ? "Đăng nhập" : "Đăng ký ngay"}
            </button>
          </form>

          <div className={styles.authSwitch}>
            {authMode === "login" ? (
              <>
                Chưa có tài khoản?{" "}
                <button className={styles.authSwitchLink} onClick={() => setAuthMode("register")}>
                  Đăng ký
                </button>
              </>
            ) : (
              <>
                Đã có tài khoản?{" "}
                <button className={styles.authSwitchLink} onClick={() => setAuthMode("login")}>
                  Đăng nhập
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
