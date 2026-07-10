const manifestSources = [
  "./latest-cache.json",
  "https://gitee.com/masongzhi1/raw-jperaw-jpeg-matcher-mac-clientg-matcher-mac-client/raw/main/release/latest.json",
];

const platformGroups = {
  mac: [
    { key: "darwin-aarch64", label: "Apple Silicon" },
    { key: "darwin-x86_64", label: "Intel" },
  ],
  windows: [{ key: "windows-x86_64", label: "64 位" }],
};

const stateElement = document.querySelector("#manifest-state");

loadManifest();

async function loadManifest() {
  try {
    const { manifest, source } = await fetchManifest();
    renderManifest(manifest, source);
  } catch (error) {
    renderManifestError(error);
  }
}

async function fetchManifest() {
  let lastError;

  for (const source of manifestSources) {
    try {
      const response = await fetch(source, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { manifest: await response.json(), source };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("版本清单读取失败");
}

function renderManifest(manifest, source) {
  const versionText = manifest.version ? `当前版本 ${manifest.version}` : "当前版本以清单为准";
  const dateText = formatDate(manifest.pub_date);
  const sourceText = source.includes("latest-cache") ? "同源缓存" : "Gitee 原始清单";

  stateElement.textContent = `${versionText}${dateText ? `，发布于 ${dateText}` : ""}。数据来源：${sourceText}。`;

  renderPlatform("mac", collectDownloads(manifest, "mac"));
  renderPlatform("windows", collectDownloads(manifest, "windows"));
}

function collectDownloads(manifest, platformName) {
  return platformGroups[platformName]
    .map(({ key, label }) => {
      const platform = manifest.platforms?.[key];
      const installer = manifest.installers?.[key];
      const url = platform?.installer_url || installer?.url;
      if (!url) {
        return null;
      }

      return {
        label,
        key,
        kind: platform?.installer_kind || installer?.kind || inferKind(url),
        url,
      };
    })
    .filter(Boolean);
}

function renderPlatform(platformName, downloads) {
  const link = document.querySelector(`[data-platform-link="${platformName}"]`);
  const meta = document.querySelector(`[data-platform-meta="${platformName}"]`);
  const variants = document.querySelector(`[data-platform-variants="${platformName}"]`);
  const platformLabel = platformName === "mac" ? "Mac" : "Windows";

  variants.replaceChildren();

  if (!downloads.length) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.classList.add("is-disabled");
    meta.textContent = "清单中暂未提供该平台安装包。";
    return;
  }

  const primary = downloads[0];
  link.href = primary.url;
  link.removeAttribute("aria-disabled");
  link.classList.remove("is-disabled");
  link.textContent = `下载 ${platformLabel} 版`;
  meta.textContent = `${primary.label}，${formatKind(primary.kind)} 安装包。`;

  for (const item of downloads) {
    const variantLink = document.createElement("a");
    variantLink.href = item.url;
    variantLink.textContent = `${item.label} - ${formatKind(item.kind)}`;
    variants.append(variantLink);
  }
}

function renderManifestError(error) {
  stateElement.textContent = `版本清单读取失败：${error.message}。可以稍后刷新页面，或进入 Gitee 仓库查看 Release。`;

  for (const platformName of Object.keys(platformGroups)) {
    renderPlatform(platformName, []);
  }
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatKind(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (normalized === "dmg") {
    return "DMG";
  }
  if (normalized === "nsis") {
    return "EXE";
  }
  if (normalized === "msi") {
    return "MSI";
  }
  return normalized ? normalized.toUpperCase() : "安装";
}

function inferKind(url) {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith(".dmg")) {
    return "dmg";
  }
  if (lowerUrl.endsWith(".msi")) {
    return "msi";
  }
  if (lowerUrl.endsWith(".exe")) {
    return "nsis";
  }
  return "";
}
