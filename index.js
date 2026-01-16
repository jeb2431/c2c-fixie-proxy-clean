// index.js
// FULL FILE — copy/paste this entire file into GitHub (replace everything), then commit + redeploy on Render.

import express from "express";
import { fetch as undiciFetch } from "undici";
import { ProxyAgent } from "proxy-agent";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const UA = "Credit2Credit/1.0 (Render; Fixie; Proxy)";

// IMPORTANT: Do NOT set HTTP_PROXY / HTTPS_PROXY in Render.
// Only set FIXIE_URL (your authenticated Fixie proxy URL).
const FIXIE_URL = process.env.FIXIE_URL || "";

// Force outbound traffic through Fixie using undici dispatcher
const dispatcher = FIXIE_URL ? new ProxyAgent(FIXIE_URL) : undefined;

app.get("/health", (req, res) => res.json({ ok: true }));

// Shows whether FIXIE_URL is present and whether we are using the proxy dispatcher
app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    hasFixieUrl: !!FIXIE_URL,
    usingProxy: !!dispatcher,
    fixieUrlMasked: FIXIE_URL ? FIXIE_URL.replace(/:\/\/.*@/, "://****:****@") : null,
  });
});

// Proves the egress IP (should be 52.5.155.132 or 52.87.82.133)
app.get("/debug/ip", async (req, res) => {
  try {
    const r = await undiciFetch("https://api.ipify.org?format=json", {
      method: "GET",
      headers: { accept: "application/json", "user-agent": UA },
      dispatcher, // <-- THE KEY: routes through Fixie
    });

    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    res.json({
      ok: true,
      status: r.status,
      ip: json.ip || null,
      viaFixie: !!dispatcher,
      raw: json.raw || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT} (Fixie=${dispatcher ? "ON" : "OFF"})`);
});
