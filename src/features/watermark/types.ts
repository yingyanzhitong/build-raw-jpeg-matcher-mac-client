export type AspectKind = "landscape" | "portrait" | "square";

export type WatermarkLayout = "single" | "tile";
export type WatermarkSourceKind = "image" | "text";
export type WatermarkSizeBasis = "width" | "height";

export type WatermarkAnchor =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "centerLeft"
  | "center"
  | "centerRight"
  | "bottomLeft"
  | "bottomCenter"
  | "bottomRight";

export interface WatermarkProfile {
  layout: WatermarkLayout;
  anchor: WatermarkAnchor;
  clarity: number;
  sizePercent: number;
  rotationDegrees: number;
  offsetXPercent: number;
  offsetYPercent: number;
  tileSpacingPercent: number;
}

export type WatermarkProfiles = Record<AspectKind, WatermarkProfile>;
export type WatermarkProfilesBySource = Record<WatermarkSourceKind, WatermarkProfiles>;

export interface WatermarkImageInput {
  path: string;
  fileName: string;
  relativePath: string;
  width: number;
  height: number;
  aspect: AspectKind;
  size: number;
  modifiedTime: number | null;
}

export interface WatermarkScanResponse {
  rootDir: string;
  images: WatermarkImageInput[];
  skippedCount: number;
  logs: string[];
}

export interface WatermarkAssetInfo {
  path: string;
  fileName: string;
  sourceKind: WatermarkSourceKind;
  sizeBasis: WatermarkSizeBasis;
  width: number;
  height: number;
  hasTransparency: boolean;
  sourceHasTransparency: boolean;
  glassProcessed: boolean;
  previewPath: string;
}

export interface WatermarkFontInfo {
  id: string;
  displayName: string;
  familyName: string;
}

export interface WatermarkFontCatalog {
  fonts: WatermarkFontInfo[];
  defaultFontId: string;
}

export interface TextWatermarkRequest {
  text: string;
  fontId: string;
}

export type WatermarkSource =
  | { type: "image"; path: string }
  | { type: "text"; text: string; fontId: string };

export interface WatermarkPreviewAsset {
  path: string;
  width: number;
  height: number;
  previewPath: string;
}

export interface WatermarkExportRequest {
  jobId: string;
  inputRoot: string;
  exportDir: string;
  jpegQuality: number;
  source: WatermarkSource;
  imagePaths: string[];
  profiles: WatermarkProfiles;
}

export type WatermarkItemStatus = "exported" | "skipped" | "failed";

export type WatermarkExportEvent =
  | { type: "started"; jobId: string; totalCount: number }
  | {
      type: "itemFinished";
      jobId: string;
      index: number;
      totalCount: number;
      relativePath: string;
      status: WatermarkItemStatus;
      message: string;
    }
  | {
      type: "warning";
      jobId: string;
      relativePath: string;
      message: string;
    }
  | {
      type: "cancelled";
      jobId: string;
      processedCount: number;
      remainingCount: number;
    };

export interface WatermarkExportSummary {
  totalCount: number;
  processedCount: number;
  exportedCount: number;
  skippedExistingCount: number;
  failedCount: number;
  cancelledRemainingCount: number;
}

export interface WatermarkSettingsSnapshot {
  sourceKind: WatermarkSourceKind;
  watermarkPath: string;
  text: string;
  fontId: string;
  jpegQuality: number;
  profilesBySource: WatermarkProfilesBySource;
}

export interface WatermarkGeometry {
  drawWidth: number;
  drawHeight: number;
  boundsWidth: number;
  boundsHeight: number;
  centerX: number;
  centerY: number;
  margin: number;
}

export interface WatermarkProgress {
  running: boolean;
  cancelling: boolean;
  totalCount: number;
  processedCount: number;
  exportedCount: number;
  skippedExistingCount: number;
  failedCount: number;
  cancelledRemainingCount: number;
}
