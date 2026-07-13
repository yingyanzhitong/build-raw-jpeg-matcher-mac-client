export type SeparatedFileKind = "image" | "raw";
export type SeparatorExportMode = "copy" | "moveInPlace";

export interface SeparatedFile {
  path: string;
  fileName: string;
  relativePath: string;
  extension: string;
  size: number;
  modifiedTime: number | null;
  kind: SeparatedFileKind;
}

export interface SeparatorScanResponse {
  rootDir: string;
  images: SeparatedFile[];
  raws: SeparatedFile[];
  logs: string[];
  skippedCount: number;
}

export interface SeparatorExportSummary {
  copiedCount: number;
  copiedImageCount: number;
  copiedRawCount: number;
  movedCount: number;
  movedImageCount: number;
  movedRawCount: number;
  alreadyPresentCount: number;
  collisionCount: number;
  failedCount: number;
}

export interface SeparatorExportResponse {
  logs: string[];
  summary: SeparatorExportSummary;
}
