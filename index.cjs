const express = require("express");
const { ProxyAgent, setGlobalDispatcher } = require("undici");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// ---- FORCE OUTBOUND TRAFFIC THROUGH FIXIE ----
const FIXIE_URL = process.env.FIXIE_URL;

if (FIXIE_URL) {
  const agent = new ProxyAgent(FIXIE_URL);
  setGlobalDispatcher(agent);

  process.env.HTTP_PROXY = FIXIE_URL;
  process.env.HTTPS_PROXY = FIXIE_URL;

  console.log("[proxy] FIXIE enabled");
} else {
  console.log("[proxy] FIXIE_URL NOT SET — OTC WILL FAIL");
}

// ---- AUTH ----
function requireProxyKey(req, res) {
  const key = req.headers["x-proxy-api-key"];
  if (!key || key !== process.env.PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "INVALID_PROXY_KEY" });
    return false;
  }
  return true;
}

app.get("/health", (req, res) =>
  res.json({ ok: true, fixie: !!process.env.FIXIE_URL })
);

// ---- PAPI passthrough ----
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
    console.error("papi_exception", e);
    return res.status(500).json({ ok: false, step: "papi_exception", message: e?.message || String(e) });
  }
});

// ---- SmartCredit passthrough ----
app.use("/sc", async (req, res) => {
  try {
    if (!requireProxyKey(req, res)) return;

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
    console.error("sc_exception", e);
    return res.status(500).json({ ok: false, step: "sc_exception", message: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`proxy listening on ${PORT}`));
