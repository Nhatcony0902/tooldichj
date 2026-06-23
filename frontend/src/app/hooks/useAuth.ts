"use client";

import { useState, useEffect, useCallback } from "react";
import { User } from "../types";

export interface ToastState {
  type: "success" | "error" | null;
  message: string;
}

export function useAuth() {
  // Auth States
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // Email Verification States
  const [verifyRequired, setVerifyRequired] = useState(false);
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState("");
  const [verifyOtp, setVerifyOtp] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  // Forgot/Reset Password States
  const [forgotPasswordStep, setForgotPasswordStep] = useState<"closed" | "request" | "reset">("closed");
  const [fpEmail, setFpEmail] = useState("");
  const [fpOtp, setFpOtp] = useState("");
  const [fpNewPassword, setFpNewPassword] = useState("");
  const [fpConfirmPassword, setFpConfirmPassword] = useState("");

  // MFA States
  const [mfaRequired, setMfaRequired] = useState(false);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; qrCode: string } | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState("");
  const [isSettingMfa, setIsSettingMfa] = useState(false);

  // Toast Notification State
  const [toast, setToast] = useState<ToastState>({
    type: null,
    message: "",
  });

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast({ type: null, message: "" });
    }, 4000);
  }, []);

  // Đăng xuất
  const handleLogout = useCallback((onLogoutCb?: () => void) => {
    localStorage.removeItem("tooldichj_token");
    setToken(null);
    setUser(null);
    setIsLoggedIn(false);
    setVerifyRequired(false);
    setPendingVerifyEmail("");
    setVerifyOtp("");
    setResendCooldown(0);
    setMfaRequired(false);
    setTempToken(null);
    setMfaCode("");
    setMfaSetupData(null);
    setMfaSetupCode("");
    if (onLogoutCb) {
      onLogoutCb();
    }
  }, []);

  // Fetch thông tin user hiện tại
  const fetchUserMe = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/auth/me", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();
      if (response.ok) {
        setUser(data);
        setIsLoggedIn(true);
      } else {
        handleLogout();
      }
    } catch (err) {
      console.error("Error fetching user profile:", err);
    } finally {
      setIsAuthLoading(false);
    }
  }, [handleLogout]);

  // Khởi động khi mount
  useEffect(() => {
    const savedToken = localStorage.getItem("tooldichj_token");
    if (savedToken) {
      setToken(savedToken);
      fetchUserMe(savedToken);
    } else {
      setIsAuthLoading(false);
    }
  }, [fetchUserMe]);

  // Đếm ngược cooldown cho nút "Gửi lại mã xác thực"
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Xác thực email bằng mã OTP gửi qua mail
  const handleVerifyEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingVerifyEmail || !verifyOtp) return;
    setAuthError("");

    try {
      const response = await fetch("http://localhost:3001/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingVerifyEmail, otp: verifyOtp }),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        showToast("success", "Xác thực email thành công! Hãy đăng nhập để tiếp tục.");
        setVerifyRequired(false);
        setVerifyOtp("");
        setAuthMode("login");
        setAuthEmail(pendingVerifyEmail);
        setPendingVerifyEmail("");
      } else {
        setAuthError(data.message || "Mã xác thực không đúng hoặc đã hết hạn!");
      }
    } catch {
      setAuthError("Không thể kết nối đến server để xác minh!");
    }
  };

  // Gửi lại mã OTP xác thực email
  const handleResendOtp = async () => {
    if (!pendingVerifyEmail || resendCooldown > 0) return;
    setAuthError("");

    try {
      const response = await fetch("http://localhost:3001/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingVerifyEmail }),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        showToast("success", "Đã gửi lại mã xác thực, vui lòng kiểm tra email.");
        setResendCooldown(60);
      } else {
        setAuthError(data.message || "Không thể gửi lại mã xác thực!");
      }
    } catch {
      setAuthError("Không thể kết nối đến server để gửi lại mã!");
    }
  };

  // Đăng ký hoặc Đăng nhập
  const handleAuthSubmit = async (e: React.FormEvent, onLoginSuccess?: (authToken: string) => void) => {
    e.preventDefault();
    setAuthError("");

    if (authMode === "register") {
      if (!authEmail || !authPassword || !authName) {
        setAuthError("Vui lòng điền đầy đủ Email, Mật khẩu và Họ tên!");
        return;
      }
      if (authPassword !== authConfirmPassword) {
        setAuthError("Mật khẩu xác nhận không khớp!");
        return;
      }
    } else {
      if (!authEmail || !authPassword) {
        setAuthError("Vui lòng nhập đầy đủ Email và Mật khẩu");
        return;
      }
    }

    const endpoint = authMode === "login" ? "login" : "register";
    const bodyPayload = authMode === "login"
      ? { email: authEmail, password: authPassword }
      : { email: authEmail, password: authPassword, name: authName, phone: authPhone };

    try {
      const response = await fetch(`http://localhost:3001/auth/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        if (authMode === "login") {
          if (data.mfaRequired) {
            setMfaRequired(true);
            setTempToken(data.tempToken);
            setAuthError("");
            showToast("success", "Vui lòng nhập mã xác thực 2 lớp (MFA) để hoàn tất đăng nhập.");
            return;
          }
          localStorage.setItem("tooldichj_token", data.accessToken);
          setToken(data.accessToken);
          setUser(data.user);
          setIsLoggedIn(true);
          setAuthEmail("");
          setAuthPassword("");
          setAuthName("");
          setAuthPhone("");
          setAuthConfirmPassword("");
          if (onLoginSuccess) {
            onLoginSuccess(data.accessToken);
          }
        } else {
          showToast(
            "success",
            data.emailSent === false
              ? "Đăng ký thành công, nhưng không gửi được email xác thực. Vui lòng dùng nút Gửi lại mã."
              : "Đăng ký thành công! Vui lòng kiểm tra email để lấy mã xác thực."
          );
          setPendingVerifyEmail(authEmail);
          setVerifyRequired(true);
          setVerifyOtp("");
          setResendCooldown(60);
          setAuthPassword("");
          setAuthName("");
          setAuthPhone("");
          setAuthConfirmPassword("");
        }
      } else if (response.status === 403 && authMode === "login") {
        setPendingVerifyEmail(authEmail);
        setAuthError(data.message || "Email chưa được xác thực. Vui lòng xác thực trước khi đăng nhập.");
      } else {
        setAuthError(data.message || data.error || "Có lỗi xảy ra, vui lòng thử lại!");
      }
    } catch {
      setAuthError("Không thể kết nối đến Backend NestJS. Vui lòng kiểm tra lại server!");
    }
  };

  // Xác thực đăng nhập bằng mã OTP (MFA)
  const handleMfaLoginSubmit = async (e: React.FormEvent, onLoginSuccess?: (authToken: string) => void) => {
    e.preventDefault();
    if (!tempToken || !mfaCode) return;
    setAuthError("");

    try {
      const response = await fetch("http://localhost:3001/auth/login/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tempToken, code: mfaCode }),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        localStorage.setItem("tooldichj_token", data.accessToken);
        setToken(data.accessToken);
        setUser(data.user);
        setIsLoggedIn(true);
        setMfaRequired(false);
        setTempToken(null);
        setMfaCode("");
        setAuthEmail("");
        setAuthPassword("");
        setAuthName("");
        setAuthPhone("");
        setAuthConfirmPassword("");
        showToast("success", "Đăng nhập thành công!");
        if (onLoginSuccess) {
          onLoginSuccess(data.accessToken);
        }
      } else {
        setAuthError(data.message || data.error || "Mã xác thực 2 lớp (MFA) không chính xác!");
      }
    } catch {
      setAuthError("Không thể kết nối đến server để xác minh!");
    }
  };

  // Yêu cầu gửi mã đặt lại mật khẩu
  const handleForgotPasswordRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fpEmail) return;

    try {
      const response = await fetch("http://localhost:3001/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fpEmail }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        showToast("success", data.message || "Nếu email tồn tại, mã đặt lại mật khẩu đã được gửi.");
        setForgotPasswordStep("reset");
      } else {
        showToast("error", data.message || "Không thể gửi yêu cầu đặt lại mật khẩu!");
      }
    } catch {
      showToast("error", "Không thể kết nối đến server!");
    }
  };

  // Đặt lại mật khẩu bằng mã OTP gửi qua mail
  const handleResetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fpEmail || !fpOtp || !fpNewPassword) return;
    if (fpNewPassword !== fpConfirmPassword) {
      showToast("error", "Mật khẩu xác nhận không khớp!");
      return;
    }

    try {
      const response = await fetch("http://localhost:3001/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fpEmail, otp: fpOtp, newPassword: fpNewPassword }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        showToast("success", "Đặt lại mật khẩu thành công! Vui lòng đăng nhập.");
        setAuthMode("login");
        setAuthEmail(fpEmail);
        setForgotPasswordStep("closed");
        setFpEmail("");
        setFpOtp("");
        setFpNewPassword("");
        setFpConfirmPassword("");
      } else {
        showToast("error", data.message || "Mã xác thực không đúng hoặc đã hết hạn!");
      }
    } catch {
      showToast("error", "Không thể kết nối đến server!");
    }
  };

  // Bắt đầu cấu hình MFA (Lấy QR Code & Secret)
  const handleMfaSetupInit = async () => {
    if (!token) return;
    setIsSettingMfa(true);
    try {
      const response = await fetch("http://localhost:3001/auth/mfa/setup", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok) {
        setMfaSetupData(data);
        showToast("success", "Tải mã QR cấu hình MFA thành công.");
      } else {
        showToast("error", data.message || "Lỗi tạo QR cấu hình.");
      }
    } catch {
      showToast("error", "Lỗi kết nối server.");
    } finally {
      setIsSettingMfa(false);
    }
  };

  // Xác minh và Kích hoạt MFA
  const handleMfaSetupVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !mfaSetupCode) return;
    setIsSettingMfa(true);
    try {
      const response = await fetch("http://localhost:3001/auth/mfa/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code: mfaSetupCode }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        showToast("success", "Bật xác thực 2 lớp (MFA) thành công!");
        setMfaSetupData(null);
        setMfaSetupCode("");
        fetchUserMe(token);
      } else {
        showToast("error", data.message || "Mã OTP xác thực không đúng!");
      }
    } catch {
      showToast("error", "Lỗi kết nối server.");
    } finally {
      setIsSettingMfa(false);
    }
  };

  // Hủy kích hoạt MFA
  const handleMfaDisable = async (code: string) => {
    if (!token || !code) return;
    setIsSettingMfa(true);
    try {
      const response = await fetch("http://localhost:3001/auth/mfa/disable", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        showToast("success", "Đã tắt xác thực 2 lớp (MFA) thành công.");
        fetchUserMe(token);
      } else {
        showToast("error", data.message || "Mã OTP xác thực không đúng!");
      }
    } catch {
      showToast("error", "Lỗi kết nối server.");
    } finally {
      setIsSettingMfa(false);
    }
  };

  return {
    isLoggedIn,
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
    token,
    user,
    isAuthLoading,
    verifyRequired,
    setVerifyRequired,
    pendingVerifyEmail,
    setPendingVerifyEmail,
    verifyOtp,
    setVerifyOtp,
    resendCooldown,
    forgotPasswordStep,
    setForgotPasswordStep,
    fpEmail,
    setFpEmail,
    fpOtp,
    setFpOtp,
    fpNewPassword,
    setFpNewPassword,
    fpConfirmPassword,
    setFpConfirmPassword,
    handleForgotPasswordRequest,
    handleResetPasswordSubmit,
    mfaRequired,
    setMfaRequired,
    tempToken,
    setTempToken,
    mfaCode,
    setMfaCode,
    mfaSetupData,
    setMfaSetupData,
    mfaSetupCode,
    setMfaSetupCode,
    isSettingMfa,
    toast,
    showToast,
    handleLogout,
    fetchUserMe,
    handleVerifyEmailSubmit,
    handleResendOtp,
    handleAuthSubmit,
    handleMfaLoginSubmit,
    handleMfaSetupInit,
    handleMfaSetupVerify,
    handleMfaDisable,
  };
}
