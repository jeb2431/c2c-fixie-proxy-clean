// index.cjs (FULL COPY/REPLACE)
// Node/Express proxy for ConsumerDirect/SmartCredit via Fixie static egress.
//
// Routes:
//   GET  /health
//   GET  /egress-ip
//   ALL  /papi/*   (requires x-proxy-api-key)
//   ALL  /cd/*     (requires x-shared-secret)
//
// Env:
//   PORT
//   FIXIE_URL or HTTPS_PROXY or HTTP_PROXY
//   PROXY_API_KEY
//   CD_PROXY_INTERNAL_SHARED_SECRET
//   CD_PAPI_BASE_URL (ex: https://papi.consumerdirect.io)  <-- IMPORTANT
//   CONSUMERDIRECT_BASE_URL (optional; fallback to CD_PAPI_BASE_URL)

const express = require("express");
const { ProxyAgent, request } = require("undici");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

function getProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.FIXIE_URL ||
    ""
  ).trim();
}

function getDispatcher() {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return null;
  return new ProxyAgent(proxyUrl);
}

function pickBaseUrl() {
  // Prefer explicit PAPI base URL
  const papi = (process.env.CD_PAPI_BASE_URL || "").trim();
  if (papi) return papi;

  // Fallback
  const cd = (process.env.CONSUMERDIRECT_BASE_URL || "").trim();
  if (cd) return cd;

  // Final fallback (prod)
  return "https://papi.consumerdirect.io";
}

function lowerHeaders(headersObj) {
  const out = {};
  for (const [k, v] of Object.entries(headersObj || {})) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function safeJson(resBody) {
  try {
    return JSON.parse(resBody);
  } catch {
    return null;
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    proxyConfigured: !!getProxyUrl(),
    baseUrl: pickBaseUrl(),
  });
});

app.get("/egress-ip", async (req, res) => {
  try {
    const dispatcher = getDispatcher();
    const proxyUrl = getProxyUrl();

    const r = await request("https://api.ipify.org?format=json", {
      method: "GET",
      dispatcher: dispatcher || undefined,
      headers: { accept: "application/json" },
    });

    const body = await r.body.text();
    const parsed = safeJson(body);

    res.json({
      ok: true,
      fixie: !!proxyUrl,
      proxyUsed: proxyUrl ? "yes" : "no",
      ip: parsed?.ip || body,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "EGRESS_IP_FAILED",
      message: e?.message || String(e),
    });
  }
});

// Core proxy handler
async function handleProxy(req, res, mode) {
  // mode = "papi" or "cd"
  const headers = lowerHeaders(req.headers);

  // Auth gate
  if (mode === "papi") {
    const expected = (process.env.PROXY_API_KEY || "").trim();
    const provided = (headers["x-proxy-api-key"] || "").trim();

    if (!expected) {
      return res.status(500).json({ ok: false, error: "PROXY_API_KEY_NOT_SET" });
    }
    if (!provided || provided !== expected) {
      return res.status(401).json({ ok: false, error: "INVALID_PROXY_KEY" });
    }
  }

  if (mode === "cd") {
    const expected = (process.env.CD_PROXY_INTERNAL_SHARED_SECRET || "").trim();
    const provided = (headers["x-shared-secret"] || "").trim();

    if (!expected) {
      return res
        .status(500)
        .json({ ok: false, error: "CD_PROXY_INTERNAL_SHARED_SECRET_NOT_SET" });
    }
    if (!provided || provided !== expected) {
      return res.status(401).json({ ok: false, error: "INVALID_SHARED_SECRET" });
    }
  }

  // Build target URL
  const baseUrl = pickBaseUrl(); // should be https://papi.consumerdirect.io
  const prefix = mode === "papi" ? "/papi" : "/cd";
  const upstreamPath = req.originalUrl.startsWith(prefix)
    ? req.originalUrl.slice(prefix.length)
    : req.originalUrl;

  const targetUrl = baseUrl.replace(/\/+$/, "") + upstreamPath;

  // Prepare upstream headers
  const upstreamHeaders = { ...headers };

  // Remove hop-by-hop + internal auth headers
  delete upstreamHeaders["host"];
  delete upstreamHeaders["content-length"];
  delete upstreamHeaders["x-proxy-api-key"];
  delete upstreamHeaders["x-shared-secret"];

  // Make sure Accept exists
  if (!upstreamHeaders["accept"]) upstreamHeaders["accept"] = "application/json";

  // Pass through body if present
  const hasBody =
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.body !== undefined &&
    req.body !== null &&
    Object.keys(req.body).length > 0;

  let bodyToSend = undefined;
  if (hasBody) {
    // If content-type is json, stringify
    const ct = (upstreamHeaders["content-type"] || "").toLowerCase();
    if (ct.includes("application/json")) {
      bodyToSend = JSON.stringify(req.body);
    } else {
      // default to json
      upstreamHeaders["content-type"] = "application/json";
      bodyToSend = JSON.stringify(req.body);
    }
  }

  try {
    const dispatcher = getDispatcher();

    const upstreamResp = await request(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: bodyToSend,
      dispatcher: dispatcher || undefined,
    });

    const respText = await upstreamResp.body.text();

    // Mirror content-type if present
    const contentType =
      upstreamResp.headers["content-type"] ||
      upstreamResp.headers["Content-Type"] ||
      "application/json";

    res.status(upstreamResp.status);
    res.setHeader("content-type", contentType);

    // If upstream is json, return text as-is
    return res.send(respText);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: "UPSTREAM_REQUEST_FAILED",
      mode,
      targetUrl,
      message: e?.message || String(e),
      proxyConfigured: !!getProxyUrl(),
    });
  }
}

app.all("/papi/*", (req, res) => handleProxy(req, res, "papi"));
app.all("/cd/*", (req, res) => handleProxy(req, res, "cd"));

app.listen(PORT, () => {
  const proxyUrl = getProxyUrl();
  if (proxyUrl) {
    console.log(`[proxy] Using upstream proxy: ${proxyUrl.replace(/\/\/.*@/, "//***:***@")}`);
  } else {
    console.log("[proxy] No upstream proxy configured");
  }
  console.log("proxy listening on", PORT);
});
