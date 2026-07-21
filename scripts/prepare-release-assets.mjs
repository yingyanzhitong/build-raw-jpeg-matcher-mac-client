#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";

const options = parseArgs(process.argv.slice(2));
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const tag = `v${version}`;
const appName = options.appName;
const outputDir = options.output;
const allFiles = walk(options.input);
const normalizedAssets = [];
const platforms = {};
const installers = {};
const notes = await readChangelogNotes(version);
const pubDate = new Date().toISOString();

await mkdir(outputDir, { recursive: true });

const macTargets = [
  { platform: "darwin-aarch64", assetLabel: "aarch64" },
  { platform: "darwin-x86_64", assetLabel: "x64" },
];

for (const { platform, assetLabel } of macTargets) {
  const macDmg = findUniqueRequired(
    allFiles,
    (file) => file.endsWith(".dmg") && tryInferMacArch(file) === platform,
    `macOS ${assetLabel} DMG`,
  );
  const macUpdater = findUniqueRequired(
    allFiles,
    (file) => file.endsWith(".app.tar.gz") && tryInferMacArch(file) === platform,
    `macOS ${assetLabel} updater bundle (*.app.tar.gz)`,
  );
  const macUpdaterSig = findUniqueRequired(
    allFiles,
    (file) => file === `${macUpdater}.sig`,
    `macOS ${assetLabel} updater signature (*.app.tar.gz.sig)`,
  );
  const macDmgName = `${appName}_${version}_macOS_${assetLabel}.dmg`;
  const macUpdaterName = `${appName}_${version}_macOS_${assetLabel}-updater.app.tar.gz`;
  const macUpdaterSigName = `${macUpdaterName}.sig`;
  const macDmgUrl = releaseUrl(options.owner, options.repo, tag, macDmgName);
  const macUpdaterUrl = releaseUrl(options.owner, options.repo, tag, macUpdaterName);

  await copyAsset(macDmg, macDmgName);
  await copyAsset(macUpdater, macUpdaterName);
  await copyAsset(macUpdaterSig, macUpdaterSigName);
  platforms[platform] = {
    signature: (await readFile(macUpdaterSig, "utf8")).trim(),
    url: macUpdaterUrl,
  };
  installers[platform] = {
    kind: "dmg",
    url: macDmgUrl,
  };
}

const windowsExe = findUniqueRequired(
  allFiles,
  (file) => file.endsWith(".exe"),
  "Windows x64 installer (*.exe)",
);
const windowsSig = findUniqueRequired(
  allFiles,
  (file) => file === `${windowsExe}.sig`,
  "Windows x64 updater signature (*.exe.sig)",
);
const windowsExeName = `${appName}_${version}_Windows_x64-setup.exe`;
const windowsSigName = `${windowsExeName}.sig`;
await copyAsset(windowsExe, windowsExeName);
await copyAsset(windowsSig, windowsSigName);
const windowsUrl = releaseUrl(options.owner, options.repo, tag, windowsExeName);
platforms["windows-x86_64"] = {
  signature: (await readFile(windowsSig, "utf8")).trim(),
  url: windowsUrl,
};
installers["windows-x86_64"] = {
  kind: "nsis",
  url: windowsUrl,
};

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  installers,
  platforms,
};
await writeFile(
  path.join(outputDir, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
normalizedAssets.push(path.join(outputDir, "latest.json"));

console.log(`Prepared ${normalizedAssets.length} release assets for ${tag}`);
console.log(`Manifest platforms: ${Object.keys(platforms).join(", ")}`);

async function copyAsset(source, fileName) {
  const destination = path.join(outputDir, fileName);
  await cp(source, destination);
  normalizedAssets.push(destination);
}

function walk(root) {
  const result = [];
  for (const entry of readdirSync(root)) {
    const entryPath = path.join(root, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      result.push(...walk(entryPath));
    } else if (stats.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

function findUniqueRequired(files, predicate, label) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} under ${options.input}, found ${matches.length}`);
  }
  return matches[0];
}

function tryInferMacArch(file) {
  const name = file.toLowerCase();
  if (name.includes("aarch64") || name.includes("arm64")) {
    return "darwin-aarch64";
  }
  if (name.includes("x64") || name.includes("x86_64")) {
    return "darwin-x86_64";
  }
  return null;
}

async function readChangelogNotes(targetVersion) {
  try {
    const changelog = await readFile("CHANGELOG.md", "utf8");
    const heading = `## ${targetVersion}`;
    const headingIndex = changelog.indexOf(heading);
    if (headingIndex === -1) {
      return `Automated installer build for ${targetVersion}.`;
    }

    const sectionStart = changelog.indexOf("\n", headingIndex);
    if (sectionStart === -1) {
      return `Automated installer build for ${targetVersion}.`;
    }

    const nextSection = changelog.indexOf("\n## ", sectionStart + 1);
    const section = changelog
      .slice(sectionStart + 1, nextSection === -1 ? undefined : nextSection)
      .trim();

    return section || `Automated installer build for ${targetVersion}.`;
  } catch {
    return `Automated installer build for ${targetVersion}.`;
  }
}

function releaseUrl(owner, repo, releaseTag, fileName) {
  return `https://gitee.com/${owner}/${repo}/releases/download/${releaseTag}/${encodeURIComponent(fileName)}`;
}

function parseArgs(args) {
  const parsed = {
    input: "release-assets",
    output: "normalized-release-assets",
    owner: "masongzhi1",
    repo: "raw-jperaw-jpeg-matcher-mac-clientg-matcher-mac-client",
    appName: "photo-pairing-assistant",
  };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${key}`);
    }
    index += 1;
    switch (key) {
      case "--input":
        parsed.input = value;
        break;
      case "--output":
        parsed.output = value;
        break;
      case "--owner":
        parsed.owner = value;
        break;
      case "--repo":
        parsed.repo = value;
        break;
      case "--app-name":
        parsed.appName = value;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  return parsed;
}
