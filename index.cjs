const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

function unauthorized(res, reason) {
  return res.status(401).json({ ok: false, error: reason || "UNAUTHORIZED" });
}

// Accept either header style:
// - X-Shared-Secret (old working flow)
// - x-proxy-api-key (newer flow)
function requireProxyAuth(req, res) {
  const shared = req.headers["x-shared-secret"];
  const key = req.headers["x-proxy-api-key"];

  const expectedShared = process.env.CD_PROXY_INTERNAL_SHARED_SECRET;
  const expectedKey = process.env.PROXY_API_KEY;

  if (expectedShared && shared && shared === expectedShared) return true;
  if (expectedKey && key && key === expectedKey) return true;

  if (shared) return unauthorized(res, "INVALID_SHARED_SECRET");
  if (key) return unauthorized(res, "INVALID_PROXY_KEY");
  return unauthorized(res, "MISSING_PROXY_AUTH");
}

app.get("/health", (req, res) => res.json({ ok: true, service: "c2c-fixie-proxy-clean" }));

// Simple endpoint to verify the outbound IP of THIS service (through Fixie)
app.get("/egress-ip", async (req, res) => {
  try {
    // uses Node18+ global fetch
    const r = await fetch("https://api.ipify.org?format=json", { method: "GET" });
    const j = await r.json();
    return res.json({ ok: true, fixie: true, ip: j.ip });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "EGRESS_IP_FAILED", message: e?.message || String(e) });
  }
});

// OAuth token mint (optional helper)
app.post("/oauth/token", async (req, res) => {
  try {
    if (!requireProxyAuth(req, res)) return;

    const clientId = process.env.CD_PAPI_PROD_CLIENT_ID;
    const clientSecret = process.env.CD_PAPI_PROD_CLIENT_SECRET;
    const scope = process.env.CD_PAPI_SCOPE; // e.g. target-entity:...

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_OAUTH_CREDS",
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret
      });
    }

    const authHeader = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    if (scope) params.set("scope", scope);

    const upstream = await fetch("https://auth.consumerdirect.io/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: authHeader
      },
      body: params.toString()
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "OAUTH_EXCEPTION", message: e?.message || String(e) });
  }
});

// /cd/* passthrough to PAPI (this matches the old working function path you quoted)
app.use("/cd", async (req, res) => {
  try {
    if (!requireProxyAuth(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/cd/, "");
    const upstreamUrl = `https://papi.consumerdirect.io${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"],
      authorization: req.headers["authorization"]
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
    return res.status(500).json({ ok: false, error: "CD_PROXY_EXCEPTION", message: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`));
