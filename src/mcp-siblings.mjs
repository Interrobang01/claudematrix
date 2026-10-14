// The `message` tool: how an agent reaches a sibling.
//
// A stdio MCP server the CLI starts for each turn, from a `--mcp-config` the
// gateway writes for that turn. It holds no state and no Matrix credentials:
// every call is POSTed to the gateway on localhost with the turn's token, and
// the gateway decides where the message goes and what it promises back.
//
// Plain JavaScript on purpose. The CLI starts this with the agent's workspace
// as cwd, where tsx does not resolve, and the guests' Node does not strip
// TypeScript types on its own.
//
// Hand-rolled rather than built on the MCP SDK: one tool, newline-delimited
// JSON-RPC, and nothing to install in three containers.

import { createInterface } from "node:readline";

const URL_ = process.env.SIBLINGS_URL;
const TOKEN = process.env.SIBLINGS_TOKEN;

const TOOL = {
  name: "message",
  description:
    "Send a message to another agent. It is posted in the shared room, where the humans " +
    "there can read it too, and only the text you pass here leaves this conversation. " +
    "The result says whether you will be woken: by their answer, or once after a timeout if none comes. " +
    "Set expect_reply to false for something that needs no answer.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The other agent's name: the localpart of its Matrix ID, e.g. \"alice\"." },
      text: { type: "string", description: "Exactly what they should read. Markdown is rendered." },
      expect_reply: { type: "boolean", description: "Default true. False: no timeout, nothing wakes you about it." },
    },
    required: ["to", "text"],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function callMessage(args) {
  const res = await fetch(`${URL_}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, ...args }),
  });
  const body = await res.json().catch(() => ({ error: `gateway answered HTTP ${res.status}` }));
  return body.error
    ? { content: [{ type: "text", text: body.error }], isError: true }
    : { content: [{ type: "text", text: body.result }] };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // a notification; none need an answer

  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "siblings", version: "1.0.0" },
      } });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    } else if (method === "tools/call" && params?.name === "message") {
      send({ jsonrpc: "2.0", id, result: await callMessage(params.arguments ?? {}) });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text: `Not sent: ${err.message}` }], isError: true,
    } });
  }
});
