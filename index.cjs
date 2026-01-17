// index.cjs — CommonJS proxy (works even if package.json has "type": "module")

const express = require("express");
const { ProxyAgent, setGlobalDispatcher } = require("undici");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// -------------------------
// ENV
// -------------------------
const PORT = process.env.PORT || 10000;

// ConsumerDirect endpoints
const AUTH_BASE = process.env.CD_AUTH_BASE_URL || "https://auth.consumerdirect.io";
const PAPI_BASE = process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io";

// Credentials (PAPI OAuth)
const CLIENT_ID = process.env.CD_PAPI_PROD_CLIENT_ID;
const CLIENT_SECRET = process.env.CD_PAPI_PROD_CLIENT_SECRET;

// Optional scope (only if your account requires it)
const CD_SCOPE = process.env.CD_SCOPE || "";

// Security for calling THIS proxy (Base44 should send this)
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";

// CORS allowlist (comma-separated)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Fixie proxy (optional but recommended if whitelisting requires static IP)
const FIXIE_URL = process.env.FIXIE_URL || "";

// If FIXIE_URL is set, route ALL outgoing fetch() through Fixie (Undici)
if (FIXIE_URL) {
  try {
    setGlobalDispatcher(new ProxyAgent(FIXIE_URL));
    console.log("[proxy] FIXIE enabled");
  } catch (e) {
    console.log("[proxy] FIXIE init failed:", e?.message || e);
  }
}

// -------------------------
// Helpers
// -------------------------
function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;

  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Proxy-Api-Key, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }
}

function requireProxyKey(req, res) {
  if (!PROXY_API_KEY) return true; // if you haven't set one, don't block

  const key =
    req.headers["x-proxy-api-key"] ||
    (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : "");

  if (key !== PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED_PROXY_KEY" });
    return false;
  }
  return true;
}

async function readTextSafe(res) {
  const t = await res.text();
  return t;
}

// -------------------------
// CORS preflight
// -------------------------
app.options("*", (req, res) => {
  setCors(req, res);
  res.status(204).send("");
});

// -------------------------
// Health
// -------------------------
app.get("/", (req, res) => {
  setCors(req, res);
  res.status(200).send("ok");
});

// -------------------------
// OAUTH TOKEN (ConsumerDirect)
// Supports ALL the legacy paths so Base44 never 404s
// -------------------------
async function handleOauthToken(req, res) {
  setCors(req, res);
  if (!requireProxyKey(req, res)) return;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_CD_PAPI_CREDS",
      missing: ["CD_PAPI_PROD_CLIENT_ID", "CD_PAPI_PROD_CLIENT_SECRET"].filter((k) => !process.env[k]),
    });
  }

  try {
    const url = `${AUTH_BASE}/oauth2/token`;

    // Most client_credentials token endpoints expect x-www-form-urlencoded
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    if (CD_SCOPE) body.set("scope", CD_SCOPE);

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const cdRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body,
    });

    const text = await readTextSafe(cdRes);

    // Try parse JSON, but don’t crash if it isn’t
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    if (!cdRes.ok) {
      return res.status(cdRes.status).json({
        ok: false,
        upstream: "consumerdirect_auth",
        status: cdRes.status,
        data: json || { raw: text },
      });
    }

    // Success
    return res.status(200).json(json || { raw: text });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "OAUTH_PROXY_ERROR",
      message: e?.message || String(e),
    });
  }
}

// NEW “correct” path you already used
app.post("/auth/oauth2/token", handleOauthToken);

// Alias paths that previously caused `Cannot POST ...`
app.post("/oauth/token", handleOauthToken);
app.post("/auth/oauth/token", handleOauthToken);
app.post("/auth/oauth2/token", handleOauthToken); // extra safety

// -------------------------
// OPTIONAL: PAPI passthrough (so Base44 can call your proxy for PAPI too)
// Example: GET/POST https://your-proxy.onrender.com/papi/v1/...
// Requires caller to send Authorization: Bearer <papi_access_token>
// -------------------------
app.all("/papi/*", async (req, res) => {
  setCors(req, res);
  if (!requireProxyKey(req, res)) return;

  try {
    const path = req.originalUrl.replace(/^\/papi/, "");
    const url = `${PAPI_BASE}${path}`;

    // forward headers (keep Authorization for Bearer token)
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (["host", "content-length", "connection"].includes(lk)) continue;
      if (lk === "x-proxy-api-key") continue;
      headers[k] = v;
    }

    const method = req.method.toUpperCase();
    const hasBody = !["GET", "HEAD"].includes(method);

    const upstream = await fetch(url, {
      method,
      headers,
      body: hasBody ? (req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : req) : undefined,
    });

    res.status(upstream.status);

    // Copy content-type
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);

    const out = await upstream.arrayBuffer();
    res.send(Buffer.from(out));
  } catch (e) {
    res.status(500).json({ ok: false, error: "PAPI_PROXY_ERROR", message: e?.message || String(e) });
  }
});

// -------------------------
app.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT}`);
});
