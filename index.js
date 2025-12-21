// index.js (FULL REPLACEMENT - paste this whole file)

import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

// Keep raw body so we can forward anything (JSON, form, etc.)
app.use(express.raw({ type: "*/*", limit: "5mb" }));

// BASIC
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/ip", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });

    const httpsAgent = new HttpsProxyAgent(fixieUrl);

    const r = await axios.get("https://api.ipify.org?format=json", {
      httpsAgent,
      timeout: 30000,
    });

    res.json({ via: "fixie-https-proxy-agent", ip: r.data.ip });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// CONSUMERDIRECT TOKEN
async function getConsumerDirectToken(httpsAgent) {
  const clientId = process.env.CONSUMERDIRECT_CLIENT_ID;
  const clientSecret = process.env.CONSUMERDIRECT_CLIENT_SECRET;

  if (!clientId) throw new Error("CONSUMERDIRECT_CLIENT_ID is not set");
  if (!clientSecret) throw new Error("CONSUMERDIRECT_CLIENT_SECRET is not set");

  const tokenUrl = "https://auth.consumerdirect.io/oauth2/token";
  const scope = "target-entity:e6c9113e-48b8-41ef-a87e-87a3c51a5e83";
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("scope", scope);

  const r = await axios.post(tokenUrl, body.toString(), {
    httpsAgent,
    timeout: 30000,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    validateStatus: () => true,
  });

  if (r.status < 200 || r.status >= 300) {
    const err = new Error("Token request failed");
    err.status = r.status;
    err.payload = r.data;
    throw err;
  }

  if (!r.data || !r.data.access_token) {
    const err = new Error("No access_token returned");
    err.status = 500;
    err.payload = r.data;
    throw err;
  }

  return r.data.access_token;
}

app.get("/cd-token", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });

    const httpsAgent = new HttpsProxyAgent(fixieUrl);
    const token = await getConsumerDirectToken(httpsAgent);

    res.json({ ok: true, access_token_preview: token.slice(0, 25) + "..." });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e?.message || e), details: e.payload });
  }
});

// TEST: GET /v1/customers
app.get("/cd-test-customers", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const httpsAgent = new HttpsProxyAgent(fixieUrl);
    const token = await getConsumerDirectToken(httpsAgent);

    const url = new URL("/v1/customers", baseUrl);

    const upstream = await axios.get(url.toString(), {
      httpsAgent,
      timeout: 30000,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      validateStatus: () => true,
      responseType: "text",
      transformResponse: (x) => x, // keep raw
    });

    res
      .status(upstream.status)
      .set("content-type", upstream.headers["content-type"] || "text/plain")
      .send(upstream.data);
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e?.message || e), details: e.payload });
  }
});

// TEST: LOGIN-AS (debug 403/WAF)
app.get("/cd-test-login-as", async (req, res) => {
  try {
    const customerToken = req.query.customerToken;
    if (!customerToken) {
      return res.status(400).json({ error: "Missing customerToken. Use: /cd-test-login-as?customerToken=..." });
    }

    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const httpsAgent = new HttpsProxyAgent(fixieUrl);
    const token = await getConsumerDirectToken(httpsAgent);

    const url = new URL(`/v1/customers/${customerToken}/otcs/login-as`, baseUrl);

    const upstream = await axios.post(
      url.toString(),
      { agentId: "Credit2Credit Support" },
      {
        httpsAgent,
        timeout: 30000,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        validateStatus: () => true,
        responseType: "text",
        transformResponse: (x) => x,
      }
    );

    res
      .status(upstream.status)
      .set("content-type", upstream.headers["content-type"] || "text/plain")
      .send(upstream.data);
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e?.message || e), details: e.payload });
  }
});

// OPTIONAL FORWARDER (kept)
app.all("/cd/*", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const httpsAgent = new HttpsProxyAgent(fixieUrl);

    const targetPath = req.originalUrl.replace(/^\/cd/, "");
    const url = new URL(targetPath, baseUrl);

    // Pass through only a few headers
    const headers = {};
    const passthrough = ["authorization", "content-type", "accept"];
    for (const h of passthrough) {
      const v = req.headers[h];
      if (v) headers[h] = v;
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";

    const upstream = await axios.request({
      url: url.toString(),
      method: req.method,
      httpsAgent,
      timeout: 30000,
      headers,
      data: hasBody ? req.body : undefined, // Buffer from express.raw
      validateStatus: () => true,
      responseType: "arraybuffer",
    });

    // Send upstream response back
    const contentType = upstream.headers["content-type"] || "text/plain";
    res.status(upstream.status).set("content-type", contentType).send(Buffer.from(upstream.data));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy running on port ${port}`));
