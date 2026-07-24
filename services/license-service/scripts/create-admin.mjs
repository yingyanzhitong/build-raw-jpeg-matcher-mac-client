import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ITERATIONS = 100_000;
const args = process.argv.slice(2);
const usernameIndex = args.indexOf("--username");
const username = (usernameIndex >= 0 ? args[usernameIndex + 1] : "admin")
  ?.trim()
  .toLowerCase();
const remote = !args.includes("--local");

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
const sql = `INSERT INTO admin_users
  (username, password_salt, password_hash, password_iterations, status, created_at, updated_at)
VALUES ('${sqlString(username)}', '${salt}', '${hash}', ${ITERATIONS}, 'active', ${now}, ${now})
ON CONFLICT(username) DO UPDATE SET
  password_salt = excluded.password_salt,
  password_hash = excluded.password_hash,
  password_iterations = excluded.password_iterations,
  status = 'active',
  updated_at = excluded.updated_at;`;

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  command,
  ["wrangler", "d1", "execute", "LICENSE_DB", remote ? "--remote" : "--local", "--command", sql],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`管理员 ${username} 已写入 ${remote ? "远程" : "本地"} D1。`);

function sqlString(value) {
  return value.replaceAll("'", "''");
}
