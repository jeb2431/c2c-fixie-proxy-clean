import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

// IMPORTANT: allow raw bodies (json + urlencoded) without breaking proxying
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;

// Base44 → Proxy shared secret
// Base44 sends header: x-cd-proxy-secret: <value>
const CD_PROXY_SECRET =
  process.env.CD_PROXY_INTERNAL_SHARED_SECRET ||
  process.env.CD_PROXY_SECRET ||
  "";

// Fixie (Render + Fixie)
const FIXIE_URL = process.env.FIXIE_URL || "";

// Upstreams
// 1) OAuth host (token exchange)
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || "https://auth.consumerdirect.io";

// 2) ConsumerDirect / Partner API host (THIS is what /cd/* forwards to)
// Set this in Render env vars. If you don’t know which one is correct, start with:
// https://papi.consumerdirect.io
// If Jon told you a different one for OTC, set it here without changing code.
const CONSUMERDIRECT_BASE_URL =
  process.env.CONSUMERDIRECT_BASE_URL || process.env.PAPI_BASE_URL || "https://papi.consumerdirect.io";

// 3) SmartCredit API host (THIS is what /smartcredit/* forwards to)
const SMARTCREDIT_API_BASE_URL =
  process.env.SMARTCREDIT_API_BASE_URL ||
  process.env.CD_SMARTCREDIT_BASE_URL ||
  "https://api.smartcredit.com";

// Optional: for debugging (do not log secrets)
const DEBUG = String(process.env.DEBUG_PROXY || "").toLowerCase() === "true";

// ---------------- HELPERS ----------------
function requireProxySecret(req, res) {
  if (!CD_PROXY_SECRET) {
    return res.status(500).json({
      ok: false,
      error:
        "Proxy misconfigured: missing CD_PROXY_INTERNAL_SHARED_SECRET or CD_PROXY_SECRET on Render.",
    });
  }

  const got = req.headers["x-cd-proxy-secret"];
  if (!got || got !== CD_PROXY_SECRET) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized proxy request (missing or invalid x-cd-proxy-secret).",
    });
  }
  return null;
}

function buildAgent() {
  if (!FIXIE_URL) return undefined;
  return new HttpsProxyAgent(FIXIE_URL);
}

function sanitizeHeaders(headers) {
  // Remove hop-by-hop + host headers that can break forwarding
  const h = { ...headers };
  delete h.host;
  delete h.connection;
  delete h["content-length"];
  // Never forward our internal shared secret to upstream
  delete h["x-cd-proxy-secret"];
  return h;
}

async function forward(req, res, upstreamBase, stripPrefix) {
  const agent = buildAgent();
  const headers = sanitizeHeaders(req.headers);

  // Build upstream URL
  // Example: /cd/v1/customers/... -> {CONSUMERDIRECT_BASE_URL}/v1/customers/...
  const path = req.originalUrl.startsWith(stripPrefix)
    ? req.originalUrl.slice(stripPrefix.length)
    : req.originalUrl;

  const upstreamUrl = `${upstreamBase}${path}`;

  if (DEBUG) {
    console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${upstreamUrl}`);
  }

  try {
    const axRes = await axios({
      method: req.method,
      url: upstreamUrl,
      headers,
      data: req.body && Object.keys(req.body).length ? req.body : undefined,
      // If body was empty for GET/POST, axios handles it fine.
      httpsAgent: agent,
      validateStatus: () => true, // we handle status manually
      timeout: 60000,
    });

    // Pass through status + body
    res.status(axRes.status);

    // Pass through content-type if present
    const ct = axRes.headers["content-type"];
    if (ct) res.setHeader("content-type", ct);

    return res.send(axRes.data);
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `Proxy upstream error: ${err?.message || String(err)}`,
      upstreamBase,
      stripPrefix,
    });
  }
}

// ---------------- ROUTES ----------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "c2c-fixie-proxy-clean",
    authBase: AUTH_BASE_URL,
    consumerDirectBase: CONSUMERDIRECT_BASE_URL,
    smartCreditBase: SMARTCREDIT_API_BASE_URL,
    fixie: !!FIXIE_URL,
  });
});

// Auth routes (token exchange)
app.all("/auth/*", async (req, res) => {
  const denied = requireProxySecret(req, res);
  if (denied) return;
  return forward(req, res, AUTH_BASE_URL, "/auth");
});

// ConsumerDirect / Partner API routes (OTC + customer lookup)
app.all("/cd/*", async (req, res) => {
  const denied = requireProxySecret(req, res);
  if (denied) return;
  return forward(req, res, CONSUMERDIRECT_BASE_URL, "/cd");
});

// SmartCredit API routes (login + statement + metadata + reports)
app.all("/smartcredit/*", async (req, res) => {
  const denied = requireProxySecret(req, res);
  if (denied) return;
  return forward(req, res, SMARTCREDIT_API_BASE_URL, "/smartcredit");
});

// Helpful error for wrong routes
app.all("*", (req, res) => {
  res.status(404).json({
    ok: false,
    error: `Proxy route not found: ${req.method} ${req.path}`,
    hint: "Expected routes: /auth/* or /cd/* or /smartcredit/*",
  });
});

// Start
app.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
