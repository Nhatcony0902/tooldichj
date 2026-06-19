---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Coding Guidelines

Behavioral guardrails for every coding interaction. Follow these before, during, and after writing code.

## 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity First (YAGNI / KISS / DRY)

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.

## 3. Surgical Changes

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- **Test:** every changed line traces directly to the user's request.

## 4. Goal-Driven Execution

Define verifiable success criteria before implementing:
- "Add validation" → write tests for invalid inputs, make them pass
- "Fix the bug" → write a test that reproduces it, make it pass
- "Refactor X" → ensure tests pass before and after

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

## 5. Verify Before Claiming Done

- Run the command. Read the output. Then claim the result.
- "Should work" and "seems fixed" are not verification.
- Never say "please test this" until you have confirmed it yourself.
