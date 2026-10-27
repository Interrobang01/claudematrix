// Matrix transport for claudecord.
//
// The point of this module is that the rest of the gateway does not know it
// exists. It presents the two shapes index.ts already used — a room you can
// `.send()` to, and a message you can `.edit()`, `.reply()` to and `.delete()`
// — so the policy code above the transport (mention gating,
// turn queueing, session groups, the sibling relay) never touches Matrix at all.
//
// Four things a chat transport is often assumed to provide, and does not here:
//   1. There is no bot flag in Matrix. Who is human is an explicit MXID list.
//   2. There are no buttons. AskUserQuestion renders as a numbered list.
//   3. Markdown is not rendered unless you send HTML yourself.
//   4. /sync replays history on reconnect. Events older than start are dropped.

import fs from "node:fs";
import path from "node:path";
import { MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";
import { marked } from "marked";

export type Msg = {
  id: string;
  roomId: string;
  edit(text: string, opts?: SendOpts): Promise<void>;
  reply(text: string, opts?: SendOpts): Promise<Msg>;
  delete(): Promise<void>;
};

/** `notice` sends `m.notice` rather than `m.text`: the gateway talking about a
 *  turn rather than the agent taking one. By Matrix convention bots do not act
 *  on notices, and this transport drops them on the way in, so a placeholder or
 *  a status line can never wake a sibling. */
export type SendOpts = {
  notice?: boolean;
  /** MXIDs for the spec's intentional-mentions field: who this message wakes. */
  mentions?: string[];
};

export type Room = {
  id: string;
  send(content: string | { content: string }, opts?: SendOpts): Promise<Msg>;
};

export type IncomingMessage = {
  id: string;
  roomId: string;
  sender: string;        // full MXID
  senderName: string;    // short label, used for the [Name] prefix
  content: string;
  isHuman: boolean;
  mentionsUs: boolean;
  attachments: { name: string; mxc: string; size: number }[];
  /** Set when this event is part of a thread: the thread root's event id.
   *  Absent for a top-level message. This is the only thing the transport
   *  needs to know about threads; everything else about the message is the
   *  same shape either way. */
  threadRootId?: string;
};

/** The relation that puts an event in a thread.
 *
 *  `is_falling_back: true` says the `m.in_reply_to` inside is a *rendering*
 *  fallback for clients that do not understand threads, not a claim that this
 *  message answers that specific event. A genuine reply sets it false and
 *  points at what it actually answers. */
function threadRelation(rootId: string, replyTo?: string): Record<string, any> {
  return {
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: rootId,
      is_falling_back: !replyTo,
      "m.in_reply_to": { event_id: replyTo ?? rootId },
    },
  };
}

// --- Markdown -> Matrix HTML ---

// Matrix clients sanitize incoming HTML against the spec's allowed-tag list
// themselves, so this does not need to be a security boundary; it needs to
// produce tags Element will actually keep. Tables survive here and did not on
// here, which is why no prompt needs a "never use markdown tables" line.
export function renderHtml(text: string): string {
  try {
    return marked.parse(text, { async: false, breaks: true, gfm: true }) as string;
  } catch {
    return escapeHtml(text).replace(/\n/g, "<br/>");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function messageBody(text: string, opts?: SendOpts): Record<string, any> {
  return {
    msgtype: opts?.notice ? "m.notice" : "m.text",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: renderHtml(text),
    ...(opts?.mentions?.length ? { "m.mentions": { user_ids: opts.mentions } } : {}),
  };
}

// --- Transport ---

export class MatrixTransport {
  readonly client: MatrixClient;
  private userId = "";
  private displayName = "";
  private startTs = 0;
  private humansByRoom: Map<string, Set<string>> = new Map();
  private nameCache: Map<string, string> = new Map();

  constructor(homeserverUrl: string, accessToken: string, storagePath: string) {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    this.client = new MatrixClient(
      homeserverUrl,
      accessToken,
      new SimpleFsStorageProvider(storagePath),
    );
  }

  /** MXIDs that count as human in a given room. Everyone else is a sibling agent. */
  setHumans(roomId: string, mxids: string[]): void {
    this.humansByRoom.set(roomId, new Set(mxids));
  }

  async start(): Promise<{ userId: string; displayName: string }> {
    this.userId = await this.client.getUserId();
    try {
      const p = await this.client.getUserProfile(this.userId);
      this.displayName = p?.displayname || this.userId.split(":")[0].slice(1);
    } catch {
      this.displayName = this.userId.split(":")[0].slice(1);
    }
    // Everything before this instant is history. Matrix replays on reconnect
    // on reconnect, and a two-hour outage must not wake N turns.
    this.startTs = Date.now();
    await this.client.start();
    return { userId: this.userId, displayName: this.displayName };
  }

  getUserId(): string { return this.userId; }

  /** The MXID a localpart would have on our own homeserver. */
  mxidFor(localpart: string): string {
    return `@${localpart}:${this.userId.split(":").slice(1).join(":")}`;
  }

  async isJoined(roomId: string, mxid: string): Promise<boolean> {
    const members = await this.client.getJoinedRoomMembers(roomId);
    return members.includes(mxid);
  }

  async shortName(mxid: string): Promise<string> {
    const cached = this.nameCache.get(mxid);
    if (cached) return cached;
    let name = mxid.split(":")[0].replace(/^@/, "");
    try {
      const p = await this.client.getUserProfile(mxid);
      if (p?.displayname) name = p.displayname;
    } catch { /* localpart is a fine fallback */ }
    this.nameCache.set(mxid, name);
    return name;
  }

  /**
   * Register the message handler. Filters out our own echoes, anything from
   * before startup, and non-text events before the caller ever sees them.
   */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.client.on("room.message", async (roomId: string, event: any) => {
      try {
        if (!event?.content) return;
        if (event.sender === this.userId) return;              // our own output
        if ((event.origin_server_ts ?? 0) < this.startTs) return; // backfill
        if (event.content["m.relates_to"]?.rel_type === "m.replace") return; // an edit

        const msgtype = event.content.msgtype;
        const isFile = ["m.image", "m.file", "m.audio", "m.video"].includes(msgtype);
        if (msgtype !== "m.text" && !isFile) return;

        const body: string = event.content.body ?? "";
        const attachments = isFile && event.content.url
          ? [{
              name: body || "attachment",
              mxc: event.content.url as string,
              size: event.content.info?.size ?? 0,
            }]
          : [];

        const humans = this.humansByRoom.get(roomId);
        const senderName = await this.shortName(event.sender);

        const rel = event.content?.["m.relates_to"];
        const threadRootId = rel?.rel_type === "m.thread" ? rel.event_id : undefined;

        handler({
          id: event.event_id,
          roomId,
          threadRootId,
          sender: event.sender,
          senderName,
          content: isFile ? "" : body,
          // No bot flag exists in Matrix. Absent an explicit list every sender
          // counts as human, so a room that admits siblings needs `humans` set
          // or a sibling could answer a confirmation.
          isHuman: humans ? humans.has(event.sender) : true,
          mentionsUs: this.mentionsUs(event),
          attachments,
        }).catch((err) => console.error("[matrix-cc-bot] handler error:", err));
      } catch (err) {
        console.error("[matrix-cc-bot] room.message error:", err);
      }
    });
  }

  private mentionsUs(event: any): boolean {
    // The spec's intentional-mentions field is authoritative when present:
    // a pill in the body then mentions nobody.
    const mentions = event.content?.["m.mentions"];
    if (mentions !== undefined && mentions !== null) {
      const ids = mentions.user_ids;
      return Array.isArray(ids) && ids.includes(this.userId);
    }
    // Absent it, a pill in formatted_body is an <a href="https://matrix.to/#/@user:server">.
    const fb: string = event.content?.formatted_body ?? "";
    // Not the name in plain text: that woke an agent whenever a sibling merely
    // talked about it. Agents address each other with the `message` tool, which sets `m.mentions`.
    return fb.includes(`/#/${this.userId}`);
  }

  /** `threadRootId` puts everything this Room sends inside that thread. Absent,
   *  it sends at the top level, which is what every caller did before threads. */
  room(roomId: string, threadRootId?: string): Room {
    return {
      id: roomId,
      send: async (content, opts) => {
        const text = typeof content === "string" ? content : content.content;
        const inner = messageBody(text, opts);
        const eventId = threadRootId
          ? await this.client.sendEvent(roomId, "m.room.message", { ...inner, ...threadRelation(threadRootId) })
          : await this.client.sendMessage(roomId, inner);
        return this.msg(roomId, eventId, threadRootId);
      },
    };
  }

  msg(roomId: string, eventId: string, threadRootId?: string): Msg {
    return {
      id: eventId,
      roomId,
      edit: async (text, opts) => {
        const inner = messageBody(text, opts);
        await this.client.sendEvent(roomId, "m.room.message", {
          ...inner,
          body: "* " + inner.body,
          "m.new_content": inner,
          "m.relates_to": { rel_type: "m.replace", event_id: eventId },
        });
      },
      reply: async (text, opts) => {
        const inner = messageBody(text, opts);
        const id = await this.client.sendEvent(roomId, "m.room.message", {
          ...inner,
          ...(threadRootId
            ? threadRelation(threadRootId, eventId)
            : { "m.relates_to": { "m.in_reply_to": { event_id: eventId } } }),
        });
        return this.msg(roomId, id, threadRootId);
      },
      delete: async () => { await this.client.redactEvent(roomId, eventId); },
    };
  }

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    await this.client.setTyping(roomId, typing, 30000).catch(() => {});
  }

  /** Authenticated media download: an mxc:// URI is not fetchable on its own. */
  async downloadMedia(mxc: string, filepath: string): Promise<void> {
    const res = await this.client.downloadContent(mxc);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, res.data);
  }
}
