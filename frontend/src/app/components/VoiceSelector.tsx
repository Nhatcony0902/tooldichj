import styles from "../page.module.css";

export interface Voice {
  id: string;
  displayName: string;
  style: string;
  sampleUrl: string;
}

interface VoiceSelectorProps {
  voices: Voice[];
  selectedVoiceId: string;
  onChange: (voiceId: string) => void;
  onPreview: (voiceId: string) => void;
  previewingVoiceId: string | null;
}

export default function VoiceSelector({
  voices,
  selectedVoiceId,
  onChange,
  onPreview,
  previewingVoiceId,
}: VoiceSelectorProps) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <select
        className={styles.langSelect}
        value={selectedVoiceId}
        onChange={(e) => onChange(e.target.value)}
        title="Chọn giọng đọc"
      >
        {voices.map((voice) => (
          <option key={voice.id} value={voice.id}>
            {voice.displayName} ({voice.style})
          </option>
        ))}
      </select>
      <button
        type="button"
        className={styles.tabButton}
        onClick={() => onPreview(selectedVoiceId)}
        disabled={previewingVoiceId === selectedVoiceId}
        title="Nghe thử giọng đọc (miễn phí)"
      >
        {previewingVoiceId === selectedVoiceId ? "..." : "🔉 Thử giọng"}
      </button>
    </div>
  );
}
