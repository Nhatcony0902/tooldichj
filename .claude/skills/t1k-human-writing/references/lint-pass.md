---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Lint Pass — Procedure, Detection Reality, Voice Injection

For `t1k:human-writing` `lint` mode.

## The lint procedure

1. **Ingest** the draft (read the file, or take the pasted text).
2. **Scan by category**, in this order, against `ai-tells-catalog.md`:
   - Vocabulary (the blocklist words)
   - Phrase templates (openers, closers, "it's not just X…")
   - Structure & rhythm (uniform sentences, rule-of-three, trailing -ing, summary conclusion)
   - Tone (sycophancy, hedging, no-stakes, generic warmth)
   - Formatting (em-dash frequency, bold-everything, emoji markers, engagement bait)
3. **Mark each hit** with its category.
4. **Rewrite** the flagged spans using the SKILL.md counter-moves. Rules:
   - **Preserve facts and intent exactly.** Never change a number, name, date, or commitment.
   - **Never fabricate specifics.** If a span is generic only because it's missing a real number/name, flag it and ask the user — do not invent one to make it "sound human." Inventing a figure in a contract or invoice email is a far worse error than a dull sentence.
   - Keep the author's actual opinions; sharpen them, don't replace them.
5. **Report**: a compact `tell → category → fix` table, then the clean rewrite, then a list of any spans you left flagged because they need a missing specific.

## How detection actually works (and why not to chase it)

Detectors (GPTZero, Turnitin, Originality.ai) score two things:
- **Perplexity** — how predictable each word is. AI picks high-probability words → low perplexity. Humans surprise → high.
- **Burstiness** — how much that predictability varies sentence to sentence. AI is flat; humans spike and dip.

Some add a fine-tuned classifier (RoBERTa/DeBERTa) and/or generation-time watermarks.

**Why they're unreliable — say this plainly to the user if they ask "will it pass a detector?":**
- Stanford (Liang et al., 2023): detectors flagged **61.3%** of non-native-English TOEFL essays as AI, **97.8%** flagged by at least one — all human. Structural bias against ESL writers.
- Formal/legal/technical registers test as "AI" because precise vocabulary is naturally low-perplexity.
- Under ~250 words there's not enough signal; the "94% AI" number is the model's confidence in its own guess, not a probability of AI authorship.
- The US Declaration of Independence tests as AI (it's all over training data).
- A 15–20% human edit disrupts the statistical fingerprint anyway.

**Therefore:** the deliverable is writing that's genuinely good and sounds like the user — never a promise that a detector will be fooled. Frame every fix as a quality improvement, because it is one.

## Voice injection (when it must sound like *you* specifically)

The content that makes writing human — the user's opinions, their real numbers, their anecdotes — can't be style-matched in. It has to be supplied. But rhythm and register *can* be matched:

1. Get **300–600 words** of the user's own past writing (an old email, a doc, a post) that sounds the way they want.
2. Analyze it for: sentence-length variation, vocabulary level, contraction use, directness vs hedging, paragraph density, characteristic transitions.
3. Rewrite the target in that style.
4. Show the user; take corrections; 2–3 rounds reaches reliable match.

Over 500 words of sample = high-confidence match. The method captures *how* they write, not *what* they know — specifics and opinions still come from the user.

## Sources (verified 200, 2026-06-11)
- [Pangram Labs — Why Perplexity and Burstiness Fail to Detect AI](https://www.pangram.com/blog/why-perplexity-and-burstiness-fail-to-detect-ai)
- [DEV (Laakash) — How AI Text Detection Works Under the Hood](https://dev.to/laakash/how-ai-text-detection-works-under-the-hood-perplexity-burstiness-and-classifiers-2o6m)
- [Turnitin — Is the AI Detector Biased Against Non-Native English Writers?](https://turnitin.app/blog/Is-Turnitins-AI-Detector-Biased-Against-Non-Native-English-Writers.html)
- [USD Law Library — Problems with AI Detectors: False Positives/Negatives](https://lawlibguides.sandiego.edu/c.php?g=1443311&p=10721367)
- [QuillBot — How to Humanize AI Text: 7 Tips](https://quillbot.com/blog/ai-writing-tools/how-to-humanize-ai-text/)
- [alfred_ — AI That Drafts Emails in My Voice](https://get-alfred.ai/blog/ai-that-drafts-emails-in-my-voice)
