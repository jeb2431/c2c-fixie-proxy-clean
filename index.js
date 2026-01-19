// index.js (ESM)
// Copy/paste this ENTIRE file into your Render repo as index.js, commit, redeploy.

import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const CONSUMERDIRECT_BASE_URL =
  process.env.CONSUMERDIRECT_BASE_URL || "https://papi.consumerdirect.io";
const CD_SMARTCREDIT_BASE_URL =
  process.env.CD_SMARTCREDIT_BASE_URL || "https://api.smartcredit.com";

// Proxy key (Render)
const PROXY_KEY =
  process.env.CD_PROXY_INTERNAL_SHARED_SECRET ||
  process.env.PROXY_API_KEY ||
  "";

// Fixie / proxy env (Render)
const FIXIE_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.FIXIE_URL ||
  "";

// Force Fixie usage via agents
const httpsAgent = FIXIE_URL ? new HttpsProxyAgent(FIXIE_URL) : undefined;
const httpAgent = FIXIE_URL ? new HttpProxyAgent(FIXIE_URL) : undefined;

function requireProxyKey(req) {
  if (!PROXY_KEY) return null; // allow if not set (not recommended)

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
  return req.header("x-cd-authorization") || req.header("authorization") || "";
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
  return axios.request({
    url,
    method,
    headers,
    data,
    responseType: "arraybuffer",
    httpAgent,
    httpsAgent,
    validateStatus: () => true,
  });
}

function sendUpstream(res, upstream) {
  const ct = upstream.headers?.["content-type"];
  if (ct) res.setHeader("content-type", ct);
  res.status(upstream.status);
  return res.send(Buffer.from(upstream.data));
}

// Root (so you never see "Cannot GET /")
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

// PUBLIC: prove egress IP via Fixie (hard refresh 5x)
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

    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(upstream.data).toString("utf8"));
    } catch {
      parsed = { raw: Buffer.from(upstream.data).toString("utf8") };
    }

    return res.json({
      ok: true,
      proxyEnabled: !!FIXIE_URL,
      fixieEnvPreview: FIXIE_URL
        ? FIXIE_URL.replace(/\/\/.*?:.*?@/, "//***:***@")
        : null,
      ipify: parsed,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// ConsumerDirect passthrough: /cd/* -> https://papi.consumerdirect.io/*
app.all("/cd/*", async (req, res) => {
  // NOTE: /cd/ip is public, but everything else under /cd/* is protected
  if (req.path !== "/ip") {
    const authErr = requireProxyKey(req);
    if (authErr) return res.status(401).json(authErr);
  }

  try {
    // Keep query string
    const pathAndQuery = req.originalUrl.replace(/^\/cd/, "");
    const url = `${CONSUMERDIRECT_BASE_URL}${pathAndQuery}`;

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
