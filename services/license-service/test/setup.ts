import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.LICENSE_DB, env.TEST_MIGRATIONS);
