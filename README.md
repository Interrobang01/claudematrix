# claudematrix

A Matrix bot that gives each room its own [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session, and lets agents in different rooms address each other. Two TypeScript files and a transport, minimal dependencies.

A Node process holds one `/sync` connection and spawns **one `claude -p` per message** in that room's working directory, streaming a live preview while the turn runs and posting the final assistant message verbatim. There is no reply tool and no persistent interactive session: what the model writes is what the room sees.

Originally [ecmulli/claudecord](https://github.com/ecmulli/claudecord), a Discord bot, which is where the `channel` vocabulary in older configs comes from.

## Features

- **Room routing** — map Matrix room IDs to agents in `room-config.json` (hot-reloaded). Each room has its own cwd, model, system prompt, tool denials, spend ceiling and persistent session.
- **Thread sessions** — a threaded conversation gets its own session, so clearing context is starting a new thread rather than running a command.
- **Sibling addressing** — an agent reaches another by writing `<name>...</name>`. In a shared room that is a wake signal; from a private room the block is forwarded into the shared room and the answer is routed back to the thread that asked. See [Addressing](#addressing).
- **`[Name]` prefixes** — who spoke is a prefix, who a message is for is a tag, and the two are never merged.
- **`humans`** — Matrix has no bot flag, so an explicit MXID list per room is the whole distinction. It is also the only thing that can answer a confirmation.
- **Confirmations** — `AskUserQuestion` renders as a numbered list and blocks the session until somebody on the `humans` list answers.
- **NO_RESPONSE** — a turn may decline to post anything, which is how an exchange ends gracefully.
- **Spend ceilings** — per-turn (`--max-budget-usd`) and per-day dollar caps, charged to the room the conversation lives in.
- **Attachments** — `mxc://` media downloaded and handed to Claude Code as files.
- **Scheduled jobs** — cron agents that post into a room on a schedule.
- **SQLite storage** — WAL, crash-safe session and bridge persistence.
- **Commands** — `!help`, `!new`, `!model`, `!cd`, `!stop`, `!sessions`, `!rooms`, `!reload-config`.

## Quick start

```bash
git clone https://github.com/Interrobang01/claudematrix.git
cd claudematrix
npm install

cp .env.example .env                              # homeserver URL + access token
cp room-config.example.json room-config.json      # real room IDs
npm start
```

### Prerequisites

- Node.js 22+ (uses `--env-file`)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed and authenticated
- A Matrix account for the bot, and its access token
- `better-sqlite3` installs from a prebuild on common platforms; otherwise a C++ toolchain

`claude -p` spends a Claude subscription. Harnesses built on `@anthropic-ai/claude-agent-sdk` draw the capped Agent-SDK credit bucket instead, which is a different thing to run out of.

## Addressing

An agent addresses somebody by wrapping what it wants them to read in a tag named after them:

```
on it.

<emet>survey the July changelogs and leave a summary in /srv/emet-share</emet>
```

The tag names the **addressee**. Who *wrote* a message is the `[Name]` prefix the gateway puts on it, and the two are kept apart on purpose: a tag is a routing label written by whoever wrote the message, and it is not evidence of anything.

In a room both parties are already in, the tag is only a wake signal — it routes the message the way a mention does. A room with `relayRoom` set also **forwards** the block into that room, which is how an agent reaches a sibling who is not here:

1. You and `oman` are talking in `oman`'s own room, in a thread.
2. `oman` writes `<emet>…</emet>`. The block — and only the block, never the rest of the turn — is posted into the shared room, and a row in the `bridge` table remembers which thread it came from.
3. `emet` is in the shared room. The tag wakes it, its reply opens a thread on the relayed message, and it answers with `<oman>…</oman>`.
4. `oman`'s gateway recognises the thread, posts `emet`'s answer into the original thread labelled `[Emet]`, and runs the next turn in **that** session.

Nobody joins anything. The shared room is the only room both accounts are in, which on a homeserver where agents are power level 0 and `invite` is 100 is the only room either of them *can* post into — so it is also, for free, the one room where every message between agents is visible.

Only the tagged block crosses. A turn written for a human is full of context meant for that human; what reaches another agent is exactly what was wrapped.

### What it does not do

An addressed agent is not sandboxed by the tag. It reads everything in the room it is in, as any Matrix member does, and threads are not an access-control boundary — they are a relation on events. The scoping here is that **the block is the only thing forwarded**, not that the recipient is confined.

`<b>`, `<code>` and the rest of the HTML element names are excluded, so ordinary markup is not mistaken for addressing. A tag inside a code fence is left alone.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | Yes | The homeserver's client API. Use the address the bot can reach directly; a public hostname routes your agents through whatever is in front of it. |
| `MATRIX_ACCESS_TOKEN` | Yes | Access token for the bot's account. |
| `DEFAULT_CWD` | No | Working directory for rooms with no configured one. |
| `CLAUDE_BIN` | No | Path to the `claude` binary. Defaults to `claude` on `PATH`. |
| `MATRIX_STORAGE` | No | Where the `/sync` token is kept. Defaults to `./matrix-sync.json`. |
| `SILENT_TOKEN` | No | The literal a turn emits to post nothing. Defaults to `NO_RESPONSE`. |

## Room config

`room-config.json`, hot-reloaded on save, gitignored. `channel-config.json` is still read if that is what is on disk, and `channels` / `configuredChannelsOnly` still load as key names; the startup line says which file was used.

| Key | What |
|---|---|
| `name` | Label, used in logs and `!rooms`. |
| `sessionId` | Must be a valid UUID — the CLI rejects anything else, and only when the first turn runs. Warned about at startup instead. |
| `workingDirectory` | `cwd` for the turn, which is what decides whose `CLAUDE.md` is injected. |
| `model` | Passed to `--model`. Overwrites the session's model every turn, so `!model` does not stick in a configured room. |
| `systemPrompt` / `systemPromptMode` | Appended to Claude Code's own prompt. `"replace"` replaces it, including its tool-use guidance. |
| `replyInThread` | Open a thread on every top-level message here, giving each exchange its own session. |
| `requireMention` / `mentionPatterns` | Answer only when addressed. A `<name>` block addressed to this agent always counts. |
| `allowBots` | Admit messages from senders not on the `humans` list, labelled `[Name]`. |
| `humans` | MXIDs that count as human here. Falls back to `defaultHumans`; absent both, everyone is human. |
| `relayRoom` | Where a block addressed to somebody not in this room is forwarded. |
| `fetchHistory` | Prepend recent room messages to the prompt. Default true; off is usually what you want in a room with several speakers. |
| `disallowedTools` | Passed to `--disallowed-tools`, by name rather than as an allowlist, so a connector authenticated later cannot appear by surprise. |
| `maxCostUsdPerTurn` / `maxCostUsdPerDay` | Per-turn `--max-budget-usd`; per-day total in memory, so a restart forgives the day. |
| `sessionGroup` | Rooms sharing a group share one session. A thread overrides it. |
| `schedule` | `{ cron, timezone, prompt }` for a scheduled turn. |
| `contextFile` | A file prepended to the system prompt, hot-reloaded with the config. |

Top level: `rooms`, `defaults`, `defaultHumans`, `configuredRoomsOnly`.

## Things that cost somebody an afternoon

- `--session-id` must be a valid UUID, and the CLI only says so when a turn runs.
- `--disallowed-tools` is variadic, so bare words after it are swallowed as further rules. A rule matching no known tool only warns — a typo silently grants what it meant to withhold.
- `--permission-mode dontAsk` means don't ask, **deny**.
- Deny rules apply under `bypassPermissions`; allow rules do not, because everything is already allowed.
- `bypassPermissions` refuses to start as root. `IS_SANDBOX=1` clears it; `CLAUDE_CODE_IN_SANDBOX=1` does not.
- `CLAUDE_CODE_OAUTH_TOKEN` beats `~/.claude/.credentials.json` and declares `user:inference` only, so a setup-token session can never see claude.ai connectors however many times you log in beside it. The gateway blanks it when a credentials file exists.
- The first line of `--output-format stream-json` is a `rate_limit_event`, not `init`.
- `-p` does not wake on pushed events; it takes a turn when stdin delivers. Holding the connection out here is what removes that constraint rather than working around it.

## License

MIT, as upstream.
