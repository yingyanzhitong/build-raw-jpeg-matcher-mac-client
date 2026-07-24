import { getStore } from "@edgeone/pages-blob";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const ITERATIONS = 100_000;
const args = process.argv.slice(2);
const usernameIndex = args.indexOf("--username");
const username = (usernameIndex >= 0 ? args[usernameIndex + 1] : "admin")
  ?.trim()
  .toLowerCase();
const projectId = process.env.EDGEONE_PROJECT_ID;
const token = process.env.EDGEONE_API_TOKEN;

if (!projectId || !token) {
  throw new Error("请设置 EDGEONE_PROJECT_ID 和 EDGEONE_API_TOKEN。");
}
if (!username || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
  throw new Error("管理员账号只能包含小写字母、数字、点、下划线和连字符，长度为 3 到 64。");
}
if (process.stdin.isTTY) {
  throw new Error("请通过标准输入提供密码，避免密码进入命令历史。");
}
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (password.length < 12 || password.length > 256) {
  throw new Error("管理员密码长度必须为 12 到 256。");
}

const salt = randomBytes(16).toString("base64url");
const hash = pbkdf2Sync(password, Buffer.from(salt, "base64url"), ITERATIONS, 32, "sha256")
  .toString("base64url");
const now = Math.floor(Date.now() / 1000);
const store = getStore({
  name: "raw-jpeg-matcher-license",
  projectId,
  token,
  consistency: "strong",
});
const key = `admins/${username}.json`;
const existing = await store.get(key, { type: "json", consistency: "strong" });
await store.setJSON(key, {
  username,
  password_salt: salt,
  password_hash: hash,
  password_iterations: ITERATIONS,
  status: "active",
  created_at: existing?.created_at ?? now,
  updated_at: now,
  last_login_at: existing?.last_login_at ?? null,
});
console.log(`管理员 ${username} 已写入 EdgeOne Blob。`);
