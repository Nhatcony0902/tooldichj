# t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=t1k-extended | protected=true
"""OpenAI-compatible backend for the multimodal skill.

When GEMINI_OPENAI_BASE_URL is set, vision (analyze) and image generation route
through `${base}/v1/chat/completions` instead of the native google-genai SDK.
This lets the skill use any OpenAI-compatible gateway:

  - a LiteLLM proxy (vision + image generation), or
  - TheOneKit model-router CCS endpoint (vision only; gh-token auth).

GEMINI_API_KEY is reused as the bearer token. Only `analyze` and `generate`
are supported over this path — audio/video/transcribe stay on native Gemini.

No third-party deps: uses urllib. A curl-like User-Agent is mandatory because
Cloudflare-fronted gateways (e.g. CCS) reject the default urllib UA (error 1010).
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Cloudflare WAF on some gateways (CCS) bans the default "Python-urllib/x" UA.
_USER_AGENT = "curl/8.5.0"

SUPPORTED_TASKS = {"analyze", "generate"}


def find_openai_base_url() -> Optional[str]:
    """Return GEMINI_OPENAI_BASE_URL (trailing slashes stripped) or None."""
    url = os.getenv("GEMINI_OPENAI_BASE_URL")
    return url.rstrip("/") if url else None


def _post_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: List[Dict[str, Any]],
    max_tokens: Optional[int] = None,
    timeout: int = 180,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {"model": model, "messages": messages}
    if max_tokens:
        body["max_tokens"] = max_tokens
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _image_data_url(image_path: str) -> str:
    mime = mimetypes.guess_type(str(image_path))[0] or "image/png"
    data = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def is_image(file_path: str) -> bool:
    mime = mimetypes.guess_type(str(file_path))[0] or ""
    return mime.startswith("image/")


def analyze_image(
    base_url: str, api_key: str, model: str, prompt: str, image_path: str, max_tokens: int = 2048
) -> str:
    """Vision: send an image + prompt, return the text answer."""
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": _image_data_url(image_path)}},
            ],
        }
    ]
    data = _post_chat(base_url, api_key, model, messages, max_tokens=max_tokens)
    message = (data.get("choices") or [{}])[0].get("message", {}) or {}
    # Some reasoning models (kimi-*) put partial text in reasoning_content.
    text = message.get("content") or message.get("reasoning_content") or ""
    return text.strip()


def generate_image(
    base_url: str, api_key: str, model: str, prompt: str, timeout: int = 180
) -> Tuple[bytes, str, Optional[str]]:
    """Image generation: returns (image_bytes, extension, optional_text)."""
    messages = [{"role": "user", "content": prompt}]
    data = _post_chat(base_url, api_key, model, messages, timeout=timeout)
    message = (data.get("choices") or [{}])[0].get("message", {}) or {}
    for img in message.get("images") or []:
        url = (img.get("image_url") or {}).get("url", "")
        if url.startswith("data:") and "," in url:
            header, b64 = url.split(",", 1)
            mime = header[5:].split(";")[0] or "image/png"
            ext = mime.split("/")[-1] or "png"
            text = message.get("content") if isinstance(message.get("content"), str) else None
            return base64.b64decode(b64), ext, text
    raise RuntimeError(
        "No image returned by the OpenAI-compatible endpoint (message.images empty). "
        "This backend may not support image generation — model-router has no image route."
    )
