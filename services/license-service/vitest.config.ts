import { readFileSync } from "node:fs";
import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      const privateKey = readFileSync(
        path.join(import.meta.dirname, "test/fixtures/test-ed25519-private.pem"),
        "utf8",
      );
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TOKEN_PEPPER: "test-only-token-pepper-with-at-least-32-bytes",
            LICENSE_PRIVATE_KEY_PEM: privateKey,
            LICENSE_PUBLIC_KEY_BASE64: "LjLA32R86oUYUpbT7dUyLLllccUyje6OIgpi/ANKdPg=",
            PRODUCT_ID: "raw-jpeg-matcher-licensed",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
