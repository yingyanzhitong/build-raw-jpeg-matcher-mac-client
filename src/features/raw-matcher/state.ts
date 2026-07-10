import type { LogEntry } from "../shared/ui";
import type {
  DirectionTransition,
  ExportSummary,
  MatchDirection,
  MatchFile,
  MatcherBusy,
  MatchResult,
} from "./types";

export interface ExportReport {
  directory: string;
  summary: ExportSummary;
}

export interface DirectionWorkspaceState {
  inputs: MatchFile[];
  manualRefs: string[];
  searchDirectory: string;
  selectedRawFormats: string[];
  results: MatchResult[];
  logs: LogEntry[];
  exportDirectory: string;
  exportReport: ExportReport | null;
  busy: MatcherBusy;
}

export type DirectionWorkspaceStates = Record<MatchDirection, DirectionWorkspaceState>;

export function canSwitchDirection(state: DirectionWorkspaceState) {
  return state.busy === null;
}

/**
 * 判断当前方向是否已具备一次匹配所需的本地状态。
 *
 * 运行时能力加载和方向切换动画由工作区负责；这里保留为纯函数，
 * 便于所有输入入口使用同一份“就绪即查找”判断。
 */
export function isDirectionReadyForMatch(state: DirectionWorkspaceState) {
  return (
    state.busy === null &&
    state.inputs.length > 0 &&
    state.searchDirectory.trim().length > 0 &&
    state.selectedRawFormats.length > 0
  );
}

export function canStartDirectionTransition(
  state: DirectionWorkspaceState,
  transition: DirectionTransition | null,
) {
  return transition === null && canSwitchDirection(state);
}

export function createDirectionWorkspaceState(
  direction: MatchDirection,
  supportedRawFormats: string[],
): DirectionWorkspaceState {
  return {
    inputs: [],
    manualRefs: [],
    searchDirectory: "",
    selectedRawFormats: [...supportedRawFormats],
    results: [],
    logs: [
      {
        level: "info",
        message:
          direction === "imageToRaw"
            ? "等待拖入 JPG、JPEG、PNG 文件、目录或粘贴清单"
            : "等待拖入 RAW 文件、目录或粘贴清单",
      },
    ],
    exportDirectory: "",
    exportReport: null,
    busy: null,
  };
}

export function createDirectionWorkspaceStates(
  supportedRawFormats: string[],
): DirectionWorkspaceStates {
  return {
    imageToRaw: createDirectionWorkspaceState("imageToRaw", supportedRawFormats),
    rawToImage: createDirectionWorkspaceState("rawToImage", supportedRawFormats),
  };
}

export function invalidateMatchState(
  state: DirectionWorkspaceState,
): DirectionWorkspaceState {
  if (state.results.length === 0 && state.exportReport === null) {
    return state;
  }

  return {
    ...state,
    results: [],
    exportReport: null,
  };
}

export function updateDirectionWorkspaceState(
  states: DirectionWorkspaceStates,
  direction: MatchDirection,
  update:
    | Partial<DirectionWorkspaceState>
    | ((state: DirectionWorkspaceState) => DirectionWorkspaceState),
): DirectionWorkspaceStates {
  const current = states[direction];
  const next = typeof update === "function" ? update(current) : { ...current, ...update };

  if (next === current) {
    return states;
  }

  return { ...states, [direction]: next };
}

export function clearDirectionWorkspaceState(
  states: DirectionWorkspaceStates,
  direction: MatchDirection,
  supportedRawFormats: string[],
): DirectionWorkspaceStates {
  const cleared = createDirectionWorkspaceState(direction, supportedRawFormats);
  return {
    ...states,
    [direction]: {
      ...cleared,
      logs: [{ level: "info", message: "已清空当前方向任务" }],
    },
  };
}
