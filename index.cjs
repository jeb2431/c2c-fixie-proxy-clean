// index.cjs  (FULL REPLACEMENT)
// Render proxy for ConsumerDirect/SmartCredit + Dispute Desk calls via Fixie static IP
//
// Important DD1 fix:
// Adds explicit Dispute Desk routes for LoginToken, GrantPortalAccess, Provider Status,
// AccountOverview, RetrieveReport, create client, and link provider.
//
// Required env vars on Render:
// - CD_PROXY_INTERNAL_SHARED_SECRET
// - FIXIE_URL
// - CD_PAPI_BASE_URL
// - DISPUTE_DESK_BASE_URL
// - DISPUTE_DESK_API_KEY

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;

// ConsumerDirect base
const CD_BASE_URL = (process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io").replace(/\/+$/, "");

// Dispute Desk base
const DISPUTE_DESK_BASE_URL = (process.env.DISPUTE_DESK_BASE_URL || "https://api.disputedesk.com").replace(/\/+$/, "");

// Dispute Desk API key
const DISPUTE_DESK_API_KEY = (process.env.DISPUTE_DESK_API_KEY || "").trim();

// Secret between Base44 and Render proxy
const SHARED_SECRET = (process.env.CD_PROXY_INTERNAL_SHARED_SECRET || "").trim();

// Fixie proxy URL
const FIXIE_URL =
  (process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.text({ type: ["text/*"], limit: "10mb" }));

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
    return {
      httpAgent: undefined,
      httpsAgent: undefined,
      proxyEnabled: false
    };
  }

  return {
    httpAgent: new HttpProxyAgent(FIXIE_URL),
    httpsAgent: new HttpsProxyAgent(FIXIE_URL),
    proxyEnabled: true
  };
}

function cleanForwardHeaders(req) {
  const headers = { ...req.headers };

  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];

  return headers;
}

function safeError(e) {
  return {
    message: String(e?.message || e),
    status: e?.response?.status || null,
    data: e?.response?.data || null
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

async function axiosForward({ method, url, headers, data, timeout = 30000 }) {
  const agents = buildAgents();

  return axios.request({
    method,
    url,
    headers,
    data,
    timeout,
    httpAgent: agents.httpAgent,
    httpsAgent: agents.httpsAgent,
    proxy: false,
    validateStatus: () => true
  });
}

function sendAxiosResponse(res, axRes) {
  const passthroughHeaders = {};
  const allowList = ["content-type", "cache-control", "pragma", "expires"];

  for (const [k, v] of Object.entries(axRes.headers || {})) {
    if (allowList.includes(k.toLowerCase())) {
      passthroughHeaders[k] = v;
    }
  }

  res.status(axRes.status).set(passthroughHeaders).send(axRes.data);
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

    const headers = cleanForwardHeaders(req);

    let data = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      data = req.body;
    }

    const axRes = await axiosForward({
      method: req.method,
      url: targetUrl,
      headers,
      data
    });

    return sendAxiosResponse(res, axRes);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: `${prefix.toUpperCase()}_PROXY_FAILED`,
      ...safeError(e)
    });
  }
}

async function forwardDisputeDesk(req, res, { method, path, body }) {
  try {
    if (!requireSharedSecret(req, res)) return;

    if (!DISPUTE_DESK_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_DISPUTE_DESK_API_KEY",
        message: "DISPUTE_DESK_API_KEY is not set on Render."
      });
    }

    const targetUrl = `${DISPUTE_DESK_BASE_URL}${path}`;

    const headers = cleanForwardHeaders(req);
    headers["accept"] = "application/json";
    headers["x-api-key"] = DISPUTE_DESK_API_KEY;

    if (method !== "GET" && method !== "HEAD") {
      headers["content-type"] = "application/json";
    }

    const axRes = await axiosForward({
      method,
      url: targetUrl,
      headers,
      data: body
    });

    return sendAxiosResponse(res, axRes);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "DISPUTE_DESK_PROXY_FAILED",
      ...safeError(e)
    });
  }
}

// ---------- Base Routes ----------
app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    message: "proxy alive"
  });
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
      ...safeError(e)
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

// ---------- Dispute Desk Health ----------
app.get("/disputedesk/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    route: "disputedesk",
    disputeDeskBaseUrl: DISPUTE_DESK_BASE_URL,
    hasDisputeDeskApiKey: !!DISPUTE_DESK_API_KEY,
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
      ...safeError(e)
    });
  }
});

// ---------- Explicit Dispute Desk Routes ----------

// Create Dispute Desk client
app.post("/disputedesk/clients/create", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "POST",
    path: "/clients/create",
    body: req.body
  });
});

// Link Dispute Desk client to provider
app.post("/disputedesk/clients/link", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "POST",
    path: "/clients/link",
    body: req.body
  });
});

// Update provider password/details
app.put("/disputedesk/clients/link", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "PUT",
    path: "/clients/link",
    body: req.body
  });
});

// CRITICAL DD1 ROUTE:
// Get short-lived CToken for DD portal login
app.get("/disputedesk/clients/:token/LoginToken", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "GET",
    path: `/clients/${encodeURIComponent(req.params.token)}/LoginToken`
  });
});

// Grant client portal access
app.put("/disputedesk/clients/GrantPortalAccess/:token", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "PUT",
    path: `/clients/GrantPortalAccess/${encodeURIComponent(req.params.token)}`,
    body: req.body || {}
  });
});

// Remove portal access
app.delete("/disputedesk/clients/:token/PortalAccess", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "DELETE",
    path: `/clients/${encodeURIComponent(req.params.token)}/PortalAccess`
  });
});

// Get provider status
app.get("/disputedesk/clients/:token/Provider/Status", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "GET",
    path: `/clients/${encodeURIComponent(req.params.token)}/Provider/Status`
  });
});

// Update provider status
app.put("/disputedesk/clients/:token/Provider/Status", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "PUT",
    path: `/clients/${encodeURIComponent(req.params.token)}/Provider/Status`,
    body: req.body || {}
  });
});

// Get account overview
app.get("/disputedesk/clients/AccountOverview/:token", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "GET",
    path: `/clients/AccountOverview/${encodeURIComponent(req.params.token)}`
  });
});

// Retrieve / schedule credit report pull
app.post("/disputedesk/clients/:token/CreditReports/retrievereport", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "POST",
    path: `/clients/${encodeURIComponent(req.params.token)}/CreditReports/retrievereport`,
    body: req.body || {}
  });
});

// Update dispute mode
app.post("/disputedesk/clients/:token/Dispute/Mode", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "POST",
    path: `/clients/${encodeURIComponent(req.params.token)}/Dispute/Mode`,
    body: req.body || {}
  });
});

// Update client
app.put("/disputedesk/clients/:token", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "PUT",
    path: `/clients/${encodeURIComponent(req.params.token)}`,
    body: req.body || {}
  });
});

// Close client
app.put("/disputedesk/clients/close/:token", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "PUT",
    path: `/clients/close/${encodeURIComponent(req.params.token)}`,
    body: req.body || {}
  });
});

// Open client
app.put("/disputedesk/clients/open/:token", async (req, res) => {
  return forwardDisputeDesk(req, res, {
    method: "PUT",
    path: `/clients/open/${encodeURIComponent(req.params.token)}`,
    body: req.body || {}
  });
});

// Generic Dispute Desk fallback.
// This keeps old Base44 functions working for routes not listed above.
app.all("/disputedesk/*", async (req, res) => {
  return forwardRequest(req, res, {
    baseUrl: DISPUTE_DESK_BASE_URL,
    prefix: "disputedesk",
    requireAuthorization: false
  });
});

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    method: req.method,
    path: req.originalUrl
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("[proxy] listening", {
    port: PORT,
    cdBaseUrl: CD_BASE_URL,
    disputeDeskBaseUrl: DISPUTE_DESK_BASE_URL,
    hasDisputeDeskApiKey: !!DISPUTE_DESK_API_KEY,
    hasSharedSecret: !!SHARED_SECRET,
    hasFixieUrl: !!FIXIE_URL,
    fixiePreview: FIXIE_URL ? FIXIE_URL.slice(0, 18) + "…" : null
  });
});
