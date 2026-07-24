import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      LICENSE_DB: D1Database;
      ADMIN_SESSIONS: KVNamespace;
      TEST_MIGRATIONS: D1Migration[];
      TOKEN_PEPPER: string;
      LICENSE_PRIVATE_KEY_PEM: string;
      LICENSE_PUBLIC_KEY_BASE64: string;
      PRODUCT_ID: string;
    }
  }
}

export {};
