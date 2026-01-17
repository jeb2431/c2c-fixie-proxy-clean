/**
 * PAPI passthrough
 * /papi/*  -> https://papi.consumerdirect.io/*
 *
 * Adds safe debug when upstream returns 401/403.
 */
app.use("/papi", async (req, res) => {
  try {
    if (!requireProxyKey(req, res)) return;

    const upstreamPath = req.originalUrl.replace(/^\/papi/, "");
    const upstreamHost = "https://papi.consumerdirect.io";
    const upstreamUrl = `${upstreamHost}${upstreamPath}`;

    const headers = {
      accept: req.headers["accept"] || "application/json",
      "content-type": req.headers["content-type"],
      authorization: req.headers["authorization"], // Bearer OTC
    };

    Object.keys(headers).forEach((k) => headers[k] === undefined && delete headers[k]);

    let body;
    if (!["GET", "HEAD"].includes(req.method)) body = JSON.stringify(req.body ?? {});

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";

    // If blocked, return extra debug WITHOUT leaking secrets
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(upstream.status).json({
        ok: false,
        step: "papi_upstream_blocked",
        upstream: {
          status: upstream.status,
          url: upstreamUrl,
          host: upstreamHost,
          method: req.method,
          hasAuthHeader: !!req.headers["authorization"],
          authType: (req.headers["authorization"] || "").startsWith("Bearer ") ? "Bearer" : "Other/None",
          contentType,
        },
        raw: text,
      });
    }

    res.status(upstream.status);
    res.set("content-type", contentType);
    return res.send(text);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      step: "papi_exception",
      message: e?.message || String(e),
    });
  }
});
