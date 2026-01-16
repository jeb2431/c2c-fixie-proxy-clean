import express from "express";
import { fetch as undiciFetch } from "undici";
import ProxyAgent from "proxy-agent";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const UA = "Credit2Credit/1.0 (Render; Fixie; Proxy)";

// We ONLY use FIXIE_URL at runtime (do NOT set HTTP_PROXY/HTTPS_PROXY in Render env)
const FIXIE_URL = process.env.FIXIE_URL || "";

// Create a dispatcher (agent) that forces outbound traffic through Fixie
const dispatcher = FIXIE_URL ? new ProxyAgent(FIXIE_URL) : undefined;

app.get("/health", (req, res) => res.json({ ok: true }));

// Debug: confirm whether proxy is actually configured
app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    hasFixieUrl: !!FIXIE_URL,
    usingProxy: !!dispatcher,
    fixieUrlMasked: FIXIE_URL ? FIXIE_URL.replace(/:\/\/.*@/, "://****:****@") : null,
  });
});

// Debug: prove outbound IP (this MUST be 52.5.155.132 or 52.87.82.133)
app.get("/debug/ip", async (req, res) => {
  try {
    const r = await undiciFetch("https://api.ipify.org?format=json", {
      method: "GET",
      headers: { accept: "application/json", "user-agent": UA },
      dispatcher, // <-- THE KEY LINE: forces Fixie
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

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
