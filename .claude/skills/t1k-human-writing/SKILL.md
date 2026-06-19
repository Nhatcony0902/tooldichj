---
name: t1k:human-writing
description: "Write emails, posts, and messages that read as human — not AI-generated. Use BEFORE drafting or sending any email/LinkedIn-or-X post/Slack-or-WhatsApp message, or when a draft 'sounds like ChatGPT'. Two modes: (1) guide — compose fresh in a human voice with register-switching for email vs post vs message; (2) lint — scan an existing draft, flag the AI tells (vocabulary, structure, tone, formatting), and rewrite them out. Strips delve/leverage/robust-class vocabulary, em-dash overuse, rule-of-three, sycophancy, hedging, 'I hope this email finds you well', engagement-bait, and the summary-conclusion reflex. Grounded in a sourced AI-tells catalog."
keywords: [human writing, sound human, not like AI, AI-generated, ChatGPT tells, AI slop, humanize, email voice, post voice, message voice, anti-AI, de-AI, write naturally, em dash, delve, engagement bait, broetry, sycophancy, hedging, register switching, lint draft, rewrite draft]
argument-hint: "guide <email|post|message> | lint <draft-file-or-pasted-text>"
effort: medium
version: 2.15.1
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Human Writing — Don't Sound Like AI

Write emails, posts, and messages that read as a real person wrote them. The goal is **genuine quality**, not gaming a detector — the two converge, because the things that make text test as "AI" are the same things that make it dull, generic, and untrustworthy.

## Two modes

| Mode | What it does | When |
|------|--------------|------|
| **`guide`** | Compose a fresh draft in a human voice, using the register rules for the channel (email / post / message). | Writing something new. |
| **`lint`** | Scan an existing draft, flag every AI tell by category, then rewrite the flagged spans. Reports what changed and why. | A draft already exists (yours or AI's) and "sounds like ChatGPT." |

If the user just pastes text with no mode word, default to **`lint`**.

## The one rule under all the rules

**AI writes toward the statistical average. A human commits to specifics.** Every technique below is a way of replacing the average with the particular: a real number instead of "significant", a real opinion instead of "both have merits", a 4-word sentence next to a 30-word one instead of a column of identical 18-word sentences.

If you do nothing else: **inject one concrete specific (a name, number, date, or amount) and one real opinion with stakes.** Those two moves are the hardest for AI to fake and the fastest signal that a human is behind the words.

## Core human-writing principles (the counter-moves)

1. **Specifics over abstractions.** "Revenue grew 40% in Q3, mostly from one client" — not "revenue grew significantly." Names, numbers, dates, amounts are un-fakeable and instantly credible.
2. **Vary the rhythm.** Mix a 3-word sentence with a 30-word one. AI's tell is a column of uniform medium-length sentences. Deliberately break the pattern. Fragments are allowed.
3. **Commit to an opinion.** Pick a side and say why. "Approach A is worse, here's why" beats "both approaches have trade-offs." Hedging everything is the model's voice, not yours.
4. **Cut the throat-clearing.** Delete the first sentence if it's warm-up ("In today's fast-paced…", "I hope this finds you well", "It's worth noting that…"). Start at the first load-bearing word.
5. **Kill the summary conclusion.** End on the last real point, a specific detail, or a concrete next step — not "In conclusion, …" restating what you just said.
6. **Write it the way you'd say it, then clean it once.** Use contractions (it's, we're, I've). The pub test: would you say this sentence out loud to a colleague? If not, rewrite it.
7. **Break the rule of three.** AI defaults to three adjectives, three parallel clauses, three bullets. Use two. Use five. Use one.
8. **Drop the transition pile-up.** "Moreover, Furthermore, Additionally, Consequently" are almost never load-bearing. Delete them; let the content connect itself.

## Quick blocklist — top offenders

Excise on sight (full sourced list with replacements: `references/ai-tells-catalog.md`):

- **Words:** delve, leverage (verb), robust, seamless, pivotal, crucial, foster, bolster, garner, utilize, underscore, navigate (figurative), holistic, multifaceted, comprehensive, elevate, unlock, harness, streamline, boasts, nestled, vibrant, tapestry, landscape (metaphor), realm, testament, showcase, transformative, cutting-edge.
- **Phrases:** "it's not just X, it's Y" · "in today's fast-paced world" · "it's worth noting that" · "it is important to note" · "serves as / stands as" · "I hope this email finds you well" · "I am reaching out to" · "please don't hesitate to" · "let me know if you have any questions" · "thank you for your time and consideration" · "at the end of the day" · "let's dive in" · "the takeaway?".
- **Punctuation/format:** em-dash every 2–3 sentences (use commas, parens, or a period); emoji section markers (🚀 ✨ 💡); bold-everything; Title Case Headings; engagement-bait closers ("Agree? 👇").

## Register switching

Match the channel — the same content is written three different ways. Full playbooks: `references/email-playbook.md`, `references/post-playbook.md`.

| Channel | Register | Length | Sign-off |
|---|---|---|---|
| **Business email** (counterparty / finance / partner) | Direct, contractions, one clear ask. Open with the reason, not pleasantries. | Short — most business email should be 3–6 sentences. | "Best, Tu" or just "Tu" in a thread. |
| **Post** (LinkedIn / X / announcement) | A real story or number + a real opinion. No hook-list-takeaway formula, no broetry, no engagement bait. | As long as the thought needs — not the "viral sweet spot." | None / just end on the point. |
| **Message** (Slack / WhatsApp) | Conversational, fragments fine, lowercase fine, one thought. | 1–3 lines. | None. |

## Lint workflow

When in `lint` mode:

1. **Read the draft** (file or pasted text).
2. **Scan by category** against `references/ai-tells-catalog.md`: vocabulary → phrase templates → structure/rhythm → tone → formatting. Mark each hit inline.
3. **Rewrite** the flagged spans applying the counter-moves. Preserve the author's intent and facts exactly — never invent specifics the user didn't supply; if a span needs a real number/name to de-genericize it, ask rather than fabricate.
4. **Report**: a short table of `tell → category → fix`, then the clean rewrite. Note any span you couldn't fix without a missing specific.

Full lint procedure + the detection caveat: `references/lint-pass.md`.

## Honest caveat — quality, not evasion

AI detectors (GPTZero, Turnitin, Originality.ai) work on **perplexity** (word predictability) and **burstiness** (sentence-length variation) — and they are unreliable. Stanford found detectors flag **61.3% of non-native-English essays** as AI despite being fully human; formal/legal registers trip them too. So:

- The aim is writing that's **genuinely better and sounds like you** — the detector score is a byproduct, never the target.
- Don't promise anyone a draft will "pass" a detector. You can't, and the score is probabilistic.
- For a draft that must read as *you* specifically, use **voice injection**: paste 300–600 words of the user's own past writing and match its rhythm, vocabulary, and directness. Detail: `references/lint-pass.md` § Voice injection.

## Voice anchor for The1Studio context

This project's writing is mostly counterparty negotiation, finance/invoicing, and partner emails. Default voice: **firm, specific, warm-but-direct.** State the position first, then the reason. Use real deal terms (section numbers, amounts, dates). In negotiation, directness reads as respect — "We can't move on the IP clause" beats a paragraph of hedged apology.
