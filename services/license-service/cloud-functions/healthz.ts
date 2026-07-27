import { getStore } from "@edgeone/pages-blob";

export default async function onRequest() {
  try {
    await getStore("raw-jpeg-matcher-license").list({
      prefix: "health/",
      consistency: "strong",
      limit: 1,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        service: "raw-jpeg-matcher-license",
        runtime: "edgeone-node",
      }),
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: "SERVER_ERROR", message: "存储暂时不可用。" },
      }),
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
