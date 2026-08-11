// foundry-stream-shim.mjs — a thin local proxy that repairs Foundry Local's OpenAI-compatible
// stream so agent harnesses (GHCP CLI in BYOK mode, any OpenAI-SDK agent) see structured tool calls.
//
// The defect is tracked at https://github.com/microsoft/foundry-local/issues/874:
//   streaming path emits the model's `<tool_call>…</tool_call>` template as raw `delta.content`
//   text with `delta.tool_calls: []` on every frame, wrapped in a non-spec chunk shape (redundant
//   `message`, plus `IsDelta`/`Successful`/`HttpStatusCode`/`CreatedAt`).
//
// What this shim does, per OpenAI spec:
//   1. Parse the leaked `<tool_call>` markup back into structured, indexed `delta.tool_calls`
//      and synthesize `finish_reason:"tool_calls"`.
//   2. Strip the tool-call markup out of `content` (both stream and non-stream).
//   3. Re-emit clean `chat.completion.chunk`s — no `message`, no Betalgo internals.
// Plain (non-tool) content streams straight through with minimal buffering.
//
// The server binary is closed, so this is a client-side unblock, not the upstream fix. When Foundry
// Local ships the real fix, drop the shim and point the harness straight at :57101.
//
// Run:   node foundry-stream-shim.mjs                 # listens :57199, upstream :57101
//        SHIM_PORT=8080 UPSTREAM=http://127.0.0.1:57101 node foundry-stream-shim.mjs
// Point an OpenAI-compatible harness at http://127.0.0.1:57199/v1.

import http from "node:http";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";
// Betalgo/Foundry response-object internals that must not reach a spec client.
const JUNK_KEYS = ["message", "IsDelta", "Successful", "HttpStatusCode", "CreatedAt"];
// In a NON-stream response, `message` is the real payload — only the Betalgo internals are junk.
const NONSTREAM_JUNK = ["IsDelta", "Successful", "HttpStatusCode", "CreatedAt"];

function requireLoopbackUpstream(upstream) {
  let parsed;
  try { parsed = new URL(upstream); }
  catch { throw new Error("upstream must be an absolute URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("upstream must be credential-free HTTP(S)");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" ||
    (isIP(host) === 4 && host.startsWith("127.")) ||
    (isIP(host) === 6 && host === "::1");
  if (!loopback) throw new Error("upstream must be loopback");
  return upstream.replace(/\/+$/, "");
}

function newCallId() {
  return "call_" + crypto.randomBytes(6).toString("hex");
}

// Turn the inner JSON of a `<tool_call>` block into a spec function-call object.
// The model emits {"name": ..., "arguments": {...}} (arguments as an OBJECT); OpenAI requires
// `function.arguments` to be a JSON STRING, so we stringify. Falls back to `parameters`.
function toToolCall(innerJson, index) {
  const name = innerJson.name ?? innerJson.function?.name;
  let args = innerJson.arguments ?? innerJson.parameters ?? innerJson.function?.arguments ?? {};
  if (typeof args !== "string") args = JSON.stringify(args);
  return { index, id: newCallId(), type: "function", function: { name, arguments: args } };
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}

function stripNullObjectValues(value) {
  if (Array.isArray(value)) return value.map(stripNullObjectValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, stripNullObjectValues(item)]),
    );
  }
  return value;
}

function normalizeToolCall(call, fallbackIndex = 0) {
  const name = call?.function?.name ?? call?.name;
  let args = call?.function?.arguments ?? call?.arguments ?? call?.parameters ?? {};
  if (typeof args === "string") {
    try { args = stripNullObjectValues(JSON.parse(args)); }
    catch { return { ...call, index: call.index ?? fallbackIndex }; }
  } else {
    args = stripNullObjectValues(args);
  }
  return {
    index: call.index ?? fallbackIndex,
    id: call.id || newCallId(),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function toolCallSignature(call) {
  const name = call?.function?.name ?? call?.name;
  let args = call?.function?.arguments ?? call?.arguments ?? call?.parameters ?? {};
  if (!name) return null;
  try {
    if (typeof args === "string") args = JSON.parse(args);
    return `${name}\0${JSON.stringify(sortObject(args))}`;
  } catch {
    return null;
  }
}

// Extract every complete <tool_call>…</tool_call> block from text.
// Returns { calls: [...], rest: <text with the blocks removed>, open: <bool: an unclosed block remains> }.
function extractToolCalls(text, startIndex = 0) {
  const calls = [];
  let rest = text;
  let idx = startIndex;
  let open = false;
  while (true) {
    const start = rest.indexOf(TOOL_OPEN);
    if (start === -1) break;
    const end = rest.indexOf(TOOL_CLOSE, start + TOOL_OPEN.length);
    if (end === -1) { open = true; break; } // block not fully arrived yet
    const inner = rest.slice(start + TOOL_OPEN.length, end).trim();
    try {
      calls.push(toToolCall(JSON.parse(inner), idx++));
    } catch {
      // inner JSON not valid yet / unparseable — treat as still-open and wait for more.
      open = true;
      break;
    }
    rest = rest.slice(0, start) + rest.slice(end + TOOL_CLOSE.length);
  }
  return { calls, rest, open, nextIndex: idx };
}

// Stateful repairer: feed it each upstream `delta` object, get back spec chunk deltas to emit.
// Modes: "undecided" (buffering until we know if it's a tool call) → "passthrough" | "toolcall".
export class StreamRepairer {
  constructor(meta = {}) {
    this.meta = { id: meta.id || "chatcmpl-shim", created: meta.created || Math.floor(Date.now() / 1000), model: meta.model || "unknown" };
    this.mode = "undecided";
    this.buffer = "";
    this.toolIndex = 0;
    this.emittedToolCall = false;
    this.roleSent = false;
    this.sawAnyContent = false;
    this.nativeCalls = new Map();
    this.pendingLeakedCalls = [];
  }

  _chunk(delta, finish_reason = null) {
    if (!this.roleSent) {
      delta = { role: "assistant", ...delta };
      this.roleSent = true;
    }
    return { id: this.meta.id, object: "chat.completion.chunk", created: this.meta.created, model: this.meta.model,
             choices: [{ index: 0, delta, finish_reason }] };
  }

  // Returns an array of spec chunks (possibly empty).
  push(delta) {
    const out = [];
    if (!this.meta._captured && delta.role) this.meta._captured = true;
    // Buffer native fragments until finish so leaked duplicate markup can be de-duplicated and
    // optional null arguments can be removed before the harness validates the tool schema.
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      this.emittedToolCall = true;
      for (const call of delta.tool_calls) {
        const index = Number.isInteger(call.index) ? call.index : 0;
        const accumulated = this.nativeCalls.get(index) || {
          index,
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) accumulated.id += call.id;
        if (call.type) accumulated.type = call.type;
        if (call.function?.name) accumulated.function.name += call.function.name;
        if (typeof call.function?.arguments === "string") {
          accumulated.function.arguments += call.function.arguments;
        }
        this.nativeCalls.set(index, accumulated);
        this.toolIndex = Math.max(this.toolIndex, index + 1);
      }
    }
    const content = typeof delta.content === "string" ? delta.content : "";
    if (content === "") return out;
    this.sawAnyContent = true;

    if (this.mode === "passthrough") {
      out.push(this._chunk({ content }));
      return out;
    }

    // undecided or toolcall: accumulate then evaluate.
    this.buffer += content;

    if (this.mode === "undecided") {
      const lead = this.buffer.replace(/^\s+/, "");
      if (lead === "") return out;                                   // only whitespace so far — wait
      if (TOOL_OPEN.startsWith(lead)) return out;                    // still a prefix of "<tool_call>" — wait
      if (lead.startsWith(TOOL_OPEN)) {
        this.mode = "toolcall";
        this.buffer = lead;                                          // drop leading whitespace before the marker
      } else {
        // Definitely not a tool call — flush what we buffered and stream the rest.
        this.mode = "passthrough";
        out.push(this._chunk({ content: this.buffer }));
        this.buffer = "";
        return out;
      }
    }

    // toolcall mode: pull out any complete blocks.
    if (this.mode === "toolcall") {
      const { calls, rest, nextIndex } = extractToolCalls(this.buffer, this.toolIndex);
      if (calls.length) {
        this.toolIndex = nextIndex;
        this.emittedToolCall = true;
        this.pendingLeakedCalls.push(...calls);
        this.buffer = rest;
      }
    }
    return out;
  }

  // Call once the upstream stream ends. Emits the terminal chunk with the right finish_reason.
  finish(upstreamFinish) {
    const out = [];
    if (this.mode === "undecided" && this.buffer.replace(/^\s+/, "") !== "") {
      // Buffered content that never resolved to a tool call — flush it as plain content.
      out.push(this._chunk({ content: this.buffer }));
      this.buffer = "";
    }
    const emittedSignatures = new Set();
    const calls = [];
    for (const [index, call] of [...this.nativeCalls.entries()].sort(([a], [b]) => a - b)) {
      const normalized = normalizeToolCall(call, index);
      if (!normalized.function?.name) continue;
      const signature = toolCallSignature(normalized);
      if (signature) emittedSignatures.add(signature);
      calls.push(normalized);
    }
    for (const call of this.pendingLeakedCalls) {
      const normalized = normalizeToolCall(call, calls.length);
      if (!normalized.function?.name) continue;
      const signature = toolCallSignature(normalized);
      if (signature && emittedSignatures.has(signature)) continue;
      if (signature) emittedSignatures.add(signature);
      calls.push(normalized);
    }
    for (const call of calls) out.push(this._chunk({ tool_calls: [call] }));
    const hasToolCalls = calls.length > 0;
    const finish = hasToolCalls ? "tool_calls" : (upstreamFinish || "stop");
    out.push(this._chunk(hasToolCalls ? {} : { content: "" }, finish));
    return out;
  }
}

// Clean a NON-streaming completion object in place: lift `<tool_call>` markup out of content into
// structured tool_calls, and drop the junk keys.
export function cleanNonStreamResponse(obj) {
  for (const k of NONSTREAM_JUNK) delete obj[k];
  for (const choice of obj.choices || []) {
    for (const k of NONSTREAM_JUNK) delete choice[k];
    const m = choice.message;
    if (!m) continue;
    if (Array.isArray(m.tool_calls)) {
      m.tool_calls = m.tool_calls
        .map((call, index) => normalizeToolCall(call, index))
        .filter((call) => call.function?.name);
    }
    if (typeof m.content !== "string" || !m.content.includes(TOOL_OPEN)) continue;
    const before = m.content.slice(0, m.content.indexOf(TOOL_OPEN)).trim();
    const { calls } = extractToolCalls(m.content);
    if (calls.length) {
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
        m.tool_calls = calls.map((call, index) => normalizeToolCall(call, index));
      }
      m.content = before; // strip the leaked markup (keep any real prose that preceded it)
      if (choice.finish_reason == null) choice.finish_reason = "tool_calls";
    }
  }
  return obj;
}

// ---- HTTP proxy ---------------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function handleChat(req, res, rawBody, upstream) {
  let body;
  try { body = JSON.parse(rawBody.toString("utf8") || "{}"); }
  catch { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"invalid JSON body"}'); return; }

  const url = upstream + "/v1/chat/completions";
  const wantsStream = body.stream === true;

  if (!wantsStream) {
    const up = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    });
    const text = await up.text();
    let cleaned = text;
    try { cleaned = JSON.stringify(cleanNonStreamResponse(JSON.parse(text))); } catch { /* pass raw through */ }
    res.writeHead(up.status, { "content-type": "application/json" });
    res.end(cleaned);
    return;
  }

  // Streaming: forward with stream:true, repair the SSE, re-emit spec chunks.
  const up = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    redirect: "error",
  });
  res.writeHead(up.status, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

  const repairer = new StreamRepairer({ model: body.model });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const dec = new TextDecoder();
  let pending = "";
  let lastFinish = null;

  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "" ) return;
    if (payload === "[DONE]") return; // handled after the loop
    let j; try { j = JSON.parse(payload); } catch { return; }
    if (!repairer.meta._metaSet) {
      if (j.id) repairer.meta.id = j.id;
      if (j.created) repairer.meta.created = j.created;
      if (j.model) repairer.meta.model = j.model;
      repairer.meta._metaSet = true;
    }
    const choice = j.choices?.[0];
    if (choice?.finish_reason) lastFinish = choice.finish_reason;
    const delta = choice?.delta;
    if (delta) for (const chunk of repairer.push(delta)) write(chunk);
  };

  try {
    for await (const buf of up.body) {
      pending += dec.decode(buf, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) handleLine(line);
    }
    if (pending) handleLine(pending);
  } catch (e) {
    // Upstream stream died; still flush a clean terminal frame so the client isn't left hanging.
    res.write(`data: ${JSON.stringify({ error: { message: `upstream stream error: ${e.message}` } })}\n\n`);
  }

  for (const chunk of repairer.finish(lastFinish)) write(chunk);
  res.write("data: [DONE]\n\n");
  res.end();
}

// Transparent proxy for everything else (e.g. GET /v1/models).
async function handlePassthrough(req, res, rawBody, upstream) {
  const up = await fetch(upstream + req.url, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] || "application/json" },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : rawBody,
    redirect: "error",
  });
  const text = await up.text();
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
  res.end(text);
}

export function startShim({ port = 57199, upstream = "http://127.0.0.1:57101" } = {}) {
  upstream = requireLoopbackUpstream(upstream);
  const server = http.createServer(async (req, res) => {
    try {
      const rawBody = await readBody(req);
      if (req.method === "POST" && req.url.replace(/\/+$/, "").endsWith("/chat/completions")) {
        await handleChat(req, res, rawBody, upstream);
      } else {
        await handlePassthrough(req, res, rawBody, upstream);
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `shim error: ${e.message}` } }));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(import.meta.url));
  const invokedPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === invokedPath.toLowerCase()
    : modulePath === invokedPath;
}

// Run directly -> start the server.
if (isDirectInvocation()) {
  const port = Number(process.env.SHIM_PORT || 57199);
  const upstream = process.env.UPSTREAM || "http://127.0.0.1:57101";
  startShim({ port, upstream }).then(() => {
    console.log(`foundry-stream-shim listening on http://127.0.0.1:${port}  → upstream ${upstream}`);
  });
}
