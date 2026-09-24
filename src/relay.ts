// Addressing one of the other agents.
//
// An agent addresses somebody by wrapping what it wants them to read in a tag
// named after them:
//
//     <emet>survey X and leave it in /srv/emet-share</emet>
//
// The tag always names the *addressee*, never the speaker; who spoke is the
// `[Name]` prefix the gateway puts on an incoming message, and the two are kept
// separate on purpose. A tag is not evidence of anything — it is a routing
// label written by whoever wrote the message.
//
// Why a tag rather than a bare `@name`. The block is explicitly delimited, so
// what leaves a private room is exactly what the agent chose to send rather
// than whatever else happened to share a line with a name. It survives multiple
// lines and code. And it reads the same in both directions, so the same mark
// that sends a request also marks the answer as text that is not Terry's.
//
// Addressing is local by default: in a room both parties are already in, the
// tag is only a wake signal. A room with `relayRoom` set also *forwards* the
// block into that room, which is how an agent reaches a sibling who is not
// here. See the bridge table in index.ts for how the answer finds its way back.

/** A tag whose name is a bare lowercase word — i.e. an agent's localpart.
 *  Nothing with attributes, and nothing capitalised. */
export const RELAY_TAG = /<([a-z][a-z0-9_-]{0,31})>([\s\S]*?)<\/\1>/g;

/** HTML element names, which this is not. Matrix's own allowed-tag list *is*
 *  HTML, so an agent writing `<code>` or `<b>` outside a fence is writing
 *  markup and meant nothing by it; without this, every such tag would be
 *  forwarded into the shared room addressed to nobody. An agent named after an
 *  HTML element would be a naming problem rather than a parsing one. */
const HTML_TAGS = new Set(`a abbr address area article aside audio b base bdi bdo big blockquote body br
button canvas caption center cite code col colgroup data datalist dd del details dfn dialog div dl dt
em embed fieldset figcaption figure font footer form g h1 h2 h3 h4 h5 h6 head header hgroup hr html i
iframe img input ins kbd label legend li line link main map mark menu meta meter nav noscript object ol
optgroup option output p param path picture pre progress q rect rp rt ruby s samp script search section
select slot small source span strong style sub summary sup svg table tbody td template text textarea
tfoot th thead time title tr track tspan tt u ul use var video wbr`.split(/\s+/));

function isAgentName(name: string): boolean {
  return !HTML_TAGS.has(name);
}

export type RelayBlock = { to: string; body: string };

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

type TagMatch = { start: number; end: number; name: string; body: string };

/** Every `<name>...</name>` in `text` whose tags are outside code. An agent
 *  pasting `<emet>` into a code block is showing somebody the syntax, not
 *  using it — but code *inside* a block is ordinary content, and the block
 *  still counts.
 *
 *  Code spans are blanked in a same-length copy and the tags are found there,
 *  so positions line up and the body is sliced from the original. This used to
 *  split the text at code spans and match each piece on its own, which made any
 *  block containing a backtick invisible: `<oman>Done: `/srv/x.md`</oman>` has
 *  its opening and closing tags in different pieces. That silently dropped a
 *  correctly tagged answer on 2026-09-22 and would have refused to forward any
 *  request with a path or a command in it. */
function tagMatches(text: string): TagMatch[] {
  const masked = text.replace(CODE, (m) => m.replace(/[^\n]/g, "\u0000"));
  const out: TagMatch[] = [];
  for (const m of masked.matchAll(RELAY_TAG)) {
    const name = m[1].toLowerCase();
    if (!isAgentName(name)) continue;
    const start = m.index!;
    const end = start + m[0].length;
    const body = text.slice(start + m[1].length + 2, end - m[1].length - 3);
    out.push({ start, end, name, body });
  }
  return out;
}

/** Every block in `text`, in order. `self` is this agent's own name: a block
 *  addressed to itself is a note to self and is never routed anywhere. */
export function relayBlocks(text: string, self?: string): RelayBlock[] {
  return tagMatches(text)
    .map((t) => ({ to: t.name, body: t.body.trim() }))
    .filter((b) => b.body && b.to !== self);
}

/** True when `text` carries a block addressed to `self`. This is a mention:
 *  it is how a sibling wakes this agent in a room they share. */
export function addressesUs(text: string, self: string): boolean {
  return tagMatches(text).some((t) => t.name === self && t.body.trim() !== "");
}

/** Matrix clients sanitize incoming HTML against the spec's allowed-tag list,
 *  so `<emet>` would be dropped by Element and the block would render as
 *  unmarked prose — while the plaintext `body` beside it kept the literal tags.
 *  Rendering it as a labelled quote instead keeps the two consistent and keeps
 *  the routing visible to the person reading the room. */
export function markRelayTags(text: string): string {
  let out = "";
  let at = 0;
  for (const t of tagMatches(text)) {
    const quoted = t.body.trim().replace(/\n/g, "\n> ");
    out += text.slice(at, t.start) + `\n> **→ ${t.name}**\n> ${quoted}\n`;
    at = t.end;
  }
  return out + text.slice(at);
}
