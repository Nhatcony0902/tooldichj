---
name: t1k:extended-multimodal
description: >
  Analyze images/audio/video with Gemini API. Generate images (Nano Banana, MiniMax),
  videos (Veo 3, Hailuo), speech (MiniMax TTS), music (MiniMax). Use for vision analysis,
  transcription, OCR, design extraction, multimodal AI tasks.
license: MIT
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
argument-hint: "[file-path] [prompt]"
version: 2.15.1
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# AI Multimodal

Process audio, images, videos, documents using Gemini. Generate images, videos, speech, music via Gemini + MiniMax.

## Setup

```bash
# 1. Install Python dependencies
pip install -r .claude/skills/t1k-extended-multimodal/scripts/requirements.txt

# 2. Set required API key
export GEMINI_API_KEY="your-key"   # https://aistudio.google.com/apikey

# 3. Set optional MiniMax key (for image/video/speech/music generation)
export MINIMAX_API_KEY="your-key"  # https://platform.minimax.io/user-center/basic-information/interface-key

# 4. (Optional) Install human-mcp for in-loop interactive use
claude mcp add human-mcp -- npx -y github:The1Studio/human-mcp#v2.15.1
```

### Optional — OpenAI-compatible backend (LiteLLM proxy / model-router)

Set `GEMINI_OPENAI_BASE_URL` to route `analyze` (vision) and `generate` (image)
through an OpenAI-compatible gateway instead of the native Gemini API.
`GEMINI_API_KEY` is reused as the bearer token. Only `analyze`+`generate` are
supported this way — audio/video/transcribe stay on native Gemini.

```bash
# LiteLLM proxy — vision + image generation
export GEMINI_OPENAI_BASE_URL="https://litellm.athena.tools"
export GEMINI_API_KEY="sk-..."                       # proxy key
python scripts/gemini_batch_process.py --task generate --prompt "a green square" \
  --model gemini-3.1-flash-image-preview --output out.png
python scripts/gemini_batch_process.py --files out.png --task analyze \
  --prompt "what color?" --model gemini-3.1-pro-preview

# TheOneKit model-router (CCS) — vision ONLY (no image-gen route)
export GEMINI_OPENAI_BASE_URL="https://ccs.the1studio.org/api/provider/kimi"
export GEMINI_API_KEY="$(gh auth token)"             # The1Studio org membership
python scripts/gemini_batch_process.py --files img.png --task analyze \
  --prompt "describe this" --model gpt-5.4-mini      # or kimi-k2.6
```

## Quick Start

**Verify setup**: `python scripts/check_setup.py`
**Analyze media**: `python scripts/gemini_batch_process.py --files <file> --task <analyze|transcribe|extract> --help`
**Generate (Gemini)**: `python scripts/gemini_batch_process.py --task <generate|generate-video> --prompt "desc"`
**Generate (MiniMax)**: `python scripts/minimax_cli.py --task <generate|generate-video|generate-speech|generate-music> --prompt "desc" --help`

## Models

| Provider | Type | Model | Notes |
|---|---|---|---|
| Gemini | Image gen | `gemini-3.1-flash-image-preview` | Nano Banana 2 — DEFAULT |
| Gemini | Image gen | `gemini-3-pro-image-preview` | Nano Banana Pro — production / 4K text |
| Gemini | Video gen | `veo-3.1-generate-preview` | 8s clips with audio |
| Gemini | Analysis | `gemini-2.5-flash` | Recommended |
| MiniMax | Image gen | `image-01` | $0.03/image |
| MiniMax | Video gen | `MiniMax-Hailuo-2.3` | 1080p |
| MiniMax | Speech/TTS | `speech-2.8-hd` | 300+ voices, 40+ languages |
| MiniMax | Music | `music-2.5` | 4-min songs with lyrics |

## Scripts

- **`gemini_batch_process.py`**: Gemini CLI — transcribe, analyze, extract, generate, generate-video
- **`minimax_cli.py`**: MiniMax CLI — generate, generate-video, generate-speech, generate-music
- **`minimax_generate.py`**: MiniMax generation library for programmatic use
- **`minimax_api_client.py`**: MiniMax HTTP client, auth, async polling, file download
- **`media_optimizer.py`**: ffmpeg/Pillow preflight — compress/resize/convert media before API calls
- **`document_converter.py`**: Gemini-powered PDF/image/Office to markdown converter
- **`check_setup.py`**: Setup checker for API keys and dependencies

## References

| Topic | File |
|---|---|
| Vision/OCR/Images | `references/vision-understanding.md` |
| Image Generation | `references/image-generation.md` |
| Video Analysis | `references/video-analysis.md` |
| Video Generation | `references/video-generation.md` |
| Audio/TTS | `references/audio-processing.md` |
| Music Generation | `references/music-generation.md` |
| MiniMax API | `references/minimax-generation.md` |

## Limits

**Formats**: Audio (WAV/MP3/AAC, 9.5h), Images (PNG/JPEG/WEBP, 3.6k), Video (MP4/MOV, 6h), PDF (1k pages)
**Size**: 20MB inline, 2GB File API
**Transcription**: Audio/video >15 min must be chunked (15 min max per chunk) to avoid truncation.
**Transcription format**: `[HH:MM:SS -> HH:MM:SS] content` per segment, with metadata header.

## Outputs

Save outputs to `plans/multimodal-outputs/<YYYYMMDD>/`.
