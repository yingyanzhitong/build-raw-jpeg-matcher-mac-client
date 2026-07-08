export type MatchStatus = "matched" | "missing" | "conflict" | "confirmed";

export interface JpegInput {
  path: string;
  fileName: string;
  baseName: string;
  size: number;
  modifiedTime: number | null;
  manual?: boolean;
}

export interface RawCandidate {
  path: string;
  fileName: string;
  baseName: string;
  extension: string;
  size: number;
  modifiedTime: number | null;
}

export interface MatchResult {
  jpeg: JpegInput;
  status: MatchStatus;
  candidates: RawCandidate[];
  selectedRaw: RawCandidate | null;
}

export interface InputCollection {
  files: JpegInput[];
  logs: string[];
  skippedCount: number;
  duplicateCount: number;
}

export interface MatchSummary {
  inputCount: number;
  matchedCount: number;
  missingCount: number;
  conflictCount: number;
  confirmedCount: number;
}

export interface MatchResponse {
  jpegInputs: JpegInput[];
  results: MatchResult[];
  logs: string[];
  summary: MatchSummary;
}

export interface ExportSummary {
  copiedCount: number;
  skippedMissingCount: number;
  skippedConflictCount: number;
  collisionCount: number;
}

export interface ExportResponse {
  logs: string[];
  summary: ExportSummary;
}

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
