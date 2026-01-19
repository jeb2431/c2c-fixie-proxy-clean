// index.cjs  (FULL REPLACEMENT)
// Render proxy for ConsumerDirect/SmartCredit calls via Fixie static IP
// Routes:
//   GET  /            -> basic alive
//   GET  /cd/health   -> health + env check
//   GET  /cd/ip       -> confirms outbound fetch (and proxy) works
//   ALL  /cd/*        -> forwards to ConsumerDirect base URL, using Fixie proxy agents
//
// Security:
//   If CD_PROXY_INTERNAL_SHARED_SECRET is set, all /cd/* routes require header:
//     X-Shared-Secret: <CD_PROXY_INTERNAL_SHARED_SECRET>

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;

// ConsumerDirect base (PAPI) - default to papi.consumerdirect.io
// Step C is calling /cd/v1/... so that will map to https://papi.consumerdirect.io/v1/...
const CD_BASE_URL = (process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io").replace(/\/+$/, "");

// Secret between Base44 and Render proxy
const SHARED_SECRET = (process.env.CD_PROXY_INTERNAL_SHARED_SECRET || "").trim();

// Fixie proxy URL (Render env usually provides FIXIE_URL; sometimes HTTPS_PROXY/HTTP_PROXY)
const FIXIE_URL =
  (process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" })); // adjust if needed
app.use(express.text({ type: ["text/*", "application/x-www-form-urlencoded"], limit: "2mb" }));

function requireSharedSecret(req, res) {
  if (!SHARED_SECRET) return true; // if not set, we won't block (but you SHOULD set it)
  const got = (req.headers["x-shared-secret"] || "").trim();
  if (!got || got !== SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: "Missing/invalid X-Shared-Secret" });
    return false;
  }
  return true;
}

function buildAgents() {
  // If FIXIE_URL isn't set, axios will do direct outbound (not what you want for whitelisting)
  if (!FIXIE_URL) return { httpAgent: undefined, httpsAgent: undefined, proxyEnabled: false };

  return {
    httpAgent: new HttpProxyAgent(FIXIE_URL),
    httpsAgent: new HttpsProxyAgent(FIXIE_URL),
    proxyEnabled: true
  };
}

function safeHeaderNames(headers) {
  return Object.keys(headers || {}).map((h) => h.toLowerCase());
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

app.get("/cd/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    cdBaseUrl: CD_BASE_URL,
    hasSharedSecret: !!SHARED_SECRET,
    hasFixieUrl: !!FIXIE_URL,
    hasHttpsProxyEnv: !!process.env.HTTPS_PROXY,
    hasHttpProxyEnv: !!process.env.HTTP_PROXY
  });
});

// Confirms outbound fetch works from inside Render, and (if FIXIE_URL is set) uses Fixie
app.get("/cd/ip", async (req, res) => {
  try {
    const agents = buildAgents();

    const r = await axios.get("https://api.ipify.org?format=json", {
      timeout: 15000,
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      // IMPORTANT: axios "proxy" option must be false when using custom agents
      proxy: false
    });

    res.status(200).json({
      ok: true,
      proxyEnabled: agents.proxyEnabled,
      ipify: r.data
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "OUTBOUND_FETCH_FAILED",
      message: String(e?.message || e)
    });
  }
});

// Main proxy: forward anything under /cd/* to ConsumerDirect PAPI
app.all("/cd/*", async (req, res) => {
  try {
    if (!requireSharedSecret(req, res)) return;

    // The path after /cd
    const forwardPath = req.originalUrl.replace(/^\/cd/, "");
    const targetUrl = `${CD_BASE_URL}${forwardPath}`;

    // You MUST send Authorization from Base44 to this proxy for ConsumerDirect calls
    // Otherwise ConsumerDirect will reject.
    const auth = req.headers["authorization"];
    if (!auth) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_AUTHORIZATION",
        message: "Base44 must send Authorization: Bearer <papiAccessToken> to the proxy so we can forward it to ConsumerDirect."
      });
    }

    const agents = buildAgents();

    // Forward headers (strip hop-by-hop)
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];

    // Axios expects data in req.body (json middleware) OR raw text
    let data = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      data = req.body;
      // If body is an object, axios will JSON stringify; if it's a string, it will send as-is.
    }

    const axRes = await axios.request({
      method: req.method,
      url: targetUrl,
      headers,
      data,
      timeout: 30000,
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      proxy: false,
      validateStatus: () => true // we forward non-2xx back to caller
    });

    // Forward status + body (and select headers)
    // Do NOT blindly forward all headers (CORS / transfer-encoding / etc).
    const passthroughHeaders = {};
    const allowList = ["content-type", "cache-control", "pragma", "expires"];
    for (const [k, v] of Object.entries(axRes.headers || {})) {
      if (allowList.includes(k.toLowerCase())) passthroughHeaders[k] = v;
    }

    res.status(axRes.status).set(passthroughHeaders).send(axRes.data);
  } catch (e) {
    // This is the "fetch failed" / network-level error bucket
    res.status(500).json({
      ok: false,
      error: "CD_PROXY_FAILED",
      message: String(e?.message || e)
    });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("[proxy] listening", {
    port: PORT,
    cdBaseUrl: CD_BASE_URL,
    hasSharedSecret: !!SHARED_SECRET,
    hasFixieUrl: !!FIXIE_URL,
    fixiePreview: FIXIE_URL ? FIXIE_URL.slice(0, 18) + "…" : null
  });
});
