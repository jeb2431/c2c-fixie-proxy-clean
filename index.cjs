/**
 * index.cjs — C2C Fixie Proxy (CommonJS)
 * - Works even if package.json has "type": "module" because this file is .cjs
 * - Protects proxy with x-proxy-api-key
 * - Uses Fixie if FIXIE_URL is set
 * - Fixes the core bug: incoming /papi/... MUST forward to upstream /... (strip /papi)
 *
 * Expected env vars on Render:
 *   PORT
 *   PROXY_API_KEY                         (required)
 *   FIXIE_URL                             (optional)
 *
 *   CD_AUTH_BASE_URL   (default: https://auth.consumerdirect.io)
 *   CD_PAPI_BASE_URL   (default: https://papi.consumerdirect.io)
 *
 *   CD_PAPI_PROD_CLIENT_ID
 *   CD_PAPI_PROD_CLIENT_SECRET
 *   CD_SCOPE (optional)
 *
 * Optional:
 *   ALLOWED_ORIGINS (comma-separated)
 */

const express = require("express");
const { ProxyAgent, setGlobalDispatcher, fetch, Headers } = require("undici");

const app = express();

// ---------- Body parsing ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const FIXIE_URL = process.env.FIXIE_URL || "";

// ConsumerDirect bases
const AUTH_BASE = process.env.CD_AUTH_BASE_URL || "https://auth.consumerdirect.io";
const PAPI_BASE = process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io";

// OAuth client credentials (PAPI)
const CLIENT_ID = process.env.CD_PAPI_PROD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.CD_PAPI_PROD_CLIENT_SECRET || "";
const CD_SCOPE = process.env.CD_SCOPE || "";

// CORS allowlist (optional)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- Fixie via undici ----------
if (FIXIE_URL) {
  try {
    setGlobalDispatcher(new ProxyAgent(FIXIE_URL));
    console.log("[proxy] FIXIE enabled");
  } catch (e) {
    console.log("[proxy] FIXIE failed to init:", String(e?.message || e));
  }
} else {
  console.log("[proxy] FIXIE not set");
}

// ---------- Helpers ----------
function sendCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-proxy-api-key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }
}

function requireProxyKey(req, res) {
  const key = req.headers["x-proxy-api-key"];
  if (!PROXY_API_KEY) {
    res.status(500).json({ ok: false, error: "PROXY_API_KEY_NOT_CONFIGURED" });
    return false;
  }
  if (!key || key !== PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED_PROXY_KEY" });
    return false;
  }
  return true;
}

function pickForwardHeaders(req) {
  // Forward minimal, safe headers
  const h = new Headers();

  // Authorization (Bearer) and content-type are useful for most API calls
  if (req.headers.authorization) h.set("authorization", req.headers.authorization);
  if (req.headers["content-type"]) h.set("content-type", req.headers["content-type"]);
  if (req.headers.accept) h.set("accept", req.headers.accept);

  // User-Agent: helpful for upstream logs (optional)
  h.set("user-agent", req.headers["user-agent"] || "Credit2Credit/Proxy");

  return h;
}

async function readUpstream(res) {
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  return { text, json };
}

// ---------- Routes ----------

// Health
app.get("/", (_req, res) => res.status(200).send("ok"));

// CORS preflight
app.options("*", (req, res) => {
  sendCors(req, res);
  return res.status(204).end();
});

// 1) Token endpoint: POST /oauth/token  ->  AUTH_BASE + /oauth2/token
app.post("/oauth/token", async (req, res) => {
  sendCors(req, res);
  if (!requireProxyKey(req, res)) return;

  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_CD_PAPI_PROD_CLIENT_ID_OR_SECRET",
      });
    }

    // Accept either JSON body or form body from caller
    const grant_type = req.body?.grant_type || "client_credentials";
    const scope = req.body?.scope ?? CD_SCOPE;

    const body = new URLSearchParams();
    body.set("grant_type", grant_type);
    if (scope) body.set("scope", scope);

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const upstreamUrl = `${AUTH_BASE.replace(/\/+$/, "")}/oauth2/token`;

    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });

    const { text, json } = await readUpstream(upstreamRes);

    // Pass through status code + body
    res.status(upstreamRes.status);
    if (json) return res.json(json);
    return res.send(text);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "TOKEN_PROXY_ERROR",
      debug: String(e?.message || e),
    });
  }
});

// 2) PAPI forwarder: ANY /papi/*  ->  PAPI_BASE + (strip leading /papi)
app.all("/papi/*", async (req, res) => {
  sendCors(req, res);
  if (!requireProxyKey(req, res)) return;

  try {
    // ✅ THIS IS THE FIX:
    // incoming: /papi/v1/partners/me
    // upstream:  /v1/partners/me
    const upstreamPath = req.originalUrl.replace(/^\/papi/, "");
    const upstreamUrl = `${PAPI_BASE.replace(/\/+$/, "")}${upstreamPath}`;

    const headers = pickForwardHeaders(req);

    // Determine body: for GET/HEAD no body
    const method = req.method.toUpperCase();
    let body = undefined;

    if (!["GET", "HEAD"].includes(method)) {
      if (req.is("application/json")) {
        body = JSON.stringify(req.body ?? {});
        if (!headers.get("content-type")) headers.set("content-type", "application/json");
      } else if (req.is("application/x-www-form-urlencoded")) {
        // If caller sent urlencoded, express already parsed it
        const params = new URLSearchParams();
        Object.entries(req.body || {}).forEach(([k, v]) => params.set(k, String(v)));
        body = params.toString();
        headers.set("content-type", "application/x-www-form-urlencoded");
      } else {
        // Fallback: if caller posted raw, express may not preserve it; prefer JSON or urlencoded
        body = JSON.stringify(req.body ?? {});
        headers.set("content-type", "application/json");
      }
    }

    const upstreamRes = await fetch(upstreamUrl, { method, headers, body });
    const { text, json } = await readUpstream(upstreamRes);

    res.status(upstreamRes.status);
    if (json) return res.json(json);
    return res.send(text);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "PAPI_PROXY_ERROR",
      debug: String(e?.message || e),
    });
  }
});

// Fallback for unknown routes
app.use((req, res) => {
  sendCors(req, res);
  res.status(404).json({ ok: false, error: "NOT_FOUND", path: req.originalUrl });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT}`);
});
