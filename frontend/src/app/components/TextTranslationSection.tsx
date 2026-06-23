"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "@/app/page.module.css";
import VoiceSelector, { type Voice } from "./VoiceSelector";
import { User, TranslationHistory } from "../types";

interface TextTranslationSectionProps {
  token: string;
  user: User | null;
  refreshUser: (token: string) => Promise<void>;
  showToast: (type: "success" | "error", message: string) => void;
  voices: Voice[];
  onPreviewVoice: (voiceId: string) => Promise<void>;
  previewingVoiceId: string | null;
}

// Mirrors backend translation.service.ts's CHUNK_SIZE / MAX_TEXT_LENGTH —
// kept as duplicated literals (no shared-constants file for two numbers).
const CHUNK_SIZE = 6000;
const MAX_TEXT_LENGTH = 20000;

// Mirrors backend translation.service.ts's SUPPORTED_LANG_CODES allowlist —
// used to render a human-readable label for the auto-detected language.
const LANG_NAMES: Record<string, string> = {
  en: "Tiếng Anh",
  vi: "Tiếng Việt",
  zh: "Tiếng Trung",
  ja: "Tiếng Nhật",
};

export default function TextTranslationSection({
  token,
  user,
  refreshUser,
  showToast,
  voices,
  onPreviewVoice,
  previewingVoiceId,
}: TextTranslationSectionProps) {
  // Text Translation States
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("vi");
  const [isTranslating, setIsTranslating] = useState(false);
  const [history, setHistory] = useState<TranslationHistory[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("Kore");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);

  // Initialize selected voice from user preferences
  useEffect(() => {
    if (user?.preferredVoiceId) {
      setSelectedVoiceId(user.preferredVoiceId);
    }
  }, [user]);

  // Load history on mount
  useEffect(() => {
    const savedHistory = localStorage.getItem("tooldichj_history");
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (err) {
        console.error("Error parsing translation history:", err);
      }
    }
  }, []);

  // Phát một blob audio
  const playAudioBlob = async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  };

  // Nghe bản dịch văn bản bằng giọng đã chọn
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
      refreshUser(token);
    } catch {
      showToast("error", "Lỗi kết nối server khi tạo giọng đọc!");
    } finally {
      setIsSpeaking(false);
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

  // Gọi dịch văn bản
  const handleTranslate = async () => {
    if (!inputText.trim() || !token) return;
    if (inputText.length > MAX_TEXT_LENGTH) return;
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
        setDetectedLang(sourceLang === "auto" ? data.detectedLang ?? null : null);

        // Cập nhật lại số dư credits hiển thị
        refreshUser(token);

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
        setDetectedLang(null);
      }
    } catch {
      setOutputText("[Lỗi kết nối]: Vui lòng kiểm tra lại Server Backend!");
      setDetectedLang(null);
    } finally {
      setIsTranslating(false);
    }
  };

  const isTextTooLong = inputText.length > MAX_TEXT_LENGTH;
  const estimatedChunks = Math.max(1, Math.ceil(inputText.length / CHUNK_SIZE));

  const handleSwapLanguages = () => {
    // Auto-detect has no symmetric "auto-detect target" concept, so when
    // source is "auto" the language fields are left untouched — only the
    // text content swaps.
    if (sourceLang !== "auto") {
      setSourceLang(targetLang);
      setTargetLang(sourceLang);
    }
    setInputText(outputText);
    setOutputText(inputText);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem("tooldichj_history");
  };

  return (
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
            <option value="auto">🌐 Tự động nhận diện</option>
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
        {isTextTooLong ? (
          <div style={{ fontSize: "0.8rem", color: "var(--error)", marginBottom: "0.5rem" }}>
            Văn bản vượt quá giới hạn {MAX_TEXT_LENGTH} ký tự (hiện tại: {inputText.length})
          </div>
        ) : (
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
            {inputText.length} / {MAX_TEXT_LENGTH} ký tự
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button className={styles.tabButton} onClick={handleSwapLanguages} title="Đổi chiều ngôn ngữ">
            🔄 Đổi chiều
          </button>
          <button
            className={styles.translateButton}
            onClick={handleTranslate}
            disabled={isTranslating || isTextTooLong}
          >
            {isTranslating
              ? "Đang dịch..."
              : `Dịch thuật (${estimatedChunks} Credit${estimatedChunks > 1 ? "s" : ""})`}
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
        {sourceLang === "auto" && detectedLang && (
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
            Đã nhận diện: {LANG_NAMES[detectedLang] || detectedLang}
          </div>
        )}
        <textarea
          className={styles.textarea}
          placeholder="Kết quả hiển thị tại đây..."
          readOnly
          value={outputText}
        />
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
          <VoiceSelector
            voices={voices}
            selectedVoiceId={selectedVoiceId}
            onChange={handleVoiceChange}
            onPreview={onPreviewVoice}
            previewingVoiceId={previewingVoiceId}
          />
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
  );
}
