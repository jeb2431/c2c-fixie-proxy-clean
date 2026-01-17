app.post("/auth/oauth2/token", async (req, res) => {
  try {
    const authUrl = "https://auth.consumerdirect.io/oauth2/token";

    const resp = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization":
          "Basic " +
          Buffer.from(
            process.env.CD_PAPI_PROD_CLIENT_ID +
              ":" +
              process.env.CD_PAPI_PROD_CLIENT_SECRET
          ).toString("base64"),
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
