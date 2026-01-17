const express = require("express");
const fetch = global.fetch || require("node-fetch");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

function requireProxyKey(req, res) {
  const key = req.headers["x-proxy-api-key"];
  if (!key || key !== process.env.PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "INVALID_PROXY_KEY" });
    return false;
  }
  return true;
}

function buildBasicAuth(id, secret) {
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

app.get("/health", (req, res) => res.json({ ok: true }));

// OAuth token (OTC)
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

    const authHeader =
      req.headers["authorization"] || buildBasicAuth(clientId, clientSecret);

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
    res.set("content-type", "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, step: "oauth_exception", message: e?.message || String(e) });
  }
});

// PAPI passthrough
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

// SmartCredit passthrough: /sc/* -> https://api.smartcredit.com/*
app.use("/sc", async (req, res) => {
  try {
    if (!requireProxyKey(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/sc/, "");
    const upstreamUrl = `https://api.smartcredit.com${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"],
      authorization: req.headers["authorization"], // Bearer token
      // pass through any customer-context headers we try from Base44
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
