#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const config = {
  token: requiredEnv("GITEE_ACCESS_TOKEN"),
  owner: process.env.GITEE_OWNER || "masongzhi1",
  repo: process.env.GITEE_REPO || "raw-jperaw-jpeg-matcher-mac-clientg-matcher-mac-client",
  branch: process.env.GITEE_PAGES_BRANCH || "pages",
  sourceDir: process.env.GITEE_PAGES_SOURCE_DIR || "gitee-pages",
  latestJsonPath: process.env.LATEST_JSON_PATH || "",
  latestJsonUrl:
    process.env.LATEST_JSON_URL ||
    "https://gitee.com/masongzhi1/raw-jperaw-jpeg-matcher-mac-clientg-matcher-mac-client/raw/main/release/latest.json",
  gitUsername: process.env.GITEE_GIT_USERNAME || process.env.GITEE_OWNER || "masongzhi1",
};

const workdir = await mkdtemp(path.join(tmpdir(), "gitee-pages-"));

try {
  if (await remoteBranchExists()) {
    await clonePagesBranch(workdir, config.gitUsername);
  } else {
    await initializePagesBranch(workdir);
  }

  await clearPublishedFiles(workdir);
  await cp(config.sourceDir, workdir, { recursive: true, force: true });
  await writeLatestCache(workdir);
  await writeFile(path.join(workdir, ".nojekyll"), "");

  const status = await gitStdout(["status", "--porcelain"], workdir);
  if (!status.trim()) {
    console.log(`Gitee Pages branch ${config.branch} is already up to date.`);
  } else {
    await runGit(["add", "-A"], workdir);
    await runGit(
      [
        "-c",
        "user.name=raw-jpeg-pages-bot",
        "-c",
        "user.email=actions@github.com",
        "commit",
        "-m",
        "chore: sync gitee pages",
      ],
      workdir,
    );
    await runGit(["push", "origin", `HEAD:${config.branch}`], workdir);
    console.log(`Synced Gitee Pages to ${config.owner}/${config.repo}:${config.branch}`);
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

async function remoteBranchExists() {
  try {
    const output = await gitStdout(
      ["ls-remote", "--heads", authenticatedRemoteUrl(config.gitUsername), config.branch],
      process.cwd(),
    );
    return output.trim().length > 0;
  } catch (error) {
    const fallbackOutput = await gitStdout(
      ["ls-remote", "--heads", authenticatedRemoteUrl("oauth2"), config.branch],
      process.cwd(),
    );
    config.gitUsername = "oauth2";
    return fallbackOutput.trim().length > 0;
  }
}

async function clonePagesBranch(targetDir, username) {
  await runGit(
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      config.branch,
      authenticatedRemoteUrl(username),
      targetDir,
    ],
    process.cwd(),
  );
}

async function initializePagesBranch(targetDir) {
  await runGit(["init", "--initial-branch", config.branch], targetDir);
  await runGit(["remote", "add", "origin", authenticatedRemoteUrl(config.gitUsername)], targetDir);
}

async function clearPublishedFiles(targetDir) {
  const entries = await readdir(targetDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== ".git")
      .map((entry) => rm(path.join(targetDir, entry.name), { recursive: true, force: true })),
  );
}

async function writeLatestCache(targetDir) {
  const cachePath = path.join(targetDir, "latest-cache.json");
  if (config.latestJsonPath) {
    await writeFile(cachePath, await readFile(config.latestJsonPath, "utf8"));
    return;
  }

  if (!config.latestJsonUrl) {
    return;
  }

  const response = await fetch(config.latestJsonUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch latest JSON: HTTP ${response.status}`);
  }
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, await response.text());
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
