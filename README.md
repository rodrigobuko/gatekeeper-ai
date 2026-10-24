# GATEKEEPER

**Understand it before you ship it.**

Gatekeeper is a plugin for [Claude Code](https://claude.com/claude-code). It stops Claude from editing your
code until you can explain the change in your own words.

Claude can still read, investigate, explain and discuss as much as you want. It just can't touch protected
files until you show you understand what is about to change and why.

```
you ask for a change
        ↓
Gatekeeper locks the code
        ↓
Claude proposes a short plan and asks you one question
        ↓
you ask anything you need (free, unlimited)
        ↓
you explain the change back in your own words
        ↓
YOU ARE WORTHY.
        ↓
Claude implements exactly what was approved
```

## Why

With AI coding it is easy to become a passive approver: the agent picks the design, writes a long plan,
you say "ok", it edits ten files, and you ship code you no longer understand.

Gatekeeper keeps you in the loop. The goal is not to slow you down. The goal is that you still know your
own codebase after the agent is done.

## Install

You need Claude Code and Node.js 18 or newer.

**Only in one project (recommended to start).** Run this inside the project folder:

```bash
claude plugin marketplace add rodrigobuko/gatekeeper-ai
claude plugin install gatekeeper@gatekeeper-ai --scope project
```

**In every project on your machine:**

```bash
claude plugin marketplace add rodrigobuko/gatekeeper-ai
claude plugin install gatekeeper@gatekeeper-ai
```

Check that it loaded with `claude plugin list`, or `/plugin` inside a session.

**Try it without installing:**

```bash
git clone https://github.com/rodrigobuko/gatekeeper-ai.git
claude --plugin-dir /absolute/path/to/gatekeeper-ai
```

To remove it: `claude plugin uninstall gatekeeper@gatekeeper-ai`.

## Your first gate (5 minutes)

1. Create a small test repo:

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
   ```

2. Open Claude Code with the plugin and ask for a change:

   > Add an in-memory cache with a 60 second TTL to getUser. Keep it simple and add meaningful tests.

3. Claude reads the code, shows a short plan and asks you a question, for example:

   > Suppose two requests for user 42 arrive at the same moment with an empty cache. How many times is
   > client.get called, and why?

4. Reply `Looks good, go ahead.` Nothing happens. The gate stays locked.

5. Now answer the question for real, in your own words. Claude prints:

   ```
   GATEKEEPER

   YOU ARE WORTHY.

   Gate opened for this implementation.
   ```

   and implements only the files in the approved plan.

[`PILOT_TESTING.md`](PILOT_TESTING.md) has a longer 10 to 15 minute walkthrough with ten scenarios
(wrong answer, asking for help, scope drift, bypass attempts, leaving the gate).

## How it works

**What gets blocked.** While the gate is locked, Claude's `Edit`, `Write`, `Bash` and `PowerShell` tools are
denied on protected files (source code and most config files). Documentation is not protected. The block
happens before the tool runs, so nothing needs to be undone.

**What opens the gate.** Only the `gatekeeper grant` command, and only when all three are true:

1. Claude registered a plan (`gatekeeper challenge`).
2. You sent at least one message after that plan.
3. Your last message was a real explanation.

These checks run in code, not in the model's judgment.

**What does not open the gate.** "ok", "looks good", "go ahead", "approved", "skip Gatekeeper" and their
Portuguese equivalents. Questions and "I don't understand" also don't count. They are welcome, they just
aren't an answer.

**What counts as a good answer.** Claude judges the idea, not keywords.

This passes:

> Each worker has its own memory, so state saved in one worker is invisible to a request handled by another
> worker. The state needs to live in shared storage.

This does not:

> Concurrency. Redis.

A weak answer is recorded as a retry. You get feedback and can try again as many times as you need.

## While the gate is locked

You can do anything that helps you understand:

- ask questions or say you don't get it
- ask for a walkthrough or an example
- ask why a file needs to change
- push back on the design or ask for a simpler plan
- ask what a test actually protects

None of this costs anything. The gate only reacts to your explanation.

## Too complex? Gatekeeper asks

If the plan is getting big, Claude must justify it before the final question:

| Plan | What happens |
|---|---|
| 1 to 4 files | normal gate |
| 5 to 8 files | simplicity challenge |
| 9 or more files | high complexity warning plus simplicity challenge |

A new dependency, an architecture change, a schema change or 3 or more new files also trigger the
simplicity challenge. Example: *"This adds a provider, a factory and an adapter. Which current requirement
needs them?"* If you spot unnecessary complexity, Claude simplifies the plan and asks again.

## When the plan changes

An approval covers only the approved files. If the work grows (a new file, a new dependency, a schema change,
or an assumption turns out wrong), the out of scope edit is blocked. Claude runs `gatekeeper revise`, explains
what changed, and you answer a new question about that change.

An approval also ends when the Claude turn that used it finishes. To continue the same approved work in the
next turn, one more real message from you is enough. You don't need to explain everything again.

## Leaving the gate

If you want to work without Gatekeeper, type this yourself in the Claude Code prompt:

```
/gatekeeper:depart
```

Claude cannot run it for you, and asking Claude to "skip Gatekeeper" does not count. Gatekeeper then asks
you to reply exactly:

```
DEPART GATEKEEPER
```

After that the gate is off for this session:

```
GATEKEEPER

The Gatekeeper returns to the Astral Lands.

The gate is unguarded.
You may proceed in unworthiness.
```

`/gatekeeper:depart` needs an interactive session. In `claude --print` mode slash commands don't run, so
the only way out there is running `gatekeeper depart --confirm` yourself or removing the plugin.

## Commands

All commands act on the current folder.

| Command | What it does |
|---|---|
| `gatekeeper status [--json]` | Show whether the gate is locked or open |
| `gatekeeper challenge --summary <s> --files <f...>` | Register a plan and lock the gate |
| `gatekeeper reject --reason <r>` | Record an answer that wasn't enough |
| `gatekeeper grant --assessment <a>` | Open the gate for the current plan |
| `gatekeeper revise --summary <s> --files <f...>` | Replace the plan after a scope change |
| `gatekeeper reset` | Lock again, keeping history |
| `gatekeeper depart --request` / `--confirm` | Leave the gate (two steps) |
| `gatekeeper diff [--json]` | Files changed since the plan was registered (uses Git) |
| `gatekeeper doctor [--json]` | Safe diagnostics to attach to a bug report |
| `gatekeeper stats` | Show your counters |
| `gatekeeper history [--limit N]` | Show recent events |
| `gatekeeper version` | Show the installed version |

`challenge` and `revise` also accept `--new-files <path...>`, `--new-dependency`, `--architecture-change`,
`--schema-change`, `--planned-tests`, `--new-exports <n>`, and repeatable `--must-not-change "<text>"` and
`--assumption "<text>"`.

In normal use you never type these. Claude runs them following the plugin's `gate` skill.

## Stats

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

There is no score for the developer, only workflow counters. History keeps short metadata (time, event type,
file count, a short reason). It never stores your prompts, Claude's messages or your code.

## Privacy and safety

- State lives in `~/.gatekeeper` (or `$GATEKEEPER_HOME`), never inside your repo, so it never shows up in a
  commit.
- No network calls and no telemetry.
- A broken or unreadable state file counts as **locked**, never as open.
- If a Gatekeeper hook itself crashes, it lets the tool run instead of freezing your editor. It is a workflow
  tool, and a bug in it should not lock you out of your own project.
- A new Claude Code session in the same folder locks the gate again, so an old approval never carries over.

## Limits

Gatekeeper enforces a workflow. It is not a security sandbox.

- You, as the machine owner, can always disable the plugin or edit files outside Claude Code.
- Shell commands are classified by text patterns, not a real parser. Unknown commands are denied while
  locked. Sometimes a harmless read command gets flagged, and creative quoting could slip through.
- After approval, shell commands that change files are allowed without checking which files they touch.
  `Edit` and `Write` are always checked against the approved file list.
- Noticing that a plan's assumption turned out false depends on Claude. The file scope and message checks
  are mechanical.
- State is per folder. Two Claude Code sessions open in the same folder at the same time share one gate.
- Tested on Windows 11 (Git Bash and PowerShell), with CI on Ubuntu, Windows and macOS.

More detail on what was proven live versus only by automated tests is in
[`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md).

## Project layout

```
.claude-plugin/   plugin.json and marketplace.json
hooks/hooks.json  which Claude Code events call Gatekeeper
src/adapters/     one small script per Claude Code hook
src/core/         the gate logic: state, rules, shell policy, history, stats
src/cli/          the gatekeeper command
skills/gate/      instructions Claude follows while the gate is active
skills/depart/    the /gatekeeper:depart command
bin/              gatekeeper launchers for Unix and Windows
tests/            automated tests (node:test, no dependencies)
```

## Development

```bash
npm test          # run all tests
npm run validate  # validate plugin.json and marketplace.json
```

While a session is open with `--plugin-dir`, run `/reload-plugins` after editing the plugin.

Issues and pull requests are welcome. For bugs, please include the output of `gatekeeper doctor` and, if
you can, a failing test.

## Roadmap

- A final check before `git push` that asks about the actual diff, not just the plan
- Adapters for Codex and OpenCode
- Configurable question depth
- Scope checks for shell commands after approval

Not planned: dashboards, cloud backend, leaderboards, developer scores or telemetry.

## Credits

Ideas Gatekeeper learned from (nothing was copied):

| Project | Idea |
|---|---|
| [Socratic Skills](https://github.com/rodbv/socratic-skills) | One question at a time, with a follow up before giving the answer |
| [No-Numb](https://github.com/Ciucky/no-numb) | Comprehension as a forcing function; conceptual versus code based questions |
| [vibecheck](https://github.com/dalvgit/vibecheck) | Adapters for multiple agents; a final diff check before push |
| [comprehension-gate](https://github.com/erickdevz/comprehension-gate) | Retry instead of one shot grading; no developer score |
| [Anthropic security-guidance](https://github.com/anthropics/claude-code/tree/main/plugins/security-guidance) | Explicit hook timeouts, Git baseline, storing metadata instead of content |
| [Anthropic PR Review Toolkit](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit) | Asking what a test really protects; challenging needless complexity |
| [universal-dev-flow-plugin](https://github.com/kktu6507/universal-dev-flow-plugin) | A small task contract (`--must-not-change`, `--assumption`) |
| [CCF, Claude Context First](https://github.com/naniiluja/ccf) | Hooks as the deterministic layer; recovering context across sessions |

## License

[MIT](LICENSE)
