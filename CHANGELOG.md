# Changelog

## 1.6.0 - 2026-10-15

### Changed
- **Every scheduled firing is its own session.** A job without `fresh` used to
  resume the room's session, so each run carried every earlier run; one daily
  job's session had reached 176K tokens over seven weeks with no reset. Now
  each firing starts a new session, and a reply in the thread of the message
  it posted resumes that session, so feedback on a scheduled post meets the
  turn that wrote it. `fresh: true` still means unpersisted, and its post has
  no session behind it.

## 1.5.1 - 2026-10-13

### Changed
- **No deployment names in the repo.** The `message` tool's description, the
  waiting-on-confirmation notice, comments, README, CHANGELOG and the example
  config named the agents and the operator of the deployment this was built
  for; they now say "the operator", "a human", `alice` and `bob`.

## 1.5.0 - 2026-10-13

### Added
- **Several schedules per room.** `schedule` takes a list.
- **`fresh: true`** on a schedule: each firing gets a new session run with
  `--no-session-persistence`, instead of accumulating in the room's session.
- **`newTranscripts: <dir>`** on a schedule: the job fires only if a `*.jsonl`
  in that directory changed since it last succeeded (first run: the last 24
  hours), and the changed files are appended to the prompt. Built for a
  nightly pass that writes down what finished threads learned. A fresh job
  leaves no transcript, so it never triggers itself. Last-run times are in a
  `schedule_runs` table and advance only on success.

### Fixed
- **Editing a schedule or a `humans` list did nothing until a restart.** The
  config hot-reload re-read the file but neither re-armed cron jobs nor pushed
  `humans` into the transport; it now does everything `!reload-config` does.

## 1.4.0 - 2026-10-13

### Added
- **The `message` tool.** Agents reach each other with `message(to, text,
  expect_reply?)` instead of writing `<name>` tags. A stdio MCP server
  (`src/mcp-siblings.mjs`) is attached to every turn in a room with
  `relayRoom` or `allowBots`, and posts through a localhost endpoint in the
  gateway with a per-turn token. The posted message carries `m.mentions`.
- **Reply deadlines.** A `message` that expects a reply records a deadline
  (`replyTimeoutMinutes`, default 5) in a new `pending` table. The answer
  clears it; otherwise the gateway wakes the sender's conversation once. The
  tool result says which, and is the only acknowledgement in the exchange.

### Changed
- A sibling's message is labelled `[name — an agent, not a human]` rather than
  `[Name]`.
- `package.json` version caught up; it had been left at 1.2.2.

### Deprecated
- `<name>` tags still route for one release, unmentioned in prompts.

## 1.3.0 - 2026-10-13

### Removed
- **Spend ceilings.** `maxCostUsdPerTurn`, `maxCostUsdPerDay` and the in-memory
  ledger are gone. The subscription's own usage window already bounds what a
  turn or a loop can cost, and the daily cap was reset by every restart anyway.
  Old configs still load; the keys are ignored.

## 1.2.2 - 2026-10-13

### Added
- **A message that waits on a running turn says so.** A session runs one turn
  at a time and a message cannot join a turn already running, so one arriving
  mid-turn (a sibling's answer during a long tool call, say) waited silently.
  It now gets an `m.notice` where the turn will run: queued, or dropped when
  `MAX_QUEUE_DEPTH` messages are already waiting.

## 1.2.1 - 2026-10-13

### Fixed
- **A `<name>` block reached the sibling only when the whole turn ended.**
  Blocks were forwarded after the CLI exited, and a turn that starts a
  background task keeps the CLI alive until the task finishes: a ping written
  before a backgrounded `sleep 60` arrived a minute late. Each block is now
  forwarded as soon as its text block completes. A consequence: a block in a
  turn that ends in `NO_RESPONSE` or an `AskUserQuestion` is forwarded too,
  where it used to be dropped with the rest of the turn.

## 1.2.0 - 2026-10-13

### Changed
- **One home thread relays into one shared-room thread.** Every `<name>` block
  used to open a new thread in the shared room, so an agent asking a sibling
  three things from one conversation produced three threads and three cold
  sibling sessions. Later blocks from the same home thread now post into the
  thread the first one opened, whoever they are addressed to.

## 1.1.4 - 2026-10-13

### Changed
- **A name in plain text is no longer a mention.** `bob` or `@bob` in a
  message body woke that agent, so a sibling saying "bob asked me" in the
  shared room started a turn nobody addressed. A mention is now `m.mentions`, a
  pill, a `<name>` tag, or an explicit `mentionPatterns` entry.

## 1.1.3 - 2026-10-13

### Changed
- **`NO_RESPONSE` leaves a trace.** The `Thinking...` placeholder used to be
  redacted, so from the room a deliberate silence looked exactly like a broken
  gateway. It is now edited into an `m.notice` reading `🤐 <name>: no
  response`, which no gateway reads as a turn. `Msg.edit` takes `{ notice }`.

## 1.1.2 - 2026-10-13

### Fixed
- **A sibling's answer to a human was routed to the agent that relayed.** 1.1.0
  routed any untagged message from the addressee in a bridged thread home, and
  a bridge row never expires, so once a human spoke in the thread the sibling's
  reply to *them* also went home. Removed: an answer routes home only when it
  carries the asker's tag. The prompts tell agents to tag answers.

## 1.1.1 - 2026-09-23

### Fixed
- **A block containing a backtick was invisible.** Tags were matched on each
  piece of text between code spans separately, so `<bob>Done: `/x`</bob>`
  had its opening and closing tag in different pieces and matched nothing — a
  correctly tagged answer was dropped at the mention gate, and a request with a
  path or command in it would never have been forwarded. Code spans are now
  blanked in a same-length copy and tags found there. This, not a missing tag,
  was the cause of the 2026-09-22 lost answer that 1.1.0 attributed to an
  untagged reply; 1.1.0's routing change stands as a second line of defence.

## 1.1.0 - 2026-09-23

### Fixed
- **Text written before the last tool call was never posted.** The gateway
  posted the CLI's `result`, which is only the final text block. The message is
  now every text block in order, and the live preview accumulates the same way.
  `NO_RESPONSE` is judged on the last block; a `<name>` block written before a
  tool call is now forwarded.
- **An untagged answer to a relayed request was lost.** The bridge lookup ran
  after the mention gate, so in a `requireMention` shared room a sibling's
  plain-text answer was posted and received by nobody, with no error. A message
  from the addressee in a bridged thread now routes home unless it is tagged
  only to somebody else.

### Changed
- The `Thinking...` placeholder and the gateway's error, budget and
  waiting-on-confirmation lines are sent as `m.notice`, so none of them can be
  taken as a sibling's answer.

### Added
- `mcpConfig`, per room, passed to `--mcp-config`.

## 1.0.0 - 2026-09-20

Renamed **claudecord → claudematrix**. The transport has been Matrix since
2026-08-29; the package, the README and the example config still described a
Discord bot, which made the repository the least accurate description of itself
available anywhere.

### Added
- **Sibling addressing.** An agent addresses another by writing
  `<name>...</name>`. In a shared room the tag is a wake signal; in a room with
  `relayRoom` set, the block — and only the block — is forwarded into that room,
  and a `bridge` row routes the answer back into the thread that asked for it.
  Nobody joins anything, and the whole exchange stays visible in the one room
  the operator is also in.
- `relayRoom`, per room.
- `[Name]` prefixes on relayed answers, regardless of the destination room's
  `allowBots`. Who spoke is the prefix; who a message is for is the tag.
- `bridge.hops`, counted and logged, so a runaway exchange is visible in the log
  and in the database while it is still running.
- `<name>` blocks render as a labelled quote. Matrix clients sanitize unknown
  HTML, so the tag would otherwise vanish from the rendered body while staying
  in the plaintext one.

### Changed
- **A confirmation can only be answered by somebody on the `humans` list.**
  Previously this was carried by the room: nobody but the operator could speak
  in an agent's own room, so anything arriving there was theirs. Relaying puts a
  sibling's words into that room, so the list has to be the ground truth the
  room was standing in for. A pending confirmation blocks its session; a
  relayed message arriving meanwhile is told so rather than dropped.
- `channel-config.json` → `room-config.json`, `channels` → `rooms`,
  `configuredChannelsOnly` → `configuredRoomsOnly`. All three old spellings
  still load — the file is gitignored, so a deployment's copy can only be
  renamed by hand — and the startup line names the file it used.
- Room config, spend ceiling and tool denials now follow the *conversation*
  rather than the room a message arrived in, so a relayed answer is charged and
  constrained where the work is happening.

### Removed
- **The bot-turn budget.** It was built when any message in a shared room woke
  every agent in it, so two agents being polite at each other was a live failure
  mode with no deliberate act behind it. Addressing is explicit now, and the
  ceiling had become actively wrong: it counted per room and suppressed
  silently, so a long legitimate exchange in one bridged thread would stop
  mid-sentence, in a room whose other conversations were fine. `maxCostUsdPerDay`
  and `NO_RESPONSE` remain; `bridge.hops` makes a loop visible instead.

## 0.8.2 - 2026-04-02

### Fixes
- Fix bot sessions not appearing in CC's `/resume` picker (CC 2.1.90+ filters `entrypoint:"sdk-cli"`)
- Patch session files after each run to rewrite entrypoint, making bot sessions discoverable

## 0.8.1 - 2026-04-02

### Improvements
- Increase task timeout from 30 to 90 minutes for long-running operations

## 0.8.0 - 2026-03-26

### Improvements
- System prompt now instructs Claude to avoid markdown tables (Discord cannot render them)
- Bold key-value line format for comparisons (mobile-friendly, no horizontal scrolling)
- Applied to both `SYSTEM_PROMPT` and `RESUME_SYSTEM_PROMPT`

## 0.7.0 - 2026-03-25

### Features
- File attachment support — images, code, PDFs, or any file sent in Discord are auto-downloaded and passed to Claude Code via the Read tool
- Type-agnostic design: no per-format handling, Claude Code decides how to read each file
- 10 MB per-file size limit, temp files auto-cleaned after response

## 0.6.0 - 2026-03-25

### Features
- `/resume-local` command — resume a local terminal Claude Code session from Discord (mobile use case)
  - Auto-discover active sessions from `~/.claude/sessions/` PID files
  - Fallback to recent sessions from `~/.claude/history.jsonl` with last prompt display
  - Select menu for multiple sessions, showing last prompt + project path
  - Blocks resume of still-running sessions (must `/quit` in terminal first)
- `/handback` command — hand session back to terminal, reset thread to fresh bot session
- Dedicated `RESUME_SYSTEM_PROMPT` for resumed sessions (lighter than bot system prompt)
- `isLocalResume` flag in DB to distinguish bot-created vs resumed sessions
- Capture stderr from Claude CLI — show error details instead of bare `(no output)`

## 0.5.0 - 2026-03-23

### Features
- Replace `thread-map.json` with SQLite (`better-sqlite3` + WAL mode) for crash-safe session storage
- Auto-migrate existing JSON data to SQLite on first startup (rename `.bak` after success)
- Per-entry upsert via `saveEntry()` instead of full-file overwrite
- Graceful shutdown on both SIGINT and SIGTERM (closes DB properly)

## 0.4.2 - 2026-03-23

### Fixes
- Rewrite `splitMessage` with segment-based approach — code blocks are never broken across Discord message chunks
- Oversized code blocks (>2000 chars) are split and re-wrapped with proper fences on each chunk
- Long AskUserQuestion replies now use `sendChunked` instead of truncating at 2000 chars

## 0.4.1 - 2026-03-23

### Fixes
- Fix duplicate message in thread history — current trigger message was included in the history block and appended again as prompt content

## 0.4.0 - 2026-03-23

### Features
- Interactive Discord buttons for AskUserQuestion permission prompts (replaces plain text)
- Button click resumes Claude session with user's choice
- Chained AskUserQuestion support (button → resume → another question → buttons again)
- "Other..." button option for free-text answers

### Improvements
- Extract `sendAskButtons` helper to deduplicate button rendering logic
- Extract `createToolUseHandler` helper to deduplicate streaming callbacks
- Add Discord customId length guard (`.slice(0, 100)`)
- Simplify redundant try/catch in button handler reply flow

## 0.3.0 - 2026-03-19

### Features
- Increase task timeout from 10 to 30 minutes for long-running operations
- Return partial results on timeout instead of empty error
- Show elapsed time in streaming preview (e.g. "working... (2m34s)")
- Display recent tool names in preview (e.g. "🔧 Read → Grep → Edit")

## 0.2.1 - 2026-03-19

### Fixes
- Send final reply as new message instead of editing preview, ensuring Discord push notifications are triggered

## 0.2.0 - 2026-03-16

### Features
- Streaming response with real-time Discord message updates (stream-json mode, 1.5s throttle, 40-char minimum delta)
- Long message auto-splitting for streaming output

### Fixes
- Correct ACP repository link in README

## 0.1.0 - 2026-03-09

### Features
- Discord thread ↔ Claude Code CLI session bridging with automatic `--resume`
- Thread context awareness (fetches last 30 messages)
- 6 slash commands: `/help`, `/new`, `/model`, `/cd`, `/stop`, `/sessions`
- Model switching per thread (opus, sonnet, haiku)
- Long responses sent as `.txt` attachments
- Typing indicator during Claude execution
- AI disclosure on first reply per session
