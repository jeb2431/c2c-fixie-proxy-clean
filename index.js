import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// =====================
// REQUIRED ENV VARS
// =====================
const PORT = process.env.PORT || 3000;

// This must match what Base44 sends in header: x-cd-proxy-secret
const PROXY_SHARED_SECRET =
  process.env.CD_PROXY_INTERNAL_SHARED_SECRET ||
  process.env.CD_PROXY_SECRET ||
  "";

// Fixie (optional but recommended if ConsumerDirect IP-whitelists you)
const FIXIE_URL = process.env.FIXIE_URL || "";

// Upstreams
// PAPI (ConsumerDirect Partner API) - used for customer lookup + OTC generation
const PAPI_BASE_URL = process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io";

// SmartCredit API - used for /v1/login and the data endpoints
// Jon told you "api.smartcredit.com"
const SMARTCREDIT_BASE_URL = process.env.CD_SMARTCREDIT_BASE_URL || "https://api.smartcredit.com";

if (!PROXY_SHARED_SECRET) {
  console.error("Missing proxy secret env var: set CD_PROXY_INTERNAL_SHARED_SECRET or CD_PROXY_SECRET");
}

// Create axios client with optional Fixie agent
function makeAxios() {
  if (!FIXIE_URL) return axios;

  const agent = new HttpsProxyAgent(FIXIE_URL);
  return axios.create({
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 60_000,
  });
}

const http = makeAxios();

// =====================
// AUTH GUARD
// =====================
function requireProxySecret(req, res, next) {
  const got = req.headers["x-cd-proxy-secret"];
  if (!PROXY_SHARED_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "Proxy not configured: missing CD_PROXY_INTERNAL_SHARED_SECRET/CD_PROXY_SECRET on Render",
    });
  }
  if (!got || got !== PROXY_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad proxy secret)" });
  }
  next();
}

// =====================
// HELPERS
// =====================
function pickHeaders(req) {
  // forward important headers, but do NOT forward host
  const allowed = [
    "authorization",
    "content-type",
    "accept",
    "user-agent",
  ];

  const out = {};
  for (const k of allowed) {
    if (req.headers[k]) out[k] = req.headers[k];
  }
  return out;
}

async function forward(req, res, baseUrl, rewritePrefix) {
  try {
    // original path includes rewritePrefix, remove it
    const upstreamPath = req.originalUrl.startsWith(rewritePrefix)
      ? req.originalUrl.slice(rewritePrefix.length)
      : req.originalUrl;

    const url = `${baseUrl}${upstreamPath}`;

    const method = req.method.toUpperCase();
    const headers = pickHeaders(req);

    // Body handling:
    // - For JSON: req.body is object
    // - For form-urlencoded: express.urlencoded makes it object too
    // We’ll send raw JSON unless content-type is x-www-form-urlencoded, then send URLSearchParams.
    let data = undefined;
    const ct = (req.headers["content-type"] || "").toLowerCase();

    if (method !== "GET" && method !== "HEAD") {
      if (ct.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(req.body || {})) {
          params.set(k, String(v));
        }
        data = params.toString();
      } else {
        data = req.body;
      }
    }

    const resp = await http.request({
      url,
      method,
      headers,
      data,
      // IMPORTANT: return the upstream error body back to Base44
      validateStatus: () => true,
    });

    res.status(resp.status);
    // If upstream returns JSON, axios already parsed it sometimes; but keep safe:
    return res.send(resp.data);
  } catch (err) {
    console.error("Proxy forward error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}

// =====================
// ROUTES
// =====================

// Health check
app.get("/", (_req, res) => res.json({
  ok: true,
  service: "c2c-fixie-proxy-clean",
  papiBase: PAPI_BASE_URL,
  smartcreditBase: SMARTCREDIT_BASE_URL,
}));

/**
 * Base44 calls:
 *   {CD_PROXY_URL}/cd/v1/...
 * We forward to:
 *   https://papi.consumerdirect.io/v1/...
 */
app.all("/cd/*", requireProxySecret, async (req, res) => {
  return forward(req, res, PAPI_BASE_URL, "/cd");
});

/**
 * Base44 calls:
 *   {CD_PROXY_URL}/smartcredit/v1/...
 * We forward to:
 *   https://api.smartcredit.com/v1/...
 */
app.all("/smartcredit/*", requireProxySecret, async (req, res) => {
  return forward(req, res, SMARTCREDIT_BASE_URL, "/smartcredit");
});

// Catch-all
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Proxy route not found: ${req.method} ${req.originalUrl}`,
    hint: "Expected /cd/* or /smartcredit/*",
  });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
