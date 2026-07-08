#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const config = {
  token: requiredEnv("GITEE_ACCESS_TOKEN"),
  owner: process.env.GITEE_OWNER || "masongzhi1",
  repo: process.env.GITEE_REPO || "raw-jpeg-matcher-mac-client",
  branch: process.env.GITEE_BRANCH || "main",
  tag: requiredEnv("RELEASE_TAG"),
  releaseName: process.env.RELEASE_NAME || requiredEnv("RELEASE_TAG"),
  releaseBody: process.env.RELEASE_BODY || "Automated installer build for 照片配对助手.",
  assetDir: process.env.RELEASE_ASSET_DIR || "normalized-release-assets",
  latestJsonPath: process.env.LATEST_JSON_PATH || "normalized-release-assets/latest.json",
};

const apiBase = "https://gitee.com/api/v5";
const releaseId = await ensureRelease();
await uploadReleaseAssets(releaseId);
await upsertLatestJson();
console.log(`Synced ${config.tag} to Gitee ${config.owner}/${config.repo}`);

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
  const form = new FormData();
  form.append("access_token", config.token);
  form.append(
    "file",
    new Blob([await readFile(filePath)], { type: "application/octet-stream" }),
    fileName,
  );

  const response = await fetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/releases/${releaseId}/attach_files`,
    {
      method: "POST",
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to upload ${fileName} to Gitee: ${await safeText(response)}`);
  }
}

async function upsertLatestJson() {
  const latestPath = "release/latest.json";
  const encodedPath = latestPath.split("/").map(encodeURIComponent).join("/");
  const content = (await readFile(config.latestJsonPath)).toString("base64");
  const existing = await getFileInfo(encodedPath);
  const method = existing ? "PUT" : "POST";
  const body = new URLSearchParams({
    access_token: config.token,
    branch: config.branch,
    content,
    message: `chore: update latest updater manifest for ${config.tag}`,
  });
  if (existing?.sha) {
    body.set("sha", existing.sha);
  }

  await giteeJson(`/repos/${config.owner}/${config.repo}/contents/${encodedPath}`, {
    method,
    body,
  });
}

async function getFileInfo(encodedPath) {
  const response = await fetch(
    `${apiBase}/repos/${config.owner}/${config.repo}/contents/${encodedPath}?access_token=${encodeURIComponent(
      config.token,
    )}&ref=${encodeURIComponent(config.branch)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to read Gitee latest.json metadata: ${await safeText(response)}`);
  }
  return response.json();
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
