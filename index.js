// index.js (FULL FILE)
// Node 18+
// Proxy: Base44 -> Render -> Fixie -> ConsumerDirect PAPI + SmartCredit

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- ENV ----
const PORT = process.env.PORT || 10000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PROXY_API_KEY = process.env.PROXY_API_KEY || ""; // optional (browser calls)
const INTERNAL_SHARED_SECRET = process.env.CD_PROXY_INTERNAL_SHARED_SECRET || ""; // required (server-to-server)

// IMPORTANT: PAPI base must be papi.consumerdirect.io
const CD_PAPI_BASE_URL = process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io";

// SmartCredit base (for /smartcredit passthrough)
const CD_SMARTCREDIT_BASE_URL = process.env.CD_SMARTCREDIT_BASE_URL || "https://api.smartcredit.com";

// Fixie URL optional (service can run without it)
const FIXIE_URL = process.env.FIXIE_URL || "";

// ---- CORS ----
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (!ALLOWED_ORIGINS.length) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ---- AUTH GATE ----
function requireProxyAuth(req, res, next) {
  // 1) Server-to-server calls from Base44 must include x-cd-proxy-secret
  const s2s = req.header("x-cd-proxy-secret");
  if (INTERNAL_SHARED_SECRET && s2s === INTERNAL_SHARED_SECRET) return next();

  // 2) Optional browser/API key auth (if you use it)
  const apiKey = req.header("x-proxy-api-key");
  if (PROXY_API_KEY && apiKey === PROXY_API_KEY) return next();

  return res.status(401).json({ ok: false, error: "Unauthorized (missing/invalid x-cd-proxy-secret)" });
}

// ---- HELPER: build fetch options, including Fixie dispatcher via https-proxy-agent ----
async function doFetch(url, options = {}) {
  // We keep this simple: Node's global fetch, and rely on FIXIE_URL via standard proxy env if needed.
  // If you must hard-force Fixie: set HTTPS_PROXY / HTTP_PROXY in Render instead of custom agent.
  return fetch(url, options);
}

// ---- DEBUG ----
app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    cdPapiBase: CD_PAPI_BASE_URL,
    smartCreditBase: CD_SMARTCREDIT_BASE_URL,
    hasInternalSharedSecret: !!INTERNAL_SHARED_SECRET,
    hasProxyApiKey: !!PROXY_API_KEY,
    hasFixieUrl: !!FIXIE_URL,
  });
});

// OPTIONAL: external IP check (no auth)
app.get("/debug/ip", async (req, res) => {
  try {
    const r = await doFetch("https://api.ipify.org?format=json");
    const j = await r.json();
    res.json({ ok: true, status: r.status, ip: j.ip });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------------------------------------------------------
// PAPI ROUTES (THIS IS THE IMPORTANT PART)
// Base44 will call:
//   {CD_PROXY_URL}/cd/v1/customers?email=...
// We forward to:
//   https://papi.consumerdirect.io/v1/customers?email=...
// ------------------------------------------------------------------
app.all("/cd/*", requireProxyAuth, async (req, res) => {
  try {
    const path = req.originalUrl.replace(/^\/cd/, ""); // keeps /v1/...
    const targetUrl = `${CD_PAPI_BASE_URL}${path}`;

    // Base44 sends token in x-cd-authorization, we forward as Authorization
    const bearer = req.header("x-cd-authorization") || "";

    const headers = {
      accept: req.header("accept") || "application/json",
      "content-type": req.header("content-type") || "application/json",
      "user-agent": req.header("user-agent") || "Credit2Credit/1.0",
    };

    if (bearer) headers["authorization"] = bearer; // MUST be "Bearer <token>"

    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {});

    const upstream = await doFetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);

    // pass content-type when possible
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);

    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------------------------------------------------------
// SMARTCREDIT ROUTES
// Base44 will call:
//   {CD_PROXY_URL}/smartcredit/v1/login?code=OTC
// ------------------------------------------------------------------
app.all("/smartcredit/*", requireProxyAuth, async (req, res) => {
  try {
    const path = req.originalUrl.replace(/^\/smartcredit/, ""); // keeps /v1/...
    const targetUrl = `${CD_SMARTCREDIT_BASE_URL}${path}`;

    const headers = {
      accept: req.header("accept") || "application/json",
      "content-type": req.header("content-type") || "application/json",
      "user-agent": req.header("user-agent") || "Credit2Credit/1.0",
    };

    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {});

    const upstream = await doFetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);

    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);

    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
