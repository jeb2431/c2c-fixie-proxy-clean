// index.js (FULL FILE) — Fixie via https-proxy-agent (reliable)

import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const UA = "Credit2Credit/1.0 (Render; Fixie; Proxy)";

// Only set FIXIE_URL in Render env (leave HTTP_PROXY/HTTPS_PROXY unset)
const FIXIE_URL = process.env.FIXIE_URL || "";

// Create a standard HTTPS proxy agent for Node fetch()
const proxyAgent = FIXIE_URL ? new HttpsProxyAgent(FIXIE_URL) : null;

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    hasFixieUrl: !!FIXIE_URL,
    usingProxy: !!proxyAgent,
    fixieUrlMasked: FIXIE_URL ? FIXIE_URL.replace(/:\/\/.*@/, "://****:****@") : null
  });
});

// This will prove the egress IP using Node fetch through Fixie.
app.get("/debug/ip", async (req, res) => {
  const targets = [
    "https://api.ipify.org?format=json",
    "https://ipinfo.io/json",
    "https://ifconfig.me/all.json"
  ];

  const results = [];

  for (const url of targets) {
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { "accept": "application/json", "user-agent": UA },
        // Node fetch (undici) supports dispatcher internally, but proxy agents work via undici global dispatcher
        // The most reliable approach here is to use the "agent" option supported by Node fetch for HTTP(S).
        agent: proxyAgent || undefined
      });

      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }

      const ip =
        json.ip ||
        json.IPv4 ||
        json.address ||
        json.query ||
        null;

      results.push({
        url,
        ok: r.ok,
        status: r.status,
        ip,
        bodyPreview: text.slice(0, 200)
      });

      if (ip) {
        return res.json({
          ok: true,
          viaFixie: !!proxyAgent,
          ip,
          results
        });
      }
    } catch (e) {
      results.push({
        url,
        ok: false,
        error: {
          name: e?.name || null,
          message: e?.message || String(e),
          stack: (e?.stack || "").split("\n").slice(0, 5).join("\n") || null
        }
      });
    }
  }

  return res.status(502).json({
    ok: false,
    viaFixie: !!proxyAgent,
    error: "All IP endpoints failed",
    results
  });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT} (Fixie=${proxyAgent ? "ON" : "OFF"})`);
});
