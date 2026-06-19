---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Image Analysis Routing — human-mcp First

## Rule

For ANY image the user provides (pasted, attached, or a file path), route the
analysis through the **human-mcp** MCP server's vision tools —
`mcp__human-mcp__eyes_analyze` (or `eyes_compare` / `eyes_read_document` for
multi-image or document inputs) — **instead of** Claude's built-in vision.

This is the kit default and is reinforced by the `UserPromptSubmit` hook
`image-routing-human-mcp.cjs`, which injects a routing reminder whenever an
image is attached.

## How to apply

1. When an image is present, call `mcp__human-mcp__eyes_analyze` with the image's
   file path (Claude Code's pasted-image cache path, a URL, or a local path) as
   `source`.
2. Use `eyes_compare` for before/after or A/B image pairs, and
   `eyes_read_document` / `eyes_summarize_document` for screenshots of text,
   PDFs, or documents.
3. **If human-mcp is registered but `mcp__human-mcp__eyes_analyze` is NOT loaded
   this session** (it loads at session start), tell the user to restart Claude
   Code, then route the analysis through it.
4. **If human-mcp is NOT installed at all**, just use Claude's built-in native
   vision — that is the intended graceful fallback. The routing hook only fires
   when human-mcp is registered, so this rule never forces a tool the user
   doesn't have.

## Scope

- Applies to image **analysis** only. Image **generation** is a separate path
  (Gemini/Imagen via the `t1k-extended-multimodal` skill or human-mcp's hands
  tools) — this rule does not govern it.
- human-mcp requires its own vision backend (a Gemini API key, Vertex AI, or an
  OpenAI-compatible gateway such as a LiteLLM proxy). LiteLLM is one option, not
  a requirement — native Gemini works with just `GOOGLE_GEMINI_API_KEY`.
- This routing is **not** related to model-router: model-router swaps the model
  running a delegated subagent, not the backend of the `eyes_analyze` tool.

## Opt-out

Set `features.imageAnalysisRouting: false` in `t1k-config-core.json` to disable
the routing hook entirely (native vision resumes).

## Why

human-mcp's dedicated vision pipeline (benchmarked correctness-first across
multiple backends) gives more reliable, configurable image understanding than
inline native vision, and keeps image analysis on the studio's chosen
gateway/models. Centralizing the routing in one hook + one rule means every
consumer gets the same default without per-project wiring.
