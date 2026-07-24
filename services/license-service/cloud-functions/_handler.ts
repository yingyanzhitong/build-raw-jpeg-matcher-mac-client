import { getStore } from "@edgeone/pages-blob";
import licenseService from "../src/index";
import type { Env } from "../src/types";

interface EdgeOneNodeContext {
  request: Request;
  env: Omit<Env, "LICENSE_STORE">;
}

export async function handleLicenseRequest(context: EdgeOneNodeContext) {
  try {
    const env: Env = {
      ...context.env,
      LICENSE_STORE: getStore("raw-jpeg-matcher-license"),
    };
    return await licenseService.fetch(context.request, env, {
      waitUntil() {
        // Node.js Cloud Functions 会等待请求处理 Promise 完成。
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "license_handler_error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: "SERVER_ERROR", message: "服务暂时不可用，请稍后重试。" },
      }),
      {
        status: 500,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
