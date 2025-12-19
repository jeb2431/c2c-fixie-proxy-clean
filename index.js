import express from "express";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const app = express();

// Capture raw request bodies so we can forward exactly what Base44 sends
app.use(express.raw({ type: "*/*", limit: "2mb" }));

// Health check (Render)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Prove outbound traffic is going through Fixie HTTP proxy by fetching our public IP
app.get("/ip", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);
    const r = await undiciFetch("https://api.ipify.org?format=json", { dispatcher });
    const data = await r.json();

    res.json({ via: "fixie-http-undici", ip: data.ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Generic ConsumerDirect forwarder
 * Call:
 *   /cd/<anything>
 * It forwards to:
 *   ${CONSUMERDIRECT_BASE_URL}/<anything>
 *
 * It forwards these headers if present:
 * - authorization
 * - x-api-key
 * - x-internal-secret
 * - content-type
 *
 * And it returns the upstream status + body so debugging is easy.
 */
app.all("/cd/*", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);

    const targetPath = req.originalUrl.replace(/^\/cd/, "");
    const url = new URL(targetPath, baseUrl);

    // Only forward a small, safe set of headers (keeps things deterministic)
    const headers = {};
    const passthrough = ["authorization", "x-api-key", "x-internal-secret", "content-type"];
    for (const h
