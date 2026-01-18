// index.cjs (FULL REPLACE)
const express = require("express");
const { fetch, ProxyAgent, setGlobalDispatcher } = require("undici");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ------------------------------
// Force ALL outbound HTTP(S) through Fixie (Undici)
// ------------------------------
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.FIXIE_URL;
if (proxyUrl) {
  try {
    const agent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(agent);
    console.log("[proxy] Using upstream proxy:", proxyUrl.replace(/:\/\/.*@/, "://***@"));
  } catch (e) {
    console.log("[proxy] Failed to set ProxyAgent:", e?.message || String(e));
  }
} else {
  console.log("[proxy] No HTTP_PROXY/HTTPS_PROXY/FIXIE_URL set; outbound will use Render IP.");
}

// ------------------------------
// Auth guards
// ------------------------------
function requireProxyApiKey(req, res) {
  const key = req.headers["x-proxy-api-key"];
  if (!key || key !== process.env.PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "INVALID_PROXY_KEY" });
    return false;
  }
  return true;
}

function requireSharedSecret(req, res) {
  const provided =
    req.headers["x-shared-secret"] ||
    req.headers["x-shared_secret"] ||
    req.headers["x-sharedsecret"] ||
    req.headers["x-shared-secret".toLowerCase()] ||
    req.headers["x-shared-secret".toUpperCase()] ||
    req.headers["x-shared-secret"]; // redundant but safe

  const expected = process.env.CD_PROXY_INTERNAL_SHARED_SECRET;

  if (!provided || !expected || provided !== expected) {
    res.status(401).json({
      ok: false,
      error: "INVALID_SHARED_SECRET",
      hasProvided: !!provided,
      hasExpected: !!expected,
    });
    return false;
  }
  return true;
}

// ------------------------------
// Health + egress IP (for whitelist verification)
// ------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/egress-ip", async (req, res) => {
  try {
    // This request will go through Fixie if ProxyAgent is set correctly
    const r = await fetch("https://api.ipify.org?format=json", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const text = await r.text();
    res.status(200).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: "EGRESS_IP_FAILED", message: e?.message || String(e) });
  }
});

// ------------------------------
// OAuth token (PAPI JWT) - keep behind x-proxy-api-key
// ------------------------------
function buildBasicAuth(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

app.post("/oauth/token", async (req, res) => {
  try {
    if (!requireProxyApiKey(req, res)) return;

    const clientId = process.env.CD_PAPI_PROD_CLIENT_ID;
    const clientSecret = process.env.CD_PAPI_PROD_CLIENT_SECRET;
    const scope = process.env.CD_PAPI_SCOPE; // optional but recommended

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_OAUTH_CREDS",
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
        hasScope: !!scope,
      });
    }

    const authHeader = req.headers["authorization"] || buildBasicAuth(clientId, clientSecret);

    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    if (scope) params.set("scope", scope);

    const upstream = await fetch("https://auth.consumerdirect.io/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: authHeader,
      },
      body: params.toString(),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.set("content-type", "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, step: "oauth_exception", message: e?.message || String(e) });
  }
});

// ------------------------------
// PAPI passthrough (x-proxy-api-key) -> https://papi.consumerdirect.io/*
// ------------------------------
app.use("/papi", async (req, res) => {
  try {
    if (!requireProxyApiKey(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/papi/, "");
    const upstreamUrl = `https://papi.consumerdirect.io${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"],
      authorization: req.headers["authorization"],
    };
    Object.keys(headers).forEach((k) => headers[k] === undefined && delete headers[k]);

    let body;
    if (!["GET", "HEAD"].includes(req.method)) body = JSON.stringify(req.body ?? {});

    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    const text = await upstream.text();

    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, step: "papi_exception", message: e?.message || String(e) });
  }
});

// ------------------------------
// CD passthrough (X-Shared-Secret) -> https://papi.consumerdirect.io/*
// This matches your LAST-KNOWN-WORKING call: /cd/v1/customers/{token}/otcs/login-as
// ------------------------------
app.use("/cd", async (req, res) => {
  try {
    if (!requireSharedSecret(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/cd/, "");
    const upstreamUrl = `https://papi.consumerdirect.io${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"] || "application/json",
      authorization: req.headers["authorization"], // Bearer <papiAccessToken>
    };
    Object.keys(headers).forEach((k) => headers[k] === undefined && delete headers[k]);

    let body;
    if (!["GET", "HEAD"].includes(req.method)) body = JSON.stringify(req.body ?? {});

    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    const text = await upstream.text();

    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, step: "cd_exception", message: e?.message || String(e) });
  }
});

// ------------------------------
// SmartCredit passthrough (x-proxy-api-key) -> https://api.smartcredit.com/*
// ------------------------------
app.use("/sc", async (req, res) => {
  try {
    if (!requireProxyApiKey(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/sc/, "");
    const upstreamUrl = `https://api.smartcredit.com${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"],
      authorization: req.headers["authorization"],
      "x-customer-token": req.headers["x-customer-token"],
      "x-customertoken": req.headers["x-customertoken"],
    };
    Object.keys(headers).forEach((k) => headers[k] === undefined && delete headers[k]);

    let body;
    if (!["GET", "HEAD"].includes(req.method)) body = JSON.stringify(req.body ?? {});

    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    const text = await upstream.text();

    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, step: "sc_exception", message: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`));
