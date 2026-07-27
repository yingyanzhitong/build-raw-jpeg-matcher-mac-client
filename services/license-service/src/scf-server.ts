import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { webcrypto } from "node:crypto";
import { getStore } from "@edgeone/pages-blob";
import licenseService from "./index";
import type { Env } from "./types";

const MAX_REQUEST_BYTES = 128 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

if (globalThis.crypto === undefined) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

export function createScfServer(env: Env = createScfEnv()) {
  return createServer(async (incoming, outgoing) => {
    let stage = "request";
    try {
      const request = await toWebRequest(incoming);
      stage = "service";
      const pending: Promise<unknown>[] = [];
      const response = await licenseService.fetch(request, env, {
        waitUntil(promise) {
          pending.push(promise);
        },
      });
      stage = "response";
      await writeWebResponse(outgoing, response);
      await Promise.allSettled(pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: "scf_adapter_error",
          stage,
          message,
        }),
      );
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
      }
      outgoing.end(
        JSON.stringify({
          ok: false,
          error: { code: "SERVER_ERROR", message: "服务暂时不可用，请稍后重试。" },
        }),
      );
    }
  });
}

export function createScfEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const projectId = requiredEnv(source, "EDGEONE_PROJECT_ID");
  const token = requiredEnv(source, "EDGEONE_API_TOKEN");
  return {
    LICENSE_STORE: getStore({
      name: source.EDGEONE_STORE_NAME || "raw-jpeg-matcher-license",
      projectId,
      token,
      consistency: "strong",
    }),
    PRODUCT_ID: requiredEnv(source, "PRODUCT_ID"),
    LICENSE_PUBLIC_KEY_BASE64: requiredEnv(source, "LICENSE_PUBLIC_KEY_BASE64"),
    LICENSE_PRIVATE_KEY_PEM: normalizePem(
      requiredEnv(source, "LICENSE_PRIVATE_KEY_PEM"),
    ),
    TOKEN_PEPPER: requiredEnv(source, "TOKEN_PEPPER"),
    CLAIM_SETTLE_MS: source.CLAIM_SETTLE_MS,
    RUNTIME_NAME: "tencent-scf",
  };
}

async function toWebRequest(incoming: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("SCF_REQUEST_TOO_LARGE");
    }
    chunks.push(bytes);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const forwardedProto = firstHeader(incoming.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(incoming.headers["x-forwarded-host"]);
  const protocol = forwardedProto === "http" ? "http" : "https";
  const host = forwardedHost || incoming.headers.host || "localhost";
  const method = incoming.method || "GET";
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  };
  if (init.body !== undefined) {
    init.duplex = "half";
  }
  return new Request(
    new URL(incoming.url || "/", `${protocol}://${host}`),
    init,
  );
}

async function writeWebResponse(outgoing: ServerResponse, response: Response) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      outgoing.setHeader(name, value);
    }
  });
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value?.split(",")[0]?.trim();
}

function requiredEnv(source: NodeJS.ProcessEnv, name: string) {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`MISSING_ENV:${name}`);
  }
  return value;
}

function normalizePem(value: string) {
  return value.replaceAll("\\n", "\n");
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT || 9000);
  createScfServer().listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "scf_server_ready", port }));
  });
}
