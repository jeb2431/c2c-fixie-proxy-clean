// server.js — minimal, guaranteed-to-run Express proxy

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: false }));

// Health check (so Render doesn’t kill it)
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// ✅ AUTH PROXY — THIS IS THE FIX
app.post("/auth/oauth2/token", async (_req, res) => {
  try {
    const clientId = process.env.CD_PAPI_PROD_CLIENT_ID;
    const clientSecret = process.env.CD_PAPI_PROD_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars in Render",
      });
    }

    const resp = await fetch("https://auth.consumerdirect.io/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization":
          "Basic " +
          Buffer.from(clientId + ":" + clientSecret).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });

    const text = await resp.text();
    res.status(resp.status).send(text);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Render proxy running on port", PORT);
});
