import express from "express";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const app = express();

// Capture raw request bodies so we can forward exactly what Base44 sends
app.use(express.raw({ type: "*/*", limit: "5mb" }));

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
 * ConsumerDirect forwarder
 * Request:
 *   /cd/<path>
 * Forwards to:
 *   ${CONSUMERDIRECT_BASE_URL}/<path>
 */
app.all("/cd/*", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);

    // Build target URL
    const targetPath = req.originalUrl.replace(/^\/cd/, "");
    const url = new URL(targetPath, baseUrl);

    // Forward a controlled set of headers (keep deterministic)
    const headers = {};
    const passthrough = ["authorization", "x-api-key", "x-internal-secret", "content-type", "accept"];

    for (const h of passthrough) {
      const v = req.headers[h];
      if (v) headers[h] = v;
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";

    const upstream = await undiciFetch(url.toString(), {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      dispatcher
    });

    const text = await upstream.text();

    // Return upstream status + body exactly
    res.status(upstream.status);
    res.set("x-cd-proxy-status", String(upstream.status));
    res.set("content-type", upstream.headers.get("content-type") || "text/plain");
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Proxy running on port ${port}`);
});
