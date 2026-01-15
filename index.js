import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// Shared secret required from Base44 backend functions
// Base44 sends: x-cd-proxy-secret: <value>
const CD_PROXY_SECRET =
  process.env.CD_PROXY_INTERNAL_SHARED_SECRET ||
  process.env.CD_PROXY_SECRET ||
  "";

// Fixie proxy (Render + Fixie)
const FIXIE_URL = process.env.FIXIE_URL || "";

// Upstreams
// IMPORTANT: This is where /cd/* should go (Partner API / PAPI host).
// If Jon told you a different host for PAPI, put it here as an env var.
// Default below is the most common pattern based on your previous work.
const PAPI_BASE_URL = process.env.PAPI_BASE_URL || "https://papi.consumerdirect.io";

// SmartCredit API base (JWT + data endpoints)
const SMARTCREDIT_API_BASE_URL =
  process.env.SMARTCREDIT_API_BASE_URL || "https://api.smartcredit.com";

// OAuth host (client_credentials)
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || "https://auth.consumerdirect.io";

// ---------- AXIOS INSTANCE ----------
const axiosClient = axios.create({
  timeout: 60_000,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  // Only apply Fixie agent if provided
  httpsAgent: FIXIE_URL ? new HttpsProxyAgent(FIXIE_URL) : undefined,
});

// Need raw body sometimes (json + form + anything)
app.use(express.raw({ type: "*/*", limit: "10mb" }));

// ---------- SECURITY MIDDLEWARE ----------
app.use((req, res, next) => {
  // Health check can be open
  if (req.path === "/health") return next();

  if (!CD_PROXY_SECRET) {
    return res.status(500).json({
      ok: false,
      error:
        "Proxy missing CD_PROXY_INTERNAL_SHARED_SECRET / CD_PROXY_SECRET env var",
    });
  }

  const incoming = req.header("x-cd-proxy-secret");
  if (!incoming || incoming !== CD_PROXY_SECRET) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized (missing/invalid x-cd-proxy-secret)",
    });
  }

  next();
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    fixieEnabled: !!FIXIE_URL,
    papiBase: PAPI_BASE_URL,
    smartcreditBase: SMARTCREDIT_API_BASE_URL,
    authBase: AUTH_BASE_URL,
  });
});

// ---------- HELPER: FORWARD REQUEST ----------
function filterHeaders(originalHeaders) {
  // Remove hop-by-hop headers + our internal secret
  const banned = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "x-cd-proxy-secret",
  ]);

  const out = {};
  for (const [k, v] of Object.entries(originalHeaders || {})) {
    const key = k.toLowerCase();
    if (!banned.has(key)) out[k] = v;
  }
  return out;
}

async function forward(req, res, upstreamBase, stripPrefix) {
  try {
    // Build upstream URL:
    // Example:
    // incoming:  /cd/v1/customers/..../otcs/login-as
    // upstream:  https://papi.consumerdirect.io/v1/customers/..../otcs/login-as
    const path = req.originalUrl.startsWith(stripPrefix)
      ? req.originalUrl.slice(stripPrefix.length)
      : req.originalUrl;

    const upstreamUrl = `${upstreamBase}${path}`;

    const headers = filterHeaders(req.headers);

    const axiosResp = await axiosClient.request({
      method: req.method,
      url: upstreamUrl,
      headers,
      data: req.body && req.body.length ? req.body : undefined,
      validateStatus: () => true, // pass through status
    });

    // Pass through
    res.status(axiosResp.status);

    // Copy content-type if present
    if (axiosResp.headers?.["content-type"]) {
      res.setHeader("content-type", axiosResp.headers["content-type"]);
    }

    // Return raw body
    if (
      Buffer.isBuffer(axiosResp.data) ||
      typeof axiosResp.data === "string"
    ) {
      return res.send(axiosResp.data);
    }

    return res.json(axiosResp.data);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `Proxy exception: ${err?.message || String(err)}`,
    });
  }
}

// ---------- ROUTES ----------
// Partner API / PAPI routes (OTC should be here)
app.use("/cd", (req, res) => forward(req, res, PAPI_BASE_URL, "/cd"));

// SmartCredit API routes (login + data)
app.use("/smartcredit", (req, res) =>
  forward(req, res, SMARTCREDIT_API_BASE_URL, "/smartcredit")
);

// Auth routes (optional, but useful)
app.use("/auth", (req, res) => forward(req, res, AUTH_BASE_URL, "/auth"));

// Catch-all (helps debugging)
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Proxy route not found: ${req.method} ${req.originalUrl}`,
    hint: "Expected /cd/* or /smartcredit/* or /auth/*",
  });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy listening on port ${PORT}`);
  console.log(`- Fixie enabled: ${!!FIXIE_URL}`);
  console.log(`- /cd -> ${PAPI_BASE_URL}`);
  console.log(`- /smartcredit -> ${SMARTCREDIT_API_BASE_URL}`);
  console.log(`- /auth -> ${AUTH_BASE_URL}`);
});
