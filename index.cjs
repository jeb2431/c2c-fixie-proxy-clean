// index.cjs (FULL REPLACE)

const express = require("express");
const { ProxyAgent, setGlobalDispatcher } = require("undici");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ---- FORCE OUTBOUND TRAFFIC THROUGH FIXIE ----
const FIXIE_URL = process.env.FIXIE_URL;

if (FIXIE_URL) {
  const agent = new ProxyAgent(FIXIE_URL);
  setGlobalDispatcher(agent);

  process.env.HTTP_PROXY = FIXIE_URL;
  process.env.HTTPS_PROXY = FIXIE_URL;

  console.log("[proxy] FIXIE enabled");
} else {
  console.log("[proxy] FIXIE_URL NOT SET — OTC WILL FAIL");
}

// ---- Shared Secret Auth (Base44 internal -> proxy) ----
function requireSharedSecret(req, res) {
  const key = req.headers["x-shared-secret"];
  if (!key || key !== process.env.CD_PROXY_INTERNAL_SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "INVALID_SHARED_SECRET" });
    return false;
  }
  return true;
}

app.get("/health", (req, res) =>
  res.json({ ok: true, fixie: !!process.env.FIXIE_URL })
);

// OPTIONAL: verify egress IP (you already used this)
app.get("/egress-ip", async (req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { method: "GET" });
    const j = await r.json();
    return res.json({ ok: true, fixie: !!process.env.FIXIE_URL, ip: j?.ip || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "EGRESS_IP_FAILED", message: String(e) });
  }
});

/**
 * ✅ WORKING ROUTE FAMILY (the one that previously produced OTC codes):
 * Base44 -> proxy:
 *   POST /cd/v1/customers/{customerToken}/otcs/login-as
 *   Header: X-Shared-Secret: <CD_PROXY_INTERNAL_SHARED_SECRET>
 *
 * Proxy -> upstream:
 *   https://papi.consumerdirect.io/v1/customers/{customerToken}/otcs/login-as
 *
 * Note: We REMOVE the "/cd" prefix when forwarding upstream.
 */
app.use("/cd", async (req, res) => {
  try {
    if (!requireSharedSecret(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/cd/, "");
    const upstreamUrl = `https://papi.consumerdirect.io${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"],
      // IMPORTANT: No Bearer token needed for this specific working flow
      // We are only forwarding whitelisted-IP traffic with shared-secret gate.
    };
    Object.keys(headers).forEach((k) => headers[k] === undefined && delete headers[k]);

    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      // In the working flow, OTC had no body. But we safely pass if present.
      body = JSON.stringify(req.body ?? {});
    }

    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    const text = await upstream.text();

    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    console.error("cd_exception", e);
    return res.status(500).json({ ok: false, step: "cd_exception", message: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`));
