// index.cjs
const express = require("express");
const { fetch, ProxyAgent, setGlobalDispatcher } = require("undici");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ----------------------
// FORCE FIXIE EGRESS
// ----------------------
const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.FIXIE_URL ||
  process.env.FIXIE;

if (PROXY_URL) {
  try {
    const agent = new ProxyAgent(PROXY_URL);
    setGlobalDispatcher(agent);
    console.log("[proxy] Using outbound proxy:", PROXY_URL.replace(/\/\/.*@/, "//****:****@"));
  } catch (e) {
    console.log("[proxy] Failed to set proxy agent:", e?.message || String(e));
  }
} else {
  console.log("[proxy] No outbound proxy env found (HTTP_PROXY/HTTPS_PROXY/FIXIE_URL). Outbound calls will be DIRECT.");
}

// ----------------------
// AUTH GATES
// ----------------------
function requireProxyKey(req, res) {
  const key = req.headers["x-proxy-api-key"];
  if (!key || key !== process.env.PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "INVALID_PROXY_KEY" });
    return false;
  }
  return true;
}

function requireSharedSecret(req, res) {
  const secret = req.headers["x-shared-secret"];
  if (!secret || secret !== process.env.CD_PROXY_INTERNAL_SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "INVALID_SHARED_SECRET" });
    return false;
  }
  return true;
}

function buildBasicAuth(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

// ----------------------
// HEALTH + EGRESS CHECK
// ----------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasProxyEnv: !!PROXY_URL,
  });
});

// This proves what IP ConsumerDirect will see
app.get("/egress-ip", async (req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const text = await r.text();
    res.status(r.status).set("content-type", "application/json").send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: "EGRESS_IP_FAILED", message: e?.message || String(e) });
  }
});

// ----------------------
// OAUTH TOKEN (through proxy, protected by PROXY_API_KEY)
// ----------------------
app.post("/oauth/token", async (req, res) => {
  try {
    if (!requireProxyKey(req, res)) return;

    const clientId = process.env.CD_PAPI_PROD_CLIENT_ID;
    const clientSecret = process.env.CD_PAPI_PROD_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_OAUTH_CREDS",
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
      });
    }

    const authHeader = req.headers["authorization"] || buildBasicAuth(clientId, clientSecret);
    const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();

    const upstream = await fetch("https://auth.consumerdirect.io/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: authHeader,
      },
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, step: "oauth_exception", message: e?.message || String(e) });
  }
});

// ----------------------
// /papi passthrough (protected by PROXY_API_KEY)
// ----------------------
app.use("/papi", async (req, res) => {
  try {
    if (!requireProxyKey(req, res)) return;

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

// ----------------------
// /cd passthrough (protected by X-Shared-Secret)
// This matches the last-known-working OTC pattern.
// ----------------------
app.use("/cd", async (req, res) => {
  try {
    if (!requireSharedSecret(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/cd/, "");
    const upstreamUrl = `https://papi.consumerdirect.io${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"] || "application/json",
      authorization: req.headers["authorization"], // OPTIONAL if you pass it
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

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`));
