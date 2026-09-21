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

/** Split on fenced code and inline code so a tag inside either is left alone.
 *  An agent pasting `<emet>` into a code block is showing somebody the syntax,
 *  not using it. */
function outsideCode(text: string, fn: (chunk: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join("");
}

/** Every block in `text`, in order. `self` is this agent's own name: a block
 *  addressed to itself is a note to self and is never routed anywhere. */
export function relayBlocks(text: string, self?: string): RelayBlock[] {
  const out: RelayBlock[] = [];
  outsideCode(text, (chunk) => {
    for (const m of chunk.matchAll(RELAY_TAG)) {
      const to = m[1].toLowerCase();
      const body = m[2].trim();
      if (body && to !== self && isAgentName(to)) out.push({ to, body });
    }
    return chunk;
  });
  return out;
}

/** True when `text` carries a block addressed to `self`. This is a mention:
 *  it is how a sibling wakes this agent in a room they share. */
export function addressesUs(text: string, self: string): boolean {
  let found = false;
  outsideCode(text, (chunk) => {
    for (const m of chunk.matchAll(RELAY_TAG)) {
      const name = m[1].toLowerCase();
      if (name === self && isAgentName(name) && m[2].trim()) found = true;
    }
    return chunk;
  });
  return found;
}

/** Matrix clients sanitize incoming HTML against the spec's allowed-tag list,
 *  so `<emet>` would be dropped by Element and the block would render as
 *  unmarked prose — while the plaintext `body` beside it kept the literal tags.
 *  Rendering it as a labelled quote instead keeps the two consistent and keeps
 *  the routing visible to the person reading the room. */
export function markRelayTags(text: string): string {
  return outsideCode(text, (chunk) =>
    chunk.replace(RELAY_TAG, (m, name: string, body: string) => {
      if (!isAgentName(name.toLowerCase())) return m;
      const quoted = body.trim().replace(/\n/g, "\n> ");
      return `\n> **→ ${name}**\n> ${quoted}\n`;
    }));
}
