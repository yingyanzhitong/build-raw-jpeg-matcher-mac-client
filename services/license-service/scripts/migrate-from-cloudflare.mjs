import { getStore } from "@edgeone/pages-blob";
import { randomUUID } from "node:crypto";

const CLOUDFLARE_DATABASE_ID = "0466cff1-9b55-4f5a-aa24-ecea637bac4d";
const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
const edgeOneProjectId = process.env.EDGEONE_PROJECT_ID;
const edgeOneToken = process.env.EDGEONE_API_TOKEN;

if (!cloudflareAccountId || !cloudflareToken || !edgeOneProjectId || !edgeOneToken) {
  throw new Error(
    "请设置 CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_API_TOKEN、EDGEONE_PROJECT_ID 和 EDGEONE_API_TOKEN。",
  );
}

const store = getStore({
  name: "raw-jpeg-matcher-license",
  projectId: edgeOneProjectId,
  token: edgeOneToken,
  consistency: "strong",
});
const [licenses, events, admins] = await Promise.all([
  queryCloudflare("SELECT * FROM licenses ORDER BY created_at, id"),
  queryCloudflare("SELECT * FROM license_events ORDER BY created_at, id"),
  queryCloudflare("SELECT * FROM admin_users ORDER BY username"),
]);

for (const row of licenses) {
  await store.setJSON(`licenses/${row.id}.json`, {
    id: row.id,
    token_digest: row.token_digest,
    token_last4: row.token_last4,
    note: row.note ?? "",
    status: row.status,
    generation: row.generation,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? null,
    updated_at: row.updated_at,
  });
  await store.setJSON(`token-index/${row.token_digest}.json`, { id: row.id });
  if (row.device_hash) {
    await store.setJSON(`claims/${row.id}.json`, {
      license_id: row.id,
      device_hash: row.device_hash,
      platform: row.platform,
      generation: row.generation,
      activated_at: row.activated_at,
      last_renewed_at: row.last_renewed_at ?? row.activated_at,
      updated_at: row.updated_at,
      nonce: `cloudflare-migration-${row.id}`,
    });
  }
}

for (const row of events) {
  const createdAt = Number(row.created_at);
  await store.setJSON(
    `events/${row.license_id}/${String(createdAt).padStart(12, "0")}-${row.id}.json`,
    {
      id: row.id,
      licenseId: row.license_id,
      eventType: row.event_type,
      createdAt,
      actor: row.actor,
      requestId: row.request_id ?? `cloudflare-migration-${randomUUID()}`,
      platform: row.platform ?? null,
      deviceSuffix: row.device_suffix ?? null,
      detailJson: row.detail_json ?? "{}",
    },
  );
}

for (const row of admins) {
  await store.setJSON(`admins/${row.username}.json`, {
    username: row.username,
    password_salt: row.password_salt,
    password_hash: row.password_hash,
    password_iterations: row.password_iterations,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at ?? null,
  });
}

console.log(
  `迁移完成：许可证 ${licenses.length} 条、审计事件 ${events.length} 条、管理员 ${admins.length} 个。`,
);

async function queryCloudflare(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/d1/database/${CLOUDFLARE_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cloudflareToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql }),
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(`Cloudflare D1 查询失败（HTTP ${response.status}）。`);
  }
  return payload.result?.[0]?.results ?? [];
}
