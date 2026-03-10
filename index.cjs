// index.cjs  (FULL REPLACEMENT)
// Render proxy for ConsumerDirect/SmartCredit + Dispute Desk calls via Fixie static IP
//
// Routes:
//   GET  /                      -> basic alive
//   GET  /cd/health             -> ConsumerDirect health + env check
//   GET  /cd/ip                 -> confirms outbound fetch (and proxy) works
//   ALL  /cd/*                  -> forwards to ConsumerDirect base URL via Fixie
//
//   GET  /disputedesk/health    -> Dispute Desk health + env check
//   GET  /disputedesk/ip        -> confirms outbound fetch (and proxy) works
//   ALL  /disputedesk/*         -> forwards to Dispute Desk base URL via Fixie
//
// Security:
//   If CD_PROXY_INTERNAL_SHARED_SECRET is set, all /cd/* and /disputedesk/* routes require header:
//     X-Shared-Secret: <CD_PROXY_INTERNAL_SHARED_SECRET>

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;

// ConsumerDirect base (PAPI)
const CD_BASE_URL = (process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io").replace(/\/+$/, "");

// Dispute Desk base
const DISPUTE_DESK_BASE_URL = (process.env.DISPUTE_DESK_BASE_URL || "https://api.disputedesk.com").replace(/\/+$/, "");

// Secret between Base44 and Render proxy
const SHARED_SECRET = (process.env.CD_PROXY_INTERNAL_SHARED_SECRET || "").trim();

// Fixie proxy URL
const FIXIE_URL =
  (process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ["text/*", "application/x-www-form-urlencoded"], limit: "5mb" }));

function requireSharedSecret(req, res) {
  if (!SHARED_SECRET) return true;
  const got = (req.headers["x-shared-secret"] || "").trim();
  if (!got || got !== SHARED_SECRET) {
    res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "Missing/invalid X-Shared-Secret"
    });
    return false;
  }
  return true;
}

function buildAgents() {
  if (!FIXIE_URL) {
    return { httpAgent: undefined, httpsAgent: undefined, proxyEnabled: false };
  }

  return {
    httpAgent: new HttpProxyAgent(FIXIE_URL),
    httpsAgent: new HttpsProxyAgent(FIXIE_URL),
    proxyEnabled: true
  };
}

async function testOutbound(url) {
  const agents = buildAgents();

  const r = await axios.get(url, {
    timeout: 15000,
    httpAgent: agents.httpAgent,
    httpsAgent: agents.httpsAgent,
    proxy: false,
    validateStatus: () => true
  });

  return {
    proxyEnabled: agents.proxyEnabled,
    status: r.status,
    data: r.data
  };
}

async function forwardRequest(req, res, { baseUrl, prefix, requireAuthorization }) {
  try {
    if (!requireSharedSecret(req, res)) return;

    const forwardPath = req.originalUrl.replace(new RegExp(`^\\/${prefix}`), "");
    const targetUrl = `${baseUrl}${forwardPath}`;

    if (requireAuthorization) {
      const auth = req.headers["authorization"];
      if (!auth) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_AUTHORIZATION",
          message: "Base44 must send Authorization: Bearer <token> to the proxy so we can forward it."
        });
      }
    }

    const agents = buildAgents();

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];

    let data = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      data = req.body;
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
      validateStatus: () => true
    });

    const passthroughHeaders = {};
    const allowList = ["content-type", "cache-control", "pragma", "expires"];
    for (const [k, v] of Object.entries(axRes.headers || {})) {
      if (allowList.includes(k.toLowerCase())) passthroughHeaders[k] = v;
    }

    res.status(axRes.status).set(passthroughHeaders).send(axRes.data);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: `${prefix.toUpperCase()}_PROXY_FAILED`,
      message: String(e?.message || e)
    });
  }
}

// ---------- Base Routes ----------
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// ---------- ConsumerDirect Routes ----------
app.get("/cd/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    route: "cd",
    cdBaseUrl: CD_BASE_URL,
    hasSharedSecret: !!SHARED_SECRET,
    hasFixieUrl: !!FIXIE_URL,
    hasHttpsProxyEnv: !!process.env.HTTPS_PROXY,
    hasHttpProxyEnv: !!process.env.HTTP_PROXY
  });
});

app.get("/cd/ip", async (_req, res) => {
  try {
    const result = await testOutbound("https://api.ipify.org?format=json");
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "OUTBOUND_FETCH_FAILED",
      message: String(e?.message || e)
    });
  }
});

app.all("/cd/*", async (req, res) => {
  return forwardRequest(req, res, {
    baseUrl: CD_BASE_URL,
    prefix: "cd",
    requireAuthorization: true
  });
});

// ---------- Dispute Desk Routes ----------
app.get("/disputedesk/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    route: "disputedesk",
    disputeDeskBaseUrl: DISPUTE_DESK_BASE_URL,
    hasSharedSecret: !!SHARED_SECRET,
    hasFixieUrl: !!FIXIE_URL,
    hasHttpsProxyEnv: !!process.env.HTTPS_PROXY,
    hasHttpProxyEnv: !!process.env.HTTP_PROXY
  });
});

app.get("/disputedesk/ip", async (_req, res) => {
  try {
    const result = await testOutbound("https://api.ipify.org?format=json");
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "OUTBOUND_FETCH_FAILED",
      message: String(e?.message || e)
    });
  }
});

app.all("/disputedesk/*", async (req, res) => {
  return forwardRequest(req, res, {
    baseUrl: DISPUTE_DESK_BASE_URL,
    prefix: "disputedesk",
    requireAuthorization: false
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("[proxy] listening", {
    port: PORT,
    cdBaseUrl: CD_BASE_URL,
    disputeDeskBaseUrl: DISPUTE_DESK_BASE_URL,
    hasSharedSecret: !!SHARED_SECRET,
    hasFixieUrl: !!FIXIE_URL,
    fixiePreview: FIXIE_URL ? FIXIE_URL.slice(0, 18) + "…" : null
  });
});
