// index.js (FULL FILE)
import express from "express";
import { fetch as undiciFetch } from "undici";
import { ProxyAgent } from "proxy-agent";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const UA = "Credit2Credit/1.0 (Render; Fixie; Proxy)";

// IMPORTANT: Only set FIXIE_URL in Render env.
// Do NOT set HTTP_PROXY / HTTPS_PROXY in Render.
const FIXIE_URL = process.env.FIXIE_URL || "";
const dispatcher = FIXIE_URL ? new ProxyAgent(FIXIE_URL) : undefined;

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    hasFixieUrl: !!FIXIE_URL,
    usingProxy: !!dispatcher,
    fixieUrlMasked: FIXIE_URL ? FIXIE_URL.replace(/:\/\/.*@/, "://****:****@") : null,
  });
});

// Try multiple endpoints so we can diagnose if one site is blocked.
// Also returns real error details (message, name, cause, stack preview).
app.get("/debug/ip", async (req, res) => {
  const targets = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.me/all.json",
    "https://ipinfo.io/json",
  ];

  const results = [];

  for (const url of targets) {
    try {
      const r = await undiciFetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": UA },
        dispatcher,
      });

      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }

      const ip =
        json.ip ||
        json.IPv4 ||
        json.address ||
        json.query ||
        (json.ipinfo && json.ipinfo.ip) ||
        null;

      results.push({
        url,
        ok: r.ok,
        status: r.status,
        ip,
        bodyPreview: text?.slice(0, 200) || null,
      });

      // If we got an IP, we can stop early.
      if (ip) {
        return res.json({
          ok: true,
          viaFixie: !!dispatcher,
          ip,
          results,
        });
      }
    } catch (e) {
      results.push({
        url,
        ok: false,
        error: {
          name: e?.name || null,
          message: e?.message || String(e),
          cause: e?.cause ? String(e.cause) : null,
          stack: (e?.stack || "").split("\n").slice(0, 5).join("\n") || null,
        },
      });
    }
  }

  // If none worked, return diagnostics
  return res.status(502).json({
    ok: false,
    viaFixie: !!dispatcher,
    error: "All IP endpoints failed via proxy",
    results,
  });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT} (Fixie=${dispatcher ? "ON" : "OFF"})`);
});
