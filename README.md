# GATEKEEPER

**Understand it before you ship it.**

Gatekeeper turns AI coding into an active engineering conversation: protected code stays locked until you
can explain what is being built and why. Your agent can investigate, explain, teach and debate freely —
protected code just doesn't move until you can explain the change back in your own words.

## 60-second version

```
you ask for a change
        ↓
   Gatekeeper locks
        ↓
  one strong question
        ↓
help / questions / pushback (as much as you need — free)
        ↓
     teach-back
        ↓
    YOU ARE WORTHY
        ↓
   agent implements
```

## What it blocks

`Edit`, `Write`, `Bash`, and `PowerShell` on protected files (source, most config/infra files — not docs)
are denied at the tool-call level, before anything happens, while the gate is locked. See
[How the gate works](#how-the-gate-works) for exactly what "locked" and "grant" mean.

## What it does not guarantee

This is workflow enforcement, not a hostile security sandbox: the machine owner can disable hooks, remove
the plugin, or edit files by hand outside Claude Code. See [Limitations](#limitations) and
[Security model](#security-model) for the honest, complete list.

## What problem it solves

A very common failure mode with AI coding agents looks like this:

```
Developer asks
→ Agent chooses architecture
→ Agent writes a huge plan/spec
→ Developer says "ok"
→ Agent edits many files
→ Agent changes the plan mid-way
→ Agent adds many tests
→ Agent says "tests pass"
→ Developer ships code they may no longer understand
```

Gatekeeper changes the shape of the workflow instead:

```
Developer asks
→ Agent investigates
→ Agent proposes a concise implementation
→ Gatekeeper blocks protected mutation
→ Developer questions / investigates / challenges
→ Developer explains the implementation in their own words
→ Agent evaluates the teach-back
→ PASS? no  → guided retry
→ PASS? yes → YOU ARE WORTHY.
→ Gate opens
→ Agent implements the approved scope
→ Material drift or scope expansion → gate closes again
```

The goal is not to slow AI coding down. The goal is to keep the engineer connected to their own codebase.

## Short demo

This is an unedited excerpt from a real local run (`claude --plugin-dir` against a disposable repo — see
[Install / test locally](#install--test-locally)). The prompt was: *"Add an in-memory cache with a 60 second
TTL to getUser. Keep it simple and add meaningful tests."*

```
I haven't changed anything yet. Gatekeeper is active in this repo and blocks edits until you
explain the change back to me, so I've registered the plan below and need your answer first.

Behavior:
- getUser(id, client) keeps a module-level Map from id to { value, expiresAt }.
- Cache hit: if an entry exists and hasn't expired, it returns the cached value without
  calling client.
- Cache miss: it stores the request promise with expiresAt = now + 60s, then awaits it.
  Storing the promise means two calls for the same id at the same moment share one request.
...

Your turn. Please answer in your own words:

1. Suppose two requests for user 42 arrive at the same moment with an empty cache. Walk
   through what happens: how many times is client.get called, and why?
2. Suppose the backend call for user 42 fails. What should happen to the cache entry, and
   what goes wrong if we skip that step?
```

Replying `Looks good. Go ahead.` at this point does **not** open the gate — nothing here ever calls the
grant command on your behalf. Only a real answer does:

```
GATEKEEPER

YOU ARE WORTHY.

Gate opened for this implementation.
```

## How the gate works

Gatekeeper hooks into Claude Code's `PreToolUse` event for `Edit`, `Write`, `Bash`, and `PowerShell`. While a
directory has no active **grant**, any mutation of a protected file (or an obviously mutating shell command)
is denied at the tool-call level — before the edit happens, not as an undo.

A grant is opened only by the Gatekeeper CLI (`gatekeeper grant`), and only when three things are true at
once, checked in code, not by asking the model to behave:

1. There is an active **challenge** (a plan Claude registered with `gatekeeper challenge`).
2. The developer has sent **at least one message since that challenge was opened**.
3. That latest message was not an obvious conversational bypass attempt.

None of `ok`, `looks good`, `continue`, `go ahead`, `approved`, or their Portuguese equivalents open the gate
by themselves — they simply aren't a teach-back, so the Gatekeeper skill won't call `grant` in response to
them, and even if something tried to, a bypass-shaped message is mechanically marked ineligible.

## Teach-back

Claude evaluates your answer on the *concept*, not on keywords. This should pass:

> "Each worker has separate process memory, so state stored only in one worker cannot be seen by another
> request handled by a different worker. The state therefore needs to live in shared storage."

This should not:

> "Concurrency. Redis."

An insufficient answer gets `gatekeeper reject --reason "..."` (tracked, gate stays locked, you get another
try). A sufficient one gets `gatekeeper grant --assessment "..."`, and only then does Claude print the
canonical `YOU ARE WORTHY.` message and start implementing.

## Asking for help

You are not expected to already understand the change before you're allowed to ask about it. You can ask
questions, say you don't understand, request a walkthrough or example, challenge the architecture, ask why a
file needs to change, ask Claude to simplify the plan, or ask why a test is meaningful — all of that is
answered freely and does not count as a passing (or failing) teach-back. The gate only responds to your next
*explanation*.

## Simplicity challenge

Gatekeeper's complexity heuristic is deliberately simple and asks a question rather than computing a score:

| Files touched | Result |
|---|---|
| 1–4 | normal |
| 5–8 | simplicity challenge |
| 9+ | high complexity warning + simplicity challenge |

A new dependency, an architecture change, a schema change, or 3+ new files also force a simplicity challenge
regardless of file count. When it fires, the skill asks things like *"This introduces a provider, factory and
adapter. Which current requirement needs them?"* before the final teach-back — and if you point out
unnecessary complexity, Claude is expected to simplify the plan and re-register it before asking again.

## Plan drift

If the scope grows mid-implementation — a new file, a new dependency, a schema change, a changed
concurrency/persistence story, or an approved assumption turning out to be false — the previous grant does
not silently cover it. `PreToolUse` denies the out-of-scope file, Claude runs `gatekeeper revise` (which
invalidates the old grant and opens a fresh challenge with reset counters), asks a question about the delta,
and requires a new teach-back before the newly-in-scope files can be touched.

## YOU ARE WORTHY

```
GATEKEEPER

YOU ARE WORTHY.

Gate opened for this implementation.
```

This exact phrase is reserved for a passed teach-back. It is never used for tests passing, a plan revision,
a departure, or the completion of an implementation.

## Explicit departure

You can leave Gatekeeper unattended, but not through conversation — only by typing `/gatekeeper:depart`
yourself in the Claude Code prompt box (Claude cannot invoke this on your behalf, and a request like "skip
Gatekeeper" is treated as a bypass attempt, not a departure). It's a two-stage, mechanically-confirmed exit:

```
GATEKEEPER

The Gatekeeper prepares to return to the Astral Lands.
...
If you are certain, reply exactly:

DEPART GATEKEEPER
```

Only after you send that exact phrase — observed as a real message by Claude Code's `UserPromptSubmit`
hook, not something a model call can fabricate — does `gatekeeper depart --confirm` succeed:

```
GATEKEEPER

The Gatekeeper returns to the Astral Lands.

The gate is unguarded.
You may proceed in unworthiness.
```

Never `YOU ARE WORTHY` — that phrase is reserved for a passed teach-back, not an exit.

## Install

### From the marketplace in this repo

```bash
claude plugin marketplace add rodrigobuko/gatekeeper-ai
claude plugin install gatekeeper@gatekeeper-ai
```

This installs at user scope (every project on your machine) by default; pass `--scope project` or
`--scope local` to `claude plugin install` to narrow that. Confirm it loaded with `claude plugin list` or
`/plugin` in a session.

### Local development (`--plugin-dir`)

```bash
git clone https://github.com/rodrigobuko/gatekeeper-ai.git
cd gatekeeper-ai
npm test                       # run the automated suite
npm run validate                # validate plugin.json and marketplace.json

# From any other project you want to try it against:
claude --plugin-dir /absolute/path/to/gatekeeper-ai
```

If you edit the plugin's source while a session is open, run `/reload-plugins` to pick up the change.
`--plugin-dir` is also how the marketplace install itself was verified end-to-end before this was written
up — see [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md) for what's been proven live versus by
automated test alone.

### Reproducing the demo yourself

```bash
mkdir gatekeeper-playground && cd gatekeeper-playground
git init -b main
mkdir src
cat > src/userService.js <<'EOF'
export async function getUser(id, client) {
  return client.get(`/users/${id}`);
}
EOF
git add -A && git commit -m "initial getUser service"

claude --plugin-dir /absolute/path/to/gatekeeper-ai
# then, inside the session:
#   Add an in-memory cache with a 60 second TTL to getUser. Keep it simple and add meaningful tests.
```

Try replying `Looks good, go ahead.` first — the gate stays locked. Then answer the questions Claude asked,
in your own words, and watch it print `YOU ARE WORTHY.` and implement only the approved files.

## Commands

All commands operate on the Gatekeeper state for the **current working directory** (state is keyed by
directory, not by an opaque session id — see [Security model](#security-model)).

```
gatekeeper status [--json]                 Show the current gate phase for this directory
gatekeeper challenge --summary <s> --files <f...>   Open a challenge (locks protected mutation)
gatekeeper reject --reason <r>             Record an insufficient teach-back
gatekeeper grant --assessment <a>          Open the gate for the active challenge
gatekeeper revise --summary <s> --files <f...>      Replace the active challenge (scope/plan change)
gatekeeper reset                           Re-lock this session without touching history/stats
gatekeeper depart --request                Start departure (prints the exact confirmation phrase)
gatekeeper depart --confirm                Finish departure (only after that phrase was sent)
gatekeeper diff [--json]                   Files changed since the challenge opened (Git-based, best-effort)
gatekeeper doctor [--json]                 Safe environment diagnostics for bug reports
gatekeeper stats                           Show aggregate counters
gatekeeper history [--limit N]             Show recent events
gatekeeper version                         Print the installed version
```

`challenge` and `revise` also accept `--new-files <path...>`, `--new-dependency`, `--architecture-change`,
`--schema-change`, `--planned-tests`, `--new-exports <n>`, and repeatable `--must-not-change "<text>"` /
`--assumption "<text>"` for an optional compact task contract on non-trivial changes.

## Coworker testing

[`PILOT_TESTING.md`](PILOT_TESTING.md) is a ~10–15 minute walkthrough covering the lock, a wrong answer, a
help request, a correct teach-back, scope drift, a conversational bypass, a shell bypass attempt, and
explicit departure. It ends with a link to the feedback issue template.

## Stats / history

```
GATEKEEPER RECORD

Gates faced:                 32
Gates passed:                24
First-attempt passes:        16
Unsuccessful teach-backs:    11
Average attempts per pass:  1.46
Plan revisions:               7
Simplicity challenges:       10
Override attempts:            3
Explicit departures:          1
```

There is deliberately **no developer skill/intelligence score** — only workflow counters. History
(`gatekeeper history`) stores compact metadata (timestamp, event type, file count, a short reason) and never
your raw prompts, Claude's raw messages, or your source code. See [`src/core/history.mjs`](src/core/history.mjs)
and [`src/core/stats.mjs`](src/core/stats.mjs).

## Limitations

Be aware of these before relying on Gatekeeper:

- **This is workflow enforcement, not a hostile security sandbox.** The machine owner can disable hooks,
  remove the plugin, edit files by hand outside Claude Code, or launch `claude` without `--plugin-dir`.
  Gatekeeper's real guarantee is: *while it is loaded and its hooks are active, the normal covered Claude
  Code mutation paths (`Edit`, `Write`, `Bash`, `PowerShell`) cannot be opened by conversational instruction
  alone.*
- **Shell classification is best-effort string matching, not a real parser** (`src/core/shell-policy.mjs`).
  It can be fooled by creative quoting, and it can occasionally flag a read-only command that happens to
  contain a mutation-shaped substring (for example, a search pattern containing `>`). While the gate is
  locked, an unrecognized command is denied by default, not allowed — the classifier only needs to
  recognize a command as safe, never as dangerous, to keep the gate meaningful. This did mean a real bypass
  in an earlier version (`gatekeeper status && rm file` was briefly misclassified as a trusted call); that's
  now closed by requiring the *entire* command to match a supported shape, with a quote-aware scan that
  rejects any unquoted chaining operator.
- **Shell mutation is not scope-checked.** Once a grant is active, a mutating shell command is allowed
  outright (best-effort) — Gatekeeper cannot reliably extract "which files" from arbitrary shell syntax the
  way it can from an `Edit`/`Write` tool call's `file_path`.
- **Grant revocation is per-turn, not per-challenge.** If the active grant is used to perform a protected
  mutation, it is revoked at the end of that Claude Code turn (the `Stop` hook), so unrelated later work
  can't silently inherit it. This was compared against letting a grant survive across turns while the
  challenge stays unchanged, and rejected for the pilot: the file-scope check that would need to prevent an
  unrelated task from reusing a stale grant depends entirely on the model correctly deciding the new task
  "looks unrelated," which is exactly the kind of guarantee this project doesn't want to rest on model
  judgment. Instead, a multi-turn implementation of the *same* approved change only needs one more real,
  non-bypass message to re-grant — not a full new teach-back, since comprehension was already demonstrated
  once (see `hasBeenGranted` in `src/core/engine.mjs`).
- **Semantic plan drift detection depends on Claude noticing it**, not on a mechanical diff. The mechanical
  guarantees are file-scope enforcement and the human-turn counter; recognizing "this assumption turned out
  to be false" is the model's judgment, guided by the gate skill.
- **`ConfigChange` auditing is coarse.** Claude Code fires this event on every settings/skills change with no
  confirmed schema for *what* changed, so Gatekeeper only records that a configuration change happened while
  a gate was active — it does not (and currently cannot reliably) verify whether the change specifically
  touched Gatekeeper's own hooks.
- **State is keyed by working directory**, not by Claude Code's internal session id (the CLI, invoked as a
  plain shell command, has no reliable way to learn that id). True session identity is layered on top using
  the session id hook adapters *do* receive — see [Security model](#security-model) — but two concurrent
  Claude Code sessions in the *same* directory at the *same* time will share one Gatekeeper state file.
- **Windows note:** tested with Git Bash's `Bash` tool and the separate `PowerShell` tool on Windows 11. Path
  normalization lower-cases drive letters and uses forward slashes internally for comparison; this is covered
  by the automated test suite.
- **The departure command is `/gatekeeper:depart`, not `/depart`.** Claude Code namespaces every plugin
  skill as `/<plugin>:<skill>`; there is no unprefixed alias. `skills/gate/SKILL.md` and
  `skills/depart/SKILL.md` both say this explicitly so Claude never tells you the wrong name.
- **`/gatekeeper:depart` needs an interactive session.** Confirmed directly: `claude --print`
  (non-interactive/headless mode) does not expand *any* slash command client-side — not this one, not even
  the built-in `/help`. In headless usage there is currently no way to reach the departure skill through a
  slash command; the only way off the gate in that mode is the machine owner running
  `gatekeeper depart --confirm` themselves, or removing the plugin. This is a Claude Code CLI-mode
  characteristic, not something Gatekeeper controls.
- **`disable-model-invocation` on the depart skill is a courtesy, not the mechanical backstop.** Community
  reports suggest plugin-provided skills may not fully honor that frontmatter flag in every Claude Code
  version. Gatekeeper doesn't rely on it: the only thing that ever flips a session to unguarded is a separate
  `gatekeeper depart --confirm` process call, and the skill's own instructions tell Claude never to run it
  without an explicit, separately-confirmed developer message — but assume a determined model *could* attempt
  it, and don't treat the flag alone as a hard guarantee.
- **Hooks declare an explicit 10-second `timeout`** in `hooks/hooks.json`. Without one, a hung or slow hook
  can be silently killed by Claude Code's default timeout, which would fail open (no decision) with no visible
  warning — effectively turning the gate off without telling you. Gatekeeper's hooks are synchronous local
  file I/O and should never approach that, but the explicit timeout is cheap insurance.

## Security model

- Gatekeeper's own CLI writes only to `$GATEKEEPER_HOME` (default `~/.gatekeeper`), never inside your
  repository, so its state never ends up in a diff, a commit, or code review.
- State fails **closed**: an unreadable or unrecognized-shape state file is treated as freshly locked, never
  as freshly granted (`src/core/state.mjs`).
- A crashed or misbehaving hook adapter fails **open** (exits 0, no decision) rather than locking you out of
  your own editor entirely — Gatekeeper is workflow enforcement, not a sandbox, and a bug in it should not be
  able to brick your session.
- A changed Claude Code session id observed in the same working directory (a new `claude` process attaching
  to a directory that had a leftover challenge/grant from a previous process) re-locks the gate automatically,
  so a stale grant can never carry over into a new session.
- The Gatekeeper CLI's own invocations (`gatekeeper ...` / `node .../gatekeeper.mjs ...`) are recognized and
  never blocked by Gatekeeper's own shell policy — narrowly, by exact invocation shape (the whole command,
  with no unquoted chaining operator), not by the mere presence of the word "gatekeeper" anywhere in a
  command (`src/core/shell-policy.mjs`).
- A help request or passive approval ("looks good", "go ahead", "I don't understand, can you explain?") is
  mechanically ineligible for `gatekeeper grant`, the same way an explicit bypass attempt is — this isn't
  left to the model's judgment either (`src/core/bypass.mjs`'s 5-way response classifier).
- Reads and read-modify-writes of Gatekeeper's own state, stats, and history files are protected by a small
  dependency-free file lock (`src/core/lock.mjs`), so two Claude Code processes racing for the same
  directory can't interleave a read-modify-write and silently drop one side's update.

## Roadmap

The next major feature after the coworker pilot should be a **Git pre-push / final-diff comprehension
gate**, because the approved plan can differ from what actually got committed (`gatekeeper diff` above is
the groundwork for this, not the feature itself) — but that needs validating v0.1 with real humans first.

Tracked as roadmap issues (to be filed on GitHub once this repo is public, rather than implemented here):

- Final-diff / pre-push comprehension gate
- Codex adapter
- OpenCode adapter
- Configurable question depth
- Richer semantic task contract
- Shell target extraction for scoped shell writes (today, shell mutation is allowed outright once granted —
  see [Limitations](#limitations))
- Pilot-informed grant lifetime (revisit the per-turn-revocation tradeoff above once real pilot data exists)

Explicitly not planned soon: a web dashboard, a cloud backend, a team leaderboard, a developer score,
AI-generated performance reviews, remote telemetry, a full AST shell parser, or an enterprise policy server —
Gatekeeper's narrow value is human understanding and active engineering participation, not becoming a
project-management platform.

### Prior art

The pre-edit "deny until you explain it" teach-back mechanic doesn't appear to exist as a shipped Claude Code
plugin elsewhere as of this writing. Gatekeeper's actual distinction from what's out there:

> Gatekeeper focuses on comprehension **before delegation**, with deterministic pre-mutation blocking and
> active developer discussion — not a post-hoc quiz, and not a risk-tiered permission gate.

Nobody credited below was copied from; each entry names the specific idea Gatekeeper borrowed or measured
itself against, and the license/attribution of any of these projects hasn't been separately checked before
naming them here.

| Project | What it inspired |
|---|---|
| [Socratic Skills](https://github.com/rodbv/socratic-skills) | One question at a time, with a probing follow-up before revealing the answer, instead of a checklist of questions at once |
| [No-Numb](https://github.com/Ciucky/no-numb) | Comprehension as a forcing function, and distinguishing conceptual from code-grounded questions — Gatekeeper differs by gating *before* implementation, not mainly quizzing after generated code |
| [vibecheck](https://github.com/dalvgit/vibecheck) | The adapter-based multi-harness direction this repo already uses, and the final-diff/pre-push idea on the roadmap — Gatekeeper does not adopt its skip-anytime/multiple-choice flow |
| [comprehension-gate](https://github.com/erickdevz/comprehension-gate) | Comprehension as a real merge/release workflow concern, retry rather than one-shot grading, no developer intelligence score |
| [Anthropic security-guidance](https://github.com/anthropics/claude-code/tree/main/plugins/security-guidance) | Explicit hook timeouts, Git-baseline/changed-diff thinking, bounded metadata instead of storing raw content, honest best-effort framing — Gatekeeper does not add a second LLM call the way this plugin does |
| [Anthropic PR Review Toolkit](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit) | Behavioral test-coverage analysis ("what does this test actually protect?") and challenging unnecessary complexity |
| [universal-dev-flow-plugin](https://github.com/kktu6507/universal-dev-flow-plugin) | The compact task contract (`--must-not-change`/`--assumption`) as a concrete object for semantic drift, kept far narrower than its full spec-driven framework |
| [CCF — Claude Context First](https://github.com/naniiluja/ccf) | Hooks as the deterministic layer, and context recovery across session/compact boundaries (see the `SessionStart` limitation above) — Gatekeeper does not adopt its full spec-driven development framework |

Deliberately not adopted from any of the above: a "skip"/"not now"/auto-pass flow — departure is a distinct,
explicitly-confirmed exit, never a quiet pass — turning Gatekeeper into a project manager or spec generator,
or any developer score/rating.

## Contributing

This is a v0.1, hardened once against a real external audit — see [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md)
for what's actually been proven versus unit-tested only. Issues and PRs are welcome — please include a
failing test for bug reports where practical. Run `npm test` and `npm run validate` before opening a PR; CI
runs the former on Ubuntu/Windows/macOS (see [Roadmap issues](#roadmap) for what's tracked as
follow-up work rather than done here).

## License

[MIT](LICENSE)
