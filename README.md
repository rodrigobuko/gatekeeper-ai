# GATEKEEPER

**Understand it before you ship it.**

Gatekeeper is a plugin for [Claude Code](https://claude.com/claude-code). It makes sure you actually
understand the code Claude writes for you: which libraries it uses and why, what each file is for, what the
architecture is, why the spec needs it, and why the code works the way it does.

Claude can still read, investigate, explain and discuss as much as you want. It just can't change your code
until you can explain what is new in your own words. Gatekeeper remembers what you already understand, so it
only asks about what is new, and gets out of the way as you learn the project.

```
you ask for a change
        ↓
Claude proposes a short plan
        ↓
Gatekeeper lists what is new to you (files, libraries, decisions)
        ↓
one question about it (ask for help as much as you need)
        ↓
you explain it in your own words
        ↓
YOU ARE WORTHY.
        ↓
Claude implements the whole stage
        ↓
one question about a real decision in the code it wrote
```

## Why

With AI coding it is easy to become a passive approver: the agent picks the design, writes a long plan,
you say "ok", it edits ten files, and you ship code you no longer understand.

Gatekeeper keeps you in the loop without turning every edit into a quiz. You explain things once, Gatekeeper
remembers, and the next question is only about what you haven't seen yet.

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

3. Claude reads the code, shows a short plan and asks you one question about what is new, for example:

   > Why cache the promise instead of the value? Suppose two requests for user 42 arrive at the same
   > moment with an empty cache: how many times is client.get called in each case?

4. Reply `Looks good, go ahead.` Nothing happens. The gate stays locked.

5. Now answer the question for real, in your own words. Claude prints:

   ```
   GATEKEEPER

   YOU ARE WORTHY.

   Gate opened for this implementation.
   ```

   and implements only the files in the approved plan.

6. When it's done, Claude asks one question about a real choice in the code it wrote, for example why it
   deletes the cache entry when the request fails. Answer it and the next stage can start.

7. Ask for another change to `userService.js`. This time Gatekeeper already knows you understand that file,
   so a single sentence about the change is enough.

[`PILOT_TESTING.md`](PILOT_TESTING.md) has a longer 10 to 15 minute walkthrough with ten scenarios
(wrong answer, asking for help, scope drift, bypass attempts, leaving the gate).

## How it works

**What gets blocked.** While the gate is locked, Claude's `Edit`, `Write`, `Bash` and `PowerShell` tools are
denied on protected files (source code and most config files). Documentation is not protected. The block
happens before the tool runs, so nothing needs to be undone.

**What you are asked about.** Every plan lists what it touches:

- **files**: what is each file for?
- **libraries**: which ones, and why these and not others?
- **decisions**: each real choice with an alternative, like "cache the promise instead of the value".
  Architecture and schema changes must name their decisions.

Gatekeeper compares that list with your **knowledge map** (what you already explained in this project) and
only asks about what is new.

**How deep the gate is.** Decided in code from the plan, not by the model:

| Gate | When | What you do |
|---|---|---|
| Light | nothing new, small change | say in one sentence what will change |
| Standard | something new to you | answer one question that covers it |
| Deep | 5 or more files, a new dependency, an architecture or schema change | justify the complexity, then answer |

**What opens the gate.** Only the `gatekeeper grant` command, and only when all of this is true:

1. Claude registered a plan (`gatekeeper challenge`).
2. You sent at least one message after that plan.
3. Your last message was a real explanation (for a light gate, any genuine sentence).
4. Every new file, library and decision is covered by what you explained.
5. No decision check from the previous stage is pending.

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

## Stages: one approval per piece of work

A big spec is split into stages (for example: data model, then service, then UI). The approval lasts for
the whole stage, across as many turns as Claude needs. You are not interrupted on every edit.

The approval only covers the approved files. If the work grows (a new file, a new library, a schema change,
or an assumption turns out wrong), the edit is blocked and Claude runs `gatekeeper revise`. You are asked
only about what changed. Installing an undeclared library through the shell (`npm install x`,
`pip install x`) is blocked too.

## Decision check at the end of a stage

When a stage that changed code ends (`gatekeeper done`), Claude looks at what it actually wrote and asks
**one** question about a real choice in it: a data structure, where some logic lives, how errors are
handled, a library API. You explain or argue for it. The next stage can't start until you do.

This catches what a plan can't: the decisions made while writing the code. Light stages skip it.

## Your knowledge map

```
gatekeeper knowledge
```

```
GATEKEEPER KNOWLEDGE MAP

Files:
  src/cache.ts: holds the TTL cache shared by getUser

Libraries:
  redis: shared cache so all workers see the same values

Decisions:
  cache-the-promise-instead-of-the-value: concurrent calls share one request
```

It is kept per project and grows as you work. To be asked about something again, remove it:
`gatekeeper forget --concept dep:redis`.

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
| `gatekeeper grant --assessment <a> --learned "<id> = <note>"` | Open the gate for the current stage |
| `gatekeeper revise --summary <s> --files <f...>` | Replace the plan after a scope change |
| `gatekeeper done` | Finish the stage (opens the decision check if code changed) |
| `gatekeeper review --pass --learned "<id> = <note>"` | Record a passed decision check |
| `gatekeeper review --fail --reason <r>` | Record a decision check answer that wasn't enough |
| `gatekeeper knowledge [--json]` | Show what you already understand in this project |
| `gatekeeper forget --concept <id>` | Remove one item so it is asked about again |
| `gatekeeper reset` | Lock again, keeping history and any pending decision check |
| `gatekeeper depart --request` / `--confirm` | Leave the gate (two steps) |
| `gatekeeper diff [--json]` | Files changed since the plan was registered (uses Git) |
| `gatekeeper doctor [--json]` | Safe diagnostics to attach to a bug report |
| `gatekeeper stats` | Show your counters |
| `gatekeeper history [--limit N]` | Show recent events |
| `gatekeeper version` | Show the installed version |

`challenge` and `revise` also accept `--new-files <path...>`, `--uses <library...>` (libraries the change
relies on), `--new-dependency <library...>` (libraries it adds), repeatable `--decision "<choice>"`,
`--architecture-change`, `--schema-change`, `--planned-tests`, `--new-exports <n>`, and repeatable
`--must-not-change "<text>"` and `--assumption "<text>"`.

Ids look like `file:src/cache.ts`, `dep:redis` and `decision:cache-the-promise-instead-of-the-value`.
`gatekeeper challenge` prints the exact ids that still need to be covered.

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
Light gates:                 14
Concepts learned:            41
Decision checks passed:      19
Decision checks retried:      4
Override attempts:            3
Explicit departures:          1
```

There is no score for the developer, only workflow counters. History keeps short metadata (time, event type,
file count, a short reason). It never stores your prompts, Claude's messages or your code. The knowledge map
stores file paths, library names, decision names and one short note for each.

## Privacy and safety

- Everything lives in `~/.gatekeeper` (or `$GATEKEEPER_HOME`), never inside your repo, so it never shows up
  in a commit.
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
- Files and installed libraries are detected mechanically. Libraries the change only relies on (`--uses`)
  and decisions (`--decision`) are declared by Claude, and the skill tells it to declare them honestly.
  Judging whether your explanation is good enough is Claude's call too.
- The approval lasts for the whole stage. Claude is told to run `gatekeeper done` between stages; if it
  doesn't, a new plan or a new session closes the stage anyway, and the decision check is still owed.
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

- A final check before `git push` over the whole branch, on top of the per stage decision check
- Adapters for Codex and OpenCode
- Detecting libraries in use from imports, instead of relying on `--uses`
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
