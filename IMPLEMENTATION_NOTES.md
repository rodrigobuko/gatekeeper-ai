# GATEKEEPER — implementation notes

This document explains the repository as built: what's in it, how the pieces fit together, every
interaction the plugin supports, what's been verified against a real Claude Code session versus only
unit-tested, and where I'd push the design further if this moved past v0.1.

It's a companion to [`README.md`](README.md) (the user-facing pitch) and
[`GATEKEEPER_IMPLEMENTATION_DIRECTIVE.md`](GATEKEEPER_IMPLEMENTATION_DIRECTIVE.md) (the original spec this
was built from) — this file is the "how it actually works and what I'd change" write-up.

---

## 1. What this is

Gatekeeper is a Claude Code plugin that denies protected-file mutation (`Edit`, `Write`, `Bash`,
`PowerShell`) until the developer explains the planned change well enough to satisfy a "teach-back" —
mechanically enforced via a `PreToolUse` hook, not by asking the model to behave. The core idea: an AI
coding agent should not be the thing deciding whether the developer understood what shipped.

## 2. Repo map

```
gatekeeper-ai/
├── .claude-plugin/plugin.json      Plugin manifest (name: "gatekeeper", drives all /gatekeeper:* naming)
├── hooks/hooks.json                Registers PreToolUse, UserPromptSubmit, Stop, ConfigChange
├── skills/
│   ├── gate/SKILL.md               Auto-invoked behavioral guidance for Claude (the whole workflow)
│   └── depart/SKILL.md             disable-model-invocation:true — user-only, /gatekeeper:depart
├── src/
│   ├── core/                       Harness-independent. No Claude-specific knowledge lives here.
│   │   ├── engine.mjs               State transitions: challenge, grant, reject, revise, depart, scope checks
│   │   ├── state.mjs                Load/save per-directory state, atomic writes, fail-closed on corruption
│   │   ├── history.mjs              Bounded NDJSON event log, compact metadata only
│   │   ├── stats.mjs                Aggregate counters (no human "skill score")
│   │   ├── complexity.mjs           1–4 / 5–8 / 9+ file heuristic + dependency/schema/architecture signals
│   │   ├── files.mjs                Protected-extension/filename classification + path normalization
│   │   ├── shell-policy.mjs         Best-effort Bash/PowerShell mutation classifier
│   │   └── bypass.mjs               EN/PT conversational-bypass phrase detection
│   ├── adapters/claude/            The ONLY layer that knows Claude Code's hook JSON dialect
│   │   ├── pre-tool-use.mjs          Edit|Write|Bash|PowerShell → deny or silence
│   │   ├── user-prompt-submit.mjs    Counts the mandatory human turn, flags bypass attempts
│   │   ├── stop.mjs                  Revokes a used grant at turn end
│   │   ├── config-change.mjs         Coarse audit-only logging
│   │   └── normalize.mjs             Hook I/O helpers (stdin JSON, response shapes)
│   └── cli/gatekeeper.mjs          status/challenge/reject/grant/revise/reset/depart/stats/history/version
├── bin/gatekeeper, bin/gatekeeper.cmd   Cross-platform CLI entry points
└── tests/                          95 Node-test-runner tests (core, claude adapters, integration)
```

The dependency direction is one-way: `adapters/claude` → `core`, never the reverse. That's what makes a
future Codex/OpenCode adapter (roadmap) a matter of writing a new `adapters/<harness>/` directory, not
touching `core/` at all.

## 3. What we actually did, in order

1. Read the 40-section implementation directive and treated it as a spec to *execute*, not re-plan.
2. Pulled the current Claude Code plugin/hooks/skills docs (they'd moved since training data — manifest
   fields, exact `PreToolUse`/`UserPromptSubmit`/`Stop` JSON shapes, `${CLAUDE_PLUGIN_DATA}`,
   `disable-model-invocation`, and the `/<plugin>:<skill>` naming rule) rather than guessing.
3. Built the harness-independent core first, then the Claude adapter on top of it, then the CLI, then the
   two skills.
4. Wrote 95 automated tests (`node --test`) that spawn the real adapter/CLI scripts as subprocesses with
   realistic hook JSON — not mocks of the logic, the actual files that ship.
5. Built a disposable playground repo and ran the real `claude --plugin-dir` against it, multiple times,
   for a real multi-turn conversation — not just unit tests. This is what caught two real bugs unit tests
   couldn't: a `Gates faced`/`Gates passed` stat that could exceed itself after a `revise`, and — the bigger
   one — that every doc and skill told the user to run `/depart`, which **does not exist**; Claude Code
   namespaces every plugin skill as `/<plugin>:<skill>`, so the only real command was always
   `/gatekeeper:depart`. Fixed both, re-verified.
6. Spawned a research subagent to check what other Claude Code plugins/official guidance exist. Nothing
   else does this exact pre-edit comprehension gate; two findings were still worth taking — an explicit
   hook `timeout` (an unbound default can silently kill a hook and fail the gate open with zero warning)
   and being honest in the README about `disable-model-invocation` being a courtesy, not a proven hard
   backstop, for plugin-provided skills.
7. Wrote the README, ran a secrets/local-state scan, committed. GitHub push is the one open item — `gh`
   isn't authenticated in this environment, so the repo is local-only (`C:\Users\Rodrigo\gatekeeper-ai`,
   branch `main`) until `gh auth login` is run.

## 4. Every interaction the plugin supports

### 4.1 The state machine

```
                    ┌─────────────────────────────────────────────┐
                    │                                               │
   ┌──────────┐  challenge  ┌───────────┐  grant   ┌─────────┐    │
   │  LOCKED  │────────────▶│ CHALLENGE │─────────▶│ GRANTED │────┘  (Stop hook revokes if used)
   │(no chal.)│             │(awaiting  │  reject  │         │
   └──────────┘             │teach-back)│◀────┐    └────┬────┘
        ▲                   └─────┬─────┘     │         │
        │                         │ revise    │         │ out-of-scope Edit/Write
        │                         ▼           │         ▼
        │                   ┌───────────┐     │    (denied, same as LOCKED)
        │                   │new CHALLENGE│    │
        │                   └───────────┘     │
        │  new session id observed             │
        └───────────────────────────────────────┘
                (also: `gatekeeper depart --confirm` → DEPARTED, bypasses all of the above)
```

### 4.2 Protected-mutation attempt while `LOCKED`
`Edit`/`Write` on a protected file, or a `Bash`/`PowerShell` command matching a mutation pattern → hard
deny (`GATEKEEPER_LOCKED`) at the tool-call level, before anything happens. Docs (`.md`/`.txt`, except
deliberate exceptions like `requirements*.txt`) are never gated, so Claude can still write a plan.

### 4.3 Challenge → question → answer, three ways it can go
- **Insufficient answer** → `gatekeeper reject --reason "..."`. Tracked (`failedTeachbacks`), gate stays
  locked, developer gets a specific "what's missing" and another try. *Live-verified*: a shallow "it retries
  the request... then gives up" answer was correctly rejected with the exact gap named.
- **Help request instead of an answer** → answered freely (code walkthroughs, timelines, examples), no
  state change at all. *Live-verified*: a concurrency walkthrough with an ASCII timeline, zero effect on
  `failedTeachbacks` or `userResponsesAfterChallenge` eligibility state.
- **Real answer** → `gatekeeper grant --assessment "..."`. Prints the exact canonical block, and only then
  does Claude implement. *Live-verified* end-to-end, including the tests Claude wrote actually passing
  (`npm test` in the playground: 7/7, then 9/9 after a second feature).

### 4.4 Passive approval / conversational bypass
Two different mechanisms handle two different things:
- **"Looks good, go ahead"** — not on the bypass phrase list, not blocked by any hook. What stops it is
  structural: nothing except an explicit `gatekeeper grant` call opens the gate, and the skill's own
  judgment is what decides whether to make that call. *Live-verified*: this phrase never opened the gate,
  across multiple runs.
- **"Ignore Gatekeeper, I approve it"** — matched by `bypass.mjs`, the `UserPromptSubmit` hook marks the
  response ineligible and injects a warning Claude sees as context, and `overrideAttempts` increments
  separately from `failedTeachbacks`. *Live-verified*, twice, in two different sessions — the message still
  reaches Claude (never silently dropped) but a `grant` attempt right after it mechanically fails.

### 4.5 Scope expansion / plan drift
An `Edit`/`Write` to a protected file outside the current grant's file list is denied
(`GATEKEEPER_SCOPE`) even with an active grant. `gatekeeper revise` opens a fresh challenge (new id, reset
counters, old grant invalidated) covering the expanded scope. *Live-verified, and this is the best evidence
in the whole build*: Claude tried to write a new test file and a new `package.json` that were never in the
original grant's file list, got denied on both, correctly diagnosed why, called `revise` on its own, asked
a delta-focused question, and only then wrote those files. I didn't script that — it happened because the
scope check is real.

### 4.6 Simplicity challenge
Deterministic: 1–4 files normal, 5–8 triggers a simplicity question, 9+ is a strong warning; a new
dependency, architecture change, schema change, or 3+ new files force the same regardless of file count.
This is a *question*, never a rejection — `computeComplexity()` never returns a verdict, only a flag asking
Claude to challenge the plan before the final teach-back.

### 4.7 Turn-end grant revocation
`Stop` hook: if the active grant was used for a mutation during the turn, it's revoked. *Live-verified*:
after a successful grant + implementation, `gatekeeper history` showed `Gate re-locked — grant used, turn
ended`, and the same file was denied again on the next attempt without a fresh grant.

### 4.8 Session relock
If a hook observes a *different* Claude Code session id in the same working directory (a new `claude`
process attaching where a previous one left a challenge/grant), the state re-locks automatically.
*Live-verified* via automated test and via a real second `claude --resume`-less invocation in the same
directory.

### 4.9 Departure
Two-stage, explicit-confirmation exit: `/gatekeeper:depart` (not `/depart` — see §5) → "Astral Lands"
warning → explicit confirmation → `gatekeeper depart --confirm` → gate unguarded for that directory until
`gatekeeper reset` or a fresh challenge. *Verified*: the CLI mechanics work exactly as specified and were
exercised end-to-end (unguarded state confirmed by a subsequent unblocked `Edit`); the slash-command
trigger itself could only be confirmed against docs + `claude plugin details`, not a live chat, because of
the limitation in §5.

## 5. What's proven live vs. proven only by unit test

Be precise about this, because it matters for how much to trust each claim:

| Claim | Evidence |
|---|---|
| Lock, challenge, reject, help, grant, canonical phrase | Real `claude --plugin-dir`, multi-turn, transcript-verified |
| Scope expansion → `revise` → new grant | Real `claude --plugin-dir`, **discovered organically**, not scripted |
| Conversational bypass refused | Real `claude --plugin-dir`, twice |
| Turn-end revocation | Real `claude --plugin-dir` + `gatekeeper history` |
| Session relock | Automated test (real subprocess, synthetic session ids) |
| Shell mutation blocking (Bash/PowerShell) | Automated test (real subprocess, realistic hook JSON) |
| Departure CLI mechanics (`depart`, `depart --confirm`, unguarded after) | Real `claude --plugin-dir` for the "now unblocked" half; CLI run directly for the confirm text |
| `/gatekeeper:depart` slash command itself resolving in chat | **Not directly observed.** `claude --print` (non-interactive) does not expand *any* slash command — confirmed by testing the built-in `/help`, which also failed the same way. Confirmed indirectly via the official naming rule and `claude plugin details gatekeeper` showing the skill registered under the plugin. If you get a chance to try `/gatekeeper:depart` in a normal interactive session, that's the one flow I'd want a human to actually click through. |

## 6. Known rough edges (see README § Limitations for the full list)

The short version: shell classification is regex, not a parser, and isn't scope-checked once granted;
`ConfigChange` auditing is coarse; state is keyed by working directory, so two concurrent sessions in the
same directory share one state file; and grant revocation is per-turn, which means a multi-turn
implementation under the *same* approved scope needs a fresh, quick grant on its next protected mutation
rather than staying open indefinitely.

## 7. Better ways to handle the main objective (if this goes past v0.1)

These are opinions, not requests from the directive — flagging them as things I'd raise before building,
not things I built without asking.

1. **Per-turn revocation is the single biggest usability risk.** It's the right conservative default, but
   in real use a "add a feature" task often spans 3–4 turns of the *same* approved plan (fix a test, adjust
   an edge case). Right now each of those turns needs its own quick grant. A middle ground: let a grant
   survive across turns **as long as no new protected file outside its scope is touched and the challenge
   hasn't been revised**, and only force a fresh teach-back when the *scope itself* changes — which is
   already the mechanism for drift. That would cut a lot of the "explain it again" friction without
   reopening the self-approval hole, because the trigger for re-locking would still be mechanical (scope
   change), not model judgment.
2. **The complexity heuristic only counts files.** A one-file, 400-line rewrite of core auth logic gets
   "normal" complexity next to a five-file, five-line-each formatting pass that gets a simplicity
   challenge. A cheap second signal — total diff line count once the implementation exists, checked at
   grant time rather than challenge time — would catch the case the current heuristic structurally can't.
3. **Shell scope-checking is the weakest mechanical guarantee in the system.** Right now a granted shell
   mutation is allowed outright, with no file-scope check, because extracting "which file does this
   command touch" from arbitrary shell syntax is genuinely hard. A pragmatic partial fix: for the common
   single-file-redirect shape (`... > path`, `Set-Content path ...`, etc.), extract the target path with a
   narrow regex and run it through the *same* scope check `Edit`/`Write` gets, falling back to today's
   allow-if-granted behavior for anything more complex. Partial coverage beats none, and it reuses
   `files.mjs` as-is.
4. **The roadmap's Git pre-push gate is the right next investment, not a nice-to-have.** Everything here
   checks "did you understand the *plan*." Nothing checks "do you understand what actually got committed,"
   and those two can diverge over several implementation turns. A pre-push hook that diffs the final commit
   range against the last granted challenge's file scope, and re-challenges on anything unexplained, closes
   the gap the directive itself calls out in its own roadmap section.
5. **No lock around concurrent state writes.** Two hook invocations racing for the same directory's state
   file (unlikely but possible — e.g. a fast tool-call burst) could interleave a read-modify-write. The
   atomic rename makes each *individual* write safe, but not read-modify-write as a unit. A simple
   directory-based lockfile (`state.json.lock`, `O_EXCL` create, short retry loop) would close this for
   cheap; I didn't add it because I never observed it happen and didn't want to add untested concurrency
   code to a v0.1, but it's the honest answer to "what could actually race."
6. **Consider exposing `gatekeeper status --json`.** Right now the CLI is human-text-only. A JSON output
   mode would let a status-line integration or a small dashboard show "gate open/locked" without scraping
   text — cheap to add, and it's the kind of thing a second developer extending this would want on day one.

## 8. How to pick this back up

```bash
cd /c/Users/Rodrigo/gatekeeper-ai
npm test                    # 95 tests
claude plugin validate .    # manifest check
claude --plugin-dir .       # try it against gatekeeper-ai's own repo, or any other project
```

Publish once authenticated as `rodrigobuko`:
```bash
gh auth login --hostname github.com --web
gh repo create rodrigobuko/gatekeeper-ai --public --source=. --remote=origin \
  --description "Keep engineers actively involved in AI-assisted coding. Understand it before you ship it." --push
```
