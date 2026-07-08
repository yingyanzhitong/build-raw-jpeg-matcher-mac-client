export type WatermarkMode = "text" | "image";
export type WatermarkLayout = "single" | "tile";

export interface WatermarkImageInput {
  path: string;
  fileName: string;
  relativePath: string;
  size: number;
  modifiedTime: number | null;
}

export interface WatermarkScanResponse {
  rootDir: string;
  images: WatermarkImageInput[];
  logs: string[];
  skippedCount: number;
  duplicateCount: number;
}

export interface WatermarkConfig {
  opacity: number;
  sizePercent: number;
  autoRemoveBackground: boolean;
  backgroundTolerance: number;
  edgeFeather: number;
  shadowStrength: number;
  layout: WatermarkLayout;
}

export interface WatermarkTextSource {
  type: "text";
  text: string;
}

export interface WatermarkImageFileSource {
  type: "imageFile";
  path: string;
}

export type WatermarkSource = WatermarkTextSource | WatermarkImageFileSource;

export interface WatermarkExportSummary {
  exportedCount: number;
  skippedCount: number;
  failedCount: number;
  collisionCount: number;
}

export interface WatermarkExportResponse {
  logs: string[];
  summary: WatermarkExportSummary;
}
