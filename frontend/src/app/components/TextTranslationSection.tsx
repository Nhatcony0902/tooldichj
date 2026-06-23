"use client";

import { useState, useEffect, useCallback } from "react";
import styles from "@/app/page.module.css";
import VoiceSelector, { type Voice } from "./VoiceSelector";
import { User, TranslationHistory } from "../types";

interface TextTranslationSectionProps {
  token: string;
  user: User | null;
  refreshUser: (token: string) => Promise<void>;
  showToast: (
    type: "success" | "error",
    message: string,
    action?: { label: string; onClick: () => void },
  ) => void;
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

  // Fetch lịch sử dịch từ Backend
  const fetchHistory = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/translation/history", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json();
      if (data.success) {
        // Backend rows carry `createdAt` (ISO string); map it to the
        // existing `timestamp` display field so the interface shape stays
        // unchanged for the rest of the component.
        const mapped: TranslationHistory[] = data.history.map(
          (row: TranslationHistory & { createdAt: string }) => ({
            id: row.id,
            sourceText: row.sourceText,
            translatedText: row.translatedText,
            sourceLang: row.sourceLang,
            targetLang: row.targetLang,
            timestamp: new Date(row.createdAt).toLocaleTimeString(),
          }),
        );
        setHistory(mapped);
      }
    } catch (err) {
      console.error("Error fetching translation history:", err);
    }
  }, []);

  // Load history on mount
  useEffect(() => {
    if (token) {
      fetchHistory(token);
    }
  }, [token, fetchHistory]);

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
        if (data.code === "INSUFFICIENT_CREDITS") {
          showToast("error", data.error || "Không thể tạo giọng đọc", {
            label: "Nạp thêm →",
            onClick: () => document.getElementById("billing-section")?.scrollIntoView({ behavior: "smooth" }),
          });
        } else {
          showToast("error", data.error || "Không thể tạo giọng đọc");
        }
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

        // Backend đã ghi lịch sử dịch như một side-effect của lần dịch này —
        // chỉ cần tải lại danh sách từ server.
        fetchHistory(token);
      } else {
        setOutputText(`[Lỗi]: ${data.error || "Không thể dịch thuật"}`);
        setDetectedLang(null);
        if (data.code === "INSUFFICIENT_CREDITS") {
          showToast("error", data.error, {
            label: "Nạp thêm →",
            onClick: () =>
              document.getElementById("billing-section")?.scrollIntoView({ behavior: "smooth" }),
          });
        }
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

  const clearHistory = async () => {
    if (!token) return;
    try {
      await fetch("http://localhost:3001/translation/history", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      setHistory([]);
    } catch (err) {
      console.error("Error clearing translation history:", err);
    }
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
