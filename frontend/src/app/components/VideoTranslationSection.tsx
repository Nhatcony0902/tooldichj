"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "@/app/page.module.css";
import VoiceSelector, { type Voice } from "./VoiceSelector";
import { User, VideoJob } from "../types";

// Mirrors backend's MAX_UPLOAD_MB (translation.controller.ts) — the backend
// value is authoritative since multer enforces it. NEXT_PUBLIC_* is inlined
// at build time, so this must be rebuilt if the backend value changes.
const MAX_UPLOAD_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 100;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

interface VideoTranslationSectionProps {
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

export default function VideoTranslationSection({
  token,
  user,
  refreshUser,
  showToast,
  voices,
  onPreviewVoice,
  previewingVoiceId,
}: VideoTranslationSectionProps) {
  // Video Translation States
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [targetLangVideo, setTargetLangVideo] = useState("vi");
  const [outputModeVideo, setOutputModeVideo] = useState("burn");
  const [dubVoiceIdVideo, setDubVoiceIdVideo] = useState("Kore");
  const [jobs, setJobs] = useState<VideoJob[]>([]);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

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

  // Fetch jobs on mount
  useEffect(() => {
    if (token) {
      fetchJobs(token);
    }
  }, [token, fetchJobs]);

  // Polling để cập nhật tiến độ video job
  useEffect(() => {
    const hasActiveJobs = jobs.some(
      (job) => job.status === "PENDING" || job.status === "PROCESSING"
    );

    if (token && hasActiveJobs) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(() => {
          fetchJobs(token);
          refreshUser(token); // Cập nhật cả credits khi job xong
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
  }, [jobs, token, fetchJobs, refreshUser]);

  // Tạo Video Job dịch thuật
  const handleVideoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    if (!videoFile) {
      showToast("error", "Vui lòng tải lên file video!");
      return;
    }

    if (videoFile.size > MAX_UPLOAD_BYTES) {
      showToast("error", `File quá lớn. Tối đa ${MAX_UPLOAD_MB}MB.`);
      return;
    }

    try {
      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("targetLang", targetLangVideo);
      formData.append("outputMode", outputModeVideo);
      if (outputModeVideo === "dub" || outputModeVideo === "burn+dub") {
        formData.append("dubVoiceId", dubVoiceIdVideo);
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
        refreshUser(token);
        showToast("success", "Đã thêm video vào hàng đợi dịch thuật!");
      } else if (data.code === "INSUFFICIENT_CREDITS") {
        showToast("error", data.error || "Lỗi tạo video job", {
          label: "Nạp thêm →",
          onClick: () =>
            document.getElementById("billing-section")?.scrollIntoView({ behavior: "smooth" }),
        });
      } else {
        showToast("error", data.error || "Lỗi tạo video job");
      }
    } catch {
      showToast("error", "Lỗi kết nối server khi tạo video job!");
    }
  };

  // Tải xuống một output đã hoàn tất của video job
  const handleDownloadOutput = (jobId: string, kind: "srt" | "video" | "audio", filename: string) => {
    if (!token) return;
    fetch(`http://localhost:3001/translation/output/${jobId}/${kind}`, {
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
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => showToast("error", "Chưa có file để tải"));
  };

  return (
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
                Hỗ trợ MP4, MOV, MKV (Tối đa {MAX_UPLOAD_MB}MB)
              </p>
            </div>
            <input
              type="file"
              id="fileInput"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                if (file && file.size > MAX_UPLOAD_BYTES) {
                  showToast(
                    "error",
                    `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Tối đa ${MAX_UPLOAD_MB}MB.`
                  );
                  e.target.value = "";
                  setVideoFile(null);
                  return;
                }
                setVideoFile(file);
              }}
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
              <select
                className={styles.langSelect}
                style={{ width: "100%" }}
                value={outputModeVideo}
                onChange={(e) => setOutputModeVideo(e.target.value)}
              >
                <option value="burn">Chèn sub vào Video</option>
                <option value="srt">Chỉ xuất file .SRT</option>
                <option value="dub">Lồng tiếng AI (TTS)</option>
                <option value="burn+dub">Chèn sub + Lồng tiếng AI</option>
              </select>
            </div>
          </div>

          {(outputModeVideo === "dub" || outputModeVideo === "burn+dub") && (
            <div className={styles.inputGroup}>
              <span className={styles.inputLabel}>Giọng lồng tiếng</span>
              <VoiceSelector
                voices={voices}
                selectedVoiceId={dubVoiceIdVideo}
                onChange={setDubVoiceIdVideo}
                onPreview={onPreviewVoice}
                previewingVoiceId={previewingVoiceId}
              />
            </div>
          )}

          <button
            type="submit"
            className={styles.translateButton}
            style={{ alignSelf: "stretch", marginTop: "1rem" }}
          >
            Bắt đầu dịch Video (10 Credits) 🚀
          </button>
        </form>
      </div>

      {/* Hàng đợi / Tiến trình dịch */}
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
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                      {job.subtitlesUrl && (
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            handleDownloadOutput(job.id, "srt", `${job.fileName}.srt`);
                          }}
                          style={{ color: "var(--success)", fontWeight: 600 }}
                        >
                          📥 Tải file SRT
                        </a>
                      )}
                      {job.outputVideoUrl && (
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            handleDownloadOutput(job.id, "video", `translated_${job.fileName}`);
                          }}
                          style={{ color: "var(--success)", fontWeight: 600 }}
                        >
                          🎬 Tải Video
                        </a>
                      )}
                      {job.outputAudioUrl && (
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            handleDownloadOutput(job.id, "audio", `audio_${job.fileName}.mp3`);
                          }}
                          style={{ color: "var(--success)", fontWeight: 600 }}
                        >
                          🔊 Tải Audio lồng tiếng
                        </a>
                      )}
                    </div>
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
  );
}
