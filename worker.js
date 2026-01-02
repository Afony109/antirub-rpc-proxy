export default {
  async fetch(request, env) {
    const ALLOWED_ORIGINS = new Set([
      "https://antirub.com",
      "https://www.antirub.com",
    ]);

    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://antirub.com";

    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") || "content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    const body = await request.text();

    // Берём upstream из переменной окружения (Cloudflare Variables)
    // Settings → Variables and secrets → UPSTREAM_RPC
    const upstream =
      (env && env.UPSTREAM_RPC) || "https://arbitrum-one-rpc.publicnode.com";

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: `Upstream fetch failed: ${e?.message || e}` },
        }),
        {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    return new Response(await upstreamResp.text(), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
