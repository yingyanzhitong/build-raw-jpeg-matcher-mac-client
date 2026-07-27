import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createScfServer } from "../src/scf-server";
import type { Env } from "../src/types";
import { MemoryBlobStore } from "./memory-store";

const servers: ReturnType<typeof createScfServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("SCF Web 函数适配器", () => {
  it("通过原生 HTTP 暴露健康检查和后台跳转", async () => {
    const server = createScfServer(testEnv());
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      version: "1.2.0",
      runtime: "tencent-scf",
    });

    const root = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
    });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/admin/");
  });

  it("可转换带请求体的激活请求", async () => {
    const server = createScfServer(testEnv());
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "NOT-A-VALID-TOKEN",
        deviceHash: "a".repeat(64),
        platform: "macos",
        appVersion: "1.0.1",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_TOKEN" },
    });
  });
});

function testEnv(): Env {
  return {
    LICENSE_STORE: new MemoryBlobStore(),
    TOKEN_PEPPER: "test-only-token-pepper-with-at-least-32-bytes",
    LICENSE_PRIVATE_KEY_PEM: "unused-in-health-test",
    LICENSE_PUBLIC_KEY_BASE64: "unused-in-health-test",
    PRODUCT_ID: "raw-jpeg-matcher-licensed",
    RUNTIME_NAME: "tencent-scf",
  };
}
