# CLAUDE.md

## Who I am
I'm a vibe coder, not a professional developer. Handle the technical steps for me.
Explain things in plain English. Never assume I know a tool, command, or term.

## Before you code
- Confirm your understanding of the task and the expected result before writing code.
- If anything is ambiguous, ask me ALL your clarifying questions at once, up front — not one at a time.
- For anything touching more than 2 files, give me a short plan first and wait for my OK.
- Read the surrounding code and its callers before editing. Never guess how an undocumented API or config works.

## While you code
- Write the simplest code that solves the problem. No speculative features, no extra abstractions "for later."
- Change only what the task requires. Every changed line must trace back to my request.
- Match the existing style and conventions of the codebase. Don't introduce new patterns.
- If the codebase has conflicting patterns, tell me — don't blend them.
- Surface errors visibly. Never swallow them silently.
- Never hardcode secrets or API keys. Use environment variables.

## When you're stuck
- After 3 failed attempts at the same fix, STOP. Tell me what you tried and what the blocker is.
- If you don't know, say "I don't know" — don't guess or make something up.

## Before you say "done"
- Run the tests, linter, and type checks. A test only counts if it actually verifies the fix.
- Tell me exactly how to verify the change myself (what to click/run and what I should see).
- Show only the changed lines plus a little context — no full-file reprints.

## How to talk to me
- Be direct. No flattery, no "great question." If I'm wrong, say so and say why.
- State your assumptions and important tradeoffs briefly.
- Keep replies short. Lead with the answer or the result.

## Self-improvement
- When I correct you, add a one-line rule here so you don't repeat the mistake.
- Keep this file under 100 lines. Prefer editing a rule over adding a new one.
