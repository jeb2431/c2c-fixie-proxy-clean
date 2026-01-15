import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// Fixie / outbound proxy (optional but likely required for your whitelisted IP)
const FIXIE_URL = process.env.FIXIE_URL || null;

// Shared secret required from Base44 backend calls
const PROXY_SECRET =
  process.env.CD_PROXY_INTERNAL_SHARED_SECRET ||
  process.env.CD_PROXY_SECRET ||
  "";

// Upstreams
// OTC + customer lookup endpoints come from PAPI
const PAPI_BASE = "https://papi.consumerdirect.io";
// SmartCredit “data” endpoints
const SMARTCREDIT_BASE = "https://api.smartcredit.com";

// ---------- SAFETY ----------
if (!PROXY_SECRET) {
  console.error(
    "ERROR: Missing proxy secret env var. Set CD_PROXY_INTERNAL_SHARED_SECRET or CD_PROXY_SECRET in Render."
  );
  process.exit(1);
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

function requireProxySecret(req, res, next) {
  const s = req.headers["x-cd-proxy-secret"];
  if (!s || s !== PROXY_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized proxy request" });
  }
  next();
}

// Create axios client (optionally through Fixie)
function axiosClient() {
  if (FIXIE_URL) {
    const agent = new HttpsProxyAgent(FIXIE_URL);
    return axios.create({ httpsAgent: agent });
  }
  return axios.create();
}

// Generic forwarder
async function forward(req, res, upstreamBase, stripPrefix) {
  try {
    const client = axiosClient();

    // Preserve query string
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";

    // Rewrite path: remove stripPrefix from the front
    // Example: /cd/v1/customers/...  -> /v1/customers/...
    const upstreamPath = req.path.startsWith(stripPrefix)
      ? req.path.slice(stripPrefix.length)
      : req.path;

    const upstreamUrl = `${upstreamBase}${upstreamPath}${qs}`;

    // Copy headers but remove hop-by-hop / internal headers
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["x-cd-proxy-secret"];
    delete headers.connection;
    delete headers["content-length"];

    const method = req.method.toUpperCase();

    const axiosResp = await client.request({
      method,
      url: upstreamUrl,
      headers,
      data: req.body,
      validateStatus: () => true, // let us pass through errors
      timeout: 60000,
    });

    res.status(axiosResp.status);

    // Pass through content-type
    if (axiosResp.headers && axiosResp.headers["content-type"]) {
      res.setHeader("content-type", axiosResp.headers["content-type"]);
    }

    // axiosResp.data may already be object
    return res.send(axiosResp.data);
  } catch (e) {
    console.error("Proxy error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Proxy failure", details: e?.message || String(e) });
  }
}

// ---------- ROUTES ----------
// SmartCredit API (login + statement + metadata + 3bs)
app.all("/smartcredit/*", requireProxySecret, async (req, res) => {
  return forward(req, res, SMARTCREDIT_BASE, "/smartcredit");
});

// ConsumerDirect PAPI (OTC + customer lookup)
// Your Base44 function calls: /cd/v1/customers/{token}/otcs/login-as
// This proxy forwards it to: https://papi.consumerdirect.io/v1/customers/{token}/otcs/login-as
app.all("/cd/*", requireProxySecret, async (req, res) => {
  return forward(req, res, PAPI_BASE, "/cd");
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Catch-all for debugging (helps when you hit a wrong route)
app.all("*", (req, res) => {
  res.status(404).json({
    ok: false,
    error: `Proxy route not found: ${req.method} ${req.path}`,
    hint: "Expected /cd/* or /smartcredit/*",
  });
});

app.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
