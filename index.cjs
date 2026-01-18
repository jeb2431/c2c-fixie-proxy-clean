// index.cjs (FULL COPY/REPLACE)

const express = require("express");
const cors = require("cors");

const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------
// ENV
// --------------------
const PORT = process.env.PORT || 10000;

// Where to forward Partner API calls
const CD_PAPI_BASE_URL = (process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io").trim();

// Outbound proxy (Fixie)
const FIXIE_URL = (process.env.FIXIE_URL || "").trim();
const HTTP_PROXY = (process.env.HTTP_PROXY || "").trim();
const HTTPS_PROXY = (process.env.HTTPS_PROXY || "").trim();

// Security keys for calling THIS proxy
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim(); // client sends: x-proxy-api-key
const CD_PROXY_INTERNAL_SHARED_SECRET = (process.env.CD_PROXY_INTERNAL_SHARED_SECRET || "").trim(); // client sends: X-Shared-Secret

// PAPI creds (proxy can mint token if you want)
const CD_PAPI_PROD_CLIENT_ID = (process.env.CD_PAPI_PROD_CLIENT_ID || "").trim();
const CD_PAPI_PROD_CLIENT_SECRET = (process.env.CD_PAPI_PROD_CLIENT_SECRET || "").trim();
const CD_PAPI_SCOPE = (process.env.CD_PAPI_SCOPE || "").trim();
const CD_PAPI_OAUTH_URL = (process.env.CD_PAPI_OAUTH_URL || "https://auth.consumerdirect.io/oauth2/token").trim();

// --------------------
// CORS
// --------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed"), false);
    },
    credentials: true,
  })
);

// --------------------
// Proxy agents (Fixie)
// --------------------
function getUpstreamProxyUrl() {
  return FIXIE_URL || HTTPS_PROXY || HTTP_PROXY || "";
}

function getAgentForUrl(targetUrl) {
  const proxyUrl = getUpstreamProxyUrl();
  if (!proxyUrl) return null;
  if (targetUrl.startsWith("https://")) return new HttpsProxyAgent(proxyUrl);
  return new HttpProxyAgent(proxyUrl);
}

const upstreamProxyUrl = getUpstreamProxyUrl();
if (upstreamProxyUrl) {
  console.log("[proxy] Using upstream proxy:", upstreamProxyUrl.replace(/\/\/.*@/, "//***:***@"));
} else {
  console.log("[proxy] No upstream proxy configured (FIXIE_URL/HTTP_PROXY/HTTPS_PROXY empty)");
}

// --------------------
// Auth helpers
// --------------------
function requireProxyApiKey(req, res, next) {
  if (!PROXY_API_KEY) return res.status(500).json({ ok: false, error: "PROXY_MISSING_PROXY_API_KEY" });
  const got = (req.headers["x-proxy-api-key"] || "").toString().trim();
  if (!got || got !== PROXY_API_KEY) return res.status(401).json({ ok: false, error: "INVALID_PROXY_API_KEY" });
  next();
}

function requireSharedSecret(req, res, next) {
  if (!CD_PROXY_INTERNAL_SHARED_SECRET) return res.status(500).json({ ok: false, error: "PROXY_MISSING_INTERNAL_SHARED_SECRET" });
  const got = (req.headers["x-shared-secret"] || "").toString().trim();
  if (!got || got !== CD_PROXY_INTERNAL_SHARED_SECRET) return res.status(401).json({ ok: false, error: "INVALID_SHARED_SECRET" });
  next();
}

// --------------------
// Health / Debug
// --------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    proxyConfigured: !!getUpstreamProxyUrl(),
    baseUrl: CD_PAPI_BASE_URL,
  });
});

// IMPORTANT: this returns the *true* egress IP by calling ipify THROUGH the upstream proxy agent
app.get("/egress-ip", async (req, res) => {
  try {
    const url = "https://api.ipify.org?format=json";
    const agent = getAgentForUrl(url);
    const r = await fetch(url, { agent });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    res.status(r.status).json(json || { raw: text });
  } catch (e) {
    res.status(500).json({ ok: false, error: "EGRESS_IP_FAILED", message: e?.message || String(e) });
  }
});

// --------------------
// PAPI token mint (optional helper)
// --------------------
app.post("/papi/oauth/token", requireProxyApiKey, async (req, res) => {
  try {
    if (!CD_PAPI_PROD_CLIENT_ID || !CD_PAPI_PROD_CLIENT_SECRET) {
      return res.status(500).json({ ok: false, error: "MISSING_PAPI_CREDS_IN_RENDER" });
    }

    const basic = Buffer.from(`${CD_PAPI_PROD_CLIENT_ID}:${CD_PAPI_PROD_CLIENT_SECRET}`).toString("base64");

    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    if (CD_PAPI_SCOPE) params.set("scope", CD_PAPI_SCOPE);

    const agent = getAgentForUrl(CD_PAPI_OAUTH_URL);

    const r = await fetch(CD_PAPI_OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      agent,
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!r.ok) return res.status(r.status).json({ ok: false, error: "PAPI_OAUTH_FAILED", raw: text, parsed: json });

    return res.json({ ok: true, ...json });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "PAPI_OAUTH_EXCEPTION", message: e?.message || String(e) });
  }
});

// --------------------
// CORE: Forward /papi/* -> https://papi.consumerdirect.io/*
// (strip the leading "/papi")
// --------------------
app.use("/papi", requireProxyApiKey, async (req, res) => {
  try {
    const upstreamPath = req.originalUrl.replace(/^\/papi/, ""); // <-- THIS is the critical fix
    const targetUrl = CD_PAPI_BASE_URL.replace(/\/$/, "") + upstreamPath;

    const agent = getAgentForUrl(targetUrl);

    // copy headers but remove host and our auth header
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["x-proxy-api-key"];

    const r = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      agent,
    });

    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);

    // pass content-type through
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);

    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "PAPI_PROXY_FAILED", message: e?.message || String(e) });
  }
});

// --------------------
// LEGACY: Forward /cd/* -> https://papi.consumerdirect.io/*
// (strip "/cd") + require X-Shared-Secret
// --------------------
app.use("/cd", requireSharedSecret, async (req, res) => {
  try {
    const upstreamPath = req.originalUrl.replace(/^\/cd/, "");
    const targetUrl = CD_PAPI_BASE_URL.replace(/\/$/, "") + upstreamPath;

    const agent = getAgentForUrl(targetUrl);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["x-shared-secret"];

    const r = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      agent,
    });

    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);

    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);

    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "CD_PROXY_FAILED", message: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log("proxy listening on", PORT));
