import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  exportFailureFeedback,
  matcherExportFeedback,
  type ExportFeedback,
} from "@/features/shared/exportFeedback";
import { cn } from "@/lib/utils";
import {
  canStartDirectionTransition,
  clearDirectionWorkspaceState,
  createDirectionWorkspaceStates,
  invalidateMatchState,
  isDirectionReadyForMatch,
  updateDirectionWorkspaceState,
  type DirectionWorkspaceState,
  type DirectionWorkspaceStates,
  type ExportReport,
} from "./state";
import type {
  DirectionTransition,
  ExportResponse,
  InputCollection,
  MatchDirection,
  MatchFile,
  MatcherBusy,
  MatcherCapabilities,
  MatchResponse,
  MatchResult,
  MatchStatus,
} from "./types";
import {
  formatBytes,
  formatTime,
  inferLogLevel,
  StatTile,
  type LogEntry,
  type LogLevel,
} from "../shared/ui";
import { FilePreview, RawJpegMatcherView } from "./RawJpegMatcherView";

const defaultCapabilities: MatcherCapabilities = {
  imageExtensions: ["jpg", "jpeg", "png"],
  rawExtensions: [
    "cr2",
    "cr3",
    "nef",
    "arw",
    "raf",
    "orf",
    "rw2",
    "dng",
    "rwl",
    "pef",
    "3fr",
    "iiq",
  ],
};

const defaultRawFormats = defaultCapabilities.rawExtensions.map((extension) =>
  extension.toUpperCase(),
);

const directionExitDuration = 120;
const directionEnterDuration = 200;

export interface RawWorkspaceStatus {
  direction: MatchDirection;
  inputCount: number;
  searchDirectory: string;
  counts: Record<MatchStatus, number>;
  exportableCount: number;
  busy: MatcherBusy;
  statusText: string;
  logs: LogEntry[];
  /** @deprecated Use inputCount. Retained while App migrates to direction-neutral labels. */
  jpegCount: number;
  /** @deprecated Use searchDirectory. */
  rawDirectory: string;
}

export const defaultRawWorkspaceStatus: RawWorkspaceStatus = {
  direction: "imageToRaw",
  inputCount: 0,
  searchDirectory: "",
  counts: { matched: 0, missing: 0, conflict: 0, confirmed: 0 },
  exportableCount: 0,
  busy: null,
  statusText: "READY",
  logs: createDirectionWorkspaceStates(defaultRawFormats).imageToRaw.logs,
  jpegCount: 0,
  rawDirectory: "",
};

export function RawMatcherWorkspace({
  active,
  logPanelOpen,
  onExportFeedback,
  onToggleLogPanel,
  onStatusChange,
}: {
  active: boolean;
  logPanelOpen: boolean;
  onExportFeedback: (feedback: ExportFeedback) => void;
  onToggleLogPanel: () => void;
  onStatusChange: (status: RawWorkspaceStatus) => void;
}) {
  const [activeDirection, setActiveDirection] = useState<MatchDirection>("imageToRaw");
  const [capabilities, setCapabilities] =
    useState<MatcherCapabilities>(defaultCapabilities);
  const [capabilitiesReady, setCapabilitiesReady] = useState(() => !isTauriRuntime());
  const [directionStates, setDirectionStates] = useState<DirectionWorkspaceStates>(() =>
    createDirectionWorkspaceStates(defaultRawFormats),
  );
  const [manualText, setManualText] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [activeConflictIndex, setActiveConflictIndex] = useState<number | null>(null);
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [directionAnnouncement, setDirectionAnnouncement] = useState("");
  const [directionTransition, setDirectionTransition] =
    useState<DirectionTransition | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const activeRef = useRef(active);
  const capabilitiesReadyRef = useRef(capabilitiesReady);
  const activeDirectionRef = useRef(activeDirection);
  const directionStatesRef = useRef(directionStates);
  const directionTransitionRef = useRef<DirectionTransition | null>(null);
  const directionTransitionSequenceRef = useRef(0);
  const directionTransitionTimersRef = useRef<number[]>([]);
  const collectInputsRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  const operationRef = useRef<Record<MatchDirection, MatcherBusy>>({
    imageToRaw: null,
    rawToImage: null,
  });

  activeRef.current = active;
  capabilitiesReadyRef.current = capabilitiesReady;
  activeDirectionRef.current = activeDirection;
  directionStatesRef.current = directionStates;
  directionTransitionRef.current = directionTransition;

  const state = directionStates[activeDirection];
  const interactionsLocked = directionTransition !== null;
  const supportedRawFormats = useMemo(
    () => capabilities.rawExtensions.map((extension) => extension.toUpperCase()),
    [capabilities.rawExtensions],
  );
  const counts = useMemo(
    () =>
      state.results.reduce(
        (accumulator, result) => {
          accumulator[result.status] += 1;
          return accumulator;
        },
        { matched: 0, missing: 0, conflict: 0, confirmed: 0 } as Record<
          MatchStatus,
          number
        >,
      ),
    [state.results],
  );
  const exportableCount = counts.matched + counts.confirmed;
  const canMatch =
    !interactionsLocked &&
    capabilitiesReady &&
    isDirectionReadyForMatch(state);
  const canExport =
    !interactionsLocked &&
    capabilitiesReady &&
    state.searchDirectory.length > 0 &&
    exportableCount > 0 &&
    state.busy === null;
  const activeConflict =
    activeConflictIndex === null ? null : state.results[activeConflictIndex] ?? null;

  function replaceStates(next: DirectionWorkspaceStates) {
    directionStatesRef.current = next;
    setDirectionStates(() => next);
  }

  function updateDirectionState(
    direction: MatchDirection,
    update:
      | Partial<DirectionWorkspaceState>
      | ((current: DirectionWorkspaceState) => DirectionWorkspaceState),
  ) {
    replaceStates(updateDirectionWorkspaceState(directionStatesRef.current, direction, update));
  }

  function appendLogs(direction: MatchDirection, messages: string[], level?: LogLevel) {
    if (messages.length === 0) {
      return;
    }

    const entries = messages.map((message) => ({
      level: level ?? inferLogLevel(message),
      message,
    }));
    updateDirectionState(direction, (current) => ({
      ...current,
      logs: [...current.logs, ...entries].slice(-300),
    }));
  }

  function setDirectionBusy(direction: MatchDirection, busy: MatcherBusy) {
    operationRef.current[direction] = busy;
    updateDirectionState(direction, { busy });
  }

  function clearDirectionTransitionTimers() {
    for (const timer of directionTransitionTimersRef.current) {
      window.clearTimeout(timer);
    }
    directionTransitionTimersRef.current = [];
  }

  function focusDirectionToggle() {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-direction-toggle]")?.focus();
    });
  }

  function resetDirectionOverlays() {
    setActiveConflictIndex(null);
    setDragActive(false);
    setManualDialogOpen(false);
    setClearDialogOpen(false);
    setManualText("");
  }

  function activateDirection(direction: MatchDirection) {
    activeDirectionRef.current = direction;
    setActiveDirection(direction);
    setDirectionAnnouncement(`已切换配对方向：${directionLabel(direction)}`);
    resetDirectionOverlays();
  }

  useEffect(
    () => () => {
      clearDirectionTransitionTimers();
    },
    [],
  );

  useEffect(() => {
    onStatusChange({
      direction: activeDirection,
      inputCount: state.inputs.length,
      searchDirectory: state.searchDirectory,
      counts,
      exportableCount,
      busy: state.busy,
      statusText: state.busy ? busyLabel(state.busy) : "READY",
      logs: state.logs,
      jpegCount: state.inputs.length,
      rawDirectory: state.searchDirectory,
    });
  }, [
    activeDirection,
    counts,
    exportableCount,
    onStatusChange,
    state.busy,
    state.inputs.length,
    state.logs,
    state.searchDirectory,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    void invoke<MatcherCapabilities>("matcher_capabilities")
      .then((response) => {
        const nextCapabilities = normalizeCapabilities(response);
        const previousSupported = new Set(
          defaultCapabilities.rawExtensions.map((extension) => extension.toUpperCase()),
        );
        const nextSupported = nextCapabilities.rawExtensions.map((extension) =>
          extension.toUpperCase(),
        );
        setCapabilities(nextCapabilities);

        let nextStates = directionStatesRef.current;
        for (const direction of ["imageToRaw", "rawToImage"] as const) {
          nextStates = updateDirectionWorkspaceState(nextStates, direction, (current) => {
            const hadAllFormats =
              current.selectedRawFormats.length === previousSupported.size &&
              current.selectedRawFormats.every((format) => previousSupported.has(format));
            const selectedRawFormats = hadAllFormats
              ? nextSupported
              : nextSupported.filter((format) => current.selectedRawFormats.includes(format));
            const inputs =
              direction === "rawToImage"
                ? current.inputs.filter((file) =>
                    nextSupported.includes(file.extension.toUpperCase()),
                  )
                : current.inputs;
            return invalidateMatchState({
              ...current,
              inputs,
              selectedRawFormats,
            });
          });
        }
        replaceStates(nextStates);
        capabilitiesReadyRef.current = true;
        setCapabilitiesReady(true);
      })
      .catch((error) => {
        appendLogs(
          activeDirectionRef.current,
          [`读取格式能力失败，已使用内置格式列表: ${String(error)}`],
          "warning",
        );
        capabilitiesReadyRef.current = true;
        setCapabilitiesReady(true);
      });
  }, []);

  async function collectInputs(
    paths: string[],
    direction: MatchDirection = activeDirectionRef.current,
  ) {
    const current = directionStatesRef.current[direction];
    if (directionTransitionRef.current !== null) {
      return;
    }
    if (!capabilitiesReadyRef.current) {
      appendLogs(direction, ["正在读取支持格式，请稍候再添加输入"], "warning");
      return;
    }
    if (paths.length === 0 || operationRef.current[direction] !== null) {
      return;
    }

    const physicalPaths = current.inputs
      .filter((file) => !file.manual && file.path.length > 0)
      .map((file) => file.path);
    let inputsChanged = false;
    setDirectionBusy(direction, "collect");

    try {
      const collection = await invoke<InputCollection>("collect_match_inputs", {
        direction,
        paths: [...physicalPaths, ...paths],
        selectedRawFormats: current.selectedRawFormats,
      });
      updateDirectionState(direction, (latest) => {
        const manualInputs = latest.inputs.filter((file) => file.manual);
        const inputs = [...collection.files, ...manualInputs];
        inputsChanged = !sameInputs(latest.inputs, inputs);
        const next = sameInputs(latest.inputs, inputs)
          ? { ...latest, inputs }
          : invalidateMatchState({ ...latest, inputs });
        return {
          ...next,
          logs: appendLogEntries(next.logs, collection.logs),
        };
      });
      setActiveConflictIndex(null);
    } catch (error) {
      appendLogs(
        direction,
        [`读取${inputRole(direction)}输入失败: ${String(error)}`],
        "error",
      );
    } finally {
      setDirectionBusy(direction, null);
      if (inputsChanged) {
        void autoMatchWhenReady(direction);
      }
    }
  }

  collectInputsRef.current = collectInputs;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    if (!isTauriRuntime()) {
      return;
    }

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!activeRef.current) {
          return;
        }

        if (directionTransitionRef.current !== null) {
          setDragActive(false);
          return;
        }

        const { payload } = event;
        if (payload.type === "over") {
          setDragActive(true);
          return;
        }

        setDragActive(false);
        if (payload.type === "drop") {
          void collectInputsRef.current(payload.paths);
        }
      })
      .then((handler) => {
        if (disposed) {
          handler();
          return;
        }
        unlisten = handler;
      })
      .catch((error) => {
        appendLogs(
          activeDirectionRef.current,
          [`拖放监听启动失败: ${String(error)}`],
          "error",
        );
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function chooseInputFiles() {
    const direction = activeDirectionRef.current;
    const current = directionStatesRef.current[direction];
    if (
      directionTransitionRef.current !== null ||
      !capabilitiesReadyRef.current ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    const extensions =
      direction === "imageToRaw"
        ? capabilities.imageExtensions
        : current.selectedRawFormats.map((format) => format.toLowerCase());
    const selected = await open({
      directory: false,
      multiple: true,
      filters:
        extensions.length > 0
          ? [{ name: inputRole(direction), extensions }]
          : undefined,
    });
    const paths = normalizeDialogSelection(selected);
    if (paths.length > 0) {
      await collectInputs(paths, direction);
    }
  }

  async function chooseInputDirectories() {
    const direction = activeDirectionRef.current;
    if (
      directionTransitionRef.current !== null ||
      !capabilitiesReadyRef.current ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    const selected = await open({ directory: true, multiple: true });
    const paths = normalizeDialogSelection(selected);
    if (paths.length > 0) {
      await collectInputs(paths, direction);
    }
  }

  async function chooseSearchDirectory() {
    const direction = activeDirectionRef.current;
    if (
      directionTransitionRef.current !== null ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") {
      return;
    }

    if (directionStatesRef.current[direction].searchDirectory === selected) {
      return;
    }

    updateDirectionState(direction, (current) => {
      const next = invalidateMatchState({ ...current, searchDirectory: selected });
      return {
        ...next,
        logs: appendLogEntries(next.logs, [
          `已选择${candidateRole(direction)}查找目录: ${selected}`,
        ]),
      };
    });
    setActiveConflictIndex(null);
    void autoMatchWhenReady(direction);
  }

  async function autoMatchWhenReady(direction: MatchDirection) {
    if (
      directionTransitionRef.current !== null ||
      !capabilitiesReadyRef.current ||
      !isDirectionReadyForMatch(directionStatesRef.current[direction])
    ) {
      return;
    }

    appendLogs(direction, [
      `${inputRole(direction)}输入与${candidateRole(direction)}查找目录已就绪，自动开始查找对应${candidateRole(direction)}`,
    ]);
    await matchFiles(direction);
  }

  async function matchFiles(direction: MatchDirection = activeDirectionRef.current) {
    const current = directionStatesRef.current[direction];
    if (
      directionTransitionRef.current !== null ||
      operationRef.current[direction] !== null
    ) {
      return;
    }
    if (!capabilitiesReadyRef.current) {
      appendLogs(direction, ["正在读取支持格式，请稍候再查找"], "warning");
      return;
    }
    const missingItems = [
      current.inputs.length === 0 ? `${inputRole(direction)}输入` : "",
      current.searchDirectory.length === 0
        ? `${candidateRole(direction)}查找目录`
        : "",
      current.selectedRawFormats.length === 0 ? "RAW 格式" : "",
    ].filter(Boolean);
    if (missingItems.length > 0) {
      appendLogs(
        direction,
        [`无法查找：缺少 ${missingItems.join("、")}`],
        "warning",
      );
      return;
    }

    setDirectionBusy(direction, "match");
    try {
      const response = await invoke<MatchResponse>("match_counterpart_files", {
        direction,
        inputs: current.inputs.filter((file) => !file.manual),
        manualRefs: current.manualRefs,
        searchRoot: current.searchDirectory,
        selectedRawFormats: current.selectedRawFormats,
      });
      updateDirectionState(direction, (latest) => ({
        ...latest,
        inputs: response.inputs,
        results: response.results,
        exportReport: null,
        logs: appendLogEntries(latest.logs, response.logs),
      }));
      setActiveConflictIndex(null);
    } catch (error) {
      appendLogs(
        direction,
        [`查找对应${candidateRole(direction)}失败: ${String(error)}`],
        "error",
      );
    } finally {
      setDirectionBusy(direction, null);
    }
  }

  async function exportFiles() {
    const direction = activeDirectionRef.current;
    const current = directionStatesRef.current[direction];
    const currentExportable = current.results.some(
      (result) => result.status === "matched" || result.status === "confirmed",
    );
    if (
      directionTransitionRef.current !== null ||
      operationRef.current[direction] !== null
    ) {
      return;
    }
    if (
      !capabilitiesReadyRef.current ||
      current.searchDirectory.length === 0 ||
      !currentExportable
    ) {
      appendLogs(
        direction,
        [
          !capabilitiesReadyRef.current
            ? "正在读取支持格式，请稍候再导出"
            : current.searchDirectory.length === 0
              ? `无法导出：缺少 ${candidateRole(direction)}查找目录`
              : `缺少可导出的${candidateRole(direction)}文件，无法导出`,
        ],
        "warning",
      );
      return;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: `选择${candidateRole(direction)}导出目录`,
    });
    if (typeof selected !== "string") {
      return;
    }

    updateDirectionState(direction, { exportDirectory: selected, exportReport: null });
    setDirectionBusy(direction, "export");
    try {
      const response = await invoke<ExportResponse>("export_matched_files", {
        direction,
        results: current.results,
        exportDir: selected,
        searchRoot: current.searchDirectory,
        selectedRawFormats: current.selectedRawFormats,
      });
      updateDirectionState(direction, (latest) => ({
        ...latest,
        logs: appendLogEntries(latest.logs, response.logs),
        exportReport: { directory: selected, summary: response.summary },
      }));
      onExportFeedback(matcherExportFeedback(response.summary));
    } catch (error) {
      appendLogs(
        direction,
        [`导出${candidateRole(direction)}失败: ${String(error)}`],
        "error",
      );
      onExportFeedback(exportFailureFeedback(`导出${candidateRole(direction)}`, error));
    } finally {
      setDirectionBusy(direction, null);
    }
  }

  async function openOriginal(path: string) {
    if (!path || path.startsWith("manual:")) {
      return;
    }

    const direction = activeDirectionRef.current;
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      appendLogs(direction, [`打开原始文件失败: ${String(error)}`], "error");
    }
  }

  function toggleDirection() {
    const direction = activeDirectionRef.current;
    if (
      !canStartDirectionTransition(
        directionStatesRef.current[direction],
        directionTransitionRef.current,
      ) ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    const nextDirection: MatchDirection =
      direction === "imageToRaw" ? "rawToImage" : "imageToRaw";
    resetDirectionOverlays();

    if (prefersReducedMotion) {
      activateDirection(nextDirection);
      focusDirectionToggle();
      return;
    }

    clearDirectionTransitionTimers();
    const exiting: DirectionTransition = {
      from: direction,
      to: nextDirection,
      phase: "exiting",
      sequence: directionTransitionSequenceRef.current + 1,
    };
    directionTransitionSequenceRef.current = exiting.sequence;
    directionTransitionRef.current = exiting;
    setDirectionTransition(exiting);

    const exitTimer = window.setTimeout(() => {
      if (directionTransitionRef.current?.sequence !== exiting.sequence) {
        return;
      }

      const entering: DirectionTransition = { ...exiting, phase: "entering" };
      directionTransitionRef.current = entering;
      activateDirection(nextDirection);
      setDirectionTransition(entering);

      const enterTimer = window.setTimeout(() => {
        if (directionTransitionRef.current?.sequence !== entering.sequence) {
          return;
        }

        directionTransitionTimersRef.current = [];
        directionTransitionRef.current = null;
        setDirectionTransition(null);
        focusDirectionToggle();
      }, directionEnterDuration);
      directionTransitionTimersRef.current.push(enterTimer);
    }, directionExitDuration);
    directionTransitionTimersRef.current.push(exitTimer);
  }

  function confirmCandidate(resultIndex: number, candidate: MatchFile) {
    if (directionTransitionRef.current !== null) {
      return;
    }
    const direction = activeDirectionRef.current;
    const result = directionStatesRef.current[direction].results[resultIndex];
    if (!result || !result.candidates.some((item) => item.path === candidate.path)) {
      return;
    }

    updateDirectionState(direction, (current) => ({
      ...current,
      results: current.results.map((item, index) =>
        index === resultIndex
          ? { ...item, status: "confirmed", selectedCandidate: candidate }
          : item,
      ),
      exportReport: null,
      logs: appendLogEntries(current.logs, [
        `已确认冲突: ${result.input.fileName} -> ${candidate.fileName}`,
      ]),
    }));
    setActiveConflictIndex(null);
  }

  function clearCurrentDirection() {
    const direction = activeDirectionRef.current;
    if (
      directionTransitionRef.current !== null ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    replaceStates(
      clearDirectionWorkspaceState(
        directionStatesRef.current,
        direction,
        supportedRawFormats,
      ),
    );
    setManualText("");
    setActiveConflictIndex(null);
  }

  function addManualInputs() {
    const direction = activeDirectionRef.current;
    if (directionTransitionRef.current !== null) {
      return;
    }

    const references = parseManualReferences(manualText);
    if (references.length === 0) {
      appendLogs(direction, ["文本清单为空，未加入输入"], "warning");
      return;
    }

    const current = directionStatesRef.current[direction];
    const existingKeys = new Set(current.manualRefs.map(normalizeManualReference));
    const nextReferences: string[] = [];
    const nextManualInputs: MatchFile[] = [];
    let disabledRawFormatCount = 0;

    for (const reference of references) {
      const baseName = normalizeManualReference(reference);
      if (!baseName || existingKeys.has(baseName)) {
        continue;
      }
      const extension = manualReferenceExtension(reference);
      if (
        direction === "rawToImage" &&
        extension.length > 0 &&
        !current.selectedRawFormats.includes(extension.toUpperCase())
      ) {
        disabledRawFormatCount += 1;
        continue;
      }
      existingKeys.add(baseName);
      nextReferences.push(reference);
      nextManualInputs.push(createManualInput(reference, baseName));
    }

    if (nextManualInputs.length === 0) {
      appendLogs(
        direction,
        [
          disabledRawFormatCount > 0
            ? `文本清单未加入新条目：${disabledRawFormatCount} 条 RAW 格式未启用或不受支持`
            : "文本清单未加入新条目，可能全部重复",
        ],
        "warning",
      );
      return;
    }

    updateDirectionState(direction, (latest) => {
      const next = invalidateMatchState({
        ...latest,
        inputs: [...latest.inputs, ...nextManualInputs],
        manualRefs: [...latest.manualRefs, ...nextReferences],
      });
      return {
        ...next,
        logs: appendLogEntries(next.logs, [
          `已加入${inputRole(direction)}文本清单: ${nextManualInputs.length} 条`,
          ...(disabledRawFormatCount > 0
            ? [`跳过 ${disabledRawFormatCount} 条未启用或不支持的 RAW 文本清单项`]
            : []),
        ]),
      };
    });
    setActiveConflictIndex(null);
    setManualText("");
    setManualDialogOpen(false);
    void autoMatchWhenReady(direction);
  }

  function toggleRawFormat(format: string) {
    const direction = activeDirectionRef.current;
    if (
      directionTransitionRef.current !== null ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    const normalized = format.toUpperCase();
    if (!supportedRawFormats.includes(normalized)) {
      return;
    }

    updateDirectionState(direction, (current) => {
      const removing = current.selectedRawFormats.includes(normalized);
      const selectedRawFormats = removing
        ? current.selectedRawFormats.filter((item) => item !== normalized)
        : supportedRawFormats.filter(
            (item) => item === normalized || current.selectedRawFormats.includes(item),
          );
      let inputs = current.inputs;
      let manualRefs = current.manualRefs;
      let removedCount = 0;

      if (direction === "rawToImage" && removing) {
        inputs = current.inputs.filter((file) => {
          const shouldRemove =
            file.extension.toUpperCase() === normalized;
          if (shouldRemove) {
            removedCount += 1;
          }
          return !shouldRemove;
        });
        manualRefs = current.manualRefs.filter(
          (reference) => manualReferenceExtension(reference).toUpperCase() !== normalized,
        );
      }

      const next = invalidateMatchState({
        ...current,
        inputs,
        manualRefs,
        selectedRawFormats,
      });
      return removedCount > 0
        ? {
            ...next,
            logs: appendLogEntries(next.logs, [
              `已取消 ${normalized}，并移除 ${removedCount} 个该格式 RAW 输入；重新启用后需重新选择`,
            ]),
          }
        : next;
    });
    setActiveConflictIndex(null);
  }

  function selectAllRawFormats() {
    const direction = activeDirectionRef.current;
    if (
      directionTransitionRef.current !== null ||
      operationRef.current[direction] !== null
    ) {
      return;
    }

    updateDirectionState(direction, (current) => {
      if (
        current.selectedRawFormats.length === supportedRawFormats.length &&
        supportedRawFormats.every((format) => current.selectedRawFormats.includes(format))
      ) {
        return current;
      }
      return invalidateMatchState({
        ...current,
        selectedRawFormats: [...supportedRawFormats],
      });
    });
    setActiveConflictIndex(null);
  }

  const shortcutsRef = useRef({
    active,
    chooseInputFiles,
    chooseSearchDirectory,
    matchFiles,
    exportFiles,
  });
  shortcutsRef.current = {
    active,
    chooseInputFiles,
    chooseSearchDirectory,
    matchFiles,
    exportFiles,
  };

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const shortcuts = shortcutsRef.current;

      if (isTextEditing || !shortcuts.active) {
        return;
      }

      const usesCommandKey = event.metaKey || event.ctrlKey;
      if (!usesCommandKey || event.defaultPrevented) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "o" && event.shiftKey) {
        event.preventDefault();
        void shortcuts.chooseSearchDirectory();
      } else if (key === "o") {
        event.preventDefault();
        void shortcuts.chooseInputFiles();
      } else if (key === "r") {
        event.preventDefault();
        void shortcuts.matchFiles();
      } else if (key === "e") {
        event.preventDefault();
        void shortcuts.exportFiles();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <RawJpegMatcherView
        active={active}
        direction={activeDirection}
        directionAnnouncement={directionAnnouncement}
        directionTransition={directionTransition}
        interactionsLocked={interactionsLocked}
        logPanelOpen={logPanelOpen}
        capabilitiesReady={capabilitiesReady}
        busy={state.busy}
        canExport={canExport}
        canMatch={canMatch}
        dragActive={dragActive}
        inputs={state.inputs}
        searchDirectory={state.searchDirectory}
        results={state.results}
        supportedRawFormats={supportedRawFormats}
        selectedRawFormats={state.selectedRawFormats}
        onToggleDirection={toggleDirection}
        onToggleLogPanel={onToggleLogPanel}
        onChooseInputDirectories={chooseInputDirectories}
        onChooseInputFiles={chooseInputFiles}
        onChooseSearchDirectory={chooseSearchDirectory}
        onClear={() => {
          if (!directionTransitionRef.current) {
            setClearDialogOpen(true);
          }
        }}
        onExport={exportFiles}
        onMatch={matchFiles}
        onOpenInput={openOriginal}
        onOpenManualDialog={() => {
          if (!directionTransitionRef.current) {
            setManualDialogOpen(true);
          }
        }}
        onOpenPath={openOriginal}
        onResultConflictClick={(index) => {
          if (!directionTransitionRef.current) {
            setActiveConflictIndex(index);
          }
        }}
        onSelectAllRawFormats={selectAllRawFormats}
        onToggleRawFormat={toggleRawFormat}
      />

      {activeConflict && activeConflictIndex !== null ? (
        <ConflictDialog
          direction={activeDirection}
          open
          result={activeConflict}
          resultIndex={activeConflictIndex}
          onOpenChange={(openState) => {
            if (!openState) {
              setActiveConflictIndex(null);
            }
          }}
          onConfirm={confirmCandidate}
          onOpenPath={openOriginal}
        />
      ) : null}

      {state.exportReport ? (
        <ExportCompleteDialog
          direction={activeDirection}
          report={state.exportReport}
          onClose={() => {
            if (!directionTransitionRef.current) {
              updateDirectionState(activeDirectionRef.current, { exportReport: null });
            }
          }}
          onOpenDirectory={openOriginal}
        />
      ) : null}

      <ManualInputDialog
        direction={activeDirection}
        open={manualDialogOpen}
        value={manualText}
        busy={state.busy}
        onValueChange={setManualText}
        onOpenChange={setManualDialogOpen}
        onConfirm={addManualInputs}
      />

      <ClearConfirmDialog
        direction={activeDirection}
        open={clearDialogOpen}
        busy={state.busy}
        onOpenChange={setClearDialogOpen}
        onConfirm={() => {
          clearCurrentDirection();
          setClearDialogOpen(false);
        }}
      />
    </>
  );
}

function ManualInputDialog({
  direction,
  open,
  value,
  busy,
  onValueChange,
  onOpenChange,
  onConfirm,
}: {
  direction: MatchDirection;
  open: boolean;
  value: string;
  busy: MatcherBusy;
  onValueChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const isRawInput = direction === "rawToImage";
  const inputLabel = inputRole(direction);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="accent">文本清单</Badge>
            <DialogTitle>按文本加入{inputLabel}清单</DialogTitle>
          </div>
          <DialogDescription>
            {isRawInput
              ? "每行一条，可以是完整 RAW 文件名、路径或文件名后几位；带扩展名时仅接受当前已启用的 RAW 格式。"
              : "每行一条，可以是完整图片文件名、路径或文件名后几位。"}
          </DialogDescription>
        </DialogHeader>

        <div className="p-4">
          <textarea
            aria-label={`${inputLabel}文本清单`}
            className="min-h-56 w-full resize-y rounded-[5px] border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
            name={isRawInput ? "manualRawList" : "manualImageList"}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={
              isRawInput
                ? "5N6A5022.CR3\n5023\nA5024.NEF"
                : "5N6A5022.JPG\n5023\nA5024.PNG"
            }
            disabled={busy !== null}
            spellCheck={false}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              取消
            </Button>
          </DialogClose>
          <Button variant="accent" onClick={onConfirm} disabled={busy !== null} type="button">
            <ClipboardList />
            加入清单
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClearConfirmDialog({
  direction,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  direction: MatchDirection;
  open: boolean;
  busy: MatcherBusy;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="destructive">确认清空</Badge>
            <DialogTitle>清空当前方向任务？</DialogTitle>
          </div>
          <DialogDescription>
            将只移除“{directionLabel(direction)}”的输入、查找目录、匹配结果和运行日志；另一方向的任务会保留。
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              取消
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={busy !== null} type="button">
            <RotateCcw />
            确认清空
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExportCompleteDialog({
  direction,
  report,
  onClose,
  onOpenDirectory,
}: {
  direction: MatchDirection;
  report: ExportReport;
  onClose: () => void;
  onOpenDirectory: (path: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(openState) => !openState && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="success">导出完成</Badge>
            <DialogTitle>{candidateRole(direction)}文件导出完成</DialogTitle>
          </div>
          <DialogDescription>{report.directory}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 p-4">
          <StatTile label="已复制" value={report.summary.copiedCount} tone="success" />
          <StatTile label="已存在相同文件" value={report.summary.alreadyPresentCount} />
          <StatTile label="未找到" value={report.summary.skippedMissingCount} />
          <StatTile label="未解决冲突" value={report.summary.skippedConflictCount} tone="danger" />
          <StatTile label="文件名冲突" value={report.summary.collisionCount} tone="danger" />
          <StatTile label="源文件错误" value={report.summary.sourceErrorCount} tone="danger" />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">
            关闭
          </Button>
          <Button variant="utility" onClick={() => onOpenDirectory(report.directory)} type="button">
            <ExternalLink />
            打开导出目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConflictDialog({
  direction,
  open,
  result,
  resultIndex,
  onOpenChange,
  onConfirm,
  onOpenPath,
}: {
  direction: MatchDirection;
  open: boolean;
  result: MatchResult;
  resultIndex: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (resultIndex: number, candidate: MatchFile) => void;
  onOpenPath: (path: string) => void;
}) {
  const [selectedCandidate, setSelectedCandidate] = useState<MatchFile | null>(null);
  const inputCanOpen = !result.input.manual && result.input.path.length > 0;

  useEffect(() => {
    if (open) {
      setSelectedCandidate(null);
    }
  }, [open, result.input.path, result.input.fileName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="destructive">冲突复核</Badge>
            <DialogTitle className="min-w-0 truncate">{result.input.fileName}</DialogTitle>
          </div>
          <DialogDescription>
            选择正确的{candidateRole(direction)}候选。双击文件名可以用系统默认应用打开原文件。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(280px,0.82fr)_minmax(360px,1.18fr)]">
          <section className="grid content-start gap-3 rounded-md border border-border bg-background p-3">
            {inputCanOpen ? (
              <div className="grid gap-2">
                <FilePreview
                  file={result.input}
                  kind={direction === "imageToRaw" ? "image" : "raw"}
                  onOpen={onOpenPath}
                  size="lg"
                />
                <span className="text-center text-xs text-muted-foreground">
                  点击预览可用系统默认 App 打开{inputRole(direction)}
                </span>
              </div>
            ) : (
              <div className="grid min-h-28 place-items-center rounded-[5px] border border-dashed border-border bg-muted/35 p-4 text-center">
                <ClipboardList className="size-5 text-muted-foreground" />
                <strong className="mt-2 text-sm">手工图片引用</strong>
                <span className="text-xs text-muted-foreground">没有可打开的本地文件路径</span>
              </div>
            )}
            <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-card p-3 text-xs">
              <dt className="text-muted-foreground">文件</dt>
              <dd className="min-w-0 truncate">{result.input.fileName}</dd>
              <dt className="text-muted-foreground">路径</dt>
              <dd className="min-w-0 truncate" title={result.input.path || undefined}>
                {result.input.manual ? "手工引用" : result.input.path}
              </dd>
              <dt className="text-muted-foreground">大小</dt>
              <dd>{formatBytes(result.input.size)}</dd>
              <dt className="text-muted-foreground">修改时间</dt>
              <dd>{formatTime(result.input.modifiedTime)}</dd>
            </dl>
            {inputCanOpen ? (
              <Button variant="utility" onClick={() => onOpenPath(result.input.path)} type="button">
                <ExternalLink />
                打开{inputRole(direction)}
              </Button>
            ) : null}
          </section>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background">
            <div className="flex h-10 items-center justify-between border-b border-border px-3">
              <h3 className="text-sm font-semibold">{candidateRole(direction)}候选</h3>
              <Badge variant="muted">{result.candidates.length}</Badge>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid gap-2 p-3">
                {result.candidates.map((candidate) => (
                  <div
                    className={cn(
                      "grid min-h-20 grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-[5px] border border-border bg-card p-3 text-left transition-colors hover:border-accent hover:bg-accent/6",
                      selectedCandidate?.path === candidate.path &&
                        "border-accent bg-accent/10 shadow-[inset_3px_0_0_var(--accent)]",
                    )}
                    key={candidate.path}
                  >
                    <FilePreview
                      file={candidate}
                      kind={direction === "imageToRaw" ? "raw" : "image"}
                      onOpen={onOpenPath}
                    />
                    <button
                      aria-pressed={selectedCandidate?.path === candidate.path}
                      className="grid min-w-0 gap-1 rounded-[4px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelectedCandidate(candidate)}
                      onDoubleClick={() => onOpenPath(candidate.path)}
                      type="button"
                    >
                      <strong className="min-w-0 truncate text-sm">{candidate.fileName}</strong>
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {candidate.path}
                      </span>
                      <span className="font-mono text-xs font-semibold text-accent">
                        {candidate.extension.toUpperCase()} · {formatBytes(candidate.size)} ·{" "}
                        {formatTime(candidate.modifiedTime)}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </section>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              取消
            </Button>
          </DialogClose>
          <Button
            variant="accent"
            disabled={!selectedCandidate}
            onClick={() => {
              if (selectedCandidate) {
                onConfirm(resultIndex, selectedCandidate);
              }
            }}
            type="button"
          >
            <CheckCircle2 />
            确认{candidateRole(direction)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function normalizeCapabilities(capabilities: MatcherCapabilities): MatcherCapabilities {
  return {
    imageExtensions: normalizeExtensions(
      capabilities.imageExtensions,
      defaultCapabilities.imageExtensions,
    ),
    rawExtensions: normalizeExtensions(
      capabilities.rawExtensions,
      defaultCapabilities.rawExtensions,
    ),
  };
}

function normalizeExtensions(values: string[], fallback: string[]) {
  const normalized = Array.from(
    new Set(
      values
        .map((value) => value.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : [...fallback];
}

function appendLogEntries(current: LogEntry[], messages: string[]) {
  return [
    ...current,
    ...messages.map((message) => ({ level: inferLogLevel(message), message })),
  ].slice(-300);
}

function sameInputs(left: MatchFile[], right: MatchFile[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((file, index) => {
    const other = right[index];
    return (
      file.path === other?.path &&
      file.fileName === other.fileName &&
      file.manual === other.manual
    );
  });
}

function createManualInput(reference: string, baseName: string): MatchFile {
  const fileName = reference.split(/[\\/]/).filter(Boolean).at(-1) ?? reference;
  const extensionMatch = fileName.match(/\.([^.]+)$/);
  return {
    path: `manual:${encodeURIComponent(reference)}`,
    fileName: reference,
    baseName,
    extension: extensionMatch?.[1]?.toLowerCase() ?? "",
    size: 0,
    modifiedTime: null,
    manual: true,
  };
}

function normalizeDialogSelection(selection: string | string[] | null): string[] {
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

function parseManualReferences(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["'`]+|["'`,;]+$/g, ""))
    .filter(Boolean);
}

function normalizeManualReference(reference: string) {
  const cleaned = reference.trim().replace(/^["'`]+|["'`,;]+$/g, "");
  const fileName = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? cleaned;
  return fileName.replace(/\.[^.]+$/, "");
}

function manualReferenceExtension(reference: string) {
  const cleaned = reference.trim().replace(/^["'`]+|["'`,;]+$/g, "");
  const fileName = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? cleaned;
  return fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";
}

function inputRole(direction: MatchDirection) {
  return direction === "imageToRaw" ? "图片" : "RAW";
}

function candidateRole(direction: MatchDirection) {
  return direction === "imageToRaw" ? "RAW" : "图片";
}

function directionLabel(direction: MatchDirection) {
  return direction === "imageToRaw" ? "图片 → RAW" : "RAW → 图片";
}

function busyLabel(busy: Exclude<MatcherBusy, null>) {
  return {
    collect: "SCANNING",
    match: "MATCHING",
    export: "EXPORTING",
  }[busy];
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
