import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 10000;

// ===== ENV =====
const FIXIE_URL = process.env.FIXIE_URL || ""; // e.g. http://fixie:pass@criterium.usefixie.com:80
const PROXY_API_KEY = process.env.PROXY_API_KEY || ""; // shared secret between Base44 and this proxy
const CONSUMERDIRECT_BASE_URL = process.env.CONSUMERDIRECT_BASE_URL || "https://papi.consumerdirect.io";
const CD_SMARTCREDIT_BASE_URL = process.env.CD_SMARTCREDIT_BASE_URL || "https://api.smartcredit.com";

const UA = "Credit2Credit/1.0 (Render; Fixie; Server-to-Server)";

const proxyAgent = FIXIE_URL ? new HttpsProxyAgent(FIXIE_URL) : null;

// ===== helpers =====
function maskFixie(url) {
  if (!url) return null;
  return url.replace(/:\/\/.*@/, "://****:****@");
}

function requireSecret(req, res) {
  if (!PROXY_API_KEY) {
    res.status(500).json({ ok: false, error: "PROXY_API_KEY not set on Render" });
    return false;
  }
  const incoming = req.headers["x-cd-proxy-secret"];
  if (!incoming || incoming !== PROXY_API_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized (missing/invalid x-cd-proxy-secret)" });
    return false;
  }
  return true;
}

function cleanForwardHeaders(reqHeaders) {
  const h = { ...reqHeaders };

  // remove hop-by-hop + things we should not forward
  delete h.host;
  delete h.connection;
  delete h["content-length"];

  // normalize UA
  h["user-agent"] = UA;

  return h;
}

async function forward(req, res, targetBase, stripPrefix) {
  if (!requireSecret(req, res)) return;

  const path = req.originalUrl.replace(stripPrefix, "");
  const url = targetBase.replace(/\/$/, "") + path;

  const headers = cleanForwardHeaders(req.headers);

  // Special mapping: if Base44 sends x-cd-authorization, convert to Authorization before forwarding
  if (headers["x-cd-authorization"] && !headers["authorization"]) {
    headers["authorization"] = headers["x-cd-authorization"];
  }
  delete headers["x-cd-authorization"];

  try {
    const ax = await axios.request({
      url,
      method: req.method,
      headers,
      data: req.body,
      timeout: 30000,
      // IMPORTANT: this forces outbound traffic through Fixie
      httpsAgent: proxyAgent || undefined,
      httpAgent: proxyAgent || undefined,
      validateStatus: () => true
    });

    // return status + body
    res.status(ax.status);

    // pass through a couple safe headers (optional)
    if (ax.headers["content-type"]) res.setHeader("content-type", ax.headers["content-type"]);

    // axios may give object or string
    return res.send(ax.data);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: "Proxy forward failed",
      message: e?.message || String(e)
    });
  }
}

// ===== routes =====

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    hasFixieUrl: !!FIXIE_URL,
    usingProxy: !!proxyAgent,
    fixieUrlMasked: maskFixie(FIXIE_URL),
    consumerDirectBase: CONSUMERDIRECT_BASE_URL,
    smartCreditBase: CD_SMARTCREDIT_BASE_URL,
    hasProxyApiKey: !!PROXY_API_KEY
  });
});

// This checks what IP the WORLD sees for your Render service when it goes OUTBOUND.
// This MUST show 52.5.155.132 or 52.87.82.133 for OTC to work.
app.get("/debug/ip", async (req, res) => {
  const targets = [
    "https://api.ipify.org?format=json",
    "https://ipinfo.io/json",
    "https://ifconfig.me/all.json"
  ];

  const results = [];

  for (const url of targets) {
    try {
      const ax = await axios.get(url, {
        headers: { accept: "application/json", "user-agent": UA },
        timeout: 20000,
        httpsAgent: proxyAgent || undefined,
        httpAgent: proxyAgent || undefined,
        validateStatus: () => true
      });

      const data = ax.data;
      const ip =
        data?.ip ||
        data?.IPv4 ||
        data?.address ||
        data?.query ||
        null;

      results.push({
        url,
        ok: ax.status >= 200 && ax.status < 300,
        status: ax.status,
        ip,
        preview: typeof data === "string" ? data.slice(0, 120) : data
      });

      if (ip) {
        return res.json({ ok: true, viaFixie: !!proxyAgent, ip, results });
      }
    } catch (e) {
      results.push({
        url,
        ok: false,
        error: e?.message || String(e)
      });
    }
  }

  return res.status(502).json({
    ok: false,
    viaFixie: !!proxyAgent,
    error: "All IP endpoints failed",
    results
  });
});

// ConsumerDirect (PAPI) proxy
app.all("/cd/*", (req, res) => forward(req, res, CONSUMERDIRECT_BASE_URL, "/cd"));

// SmartCredit proxy
app.all("/smartcredit/*", (req, res) => forward(req, res, CD_SMARTCREDIT_BASE_URL, "/smartcredit"));

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
  console.log(`Fixie: ${proxyAgent ? "ON" : "OFF"} (${maskFixie(FIXIE_URL)})`);
});
