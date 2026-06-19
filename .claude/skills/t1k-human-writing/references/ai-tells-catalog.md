---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# AI-Tells Catalog

The sourced reference for `t1k:human-writing`. Five categories: vocabulary, phrase templates, structure/rhythm, tone, formatting. No single item is proof on its own — **three or more in one paragraph is a strong signal.** Sources verified HTTP 200 on 2026-06-11 (see end).

---

## 1. Vocabulary — overused words

Replace on sight. The plain-human word is almost always shorter and clearer.

| AI word | Human replacement |
|---|---|
| delve (into) | look into, dig into |
| leverage (verb) | use |
| utilize | use |
| robust | strong, solid, reliable |
| seamless / seamlessly | smooth, easy |
| pivotal / crucial / vital | important, key |
| foster | build, encourage, grow |
| bolster | strengthen, back up |
| garner | get, win, collect |
| underscore / highlight (verb) | show, stress |
| navigate (figurative) | handle, deal with, work through |
| holistic | whole, complete |
| multifaceted | complex, many-sided |
| comprehensive | full, complete, thorough |
| elevate | raise, lift, improve |
| unlock / unleash | open up, release, enable |
| harness | use, tap |
| streamline / optimize | simplify, speed up, tidy |
| meticulous | careful |
| endeavor | try, effort |
| facilitate | help, run, ease |
| boasts | has |
| nestled | sits, located |
| vibrant | lively, busy |
| tapestry / rich tapestry | mix, range |
| landscape (metaphor) | field, market, scene |
| realm | area, field |
| testament (to) | proof (of), shows |
| showcase | show, feature |
| transformative / revolutionary / groundbreaking | new, big, first |
| cutting-edge / state-of-the-art | latest, newest |
| dynamic / synergy / forward-thinking | (usually deletable buzzwords) |

**Empirical anchor:** an analysis of ~15M PubMed abstracts found an unprecedented post-2022 surge in "delve" and "underscore" — direct evidence these words spiked when ChatGPT entered wide use (PMC study, below).

---

## 2. Phrase templates

| Template | Why it's a tell | Human version |
|---|---|---|
| "It's not just X, it's Y" / "not only… but also" | The model's favorite faux-insight construction. | State the affirmative directly. |
| "In today's fast-paced world / digital landscape" | Scene-setting filler that says nothing. | Delete it; start with the point. |
| "It's worth noting that…" / "It is important to note…" | Throat-clearing before the actual claim. | Just make the claim. |
| "serves as / stands as / represents" (instead of *is*) | Inflated copula-avoidance. | Use "is". |
| "I hope this email finds you well" | The single most-flagged email opener. | Open with why you're writing. |
| "I am reaching out to…" / "I wanted to connect regarding…" | Nobody says this out loud. | "I'm writing about X." |
| "Please don't hesitate to reach out" | Passive, generic closer. | "Email me if anything's unclear." or nothing. |
| "Let me know if you have any questions" | Inert; everyone says it, no one means it. | A specific ask instead. |
| "Thank you for your time and consideration" | Job-application register in a business thread. | "Thanks, Tu." |
| "Moreover / Furthermore / Additionally / Consequently" (pile-up) | Artificial coherence glue. | Delete; let content connect. |
| "In conclusion / Ultimately / At the end of the day / In essence" | Summary reflex. | End on the last real point. |
| "Let's dive in / Let's break this down / Here's the thing" | Pivot-to-list filler. | Start the list (or don't). |
| "experts argue / studies show / it is widely believed" | Phantom citation — no author, year, or link. | Cite it, or own the claim: "I think X because Y." |

---

## 3. Structure & rhythm

| Pattern | What AI does | Human fix |
|---|---|---|
| **Uniform sentence length** | Every sentence 15–25 words; flat rhythm (low "burstiness"). | Drop in a 3-word sentence. Then run one long. |
| **Rule of three** | Three adjectives / three parallel clauses / three bullets, constantly. | Use two, or five, or one. |
| **Trailing "-ing" clauses** | "…, reflecting the broader trend", "…, highlighting the need for…" | Start a new sentence instead. |
| **Negative parallelism** | "Not merely X, but fundamentally Y." | Say the affirmative. |
| **Both-sides hedging** | Every point gets balanced "while X, also Y" treatment. | Pick a side; be lopsided. |
| **Paragraph uniformity** | Every paragraph 3–5 sentences. | Vary hard: one line, then eight. |
| **Thesis→point→point→conclusion template** | "First… Second… Furthermore… In conclusion…" | Start in the middle; skip the recap. |
| **Summary conclusion** | Restates the intro, adds nothing. | Cut it. End on a detail or a next step. |

**Burstiness / perplexity in plain terms:** perplexity = how surprising the next word is; burstiness = how much sentence-to-sentence predictability varies. AI is low on both (predictable words, even rhythm). Humans spike and dip. You don't need the jargon — just vary length and pick the occasional unexpected-but-right word.

---

## 4. Tone

| Tell | Example | Counter-move |
|---|---|---|
| **Sycophancy** | "Great question!", "Absolutely!", "I'd be happy to help!" | Delete the opener; start with the answer. |
| **Relentless positivity / no stakes** | "Both approaches have merit", silver-lining on bad news. | Take a side; name the downside plainly. |
| **Generic warmth, zero specifics** | "As a business owner, you know how important it is to…" | Anchor to one real number / name / date. |
| **Over-explaining / restating the question** | "You asked about X. This is a complex topic. Let's explore…" | Cut everything before the first real sentence. |
| **Promotional tone** | "boasts a rich heritage", "a seamless, robust solution" | Replace superlatives with measurables. |
| **Vague attribution** | "studies show", "it is widely believed" | Cite or own it. |
| **Over-hedging** | "arguably", "to some extent", "it could be said", "in many ways" | Commit. Save hedging for genuine, named uncertainty. |
| **No personality** | Smooth like a stock photo; every sentence same energy. | Write one sentence with an edge only you'd write. |

---

## 5. Formatting

| Tell | Fix |
|---|---|
| **Em-dash overuse** (— every 2–3 sentences) | Use commas, parens, or a period. *Caveat: em-dashes alone are NOT proof — many humans use them. It's the frequency.* |
| **Bold-everything** | Bold only what you'd underline in print. If everything's bold, nothing is. |
| **Over-bulleting** | Write prose; bullet only genuinely discrete items. |
| **Title Case Headings** | Use sentence case, or no heading. |
| **Emoji section markers** (🎯 💡 ⚡✅🚀) | Drop them; use real typographic hierarchy. |
| **Numbered/section symmetry** | Let sections be uneven — some need 2 points, some 7. |
| **Table overuse** | Use prose when there's no clean comparison axis. |
| **Curly vs straight quotes** | Weak signal alone; mismatch within one doc is the suspicious part. |

---

## Sources (verified HTTP 200, 2026-06-11)

- [Wikipedia — Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
- [Wikipedia — AI slop](https://en.wikipedia.org/wiki/AI_slop)
- [ContentBeta — 300+ Words and Phrases Overused by AI](https://www.contentbeta.com/blog/list-of-words-overused-by-ai/)
- [Olivia Cal — How to Spot AI Writing Tells (17 Examples + Blacklist)](https://www.oliviacal.com/post/ai-writing-tells)
- [Every.to / Katie Parrott — Writing With AI is Harder Than You Think](https://every.to/working-overtime/writing-with-ai-is-harder-than-you-think)
- [Ben Congdon — AI Slop, Suspicion, and Writing Back](https://benjamincongdon.me/blog/2025/01/25/AI-Slop-Suspicion-and-Writing-Back/)
- [PMC/NIH — Delving Into PubMed Records: AI-Influenced Vocabulary since ChatGPT](https://pmc.ncbi.nlm.nih.gov/articles/PMC12679996/)
- [Momentic Marketing — 34 Types of AI Slop](https://momenticmarketing.com/blog/avoid-ai-slop)
- [Rolling Stone — the em-dash "ChatGPT hyphen" tell](https://www.rollingstone.com/culture/culture-features/chatgpt-hypen-em-dash-ai-writing-1235314945/)
- [WriteWithAI — 10 Dead Giveaways Your Content Screams "AI Wrote This"](https://writewithai.substack.com/p/10-dead-giveaways-your-content-screams)
