import type {
  AspectKind,
  WatermarkAnchor,
  WatermarkExportEvent,
  WatermarkFontInfo,
  WatermarkGeometry,
  WatermarkLayout,
  WatermarkProfile,
  WatermarkProfiles,
  WatermarkProfilesBySource,
  WatermarkProgress,
  WatermarkSettingsSnapshot,
  WatermarkSizeBasis,
  WatermarkSourceKind,
} from "./types";

export const watermarkSettingsKey = "watermark-settings:v6";
export const legacyWatermarkV5SettingsKey = "watermark-settings:v5";
export const legacyWatermarkV4SettingsKey = "watermark-settings:v4";
export const legacyWatermarkV3SettingsKey = "watermark-settings:v3";
export const legacyWatermarkV2SettingsKey = "watermark-settings:v2";
export const legacyWatermarkSettingsKey = "watermark-settings:v1";
export const aspectKinds: AspectKind[] = ["landscape", "portrait", "square"];
export const maxWatermarkTileCount = 5_000;
export const maxTextWatermarkCharacters = 120;
export const defaultTextWatermarkClarity = 0.4;
export const defaultTextWatermarkTileSpacingPercent = 2;
export const defaultJpegQuality = 100;

export type WatermarkWorkflowStepState = "complete" | "current" | "pending";

export function watermarkWorkflowStepStates(
  imageCount: number,
  hasWatermarkAsset: boolean,
): [WatermarkWorkflowStepState, WatermarkWorkflowStepState, WatermarkWorkflowStepState] {
  const sourceReady = imageCount > 0;
  return [
    sourceReady ? "complete" : "current",
    hasWatermarkAsset ? "complete" : sourceReady ? "current" : "pending",
    sourceReady && hasWatermarkAsset ? "current" : "pending",
  ];
}

const validAnchors = new Set<WatermarkAnchor>([
  "topLeft",
  "topCenter",
  "topRight",
  "centerLeft",
  "center",
  "centerRight",
  "bottomLeft",
  "bottomCenter",
  "bottomRight",
]);
const validLayouts = new Set<WatermarkLayout>(["single", "tile"]);

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createDefaultProfile(
  sourceKind: WatermarkSourceKind = "image",
): WatermarkProfile {
  return {
    layout: "single",
    anchor: "bottomRight",
    clarity: sourceKind === "text" ? defaultTextWatermarkClarity : 1,
    sizePercent: 20,
    rotationDegrees: 0,
    offsetXPercent: 0,
    offsetYPercent: 0,
    tileSpacingPercent:
      sourceKind === "text" ? defaultTextWatermarkTileSpacingPercent : 8,
  };
}

export function createDefaultProfiles(
  sourceKind: WatermarkSourceKind = "image",
): WatermarkProfiles {
  return {
    landscape: createDefaultProfile(sourceKind),
    portrait: createDefaultProfile(sourceKind),
    square: createDefaultProfile(sourceKind),
  };
}

export function createDefaultProfilesBySource(): WatermarkProfilesBySource {
  return {
    image: createDefaultProfiles("image"),
    text: createDefaultProfiles("text"),
  };
}

export function updateWatermarkProfile(
  profiles: WatermarkProfiles,
  aspect: AspectKind,
  update: Partial<WatermarkProfile>,
): WatermarkProfiles {
  return {
    ...profiles,
    [aspect]: sanitizeProfile({ ...profiles[aspect], ...update }),
  };
}

export function syncWatermarkProfiles(
  profiles: WatermarkProfiles,
  source: AspectKind,
): WatermarkProfiles {
  const profile = sanitizeProfile(profiles[source]);
  return {
    landscape: { ...profile },
    portrait: { ...profile },
    square: { ...profile },
  };
}

export function loadWatermarkSettings(
  storage: SettingsStorage,
): WatermarkSettingsSnapshot {
  const fallback = createDefaultWatermarkSettings();
  try {
    const current = storage.getItem(watermarkSettingsKey);
    const legacyV5 = current === null ? storage.getItem(legacyWatermarkV5SettingsKey) : null;
    const legacyV4 =
      current === null && legacyV5 === null
        ? storage.getItem(legacyWatermarkV4SettingsKey)
        : null;
    const serialized =
      current ??
      legacyV5 ??
      legacyV4 ??
      storage.getItem(legacyWatermarkV3SettingsKey) ??
      storage.getItem(legacyWatermarkV2SettingsKey) ??
      storage.getItem(legacyWatermarkSettingsKey);
    if (!serialized) {
      return fallback;
    }
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) {
      return fallback;
    }
    const watermarkPath = typeof value.watermarkPath === "string" ? value.watermarkPath : "";
    const sourceKind: WatermarkSourceKind = value.sourceKind === "text" ? "text" : "image";
    const storedProfilesBySource = isRecord(value.profilesBySource)
      ? value.profilesBySource
      : {};
    const legacyImageProfiles = sanitizeProfiles(value.profiles, "image");
    const profilesBySource: WatermarkProfilesBySource = current !== null || legacyV5 !== null
      ? {
          image: sanitizeProfiles(storedProfilesBySource.image, "image"),
          text: sanitizeProfiles(storedProfilesBySource.text, "text"),
        }
      : {
          image: legacyImageProfiles,
          text:
            legacyV4 !== null && sourceKind === "text"
              ? migrateLegacyTextProfiles(legacyImageProfiles)
              : createDefaultProfiles("text"),
        };
    return {
      sourceKind,
      watermarkPath,
      text: sanitizeTextWatermarkInput(value.text),
      fontId: typeof value.fontId === "string" ? value.fontId : "",
      jpegQuality: sanitizeJpegQuality(value.jpegQuality),
      profilesBySource,
    };
  } catch {
    return fallback;
  }
}

export function createDefaultWatermarkSettings(): WatermarkSettingsSnapshot {
  return {
    sourceKind: "image",
    watermarkPath: "",
    text: "",
    fontId: "",
    jpegQuality: defaultJpegQuality,
    profilesBySource: createDefaultProfilesBySource(),
  };
}

export function saveWatermarkSettings(
  storage: SettingsStorage,
  settings: WatermarkSettingsSnapshot,
) {
  try {
    storage.setItem(
      watermarkSettingsKey,
      JSON.stringify({
        sourceKind: settings.sourceKind,
        watermarkPath: settings.watermarkPath,
        text: sanitizeTextWatermarkInput(settings.text),
        fontId: settings.fontId,
        jpegQuality: sanitizeJpegQuality(settings.jpegQuality),
        profilesBySource: {
          image: sanitizeProfiles(settings.profilesBySource.image, "image"),
          text: sanitizeProfiles(settings.profilesBySource.text, "text"),
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function sanitizeJpegQuality(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultJpegQuality;
  }
  return clamp(Math.round(value), 1, 100);
}

function sanitizeProfiles(
  value: unknown,
  sourceKind: WatermarkSourceKind,
): WatermarkProfiles {
  const stored = isRecord(value) ? value : {};
  const defaults = createDefaultProfiles(sourceKind);
  return {
    landscape: sanitizeProfile(stored.landscape, defaults.landscape),
    portrait: sanitizeProfile(stored.portrait, defaults.portrait),
    square: sanitizeProfile(stored.square, defaults.square),
  };
}

function migrateLegacyTextProfiles(profiles: WatermarkProfiles): WatermarkProfiles {
  return Object.fromEntries(
    aspectKinds.map((aspect) => {
      const profile = profiles[aspect];
      return [
        aspect,
        {
          ...profile,
          clarity:
            profile.clarity === 1 ? defaultTextWatermarkClarity : profile.clarity,
          tileSpacingPercent:
            profile.tileSpacingPercent === 8
              ? defaultTextWatermarkTileSpacingPercent
              : profile.tileSpacingPercent,
        },
      ];
    }),
  ) as WatermarkProfiles;
}

export function sanitizeTextWatermarkInput(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if ([...trimmed].some((character) => /[\u0000-\u001f\u007f]/.test(character))) {
    return "";
  }
  return [...trimmed].slice(0, maxTextWatermarkCharacters).join("");
}

export function resolveWatermarkFont(
  fonts: WatermarkFontInfo[],
  requestedFontId: string,
  defaultFontId: string,
) {
  const available = new Set(fonts.map((font) => font.id));
  if (available.has(requestedFontId)) {
    return { fontId: requestedFontId, fellBack: false };
  }
  const fontId = available.has(defaultFontId) ? defaultFontId : (fonts[0]?.id ?? "");
  return { fontId, fellBack: requestedFontId.length > 0 && fontId !== requestedFontId };
}

export function computeWatermarkGeometry({
  targetWidth,
  targetHeight,
  watermarkWidth,
  watermarkHeight,
  profile,
  sizeBasis = "width",
}: {
  targetWidth: number;
  targetHeight: number;
  watermarkWidth: number;
  watermarkHeight: number;
  profile: WatermarkProfile;
  sizeBasis?: WatermarkSizeBasis;
}): WatermarkGeometry {
  const safeTargetWidth = Math.max(1, targetWidth);
  const safeTargetHeight = Math.max(1, targetHeight);
  const safeWatermarkWidth = Math.max(1, watermarkWidth);
  const safeWatermarkHeight = Math.max(1, watermarkHeight);
  const shortEdge = Math.min(safeTargetWidth, safeTargetHeight);
  const margin = Math.min(
    Math.round(shortEdge * 0.03),
    Math.floor((safeTargetWidth - 1) / 2),
    Math.floor((safeTargetHeight - 1) / 2),
  );
  const sanitized = sanitizeProfile(profile);
  let [drawWidth, drawHeight] = scaledWatermarkDimensions(
    shortEdge,
    safeWatermarkWidth,
    safeWatermarkHeight,
    sanitized.sizePercent,
    sizeBasis,
  );
  const radians = (sanitized.rotationDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  let boundsWidth = drawWidth * cos + drawHeight * sin;
  let boundsHeight = drawHeight * cos + drawWidth * sin;
  const availableWidth = Math.max(1, safeTargetWidth - margin * 2);
  const availableHeight = Math.max(1, safeTargetHeight - margin * 2);
  const fitScale = Math.min(1, availableWidth / boundsWidth, availableHeight / boundsHeight);
  drawWidth *= fitScale;
  drawHeight *= fitScale;
  boundsWidth = drawWidth * cos + drawHeight * sin;
  boundsHeight = drawHeight * cos + drawWidth * sin;

  const minX = margin;
  const minY = margin;
  const maxX = safeTargetWidth - margin - boundsWidth;
  const maxY = safeTargetHeight - margin - boundsHeight;
  const centerLeft = (safeTargetWidth - boundsWidth) / 2;
  const centerTop = (safeTargetHeight - boundsHeight) / 2;
  const [baseX, baseY] = anchorOrigin(
    sanitized.anchor,
    minX,
    minY,
    centerLeft,
    centerTop,
    maxX,
    maxY,
  );
  const boundsX = clamp(
    baseX + safeTargetWidth * sanitized.offsetXPercent * 0.01,
    minX,
    maxX,
  );
  const boundsY = clamp(
    baseY + safeTargetHeight * sanitized.offsetYPercent * 0.01,
    minY,
    maxY,
  );
  return {
    drawWidth,
    drawHeight,
    boundsWidth,
    boundsHeight,
    centerX: boundsX + boundsWidth / 2,
    centerY: boundsY + boundsHeight / 2,
    margin,
  };
}

export function computeWatermarkPlacements({
  targetWidth,
  targetHeight,
  watermarkWidth,
  watermarkHeight,
  profile,
  sizeBasis = "width",
}: {
  targetWidth: number;
  targetHeight: number;
  watermarkWidth: number;
  watermarkHeight: number;
  profile: WatermarkProfile;
  sizeBasis?: WatermarkSizeBasis;
}): WatermarkGeometry[] {
  const sanitized = sanitizeProfile(profile);
  if (sanitized.layout === "single") {
    return [
      computeWatermarkGeometry({
        targetWidth,
        targetHeight,
        watermarkWidth,
        watermarkHeight,
        profile: sanitized,
        sizeBasis,
      }),
    ];
  }

  const safeTargetWidth = Math.max(1, targetWidth);
  const safeTargetHeight = Math.max(1, targetHeight);
  const safeWatermarkWidth = Math.max(1, watermarkWidth);
  const safeWatermarkHeight = Math.max(1, watermarkHeight);
  const shortEdge = Math.min(safeTargetWidth, safeTargetHeight);
  const [drawWidth, drawHeight] = scaledWatermarkDimensions(
    shortEdge,
    safeWatermarkWidth,
    safeWatermarkHeight,
    sanitized.sizePercent,
    sizeBasis,
  );
  const radians = (sanitized.rotationDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const boundsWidth = Math.ceil(drawWidth * cos + drawHeight * sin);
  const boundsHeight = Math.ceil(drawHeight * cos + drawWidth * sin);
  const gap = Math.max(1, Math.round(shortEdge * sanitized.tileSpacingPercent * 0.01));
  if (sizeBasis === "height") {
    return computeRotatedTextTilePlacements({
      boundsHeight,
      boundsWidth,
      drawHeight,
      drawWidth,
      gap,
      offsetX: Math.round(safeTargetWidth * sanitized.offsetXPercent * 0.01),
      offsetY: Math.round(safeTargetHeight * sanitized.offsetYPercent * 0.01),
      radians,
      targetHeight: safeTargetHeight,
      targetWidth: safeTargetWidth,
    });
  }
  const stepX = boundsWidth + gap;
  const stepY = boundsHeight + gap;
  const phaseX = positiveModulo(safeTargetWidth * sanitized.offsetXPercent * 0.01, stepX);
  const phaseY = positiveModulo(safeTargetHeight * sanitized.offsetYPercent * 0.01, stepY);
  const placements: WatermarkGeometry[] = [];

  for (let top = phaseY - boundsHeight / 2; top < safeTargetHeight; top += stepY) {
    for (let left = phaseX - boundsWidth / 2; left < safeTargetWidth; left += stepX) {
      placements.push({
        drawWidth,
        drawHeight,
        boundsWidth,
        boundsHeight,
        centerX: left + boundsWidth / 2,
        centerY: top + boundsHeight / 2,
        margin: 0,
      });
      if (placements.length >= maxWatermarkTileCount) {
        return placements;
      }
    }
  }
  return placements;
}

function computeRotatedTextTilePlacements({
  boundsHeight,
  boundsWidth,
  drawHeight,
  drawWidth,
  gap,
  offsetX,
  offsetY,
  radians,
  targetHeight,
  targetWidth,
}: {
  boundsHeight: number;
  boundsWidth: number;
  drawHeight: number;
  drawWidth: number;
  gap: number;
  offsetX: number;
  offsetY: number;
  radians: number;
  targetHeight: number;
  targetWidth: number;
}): WatermarkGeometry[] {
  const stepX = drawWidth + gap;
  const stepY = drawHeight + gap;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const originX = targetWidth / 2 + offsetX;
  const originY = targetHeight / 2 + offsetY;
  const expandedCorners = [
    [-boundsWidth / 2, -boundsHeight / 2],
    [targetWidth + boundsWidth / 2, -boundsHeight / 2],
    [-boundsWidth / 2, targetHeight + boundsHeight / 2],
    [targetWidth + boundsWidth / 2, targetHeight + boundsHeight / 2],
  ];
  const localCorners = expandedCorners.map(([worldX, worldY]) => {
    const deltaX = worldX - originX;
    const deltaY = worldY - originY;
    return [deltaX * cos + deltaY * sin, -deltaX * sin + deltaY * cos];
  });
  const localXs = localCorners.map(([localX]) => localX);
  const localYs = localCorners.map(([, localY]) => localY);
  const minimumColumn = Math.floor((Math.min(...localXs) - stepX / 2) / stepX) - 1;
  const maximumColumn = Math.ceil((Math.max(...localXs) + stepX / 2) / stepX) + 1;
  const minimumRow = Math.floor(Math.min(...localYs) / stepY) - 1;
  const maximumRow = Math.ceil(Math.max(...localYs) / stepY) + 1;
  const placements: WatermarkGeometry[] = [];

  for (let row = minimumRow; row <= maximumRow; row += 1) {
    const stagger = Math.abs(row) % 2 === 1 ? stepX / 2 : 0;
    const localY = row * stepY;
    for (let column = minimumColumn; column <= maximumColumn; column += 1) {
      const localX = column * stepX + stagger;
      const worldCenterX = originX + localX * cos - localY * sin;
      const worldCenterY = originY + localX * sin + localY * cos;
      const left = Math.round(worldCenterX - boundsWidth / 2);
      const top = Math.round(worldCenterY - boundsHeight / 2);
      if (
        left >= targetWidth ||
        top >= targetHeight ||
        left + boundsWidth <= 0 ||
        top + boundsHeight <= 0
      ) {
        continue;
      }
      placements.push({
        drawWidth,
        drawHeight,
        boundsWidth,
        boundsHeight,
        centerX: left + boundsWidth / 2,
        centerY: top + boundsHeight / 2,
        margin: 0,
      });
      if (placements.length >= maxWatermarkTileCount) {
        return placements;
      }
    }
  }
  return placements;
}

function scaledWatermarkDimensions(
  shortEdge: number,
  watermarkWidth: number,
  watermarkHeight: number,
  sizePercent: number,
  sizeBasis: WatermarkSizeBasis,
): [number, number] {
  const desired = Math.max(1, Math.round(shortEdge * sizePercent * 0.01));
  if (sizeBasis === "height") {
    return [Math.max(1, Math.round(desired * (watermarkWidth / watermarkHeight))), desired];
  }
  return [desired, Math.max(1, Math.round(desired * (watermarkHeight / watermarkWidth)))];
}

export function createWatermarkProgress(): WatermarkProgress {
  return {
    running: false,
    cancelling: false,
    totalCount: 0,
    processedCount: 0,
    exportedCount: 0,
    skippedExistingCount: 0,
    failedCount: 0,
    cancelledRemainingCount: 0,
  };
}

export function reduceWatermarkProgress(
  progress: WatermarkProgress,
  event: WatermarkExportEvent,
): WatermarkProgress {
  if (event.type === "started") {
    return { ...createWatermarkProgress(), running: true, totalCount: event.totalCount };
  }
  if (event.type === "itemFinished") {
    return {
      ...progress,
      running: true,
      totalCount: event.totalCount,
      processedCount: Math.max(progress.processedCount, event.index),
      exportedCount: progress.exportedCount + (event.status === "exported" ? 1 : 0),
      skippedExistingCount:
        progress.skippedExistingCount + (event.status === "skipped" ? 1 : 0),
      failedCount: progress.failedCount + (event.status === "failed" ? 1 : 0),
    };
  }
  if (event.type === "cancelled") {
    return {
      ...progress,
      running: false,
      cancelling: false,
      processedCount: event.processedCount,
      cancelledRemainingCount: event.remainingCount,
    };
  }
  return progress;
}

export function markWatermarkCancelling(progress: WatermarkProgress): WatermarkProgress {
  return progress.running ? { ...progress, cancelling: true } : progress;
}

export function glassAlphaFactor(clarity: number) {
  return 1 - clamp(clarity, 0, 1) * 0.65;
}

export function completeWatermarkProgress(
  progress: WatermarkProgress,
  summary: Pick<
    WatermarkProgress,
    | "totalCount"
    | "processedCount"
    | "exportedCount"
    | "skippedExistingCount"
    | "failedCount"
    | "cancelledRemainingCount"
  >,
): WatermarkProgress {
  return { ...progress, ...summary, running: false, cancelling: false };
}

export function thumbnailWindow(total: number, selectedIndex: number, limit = 15) {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeSelected = clamp(Math.floor(selectedIndex), 0, Math.max(0, safeTotal - 1));
  const start = clamp(
    safeSelected - Math.floor(safeLimit / 2),
    0,
    Math.max(0, safeTotal - safeLimit),
  );
  return { start, end: Math.min(safeTotal, start + safeLimit) };
}

function sanitizeProfile(
  value: unknown,
  fallback: WatermarkProfile = createDefaultProfile(),
): WatermarkProfile {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  return {
    layout:
      typeof value.layout === "string" && validLayouts.has(value.layout as WatermarkLayout)
        ? (value.layout as WatermarkLayout)
        : fallback.layout,
    anchor:
      typeof value.anchor === "string" && validAnchors.has(value.anchor as WatermarkAnchor)
        ? (value.anchor as WatermarkAnchor)
        : fallback.anchor,
    clarity: sanitizeNumber(value.clarity ?? value.opacity, fallback.clarity, 0, 1),
    sizePercent: sanitizeNumber(value.sizePercent, fallback.sizePercent, 1, 100),
    rotationDegrees: sanitizeNumber(value.rotationDegrees, fallback.rotationDegrees, -180, 180),
    offsetXPercent: sanitizeNumber(value.offsetXPercent, fallback.offsetXPercent, -50, 50),
    offsetYPercent: sanitizeNumber(value.offsetYPercent, fallback.offsetYPercent, -50, 50),
    tileSpacingPercent: sanitizeNumber(
      value.tileSpacingPercent,
      fallback.tileSpacingPercent,
      1,
      50,
    ),
  };
}

function sanitizeNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, minimum, maximum)
    : fallback;
}

function anchorOrigin(
  anchor: WatermarkAnchor,
  left: number,
  top: number,
  centerX: number,
  centerY: number,
  right: number,
  bottom: number,
): [number, number] {
  switch (anchor) {
    case "topLeft":
      return [left, top];
    case "topCenter":
      return [centerX, top];
    case "topRight":
      return [right, top];
    case "centerLeft":
      return [left, centerY];
    case "center":
      return [centerX, centerY];
    case "centerRight":
      return [right, centerY];
    case "bottomLeft":
      return [left, bottom];
    case "bottomCenter":
      return [centerX, bottom];
    case "bottomRight":
      return [right, bottom];
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
