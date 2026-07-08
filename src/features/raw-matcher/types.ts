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
