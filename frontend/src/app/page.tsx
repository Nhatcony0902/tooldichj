"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import Header from "./components/Header";
import Toast from "./components/Toast";
import AuthCard from "./components/AuthCard";
import TextTranslationSection from "./components/TextTranslationSection";
import VideoTranslationSection from "./components/VideoTranslationSection";
import MfaSettingsSection from "./components/MfaSettingsSection";
import { useAuth } from "./hooks/useAuth";
import { Voice } from "./types";

export default function Home() {
  const {
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
    mfaRequired,
    setMfaRequired,
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
  } = useAuth();

  // Tab State
  const [activeTab, setActiveTab] = useState<"text" | "video">("text");

  // TTS Voice States
  const [voices, setVoices] = useState<Voice[]>([]);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  // Fetch danh mục giọng đọc TTS
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

  // Fetch voices khi token sẵn sàng
  useEffect(() => {
    if (token) {
      fetchVoices(token);
    }
  }, [token, fetchVoices]);

  // Phát một blob audio
  const playAudioBlob = async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
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
      <Toast type={toast.type} message={toast.message} />

      {/* Header */}
      <Header isLoggedIn={isLoggedIn} user={user} onLogout={handleLogout} />

      {/* GIAO DIỆN AUTH (LOGIN / REGISTER) */}
      {!isLoggedIn ? (
        <AuthCard
          authMode={authMode}
          setAuthMode={setAuthMode}
          authEmail={authEmail}
          setAuthEmail={setAuthEmail}
          authPassword={authPassword}
          setAuthPassword={setAuthPassword}
          authName={authName}
          setAuthName={setAuthName}
          authPhone={authPhone}
          setAuthPhone={setAuthPhone}
          authConfirmPassword={authConfirmPassword}
          setAuthConfirmPassword={setAuthConfirmPassword}
          authError={authError}
          setAuthError={setAuthError}
          verifyRequired={verifyRequired}
          setVerifyRequired={setVerifyRequired}
          pendingVerifyEmail={pendingVerifyEmail}
          setPendingVerifyEmail={setPendingVerifyEmail}
          verifyOtp={verifyOtp}
          setVerifyOtp={setVerifyOtp}
          resendCooldown={resendCooldown}
          mfaRequired={mfaRequired}
          setMfaRequired={setMfaRequired}
          mfaCode={mfaCode}
          setMfaCode={setMfaCode}
          handleVerifyEmailSubmit={handleVerifyEmailSubmit}
          handleResendOtp={handleResendOtp}
          handleAuthSubmit={(e) => handleAuthSubmit(e)}
          handleMfaLoginSubmit={(e) => handleMfaLoginSubmit(e)}
        />
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
            <TextTranslationSection
              token={token!}
              user={user}
              refreshUser={fetchUserMe}
              showToast={showToast}
              voices={voices}
              onPreviewVoice={handlePreviewVoice}
              previewingVoiceId={previewingVoiceId}
            />
          ) : (
            <VideoTranslationSection
              token={token!}
              user={user}
              refreshUser={fetchUserMe}
              showToast={showToast}
              voices={voices}
              onPreviewVoice={handlePreviewVoice}
              previewingVoiceId={previewingVoiceId}
            />
          )}

          {/* MFA Settings Card */}
          <MfaSettingsSection
            user={user}
            mfaSetupData={mfaSetupData}
            setMfaSetupData={setMfaSetupData}
            mfaSetupCode={mfaSetupCode}
            setMfaSetupCode={setMfaSetupCode}
            isSettingMfa={isSettingMfa}
            handleMfaSetupInit={handleMfaSetupInit}
            handleMfaSetupVerify={handleMfaSetupVerify}
            handleMfaDisable={handleMfaDisable}
          />
        </>
      )}
    </div>
  );
}
