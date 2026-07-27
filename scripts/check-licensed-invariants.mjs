import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), "utf8");

const [
  licensedConfigSource,
  publicConfigSource,
  licenseSource,
  libSource,
  edgeOneHandlerSource,
  storageSource,
  servicePackageSource,
] = await Promise.all([
  read("src-tauri/tauri.licensed.conf.json"),
  read("src-tauri/tauri.conf.json"),
  read("src-tauri/src/license.rs"),
  read("src-tauri/src/lib.rs"),
  read("services/license-service/cloud-functions/_handler.ts"),
  read("services/license-service/src/storage.ts"),
  read("services/license-service/package.json"),
]);

const licensedConfig = JSON.parse(licensedConfigSource);
const publicConfig = JSON.parse(publicConfigSource);
const servicePackage = JSON.parse(servicePackageSource);

assert.equal(licensedConfig.productName, "摄影修图师助手");
assert.equal(licensedConfig.version, "1.0.0");
assert.equal(licensedConfig.identifier, "com.masongzhi.rawjpegmatcher.licensed");
assert.deepEqual(licensedConfig.plugins.updater.endpoints, [
  "https://gitee.com/masongzhi1/raw-jpeg-matcher-licensed-release/raw/main/release/latest.json",
]);
assert.notEqual(
  licensedConfig.plugins.updater.pubkey,
  publicConfig.plugins.updater.pubkey,
  "激活版与无激活版不得复用 updater 公钥",
);
assert.match(licenseSource, /const PRODUCT_ID: &str = "raw-jpeg-matcher-licensed"/);
assert.match(licenseSource, /const SERVICE_URL: &str = "https:\/\/licensed\.xyyamsz\.cn"/);
assert.match(licenseSource, /const LICENSE_PUBLIC_KEY_BASE64: &str = "[A-Za-z0-9+/=]+"/);
assert.match(libSource, /mod license;/);
assert.match(libSource, /license_status,\s+activate_license,\s+renew_license,/);
assert.equal(servicePackage.dependencies["@edgeone/pages-blob"], "0.0.14");
assert.equal(servicePackage.devDependencies.edgeone, "1.6.17");
assert.match(edgeOneHandlerSource, /getStore\("raw-jpeg-matcher-license"\)/);
assert.match(storageSource, /onlyIfNew:\s*true/);
assert.match(storageSource, /consistency:\s*"strong"/);
assert.equal(
  existsSync(path.join(repositoryRoot, "services/license-service/cloud-functions/_handler.ts")),
  true,
  "激活服务必须保留 EdgeOne Node.js 云函数入口",
);
assert.equal(
  existsSync(path.join(repositoryRoot, "services/license-service/edge-functions")),
  false,
  "激活服务不得恢复不稳定的 Edge Runtime 入口",
);
assert.equal(
  existsSync(path.join(repositoryRoot, "services/license-service/wrangler.jsonc")),
  false,
  "激活服务不得恢复 Cloudflare Wrangler 配置",
);

const commandFiles = {
  "src-tauri/src/lib.rs": ["open_file_path"],
  "src-tauri/src/raw_matcher.rs": [
    "matcher_capabilities",
    "collect_match_inputs",
    "match_counterpart_files",
    "export_matched_files",
    "file_thumbnail_path",
  ],
  "src-tauri/src/file_separator.rs": ["scan_separator_source", "export_separated_files"],
  "src-tauri/src/watermark.rs": [
    "scan_watermark_source",
    "inspect_watermark_asset",
    "list_watermark_fonts",
    "inspect_text_watermark",
    "watermark_preview_asset",
    "export_watermarked_images",
    "cancel_watermark_export",
  ],
};

for (const [relativePath, commandNames] of Object.entries(commandFiles)) {
  const source = await read(relativePath);
  for (const commandName of commandNames) {
    const functionStart = source.search(
      new RegExp(`(?:async\\s+)?fn\\s+${commandName}\\s*\\(`),
    );
    assert.notEqual(functionStart, -1, `${relativePath} 缺少 ${commandName}`);
    const nextCommand = source.indexOf("#[tauri::command]", functionStart);
    const functionSection = source.slice(
      functionStart,
      nextCommand === -1 ? source.length : nextCommand,
    );
    assert.match(
      functionSection,
      /license\.require_active\(\)\?/,
      `${commandName} 必须在 Rust 侧执行许可证门禁`,
    );
  }
}

console.log("licensed branch invariants: ok");
