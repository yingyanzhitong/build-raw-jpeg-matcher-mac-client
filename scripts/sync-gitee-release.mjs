#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  latestJsonPath: process.env.LATEST_JSON_PATH || "normalized-release-assets/latest.json",
};

const apiBase = "https://gitee.com/api/v5";
await ensureRepositoryReady();
await upsertLatestJson();
console.log(`Synced updater manifest for ${config.tag} to Gitee ${config.owner}/${config.repo}`);

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

async function upsertLatestJson() {
  await updateLatestJsonWithGit();
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
