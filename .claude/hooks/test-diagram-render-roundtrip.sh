#!/usr/bin/env bash
# t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
#
# test-diagram-render-roundtrip.sh — CI gate: diagram render roundtrip test (T10).
#
# Intended destination: theonekit-release-action/scripts/
# Placed under .claude/hooks/ for development testing.
#
# Purpose:
#   Validates that installed diagram tools can render a simple fixture graph.
#   Skips gracefully (exit 77, automake convention) when tools are not installed.
#
# Tests:
#   1. Mermaid CLI (mmdc): render 3-node flowchart to SVG
#   2. D2 (d2): render 3-node diagram to SVG (when installed)
#
# Exit codes:
#   0  — all available tools passed
#   1  — at least one available tool failed
#   77 — no diagram tools found (skip — not a failure)
#
# Usage:
#   bash test-diagram-render-roundtrip.sh [--warn-only]
#
set -euo pipefail

SCRIPT_NAME="test-diagram-render-roundtrip"
WARN_ONLY=0
TOOLS_FOUND=0
TOOLS_FAILED=0

for arg in "$@"; do
  if [ "$arg" = "--warn-only" ]; then WARN_ONLY=1; fi
done

# Create temp dir (cross-platform: avoids hardcoded /tmp)
TMPDIR_BASE="${TMPDIR:-$(dirname "$(mktemp -u)")}"
WORK_DIR="${TMPDIR_BASE}/t1k-roundtrip-$$"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

log_pass() { echo "[$SCRIPT_NAME] PASS: $*"; }
log_fail() { echo "[$SCRIPT_NAME] FAIL: $*" >&2; }
log_skip() { echo "[$SCRIPT_NAME] SKIP: $*"; }
log_warn() { echo "[$SCRIPT_NAME] WARN: $*" >&2; }

# ── Mermaid CLI roundtrip ──────────────────────────────────────────────────

test_mermaid() {
  if ! command -v mmdc >/dev/null 2>&1; then
    log_skip "mmdc not found on PATH — install mermaid-cli to enable this test"
    return 77
  fi

  TOOLS_FOUND=$((TOOLS_FOUND + 1))

  local fixture_file="$WORK_DIR/fixture.mmd"
  local out_file="$WORK_DIR/output.svg"

  # Write minimal 3-node flowchart fixture
  cat > "$fixture_file" << 'EOF'
graph TD
  A[Start] --> B[Process]
  B --> C[End]
EOF

  # Render to SVG
  if ! mmdc -i "$fixture_file" -o "$out_file" --quiet 2>"$WORK_DIR/mmdc-stderr.txt"; then
    log_fail "mmdc exited non-zero. stderr: $(cat "$WORK_DIR/mmdc-stderr.txt")"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  if [ ! -f "$out_file" ]; then
    log_fail "mmdc produced no output file at $out_file"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  local size
  size=$(wc -c < "$out_file")
  if [ "$size" -lt 100 ]; then
    log_fail "mmdc output file too small ($size bytes < 100 minimum)"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  if ! grep -q '<svg' "$out_file"; then
    log_fail "mmdc output missing <svg> tag"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  log_pass "mermaid-cli: 3-node flowchart → valid SVG ($size bytes)"
  return 0
}

# ── D2 roundtrip ───────────────────────────────────────────────────────────

test_d2() {
  if ! command -v d2 >/dev/null 2>&1; then
    log_skip "d2 not found on PATH — install d2 to enable this test"
    return 77
  fi

  TOOLS_FOUND=$((TOOLS_FOUND + 1))

  local fixture_file="$WORK_DIR/fixture.d2"
  local out_file="$WORK_DIR/output-d2.svg"

  # Write minimal 3-node D2 fixture
  cat > "$fixture_file" << 'EOF'
Start -> Process
Process -> End
EOF

  # Render to SVG
  if ! d2 "$fixture_file" "$out_file" 2>"$WORK_DIR/d2-stderr.txt"; then
    log_fail "d2 exited non-zero. stderr: $(cat "$WORK_DIR/d2-stderr.txt")"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  if [ ! -f "$out_file" ]; then
    log_fail "d2 produced no output file at $out_file"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  local size
  size=$(wc -c < "$out_file")
  if [ "$size" -lt 100 ]; then
    log_fail "d2 output file too small ($size bytes < 100 minimum)"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  if ! grep -q '<svg' "$out_file"; then
    log_fail "d2 output missing <svg> tag"
    TOOLS_FAILED=$((TOOLS_FAILED + 1))
    return 1
  fi

  log_pass "d2: 3-node diagram → valid SVG ($size bytes)"
  return 0
}

# ── Run tests ──────────────────────────────────────────────────────────────

test_mermaid || true
test_d2 || true

# ── Summary ────────────────────────────────────────────────────────────────

if [ "$TOOLS_FOUND" -eq 0 ]; then
  log_skip "No diagram tools installed. CI matrix should ensure at least mermaid-cli on Linux."
  exit 77
fi

if [ "$TOOLS_FAILED" -gt 0 ]; then
  if [ "$WARN_ONLY" -eq 1 ]; then
    log_warn "$TOOLS_FAILED/$TOOLS_FOUND tool(s) failed. (warn-only — not blocking)"
    exit 0
  else
    echo "[$SCRIPT_NAME] FAIL: $TOOLS_FAILED/$TOOLS_FOUND tool(s) failed render roundtrip." >&2
    exit 1
  fi
fi

echo "[$SCRIPT_NAME] PASS: $TOOLS_FOUND tool(s) passed render roundtrip."
exit 0
