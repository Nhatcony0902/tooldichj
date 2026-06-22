"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "./page.module.css";

interface TranslationHistory {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  timestamp: string;
}

interface VideoJob {
  id: string;
  fileName: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  progress: number;
  stepDescription: string;
  targetLang: string;
  subtitlesUrl?: string;
  errorMessage?: string;
  createdAt: string;
}

interface User {
  id: string;
  email: string;
  name: string;
  role?: string;
  credits: number;
  mfaEnabled?: boolean;
  preferredVoiceId?: string | null;
}

interface Voice {
  id: string;
  displayName: string;
  style: string;
  sampleUrl: string;
}

export default function Home() {
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

  // MFA States
  const [mfaRequired, setMfaRequired] = useState(false);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; qrCode: string } | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState("");
  const [isSettingMfa, setIsSettingMfa] = useState(false);

  // Toast Notification State
  const [toast, setToast] = useState<{ type: "success" | "error" | null; message: string }>({
    type: null,
    message: "",
  });

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast({ type: null, message: "" });
    }, 4000);
  };

  // Tab States
  const [activeTab, setActiveTab] = useState<"text" | "video">("text");

  // Text Translation States
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("vi");
  const [isTranslating, setIsTranslating] = useState(false);
  const [history, setHistory] = useState<TranslationHistory[]>([]);

  // TTS Voice States
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("Kore");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  // Video Translation States
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [targetLangVideo, setTargetLangVideo] = useState("vi");
  const [jobs, setJobs] = useState<VideoJob[]>([]);

  // Ref to hold polling interval
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Đăng xuất
  const handleLogout = useCallback(() => {
    localStorage.removeItem("tooldichj_token");
    setToken(null);
    setUser(null);
    setIsLoggedIn(false);
    setJobs([]);
    setVerifyRequired(false);
    setPendingVerifyEmail("");
    setVerifyOtp("");
    setResendCooldown(0);
    setMfaRequired(false);
    setTempToken(null);
    setMfaCode("");
    setMfaSetupData(null);
    setMfaSetupCode("");
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Fetch thông tin user hiện tại (để cập nhật Credits)
  const fetchUserMe = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/auth/me", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();
      if (response.ok) {
        setUser(data);
        setIsLoggedIn(true);
        if (data.preferredVoiceId) {
          setSelectedVoiceId(data.preferredVoiceId);
        }
      } else {
        // Token hết hạn hoặc không hợp lệ
        handleLogout();
      }
    } catch (err) {
      console.error("Error fetching user profile:", err);
    } finally {
      setIsAuthLoading(false);
    }
  }, [handleLogout]);

  // Fetch danh sách các Video Jobs từ Backend
  const fetchJobs = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/translation/video-jobs", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();
      if (data.success) {
        setJobs(data.jobs);
      }
    } catch (err) {
      console.error("Error fetching video jobs:", err);
    }
  }, []);

  // Fetch danh mục giọng đọc TTS (chỉ cần 1 lần)
  const fetchVoices = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/tts/voices", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();
      if (data.success) {
        setVoices(data.voices);
      }
    } catch (err) {
      console.error("Error fetching voice catalog:", err);
    }
  }, []);

  // Phát một blob audio (dùng chung cho Listen và preview giọng đọc)
  const playAudioBlob = async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  };

  // Nghe bản dịch văn bản bằng giọng đã chọn (1 Credit, cache theo text+voice)
  const handleListen = async () => {
    if (!outputText.trim() || !token || isSpeaking) return;
    setIsSpeaking(true);
    try {
      const response = await fetch("http://localhost:3001/tts/speak", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: outputText, voiceId: selectedVoiceId }),
      });
      if (!response.ok) {
        const data = await response.json();
        showToast("error", data.error || "Không thể tạo giọng đọc");
        return;
      }
      await playAudioBlob(await response.blob());
      fetchUserMe(token);
    } catch {
      showToast("error", "Lỗi kết nối server khi tạo giọng đọc!");
    } finally {
      setIsSpeaking(false);
    }
  };

  // Nghe thử mẫu giọng đọc (miễn phí, không trừ Credits)
  const handlePreviewVoice = async (voiceId: string) => {
    if (!token || previewingVoiceId) return;
    setPreviewingVoiceId(voiceId);
    try {
      const response = await fetch(`http://localhost:3001/tts/sample/${voiceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        showToast("error", "Không thể tải mẫu giọng đọc");
        return;
      }
      await playAudioBlob(await response.blob());
    } catch {
      showToast("error", "Lỗi kết nối server khi tải mẫu giọng đọc!");
    } finally {
      setPreviewingVoiceId(null);
    }
  };

  // Chọn giọng đọc mặc định và lưu lại cho lần sau
  const handleVoiceChange = async (voiceId: string) => {
    setSelectedVoiceId(voiceId);
    if (!token) return;
    try {
      await fetch("http://localhost:3001/tts/preferred-voice", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ voiceId }),
      });
    } catch (err) {
      console.error("Error saving preferred voice:", err);
    }
  };

  // Khởi động khi mount
  useEffect(() => {
    const savedToken = localStorage.getItem("tooldichj_token");
    const savedHistory = localStorage.getItem("tooldichj_history");
    setTimeout(() => {
      if (savedToken) {
        setToken(savedToken);
        fetchUserMe(savedToken);
        fetchJobs(savedToken);
        fetchVoices(savedToken);
      } else {
        setIsAuthLoading(false);
      }
      if (savedHistory) {
        setHistory(JSON.parse(savedHistory));
      }
    }, 0);
  }, [fetchUserMe, fetchJobs, fetchVoices]);

  // Polling để cập nhật tiến độ video job
  useEffect(() => {
    // Nếu có job đang chạy (PENDING hoặc PROCESSING), ta sẽ poll định kỳ mỗi 3 giây
    const hasActiveJobs = jobs.some(
      (job) => job.status === "PENDING" || job.status === "PROCESSING"
    );

    if (isLoggedIn && token && hasActiveJobs) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(() => {
          fetchJobs(token);
          fetchUserMe(token); // Cập nhật cả credits khi job xong
        }, 3000);
      }
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [jobs, isLoggedIn, token, fetchJobs, fetchUserMe]);

  // handleLogout is moved above

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
  const handleAuthSubmit = async (e: React.FormEvent) => {
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
          if (data.user.preferredVoiceId) {
            setSelectedVoiceId(data.user.preferredVoiceId);
          }
          setAuthEmail("");
          setAuthPassword("");
          setAuthName("");
          setAuthPhone("");
          setAuthConfirmPassword("");
          fetchJobs(data.accessToken);
          fetchVoices(data.accessToken);
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
  const handleMfaLoginSubmit = async (e: React.FormEvent) => {
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
        if (data.user.preferredVoiceId) {
          setSelectedVoiceId(data.user.preferredVoiceId);
        }
        setMfaRequired(false);
        setTempToken(null);
        setMfaCode("");
        setAuthEmail("");
        setAuthPassword("");
        setAuthName("");
        setAuthPhone("");
        setAuthConfirmPassword("");
        showToast("success", "Đăng nhập thành công!");
        fetchJobs(data.accessToken);
        fetchVoices(data.accessToken);
      } else {
        setAuthError(data.message || data.error || "Mã xác thực 2 lớp (MFA) không chính xác!");
      }
    } catch {
      setAuthError("Không thể kết nối đến server để xác minh!");
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

  // Gọi dịch văn bản (Có JWT Auth và trừ Credits)
  const handleTranslate = async () => {
    if (!inputText.trim() || !token) return;
    setIsTranslating(true);
    try {
      const response = await fetch("http://localhost:3001/translation/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          text: inputText,
          sourceLang,
          targetLang,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setOutputText(data.translatedText);

        // Cập nhật lại số dư credits hiển thị
        fetchUserMe(token);

        // Lưu vào lịch sử dịch
        const newRecord: TranslationHistory = {
          id: Math.random().toString(36).substring(2, 9),
          sourceText: inputText,
          translatedText: data.translatedText,
          sourceLang,
          targetLang,
          timestamp: new Date().toLocaleTimeString(),
        };
        const updatedHistory = [newRecord, ...history.slice(0, 9)];
        setHistory(updatedHistory);
        localStorage.setItem("tooldichj_history", JSON.stringify(updatedHistory));
      } else {
        setOutputText(`[Lỗi]: ${data.error || "Không thể dịch thuật"}`);
      }
    } catch {
      setOutputText("[Lỗi kết nối]: Vui lòng kiểm tra lại Server Backend!");
    } finally {
      setIsTranslating(false);
    }
  };

  // Tạo Video Job dịch thuật ở Backend (Có trừ Credits sau khi xong)
  const handleVideoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    if (!videoFile) {
      showToast("error", "Vui lòng tải lên file video!");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("targetLang", targetLangVideo);

      const outputSelect = document.querySelector<HTMLSelectElement>('[data-output-mode]');
      if (outputSelect) {
        formData.append("outputMode", outputSelect.value);
      }

      const response = await fetch("http://localhost:3001/translation/video-job", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
      const data = await response.json();

      if (data.success) {
        setVideoFile(null);
        setVideoUrl("");
        const fileInput = document.getElementById("fileInput") as HTMLInputElement;
        if (fileInput) fileInput.value = "";

        fetchJobs(token);
        fetchUserMe(token);
        showToast("success", "Đã thêm video vào hàng đợi dịch thuật!");
      } else {
        showToast("error", data.error || "Lỗi tạo video job");
      }
    } catch {
      showToast("error", "Lỗi kết nối server khi tạo video job!");
    }
  };

  const handleSwapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setInputText(outputText);
    setOutputText(inputText);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem("tooldichj_history");
  };

  if (isAuthLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p style={{ fontSize: "1.25rem", color: "var(--text-secondary)" }}>Đang tải cấu hình ứng dụng...</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Toast Notification */}
      {toast.type && (
        <div className={`${styles.toast} ${toast.type === "error" ? styles.toastError : ""}`}>
          <span>{toast.type === "success" ? "✅" : "⚠️"}</span>
          <span>{toast.message}</span>
        </div>
      )}

      {/* Header */}
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
            <button className={styles.logoutButton} onClick={handleLogout}>
              Đăng xuất
            </button>
          </div>
        )}
      </header>

      {/* GIAO DIỆN AUTH (LOGIN / REGISTER) */}
      {!isLoggedIn ? (
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
                    setTempToken(null);
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
                          setResendCooldown(0);
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
                    {/* Trường Đăng ký */}
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
                    {/* Trường Đăng nhập */}
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
      ) : (
        /* GIAO DIỆN DASHBOARD CHÍNH (ĐÃ ĐĂNG NHẬP) */
        <>
          {/* Tabs */}
          <div className={styles.tabs}>
            <button
              className={`${styles.tabButton} ${activeTab === "text" ? styles.activeTab : ""}`}
              onClick={() => setActiveTab("text")}
            >
              📝 Dịch văn bản (1 Credit)
            </button>
            <button
              className={`${styles.tabButton} ${activeTab === "video" ? styles.activeTab : ""}`}
              onClick={() => setActiveTab("video")}
            >
              🎥 Dịch video & Chèn Sub (10 Credits)
            </button>
          </div>

          {/* Main Board */}
          {activeTab === "text" ? (
            <div className={styles.board}>
              {/* Card Input */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <span className={styles.inputLabel}>Nhập văn bản</span>
                  <select
                    className={styles.langSelect}
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                  >
                    <option value="en">Tiếng Anh (EN)</option>
                    <option value="vi">Tiếng Việt (VI)</option>
                    <option value="zh">Tiếng Trung (ZH)</option>
                    <option value="ja">Tiếng Nhật (JA)</option>
                  </select>
                </div>
                <textarea
                  className={styles.textarea}
                  placeholder="Nhập nội dung cần dịch..."
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button className={styles.tabButton} onClick={handleSwapLanguages} title="Đổi chiều ngôn ngữ">
                    🔄 Đổi chiều
                  </button>
                  <button
                    className={styles.translateButton}
                    onClick={handleTranslate}
                    disabled={isTranslating}
                  >
                    {isTranslating ? "Đang dịch..." : "Dịch thuật (1 Credit)"}
                  </button>
                </div>
              </div>

              {/* Card Output */}
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <span className={styles.inputLabel}>Bản dịch kết quả</span>
                  <select
                    className={styles.langSelect}
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                  >
                    <option value="vi">Tiếng Việt (VI)</option>
                    <option value="en">Tiếng Anh (EN)</option>
                    <option value="zh">Tiếng Trung (ZH)</option>
                    <option value="ja">Tiếng Nhật (JA)</option>
                  </select>
                </div>
                <textarea
                  className={styles.textarea}
                  placeholder="Kết quả hiển thị tại đây..."
                  readOnly
                  value={outputText}
                />
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
                  <select
                    className={styles.langSelect}
                    value={selectedVoiceId}
                    onChange={(e) => handleVoiceChange(e.target.value)}
                    title="Chọn giọng đọc"
                  >
                    {voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.displayName} ({voice.style})
                      </option>
                    ))}
                  </select>
                  <button
                    className={styles.tabButton}
                    onClick={() => handlePreviewVoice(selectedVoiceId)}
                    disabled={previewingVoiceId === selectedVoiceId}
                    title="Nghe thử giọng đọc (miễn phí)"
                  >
                    {previewingVoiceId === selectedVoiceId ? "..." : "🔉 Thử giọng"}
                  </button>
                  <button
                    className={styles.translateButton}
                    onClick={handleListen}
                    disabled={!outputText.trim() || isSpeaking}
                    title="Nghe bản dịch (1 Credit)"
                  >
                    {isSpeaking ? "Đang tạo..." : "🔊 Nghe (1 Credit)"}
                  </button>
                </div>
                {history.length > 0 && (
                  <div className={styles.historySection}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                      <span className={styles.inputLabel}>Lịch sử gần đây</span>
                      <button
                        onClick={clearHistory}
                        style={{ background: "none", border: "none", color: "var(--error)", cursor: "pointer", fontSize: "0.8rem" }}
                      >
                        Xóa tất cả
                      </button>
                    </div>
                    <div className={styles.historyList}>
                      {history.slice(0, 3).map((item) => (
                        <div key={item.id} className={styles.historyItem}>
                          <span className={styles.historyText}>{item.sourceText.substring(0, 60)}...</span>
                          <span className={styles.historyTranslation}>{item.translatedText.substring(0, 60)}...</span>
                          <div className={styles.historyMeta}>
                            <span>{item.sourceLang.toUpperCase()} ➔ {item.targetLang.toUpperCase()}</span>
                            <span>{item.timestamp}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className={styles.videoSection}>
              {/* Cấu hình upload video */}
              <div className={styles.card}>
                <h2 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>Dịch video mới</h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
                  Tải file video lên hoặc dán URL (YouTube, TikTok...) để tự động dịch và ghi phụ đề.
                </p>

                <form onSubmit={handleVideoSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  <div
                    className={styles.dropzone}
                    onClick={() => document.getElementById("fileInput")?.click()}
                  >
                    <div className={styles.uploadIcon}>📁</div>
                    <div>
                      <p style={{ fontWeight: 500 }}>
                        {videoFile ? videoFile.name : "Kéo & thả video hoặc nhấp để tải lên"}
                      </p>
                      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                        Hỗ trợ MP4, MOV, MKV (Tối đa 50MB)
                      </p>
                    </div>
                    <input
                      type="file"
                      id="fileInput"
                      accept="video/*"
                      style={{ display: "none" }}
                      onChange={(e) => setVideoFile(e.target.files?.[0] || null)}
                    />
                  </div>

                  <div className={styles.divider}>HOẶC</div>

                  <div className={styles.inputGroup}>
                    <span className={styles.inputLabel}>Đường dẫn video</span>
                    <input
                      type="text"
                      className={styles.input}
                      placeholder="https://www.youtube.com/watch?v=..."
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                    />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "0.5rem" }}>
                    <div className={styles.inputGroup}>
                      <span className={styles.inputLabel}>Ngôn ngữ dịch sang</span>
                      <select
                        className={styles.langSelect}
                        style={{ width: "100%" }}
                        value={targetLangVideo}
                        onChange={(e) => setTargetLangVideo(e.target.value)}
                      >
                        <option value="vi">Tiếng Việt (VI)</option>
                        <option value="en">Tiếng Anh (EN)</option>
                        <option value="zh">Tiếng Trung (ZH)</option>
                        <option value="ja">Tiếng Nhật (JA)</option>
                      </select>
                    </div>
                    <div className={styles.inputGroup}>
                      <span className={styles.inputLabel}>Đầu ra</span>
                      <select className={styles.langSelect} style={{ width: "100%" }} data-output-mode>
                        <option value="burn">Chèn sub vào Video</option>
                        <option value="srt">Chỉ xuất file .SRT</option>
                      </select>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className={styles.translateButton}
                    style={{ alignSelf: "stretch", marginTop: "1rem" }}
                  >
                    Bắt đầu dịch Video (10 Credits) 🚀
                  </button>
                </form>
              </div>

              {/* Hàng đợi / Tiến trình dịch (Đọc trực tiếp từ Backend DB) */}
              <div className={`${styles.card} ${styles.jobsCard}`}>
                <h2 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>Tiến trình xử lý</h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
                  Theo dõi và tải xuống các file phụ đề/video đã hoàn tất.
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  {jobs.length === 0 ? (
                    <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                      Chưa có tiến trình dịch video nào hoạt động.
                    </div>
                  ) : (
                    jobs.map((job) => (
                      <div key={job.id} className={styles.jobItem}>
                        <div className={styles.jobHeader}>
                          <span className={styles.jobTitle} title={job.fileName}>
                            {job.fileName}
                          </span>
                          <span
                            className={`${styles.badge} ${
                              job.status === "PENDING"
                                ? styles.badgePending
                                : job.status === "PROCESSING"
                                ? styles.badgeProcessing
                                : job.status === "COMPLETED"
                                ? styles.badgeCompleted
                                : styles.badgeFailed
                            }`}
                          >
                            {job.status}
                          </span>
                        </div>

                        <div className={styles.progressBarBg}>
                          <div className={styles.progressBar} style={{ width: `${job.progress}%` }} />
                        </div>

                        <p
                          style={{
                            fontSize: "0.8rem",
                            color: job.status === "FAILED" ? "var(--error)" : "var(--text-secondary)",
                          }}
                        >
                          {job.status === "FAILED" ? job.errorMessage || job.stepDescription : job.stepDescription}
                        </p>

                        <div className={styles.jobDetails}>
                          <span>Mục tiêu: {job.targetLang.toUpperCase()}</span>
                          {job.status === "COMPLETED" ? (
                            <a
                              href={`http://localhost:3001/translation/output/${job.id}/srt`}
                              onClick={(e) => {
                                e.preventDefault();
                                if (!token) return;
                                fetch(`http://localhost:3001/translation/output/${job.id}/srt`, {
                                  headers: { Authorization: `Bearer ${token}` },
                                })
                                  .then((res) => {
                                    if (!res.ok) throw new Error("Download failed");
                                    return res.blob();
                                  })
                                  .then((blob) => {
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url;
                                    a.download = `${job.fileName}.srt`;
                                    a.click();
                                    URL.revokeObjectURL(url);
                                  })
                                  .catch(() => showToast("error", "Chưa có file SRT để tải"));
                              }}
                              style={{ color: "var(--success)", fontWeight: 600 }}
                            >
                              📥 Tải file SRT
                            </a>
                          ) : (
                            <span>Tiến trình: {job.progress}%</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* MFA Settings Card */}
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
                  <button type="submit" className={styles.translateButton} style={{ backgroundColor: "var(--error)", border: "none" }} disabled={isSettingMfa}>
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
                    <div style={{ backgroundColor: "white", padding: "12px", borderRadius: "8px", display: "inline-block", alignSelf: "flex-start" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={mfaSetupData.qrCode} alt="MFA QR Code" style={{ display: "block", width: "180px", height: "180px" }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", flex: 1, minWidth: "300px" }}>
                      <div>
                        <p style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.25rem" }}>Bước 1: Quét mã QR bảo mật</p>
                        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: "1.4" }}>
                          Dùng camera điện thoại hoặc ứng dụng quản lý bảo mật như Google Authenticator / Authy để quét mã QR bên cạnh.
                        </p>
                        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
                          Hoặc copy mã thiết lập thủ công: <code style={{ color: "var(--accent)", padding: "2px 6px", backgroundColor: "rgba(255,255,255,0.05)", borderRadius: "4px", fontSize: "0.9rem", fontWeight: "600" }}>{mfaSetupData.secret}</code>
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
        </>
      )}
    </div>
  );
}
