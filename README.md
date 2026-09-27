# pi-thinking-compact-lite

**Uniform thinking compaction** for Pi Agent — head-truncate (or drop) every thinking block on the
way out, so a long session stops paying for reasoning it no longer needs.

> **Only the zai route benefits.** On DeepSeek-family routes the server ignores thinking fields
> entirely, so the extension changes nothing there. DeepSeek-family APIs let you keep thinking
> history out of the context; the zai Coding Plan does not. z.ai's own docs describe "Preserved
> Thinking" as **default ON on the Coding Plan endpoint and default OFF on the standard API
> endpoint** ([thinking-mode](https://docs.z.ai/guides/capabilities/thinking-mode)); measured here,
> sending `clear_thinking: true` to the Coding Plan endpoint is ignored as well (prompt tokens
> unchanged, with pi out of the loop entirely — see Requirements). Had zai allowed thinking to be
> filtered the way DeepSeek does, there would have been no reason to write this extension at all.

No extra service, no judgements, no network calls of its own: one deterministic rule, applied
idempotently to the pristine transcript pi re-delivers on every request — which is exactly what
keeps the provider prefix cache hitting.

> **⚠️ Experimental software.** This extension is experimental and is provided "as is", without
> warranty of any kind. **The author assumes no responsibility whatsoever** for any damage or loss
> arising from its use, including billing on your model provider, changes to the endpoints it
> depends on, or any effect on answer quality. Use at your own risk.

## Install

### Option 1: `pi install` (recommended)

```sh
pi install https://github.com/pcparts001/pi-thinking-compact-lite
```

**Uninstall:**

```sh
pi remove https://github.com/pcparts001/pi-thinking-compact-lite
```

This removes the entry from `settings.json` and deletes the cloned directory.

### Option 2: manual placement

```sh
git clone https://github.com/pcparts001/pi-thinking-compact-lite.git \
  ~/.pi/agent/extensions/pi-thinking-compact-lite
```

`package.json` declares the entry point via `pi.extensions` (and pi would also find `index.ts` at the
repository root), so no file renaming is required. Placed this way the extension is only a few tens of
KB, because nothing runs `npm install`. The directory name is yours to choose and has no effect on the
runtime: the command is `/thinking-compact` either way.

**Uninstall** — a manual clone has no `settings.json` entry, so `pi remove` reports
`No matching package found` (pi 0.87.1) and changes nothing. Delete the directory instead:

```sh
rm -rf ~/.pi/agent/extensions/pi-thinking-compact-lite
```

**Update** with `git pull` (this clone is not managed by `pi update`):

```sh
git -C ~/.pi/agent/extensions/pi-thinking-compact-lite pull
```

Either way, the allowlist must be set or **nothing happens at all** (see Requirements).

## About this extension

### The problem

A Pi session carries every past thinking block to the model on every request. On the one route where
thinking history is context-counted (see "Where this has any effect"), that history accumulates: in a
measured real session, thinking plus tool-call arguments made up ~65% of the outgoing context. Most of
a *finished* reasoning block is redundant — its conclusion (the tool call it produced, the text it
wrote) is already in the transcript.

### What this extension does

One rule, applied to the outgoing view of every LLM request:

| Behavior | What goes on the wire |
|---|---|
| `truncate` (default) | head excerpt (default 600 chars ≈ 150 tok) + a marker, for every thinking block longer than the excerpt |
| `drop` | thinking blocks are omitted entirely |

- Blocks shorter than the excerpt are sent unchanged.
- An assistant message whose content would become empty is left as-is (an empty content array is
  malformed downstream).
- Only the **outgoing request view** is transformed. The session file, the transcript and the UI are
  untouched — disabling the extension restores stock behavior exactly.

### Why it is cache-safe by construction

Pi re-delivers the **pristine (untransformed) transcript** at every request and uses the handler's
result for that request only; the session is never rewritten
(`pi-agent-core/dist/agent-loop.js`, `streamAssistantResponse()` — pi 0.87.1). This extension therefore re-applies
the *same deterministic rule* to the *same pristine input* on every request — the same input plus the
same parameters always produce byte-identical output, which is precisely the condition for the
provider prefix cache to keep hitting while thinking shrinks.

There is no "pin phase" and no per-block decision to race: the rule is uniform, so a block's shape is
stable from its first send onward.

### Measured results

All numbers below are the author's own measurements, from a replay benchmark run over a **real
150-thinking-block session** on the live zai route (glm-5.3-flash), recorded to JSONL. That session,
the replay script and the result files are **not shipped in this package** — treat these as reported
evidence, not as a benchmark you can re-run from what you install here.

**Replay, 30 aligned requests:**

| Condition | Input total | Cached | Cache % | vs off |
|---|---|---|---|---|
| off | 1,180,055 | 1,128,640 | 95.6% | — |
| `truncate` | 871,760 | 826,176 | 94.8% | **−26.1%** |
| `drop` | 816,994 | 775,232 | 94.9% | **−30.8%** |

**Replay, 40 aligned requests:**

| Condition | Input total | Cache % | vs off |
|---|---|---|---|
| off | 1,882,803 | 96.9% | — |
| `truncate` | 1,355,768 | 96.2% | **−28.0%** |

**Prefix-cache safety (the design's core claim):** the tail requests keep a 96–100% cache hit in every
condition — removing thinking never rewrote the outgoing prefix.

**Live headless A/B (`pi -p`, deterministic tasks, the author's fixtures):** task quality was unchanged in every arm
(5/5, 12/12 on the file-reading fixtures; 8.0–8.3/10 on a large-output report task). On *short*
conversations the input saving (−3.5…−8.7%) is largely offset by output/reasoning rising +13…35% (the
model re-derives what was cut); the saving compounds on long sessions, which is where thinking
accumulates.

**End-to-end wire check:** in a real `pi -p` run on zai, the excerpt rides `reasoning_content` at
≤600 chars + marker, with no provider signatures on the wire.

## Requirements

### Model allowlist (required)

`THINKING_COMPACT_MODELS` is the only required setting. **Unset (or null) means the extension does
nothing at all** — no transform, no logs, no notice. Comma-separated `provider/id`, with `*` wildcards
per segment (`zai/*`, `zai/glm-5.3-flash`, `*/glm-5.3*`). An empty string is a kill switch: everything
stops, including for models that were previously allowed.

```sh
export THINKING_COMPACT_MODELS="zai/glm-5.3-flash"
```

### Where this has any effect (the zai route)

Measured on the wire by comparing request token counts with and without thinking history (the row
marked *docs* comes from z.ai's documentation rather than from a measurement here):

| Route | Does thinking history reach the model's context? | This extension |
|---|---|---|
| **zai** Coding Plan (glm-5.3 / glm-5.3-flash) | **Yes** — `reasoning_content` is context-counted and billed (measured Δ+201…250 tok). "Preserved Thinking" is **default ON** on this endpoint (z.ai docs); measured, `clear_thinking: true` is ignored there too | **the one route it serves** |
| **zai** standard API (`paas/v4`, metered) *docs* | No — "Preserved Thinking" is **default OFF** on the standard API endpoint, so thinking history is not carried | nothing to save |
| DeepSeek official API | No (measured Δ0 on both `deepseek-chat` and `deepseek-reasoner`) | nothing to save |
| Command Code proxy (DeepSeek / GLM) | No (measured Δ0) | nothing to save |

On the routes in the lower rows this extension still runs, but it changes nothing — keep the allowlist
tight.

### No API keys

This extension makes **no calls of its own**. It needs no key and adds no latency beyond the local
string work.

## Privacy & data flow

| Direction | Content |
|---|---|
| **Sent anywhere new** | nothing. The only outbound request is the model request pi was already making |
| **Written locally** | `~/.pi/agent/thinking-compact/runs.jsonl`: timestamp, cwd, session id, model, block **hash**, block **length**, action, and characters saved. **Thinking bodies and prompt text are never written.** Disable with `THINKING_COMPACT_LOG=off` |
| **Never touched** | the session file, the transcript, the UI, images/attachments |

## Experimental — no warranty

This extension is **experimental software** and is provided "as is", without warranty of any kind. The
author assumes no responsibility whatsoever for any damage or loss arising from its use, including
billing changes on your model provider or any effect on answer quality.

Behavior described in this README was verified against **pi 0.87.1**. pi internals — the extension
event names, `settings.json`, `hideThinkingBlock`, the `pi.extensions` entry point, and the CLI
messages quoted above — can change between releases, and this extension may need updating when they do.

## Usage

### Automatic triggering

No user action is needed. On every LLM request:

```
request messages
  -> model gate (THINKING_COMPACT_MODELS)         # not allowed -> untouched
  -> every assistant thinking block: truncate | drop
  -> one notice (only when a NEW block was actually shortened) + one log record + one appendEntry
  -> transformed view is used for THIS request only
```

- The transform is **per request**, not a background job — there is nothing to wait for.
- `pi`'s `hideThinkingBlock` setting is **display-only**: hidden thinking blocks are still in the
  transcript, so they are still compacted.
- A model outside the allowlist is left completely alone.

### Commands

| Command | Behavior | Gate |
|---|---|---|
| `/thinking-compact` | show whether the extension is enabled, the current model, the allowlist, whether the model is allowed, the action and excerpt size, how many block identities were seen, how many characters were saved, and the log path | — |
| `/thinking-compact on` / `off` | toggle. Off stops transforming immediately; re-enabling rewrites the prefix once (see Known limitations) | — |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `THINKING_COMPACT_MODELS` | *(unset = off)* | **required to do anything.** Comma-separated `provider/id` allowlist with per-segment `*` wildcards. Unset = fully off; empty = kill switch |
| `THINKING_COMPACT_LOG` | `~/.pi/agent/thinking-compact/runs.jsonl` | run log (`off` disables). Hashes and lengths only |
| `THINKING_COMPACT_NOTIFY` | on | `off` disables the one-line UI notice |

## How it works

```
context_with_system (pi assembles the outgoing messages for an LLM call)
  -> gated?                        enabled AND model matches the allowlist   (otherwise: return, untouched)
  -> any assistant thinking block? (otherwise: return, untouched)
  -> for every thinking block:
       truncate -> head excerpt (built by code) + marker, carrier re-carried
       drop     -> block omitted
  -> notice / log / appendEntry for block identities seen for the first time
  -> return the new array        (pi uses it for this request only; the session is untouched)
```

**The carrier note that matters:** pi-ai picks the wire field from `thinkingSignature`. Stripping the
signature makes the reasoning vanish from the request entirely — so a "truncate" would silently become
a "drop". Truncated blocks therefore re-carry `thinkingSignature: "reasoning_content"`, which is the
field the pristine block used on this route.

## Known limitations

- **Only the zai route benefits** (see Requirements). On DeepSeek-family routes the server ignores
  thinking fields, so the extension changes nothing.
- **The 601–651 character band grows slightly.** The rule is "≤600 chars pass through, longer is cut
  to 600 + marker (52 chars)", so a block of 601–651 chars comes out at 652 chars — up to 51 characters
  longer than it started. Net savings begin above 652 chars. The effect is tiny (≈13 tok per block) but
  it is the opposite of the extension's intent; it is measured and reported honestly here.
- **The UI notice is deliberately quiet.** It appears only for the *first* sighting of a block
  identity, and only when the block was actually shortened. Blocks ≤600 chars are logged as
  `kept-short` but produce no notice, and re-sending the same block never notifies again. In practice
  most thinking blocks in a real session are below 600 chars, so long stretches with no notice are
  normal — the log (`runs.jsonl`) and `blocks seen` in `/thinking-compact` are the proof it still runs.
- **Toggling off → on costs one prefix rewrite.** There is no pin phase and no memory across the
  toggle, so the first requests after re-enabling re-register a prefix. Measured on a replay: a
  2-request miss (+31,386 non-cached tokens), byte-stable from request 7 onward, +0.2% overall.
- **Short conversations can cancel out.** The output/reasoning increase measured on short sessions
  (+13…35%) is the model re-deriving what was removed. The saving is meant for long, thinking-heavy
  sessions.
- **Dropping everything can increase output reasoning.** In a live probe, removing all previous
  thinking (including the most recent block) made the model reason more (145 vs 89 tokens). With the
  default `truncate` this is mitigated; a full `drop` is the aggressive setting.
- **Identity is the content hash.** Two identical thinking blocks anywhere in the transcript share one
  identity and therefore one treatment. This is safe (they transform identically) but the saved
  characters are attributed once.
- **In-memory state grows within a session.** One 16-character hash per distinct block identity is
  kept so the notice/log fire once; it is cleared at `session_start`.
- **Not verified on the Anthropic native API.** Anthropic documents thinking blocks as required while
  a tool loop is open. On such routes keep `truncate` and expect the block to still be sent (the
  extension is not a correctness risk there, only a lost saving).

## License

MIT
