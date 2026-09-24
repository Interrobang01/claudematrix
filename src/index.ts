import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import cron from "node-cron";
import {
  MatrixTransport, MATRIX_MAX_LEN,
  type Msg, type Room, type IncomingMessage,
} from "./matrix.js";
import { relayBlocks, addressesUs } from "./relay.js";

// --- ThreadMap (SQLite-backed) ---

type ThreadEntry = {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  started: boolean;
  lastBotMessageId?: string;
  /** Set when an AskUserQuestion is on screen and unanswered. Only a human can
   *  clear it — see `onMessage`. Persisted, because a restart must not turn a
   *  pending confirmation into one a relayed message can answer. */
  awaitingAnswer?: number;
};

type ThreadMap = Record<string, ThreadEntry>;

const DB_PATH = path.join(import.meta.dirname, "..", "threads.db");
const JSON_PATH = path.join(import.meta.dirname, "..", "thread-map.json");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`CREATE TABLE IF NOT EXISTS threads (
  threadId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  lastBotMessageId TEXT
)`);

// Added after the fact; the table predates confirmations being gated.
if (!(db.prepare("PRAGMA table_info(threads)").all() as any[]).some((c) => c.name === "awaitingAnswer")) {
  db.exec("ALTER TABLE threads ADD COLUMN awaitingAnswer INTEGER");
}

// Which conversation a relayed block came from.
//
// An agent reaches a sibling by posting into the one room they share, because
// that is the only room its account can post into — every room here is
// `invite: 100` and every agent is power level 0, so no agent can open a
// private room with another even if it wanted to. The shared room is therefore
// also the log: every inter-agent message is visible in one room Terry is in,
// and that falls out of the power levels rather than needing its own mechanism.
//
// The cost is that the reply arrives in the shared room, a long way from the
// conversation that asked for it. This row is the way back: the thread root of
// the relayed message in the shared room, mapped to the session that sent it.
db.exec(`CREATE TABLE IF NOT EXISTS bridge (
  relayRootId  TEXT PRIMARY KEY,
  homeRoomId   TEXT NOT NULL,
  homeThreadRootId TEXT,
  homeThreadId TEXT NOT NULL,
  addressee    TEXT NOT NULL,
  hops         INTEGER NOT NULL DEFAULT 0,
  createdAt    INTEGER NOT NULL
)`);

const stmtBridgeGet = db.prepare("SELECT * FROM bridge WHERE relayRootId = ?");
const stmtBridgePut = db.prepare(
  `INSERT OR REPLACE INTO bridge (relayRootId, homeRoomId, homeThreadRootId, homeThreadId, addressee, hops, createdAt)
   VALUES (@relayRootId, @homeRoomId, @homeThreadRootId, @homeThreadId, @addressee, @hops, @createdAt)`,
);
const stmtBridgeHop = db.prepare("UPDATE bridge SET hops = hops + 1 WHERE relayRootId = ?");

type Bridge = {
  relayRootId: string;
  homeRoomId: string;
  homeThreadRootId: string | null;
  homeThreadId: string;
  addressee: string;
  hops: number;
};

function lookupBridge(relayRootId: string): Bridge | null {
  return (stmtBridgeGet.get(relayRootId) as Bridge | undefined) ?? null;
}

// One-time migration from JSON → SQLite
if (fs.existsSync(JSON_PATH)) {
  try {
    const old: ThreadMap = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO threads (threadId, sessionId, cwd, model, createdAt, started, lastBotMessageId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const migrate = db.transaction(() => {
      for (const [tid, e] of Object.entries(old)) {
        insert.run(tid, e.sessionId, e.cwd, e.model, e.createdAt, e.started ? 1 : 0, e.lastBotMessageId ?? null);
      }
    });
    migrate();
    fs.renameSync(JSON_PATH, JSON_PATH + ".bak");
    console.log(`[matrix-cc-bot] migrated ${Object.keys(old).length} threads from JSON → SQLite`);
  } catch (err) {
    console.error("[matrix-cc-bot] JSON migration failed:", err);
  }
}

// Prepared statements
const stmtGet = db.prepare("SELECT * FROM threads WHERE threadId = ?");
const stmtUpsert = db.prepare(
  `INSERT OR REPLACE INTO threads (threadId, sessionId, cwd, model, createdAt, started, lastBotMessageId, awaitingAnswer)
   VALUES (@threadId, @sessionId, @cwd, @model, @createdAt, @started, @lastBotMessageId, @awaitingAnswer)`,
);
const stmtAll = db.prepare("SELECT * FROM threads");

function rowToEntry(row: any): ThreadEntry {
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    model: row.model,
    createdAt: row.createdAt,
    started: !!row.started,
    lastBotMessageId: row.lastBotMessageId ?? undefined,
    awaitingAnswer: row.awaitingAnswer ?? undefined,
  };
}

function loadMap(): ThreadMap {
  const map: ThreadMap = {};
  for (const row of stmtAll.all() as any[]) {
    map[row.threadId] = rowToEntry(row);
  }
  return map;
}

function saveEntry(threadId: string, entry: ThreadEntry): void {
  stmtUpsert.run({
    threadId,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    model: entry.model,
    createdAt: entry.createdAt,
    started: entry.started ? 1 : 0,
    lastBotMessageId: entry.lastBotMessageId ?? null,
    awaitingAnswer: entry.awaitingAnswer ?? null,
  });
}

function getOrCreate(map: ThreadMap, threadId: string, defaultCwd: string, seedSessionId?: string): ThreadEntry {
  if (!map[threadId]) {
    const row = stmtGet.get(threadId) as any;
    if (row) {
      map[threadId] = rowToEntry(row);
    } else {
      map[threadId] = {
        sessionId: seedSessionId ?? crypto.randomUUID(),
        cwd: defaultCwd,
        model: "opus",
        createdAt: Date.now(),
        started: false,
      };
      saveEntry(threadId, map[threadId]);
    }
  }
  return map[threadId];
}

const CLAUDE_HOME = path.join(process.env.HOME ?? "", ".claude");

// --- Auth / child environment ---

// CLAUDE_CODE_OAUTH_TOKEN short-circuits ~/.claude/.credentials.json inside the
// CLI's credential resolver, and a token minted by `claude setup-token` declares
// only `user:inference`. So an inherited token silently strips the scopes a
// `claude /login` credential carries — `user:mcp_servers` among them, which is
// what gates claude.ai connectors — and nothing errors: the tool is simply
// absent. Prefer the stored credential when one exists, and blank the variable
// for the child so a value from a systemd EnvironmentFile cannot ride in on the
// `...process.env` spread.
const CREDENTIALS_PATH = path.join(CLAUDE_HOME, ".credentials.json");

function hasStoredCredentials(): boolean {
  try {
    return fs.statSync(CREDENTIALS_PATH).isFile();
  } catch {
    return false;
  }
}

// Checked per spawn rather than cached, so a `claude /login` run after the
// process started takes effect without a restart.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: undefined };
  if (hasStoredCredentials()) env.CLAUDE_CODE_OAUTH_TOKEN = "";
  // This bot's own bookkeeping is not the agent's business. The bot token in
  // particular would otherwise be readable from the agent's shell, which is a
  // credential for the identity it is speaking as.
  env.MATRIX_ACCESS_TOKEN = "";
  return env;
}

// --- Thread History ---

const SYSTEM_PROMPT = [
  "You are an agent reachable in a Matrix room.",
  "Several people and agents may be talking in the same room.",
  "When room history is provided, use it as context to understand the conversation so far.",
  "Reply naturally as a participant in the group conversation.",
  "IMPORTANT: Do NOT output any session handoff summaries, session recaps, bullet-point preambles, or any meta-commentary about previous sessions at the start of your reply.",
  "Respond directly and immediately to the message.",
  "",
  "FORMATTING: your markdown is rendered to HTML, so tables, headings, lists and",
  "code fences all display correctly. Use them where they help.",
].join("\n");

const HISTORY_FETCH_LIMIT = 30;

async function fetchThreadHistory(
  roomId: string,
  entry: ThreadEntry,
  botUserId: string,
  currentMessageId?: string,
): Promise<string> {
  let events: any[];
  try {
    const res = await transport.client.doRequest(
      "GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { dir: "b", limit: HISTORY_FETCH_LIMIT },
    );
    events = res?.chunk ?? [];
  } catch {
    return "";
  }

  // Paginating backwards yields newest first; the model wants oldest first. Stop
  // at our own last reply, which is where "since your last reply" is anchored.
  const stopAt = entry.started ? entry.lastBotMessageId : undefined;
  const collected: any[] = [];
  for (const ev of events) {
    if (stopAt && ev.event_id === stopAt) break;
    if (ev.type !== "m.room.message") continue;
    if (ev.sender === botUserId) continue;
    if (ev.event_id === currentMessageId) continue;
    if (ev.content?.["m.relates_to"]?.rel_type === "m.replace") continue;
    collected.push(ev);
  }
  const sorted = collected.reverse();

  if (sorted.length === 0) return "";

  const lines = (await Promise.all(sorted.map(async (m) => {
    const name = await transport.shortName(m.sender);
    const text = (m.content?.body ?? "").trim();
    return text ? `[${name}] ${text}` : null;
  }))).filter(Boolean);

  if (lines.length === 0) return "";

  const label = entry.started
    ? "Messages from other users since your last reply"
    : "Recent thread history for context";

  return `[${label}]\n${lines.join("\n")}\n[End]\n\n`;
}

// --- Streaming Runner ---

const running = new Map<string, ChildProcess>();

type StreamCallbacks = {
  onText?: (fullText: string) => void;
  onToolUse?: (toolName: string) => void;
};

type AskQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

type PermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: { questions: AskQuestion[] };
};

type RunResult = {
  /** Every text block of the turn, in order. */
  text: string;
  /** The last one alone — what the CLI reports as the turn's `result`. */
  finalText: string;
  exitCode: number;
  costUsd?: number;
  is_error?: boolean;
  permissionDenials?: PermissionDenial[];
};

/** A turn that narrates, calls a tool, then answers is several text blocks, and
 *  the CLI's `result` is only the last of them. Everything said before the last
 *  tool call was being dropped on the floor, so the posted message is all of
 *  them joined. */
function joinSegments(segments: string[]): string {
  return segments.map((s) => s.trim()).filter(Boolean).join("\n\n");
}

function runClaudeStreaming(opts: {
  sessionId: string;
  prompt: string;
  cwd: string;
  model: string;
  claudeBin: string;
  resume: boolean;
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  maxBudgetUsd?: number;
  disallowedTools?: string[];
  mcpConfig?: string;
  timeoutMs?: number;
  callbacks?: StreamCallbacks;
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", opts.prompt,
      ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
      "--model", opts.model,
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      // `--system-prompt` REPLACES Claude Code's own system prompt; `--append-`
      // adds to it. Replacing drops the CLI's tool-use guidance along with
      // everything else, so append is the default and replacing is opt-in.
      ...(opts.systemPrompt
        ? [opts.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", opts.systemPrompt]
        : []),
      ...(opts.maxBudgetUsd ? ["--max-budget-usd", String(opts.maxBudgetUsd)] : []),
      // Variadic: every bare word after it is taken as another rule. Safe here
      // because the prompt is passed with -p up front, never positionally. A rule
      // matching no known tool only warns, so a typo silently grants what it meant
      // to withhold — check the log after changing this.
      ...(opts.disallowedTools?.length ? ["--disallowed-tools", ...opts.disallowedTools] : []),
      ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
    ];

    const child = spawn(opts.claudeBin, args, {
      cwd: opts.cwd,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    running.set(opts.sessionId, child);

    let buffer = "";
    let stderrBuf = "";
    let lastSeenText = "";
    let resultText = "";
    // One entry per text block. stream-json emits a message once per content
    // block under a shared message id, so the id plus the text is the identity.
    const segments: string[] = [];
    const seenSegments = new Set<string>();
    let costUsd: number | undefined;
    let isError = false;
    let permissionDenials: PermissionDenial[] | undefined;
    let settled = false;

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" && event.message?.content) {
            let messageText = "";
            for (const block of event.message.content) {
              if (block.type === "text") {
                messageText += block.text || "";
              } else if (block.type === "tool_use" && block.name) {
                opts.callbacks?.onToolUse?.(block.name);
              }
            }
            if (messageText) {
              const key = `${event.message.id ?? ""}\0${messageText}`;
              if (!seenSegments.has(key)) {
                seenSegments.add(key);
                segments.push(messageText);
              }
            }
            if (messageText && messageText !== lastSeenText) {
              lastSeenText = messageText;
              opts.callbacks?.onText?.(joinSegments(segments));
            }
          }

          if (event.type === "result") {
            resultText = event.result || "";
            costUsd = event.total_cost_usd;
            if (event.is_error) isError = true;
            // Capture error messages from the errors array (e.g. "No conversation found...")
            if (!resultText && event.errors?.length) {
              resultText = event.errors.join("\n");
            }
            if (event.permission_denials?.length > 0) {
              permissionDenials = event.permission_denials;
            }
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    const timeout = opts.timeoutMs ?? 5_400_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      running.delete(opts.sessionId);
      child.kill("SIGTERM");
      const partial = joinSegments(segments) || resultText;
      if (partial) {
        resolve({
          text: partial + "\n\n⚠️ *Task timed out after 90 min — partial result above.*",
          finalText: lastSeenText || resultText,
          exitCode: 124,
          costUsd,
        });
      } else {
        reject(new Error(`Timeout after ${timeout}ms with no output`));
      }
    }, timeout);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(opts.sessionId);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(opts.sessionId);
      const errHint = stderrBuf.trim() ? `\n\n⚠️ stderr: ${stderrBuf.trim().slice(0, 500)}` : "";
      // An error result (budget, a forgotten session) is not one of the text
      // blocks, and is the part worth seeing.
      if (isError && resultText && !segments.includes(resultText)) segments.push(resultText);
      const text = joinSegments(segments) || resultText || `(no output)${errHint}`;
      const finalText = segments.length ? segments[segments.length - 1] : text;
      resolve({ text, finalText, exitCode: code ?? 1, costUsd, is_error: isError, permissionDenials });
    });
  });
}

// Generate a short, intuitive thread title from a user message using Claude Haiku.
// Returns null on failure — caller should fall back to the placeholder name.
// Matrix has no interactive components, so a confirmation is a numbered list and
// the answer is the next message in the room from somebody on the `humans`
// list. What the buttons in the Discord era were
// actually buying is untouched: the question is asked in the agent's own room,
// where nobody but Terry speaks, and the answer carries his MXID as its sender.
async function sendAskPrompt(
  room: Room,
  threadId: string,
  entry: ThreadEntry,
  denial: PermissionDenial,
): Promise<void> {
  for (const q of denial.tool_input.questions) {
    const opts = q.options
      .map((o, i) => `${i + 1}. **${o.label}**${o.description ? ` — ${o.description}` : ""}`)
      .join("\n");
    const botReply = await room.send(
      `❓ **${q.question}**\n\n${opts}\n\n*Reply with a number, or answer in your own words.*`,
    );
    entry.lastBotMessageId = botReply.id;
  }
  // Until Terry answers, this session takes nothing from anyone else. The room
  // used to carry this by itself — only he could speak here — and once a
  // sibling's words can be relayed in, it cannot.
  entry.awaitingAnswer = Date.now();
  saveEntry(threadId, entry);
}

// --- Streaming tool-use callback ---

function createToolUseHandler(ps: PreviewState): (toolName: string) => void {
  return (toolName) => {
    console.log(`[matrix-cc-bot] tool: ${toolName}`);
    ps.toolsUsed.push(toolName);
    if (ps.msg) {
      const text = (ps.pendingText || "").slice(0, PREVIEW_MAX_LEN);
      ps.msg.edit(text + buildStatusLine(ps)).catch(() => {});
    }
  };
}

// --- Attachment handling ---

const ATTACH_TMP_DIR = path.join(import.meta.dirname, "..", "tmp-attachments");
const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file

async function downloadAttachment(url: string, filepath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buf);
}

// --- Chunked message sending ---

const CHUNK_LEN = MATRIX_MAX_LEN - 1000;

function splitMessage(text: string): string[] {
  if (text.length <= CHUNK_LEN) return [text];

  // Split text into atomic segments: complete code blocks + surrounding text.
  // Code blocks are never broken across chunks.
  const segments: string[] = [];
  const blockRegex = /^(`{3,})\w*\n[\s\S]*?^\1\s*$/gm;
  let lastEnd = 0;

  for (const match of text.matchAll(blockRegex)) {
    if (match.index! > lastEnd) {
      segments.push(text.slice(lastEnd, match.index!));
    }
    segments.push(match[0]);
    lastEnd = match.index! + match[0].length;
  }
  if (lastEnd < text.length) {
    segments.push(text.slice(lastEnd));
  }

  // Pack segments into chunks, splitting only at segment boundaries
  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    const combined = current + seg;
    if (combined.length <= CHUNK_LEN) {
      current = combined;
      continue;
    }

    // Won't fit — flush current chunk, start new one
    if (current) chunks.push(current);

    if (seg.length <= CHUNK_LEN) {
      current = seg;
    } else {
      // Oversized segment — detect if it's a code block
      const fenceMatch = seg.match(/^(`{3,})(\w*)\n/);
      if (fenceMatch) {
        // It's a code block — strip outer fences, split inner content, re-wrap each piece
        const fence = fenceMatch[1];
        const lang = fenceMatch[2];
        const header = fence + lang + "\n";
        const footer = "\n" + fence;
        const closeIdx = seg.lastIndexOf("\n" + fence);
        const body = seg.slice(header.length, closeIdx === -1 ? seg.length : closeIdx);
        const maxBody = CHUNK_LEN - header.length - footer.length;
        let rem = body;
        while (rem.length > maxBody) {
          let splitAt = rem.lastIndexOf("\n", maxBody);
          if (splitAt < maxBody / 2) splitAt = maxBody;
          chunks.push(header + rem.slice(0, splitAt) + footer);
          rem = rem.slice(splitAt + (rem[splitAt] === "\n" ? 1 : 0));
        }
        current = header + rem + footer;
      } else {
        // Plain text oversized — split at newlines
        let rem = seg;
        while (rem.length > CHUNK_LEN) {
          let splitAt = rem.lastIndexOf("\n", CHUNK_LEN);
          if (splitAt < CHUNK_LEN / 2) splitAt = CHUNK_LEN;
          chunks.push(rem.slice(0, splitAt));
          rem = rem.slice(splitAt + (rem[splitAt] === "\n" ? 1 : 0));
        }
        current = rem;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendChunked(
  room: Room,
  text: string,
  replyTo?: Msg,
): Promise<Msg> {
  const chunks = splitMessage(text);

  let firstMsg: Msg | undefined;
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && replyTo) {
      firstMsg = await replyTo.reply(chunks[i]);
    } else {
      const msg = await room.send(chunks[i]);
      if (i === 0) firstMsg = msg;
    }
  }
  return firstMsg!;
}

// --- Streaming preview throttle ---

const STREAM_THROTTLE_MS = 1500;
const STREAM_MIN_DELTA = 40;
const PREVIEW_MAX_LEN = 4000;

type PreviewState = {
  msg: Msg | null;
  lastText: string;
  lastEditTime: number;
  timer: NodeJS.Timeout | null;
  pendingText: string;
  startTime: number;
  toolsUsed: string[];
};

function createPreviewState(): PreviewState {
  return { msg: null, lastText: "", lastEditTime: 0, timer: null, pendingText: "", startTime: Date.now(), toolsUsed: [] };
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

function buildStatusLine(ps: PreviewState): string {
  const time = formatElapsed(ps.startTime);
  const toolLine = ps.toolsUsed.length > 0
    ? `🔧 ${ps.toolsUsed.slice(-3).join(" → ")}\n` : "";
  return `\n\n${toolLine}⏳ *working... (${time})*`;
}

function flushPreview(ps: PreviewState): void {
  if (!ps.msg || !ps.pendingText) return;
  const display = ps.pendingText.slice(0, PREVIEW_MAX_LEN) + buildStatusLine(ps);
  ps.msg.edit(display).catch(() => {});
  ps.lastText = ps.pendingText;
  ps.lastEditTime = Date.now();
}

function handleStreamText(ps: PreviewState, fullText: string): void {
  ps.pendingText = fullText;

  const delta = fullText.length - ps.lastText.length;
  const elapsed = Date.now() - ps.lastEditTime;

  // Not enough new content
  if (delta < STREAM_MIN_DELTA && ps.lastEditTime > 0) {
    if (!ps.timer) {
      ps.timer = setTimeout(() => {
        ps.timer = null;
        flushPreview(ps);
      }, STREAM_THROTTLE_MS);
    }
    return;
  }

  // Too soon since last edit
  if (elapsed < STREAM_THROTTLE_MS && ps.lastEditTime > 0) {
    if (!ps.timer) {
      ps.timer = setTimeout(() => {
        ps.timer = null;
        flushPreview(ps);
      }, STREAM_THROTTLE_MS - elapsed);
    }
    return;
  }

  // Enough content & time — flush immediately
  if (ps.timer) clearTimeout(ps.timer);
  flushPreview(ps);
}

// --- Room config (agent routing) ---

type RoomSchedule = {
  cron: string;
  prompt: string;
  timezone?: string;
};

type SystemPromptMode = "append" | "replace";

type RoomConfig = {
  name: string;
  sessionId: string;
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  workingDirectory?: string;
  model?: string;
  schedule?: RoomSchedule;
  contextFile?: string;
  /** Answer only when mentioned. Default false — a configured room replies to everything. */
  requireMention?: boolean;
  /** Extra case-insensitive regexes counted as a mention, so a bare name in plain
   *  text routes the way a real mention does. */
  mentionPatterns?: string[];
  /** Admit messages from sibling agents. Default false. */
  allowBots?: boolean;
  /** MXIDs that count as human here. Matrix has no bot flag, so this list is the
   *  whole of the distinction: everyone else in the room is a sibling agent.
   *  Absent, everyone is human.
   *
   *  It is also the only thing that can answer a confirmation — see
   *  `awaitingAnswer`. That used to be guaranteed by the room instead: nobody
   *  but Terry could speak in an agent's own room, so anything arriving there
   *  was his. Relaying puts a sibling's words into that room, which makes the
   *  room a worse piece of evidence than it was, and this list the ground truth
   *  it was standing in for. */
  humans?: string[];
  /** Where a `<name>` block addressed to somebody who is not in this room is
   *  forwarded: the room this agent shares with its siblings. Absent, a block
   *  is local addressing only and nothing leaves the room.
   *
   *  This is not a boundary and is not trying to be one — the agent is root in
   *  its own container and can rewrite this file. What it cannot do is join a
   *  room or invite anybody: that is power level 100 on the homeserver and
   *  every agent here is 0. Which rooms this process can reach is decided in
   *  Synapse; this key only picks one of them. */
  relayRoom?: string;
  /** Prepend recent room messages to the prompt. Default true. */
  fetchHistory?: boolean;
  /** Rooms sharing a group share one Claude Code session, so a conversation can
   *  move between rooms without starting over. Give them the same `sessionId` too;
   *  otherwise whichever room speaks first seeds the group. */
  sessionGroup?: string;
  /** Withheld from the model via --disallowed-tools. Names, not an allowlist, so a
   *  tool that becomes available later cannot appear in a turn by surprise; and a
   *  flag rather than a deny rule, so the schema stays out of the prompt too. */
  disallowedTools?: string[];
  /** Passed to the CLI as --mcp-config. A server declared here resolves inside
   *  the awaited startup path; a claude.ai connector is fetched asynchronously
   *  and can lose the race with the first model request, leaving that turn with
   *  no connector tools and no error anywhere. Declaring the connector as a
   *  `claudeai-proxy` server pins it into the awaited path. */
  mcpConfig?: string;
  /** Start a thread on every top-level message here, so each exchange gets its
   *  own bounded session. Off by default, which leaves the room behaving exactly
   *  as it did: threads are then opt-in, and Terry starts one by hand when he
   *  wants a fresh context. A message *inside* a thread gets its own session
   *  either way — that does not need enabling, because it cannot happen by
   *  accident. */
  replyInThread?: boolean;
  /** Passed to the CLI as --max-budget-usd, which aborts a turn mid-flight. */
  maxCostUsdPerTurn?: number;
  /** Refuse new turns in this room once the day's spend reaches this. */
  maxCostUsdPerDay?: number;
};

type RoomConfigFile = {
  rooms: Record<string, RoomConfig>;
  defaults?: {
    model?: string;
    systemPrompt?: string;
    systemPromptMode?: SystemPromptMode;
    workingDirectory?: string;
  };
  /** MXIDs treated as human in every room lacking its own `humans` list. */
  defaultHumans?: string[];
  /** Ignore mentions in rooms that have no entry above. Default false, which is
   *  upstream's behaviour: a mention anywhere the bot can see starts a turn with
   *  DEFAULT_CWD, the generic prompt, and none of a room's tool denials or spend
   *  ceiling. Where the room list is a containment boundary, set this true. */
  configuredRoomsOnly?: boolean;
};

// `room-config.json` is the name; `channel-config.json` is what every existing
// deployment has on disk, and the file is gitignored so nothing in the repo can
// rename it for them. Both are watched and whichever exists is loaded — the
// startup line says which, because a config that silently did not load has
// looked exactly like one that did more than once in this project's history.
const CONFIG_PATHS = ["room-config.json", "channel-config.json"]
  .map((f) => path.join(import.meta.dirname, "..", f));

function configPath(): string | null {
  return CONFIG_PATHS.find((f) => fs.existsSync(f)) ?? null;
}

function loadRoomConfig(): RoomConfigFile {
  try {
    const found = configPath();
    if (found) {
      const raw = JSON.parse(fs.readFileSync(found, "utf8"));
      // `channels` and `configuredChannelsOnly` are what the Discord-era config
      // called these. The file is gitignored, so a deployment's copy can only be
      // renamed by hand; both spellings load.
      return {
        ...raw,
        rooms: raw.rooms ?? raw.channels ?? {},
        configuredRoomsOnly: raw.configuredRoomsOnly ?? raw.configuredChannelsOnly ?? false,
      };
    }
  } catch (err) {
    console.error(`[matrix-cc-bot] failed to load ${configPath() ?? "room-config.json"}:`, err);
  }
  return { rooms: {} };
}

let roomConfig = loadRoomConfig();

// --- Context File Cache ---

const contextFileCache = new Map<string, string>();

function loadContextFile(filePath: string): string {
  const absPath = path.resolve(path.join(import.meta.dirname, "..", filePath));
  try {
    const content = fs.readFileSync(absPath, "utf8").trim();
    contextFileCache.set(filePath, content);
    console.log(`[matrix-cc-bot] loaded context file: ${filePath}`);
    return content;
  } catch (err) {
    console.error(`[matrix-cc-bot] failed to load context file "${filePath}":`, (err as Error).message);
    return "";
  }
}

function getContextForRoom(config: RoomConfig): string {
  if (!config.contextFile) return "";
  if (contextFileCache.has(config.contextFile)) {
    return contextFileCache.get(config.contextFile)!;
  }
  return loadContextFile(config.contextFile);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `--session-id` must be a valid UUID. A bad one fails only on the room's
// very first turn, which is a long way from where it was configured.
function warnOnBadSessionIds(): void {
  const groups = new Map<string, Set<string>>();
  for (const [cid, cfg] of Object.entries(roomConfig.rooms)) {
    if (!UUID_RE.test(cfg.sessionId)) {
      console.error(`[matrix-cc-bot] room ${cid} ("${cfg.name}") has sessionId "${cfg.sessionId}", which is not a UUID — its first turn will fail.`);
    }
    if (cfg.sessionGroup) {
      if (!groups.has(cfg.sessionGroup)) groups.set(cfg.sessionGroup, new Set());
      groups.get(cfg.sessionGroup)!.add(cfg.sessionId);
    }
  }
  for (const [name, ids] of groups) {
    if (ids.size > 1) {
      console.error(`[matrix-cc-bot] sessionGroup "${name}" spans ${ids.size} different sessionIds — whichever room speaks first seeds the group and the rest are ignored.`);
    }
  }
}

function preloadContextFiles(): void {
  contextFileCache.clear();
  for (const cfg of Object.values(roomConfig.rooms)) {
    if (cfg.contextFile) {
      loadContextFile(cfg.contextFile);
    }
  }
}

preloadContextFiles();
warnOnBadSessionIds();

// Watch for config changes and reload
for (const f of CONFIG_PATHS) fs.watchFile(f, { interval: 5000 }, () => {
  console.log(`[matrix-cc-bot] reloading ${path.basename(f)}`);
  roomConfig = loadRoomConfig();
  preloadContextFiles();
  warnOnBadSessionIds();
});

function getRoomAgent(roomId: string): RoomConfig | null {
  return roomConfig.rooms[roomId] ?? null;
}

// Which row a turn's session lives under. Rooms sharing a `sessionGroup` share
// one session: an agent working in the commons can ask for a confirmation on its
// private room and the same session sees the answer, which is what keeps the
// private room meaningful instead of merely quieter.
//
// A thread overrides the group and gets a session of its own. That is the point
// of threading a conversation — a bounded context you clear by starting another
// one — but note what it costs: a thread lives in exactly one room, so an
// exchange threaded in the commons can no longer ask for confirmation in the
// agent's private room and see the answer. Top-level traffic keeps the group and
// keeps that property. Thread deliberately.
function sessionKey(roomId: string, agent: RoomConfig | null, threadRootId?: string): string {
  if (threadRootId) return `thread:${threadRootId}`;
  return agent?.sessionGroup ? `group:${agent.sessionGroup}` : roomId;
}

function resolveSystemPromptMode(agent: RoomConfig | null): SystemPromptMode {
  return agent?.systemPromptMode ?? roomConfig.defaults?.systemPromptMode ?? "append";
}

// A bare name in message text has to route on its own. An agent writing "@emet"
// produces no ping — a Matrix mention is a pill or an `m.mentions` field, and a
// model's text is posted verbatim — so routing between agents matches text.
// The `<name>` block is the form siblings actually use; this stays for a human
// typing a name by hand.
function matchesMentionPatterns(content: string, agent: RoomConfig | null): boolean {
  const patterns = agent?.mentionPatterns;
  if (!patterns?.length) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(content);
    } catch (err) {
      console.error(`[matrix-cc-bot] bad mentionPattern ${JSON.stringify(pattern)}:`, (err as Error).message);
      return false;
    }
  });
}

// --- Runaway exchanges ---
//
// There used to be a ceiling here: N consecutive sibling-triggered turns per
// room, cleared by any human message. It was built when *any* message in a
// shared room woke every agent in it, so two agents being polite at each other
// was a live failure mode with no deliberate act behind it.
//
// Addressing is explicit now. A turn only reaches a sibling because the agent
// wrote a block addressed to them, so a runaway exchange takes a decision at
// every hop rather than none. The ceiling had also become actively wrong: it
// counted per room and suppressed *silently*, so a long, legitimate exchange in
// one bridged thread would stop mid-sentence with nothing said about why, in a
// room whose other conversations were fine. A loop you can see beats a brake
// that fires on the wrong thing.
//
// What remains: `maxCostUsdPerDay`, the backstop that actually matters because
// a loop is a bill before it is anything else; NO_RESPONSE, the graceful end an
// agent can choose; and `bridge.hops`, counted and logged so a loop is visible
// in the log and in the database while it is still happening.
const HOPS_NOISY = 12;

// --- Turn serialization ---

// A message arriving mid-turn queues instead of being rejected: with several
// speakers in one room, mid-turn arrival is the normal case rather than the
// exception.
const MAX_QUEUE_DEPTH = 4;

type Lane = { busy: boolean; waiting: (() => void)[] };
const lanes = new Map<string, Lane>();

/** Returns a release function, or null if this key's queue is already full. */
function acquireTurn(key: string): Promise<(() => void) | null> {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { busy: false, waiting: [] };
    lanes.set(key, lane);
  }
  const held = lane;

  if (held.busy && held.waiting.length >= MAX_QUEUE_DEPTH) {
    return Promise.resolve(null);
  }

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = held.waiting.shift();
      if (next) {
        next();
      } else {
        held.busy = false;
        if (lanes.get(key) === held) lanes.delete(key);
      }
    };
  };

  if (!held.busy) {
    held.busy = true;
    return Promise.resolve(makeRelease());
  }
  return new Promise((resolve) => {
    held.waiting.push(() => resolve(makeRelease()));
  });
}

// --- Spend ledger ---

// An agent talked into a loop is a financial problem before it is anything else,
// so the ceiling is enforced here rather than left to the model to observe.
// In memory only: a restart forgives the day's spend.
type Spend = { day: string; usd: number; notified: boolean };
const spendByRoom = new Map<string, Spend>();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordSpend(roomId: string, usd: number | undefined): void {
  if (!usd) return;
  const day = utcDay();
  const rec = spendByRoom.get(roomId);
  if (!rec || rec.day !== day) {
    spendByRoom.set(roomId, { day, usd, notified: false });
  } else {
    rec.usd += usd;
  }
}

/** True when the room is out of budget for today; notifies once per day. */
function overDailyBudget(roomId: string, agent: RoomConfig | null): { over: boolean; announce: boolean; spent: number; cap: number } {
  const cap = agent?.maxCostUsdPerDay ?? 0;
  const rec = spendByRoom.get(roomId);
  const spent = rec && rec.day === utcDay() ? rec.usd : 0;
  if (!cap || spent < cap) return { over: false, announce: false, spent, cap };
  const announce = !!rec && !rec.notified;
  if (rec) rec.notified = true;
  return { over: true, announce, spent, cap };
}

// --- Silent turns ---

// An explicit way for the model to decline to post. In a room where bots hear
// each other, not posting is what ends an exchange, so the graceful exit needs to
// be something the model can choose rather than something it has to be stopped
// from doing.
const SILENT_TOKEN = process.env.SILENT_TOKEN ?? "NO_RESPONSE";

// --- Matrix ---

const HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL ?? "http://localhost:8008";
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN!;
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const STORAGE_PATH = process.env.MATRIX_STORAGE
  ?? path.join(import.meta.dirname, "..", "matrix-sync.json");

if (!ACCESS_TOKEN) {
  console.error("Missing MATRIX_ACCESS_TOKEN");
  process.exit(1);
}

const threadMap = loadMap();
const transport = new MatrixTransport(HOMESERVER_URL, ACCESS_TOKEN, STORAGE_PATH);

// This agent's own name, as siblings write it in a `<name>` block: the
// localpart of its MXID. Filled in at startup, before any message is handled.
let selfName = "";

/** `@emet:synapse.example` → `emet`, which is also the name its tag uses. */
function localpart(mxid: string): string {
  return mxid.split(":")[0].replace(/^@/, "").toLowerCase();
}

// Matrix has no command registry, so these are plain text prefixes.
const TEXT_COMMANDS = [
  ["!help", "Show available commands"],
  ["!new", "Clear context — start a new conversation"],
  ["!model <name>", "Switch Claude model"],
  ["!cd <path>", "Switch working directory"],
  ["!stop", "Kill running Claude process"],
  ["!sessions", "List all active sessions"],
  ["!rooms", "List configured room agents"],
  ["!reload-config", "Reload the room config"],
] as const;

// --- Text commands ---

async function handleCommand(msg: IncomingMessage, room: Room, threadId: string): Promise<boolean> {
  const [cmd, ...rest] = msg.content.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const agent = getRoomAgent(msg.roomId);

  switch (cmd) {
    case "!help":
      await room.send(TEXT_COMMANDS.map(([c, d]) => `\`${c}\` — ${d}`).join("\n"));
      return true;

    case "!new": {
      const entry = threadMap[threadId];
      if (entry) {
        const child = running.get(entry.sessionId);
        if (child) child.kill("SIGTERM");
        entry.sessionId = crypto.randomUUID();
        entry.started = false;
        saveEntry(threadId, entry);
      }
      await room.send("🆕 *Context cleared.*");
      return true;
    }

    case "!model": {
      if (!arg) { await room.send("Usage: `!model sonnet|opus|haiku`"); return true; }
      const entry = getOrCreate(threadMap, threadId, agent?.workingDirectory ?? DEFAULT_CWD);
      entry.model = arg;
      saveEntry(threadId, entry);
      await room.send(`🤖 *Model set to \`${arg}\`.*`);
      return true;
    }

    case "!cd": {
      if (!arg.startsWith("/")) { await room.send("Usage: `!cd /absolute/path`"); return true; }
      if (!fs.existsSync(arg)) { await room.send(`No such directory: \`${arg}\``); return true; }
      const entry = getOrCreate(threadMap, threadId, arg);
      entry.cwd = arg;
      saveEntry(threadId, entry);
      await room.send(`📁 *Working directory set to \`${arg}\`.*`);
      return true;
    }

    case "!stop": {
      const entry = threadMap[threadId];
      const child = entry && running.get(entry.sessionId);
      if (child) { child.kill("SIGTERM"); await room.send("🛑 *Stopped.*"); }
      else await room.send("*Nothing running.*");
      return true;
    }

    case "!sessions": {
      const lines = Object.entries(threadMap).map(([k, e]) =>
        `\`${k}\` — ${e.sessionId.slice(0, 8)} ${e.model ?? "?"} ${running.has(e.sessionId) ? "▶︎" : ""}`);
      await room.send(lines.length ? lines.join("\n") : "*No sessions.*");
      return true;
    }

    case "!rooms": {
      const lines = Object.entries(roomConfig.rooms).map(([rid, c]) =>
        `**${c.name}** \`${rid}\`${c.sessionGroup ? ` group:${c.sessionGroup}` : ""}${c.requireMention ? " mention" : ""}`);
      await room.send(lines.length ? lines.join("\n") : "*No configured rooms.*");
      return true;
    }

    case "!reload-config":
      roomConfig = loadRoomConfig();
      preloadContextFiles();
      warnOnBadSessionIds();
      applyRoomHumans();
      startScheduledJobs();
      await room.send(`♻️ *Reloaded — ${Object.keys(roomConfig.rooms).length} room(s).*`);
      return true;
  }
  return false;
}

// --- Scheduled jobs ---

const scheduledTasks: cron.ScheduledTask[] = [];

function startScheduledJobs(): void {
  for (const task of scheduledTasks) task.stop();
  scheduledTasks.length = 0;

  for (const [roomId, cfg] of Object.entries(roomConfig.rooms)) {
    if (!cfg.schedule) continue;
    const { cron: cronExpr, prompt, timezone } = cfg.schedule;
    if (!cron.validate(cronExpr)) {
      console.error(`[matrix-cc-bot] invalid cron for "${cfg.name}": ${cronExpr}`);
      continue;
    }
    console.log(`[matrix-cc-bot] scheduling "${cfg.name}" → "${cronExpr}"${timezone ? ` (${timezone})` : ""}`);

    const task = cron.schedule(cronExpr, async () => {
      console.log(`[matrix-cc-bot] cron fired for ${cfg.name}`);
      const room = transport.room(roomId);
      const threadId = sessionKey(roomId, cfg);
      const entry = getOrCreate(threadMap, threadId,
        cfg.workingDirectory ?? roomConfig.defaults?.workingDirectory ?? DEFAULT_CWD, cfg.sessionId);

      // Cron takes the same lane as a message: `running` only fills once a child
      // has spawned, so checking it alone races a turn that is still starting.
      const release = await acquireTurn(entry.sessionId);
      if (!release) {
        console.log(`[matrix-cc-bot] cron: ${cfg.name} session busy, skipping this firing`);
        return;
      }
      try {
        const budget = overDailyBudget(roomId, cfg);
        if (budget.over) {
          console.log(`[matrix-cc-bot] cron: ${cfg.name} over daily budget, skipping`);
          return;
        }
        await runTurn({
          room, roomId, threadId, entry, agent: cfg,
          prompt, replyTo: undefined,
        });
      } catch (err) {
        console.error(`[matrix-cc-bot] cron error for ${cfg.name}:`, (err as Error).message);
      } finally {
        release();
      }
    }, timezone ? { timezone } : undefined);

    scheduledTasks.push(task);
  }
  if (scheduledTasks.length) console.log(`[matrix-cc-bot] started ${scheduledTasks.length} scheduled job(s)`);
}

/** Forward every `<name>` block in a turn's output to the room this agent
 *  shares with its siblings, and remember where each one came from.
 *
 *  Only the block travels, never the whole message. A turn is written for Terry
 *  and will be full of context meant for him; what crosses into a room another
 *  agent can read is exactly the text the agent wrapped and nothing else. That
 *  is the difference between a tag and a bare @mention, and it is the reason
 *  for the tag.
 *
 *  In the shared room itself there is nothing to forward — both parties are
 *  already there, and the tag is only a wake signal. */
async function forwardRelayBlocks(
  text: string,
  ctx: { roomId: string; threadId: string; agent: RoomConfig | null },
): Promise<void> {
  const relayRoomId = ctx.agent?.relayRoom;
  if (!relayRoomId || relayRoomId === ctx.roomId) return;

  // `thread:<root>` is the only session key that names an event, and a relayed
  // answer has to come back to the thread it was asked from, not to the room.
  const homeThreadRootId = ctx.threadId.startsWith("thread:") ? ctx.threadId.slice(7) : null;

  for (const block of relayBlocks(text, selfName)) {
    try {
      // Posted verbatim, tag included: it is what wakes the addressee on the
      // other side, and it is what tells a reader of the shared room who the
      // message is for.
      const root = await transport.room(relayRoomId).send(`<${block.to}>${block.body}</${block.to}>`);
      stmtBridgePut.run({
        relayRootId: root.id,
        homeRoomId: ctx.roomId,
        homeThreadRootId,
        homeThreadId: ctx.threadId,
        addressee: block.to,
        hops: 0,
        createdAt: Date.now(),
      });
      console.log(`[matrix-cc-bot] relayed to ${block.to} → ${relayRoomId} ${root.id.slice(0, 8)}… (home ${ctx.threadId})`);
    } catch (err) {
      console.error(`[matrix-cc-bot] relay to ${block.to} failed:`, (err as Error).message);
    }
  }
}

// --- One turn ---

/** Runs Claude for one turn and delivers the result. Shared by messages and cron. */
async function runTurn(opts: {
  room: Room;
  roomId: string;
  threadId: string;
  entry: ThreadEntry;
  agent: RoomConfig | null;
  prompt: string;
  replyTo?: Msg;
  filePaths?: string[];
}): Promise<void> {
  const { room, roomId, threadId, entry, agent, prompt, replyTo } = opts;

  const previewState = createPreviewState();
  previewState.msg = replyTo
    ? await replyTo.reply("⏳ *Thinking...*", { notice: true })
    : await room.send("⏳ *Thinking...*", { notice: true });
  await transport.setTyping(roomId, true);

  const baseSystemPrompt = agent?.systemPrompt ?? roomConfig.defaults?.systemPrompt ?? SYSTEM_PROMPT;
  const roomContext = agent ? getContextForRoom(agent) : "";
  const systemPrompt = roomContext
    ? `Room context:\n${roomContext}\n\n${baseSystemPrompt}`
    : baseSystemPrompt;

  const runOpts = {
    sessionId: entry.sessionId,
    prompt,
    cwd: entry.cwd,
    model: entry.model,
    claudeBin: CLAUDE_BIN,
    systemPrompt,
    systemPromptMode: resolveSystemPromptMode(agent),
    maxBudgetUsd: agent?.maxCostUsdPerTurn,
    disallowedTools: agent?.disallowedTools,
    mcpConfig: agent?.mcpConfig,
    callbacks: {
      onText: (fullText: string) => handleStreamText(previewState, fullText),
      onToolUse: createToolUseHandler(previewState),
    },
  };

  try {
    let result = await runClaudeStreaming({ ...runOpts, resume: entry.started });

    // --resume against a session the CLI has forgotten: reset and retry fresh.
    if (entry.started && result.is_error && /no conversation found/i.test(result.text)) {
      console.log(`[matrix-cc-bot] session ${entry.sessionId} not found, starting fresh`);
      entry.sessionId = crypto.randomUUID();
      entry.started = false;
      saveEntry(threadId, entry);
      result = await runClaudeStreaming({ ...runOpts, sessionId: entry.sessionId, resume: false });
    }

    recordSpend(roomId, result.costUsd);
    if (previewState.timer) clearTimeout(previewState.timer);

    const askDenial = result.permissionDenials?.find((d) => d.tool_name === "AskUserQuestion");
    if (askDenial) {
      await previewState.msg!.delete().catch(() => {});
      entry.started = true;
      await sendAskPrompt(room, threadId, entry, askDenial);
      return;
    }

    // The model declined to speak. In a room where agents hear each other,
    // silence is what ends an exchange gracefully; the budget is the other way.
    // Judged on the last block: a turn that says "let me check", looks, and then
    // decides there is nothing to add has decided, and the narration goes too.
    if (result.finalText.trim().startsWith(SILENT_TOKEN)) {
      await previewState.msg!.delete().catch(() => {});
      entry.started = true;
      saveEntry(threadId, entry);
      console.log(`[matrix-cc-bot] ${SILENT_TOKEN} in ${threadId} — nothing posted`);
      return;
    }

    entry.started = true;

    let botReply: Msg;
    try {
      await previewState.msg!.delete().catch(() => {});
      if (result.text.length <= MATRIX_MAX_LEN) {
        botReply = replyTo ? await replyTo.reply(result.text) : await room.send(result.text);
      } else {
        botReply = await sendChunked(room, result.text, replyTo);
      }
    } catch (replyErr) {
      console.error("[matrix-cc-bot] reply failed, trying fallback:", (replyErr as Error).message);
      botReply = await room.send(result.text.slice(0, MATRIX_MAX_LEN));
    }

    entry.lastBotMessageId = botReply.id;
    saveEntry(threadId, entry);

    await forwardRelayBlocks(result.text, { roomId, threadId, agent });
  } catch (err) {
    if (previewState.timer) clearTimeout(previewState.timer);
    if (previewState.msg) await previewState.msg.edit(`Error: ${(err as Error).message}`).catch(() => {});
    else await room.send(`Error: ${(err as Error).message}`, { notice: true }).catch(() => {});
  } finally {
    await transport.setTyping(roomId, false);
    for (const p of opts.filePaths ?? []) fs.unlink(p, () => {});
  }
}

// --- Message handler ---

/** Push each room's human list into the transport, so isHuman is answerable. */
function applyRoomHumans(): void {
  for (const [roomId, cfg] of Object.entries(roomConfig.rooms)) {
    transport.setHumans(roomId, cfg.humans ?? roomConfig.defaultHumans ?? []);
  }
}

transport.onMessage(async (msg) => {
  let releaseTurn: (() => void) | null = null;
  try {
    const agent = getRoomAgent(msg.roomId);

    // Matrix has no bot flag, so "from a sibling" is "not on the human list".
    const fromBot = !msg.isHuman;
    if (fromBot && !(agent?.allowBots ?? false)) return;

    // A `<name>` block addressed to us is a mention, and in a shared room it is
    // the one siblings actually use: a bot posting plain `@name` produces no
    // ping, and a tag is unambiguous where a name in prose is not.
    const isMentioned = msg.mentionsUs
      || matchesMentionPatterns(msg.content, agent)
      || addressesUs(msg.content, selfName);

    // The answer to a block this agent relayed, from the sibling it was sent
    // to, in the thread it opened. That is a reply whether or not it carries
    // our tag. Requiring the tag here meant an answer written in plain text
    // was posted, read by nobody, and never reported: the asker's turn had
    // ended and nothing was waiting on it. A message tagged only to somebody
    // else is that sibling moving on, and still does not wake us.
    const answerTo = fromBot && msg.threadRootId ? lookupBridge(msg.threadRootId) : null;
    const answersUs = !!answerTo
      && localpart(msg.sender) === answerTo.addressee
      && (isMentioned || relayBlocks(msg.content).length === 0);

    if (agent) {
      if ((agent.requireMention ?? false) && !isMentioned && !answersUs) return;
    } else if (isMentioned) {
      // A mention in a room with no config. Whether that is a feature or a hole
      // in a boundary depends on the deployment, so it is a setting.
      if (roomConfig.configuredRoomsOnly) {
        console.log(`[matrix-cc-bot] mention in unconfigured room ${msg.roomId} — ignored (configuredRoomsOnly)`);
        return;
      }
    } else {
      return;
    }

    // Where a notice or a command answer belongs: exactly where it was typed.
    // A command must never *start* a thread — `!new` at the top level is about
    // the room's own session, not about opening a side-conversation.
    const inThread = msg.threadRootId;
    const room = transport.room(msg.roomId, inThread);

    // Commands are free: no turn, no spend, no budget.
    if (msg.isHuman && msg.content.trim().startsWith("!")) {
      if (await handleCommand(msg, room, sessionKey(msg.roomId, agent, inThread))) return;
    }

    const content = msg.content.trim();
    if (!content && msg.attachments.length === 0) return;

    // A message already in a thread stays there. A top-level message opens one
    // only where the room asks for it.
    const outThread = inThread ?? ((agent?.replyInThread ?? false) ? msg.id : undefined);

    // An answer to something this agent relayed. It arrived in the shared room,
    // but it belongs to the conversation that asked for it, so the turn runs in
    // that session and its output goes back to that thread. Everything below
    // this point is the ordinary path with a different room and session.
    const bridge = inThread ? lookupBridge(inThread) : null;
    if (bridge && !fromBot) {
      // Terry speaking in a bridged thread is Terry in the shared room, not an
      // answer from a sibling. Routing it home would forge the one distinction
      // the whole arrangement rests on.
      console.log(`[matrix-cc-bot] human message in bridged thread ${inThread!.slice(0, 8)}… — not routed home`);
    }
    const routed = bridge && fromBot ? bridge : null;

    const turnRoomId = routed ? routed.homeRoomId : msg.roomId;
    const turnThreadRoot = routed ? (routed.homeThreadRootId ?? undefined) : outThread;
    const turnRoom = transport.room(turnRoomId, turnThreadRoot);

    const threadId = routed ? routed.homeThreadId : sessionKey(msg.roomId, agent, outThread);
    // Spend, budget and tool denials follow the conversation, not the room the
    // message happened to arrive in.
    const turnAgent = routed ? getRoomAgent(routed.homeRoomId) : agent;
    const agentCwd = turnAgent?.workingDirectory ?? roomConfig.defaults?.workingDirectory ?? DEFAULT_CWD;
    const agentModel = turnAgent?.model ?? roomConfig.defaults?.model ?? "opus";

    // Charged where the turn runs, which for a relayed answer is the room that
    // asked the question rather than the shared room it came back through.
    const budget = overDailyBudget(turnRoomId, turnAgent);
    if (budget.over) {
      console.log(`[matrix-cc-bot] daily budget spent in ${turnRoomId}: $${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)}`);
      if (budget.announce) {
        await room.send(`💸 *Daily budget reached ($${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)}). Quiet until UTC midnight.*`, { notice: true }).catch(() => {});
      }
      return;
    }

    if (routed) {
      stmtBridgeHop.run(routed.relayRootId);
      if (routed.hops + 1 >= HOPS_NOISY) {
        console.log(`[matrix-cc-bot] bridged thread ${routed.relayRootId.slice(0, 8)}… is ${routed.hops + 1} hops deep`);
      }
    }

    // Only a room-level session may be seeded from the configured `sessionId`.
    // Seeding a thread with it would make every new thread resume the one
    // long-lived session it was supposed to be an escape from.
    const entry = turnAgent
      ? getOrCreate(threadMap, threadId, agentCwd, (routed || outThread) ? undefined : turnAgent.sessionId)
      : getOrCreate(threadMap, threadId, DEFAULT_CWD);
    if (turnAgent) { entry.cwd = agentCwd; entry.model = agentModel; }

    // A confirmation is on screen in this session and has not been answered.
    // Only a human can answer one: the `humans` list is the ground truth that
    // the room used to stand in for. A sibling's message waits rather than
    // being dropped on the floor — it is told so, in the thread it came from.
    if (entry.awaitingAnswer && !msg.isHuman) {
      console.log(`[matrix-cc-bot] ${threadId} is awaiting a confirmation — not taking a relayed turn`);
      await room.send("*Waiting on Terry. Nothing here will be read until he answers.*", { notice: true }).catch(() => {});
      return;
    }
    if (entry.awaitingAnswer && msg.isHuman) {
      entry.awaitingAnswer = undefined;
      saveEntry(threadId, entry);
    }

    releaseTurn = await acquireTurn(entry.sessionId);
    if (!releaseTurn) {
      console.log(`[matrix-cc-bot] queue full for ${entry.sessionId} — dropping message ${msg.id}`);
      return;
    }

    // mxc:// is authenticated media, so this goes through the client rather
    // than a bare fetch.
    const filePaths: string[] = [];
    for (const att of msg.attachments) {
      if (att.size > ATTACH_MAX_BYTES) {
        console.log(`[matrix-cc-bot] skipping oversized attachment: ${att.name} (${att.size} bytes)`);
        continue;
      }
      const ext = att.name.split(".").pop() ?? "bin";
      const filepath = path.join(ATTACH_TMP_DIR, `${msg.id.replace(/[^\w]/g, "")}.${ext}`);
      try {
        await transport.downloadMedia(att.mxc, filepath);
        filePaths.push(filepath);
      } catch (err) {
        console.error(`[matrix-cc-bot] attachment download failed: ${(err as Error).message}`);
      }
    }

    const history = (!routed && (agent?.fetchHistory ?? true))
      ? await fetchThreadHistory(msg.roomId, entry, transport.getUserId(), msg.id)
      : "";

    // Once several speakers share a room the model has no other way to tell who
    // is talking, and who is talking is the whole of the routing. Only Terry's
    // word is Terry's, and this label is how that stays checkable.
    // Who spoke is `[Name]`; who a message is *for* is the `<name>` tag, and the
    // two are never merged. A relayed answer is labelled even though the room it
    // lands in admits no bots, because it is exactly there that the label is
    // load-bearing: it is the only thing separating a sibling's words from
    // Terry's in the room where his word is authority.
    const body = (routed || (agent?.allowBots ?? false)) ? `[${msg.senderName}] ${content}` : content;
    let userMessage = body;
    if (filePaths.length === 1) {
      userMessage = `${body}\n\nThe user attached a file: ${filePaths[0]}`.trim();
    } else if (filePaths.length > 1) {
      userMessage = `${body}\n\nThe user attached files:\n${filePaths.map((p) => `- ${p}`).join("\n")}`.trim();
    }

    // A relayed answer is put into the home thread verbatim before the turn
    // runs, so the conversation Terry is reading stays readable: he sees what
    // the sibling actually said, not the agent's account of it afterwards.
    if (routed) {
      await turnRoom.send(userMessage).catch((err) =>
        console.error("[matrix-cc-bot] posting relayed answer home failed:", (err as Error).message));
    }

    await runTurn({
      room: turnRoom,
      roomId: turnRoomId,
      threadId,
      entry,
      agent: turnAgent,
      prompt: history ? `${history}${userMessage}` : userMessage,
      replyTo: routed ? undefined : transport.msg(msg.roomId, msg.id, outThread),
      filePaths,
    });
  } catch (err) {
    console.error("[matrix-cc-bot] handler error:", (err as Error).message);
  } finally {
    releaseTurn?.();
  }
});

// --- Start ---

function shutdown() {
  for (const child of running.values()) child.kill("SIGTERM");
  db.close();
  transport.client.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

(async () => {
  const { userId, displayName } = await transport.start();
  selfName = localpart(userId);
  console.log(`[matrix-cc-bot] ready as ${userId} ("${displayName}") on ${HOMESERVER_URL}`);
  console.log(
    `[matrix-cc-bot] auth: ${hasStoredCredentials()
      ? `stored credentials (${CREDENTIALS_PATH}); CLAUDE_CODE_OAUTH_TOKEN blanked for children`
      : process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? "CLAUDE_CODE_OAUTH_TOKEN from the environment"
        : "none found — the CLI will resolve its own"}`,
  );

  applyRoomHumans();
  const configured = Object.entries(roomConfig.rooms);
  console.log(
    configured.length
      ? `[matrix-cc-bot] ${configured.length} room(s) from ${path.basename(configPath()!)}: ` + configured
          .map(([rid, c]) => `${c.name}=${rid}${c.sessionGroup ? ` group:${c.sessionGroup}` : ""}${c.requireMention ? " mention" : ""}${c.allowBots ? " bots" : ""}${c.fetchHistory === false ? " nohistory" : ""}${c.replyInThread ? " thread" : ""}${c.relayRoom ? " relay" : ""}${c.disallowedTools?.length ? ` -${c.disallowedTools.length}tools` : ""}`)
          .join(", ")
      : "[matrix-cc-bot] no room-config.json — mention-only with defaults",
  );
  console.log(`[matrix-cc-bot] unconfigured rooms: ${roomConfig.configuredRoomsOnly ? "ignored" : "answer on mention with defaults"}`);
  console.log(`[matrix-cc-bot] backfill: events before startup are dropped`);

  startScheduledJobs();
})().catch((err) => {
  console.error("[matrix-cc-bot] startup failed:", err);
  process.exit(1);
});
