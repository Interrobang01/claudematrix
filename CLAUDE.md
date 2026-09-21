# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A Matrix bot that gives each room its own Claude Code session. A Node process
holds one `/sync` connection and spawns **one `claude -p` per message**; the
child exits when the turn ends. Nothing runs between messages. Session
continuity is a UUID plus `--resume`, and the transcript lives in Claude Code's
own storage, not here.

- **Stack:** TypeScript, Node 22, matrix-bot-sdk, better-sqlite3, node-cron.
- **Entry point:** `src/index.ts` — routing, sessions, spend, the relay.
- **Transport:** `src/matrix.ts` — presents a `Room` you can `send()` to and a
  `Msg` you can `edit()`/`reply()`/`delete()`. The policy code above it never
  touches Matrix.
- **Addressing:** `src/relay.ts` — the `<name>...</name>` block, its parsing and
  its rendering.
- **Origin:** a fork of [ecmulli/claudecord](https://github.com/ecmulli/claudecord),
  which is itself fredchu/discord-claude-code-bot plus channel routing. The
  Discord vocabulary in old config files comes from there.

## Flow

```
room message → gating → session key → claude -p --resume <uuid> → message posted
                                   ↘ <name> block → shared room → bridge row
                    bridged reply ← ↙
```

## Things to know before changing anything

- **`claude -p` is the only path that spends a subscription.** Anything built on
  `@anthropic-ai/claude-agent-sdk` draws the capped Agent-SDK credit bucket
  instead. Do not "modernise" the spawn.
- **`--append-system-prompt`, never `--system-prompt`.** Replacing drops Claude
  Code's own tool-use guidance along with everything else. `systemPromptMode:
  "replace"` exists and is opt-in for that reason.
- **`--disallowed-tools` is variadic.** The prompt goes in `-p` up front, never
  positionally, or it is swallowed as another rule.
- **Deny rules survive `bypassPermissions`; allow rules do not.**
- **`--session-id` must be a UUID**, and the CLI only says so when a turn runs.
  Startup warns instead.
- **A tag is not evidence.** `<name>` says who a message is *for* and is written
  by whoever wrote the message. `[Name]` says who *wrote* it and is put on by
  the gateway. Never merge them, and never let a tag decide trust.
- **`humans` is the trust boundary**, not the room. A confirmation blocks its
  session until somebody on that list answers.
- **A thread is not an access-control boundary.** It is a relation on events;
  anyone in the room reads all of it. Scoping here comes from forwarding only
  the tagged block, never from confining a recipient.
- **Verify behaviour, not the config value.** This codebase has a history of
  keys that were read by nothing (`replyInThread` sat inert in the config for
  months) and of configs that silently failed to load. New config keys need a
  startup line proving they were seen.

## Layout

```
src/index.ts              routing, sessions, spend, relay, commands, cron
src/matrix.ts             transport
src/relay.ts              <name> parsing and rendering
room-config.json          per-room agents (gitignored, hot-reloaded)
.env                      homeserver URL, access token, DEFAULT_CWD, CLAUDE_BIN
threads.db                SQLite (WAL): sessions, and the relay bridge
matrix-sync.json          /sync token (gitignored)
```

## Checks

`npm run check` (`tsc --noEmit`). There is no test suite; the relay parser is
the part most worth exercising by hand before a deploy.
