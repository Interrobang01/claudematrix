# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A Matrix bot that gives each room its own Claude Code session. A Node process
holds one `/sync` connection and spawns **one `claude -p` per message**; the
child exits when the turn ends. Nothing runs between messages. Session
continuity is a UUID plus `--resume`, and the transcript lives in Claude Code's
own storage, not here.

- **Stack:** TypeScript, Node 22, matrix-bot-sdk, better-sqlite3, node-cron.
- **Entry point:** `src/index.ts` — routing, sessions, the relay.
- **Transport:** `src/matrix.ts` — presents a `Room` you can `send()` to and a
  `Msg` you can `edit()`/`reply()`/`delete()`. The policy code above it never
  touches Matrix.
- **Sibling messaging:** the `message` tool. `src/mcp-siblings.mjs` is a stdio MCP
  server the CLI starts per turn; it POSTs to the gateway's localhost endpoint,
  which posts into the shared room and keeps the reply deadline. The `<name>`
  tag it replaced was removed in 1.8.0.
- **Origin:** a fork of [ecmulli/claudecord](https://github.com/ecmulli/claudecord),
  which is itself fredchu/discord-claude-code-bot plus channel routing. The
  Discord vocabulary in old config files comes from there.

## Flow

```
room message → gating → session key → claude -p --resume <uuid> → message posted
                                   ↘ message tool → shared room → bridge row (+ deadline)
                    bridged reply ← ↙        deadline passes → one wake turn
```

## Things to know before changing anything

- **`claude -p` is the only path that spends a subscription.** Anything built on
  `@anthropic-ai/claude-agent-sdk` draws the capped Agent-SDK credit bucket
  instead. Do not "modernise" the spawn.
- **`--append-system-prompt`, never `--system-prompt`.** Replacing drops Claude
  Code's own tool-use guidance along with everything else. `systemPromptMode:
  "replace"` exists and is opt-in for that reason.
- **`--disallowed-tools` is variadic, and `-p` is a bare flag.** The prompt is
  positional: last, after `--`, so neither a variadic option swallows it nor a
  prompt starting with `-` is parsed as an option.
- **Deny rules survive `bypassPermissions`; allow rules do not.**
- **`--session-id` must be a UUID**, and the CLI only says so when a turn runs.
  The gateway generates every one, so nothing user-supplied reaches it.
- **Every conversation is a thread.** A top-level message opens one rooted at
  itself; there are no room-level sessions (removed 1.13.0, unused since
  threading went on everywhere).
- **Addressing is not evidence.** The mention says who a message is *for* and is
  chosen by whoever wrote it. The `[name — an agent, not a human]` label says
  who *wrote* it and is put on by the gateway. Never merge them.
- **The `message` tool's result is the only acknowledgement.** It promises a
  wake: the answer, or one gateway turn at the deadline. The deadline lives in
  SQLite so a restart keeps it. Do not add acknowledgements from the recipient;
  that is how you end up needing infinitely many.
- **`wake_me` is the only scheduler a turn has.** Claude Code's own
  (`CronCreate`, `ScheduleWakeup`) live in the process, which exits with the
  turn, so they accept a job and drop it; the gateway withholds them in every
  turn. Background Bash does wake a `-p` process, but the gateway posts only
  at exit, holds the thread's lane, and kills the process at 90 min.
- **`mcp-siblings.mjs` is plain JS.** The CLI starts it with the agent's
  workspace as cwd, where tsx does not resolve, and Node 22 does not strip types.
- **`humans` is the trust boundary**, not the room. A confirmation blocks its
  session until somebody on that list answers.
- **A thread is not an access-control boundary.** It is a relation on events;
  anyone in the room reads all of it. Scoping here comes from sending only the
  tool's text, never from confining a recipient.
- **The posted message is every text block, not `result`.** stream-json's
  `result` is only the last block, so posting it drops whatever the model said
  before its last tool call. `NO_RESPONSE` is judged on the last block alone.
- **Anything the gateway says about a turn is `m.notice`.** The transport drops
  notices on the way in, so a status line can never be read as a turn by a
  sibling sharing the room.
- **No placeholder, no redactions.** A running turn shows only the typing
  indicator. Redacting a streamed placeholder left a "message deleted" per
  turn, and a redaction leaves the original's `m.replace` edits in place, which
  some clients render as a second copy of the answer.
- **Only an addressed message is routed home from a bridged thread.** A bridge
  row lives as long as its thread, so "anything from the addressee counts"
  (1.1.0) also caught the addressee answering a human there. Removed in 1.1.2.
- **Routing home needs a solicited sender.** A bot's message goes into the home
  session only if it mentions us, arrives in the home agent's `relayRoom`, and
  the sender is in `bridge_to` (everyone that conversation messaged in that
  thread; `addressee` is only the first). Otherwise it is unsolicited and
  `allowBots` decides, so `allowBots: false` means "nobody cold-messages me"
  while answers still arrive.
- **A file event's `body` may be the whole message.** It is a caption when
  `filename` is set and differs. Attachment files outlive the turn (14 days),
  because the session that was told their path does.
- **One request can arrive as several events.** Sable sends each attachment
  as its own top-level event, then the text. A bare top-level file is held (4 s quiet, 15 s cap) and the burst runs
  as one message rooted at its first event; text ends a burst immediately and
  is never itself delayed. Without this each file opened its own cold thread.
- **A scheduled job's silence is silent.** No `🤐` notice for cron runs, and
  `finalOnly` jobs post only the last text block, so narration stays out.
- **Verify behaviour, not the config value.** This codebase has a history of
  keys that were read by nothing (`replyInThread` sat inert in the config for
  months) and of configs that silently failed to load. New config keys need a
  startup line proving they were seen.

## Layout

```
src/index.ts              routing, sessions, relay, commands, cron
src/matrix.ts             transport
src/mcp-siblings.mjs      the message tool (stdio MCP, per turn)
room-config.json          per-room agents (gitignored, hot-reloaded)
.env                      homeserver URL, access token, DEFAULT_CWD, CLAUDE_BIN
threads.db                SQLite (WAL): sessions, the relay bridge, reply deadlines
matrix-sync.json          /sync token (gitignored)
```

## Checks

`npm run check` (`tsc --noEmit`). There is no test suite; the relay parser is
the part most worth exercising by hand before a deploy.
