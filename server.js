// Дубли — Higgsfield bridge
//
// A tiny MCP server that wraps the Higgsfield REST API so the published
// "Дубли" prototype can request real storyboard frames from inside the
// browser (via the artifact's `mcp` capability) without ever touching a
// raw image URL — the CSP inside claude.ai artifacts blocks loading images
// from arbitrary external hosts, so this bridge downloads the generated
// image itself (its own network, not claude.ai's) and hands the bytes
// back as an MCP image content block, base64-encoded. The artifact then
// stores those bytes in its own asset store via `assets.upload()`.
//
// Deploy this somewhere reachable over HTTPS (Render, Railway, your own
// server) and register it as a custom connector in claude.ai. See
// README.md for the exact steps.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const HF_BASE = "https://api.higgsfield.ai";
const HF_API_KEY = process.env.HIGGSFIELD_API_KEY || "";
const BRIDGE_SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || "";
const PORT = process.env.PORT || 3000;

if (!HF_API_KEY) {
  console.warn(
    "[warn] HIGGSFIELD_API_KEY is not set — every generation call will fail. " +
      "Set it in your hosting provider's environment variables (format: <key_id>:<key_secret>)."
  );
}

function hfHeaders(extra) {
  return {
    Authorization: `Key ${HF_API_KEY}`,
    ...extra,
  };
}

// The Higgsfield model used here — "popcorn/auto" — is the one publicly
// documented text-to-image endpoint that fits our use case (single prompt
// in, up to 8 images out, chooseable resolution + aspect ratio). It is
// deliberately NOT the "gpt_image_2_5 / sunburst" model used earlier via
// the Higgsfield MCP connector in chat — that model isn't in Higgsfield's
// public REST API surface as of this writing. Swap the path below if
// Higgsfield exposes it later, or if you'd rather use "soul/standard".
async function createGeneration(prompt, aspectRatio) {
  const res = await fetch(`${HF_BASE}/higgsfield-ai/popcorn/auto`, {
    method: "POST",
    headers: hfHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      prompt,
      num_images: 1,
      resolution: "720p",
      aspect_ratio: aspectRatio || "3:2",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Higgsfield create failed (${res.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Higgsfield create returned non-JSON: ${text.slice(0, 500)}`);
  }
}

// Higgsfield's published docs disagree with themselves on the exact
// status-response shape, so this reads defensively: it walks the JSON
// looking for a plausible "state" field and a plausible image URL rather
// than assuming one fixed field name. If your account's responses don't
// match, check the Render logs (this file logs the raw JSON on first
// failure) and adjust `findState` / `findImageUrl` below.
function findState(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of ["status", "state"]) {
    if (typeof obj[key] === "string") return obj[key].toLowerCase();
  }
  return null;
}

function findImageUrl(obj) {
  const seen = new Set();
  function walk(v) {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = walk(item);
        if (r) return r;
      }
      return null;
    }
    for (const key of Object.keys(v)) {
      const val = v[key];
      if (typeof val === "string" && /^https?:\/\/[^\s"]+\.(png|jpe?g|webp)(\?[^\s"]*)?$/i.test(val)) {
        return val;
      }
      if (val && typeof val === "object") {
        const r = walk(val);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(obj);
}

const DONE_STATES = ["completed", "succeeded", "success", "done", "finished"];
const FAILED_STATES = ["failed", "error", "cancelled", "canceled"];

async function pollUntilDone(created, { timeoutMs = 120000, intervalMs = 2500 } = {}) {
  const statusUrl =
    created.status_url || `${HF_BASE}/requests/${created.request_id}/status`;
  const deadline = Date.now() + timeoutMs;
  let lastRaw = null;
  while (Date.now() < deadline) {
    const res = await fetch(statusUrl, { headers: hfHeaders() });
    const text = await res.text();
    if (!res.ok) throw new Error(`Higgsfield status check failed (${res.status}): ${text.slice(0, 500)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Higgsfield status returned non-JSON: ${text.slice(0, 500)}`);
    }
    lastRaw = data;
    const state = findState(data);
    const url = findImageUrl(data);
    if (url && (state === null || DONE_STATES.includes(state))) return url;
    if (state && FAILED_STATES.includes(state)) {
      throw new Error(`Higgsfield generation failed: ${JSON.stringify(data).slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.error("[timeout] last status payload:", JSON.stringify(lastRaw));
  throw new Error("Timed out waiting for Higgsfield generation to finish.");
}

async function downloadAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading generated image failed (${res.status}) from ${url}`);
  const mimeType = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mimeType: mimeType.split(";")[0].trim() };
}

// ---------- MCP server ----------

const server = new McpServer({ name: "dubli-higgsfield-bridge", version: "1.0.0" });

server.registerTool(
  "generate_frame",
  {
    title: "Generate a storyboard frame",
    description:
      "Generates one still storyboard frame from a full scene/shot description via Higgsfield and returns the image bytes directly (no external URL) so it can be dropped straight into the Дубли prototype.",
    inputSchema: {
      prompt: z
        .string()
        .min(3)
        .describe("Full shot description: action, framing, lens, location, characters — one complete prompt per frame."),
      aspect_ratio: z
        .string()
        .optional()
        .describe('Optional aspect ratio, e.g. "16:9", "3:2", "4:3", "1:1". Defaults to "3:2".'),
    },
  },
  async ({ prompt, aspect_ratio }) => {
    if (!HF_API_KEY) {
      return {
        content: [{ type: "text", text: "HIGGSFIELD_API_KEY is not configured on the bridge server." }],
        isError: true,
      };
    }
    try {
      const created = await createGeneration(prompt, aspect_ratio);
      const imageUrl = await pollUntilDone(created);
      const { data, mimeType } = await downloadAsBase64(imageUrl);
      return { content: [{ type: "image", data, mimeType }] };
    } catch (err) {
      console.error("[generate_frame failed]", err);
      return { content: [{ type: "text", text: String(err && err.message ? err.message : err) }], isError: true };
    }
  }
);

// ---------- HTTP transport ----------

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.all("/mcp", async (req, res) => {
  if (BRIDGE_SHARED_SECRET) {
    const provided = req.headers["x-bridge-secret"] || req.query.secret;
    if (provided !== BRIDGE_SHARED_SECRET) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  try {
    // Stateless: a fresh transport per request avoids keeping session
    // state around between calls from different claude.ai sessions.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp request failed]", err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

app.listen(PORT, () => {
  console.log(`Дубли × Higgsfield bridge listening on :${PORT}`);
});
