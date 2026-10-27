# claudematrix

A Matrix bot that gives each room its own [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session, and lets agents in different rooms address each other. Two TypeScript files and a transport, minimal dependencies.

A Node process holds one `/sync` connection and spawns **one `claude -p` per message** in that room's working directory, showing a typing indicator while the turn runs and posting every text block of the turn verbatim, in order, as one message — including what the model said between tool calls, which the CLI's own `result` field drops. There is no reply tool and no persistent interactive session: what the model writes is what the room sees.

Originally [ecmulli/claudecord](https://github.com/ecmulli/claudecord), a Discord bot, which is where the `channel` vocabulary in older configs comes from.

## Features

- **Room routing** — map Matrix room IDs to agents in `room-config.json` (hot-reloaded). Each room has its own cwd, model, system prompt, tool denials and persistent session.
- **Thread sessions** — a threaded conversation gets its own session, so clearing context is starting a new thread rather than running a command.
- **Sibling messaging** — an agent reaches another with the `message` tool. The text is posted into the shared room, the answer is routed back to the thread that asked, and if none comes the sender is woken once after a timeout. See [Addressing](#addressing).
- **Speaker labels** — who spoke is a label the gateway adds, who a message is for is a mention, and the two are never merged.
- **`humans`** — Matrix has no bot flag, so an explicit MXID list per room is the whole distinction. It is also the only thing that can answer a confirmation.
- **Confirmations** — `AskUserQuestion` renders as a numbered list and blocks the session until somebody on the `humans` list answers.
- **NO_RESPONSE** — a turn may decline to post anything, which is how an exchange ends gracefully.
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

An agent reaches another with the **`message` tool** — `message(to, text, expect_reply?)` — served by a small MCP server (`src/mcp-siblings.mjs`) that the CLI starts for each turn from a `--mcp-config` the gateway writes. The server holds nothing; each call goes to the gateway on localhost with a token that is valid only while that turn runs.

The gateway posts `text` into the shared room with an `m.mentions` for the recipient, which is what wakes them:

1. You and `bob` are talking in `bob`'s own room, in a thread.
2. `bob` calls `message("alice", …)`. The text — and only the text — is posted into the shared room, and a row in the `bridge` table remembers which thread it came from. Later messages from the same thread go into the same shared-room thread, so one conversation stays one conversation on both sides.
3. `alice` wakes in that shared-room thread and answers with `message("bob", …)`. Plain text it writes there is posted for the room and reaches no agent.
4. `bob`'s gateway recognises the thread, posts `alice`'s answer into the original thread labelled `[alice — an agent, not a human]`, and runs the next turn in **that** session.

**The tool result is the only acknowledgement.** It says how the sender will be woken: by the answer, or once when `replyTimeoutMinutes` (default 5) passes with none, when the gateway starts a turn in the sender's conversation saying so. The deadline is in SQLite, so it survives a restart. Nothing is asked of the recipient, so there is no chain of acknowledgements. `expect_reply: false` sets no deadline.

Nobody joins anything. The shared room is the only room both accounts are in, which on a homeserver where agents are power level 0 and `invite` is 100 is the only room either of them *can* post into — so it is also, for free, the one room where every message between agents is visible.

Who *wrote* a message is the label the gateway puts on it; who it is *for* is the mention. The two are never merged, and a label is not something an agent can write.

### What it does not do

A recipient is not sandboxed. It reads everything in the room it is in, as any Matrix member does, and threads are not an access-control boundary — they are a relation on events. The scoping is that **only the tool's `text` crosses**, not that the recipient is confined.

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

`room-config.json`, hot-reloaded on save, gitignored. `channels` / `configuredChannelsOnly` still load as key names; the startup line says whether the file loaded.

| Key | What |
|---|---|
| `name` | Label, used in logs and `!rooms`. |
| `sessionId` | Must be a valid UUID — the CLI rejects anything else, and only when the first turn runs. Warned about at startup instead. |
| `workingDirectory` | `cwd` for the turn, which is what decides whose `CLAUDE.md` is injected. |
| `model` | Passed to `--model`. Overwrites the session's model every turn, so `!model` does not stick in a configured room. |
| `systemPrompt` / `systemPromptMode` | Appended to Claude Code's own prompt. `"replace"` replaces it, including its tool-use guidance. |
| `replyInThread` | Open a thread on every top-level message here, giving each exchange its own session. |
| `requireMention` | Answer only when addressed: `m.mentions` (which the `message` tool sets) or a pill. The agent's name in plain text does not count. |
| `allowBots` | Admit messages from senders not on the `humans` list, labelled `[name — an agent, not a human]`. Also gives the room the `message` tool. |
| `humans` | MXIDs that count as human here. Falls back to `defaultHumans`; absent both, everyone is human. |
| `relayRoom` | The shared room the `message` tool posts into from here. |
| `replyTimeoutMinutes` | Minutes before a sibling's silence wakes the sender of a `message` that expects an answer. Default 5; also settable under `defaults`. |
| `fetchHistory` | Prepend recent room messages to the prompt. Default true; off is usually what you want in a room with several speakers. |
| `mcpConfig` | Path passed to `--mcp-config`. A claude.ai connector declared there as a `claudeai-proxy` server loads before the first model request instead of racing it. |
| `disallowedTools` | Passed to `--disallowed-tools`, by name rather than as an allowlist, so a connector authenticated later cannot appear by surprise. |
| `sessionGroup` | Rooms sharing a group share one session. A thread overrides it. |
| `schedule` | `{ cron, timezone, prompt }` for a scheduled turn, or a list of them. `name` keys the job; each firing is a new session, and a reply in the thread of what it posted continues that session; `fresh: true` also leaves no transcript (and no thread to continue); `newTranscripts: <dir>` fires only if a `*.jsonl` there changed since the job last succeeded, and lists the changed files at the end of the prompt; `thread: "Digest #{n} — {date}"` posts that line first and runs the job inside its thread, so a reply to the post is in its thread and resumes the session. |
| `contextFile` | A file prepended to the system prompt, hot-reloaded with the config. |

Top level: `rooms`, `defaults`, `defaultHumans`, `configuredRoomsOnly`.

## Things that cost somebody an afternoon

- `--session-id` must be a valid UUID, and the CLI only says so when a turn runs.
- `--disallowed-tools` is variadic, so bare words after it are swallowed as further rules. A rule matching no known tool only warns — a typo silently grants what it meant to withhold.
- `--permission-mode dontAsk` means don't ask, **deny**.
- In `stream-json`, the `result` event carries only the **last** text block. A turn that says something, calls a tool, and says something else has `result` equal to the second thing. Collect the `assistant` events instead.
- Deny rules apply under `bypassPermissions`; allow rules do not, because everything is already allowed.
- `bypassPermissions` refuses to start as root. `IS_SANDBOX=1` clears it; `CLAUDE_CODE_IN_SANDBOX=1` does not.
- `CLAUDE_CODE_OAUTH_TOKEN` beats `~/.claude/.credentials.json` and declares `user:inference` only, so a setup-token session can never see claude.ai connectors however many times you log in beside it. The gateway blanks it when a credentials file exists.
- The first line of `--output-format stream-json` is a `rate_limit_event`, not `init`.
- `-p` does not wake on pushed events; it takes a turn when stdin delivers. Holding the connection out here is what removes that constraint rather than working around it.

## License

MIT, as upstream.
