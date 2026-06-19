# t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=t1k-extended | protected=true
"""Tests for the OpenAI-compatible backend (common/openai_compat.py)."""

import base64
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# common/ holds the module
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "common"))

import openai_compat as oc  # noqa: E402


class _FakeResp(io.BytesIO):
    """Minimal context-manager response that json.load can read."""
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _capture(payload):
    """Patch urllib.request.urlopen, returning `payload` and capturing the request."""
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.headers)
        captured["body"] = json.loads(req.data.decode())
        return _FakeResp(json.dumps(payload).encode())

    return patch("urllib.request.urlopen", side_effect=fake_urlopen), captured


def test_find_openai_base_url(monkeypatch):
    monkeypatch.delenv("GEMINI_OPENAI_BASE_URL", raising=False)
    assert oc.find_openai_base_url() is None
    monkeypatch.setenv("GEMINI_OPENAI_BASE_URL", "https://proxy.example///")
    assert oc.find_openai_base_url() == "https://proxy.example"


def test_supported_tasks():
    assert oc.SUPPORTED_TASKS == {"analyze", "generate"}


def test_is_image(tmp_path):
    assert oc.is_image("x.png") and oc.is_image("y.JPG")
    assert not oc.is_image("a.mp3") and not oc.is_image("b.pdf")


def test_analyze_image_sends_image_url_and_returns_text(tmp_path):
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 8)
    patcher, captured = _capture(
        {"choices": [{"message": {"role": "assistant", "content": "blue"}}]}
    )
    with patcher:
        text = oc.analyze_image("https://p.example", "sk-test", "gpt-5.4-mini", "what color?", str(img))
    assert text == "blue"
    # endpoint, bearer, curl UA (Cloudflare), and an image_url block
    assert captured["url"] == "https://p.example/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk-test"
    assert captured["headers"]["User-agent"] == "curl/8.5.0"
    content = captured["body"]["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "what color?"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_analyze_falls_back_to_reasoning_content(tmp_path):
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG")
    patcher, _ = _capture(
        {"choices": [{"message": {"content": "", "reasoning_content": "it is red"}}]}
    )
    with patcher:
        assert oc.analyze_image("https://p.example", "k", "kimi-k2.6", "?", str(img)) == "it is red"


def test_generate_image_decodes_data_url():
    raw = b"\x89PNG-bytes"
    data_url = "data:image/png;base64," + base64.b64encode(raw).decode()
    patcher, captured = _capture(
        {"choices": [{"message": {"content": None, "images": [{"image_url": {"url": data_url}}]}}]}
    )
    with patcher:
        img_bytes, ext, text = oc.generate_image("https://p.example", "k", "img-model", "a red circle")
    assert img_bytes == raw
    assert ext == "png"
    assert text is None
    assert captured["body"]["messages"][0]["content"] == "a red circle"


def test_generate_image_raises_when_no_image():
    patcher, _ = _capture({"choices": [{"message": {"content": "no image here", "images": []}}]})
    with patcher:
        with pytest.raises(RuntimeError, match="No image returned"):
            oc.generate_image("https://p.example", "k", "m", "draw")
