#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const config = {
  token: requiredEnv("GITEE_ACCESS_TOKEN"),
  owner: process.env.GITEE_OWNER || "masongzhi1",
  repo: process.env.GITEE_REPO || "raw-jperaw-jpeg-matcher-mac-clientg-matcher-mac-client",
  branch: process.env.GITEE_BRANCH || "main",
  gitUsername: process.env.GITEE_GIT_USERNAME || process.env.GITEE_OWNER || "masongzhi1",
  tag: requiredEnv("RELEASE_TAG"),
  releaseName: process.env.RELEASE_NAME || requiredEnv("RELEASE_TAG"),
  releaseBody: process.env.RELEASE_BODY || "Automated installer build for 照片配对助手.",
  assetDir: process.env.RELEASE_ASSET_DIR || "normalized-release-assets",
  latestInstallerDir: process.env.LATEST_INSTALLER_DIR || "latest-installers",
  latestJsonPath: process.env.LATEST_JSON_PATH || "normalized-release-assets/latest.json",
  latestInstallerTag: process.env.GITEE_LATEST_INSTALLER_TAG || "latest",
  latestInstallerName: process.env.GITEE_LATEST_INSTALLER_NAME || "照片配对助手最新安装包",
  latestInstallerBody:
    process.env.GITEE_LATEST_INSTALLER_BODY || "始终提供当前最新版本的 Windows 与 macOS 安装包。",
  compatibilityManifestTag: process.env.GITEE_COMPATIBILITY_MANIFEST_TAG?.trim() || null,
};

const apiBase = "https://gitee.com/api/v5";
await ensureRepositoryReady();
const releaseId = await ensureRelease({
  tag: config.tag,
  name: config.releaseName,
  body: config.releaseBody,
});
const latestInstallerReleaseId = await ensureRelease({
  tag: config.latestInstallerTag,
  name: config.latestInstallerName,
  body: config.latestInstallerBody,
});
const compatibilityManifestReleaseId = config.compatibilityManifestTag
  ? await ensureRelease({
      tag: config.compatibilityManifestTag,
      name: "旧版更新兼容清单",
      body: "仅用于旧版客户端迁移至当前更新规范。",
    })
  : null;
const releaseAssets = await releaseAssetFiles();
const latestInstallers = await latestInstallerAssetFiles();

await uploadReleaseAssets(releaseId, releaseAssets, config.tag);
await replaceReleaseAssets(latestInstallerReleaseId, latestInstallers, config.latestInstallerTag);
await updateLatestJsonWithGit();
if (compatibilityManifestReleaseId) {
  await replaceReleaseAssets(
    compatibilityManifestReleaseId,
    [config.latestJsonPath],
    config.compatibilityManifestTag,
  );
}
console.log(
  `已同步 Gitee 版本 Release ${config.tag}，并更新 ${config.latestInstallerTag} 安装包、main/release/latest.json 更新清单${
    config.compatibilityManifestTag ? `及 ${config.compatibilityManifestTag} 兼容清单` : ""
  }：${config.owner}/${config.repo}`,
);

async function ensureRepositoryReady() {
  const repository = await giteeJson(
    `/repos/${config.owner}/${config.repo}?access_token=${encodeURIComponent(config.token)}`,
  );
  if (repository.private) {
    throw new Error(
      `Gitee release repository ${config.owner}/${config.repo} must be public so installed clients can fetch updates`,
    );
  }
  if (await branchExists()) {
    return;
  }

  console.log(`Gitee branch ${config.branch} does not exist; initializing repository content.`);
  await initializeRepositoryWithGit();

  if (!(await branchExists())) {
    throw new Error(`Gitee branch ${config.branch} still does not exist after initialization`);
  }
}

async function branchExists() {
  const response = await giteeFetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/branches/${encodeURIComponent(
      config.branch,
    )}?access_token=${encodeURIComponent(config.token)}`,
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Failed to query Gitee branch ${config.branch}: ${await safeText(response)}`);
  }
  return true;
}

async function initializeRepositoryWithGit() {
  const workdir = await mkdtemp(path.join(tmpdir(), "gitee-release-"));
  try {
    await runGit(["init", "--initial-branch", config.branch], workdir);
    await writeFile(
      path.join(workdir, "README.md"),
      "# 照片配对助手发布镜像\n\n此仓库用于托管自动更新清单和安装包 release 资产。\n",
    );
    await runGit(["add", "README.md"], workdir);
    await runGit(
      [
        "-c",
        "user.name=raw-jpeg-release-bot",
        "-c",
        "user.email=actions@github.com",
        "commit",
        "-m",
        `chore: initialize release mirror for ${config.tag}`,
      ],
      workdir,
    );
    await runGit(["remote", "add", "origin", authenticatedRemoteUrl(config.gitUsername)], workdir);
    try {
      await runGit(["push", "origin", `HEAD:${config.branch}`], workdir);
    } catch (error) {
      await runGit(
        ["remote", "set-url", "origin", authenticatedRemoteUrl("oauth2")],
        workdir,
      );
      await runGit(["push", "origin", `HEAD:${config.branch}`], workdir);
    }
    console.log(`Initialized Gitee branch ${config.branch}.`);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function updateLatestJsonWithGit() {
  let workdir = await mkdtemp(path.join(tmpdir(), "gitee-release-"));
  try {
    try {
      await cloneRepository(workdir, config.gitUsername);
    } catch {
      await rm(workdir, { recursive: true, force: true });
      workdir = await mkdtemp(path.join(tmpdir(), "gitee-release-"));
      await cloneRepository(workdir, "oauth2");
    }

    await mkdir(path.join(workdir, "release"), { recursive: true });
    await writeFile(
      path.join(workdir, "release", "latest.json"),
      await readFile(config.latestJsonPath, "utf8"),
    );

    const status = await gitStdout(["status", "--porcelain", "--", "release/latest.json"], workdir);
    if (!status.trim()) {
      console.log("Gitee latest.json is already up to date.");
      return;
    }

    await runGit(["add", "release/latest.json"], workdir);
    await runGit(
      [
        "-c",
        "user.name=raw-jpeg-release-bot",
        "-c",
        "user.email=actions@github.com",
        "commit",
        "-m",
        `chore: update latest updater manifest for ${config.tag}`,
      ],
      workdir,
    );
    await runGit(["push", "origin", `HEAD:${config.branch}`], workdir);
    console.log(`Updated Gitee release/latest.json for ${config.tag}.`);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function cloneRepository(workdir, username) {
  await runGit(
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      config.branch,
      authenticatedRemoteUrl(username),
      workdir,
    ],
    process.cwd(),
  );
}

async function runGit(args, cwd) {
  await gitExec(args, cwd);
}

async function gitStdout(args, cwd) {
  const result = await gitExec(args, cwd);
  return result.stdout || "";
}

async function gitExec(args, cwd) {
  try {
    return await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    throw sanitizeError(error);
  }
}

function authenticatedRemoteUrl(username) {
  return `https://${encodeURIComponent(username)}:${encodeURIComponent(config.token)}@gitee.com/${
    config.owner
  }/${config.repo}.git`;
}

async function ensureRelease({ tag, name, body }) {
  const existing = await getReleaseByTag(tag);
  if (existing) {
    return existing.id;
  }

  const requestBody = new URLSearchParams({
    access_token: config.token,
    tag_name: tag,
    name,
    body,
    target_commitish: config.branch,
  });
  const created = await giteeJson(`/repos/${config.owner}/${config.repo}/releases`, {
    method: "POST",
    body: requestBody,
  });
  if (!created.id) {
    throw new Error("Gitee release response did not include id");
  }
  return created.id;
}

async function getReleaseByTag(tag) {
  const response = await giteeFetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/releases/tags/${encodeURIComponent(
      tag,
    )}?access_token=${encodeURIComponent(config.token)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to query Gitee release ${tag}: ${await safeText(response)}`);
  }
  return response.json();
}

async function releaseAssetFiles() {
  return (await readdir(config.assetDir))
    .filter((fileName) => fileName !== "latest.json")
    .map((fileName) => path.join(config.assetDir, fileName))
    .sort();
}

async function latestInstallerAssetFiles() {
  const files = (await readdir(config.latestInstallerDir))
    .map((fileName) => path.join(config.latestInstallerDir, fileName))
    .sort();
  if (files.length !== 3 || files.some((file) => !/\.(dmg|exe)$/i.test(file))) {
    throw new Error("最新安装包目录必须包含两份 macOS DMG 和一份 Windows EXE");
  }
  return files;
}

async function uploadReleaseAssets(releaseId, files, releaseTag) {
  const expectedNames = new Set(files.map((file) => path.basename(file)));
  const existingAssets = await listAssets(releaseId);

  for (const file of files) {
    const fileName = path.basename(file);
    const existing = existingAssets.filter((asset) => asset.name === fileName);
    if (existing.length === 1 && (await assetMatchesFile(existing[0], file))) {
      console.log(`Gitee release asset ${fileName} is already complete; skipping upload.`);
      continue;
    }
    for (const asset of existing) {
      await deleteAsset(releaseId, asset.id);
    }
    await uploadAsset(releaseId, file, releaseTag);
    await assertAssetUploaded(releaseId, fileName);
  }

  await assertExpectedAssetsUploaded(releaseId, expectedNames);
}

async function replaceReleaseAssets(releaseId, files, releaseTag) {
  for (const asset of await listAssets(releaseId)) {
    await deleteAsset(releaseId, asset.id);
  }
  await uploadReleaseAssets(releaseId, files, releaseTag);
  const expectedNames = files.map((file) => path.basename(file)).sort();
  const actualNames = (await listAssets(releaseId)).map((asset) => asset.name).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Gitee ${releaseTag} Release 资产不完整`);
  }
}

async function listAssets(releaseId) {
  const assets = await giteeJson(
    `/repos/${config.owner}/${config.repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(
      config.token,
    )}&per_page=100`,
  );
  return Array.isArray(assets) ? assets : [];
}

async function deleteAsset(releaseId, assetId) {
  const response = await giteeFetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/releases/${releaseId}/attach_files/${assetId}?access_token=${encodeURIComponent(
      config.token,
    )}`,
    { method: "DELETE" },
  );
  if (response.status !== 204) {
    throw new Error(`Failed to delete Gitee release asset ${assetId}: ${await safeText(response)}`);
  }
}

async function uploadAsset(releaseId, filePath, releaseTag) {
  const fileName = path.basename(filePath);
  const url = `${apiBase}/repos/${config.owner}/${config.repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(
    config.token,
  )}`;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`Uploading ${fileName} to Gitee release ${releaseTag} (${attempt}/${maxAttempts}).`);
    try {
      await runCurl(fileName, [
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--http1.1",
        "--connect-timeout",
        "30",
        "--max-time",
        "900",
        "--request",
        "POST",
        "--header",
        "Expect:",
        "--form",
        `file=@${filePath};filename=${fileName};type=application/octet-stream`,
        url,
      ]);
      console.log(`Uploaded ${fileName} to Gitee release ${releaseTag}.`);
      return;
    } catch (error) {
      const uploaded = (await listAssets(releaseId)).filter((asset) => asset.name === fileName);
      if (uploaded.length === 1 && (await assetMatchesFile(uploaded[0], filePath))) {
        console.log(
          `Gitee timed out after accepting ${fileName}; verified the complete remote asset.`,
        );
        return;
      }
      if (attempt === maxAttempts) {
        throw error;
      }
      console.log(
        `Gitee asset upload failed (${attempt}/${maxAttempts}) for ${fileName}; retrying: ${error.message}`,
      );
      await sleep(attempt * 5000);
    }
  }
}

async function assetMatchesFile(asset, filePath) {
  const fileStats = await stat(filePath);
  return Number(asset.size) === fileStats.size;
}

async function assertAssetUploaded(releaseId, fileName) {
  const matches = (await listAssets(releaseId)).filter((asset) => asset.name === fileName);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one uploaded Gitee asset named ${fileName}, found ${matches.length}`);
  }
}

async function assertExpectedAssetsUploaded(releaseId, expectedNames) {
  const actualNames = new Set((await listAssets(releaseId)).map((asset) => asset.name));
  const missing = [...expectedNames].filter((fileName) => !actualNames.has(fileName));
  if (missing.length > 0) {
    throw new Error(`Gitee release is missing expected assets: ${missing.join(", ")}`);
  }
}

async function runCurl(label, args) {
  const heartbeat = setInterval(() => {
    console.log(`Still uploading ${label} to Gitee release...`);
  }, 30_000);
  try {
    await execFileAsync("curl", args, {
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    throw sanitizeError(error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function giteeJson(pathname, init = {}) {
  const response = await giteeFetch(`${apiBase}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`Gitee API request failed: ${await safeText(response)}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function giteeFetch(url, init = {}) {
  const maxAttempts = 4;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = sanitizeError(error);
      if (attempt === maxAttempts) {
        break;
      }
      console.log(
        `Gitee request failed (${attempt}/${maxAttempts}), retrying: ${lastError.message}`,
      );
      await sleep(attempt * 3000);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeText(response) {
  const text = await response.text();
  return text.slice(0, 600);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sanitizeError(error) {
  const sanitized = new Error(sanitizeText(error.message || String(error)));
  sanitized.stack = sanitizeText(error.stack || sanitized.stack || "");
  sanitized.stdout = sanitizeText(error.stdout || "");
  sanitized.stderr = sanitizeText(error.stderr || "");
  return sanitized;
}

function sanitizeText(value) {
  return String(value)
    .replaceAll(config.token, "<redacted>")
    .replaceAll(encodeURIComponent(config.token), "<redacted>");
}
