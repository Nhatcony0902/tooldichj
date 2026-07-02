"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "@/app/page.module.css";
import { SubtitleSegment, User, VideoJob } from "../types";

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
}

export default function VideoTranslationSection({
  token,
  user,
  refreshUser,
  showToast,
}: VideoTranslationSectionProps) {
  // Video Translation States
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [targetLangVideo, setTargetLangVideo] = useState("vi");
  const [outputModeVideo, setOutputModeVideo] = useState("burn");
  const [removeSourceSubsVideo, setRemoveSourceSubsVideo] = useState(false);
  const [jobs, setJobs] = useState<VideoJob[]>([]);

  // Subtitle review states
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [reviewSegments, setReviewSegments] = useState<SubtitleSegment[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch danh sách các Video Jobs từ Backend
  const fetchJobs = useCallback(async (authToken: string) => {
    try {
      const response = await fetch("http://localhost:3001/translation/video-jobs", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) return;
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
      (job) => job.status === "PENDING" || job.status === "PROCESSING" || job.status === "AWAITING_REVIEW"
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
      formData.append("removeSourceSubs", String(removeSourceSubsVideo));

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

  const handleCancelJob = async (jobId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`http://localhost:3001/translation/video-jobs/${jobId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        await fetchJobs(token);
        showToast("success", "Đã huỷ job xử lý video.");
      } else {
        const data = await res.json().catch(() => ({}));
        showToast("error", data.message || "Không thể huỷ job này.");
      }
    } catch {
      showToast("error", "Lỗi kết nối khi huỷ job.");
    }
  };

  const openReview = async (jobId: string) => {
    if (!token) return;
    setReviewLoading(true);
    setReviewJobId(jobId);
    try {
      const res = await fetch(`http://localhost:3001/translation/video-jobs/${jobId}/segments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setReviewSegments(data.segments);
      } else {
        showToast("error", data.message || "Không tải được phụ đề.");
        setReviewJobId(null);
      }
    } catch {
      showToast("error", "Lỗi kết nối khi tải phụ đề.");
      setReviewJobId(null);
    } finally {
      setReviewLoading(false);
    }
  };

  const editSegment = (index: number, value: string) =>
    setReviewSegments((prev) => prev.map((s) => (s.index === index ? { ...s, translatedText: value } : s)));

  const saveDraft = async () => {
    if (!token || !reviewJobId) return;
    setReviewSaving(true);
    try {
      const res = await fetch(`http://localhost:3001/translation/video-jobs/${reviewJobId}/segments`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: reviewSegments.map((s) => ({ index: s.index, translatedText: s.translatedText })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast("success", "Đã lưu bản chỉnh sửa.");
      } else {
        showToast("error", data.message || "Không lưu được. Kiểm tra các dòng trống.");
      }
    } catch {
      showToast("error", "Lỗi kết nối khi lưu.");
    } finally {
      setReviewSaving(false);
    }
  };

  const confirmReview = async () => {
    if (!token || !reviewJobId) return;
    // save first so the burn uses the latest edits, then confirm
    await saveDraft();
    try {
      const res = await fetch(`http://localhost:3001/translation/video-jobs/${reviewJobId}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast("success", "Đã xác nhận — đang tạo video.");
        setReviewJobId(null);
        setReviewSegments([]);
        await fetchJobs(token);
      } else {
        showToast("error", data.message || "Không xác nhận được.");
      }
    } catch {
      showToast("error", "Lỗi kết nối khi xác nhận.");
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!token) return;
    if (!confirm("Xoá job này? Thao tác không thể hoàn tác.")) return;
    try {
      const res = await fetch(`http://localhost:3001/translation/video-jobs/${jobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        showToast("success", "Đã xoá job.");
      } else {
        const data = await res.json().catch(() => ({}));
        showToast("error", data.message || "Không thể xoá job này.");
      }
    } catch {
      showToast("error", "Lỗi kết nối khi xoá job.");
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

  // Định dạng giây -> mm:ss cho bảng review (chỉ hiển thị, không chỉnh sửa)
  const formatSegmentTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
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
              </select>
            </div>
          </div>

          <div className={styles.inputGroup}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={removeSourceSubsVideo}
                onChange={(e) => setRemoveSourceSubsVideo(e.target.checked)}
              />
              <span>Làm mờ phụ đề cứng có sẵn trong video</span>
            </label>
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
                      {
                        PENDING: styles.badgePending,
                        PROCESSING: styles.badgeProcessing,
                        AWAITING_REVIEW: styles.badgeReview,
                        COMPLETED: styles.badgeCompleted,
                        FAILED: styles.badgeFailed,
                        CANCELLED: styles.badgeCancelled,
                      }[job.status] ?? styles.badgeFailed
                    }`}
                  >
                    {
                      {
                        PENDING: "Đang chờ",
                        PROCESSING: "Đang xử lý",
                        AWAITING_REVIEW: "Chờ duyệt",
                        COMPLETED: "Hoàn tất",
                        FAILED: "Thất bại",
                        CANCELLED: "Đã huỷ",
                      }[job.status] ?? job.status
                    }
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
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
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
                      <button
                        className={styles.jobDeleteBtn}
                        onClick={() => handleDeleteJob(job.id)}
                      >
                        Xoá
                      </button>
                    </div>
                  ) : job.status === "AWAITING_REVIEW" ? (
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <button className={styles.jobReviewBtn} onClick={() => openReview(job.id)}>
                        Kiểm tra & sửa phụ đề
                      </button>
                      <button
                        className={styles.jobCancelBtn}
                        onClick={() => handleCancelJob(job.id)}
                      >
                        Huỷ
                      </button>
                    </div>
                  ) : job.status === "PENDING" || job.status === "PROCESSING" ? (
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span>Tiến trình: {job.progress}%</span>
                      <button
                        className={styles.jobCancelBtn}
                        onClick={() => handleCancelJob(job.id)}
                      >
                        Huỷ
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span>{job.status === "CANCELLED" ? "Đã huỷ" : "Thất bại"}</span>
                      <button
                        className={styles.jobDeleteBtn}
                        onClick={() => handleDeleteJob(job.id)}
                      >
                        Xoá
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Panel duyệt & sửa phụ đề trước khi ghi hình */}
      {reviewJobId && (
        <div className={styles.reviewOverlay}>
          <div className={styles.reviewPanel}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: "600", marginBottom: "0.25rem" }}>
              Kiểm tra & sửa phụ đề
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "1rem" }}>
              Chỉnh sửa bản dịch trước khi tạo video. Thời gian & bản gốc chỉ để tham khảo.
            </p>

            {reviewLoading ? (
              <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                Đang tải phụ đề...
              </div>
            ) : (
              <div className={styles.reviewTable}>
                {reviewSegments.map((segment) => (
                  <div key={segment.index} className={styles.reviewRow}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      <span>#{segment.index + 1}</span>
                      <span>
                        {formatSegmentTime(segment.start)} → {formatSegmentTime(segment.end)}
                      </span>
                    </div>
                    <p className={styles.reviewOriginal}>{segment.text}</p>
                    <textarea
                      className={styles.reviewInput}
                      value={segment.translatedText}
                      onChange={(e) => editSegment(segment.index, e.target.value)}
                      rows={2}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className={styles.reviewActions}>
              <button
                className={styles.jobDeleteBtn}
                onClick={() => {
                  setReviewJobId(null);
                  setReviewSegments([]);
                }}
              >
                Đóng
              </button>
              <button
                className={styles.jobCancelBtn}
                onClick={saveDraft}
                disabled={reviewSaving || reviewLoading}
              >
                Lưu nháp
              </button>
              <button
                className={styles.translateButton}
                onClick={confirmReview}
                disabled={reviewSaving || reviewLoading}
              >
                Xác nhận & tạo video
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
