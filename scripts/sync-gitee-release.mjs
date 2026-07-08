#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  latestJsonPath: process.env.LATEST_JSON_PATH || "normalized-release-assets/latest.json",
};

const apiBase = "https://gitee.com/api/v5";
await ensureRepositoryReady();
const releaseId = await ensureRelease();
await uploadReleaseAssets(releaseId);
await upsertLatestJson();
console.log(`Synced ${config.tag} to Gitee ${config.owner}/${config.repo}`);

async function ensureRepositoryReady() {
  await giteeJson(
    `/repos/${config.owner}/${config.repo}?access_token=${encodeURIComponent(config.token)}`,
  );
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
  const response = await fetch(
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
    await mkdir(path.join(workdir, "release"), { recursive: true });
    await writeFile(
      path.join(workdir, "README.md"),
      "# 照片配对助手发布镜像\n\n此仓库用于托管自动更新清单和安装包 release 资产。\n",
    );
    await writeFile(
      path.join(workdir, "release", "latest.json"),
      await readFile(config.latestJsonPath, "utf8"),
    );
    await runGit(["add", "README.md", "release/latest.json"], workdir);
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
    } catch (error) {
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

async function ensureRelease() {
  const existing = await getReleaseByTag();
  if (existing) {
    return existing.id;
  }

  const body = new URLSearchParams({
    access_token: config.token,
    tag_name: config.tag,
    name: config.releaseName,
    body: config.releaseBody,
    target_commitish: config.branch,
  });
  const created = await giteeJson(`/repos/${config.owner}/${config.repo}/releases`, {
    method: "POST",
    body,
  });
  if (!created.id) {
    throw new Error("Gitee release response did not include id");
  }
  return created.id;
}

async function getReleaseByTag() {
  const response = await fetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/releases/tags/${encodeURIComponent(
      config.tag,
    )}?access_token=${encodeURIComponent(config.token)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to query Gitee release ${config.tag}: ${await safeText(response)}`);
  }
  return response.json();
}

async function uploadReleaseAssets(releaseId) {
  const files = (await readdir(config.assetDir))
    .map((fileName) => path.join(config.assetDir, fileName))
    .sort();
  const existingAssets = await listAssets(releaseId);

  for (const file of files) {
    const fileName = path.basename(file);
    const existing = existingAssets.find((asset) => asset.name === fileName);
    if (existing) {
      await deleteAsset(releaseId, existing.id);
    }
    await uploadAsset(releaseId, file);
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
  const response = await fetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/releases/${releaseId}/attach_files/${assetId}?access_token=${encodeURIComponent(
      config.token,
    )}`,
    { method: "DELETE" },
  );
  if (response.status !== 204) {
    throw new Error(`Failed to delete Gitee release asset ${assetId}: ${await safeText(response)}`);
  }
}

async function uploadAsset(releaseId, filePath) {
  const fileName = path.basename(filePath);
  const url = `${apiBase}/repos/${config.owner}/${config.repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(
    config.token,
  )}`;
  console.log(`Uploading ${fileName} to Gitee release ${config.tag}.`);
  await runCurl([
    "--fail-with-body",
    "--silent",
    "--show-error",
    "--retry",
    "2",
    "--retry-delay",
    "5",
    "--connect-timeout",
    "30",
    "--max-time",
    "600",
    "--request",
    "POST",
    "--header",
    "Expect:",
    "--form",
    `file=@${filePath};filename=${fileName};type=application/octet-stream`,
    url,
  ]);
  console.log(`Uploaded ${fileName} to Gitee release ${config.tag}.`);
}

async function upsertLatestJson() {
  await updateLatestJsonWithGit();
}

async function runCurl(args) {
  try {
    await execFileAsync("curl", args, {
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    throw sanitizeError(error);
  }
}

async function giteeJson(pathname, init = {}) {
  const response = await fetch(`${apiBase}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`Gitee API request failed: ${await safeText(response)}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
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
