// server.js
// Copy/paste this entire file into your Render proxy repo as server.js,
// commit to GitHub, and redeploy on Render.

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- REQUIRED ENV VARS ON RENDER ----
// PROXY_API_KEY   = a shared secret you already use (optional but recommended)
// FIXIE_URL       = http://fixie:USER:PASS@criterium.usefixie.com:80   (you already have)
// HTTP_PROXY      = same as FIXIE_URL (you added)
// HTTPS_PROXY     = same as FIXIE_URL (you added)
//
// ---- OPTIONAL BASE URLS ----
// CONSUMERDIRECT_BASE_URL = https://papi.consumerdirect.io
// CD_SMARTCREDIT_BASE_URL = https://api.smartcredit.com

const PORT = process.env.PORT || 3000;

const {
  PROXY_API_KEY,
  CONSUMERDIRECT_BASE_URL = "https://papi.consumerdirect.io",
  CD_SMARTCREDIT_BASE_URL = "https://api.smartcredit.com",
} = process.env;

// ===============
// Helpers
// ===============
function requireApiKey(req) {
  // If you already secure with a different header, change it here.
  // You can also comment this out if you truly don’t want auth.
  if (!PROXY_API_KEY) return; // allow if not set (not recommended)
  const provided =
    req.header("x-cd-proxy-secret") ||
    req.header("x-proxy-api-key") ||
    req.header("authorization");
  if (!provided || provided !== PROXY_API_KEY) {
    const err = new Error("Unauthorized (missing/invalid proxy key)");
    err.status = 401;
    throw err;
  }
}

function forwardHeaders(req, extra = {}) {
  const headers = {};

  // Always send a real UA
  headers["user-agent"] =
    req.header("user-agent") || "Credit2Credit/1.0 (Render; Fixie; Proxy)";

  // Accept JSON by default
  headers["accept"] = req.header("accept") || "application/json";

  // Forward content-type when relevant
  if (req.header("content-type")) headers["content-type"] = req.header("content-type");

  // IMPORTANT:
  // ConsumerDirect expects Authorization: Bearer <token>
  // Your Base44 function should send x-cd-authorization to avoid auth interception upstream.
  const bearer =
    req.header("x-cd-authorization") ||
    req.header("x-cd-authorization".toLowerCase()) ||
    req.header("authorization");

  if (bearer) headers["authorization"] = bearer;

  // Merge extras (allows caller to force headers)
  return { ...headers, ...extra };
}

async function fetchText(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { res, text };
}

// ===============
// Routes
// ===============

// 1) PROVE EGRESS IP (this is the whole point)
app.get("/debug/ip", async (req, res) => {
  try {
    // If you want this protected, uncomment:
    // requireApiKey(req);

    const { res: r, text } = await fetchText("https://api.ipify.org?format=json", {
      method: "GET",
      headers: {
        "accept": "application/json",
        "user-agent": "Credit2Credit/1.0 (Render; Fixie; Proxy)",
      },
    });

    // Return raw + parsed
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    return res.status(200).json({
      ok: true,
      status: r.status,
      ip: json.ip || null,
      raw: json.raw || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// 2) ConsumerDirect passthrough: /cd/* -> https://papi.consumerdirect.io/*
app.all("/cd/*", async (req, res) => {
  try {
    requireApiKey(req);

    const path = req.originalUrl.replace(/^\/cd/, ""); // keeps query string
    const url = `${CONSUMERDIRECT_BASE_URL}${path}`;

    const headers = forwardHeaders(req);

    const init = {
      method: req.method,
      headers,
    };

    // Only attach body for non-GET/HEAD
    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      // Ensure content-type if we set a JSON body
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const { res: upstream, text } = await fetchText(url, init);

    // Pass through status + body
    res.status(upstream.status);
    // Try to preserve content-type
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    return res.send(text);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || String(e) });
  }
});

// 3) SmartCredit passthrough: /smartcredit/* -> https://api.smartcredit.com/*
app.all("/smartcredit/*", async (req, res) => {
  try {
    requireApiKey(req);

    const path = req.originalUrl.replace(/^\/smartcredit/, "");
    const url = `${CD_SMARTCREDIT_BASE_URL}${path}`;

    const headers = forwardHeaders(req);

    const init = {
      method: req.method,
      headers,
    };

    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const { res: upstream, text } = await fetchText(url, init);

    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    return res.send(text);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e?.message || String(e) });
  }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
