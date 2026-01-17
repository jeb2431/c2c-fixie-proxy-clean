// server.js — CommonJS, Node 18+, zero deps

const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// AUTH PROXY — WORKS ON RENDER
app.post("/auth/oauth2/token", async (_req, res) => {
  try {
    const clientId = process.env.CD_PAPI_PROD_CLIENT_ID;
    const clientSecret = process.env.CD_PAPI_PROD_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: "Missing CD_PAPI_PROD_CLIENT_ID or CD_PAPI_PROD_CLIENT_SECRET",
      });
    }

    const auth = Buffer.from(clientId + ":" + clientSecret).toString("base64");

    const response = await fetch("https://auth.consumerdirect.io/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + auth,
      },
      body: "grant_type=client_credentials",
    });

    const text = await response.text();
    res.status(response.status).send(text);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Render proxy listening on", PORT);
});
