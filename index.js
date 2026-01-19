// index.cjs
// Copy/paste this ENTIRE file into your Render proxy repo as: index.cjs
// Commit to GitHub, then redeploy on Render.
//
// IMPORTANT:
// - This version fixes your 401 issue by accepting CD_PROXY_INTERNAL_SHARED_SECRET (your current Render env name)
// - It also proves Fixie is being used by exposing PUBLIC /cd/ip (no key required)
// - All /cd/* and /smartcredit/* routes stay PROTECTED by the proxy key
//
// REQUIRED ENV VARS ON RENDER (one of these must exist):
// - CD_PROXY_INTERNAL_SHARED_SECRET   (recommended — matches your Base44 secret name)
//   OR PROXY_API_KEY
//
// REQUIRED FOR WHITELISTED IP (Fixie):
// - FIXIE_URL  OR  HTTPS_PROXY / HTTP_PROXY  (you already set these)
//
// OPTIONAL BASE URLS:
// - CONSUMERDIRECT_BASE_URL = https://papi.consumerdirect.io
// - CD_SMARTCREDIT_BASE_URL = https://api.smartcredit.com

const express = require("express");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const CONSUMERDIRECT_BASE_URL =
  process.env.CONSUMERDIRECT_BASE_URL || "https://papi.consumerdirect.io";
const CD_SMARTCREDIT_BASE_URL =
  process.env.CD_SMARTCREDIT_BASE_URL || "https://api.smartcredit.com";

// --- Proxy key (Render) ---
const PROXY_KEY =
  process.env.CD_PROXY_INTERNAL_SHARED_SECRET ||
  process.env.PROXY_API_KEY ||
  "";

// --- Fixie / proxy env (Render) ---
const FIXIE_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.FIXIE_URL ||
  "";

// Build proxy agents for axios (this is what ensures Fixie is used)
const httpsAgent = FIXIE_URL ? new HttpsProxyAgent(FIXIE_URL) : undefined;
const httpAgent = FIXIE_URL ? new HttpProxyAgent(FIXIE_URL) : undefined;

// =======================
// Helpers
// =======================
function requireProxyKey(req) {
  // If no key configured, allow (not recommended, but useful during setup)
  if (!PROXY_KEY) return;

  const provided =
    req.header("x-cd-proxy-secret") ||
    req.header("x-proxy-api-key") ||
    req.header("x-shared-secret") ||
    "";

  if (!provided || provided !== PROXY_KEY) {
    return {
      ok: false,
      error: "Unauthorized (missing/invalid proxy key)",
      hint:
        "Send header x-cd-proxy-secret with the SAME value as Render env CD_PROXY_INTERNAL_SHARED_SECRET",
    };
  }

  return null;
}

function pickBearer(req) {
  // We ONLY forward Authorization to ConsumerDirect/SmartCredit.
  // This is NOT used as the proxy key.
  const b =
    req.header("x-cd-authorization") ||
    req.header("authorization") ||
    "";
  return b;
}

function buildForwardHeaders(req, extra = {}) {
  const headers = {};

  headers["user-agent"] =
    req.header("user-agent") || "Credit2Credit/1.0 (Render; Fixie; Proxy)";
  headers["accept"] = req.header("accept") || "application/json";

  const ct = req.header("content-type");
  if (ct) headers["content-type"] = ct;

  const bearer = pickBearer(req);
  if (bearer) headers["authorization"] = bearer;

  return { ...headers, ...extra };
}

async function axiosRequest(url, method, headers, data) {
  // responseType arraybuffer preserves JSON/text/binary safely
  return axios.request({
    url,
    method,
    headers,
    data,
    responseType: "arraybuffer",
    // IMPORTANT: force Fixie usage via agents
    httpAgent,
    httpsAgent,
    // don’t throw on non-2xx; we pass through status codes
    validateStatus: () => true,
  });
}

function sendUpstream(res, upstream) {
  // Copy content-type if present
  const ct = upstream.headers?.["content-type"];
  if (ct) res.setHeader("content-type", ct);

  // Pass through status + body
  res.status(upstream.status);

  // upstream.data is a Buffer (arraybuffer)
  return res.send(Buffer.from(upstream.data));
}

// =======================
// Public routes (NO key)
// =======================

// Root (so you never see "Cannot GET /" again)
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    hasProxyKeyConfigured: !!PROXY_KEY,
    hasFixieUrl: !!FIXIE_URL,
    consumerDirectBaseUrl: CONSUMERDIRECT_BASE_URL,
    smartCreditBaseUrl: CD_SMARTCREDIT_BASE_URL,
  });
});

// PUBLIC: prove egress IP via Fixie (hit this 5 times with hard refresh)
app.get("/cd/ip", async (req, res) => {
  try {
    const upstream = await axiosRequest(
      "https://api.ipify.org?format=json",
      "GET",
      {
        accept: "application/json",
        "user-agent": "Credit2Credit/1.0 (Render; Fixie; Proxy)",
      },
      undefined
    );

    let parsed = null;
    try {
      parsed = JSON.parse(Buffer.from(upstream.data).toString("utf8"));
    } catch {
      parsed = { raw: Buffer.from(upstream.data).toString("utf8") };
    }

    return res.json({
      ok: true,
      proxyEnabled: !!FIXIE_URL,
      fixieEnvPreview: FIXIE_URL ? FIXIE_URL.replace(/\/\/.*?:.*?@/, "//***:***@") : null,
      ipify: parsed,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Simple health
app.get("/health", (req, res) => res.json({ ok: true }));

// =======================
// Protected passthroughs
// =======================

// ConsumerDirect passthrough: /cd/* -> https://papi.consumerdirect.io/*
app.all("/cd/*", async (req, res) => {
  const authErr = requireProxyKey(req);
  if (authErr) return res.status(401).json(authErr);

  try {
    const pathAndQuery = req.originalUrl.replace(/^\/cd/, ""); // keeps query string
    const url = `${CONSUMERDIRECT_BASE_URL}${pathAndQuery}`;

    const headers = buildForwardHeaders(req);

    // Only attach body for non-GET/HEAD
    let data = undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      data = req.body ?? {};
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const upstream = await axiosRequest(url, req.method, headers, data);
    return sendUpstream(res, upstream);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// SmartCredit passthrough: /smartcredit/* -> https://api.smartcredit.com/*
app.all("/smartcredit/*", async (req, res) => {
  const authErr = requireProxyKey(req);
  if (authErr) return res.status(401).json(authErr);

  try {
    const pathAndQuery = req.originalUrl.replace(/^\/smartcredit/, "");
    const url = `${CD_SMARTCREDIT_BASE_URL}${pathAndQuery}`;

    const headers = buildForwardHeaders(req);

    let data = undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      data = req.body ?? {};
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const upstream = await axiosRequest(url, req.method, headers, data);
    return sendUpstream(res, upstream);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
  console.log(`CONSUMERDIRECT_BASE_URL=${CONSUMERDIRECT_BASE_URL}`);
  console.log(`CD_SMARTCREDIT_BASE_URL=${CD_SMARTCREDIT_BASE_URL}`);
  console.log(`PROXY_KEY_CONFIGURED=${!!PROXY_KEY}`);
  console.log(`FIXIE_URL_CONFIGURED=${!!FIXIE_URL}`);
});
