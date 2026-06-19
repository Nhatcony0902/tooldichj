# t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=t1k-extended | protected=true
"""
Regression tests for resolve_env._parse_env_file_fallback (B2 fix).

Tests that inline # comments are stripped from .env values to match
python-dotenv behaviour and prevent silent API-key corruption.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

# resolve_env SSOT lives at the kit-level .claude/scripts/ (matches runtime
# imports in minimax_api_client.py / gemini_batch_process.py / check_setup.py).
sys.path.insert(
    0,
    str(Path(__file__).parent.parent.parent.parent.parent / 'scripts'),
)

from resolve_env import _parse_env_file_fallback


class TestParseEnvFileFallback:
    """Tests for the pure-Python fallback .env parser."""

    def _write_env(self, content: str) -> Path:
        """Write content to a temp .env file and return its Path."""
        tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.env', delete=False
        )
        tmp.write(content)
        tmp.flush()
        tmp.close()
        return Path(tmp.name)

    def test_plain_value(self):
        """Simple KEY=value with no comment."""
        p = self._write_env('MY_KEY=abc123\n')
        result = _parse_env_file_fallback(p)
        assert result['MY_KEY'] == 'abc123'

    def test_double_quoted_value(self):
        """Double-quoted value is unquoted."""
        p = self._write_env('MY_KEY="abc123"\n')
        result = _parse_env_file_fallback(p)
        assert result['MY_KEY'] == 'abc123'

    def test_single_quoted_value(self):
        """Single-quoted value is unquoted."""
        p = self._write_env("MY_KEY='abc123'\n")
        result = _parse_env_file_fallback(p)
        assert result['MY_KEY'] == 'abc123'

    def test_full_line_comment_skipped(self):
        """Full-line # comments are skipped."""
        p = self._write_env('# this is a comment\nMY_KEY=val\n')
        result = _parse_env_file_fallback(p)
        assert 'this is a comment' not in str(result)
        assert result['MY_KEY'] == 'val'

    # --- B2 regression tests -----------------------------------------------

    def test_inline_comment_stripped(self):
        """B2 fix: inline ' # comment' after value must be stripped."""
        p = self._write_env('GEMINI_API_KEY=AIzaSyXXXXXXXXXX  # my gemini key\n')
        result = _parse_env_file_fallback(p)
        assert result['GEMINI_API_KEY'] == 'AIzaSyXXXXXXXXXX'

    def test_inline_comment_no_leading_space(self):
        """Hash without leading space is NOT treated as a comment (value preserved)."""
        # e.g. a bcrypt hash or URL fragment — should NOT be stripped
        p = self._write_env('MY_HASH=abc#def\n')
        result = _parse_env_file_fallback(p)
        # The value contains '#' with no preceding space — keep it intact
        assert result['MY_HASH'] == 'abc#def'

    def test_inline_comment_trailing_whitespace_removed(self):
        """After comment strip, trailing whitespace is also removed."""
        p = self._write_env('KEY=value   # some note   \n')
        result = _parse_env_file_fallback(p)
        assert result['KEY'] == 'value'

    def test_multiple_keys_with_comments(self):
        """Multiple keys, some with inline comments, some without."""
        content = (
            'KEY1=first_value  # first comment\n'
            'KEY2=second_value\n'
            '# ignored line\n'
            'KEY3=third_value  # third comment\n'
        )
        p = self._write_env(content)
        result = _parse_env_file_fallback(p)
        assert result['KEY1'] == 'first_value'
        assert result['KEY2'] == 'second_value'
        assert result['KEY3'] == 'third_value'

    def test_empty_file(self):
        """Empty file returns empty dict."""
        p = self._write_env('')
        assert _parse_env_file_fallback(p) == {}

    def test_nonexistent_file(self):
        """Non-existent file returns empty dict, does not raise."""
        result = _parse_env_file_fallback('/nonexistent/path/.env')
        assert result == {}
