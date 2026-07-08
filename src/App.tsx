import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  ExternalLink,
  FileArchive,
  FileImage,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Type,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import appIcon from "../src-tauri/icons/icon.png";

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
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  ExportResponse,
  ExportSummary,
  InputCollection,
  JpegInput,
  MatchResponse,
  MatchResult,
  MatchStatus,
  RawCandidate,
  WatermarkConfig,
  WatermarkExportResponse,
  WatermarkExportSummary,
  WatermarkImageInput,
  WatermarkMode,
  WatermarkScanResponse,
  WatermarkSource,
} from "./types";

const rawFormats = ["CR2", "CR3", "NEF", "ARW", "RAF", "ORF", "RW2", "DNG"];
type WorkspaceId = "raw-jpeg-matcher" | "watermark";
type LogLevel = "info" | "success" | "warning" | "error";
type RawBusy = "collect" | "match" | "export" | null;
type WatermarkBusy = "scan" | "export" | null;
type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "notAvailable"
  | "downloading"
  | "installing"
  | "installed"
  | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
}

interface Size {
  width: number;
  height: number;
}

interface ImageFrame extends Size {
  left: number;
  top: number;
}

interface ExportReport {
  directory: string;
  summary: ExportSummary;
}

interface WatermarkExportReport {
  directory: string;
  summary: WatermarkExportSummary;
}

interface UpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

const updateCheckTimeoutMs = 30_000;
const updateSourceLabel = "Gitee Release";
const updateManifestUrl =
  "https://gitee.com/masongzhi/raw-jpeg-matcher-mac-client/raw/main/release/latest.json";

const defaultWatermarkConfig: WatermarkConfig = {
  opacity: 0.72,
  sizePercent: 22,
  autoRemoveBackground: true,
  backgroundTolerance: 34,
  edgeFeather: 2,
  shadowStrength: 0.28,
  layout: "single",
};

const statusLabel: Record<MatchStatus, string> = {
  matched: "已匹配",
  missing: "未找到",
  conflict: "需复核",
  confirmed: "已确认",
};

const statusIcon: Record<MatchStatus, ReactNode> = {
  matched: <CheckCircle2 />,
  missing: <XCircle />,
  conflict: <AlertTriangle />,
  confirmed: <CheckCircle2 />,
};

const logLevelCode: Record<LogLevel, string> = {
  info: "INF",
  success: "SUC",
  warning: "WRN",
  error: "ERR",
};

function App() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("raw-jpeg-matcher");
  const [jpegInputs, setJpegInputs] = useState<JpegInput[]>([]);
  const [manualText, setManualText] = useState("");
  const [rawSourceDirectory, setRawSourceDirectory] = useState("");
  const [results, setResults] = useState<MatchResult[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([
    { level: "info", message: "等待拖入 JPG 文件、目录或粘贴清单" },
  ]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState<RawBusy>(null);
  const [activeConflictIndex, setActiveConflictIndex] = useState<number | null>(null);
  const [selectedRawFormats, setSelectedRawFormats] = useState<string[]>(rawFormats);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const counts = useMemo(() => {
    return results.reduce(
      (accumulator, result) => {
        accumulator[result.status] += 1;
        return accumulator;
      },
      { matched: 0, missing: 0, conflict: 0, confirmed: 0 } as Record<MatchStatus, number>,
    );
  }, [results]);

  const exportableCount = counts.matched + counts.confirmed;
  const canMatch =
    jpegInputs.length > 0 &&
    rawSourceDirectory.length > 0 &&
    selectedRawFormats.length > 0 &&
    busy === null;
  const canExport = exportableCount > 0 && busy === null;
  const activeConflict =
    activeConflictIndex === null ? null : results[activeConflictIndex] ?? null;

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    if (!isTauriRuntime()) {
      return () => {
        unlisten?.();
      };
    }

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (activeWorkspace !== "raw-jpeg-matcher") {
          return;
        }

        const { payload } = event;
        if (payload.type === "over") {
          setDragActive(true);
          return;
        }

        setDragActive(false);
        if (payload.type === "drop") {
          void collectInputs(payload.paths);
        }
      })
      .then((handler) => {
        unlisten = handler;
      })
      .catch((error) => {
        appendLogs([`拖放监听启动失败: ${String(error)}`]);
      });

    return () => {
      unlisten?.();
    };
  }, [activeWorkspace, jpegInputs]);

  function appendLogs(nextLogs: string[], level?: LogLevel) {
    const entries = nextLogs.map((message) => ({
      level: level ?? inferLogLevel(message),
      message,
    }));
    setLogs((current) => [...current, ...entries].slice(-300));
  }

  async function collectInputs(paths: string[]) {
    if (paths.length === 0) {
      return;
    }

    setBusy("collect");
    try {
      const manualInputs = jpegInputs.filter((file) => file.manual);
      const mergedInputs = [
        ...jpegInputs.filter((file) => !file.manual).map((file) => file.path),
        ...paths,
      ];
      const collection = await invoke<InputCollection>("collect_jpeg_inputs", {
        inputs: mergedInputs,
      });
      setJpegInputs([...collection.files, ...manualInputs]);
      setResults([]);
      appendLogs(collection.logs);
    } catch (error) {
      appendLogs([`读取 JPEG 输入失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function chooseJpegFiles() {
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }],
    });
    const paths = normalizeDialogSelection(selected);
    if (paths.length > 0) {
      await collectInputs(paths);
    }
  }

  async function chooseJpegDirectories() {
    const selected = await open({ directory: true, multiple: true });
    const paths = normalizeDialogSelection(selected);
    if (paths.length > 0) {
      await collectInputs(paths);
    }
  }

  async function chooseRawDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") {
      return;
    }
    setRawSourceDirectory(selected);
    appendLogs([`已选择 RAW 源目录: ${selected}`]);
  }

  async function findRawFiles() {
    if (!canMatch) {
      appendLogs(["缺少 JPEG 输入、RAW 源目录或 RAW 格式选择，无法查找"]);
      return;
    }

    setBusy("match");
    try {
      const response = await invoke<MatchResponse>("match_raw_files", {
        inputs: jpegInputs.filter((file) => !file.manual).map((file) => file.path),
        manualRefs: jpegInputs.filter((file) => file.manual).map((file) => file.fileName),
        rawRoot: rawSourceDirectory,
        rawExtensions: selectedRawFormats,
      });
      setJpegInputs(response.jpegInputs);
      setResults(response.results);
      appendLogs(response.logs);
    } catch (error) {
      appendLogs([`查找 RAW 失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function exportRawFiles() {
    if (!canExport) {
      appendLogs(["缺少可导出的 RAW，无法导出"]);
      return;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 RAW 导出目录",
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("export");
    try {
      const response = await invoke<ExportResponse>("export_raw_files", {
        results,
        exportDir: selected,
      });
      appendLogs(response.logs);
      setExportReport({ directory: selected, summary: response.summary });
    } catch (error) {
      appendLogs([`导出 RAW 失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function openOriginal(path: string) {
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      appendLogs([`打开原始文件失败: ${String(error)}`], "error");
    }
  }

  function confirmCandidate(resultIndex: number, candidate: RawCandidate) {
    const jpegName = results[resultIndex]?.jpeg.fileName ?? "未知 JPG";
    setResults((current) =>
      current.map((result, index) =>
        index === resultIndex
          ? {
              ...result,
              status: "confirmed",
              selectedRaw: candidate,
            }
          : result,
      ),
    );
    setActiveConflictIndex(null);
    appendLogs([`已确认冲突: ${jpegName} -> ${candidate.fileName}`]);
  }

  function clearAll() {
    setJpegInputs([]);
    setManualText("");
    setResults([]);
    setRawSourceDirectory("");
    setActiveConflictIndex(null);
    setSelectedRawFormats(rawFormats);
    setLogs([{ level: "info", message: "已清空当前任务" }]);
  }

  function addManualInputs() {
    const references = parseManualReferences(manualText);
    if (references.length === 0) {
      appendLogs(["文本清单为空，未加入输入"], "warning");
      return;
    }

    const existingKeys = new Set(
      jpegInputs.map((file) =>
        file.manual ? normalizeManualReference(file.fileName) : file.path,
      ),
    );
    const nextManualInputs: JpegInput[] = [];

    for (const reference of references) {
      const baseName = normalizeManualReference(reference);
      if (!baseName || existingKeys.has(baseName)) {
        continue;
      }
      existingKeys.add(baseName);
      nextManualInputs.push({
        path: `manual:${encodeURIComponent(reference)}`,
        fileName: reference,
        baseName,
        size: 0,
        modifiedTime: null,
        manual: true,
      });
    }

    if (nextManualInputs.length === 0) {
      appendLogs(["文本清单未加入新条目，可能全部重复"], "warning");
      return;
    }

    setJpegInputs((current) => [...current, ...nextManualInputs]);
    setResults([]);
    setManualText("");
    setManualDialogOpen(false);
    appendLogs([`已加入文本清单: ${nextManualInputs.length} 条`], "success");
  }

  function toggleRawFormat(format: string) {
    setSelectedRawFormats((current) => {
      const next = current.includes(format)
        ? current.filter((item) => item !== format)
        : [...current, format];
      return rawFormats.filter((item) => next.includes(item));
    });
    setResults([]);
    setActiveConflictIndex(null);
  }

  function selectAllRawFormats() {
    setSelectedRawFormats(rawFormats);
    setResults([]);
    setActiveConflictIndex(null);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (isTextEditing || activeWorkspace !== "raw-jpeg-matcher") {
        return;
      }

      const usesCommandKey = event.metaKey || event.ctrlKey;
      if (!usesCommandKey || event.defaultPrevented) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "o" && event.shiftKey) {
        event.preventDefault();
        void chooseRawDirectory();
      } else if (key === "o") {
        event.preventDefault();
        void chooseJpegFiles();
      } else if (key === "r" && canMatch) {
        event.preventDefault();
        void findRawFiles();
      } else if (key === "e" && canExport) {
        event.preventDefault();
        void exportRawFiles();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeWorkspace, canExport, canMatch, busy, jpegInputs, rawSourceDirectory, results, selectedRawFormats]);

  return (
    <TooltipProvider>
      <main className="desk-grid h-screen overflow-hidden text-foreground">
        <div className="grid h-full grid-rows-[64px_40px_minmax(0,1fr)_28px]">
          <AppHeader
            jpegCount={jpegInputs.length}
            counts={counts}
            exportableCount={exportableCount}
          />

          <WorkspaceTabs activeWorkspace={activeWorkspace} onChange={setActiveWorkspace} />

          <div className="min-h-0 overflow-hidden">
            <RawJpegMatcherView
              active={activeWorkspace === "raw-jpeg-matcher"}
              busy={busy}
              canExport={canExport}
              canMatch={canMatch}
              counts={counts}
              dragActive={dragActive}
              exportableCount={exportableCount}
              jpegInputs={jpegInputs}
              logs={logs}
              rawSourceDirectory={rawSourceDirectory}
              results={results}
              selectedRawFormats={selectedRawFormats}
              onChooseJpegDirectories={chooseJpegDirectories}
              onChooseJpegFiles={chooseJpegFiles}
              onChooseRawDirectory={chooseRawDirectory}
              onClear={() => setClearDialogOpen(true)}
              onExport={exportRawFiles}
              onMatch={findRawFiles}
              onOpenJpeg={openOriginal}
              onOpenManualDialog={() => setManualDialogOpen(true)}
              onOpenPath={openOriginal}
              onResultConflictClick={setActiveConflictIndex}
              onSelectAllRawFormats={selectAllRawFormats}
              onToggleRawFormat={toggleRawFormat}
            />
            <WatermarkView active={activeWorkspace === "watermark"} />
          </div>

          <FooterStatus
            activeWorkspace={activeWorkspace}
            jpegCount={jpegInputs.length}
            rawDirectory={rawSourceDirectory}
            busy={busy}
          />
        </div>

        {activeConflict && activeConflictIndex !== null ? (
          <ConflictDialog
            open={activeConflict !== null}
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

        {exportReport ? (
          <ExportCompleteDialog
            report={exportReport}
            onClose={() => setExportReport(null)}
            onOpenDirectory={openOriginal}
          />
        ) : null}

        <ManualInputDialog
          open={manualDialogOpen}
          value={manualText}
          busy={busy}
          onValueChange={setManualText}
          onOpenChange={setManualDialogOpen}
          onConfirm={addManualInputs}
        />

        <ClearConfirmDialog
          open={clearDialogOpen}
          busy={busy}
          onOpenChange={setClearDialogOpen}
          onConfirm={() => {
            clearAll();
            setClearDialogOpen(false);
          }}
        />

      </main>
    </TooltipProvider>
  );
}

function WorkspaceTabs({
  activeWorkspace,
  onChange,
}: {
  activeWorkspace: WorkspaceId;
  onChange: (workspace: WorkspaceId) => void;
}) {
  const tabs: Array<{ id: WorkspaceId; label: string; icon: ReactNode }> = [
    { id: "raw-jpeg-matcher", label: "RAW/JPEG matcher", icon: <Search /> },
    { id: "watermark", label: "添加水印", icon: <ImageIcon /> },
  ];

  return (
    <nav
      aria-label="工作区"
      className="flex items-center gap-2 border-b border-border bg-background/72 px-3 backdrop-blur-xl"
    >
      {tabs.map((tab) => (
        <button
          aria-pressed={activeWorkspace === tab.id}
          className={cn(
            "inline-flex h-7 items-center gap-2 rounded-[7px] border px-3 text-xs font-semibold transition-[background,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
            activeWorkspace === tab.id
              ? "border-accent bg-accent text-accent-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              : "border-transparent bg-card/60 text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
          )}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function RawJpegMatcherView({
  active,
  busy,
  canExport,
  canMatch,
  counts,
  dragActive,
  exportableCount,
  jpegInputs,
  logs,
  rawSourceDirectory,
  results,
  selectedRawFormats,
  onChooseJpegDirectories,
  onChooseJpegFiles,
  onChooseRawDirectory,
  onClear,
  onExport,
  onMatch,
  onOpenJpeg,
  onOpenManualDialog,
  onOpenPath,
  onResultConflictClick,
  onSelectAllRawFormats,
  onToggleRawFormat,
}: {
  active: boolean;
  busy: RawBusy;
  canExport: boolean;
  canMatch: boolean;
  counts: Record<MatchStatus, number>;
  dragActive: boolean;
  exportableCount: number;
  jpegInputs: JpegInput[];
  logs: LogEntry[];
  rawSourceDirectory: string;
  results: MatchResult[];
  selectedRawFormats: string[];
  onChooseJpegDirectories: () => void;
  onChooseJpegFiles: () => void;
  onChooseRawDirectory: () => void;
  onClear: () => void;
  onExport: () => void;
  onMatch: () => void;
  onOpenJpeg: (path: string) => void;
  onOpenManualDialog: () => void;
  onOpenPath: (path: string) => void;
  onResultConflictClick: (index: number) => void;
  onSelectAllRawFormats: () => void;
  onToggleRawFormat: (format: string) => void;
}) {
  return (
    <section
      className={cn(
        "grid h-full min-h-0 grid-cols-1 overflow-auto min-[1100px]:grid-cols-[280px_minmax(0,1fr)_280px] min-[1100px]:overflow-hidden",
        !active && "hidden",
      )}
    >
      <aside className="min-h-[520px] border-r border-border bg-background/78 min-[1100px]:min-h-0">
        <ScrollArea className="h-full min-h-0">
          <div className="grid min-h-[720px] gap-3 p-3 pb-6 min-[1100px]:min-h-0">
            <InputPane
              busy={busy}
              dragActive={dragActive}
              jpegInputs={jpegInputs}
              rawSourceDirectory={rawSourceDirectory}
              selectedRawFormats={selectedRawFormats}
              onOpenManualDialog={onOpenManualDialog}
              onChooseJpegFiles={onChooseJpegFiles}
              onChooseJpegDirectories={onChooseJpegDirectories}
              onChooseRawDirectory={onChooseRawDirectory}
              onOpenJpeg={onOpenJpeg}
              onToggleRawFormat={onToggleRawFormat}
              onSelectAllRawFormats={onSelectAllRawFormats}
            />
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[620px] min-w-0 flex-col border-r border-border bg-card/72 min-[1100px]:min-h-0">
        <WorkbenchToolbar
          busy={busy}
          canMatch={canMatch}
          canExport={canExport}
          onMatch={onMatch}
          onExport={onExport}
          onClear={onClear}
        />
        <ResultTable
          results={results}
          onConflictClick={onResultConflictClick}
          onOpenPath={onOpenPath}
        />
      </section>

      <aside className="flex min-h-[440px] min-w-0 flex-col bg-background/78 min-[1100px]:min-h-0">
        <InspectorPane counts={counts} exportableCount={exportableCount} logs={logs} />
      </aside>
    </section>
  );
}

function WatermarkView({ active }: { active: boolean }) {
  const [inputRoot, setInputRoot] = useState("");
  const [images, setImages] = useState<WatermarkImageInput[]>([]);
  const [mode, setMode] = useState<WatermarkMode>("text");
  const [watermarkText, setWatermarkText] = useState("照片配对助手");
  const [watermarkImagePath, setWatermarkImagePath] = useState("");
  const [config, setConfig] = useState<WatermarkConfig>(defaultWatermarkConfig);
  const [logs, setLogs] = useState<LogEntry[]>([
    { level: "info", message: "等待选择图片输入目录" },
  ]);
  const [busy, setBusy] = useState<WatermarkBusy>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [exportReport, setExportReport] = useState<WatermarkExportReport | null>(null);
  const [originalPreviewOpen, setOriginalPreviewOpen] = useState(false);

  const hasValidWatermark =
    mode === "text" ? watermarkText.trim().length > 0 : watermarkImagePath.length > 0;
  const canExport = images.length > 0 && hasValidWatermark && busy === null;
  const previewImage = images[0];
  const previewImageUrl = previewImage?.path ? convertFileSrc(previewImage.path) : "";
  const previewWatermarkUrl =
    mode === "image" && watermarkImagePath ? convertFileSrc(watermarkImagePath) : previewUrl;

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    if (mode === "image") {
      setPreviewUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return "";
      });
      return;
    }

    renderTextWatermarkPreview(watermarkText || "Watermark", config)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return url;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl("");
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [config, mode, watermarkText]);

  function appendWatermarkLogs(nextLogs: string[], level?: LogLevel) {
    const entries = nextLogs.map((message) => ({
      level: level ?? inferLogLevel(message),
      message,
    }));
    setLogs((current) => [...current, ...entries].slice(-300));
  }

  async function chooseInputDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择图片输入目录",
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("scan");
    try {
      const response = await invoke<WatermarkScanResponse>("scan_watermark_images", {
        root: selected,
      });
      setInputRoot(response.rootDir);
      setImages(response.images);
      setSkippedCount(response.skippedCount);
      setDuplicateCount(response.duplicateCount);
      appendWatermarkLogs(response.logs);
    } catch (error) {
      appendWatermarkLogs([`扫描图片输入失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function chooseWatermarkImage() {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "水印图片", extensions: ["jpg", "jpeg", "png"] }],
      title: "选择水印图片",
    });
    if (typeof selected !== "string") {
      return;
    }

    setWatermarkImagePath(selected);
    appendWatermarkLogs([`已选择图片水印: ${selected}`], "success");
  }

  async function openWatermarkPath(path: string) {
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      appendWatermarkLogs([`打开图片失败: ${String(error)}`], "error");
    }
  }

  async function exportWatermarkedImages() {
    if (images.length === 0) {
      appendWatermarkLogs(["缺少图片输入，无法导出水印图片"], "warning");
      return;
    }
    if (mode === "text" && watermarkText.trim().length === 0) {
      appendWatermarkLogs(["文字水印文案为空，无法导出"], "warning");
      return;
    }
    if (mode === "image" && watermarkImagePath.length === 0) {
      appendWatermarkLogs(["尚未选择图片水印，无法导出"], "warning");
      return;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择水印导出目录",
      canCreateDirectories: true,
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("export");
    try {
      const source: WatermarkSource =
        mode === "text"
          ? await createTextWatermarkSource(watermarkText)
          : { type: "imageFile", path: watermarkImagePath };
      const response = await invoke<WatermarkExportResponse>("export_watermarked_images", {
        inputRoot,
        images,
        exportDir: selected,
        source,
        config,
      });
      appendWatermarkLogs(response.logs);
      setExportReport({ directory: selected, summary: response.summary });
    } catch (error) {
      appendWatermarkLogs([`导出水印图片失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  function updateConfig<K extends keyof WatermarkConfig>(key: K, value: WatermarkConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  return (
    <section
      className={cn(
        "grid h-full min-h-0 grid-cols-1 overflow-auto min-[1100px]:grid-cols-[300px_minmax(0,1fr)_280px] min-[1100px]:overflow-hidden",
        !active && "hidden",
      )}
    >
      <aside className="min-h-[560px] border-r border-border bg-background/78 min-[1100px]:min-h-0">
        <ScrollArea className="h-full min-h-0">
          <div className="grid min-h-[720px] gap-3 p-3 pb-6 min-[1100px]:min-h-0">
            <Pane
              icon={<FileImage className="size-4" />}
              title="图片输入"
              subtitle={`${images.length} 张图片已加入`}
            >
              <PathDisplay path={inputRoot} fallback="尚未选择图片输入目录" />
              <Button
                variant="default"
                onClick={chooseInputDirectory}
                disabled={busy !== null}
                type="button"
              >
                {busy === "scan" ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                选择图片目录
              </Button>
              <WatermarkImageList images={images} onOpen={openWatermarkPath} />
            </Pane>

            <Pane
              icon={<SlidersHorizontal className="size-4" />}
              title="水印配置"
              subtitle={mode === "text" ? "文字水印" : "图片水印"}
            >
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={mode === "text" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => setMode("text")}
                  type="button"
                >
                  <Type />
                  文字
                </Button>
                <Button
                  variant={mode === "image" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => setMode("image")}
                  type="button"
                >
                  <ImageIcon />
                  图片
                </Button>
              </div>

              {mode === "text" ? (
                <textarea
                  aria-label="文字水印内容"
                  className="min-h-20 resize-y rounded-[5px] border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
                  name="watermarkText"
                  value={watermarkText}
                  onChange={(event) => setWatermarkText(event.target.value)}
                  placeholder="输入文字水印"
                  disabled={busy !== null}
                  spellCheck={false}
                />
              ) : (
                <>
                  <PathDisplay
                    path={watermarkImagePath}
                    fallback="尚未选择图片水印"
                    compact
                  />
                  <Button
                    variant="utility"
                    onClick={chooseWatermarkImage}
                    disabled={busy !== null}
                    type="button"
                  >
                    <ImageIcon />
                    选择水印图片
                  </Button>
                </>
              )}

              <RangeControl
                label="透明度"
                value={config.opacity}
                min={0.1}
                max={1}
                step={0.01}
                suffix="%"
                formatValue={(value) => Math.round(value * 100).toString()}
                onChange={(value) => updateConfig("opacity", value)}
              />
              <RangeControl
                label="尺寸"
                value={config.sizePercent}
                min={4}
                max={60}
                step={1}
                suffix="%"
                onChange={(value) => updateConfig("sizePercent", value)}
              />
              <RangeControl
                label="阴影"
                value={config.shadowStrength}
                min={0}
                max={1}
                step={0.01}
                suffix="%"
                formatValue={(value) => Math.round(value * 100).toString()}
                onChange={(value) => updateConfig("shadowStrength", value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={config.layout === "single" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => updateConfig("layout", "single")}
                  type="button"
                >
                  <Eye />
                  单点
                </Button>
                <Button
                  variant={config.layout === "tile" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => updateConfig("layout", "tile")}
                  type="button"
                >
                  <LayoutGrid />
                  平铺
                </Button>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-[5px] border border-border bg-background px-3 py-2 text-xs">
                <span className="font-medium">自动去背景</span>
                <input
                  aria-label="自动去背景"
                  className="size-4 accent-[var(--accent)]"
                  name="autoRemoveBackground"
                  type="checkbox"
                  checked={config.autoRemoveBackground}
                  onChange={(event) => updateConfig("autoRemoveBackground", event.target.checked)}
                  disabled={mode !== "image" || busy !== null}
                />
              </label>
              <RangeControl
                label="背景容差"
                value={config.backgroundTolerance}
                min={0}
                max={120}
                step={1}
                disabled={mode !== "image" || !config.autoRemoveBackground}
                onChange={(value) => updateConfig("backgroundTolerance", value)}
              />
              <RangeControl
                label="边缘柔化"
                value={config.edgeFeather}
                min={0}
                max={8}
                step={1}
                disabled={mode !== "image" || !config.autoRemoveBackground}
                onChange={(value) => updateConfig("edgeFeather", Math.round(value))}
              />
            </Pane>
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[620px] min-w-0 flex-col border-r border-border bg-card/72 min-[1100px]:min-h-0">
        <div className="border-b border-border bg-card/82 px-3 py-2.5 backdrop-blur">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="accent"
              onClick={exportWatermarkedImages}
              disabled={!canExport}
              type="button"
            >
              {busy === "export" ? <Loader2 className="animate-spin" /> : <Download />}
              导出加水印图片
            </Button>
            <Badge variant={hasValidWatermark ? "success" : "warning"}>
              {hasValidWatermark ? "配置有效" : "待配置"}
            </Badge>
          </div>
        </div>

        <section className="grid min-h-0 flex-1 grid-rows-[minmax(220px,0.9fr)_minmax(220px,1.1fr)]">
          <div className="grid min-h-0 gap-3 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">水印预览</h2>
              <Badge variant="muted">{mode === "text" ? "文字" : "图片"}</Badge>
            </div>
            <WatermarkPreviewPanel
              imageUrl={previewImageUrl}
              watermarkUrl={previewWatermarkUrl}
              config={config}
              onOpenOriginal={() => setOriginalPreviewOpen(true)}
            />
          </div>

          <WatermarkInputTable images={images} onOpen={openWatermarkPath} />
        </section>
      </section>

      <aside className="flex min-h-[440px] min-w-0 flex-col bg-background/78 min-[1100px]:min-h-0">
        <div className="flex h-full min-h-0 flex-col gap-3 p-3">
          <section className="rounded-md border border-border bg-card p-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">水印统计</h2>
              <Badge variant="accent">{images.length} 可处理</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="图片" value={images.length} tone="success" />
              <StatTile label="跳过" value={skippedCount} />
              <StatTile label="重复" value={duplicateCount} />
              <StatTile label="可导出" value={canExport ? images.length : 0} tone="success" />
            </div>
          </section>
          <LogPanel logs={logs} />
        </div>
      </aside>

      {exportReport ? (
        <WatermarkExportCompleteDialog
          report={exportReport}
          onClose={() => setExportReport(null)}
          onOpenDirectory={openWatermarkPath}
        />
      ) : null}
      {originalPreviewOpen && previewImageUrl ? (
        <WatermarkOriginalPreviewDialog
          imageName={previewImage?.fileName ?? "原图预览"}
          imageUrl={previewImageUrl}
          watermarkUrl={previewWatermarkUrl}
          config={config}
          onClose={() => setOriginalPreviewOpen(false)}
        />
      ) : null}
    </section>
  );
}

function WatermarkPreviewPanel({
  imageUrl,
  watermarkUrl,
  config,
  onOpenOriginal,
}: {
  imageUrl: string;
  watermarkUrl: string;
  config: WatermarkConfig;
  onOpenOriginal: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [imageUrl]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setContainerSize({
        width: rect.width,
        height: rect.height,
      });
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const imageFrame = useMemo(
    () => (naturalSize ? containImageFrame(containerSize, naturalSize) : null),
    [containerSize, naturalSize],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0 w-full overflow-hidden rounded-md border border-border bg-background"
    >
      {!imageUrl ? (
        <div className="absolute inset-0 grid justify-items-center place-content-center gap-2 text-center text-muted-foreground">
          <Eye className="size-6" />
          <span className="text-sm">等待预览</span>
        </div>
      ) : null}

      {imageUrl && imageFrame ? (
        <button
          aria-label="打开原图尺寸水印预览"
          className="absolute overflow-hidden bg-background text-left outline-none transition-shadow hover:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_18%,transparent)] focus-visible:ring-2 focus-visible:ring-ring"
          style={imageFrameStyle(imageFrame)}
          onClick={onOpenOriginal}
          type="button"
          title="查看原图尺寸水印预览"
        >
          <img
            className="absolute inset-0 size-full object-fill"
            src={imageUrl}
            alt="水印预览底图"
          />
          <WatermarkOverlay
            watermarkUrl={watermarkUrl}
            config={config}
            frameSize={imageFrame}
          />
        </button>
      ) : null}

      {imageUrl ? (
        <img
          className="pointer-events-none absolute size-0 opacity-0"
          src={imageUrl}
          alt=""
          aria-hidden="true"
          onLoad={(event) => {
            const image = event.currentTarget;
            setNaturalSize({
              width: image.naturalWidth || 1,
              height: image.naturalHeight || 1,
            });
          }}
        />
      ) : null}
    </div>
  );
}

function WatermarkOriginalPreviewDialog({
  imageName,
  imageUrl,
  watermarkUrl,
  config,
  onClose,
}: {
  imageName: string;
  imageUrl: string;
  watermarkUrl: string;
  config: WatermarkConfig;
  onClose: () => void;
}) {
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [imageUrl]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[92vw]">
        <DialogHeader>
          <DialogTitle>{imageName}</DialogTitle>
          <DialogDescription>
            {naturalSize
              ? `原图尺寸 ${naturalSize.width} x ${naturalSize.height}`
              : "正在读取原图尺寸"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[72vh] overflow-auto rounded-md border border-border bg-background">
          <div
            className="relative"
            style={
              naturalSize
                ? {
                    width: `${naturalSize.width}px`,
                    height: `${naturalSize.height}px`,
                  }
                : undefined
            }
          >
            <img
              className={cn(
                "block",
                naturalSize
                  ? "absolute inset-0 size-full object-fill"
                  : "max-h-[70vh] max-w-full object-contain",
              )}
              src={imageUrl}
              alt="原图尺寸水印预览"
              onLoad={(event) => {
                const image = event.currentTarget;
                setNaturalSize({
                  width: image.naturalWidth || 1,
                  height: image.naturalHeight || 1,
                });
              }}
            />
            {naturalSize ? (
              <WatermarkOverlay
                watermarkUrl={watermarkUrl}
                config={config}
                frameSize={naturalSize}
              />
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="utility" type="button">关闭</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WatermarkOverlay({
  watermarkUrl,
  config,
  frameSize,
}: {
  watermarkUrl: string;
  config: WatermarkConfig;
  frameSize: Size;
}) {
  if (!watermarkUrl) {
    return null;
  }

  const margin = watermarkMargin(frameSize);
  const shadow = watermarkShadow(config);

  if (config.layout === "tile") {
    return (
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          backgroundImage: cssImageUrl(watermarkUrl),
          backgroundRepeat: "repeat",
          backgroundSize: `${config.sizePercent}% auto`,
          backgroundPosition: `${margin / 2}px ${margin / 2}px`,
          opacity: config.opacity,
          filter: shadow,
        }}
      />
    );
  }

  return (
    <img
      className="absolute max-h-[70%] object-contain"
      src={watermarkUrl}
      alt=""
      aria-hidden="true"
      style={{
        width: `${config.sizePercent}%`,
        right: `${margin}px`,
        bottom: `${margin}px`,
        opacity: config.opacity,
        filter: shadow,
      }}
    />
  );
}

function containImageFrame(container: Size, image: Size): ImageFrame | null {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }

  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    width,
    height,
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
  };
}

function imageFrameStyle(frame: ImageFrame) {
  return {
    left: `${frame.left}px`,
    top: `${frame.top}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`,
  };
}

function watermarkMargin(size: Size) {
  return clampNumber(Math.round(Math.min(size.width, size.height) * 0.035), 12, 48);
}

function watermarkShadow(config: WatermarkConfig) {
  if (config.shadowStrength <= 0) {
    return undefined;
  }

  return `drop-shadow(${Math.round(10 * config.shadowStrength)}px ${Math.round(12 * config.shadowStrength)}px ${Math.round(18 * config.shadowStrength)}px rgba(0,0,0,${Math.min(0.45, config.shadowStrength * 0.6)}))`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cssImageUrl(url: string) {
  return `url("${url.replace(/"/g, '\\"')}")`;
}

function AppHeader({
  jpegCount,
  counts,
  exportableCount,
}: {
  jpegCount: number;
  counts: Record<MatchStatus, number>;
  exportableCount: number;
}) {
  return (
    <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-card/76 px-4 shadow-[0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-xl lg:grid-cols-[minmax(240px,1fr)_auto_auto]">
      <div className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-3">
        <span className="grid size-11 place-items-center overflow-visible rounded-[10px]">
          <img
            className="size-full object-contain"
            src={appIcon}
            alt=""
            aria-hidden="true"
            width={44}
            height={44}
          />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[16px] font-semibold leading-none text-pretty">照片配对助手</h1>
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            RAW 原片配对导出与交付图片批量水印
          </p>
        </div>
      </div>

      <div className="justify-self-end lg:justify-self-center">
        <UpdateButton />
      </div>

      <div className="hidden items-center gap-2 justify-self-end lg:flex">
        <HeaderMetric label="JPG" value={jpegCount} />
        <HeaderMetric label="匹配" value={counts.matched} tone="success" />
        <HeaderMetric label="冲突" value={counts.conflict} tone="danger" />
        <HeaderMetric label="可导出" value={exportableCount} tone="accent" />
      </div>
    </header>
  );
}

function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [currentVersion, setCurrentVersion] = useState("");
  const [progress, setProgress] = useState<UpdateProgress>({
    downloadedBytes: 0,
    totalBytes: null,
  });
  const resetTimerRef = useRef<number | null>(null);

  const isBusy =
    status === "checking" || status === "downloading" || status === "installing";
  const hasUpdate = pendingUpdate !== null;

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;
    void getVersion()
      .then((version) => {
        if (!cancelled) {
          setCurrentVersion(version);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentVersion("");
        }
      });

    const checkTimer = window.setTimeout(() => {
      if (!cancelled) {
        void checkForUpdates(true);
      }
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(checkTimer);
    };
  }, []);

  function clearStatusReset() {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }

  function queueStatusReset() {
    clearStatusReset();
    resetTimerRef.current = window.setTimeout(() => {
      setStatus((current) =>
        current === "notAvailable" || current === "installed" ? "idle" : current,
      );
      resetTimerRef.current = null;
    }, 2600);
  }

  async function checkForUpdates(silent: boolean) {
    if (!isTauriRuntime()) {
      setStatus("error");
      setMessage("更新功能仅在真实 Tauri 客户端中可用。");
      if (!silent) {
        setDialogOpen(true);
      }
      return;
    }

    clearStatusReset();
    setStatus("checking");
    setMessage("");
    setProgress({ downloadedBytes: 0, totalBytes: null });

    try {
      const latestUpdate = await check({ timeout: updateCheckTimeoutMs });
      setPendingUpdate(latestUpdate);

      if (latestUpdate) {
        setStatus("available");
        setCurrentVersion(latestUpdate.currentVersion);
        setMessage(`发现新版本 ${latestUpdate.version}`);
        if (!silent) {
          setDialogOpen(true);
        }
        return;
      }

      setStatus(silent ? "idle" : "notAvailable");
      setMessage("当前已经是最新版本。");
      if (!silent) {
        queueStatusReset();
      }
    } catch (error) {
      setPendingUpdate(null);
      if (silent) {
        setStatus("idle");
        return;
      }
      setStatus("error");
      setMessage(formatUpdateError(error));
      setDialogOpen(true);
    }
  }

  async function installPendingUpdate() {
    if (!pendingUpdate) {
      await checkForUpdates(false);
      return;
    }

    clearStatusReset();
    setDialogOpen(true);
    setStatus("downloading");
    setMessage("正在下载更新包。");
    setProgress({ downloadedBytes: 0, totalBytes: null });

    let downloadedBytes = 0;
    let totalBytes: number | null = null;

    try {
      await pendingUpdate.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? null;
          downloadedBytes = 0;
          setProgress({ downloadedBytes, totalBytes });
          return;
        }

        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setProgress({ downloadedBytes, totalBytes });
          return;
        }

        setStatus("installing");
        setMessage("更新已下载，正在安装。");
      });

      setStatus("installed");
      setMessage("更新已安装，正在重启应用。");
      queueStatusReset();
      await relaunch();
    } catch (error) {
      setStatus("error");
      setMessage(formatUpdateError(error));
    }
  }

  function handleButtonClick() {
    if (isBusy || hasUpdate) {
      setDialogOpen(true);
      return;
    }
    void checkForUpdates(false);
  }

  const label = getUpdateButtonLabel(status, pendingUpdate, progress);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={label}
            className={cn(
              "h-8 max-w-[10.5rem] overflow-hidden px-2.5 text-xs",
              status === "available" &&
                "border-accent/35 bg-accent/12 text-accent hover:bg-accent/16",
              status === "error" &&
                "border-destructive/30 bg-destructive/8 text-destructive hover:bg-destructive/12",
            )}
            disabled={status === "installing" || status === "installed"}
            onClick={handleButtonClick}
            type="button"
            variant={status === "available" ? "accent" : "utility"}
          >
            <UpdateButtonIcon status={status} />
            <span className="min-w-0 truncate">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasUpdate ? "查看新版本" : `从 ${updateSourceLabel} 检查更新`}
        </TooltipContent>
      </Tooltip>

      <UpdateDialog
        currentVersion={currentVersion}
        message={message}
        onCheck={() => void checkForUpdates(false)}
        onInstall={() => void installPendingUpdate()}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        pendingUpdate={pendingUpdate}
        progress={progress}
        status={status}
      />
    </>
  );
}

function UpdateButtonIcon({ status }: { status: UpdateStatus }) {
  if (status === "checking" || status === "downloading") {
    return <Loader2 className="animate-spin" />;
  }
  if (status === "available") {
    return <Download />;
  }
  if (status === "notAvailable" || status === "installed") {
    return <CheckCircle2 />;
  }
  if (status === "error") {
    return <AlertTriangle />;
  }
  return <RotateCcw />;
}

function UpdateDialog({
  open,
  status,
  currentVersion,
  pendingUpdate,
  progress,
  message,
  onOpenChange,
  onCheck,
  onInstall,
}: {
  open: boolean;
  status: UpdateStatus;
  currentVersion: string;
  pendingUpdate: Update | null;
  progress: UpdateProgress;
  message: string;
  onOpenChange: (open: boolean) => void;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const isInstalling = status === "downloading" || status === "installing";
  const latestVersion = pendingUpdate?.version ?? "-";
  const notes = pendingUpdate?.body?.trim();
  const progressPercent = getUpdateProgressPercent(progress);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isInstalling) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={!isInstalling}>
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <DialogTitle className="min-w-0 truncate">应用更新</DialogTitle>
            <Badge variant={getUpdateBadgeVariant(status)}>
              {getUpdateBadgeLabel(status)}
            </Badge>
          </div>
          <DialogDescription>
            更新包来自 {updateSourceLabel}，安装前会经过 Tauri 签名校验。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[6px] border border-border bg-background/72 px-3 py-2">
              <div className="text-[11px] font-medium text-muted-foreground">当前版本</div>
              <div className="mt-1 truncate font-mono text-sm font-semibold">
                {currentVersion || "-"}
              </div>
            </div>
            <div className="rounded-[6px] border border-border bg-background/72 px-3 py-2">
              <div className="text-[11px] font-medium text-muted-foreground">最新版本</div>
              <div className="mt-1 truncate font-mono text-sm font-semibold">
                {latestVersion}
              </div>
            </div>
          </div>

          {notes ? (
            <div className="rounded-[6px] border border-border bg-muted/40 px-3 py-2.5">
              <div className="mb-1 text-[11px] font-semibold text-muted-foreground">
                更新说明
              </div>
              <p className="max-h-28 overflow-auto whitespace-pre-wrap text-sm leading-6">
                {notes}
              </p>
            </div>
          ) : null}

          {status === "downloading" || status === "installing" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{status === "installing" ? "正在安装" : "正在下载"}</span>
                <span className="font-mono tabular-nums">
                  {progressPercent === null
                    ? formatBytes(progress.downloadedBytes)
                    : `${progressPercent}%`}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{
                    width:
                      progressPercent === null ? "36%" : `${progressPercent}%`,
                  }}
                />
              </div>
              <div className="text-[11px] text-muted-foreground">
                {progress.totalBytes
                  ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(
                      progress.totalBytes,
                    )}`
                  : "等待服务器返回文件大小"}
              </div>
            </div>
          ) : null}

          {message ? (
            <div
              className={cn(
                "rounded-[6px] border px-3 py-2 text-sm",
                status === "error"
                  ? "border-destructive/25 bg-destructive/8 text-destructive"
                  : "border-border bg-background/70 text-muted-foreground",
              )}
            >
              {message}
            </div>
          ) : null}

          <div className="rounded-[6px] border border-border bg-background/72 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            Manifest: <span className="font-mono">{updateManifestUrl}</span>
          </div>
        </div>

        <DialogFooter>
          {!isInstalling ? (
            <DialogClose asChild>
              <Button variant="outline" type="button">
                关闭
              </Button>
            </DialogClose>
          ) : null}
          <Button
            disabled={isInstalling || status === "installed" || status === "checking"}
            onClick={pendingUpdate ? onInstall : onCheck}
            type="button"
          >
            {getUpdatePrimaryActionLabel(status, pendingUpdate)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HeaderMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "danger" | "accent";
}) {
  return (
    <div className="grid h-9 min-w-[4.5rem] grid-cols-[1fr_auto] items-center gap-2 rounded-[7px] border border-border bg-background/78 px-2.5 shadow-[0_1px_0_rgba(255,255,255,0.76)]">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "font-mono text-[16px] leading-none tabular-nums",
          tone === "success" && "text-success",
          tone === "danger" && "text-destructive",
          tone === "accent" && "text-accent",
        )}
      >
        {value}
      </strong>
    </div>
  );
}

function InputPane({
  busy,
  dragActive,
  jpegInputs,
  rawSourceDirectory,
  selectedRawFormats,
  onOpenManualDialog,
  onChooseJpegFiles,
  onChooseJpegDirectories,
  onChooseRawDirectory,
  onOpenJpeg,
  onToggleRawFormat,
  onSelectAllRawFormats,
}: {
  busy: RawBusy;
  dragActive: boolean;
  jpegInputs: JpegInput[];
  rawSourceDirectory: string;
  selectedRawFormats: string[];
  onOpenManualDialog: () => void;
  onChooseJpegFiles: () => void;
  onChooseJpegDirectories: () => void;
  onChooseRawDirectory: () => void;
  onOpenJpeg: (path: string) => void;
  onToggleRawFormat: (format: string) => void;
  onSelectAllRawFormats: () => void;
}) {
  return (
    <>
      <Pane
        icon={<FileImage className="size-4" />}
        title="JPG 输入"
        subtitle={`${jpegInputs.length} 个文件已加入`}
      >
        <button
          className={cn(
            "drop-raster grid min-h-28 place-items-center rounded-md border border-dashed border-border p-4 text-center transition-[border-color,box-shadow,transform] duration-150 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            dragActive && "border-accent shadow-[0_0_0_4px_color-mix(in_oklch,var(--accent)_18%,transparent)]",
          )}
          onClick={onChooseJpegFiles}
          disabled={busy !== null}
          type="button"
        >
          <div className="grid justify-items-center gap-2">
            <span className="grid size-9 place-items-center rounded-[5px] border border-accent/30 bg-accent/10 text-accent">
              {busy === "collect" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FileImage className="size-4" />
              )}
            </span>
            <strong className="text-sm font-semibold">
              {busy === "collect" ? "正在扫描输入..." : "拖入 JPG 文件或目录"}
            </strong>
            <span className="text-xs text-muted-foreground">点击选择文件，目录入口在下方</span>
          </div>
        </button>

        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="utility"
            size="sm"
            onClick={onChooseJpegFiles}
            disabled={busy !== null}
            type="button"
          >
            <FileImage />
            文件
          </Button>
          <Button
            variant="utility"
            size="sm"
            onClick={onChooseJpegDirectories}
            disabled={busy !== null}
            type="button"
          >
            <FolderOpen />
            目录
          </Button>
          <Button
            variant="utility"
            size="sm"
            onClick={onOpenManualDialog}
            disabled={busy !== null}
            type="button"
          >
            <ClipboardList />
            文本
          </Button>
        </div>

        <FileList files={jpegInputs} onOpen={onOpenJpeg} />
      </Pane>

      <Pane
        icon={<FileArchive className="size-4" />}
        title="RAW 源目录"
        subtitle="递归扫描常见 RAW 格式"
      >
        <PathDisplay path={rawSourceDirectory} fallback="尚未选择 RAW 源目录" />
        <Button
          variant="default"
          onClick={onChooseRawDirectory}
          disabled={busy !== null}
          type="button"
        >
          <FolderOpen />
          选择 RAW 目录
        </Button>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            已选 {selectedRawFormats.length}/{rawFormats.length}
          </span>
          <Button
            variant={selectedRawFormats.length === rawFormats.length ? "accent" : "ghost"}
            size="sm"
            onClick={onSelectAllRawFormats}
            type="button"
            aria-pressed={selectedRawFormats.length === rawFormats.length}
          >
            {selectedRawFormats.length === rawFormats.length ? <Check /> : null}
            全选
          </Button>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {rawFormats.map((format) => (
            <button
              aria-pressed={selectedRawFormats.includes(format)}
              className={cn(
                "grid h-7 place-items-center rounded-[4px] border text-[11px] font-semibold transition-colors",
                selectedRawFormats.includes(format)
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border bg-muted text-muted-foreground hover:border-accent/60",
              )}
              key={format}
              onClick={() => onToggleRawFormat(format)}
              type="button"
            >
              {format}
            </button>
          ))}
        </div>
      </Pane>

    </>
  );
}

function Pane({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/92 p-3 shadow-[0_1px_0_rgba(255,255,255,0.72),0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-[7px] border border-border bg-muted text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold leading-none">{title}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="grid gap-2.5">{children}</div>
    </section>
  );
}

function WorkbenchToolbar({
  busy,
  canMatch,
  canExport,
  onMatch,
  onExport,
  onClear,
}: {
  busy: RawBusy;
  canMatch: boolean;
  canExport: boolean;
  onMatch: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="border-b border-border bg-card/82 px-3 py-2.5 backdrop-blur">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button onClick={onMatch} disabled={!canMatch} type="button">
          {busy === "match" ? <Loader2 className="animate-spin" /> : <Search />}
          查找 RAW
        </Button>
        <Button variant="accent" onClick={onExport} disabled={!canExport} type="button">
          {busy === "export" ? <Loader2 className="animate-spin" /> : <Download />}
          导出对应 RAW
        </Button>
        <Separator orientation="vertical" className="hidden h-8 sm:block" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="清空当前任务"
              variant="ghost"
              size="icon"
              onClick={onClear}
              disabled={busy !== null}
              type="button"
            >
              <RotateCcw />
              <span className="sr-only">清空</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>清空当前任务</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function ResultTable({
  results,
  onConflictClick,
  onOpenPath,
}: {
  results: MatchResult[];
  onConflictClick: (index: number) => void;
  onOpenPath: (path: string) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="grid max-w-md justify-items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
            <Search className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">等待匹配结果</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              加入 JPG、选择 RAW 源目录后执行查找；冲突项会在这里进入复核流程。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">匹配结果</h2>
          <Badge variant="muted">{results.length} 条</Badge>
        </div>
        <p className="text-xs text-muted-foreground">单击缩略图可在系统中打开 RAW</p>
      </div>

      <div className="table-fade min-h-0 flex-1 overflow-auto">
        <table className="min-w-full table-auto border-collapse text-sm">
          <colgroup>
            <col className="w-[1%]" />
            <col className="w-[1%]" />
            <col className="w-[1%]" />
            <col className="w-[1%]" />
            <col className="w-[1%]" />
            <col />
          </colgroup>
          <thead className="bg-muted/55 text-[11px] font-semibold text-muted-foreground">
            <tr className="h-9 border-b border-border">
              <th className="whitespace-nowrap px-3 text-left">预览</th>
              <th className="whitespace-nowrap px-3 text-left">RAW</th>
              <th className="whitespace-nowrap px-3 text-left">状态</th>
              <th className="whitespace-nowrap px-3 text-left">JPG / 清单</th>
              <th className="whitespace-nowrap px-3 text-right">候选</th>
              <th className="whitespace-nowrap px-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {results.map((result, index) => (
              <tr
                className={cn(
                  "h-16 transition-colors hover:bg-muted/70",
                  result.status === "conflict" && "bg-destructive/7 hover:bg-destructive/12",
                )}
                key={result.jpeg.path}
              >
                <td className="whitespace-nowrap px-3 py-2 align-middle">
                  <RawThumbnail
                    candidate={result.selectedRaw ?? result.candidates[0] ?? null}
                    onOpen={onOpenPath}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-middle">
                  <span
                    className="block max-w-60 truncate font-mono text-xs font-semibold"
                    title={result.selectedRaw?.path ?? ""}
                  >
                    {rawResultLabel(result)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-middle">
                  <StatusBadge status={result.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-middle">
                  <span
                    className="block max-w-56 truncate font-medium"
                    title={result.jpeg.manual ? result.jpeg.fileName : result.jpeg.path}
                  >
                    {result.jpeg.fileName}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-middle font-mono text-xs tabular-nums text-muted-foreground">
                  {result.candidates.length}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-middle">
                  {result.status === "conflict" ? (
                    <Button
                      aria-label={`复核 ${result.jpeg.fileName}`}
                      variant="utility"
                      size="sm"
                      onClick={() => onConflictClick(index)}
                      type="button"
                    >
                      复核
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" aria-hidden="true">
                      -
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RawThumbnail({
  candidate,
  onOpen,
}: {
  candidate: RawCandidate | null;
  onOpen: (path: string) => void;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl("");
    setFailed(false);

    if (!candidate) {
      return () => {
        cancelled = true;
      };
    }

    invoke<string>("raw_thumbnail_path", { path: candidate.path })
      .then((thumbnailPath) => {
        if (!cancelled) {
          setThumbnailUrl(convertFileSrc(thumbnailPath));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [candidate?.path]);

  return (
    <button
      aria-label={candidate ? `打开 RAW 缩略图 ${candidate.fileName}` : "无 RAW 缩略图"}
      className="grid size-11 place-items-center overflow-hidden rounded-[5px] border border-border bg-card text-muted-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)] transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
      disabled={!candidate}
      onClick={(event) => {
        event.stopPropagation();
        if (candidate) {
          onOpen(candidate.path);
        }
      }}
      title={candidate?.fileName ?? "无 RAW 缩略图"}
      type="button"
    >
      {thumbnailUrl ? (
        <img
          className="size-full object-cover"
          src={thumbnailUrl}
          alt={candidate?.fileName ?? "RAW 缩略图"}
          loading="lazy"
        />
      ) : (
        <FileArchive className={cn("size-4", failed && "opacity-45")} />
      )}
    </button>
  );
}

function InspectorPane({
  counts,
  exportableCount,
  logs,
}: {
  counts: Record<MatchStatus, number>;
  exportableCount: number;
  logs: LogEntry[];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <section className="rounded-lg border border-border bg-card/92 p-3 shadow-[0_1px_0_rgba(255,255,255,0.72)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">任务统计</h2>
          <Badge variant="accent">{exportableCount} 可导出</Badge>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="匹配" value={counts.matched} tone="success" />
          <StatTile label="已确认" value={counts.confirmed} tone="success" />
          <StatTile label="冲突" value={counts.conflict} tone="danger" />
          <StatTile label="缺失" value={counts.missing} />
        </div>
      </section>

      <LogPanel logs={logs} />
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div className="rounded-[7px] border border-border bg-background/80 p-2.5 shadow-[0_1px_0_rgba(255,255,255,0.72)]">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "mt-1 block font-mono text-2xl leading-none tabular-nums",
          tone === "success" && "text-success",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </strong>
    </div>
  );
}

function LogPanel({ logs }: { logs: LogEntry[] }) {
  return (
    <section
      aria-label="运行日志"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-panel bg-panel text-panel-foreground"
    >
      <div className="flex h-11 items-center justify-between border-b border-white/10 px-3">
        <h2 className="text-sm font-semibold">运行日志</h2>
        <Badge variant="outline" className="border-white/15 bg-white/6 text-panel-foreground">
          {logs.length}
        </Badge>
      </div>
      <ScrollArea className="log-surface min-h-0 flex-1">
        <div className="divide-y divide-white/8 py-1 font-mono text-[12px]">
          {logs.map((log, index) => (
            <div
              className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 px-3 py-2"
              key={`${log.message}-${index}`}
            >
              <span className="grid gap-1">
                <span className="text-accent tabular-nums">{String(index + 1).padStart(3, "0")}</span>
                <span
                  className={cn(
                    "h-5 w-10 rounded-[3px] border text-center text-[10px] font-semibold uppercase leading-5",
                    log.level === "info" && "border-white/15 text-panel-foreground/70",
                    log.level === "success" && "border-success/40 bg-success/12 text-success",
                    log.level === "warning" && "border-warning/45 bg-warning/12 text-warning",
                    log.level === "error" && "border-destructive/45 bg-destructive/12 text-destructive",
                  )}
                  title={log.level}
                >
                  {logLevelCode[log.level]}
                </span>
              </span>
              <p className="min-w-0 [overflow-wrap:anywhere] text-panel-foreground/88">
                {log.message}
              </p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

function FooterStatus({
  activeWorkspace,
  jpegCount,
  rawDirectory,
  busy,
}: {
  activeWorkspace: WorkspaceId;
  jpegCount: number;
  rawDirectory: string;
  busy: RawBusy;
}) {
  return (
    <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-border bg-card/92 px-4 text-[11px] text-muted-foreground">
      <span className="truncate">
        {activeWorkspace === "raw-jpeg-matcher"
          ? `JPG ${jpegCount} · RAW ${rawDirectory ? "已选择" : "未选择"}`
          : "添加水印 · 选择图片目录后批量导出"}
      </span>
      <span className="font-mono tabular-nums">{busy ? busyLabel(busy) : "READY"}</span>
    </footer>
  );
}

function PathDisplay({
  path,
  fallback,
  compact = false,
  className,
}: {
  path: string;
  fallback: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center overflow-x-auto rounded-[5px] border border-input bg-background px-2.5 font-mono text-xs text-muted-foreground",
        compact ? "h-9" : "min-h-10",
        className,
      )}
      title={path || fallback}
    >
      <span className="min-w-max whitespace-nowrap py-2">{path || fallback}</span>
    </div>
  );
}

function FileList({
  files,
  onOpen,
}: {
  files: JpegInput[];
  onOpen: (path: string) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="rounded-[5px] border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        等待输入
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {files.slice(0, 6).map((file) => (
        <button
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border border-border bg-background px-2 text-left text-xs transition-colors hover:border-accent hover:bg-accent/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:border-border disabled:hover:bg-background"
          disabled={file.manual}
          key={file.path}
          onClick={() => onOpen(file.path)}
          title={file.path}
          type="button"
        >
          {file.manual ? (
            <ClipboardList className="size-3.5 text-muted-foreground" />
          ) : (
            <FileImage className="size-3.5 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{file.fileName}</span>
          {file.manual ? <Badge variant="muted">清单</Badge> : null}
        </button>
      ))}
      {files.length > 6 ? (
        <div className="rounded-[5px] border border-dashed border-border bg-muted/60 px-2 py-1 text-center text-xs text-muted-foreground">
          另有 {files.length - 6} 个 JPG
        </div>
      ) : null}
    </div>
  );
}

function WatermarkImageList({
  images,
  onOpen,
}: {
  images: WatermarkImageInput[];
  onOpen: (path: string) => void;
}) {
  if (images.length === 0) {
    return (
      <div className="rounded-[5px] border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        等待图片目录
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {images.slice(0, 7).map((image) => (
        <button
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border border-border bg-background px-2 text-left text-xs transition-colors hover:border-accent hover:bg-accent/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          key={image.path}
          onClick={() => onOpen(image.path)}
          title={image.path}
          type="button"
        >
          <FileImage className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 truncate">{image.fileName}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{formatBytes(image.size)}</span>
        </button>
      ))}
      {images.length > 7 ? (
        <div className="rounded-[5px] border border-dashed border-border bg-muted/60 px-2 py-1 text-center text-xs text-muted-foreground">
          另有 {images.length - 7} 张图片
        </div>
      ) : null}
    </div>
  );
}

function WatermarkInputTable({
  images,
  onOpen,
}: {
  images: WatermarkImageInput[];
  onOpen: (path: string) => void;
}) {
  if (images.length === 0) {
    return (
      <div className="grid min-h-0 place-items-center p-6">
        <div className="grid max-w-md justify-items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
            <FileImage className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">等待图片输入</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              选择图片目录后，会递归收集 JPG、JPEG 和 PNG 图片。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">图片列表</h2>
          <Badge variant="muted">{images.length} 张</Badge>
        </div>
        <p className="text-xs text-muted-foreground">单击文件名可在系统中打开</p>
      </div>
      <div className="table-fade min-h-0 flex-1 overflow-auto">
        <table className="min-w-full table-auto border-collapse text-sm">
          <thead className="bg-muted/55 text-[11px] font-semibold text-muted-foreground">
            <tr className="h-9 border-b border-border">
              <th className="whitespace-nowrap px-3 text-left">文件</th>
              <th className="whitespace-nowrap px-3 text-left">相对路径</th>
              <th className="whitespace-nowrap px-3 text-right">大小</th>
              <th className="whitespace-nowrap px-3 text-right">修改时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {images.map((image) => (
              <tr className="h-12 transition-colors hover:bg-muted/70" key={image.path}>
                <td className="whitespace-nowrap px-3 py-2 align-middle">
                  <button
                    className="max-w-52 truncate text-left font-medium hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(image.path)}
                    title={image.path}
                    type="button"
                  >
                    {image.fileName}
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-middle">
                  <span className="block max-w-80 truncate font-mono text-xs text-muted-foreground">
                    {image.relativePath}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-middle font-mono text-xs text-muted-foreground">
                  {formatBytes(image.size)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-middle font-mono text-xs text-muted-foreground">
                  {formatTime(image.modifiedTime)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled = false,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const displayValue = formatValue ? formatValue(value) : String(value);

  return (
    <label className="grid gap-1.5 rounded-[5px] border border-border bg-background px-3 py-2 text-xs">
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-muted-foreground">
          {displayValue}
          {suffix}
        </span>
      </span>
      <input
        aria-label={label}
        className="h-2 w-full accent-[var(--accent)] disabled:opacity-45"
        name={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function WatermarkExportCompleteDialog({
  report,
  onClose,
  onOpenDirectory,
}: {
  report: WatermarkExportReport;
  onClose: () => void;
  onOpenDirectory: (path: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(openState) => !openState && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="success">导出完成</Badge>
            <DialogTitle>水印图片导出完成</DialogTitle>
          </div>
          <DialogDescription>{report.directory}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 p-4">
          <StatTile label="成功" value={report.summary.exportedCount} tone="success" />
          <StatTile label="跳过" value={report.summary.skippedCount} />
          <StatTile label="失败" value={report.summary.failedCount} tone="danger" />
          <StatTile label="文件名冲突" value={report.summary.collisionCount} tone="danger" />
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

function StatusBadge({ status }: { status: MatchStatus }) {
  const variant =
    status === "matched" || status === "confirmed"
      ? "success"
      : status === "conflict"
        ? "destructive"
        : "muted";

  return (
    <Badge variant={variant}>
      <span className="[&_svg]:size-3.5">{statusIcon[status]}</span>
      {statusLabel[status]}
    </Badge>
  );
}

function ManualInputDialog({
  open,
  value,
  busy,
  onValueChange,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  value: string;
  busy: RawBusy;
  onValueChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="accent">文本清单</Badge>
            <DialogTitle>按文本加入 JPG 清单</DialogTitle>
          </div>
          <DialogDescription>
            每行一条，可以是完整文件名，也可以只是文件名后几位。
          </DialogDescription>
        </DialogHeader>

        <div className="p-4">
          <textarea
            aria-label="JPG 文本清单"
            className="min-h-56 w-full resize-y rounded-[5px] border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
            name="manualJpegList"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={"5N6A5022.JPG\n5023\nA5024"}
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
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  busy: RawBusy;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="destructive">确认清空</Badge>
            <DialogTitle>清空当前任务？</DialogTitle>
          </div>
          <DialogDescription>
            将移除已加入的 JPG / 文本清单、RAW 源目录、匹配结果和运行日志。
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
  report,
  onClose,
  onOpenDirectory,
}: {
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
            <DialogTitle>RAW 文件导出完成</DialogTitle>
          </div>
          <DialogDescription>{report.directory}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 p-4">
          <StatTile label="已复制" value={report.summary.copiedCount} tone="success" />
          <StatTile label="未找到" value={report.summary.skippedMissingCount} />
          <StatTile label="未解决冲突" value={report.summary.skippedConflictCount} tone="danger" />
          <StatTile label="文件名冲突" value={report.summary.collisionCount} tone="danger" />
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
  open,
  result,
  resultIndex,
  onOpenChange,
  onConfirm,
  onOpenPath,
}: {
  open: boolean;
  result: MatchResult;
  resultIndex: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (resultIndex: number, candidate: RawCandidate) => void;
  onOpenPath: (path: string) => void;
}) {
  const [selectedCandidate, setSelectedCandidate] = useState<RawCandidate | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedCandidate(null);
  }, [open, result.jpeg.path]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="destructive">冲突复核</Badge>
            <DialogTitle className="min-w-0 truncate">{result.jpeg.fileName}</DialogTitle>
          </div>
          <DialogDescription>
            选择正确的 RAW 候选。双击文件名可以用系统默认应用打开原文件。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(280px,0.82fr)_minmax(360px,1.18fr)]">
          <section className="grid content-start gap-3 rounded-md border border-border bg-background p-3">
            <button
              className="grid min-h-28 place-items-center rounded-[5px] border border-dashed border-accent/35 bg-accent/8 p-4 text-center transition-colors hover:border-accent hover:bg-accent/12"
              onClick={() => onOpenPath(result.jpeg.path)}
              type="button"
            >
              <span className="grid size-10 place-items-center rounded-[5px] border border-accent/30 bg-card text-accent">
                <FileImage className="size-5" />
              </span>
              <strong className="mt-3 text-sm">使用系统默认 App 打开 JPG</strong>
              <span className="mt-1 text-xs text-muted-foreground">点击此处查看原图</span>
            </button>
            <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-card p-3 text-xs">
              <dt className="text-muted-foreground">文件</dt>
              <dd className="min-w-0 truncate">{result.jpeg.fileName}</dd>
              <dt className="text-muted-foreground">路径</dt>
              <dd className="min-w-0 truncate" title={result.jpeg.path}>
                {result.jpeg.path}
              </dd>
              <dt className="text-muted-foreground">大小</dt>
              <dd>{formatBytes(result.jpeg.size)}</dd>
              <dt className="text-muted-foreground">修改时间</dt>
              <dd>{formatTime(result.jpeg.modifiedTime)}</dd>
            </dl>
            <Button variant="utility" onClick={() => onOpenPath(result.jpeg.path)} type="button">
              <ExternalLink />
              打开 JPG
            </Button>
          </section>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background">
            <div className="flex h-10 items-center justify-between border-b border-border px-3">
              <h3 className="text-sm font-semibold">RAW 候选</h3>
              <Badge variant="muted">{result.candidates.length}</Badge>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid gap-2 p-3">
                {result.candidates.map((candidate) => (
                  <button
                    className={cn(
                      "grid min-h-20 gap-1 rounded-[5px] border border-border bg-card p-3 text-left transition-colors hover:border-accent hover:bg-accent/6",
                      selectedCandidate?.path === candidate.path &&
                        "border-accent bg-accent/10 shadow-[inset_3px_0_0_var(--accent)]",
                    )}
                    key={candidate.path}
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
            确认 RAW
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function normalizeDialogSelection(selection: string | string[] | null): string[] {
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

async function createTextWatermarkSource(
  text: string,
): Promise<WatermarkSource> {
  return {
    type: "text",
    text: text.trim() || "Watermark",
  };
}

async function renderTextWatermarkPreview(text: string, config: WatermarkConfig) {
  const canvas = createTextWatermarkCanvas(text, config);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("无法生成水印预览"));
      }
    }, "image/png");
  });

  return URL.createObjectURL(blob);
}

function createTextWatermarkCanvas(text: string, config: WatermarkConfig) {
  const canvas = document.createElement("canvas");
  const measureContext = canvas.getContext("2d");
  if (!measureContext) {
    throw new Error("无法创建文字水印画布");
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const safeLines = lines.length > 0 ? lines : ["Watermark"];
  const fontSize = 72;
  const padding = 52;
  const lineHeight = fontSize * 1.22;
  measureContext.font = `700 ${fontSize}px ${getComputedStyle(document.documentElement).fontFamily}`;
  const textWidth = Math.max(
    ...safeLines.map((line) => measureContext.measureText(line).width),
    240,
  );

  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = Math.ceil(safeLines.length * lineHeight + padding * 2);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建文字水印画布");
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `700 ${fontSize}px ${getComputedStyle(document.documentElement).fontFamily}`;
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.shadowColor = `rgba(0, 0, 0, ${Math.min(0.55, config.shadowStrength * 0.8)})`;
  context.shadowBlur = 20 * config.shadowStrength;
  context.shadowOffsetX = 6 * config.shadowStrength;
  context.shadowOffsetY = 8 * config.shadowStrength;
  context.fillStyle = "rgba(255, 255, 255, 0.96)";

  safeLines.forEach((line, index) => {
    context.fillText(
      line,
      canvas.width / 2,
      padding + lineHeight * index + lineHeight / 2,
    );
  });

  return canvas;
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

function rawResultLabel(result: MatchResult) {
  if (result.selectedRaw) {
    return result.selectedRaw.fileName;
  }
  if (result.status === "conflict") {
    return `${result.candidates.length} 个 RAW 候选`;
  }
  return "-";
}

function inferLogLevel(message: string): LogLevel {
  if (/失败|错误|不存在|不是目录|无法/.test(message)) {
    return "error";
  }
  if (/跳过|冲突|未找到|缺少|重复/.test(message)) {
    return "warning";
  }
  if (/完成|已匹配|已导出|已确认|已加入|已复制|准备完成|扫描完成/.test(message)) {
    return "success";
  }
  return "info";
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function getUpdateButtonLabel(
  status: UpdateStatus,
  pendingUpdate: Update | null,
  progress: UpdateProgress,
) {
  const progressPercent = getUpdateProgressPercent(progress);

  if (status === "checking") {
    return "检查中";
  }
  if (status === "available") {
    return `新版本 ${pendingUpdate?.version ?? ""}`.trim();
  }
  if (status === "downloading") {
    return progressPercent === null ? "下载中" : `下载 ${progressPercent}%`;
  }
  if (status === "installing") {
    return "安装中";
  }
  if (status === "installed") {
    return "重启中";
  }
  if (status === "notAvailable") {
    return "已是最新";
  }
  if (status === "error") {
    return "更新失败";
  }
  return "检查更新";
}

function getUpdatePrimaryActionLabel(status: UpdateStatus, pendingUpdate: Update | null) {
  if (status === "checking") {
    return "检查中";
  }
  if (status === "downloading") {
    return "下载中";
  }
  if (status === "installing") {
    return "安装中";
  }
  if (status === "installed") {
    return "正在重启";
  }
  if (pendingUpdate) {
    return "立即更新";
  }
  return "重新检查";
}

function getUpdateBadgeLabel(status: UpdateStatus) {
  if (status === "available") {
    return "有新版本";
  }
  if (status === "checking") {
    return "检查中";
  }
  if (status === "downloading") {
    return "下载中";
  }
  if (status === "installing") {
    return "安装中";
  }
  if (status === "installed") {
    return "已安装";
  }
  if (status === "notAvailable") {
    return "最新";
  }
  if (status === "error") {
    return "失败";
  }
  return "待检查";
}

function getUpdateBadgeVariant(status: UpdateStatus) {
  if (status === "available" || status === "downloading" || status === "installing") {
    return "accent";
  }
  if (status === "notAvailable" || status === "installed") {
    return "success";
  }
  if (status === "error") {
    return "destructive";
  }
  return "secondary";
}

function getUpdateProgressPercent(progress: UpdateProgress) {
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return null;
  }
  return Math.min(
    100,
    Math.max(0, Math.round((progress.downloadedBytes / progress.totalBytes) * 100)),
  );
}

function formatUpdateError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (/404|Not Found/i.test(rawMessage)) {
    return "未找到更新清单，请确认 Gitee 仓库已发布 release/latest.json。";
  }
  if (/signature|pubkey|verify/i.test(rawMessage)) {
    return "更新签名校验失败，请确认 latest.json 中的 signature 来自本次构建产物。";
  }
  if (/network|fetch|timeout|timed out/i.test(rawMessage)) {
    return "连接更新源失败，请稍后重试或检查当前网络。";
  }
  return rawMessage || "检查更新失败。";
}

function busyLabel(busy: Exclude<RawBusy, null>) {
  return {
    collect: "SCANNING",
    match: "MATCHING",
    export: "EXPORTING",
  }[busy];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(timestamp: number | null) {
  if (!timestamp) {
    return "-";
  }
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    hour12: false,
  });
}

export default App;
