export type MatchDirection = "imageToRaw" | "rawToImage";

export type DirectionTransitionPhase = "exiting" | "entering";

export interface DirectionTransition {
  from: MatchDirection;
  to: MatchDirection;
  phase: DirectionTransitionPhase;
  sequence: number;
}

export type MatchStatus = "matched" | "missing" | "conflict" | "confirmed";

export type MatcherBusy = "collect" | "match" | "export" | null;

export interface MatcherCapabilities {
  imageExtensions: string[];
  rawExtensions: string[];
}

export interface MatchFile {
  path: string;
  fileName: string;
  baseName: string;
  extension: string;
  size: number;
  modifiedTime: number | null;
  manual: boolean;
}

export interface MatchResult {
  input: MatchFile;
  status: MatchStatus;
  candidates: MatchFile[];
  selectedCandidate: MatchFile | null;
}

export interface InputCollection {
  files: MatchFile[];
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
  inputs: MatchFile[];
  results: MatchResult[];
  logs: string[];
  summary: MatchSummary;
}

export interface ExportSummary {
  copiedCount: number;
  alreadyPresentCount: number;
  skippedMissingCount: number;
  skippedConflictCount: number;
  collisionCount: number;
  sourceErrorCount: number;
}

export interface ExportResponse {
  logs: string[];
  summary: ExportSummary;
}
