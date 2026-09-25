---
name: depart
description: User-only command to explicitly leave Gatekeeper for this session, so protected mutation no longer requires a comprehension gate. Only the developer can invoke this — you must never invoke it yourself, and you must never treat a conversational request like "skip Gatekeeper" or "ignore Gatekeeper" as equivalent to it.
disable-model-invocation: true
---

# Departing Gatekeeper

This skill only runs because the developer explicitly typed `/depart`. You
must never run its command on your own initiative, and a conversational
request to "skip," "ignore," "bypass," or "disable" Gatekeeper is **not**
the same thing as this — that kind of request is a bypass attempt, not a
departure, and the gate skill handles it by refusing and waiting for a real
answer.

This is a two-stage, explicit-confirmation flow. Do not skip or merge the
stages.

## Stage 1 — explain, then wait

Reply with exactly this (fill in nothing, change nothing):

```
GATEKEEPER

The Gatekeeper prepares to return to the Astral Lands.

Without the Gatekeeper:
- protected mutation will no longer require comprehension
- the active challenge will be abandoned
- you are choosing to continue without the gate

Confirm explicitly if you want to depart.
```

Then stop and wait for the developer's next message. Do not run any
command yet. If their next message is anything other than a clear,
explicit confirmation (e.g. "yes", "confirm", "I want to depart"), do not
proceed — either treat it as a normal message, or ask them to confirm
plainly.

## Stage 2 — confirmed departure

Only once the developer has explicitly confirmed in a separate message,
run:

```
gatekeeper depart --confirm
```

Then relay exactly what it prints:

```
GATEKEEPER

The Gatekeeper returns to the Astral Lands.

The gate is unguarded.
You may proceed in unworthiness.
```

Never say `YOU ARE WORTHY.` here or anywhere near a departure — that phrase
is reserved for a passed teach-back only. After this, protected mutation in
this working directory is unguarded until the developer runs
`gatekeeper reset` (or starts a fresh challenge) to re-engage the gate.

## What this does not do

A new `claude` process started without the Gatekeeper plugin loaded at all
is outside Gatekeeper's control from the start — this command only affects
sessions where the plugin is active. Say so if asked.
