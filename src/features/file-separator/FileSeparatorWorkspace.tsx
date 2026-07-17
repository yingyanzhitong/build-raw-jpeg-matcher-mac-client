import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Files,
  FileImage,
  FolderInput,
  FolderOutput,
  Loader2,
  PanelBottom,
  RotateCcw,
  Split,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  exportFailureFeedback,
  separatorExportFeedback,
  type ExportFeedback,
} from "@/features/shared/exportFeedback";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  inferLogLevel,
  Pane,
  PathDisplay,
  StatTile,
  type LogEntry,
  type LogLevel,
} from "@/features/shared/ui";
import type {
  SeparatedFile,
  SeparatorExportMode,
  SeparatorExportResponse,
  SeparatorExportSummary,
  SeparatorScanResponse,
} from "./types";

type SeparatorBusy = "scan" | "export" | null;

interface ExportReport {
  directory: string;
  mode: SeparatorExportMode;
  summary: SeparatorExportSummary;
}

const previewLimit = 160;
const initialSeparatorLogs: LogEntry[] = [
  { level: "info", message: "等待选择包含图片与 RAW 的混合文件夹" },
];

export interface SeparatorWorkspaceStatus {
  logs: LogEntry[];
  fileCount: number;
  imageCount: number;
  rawCount: number;
  skippedCount: number;
  hasExportReport: boolean;
}

export const defaultSeparatorWorkspaceStatus: SeparatorWorkspaceStatus = {
  logs: initialSeparatorLogs,
  fileCount: 0,
  imageCount: 0,
  rawCount: 0,
  skippedCount: 0,
  hasExportReport: false,
};

export function FileSeparatorWorkspace({
  active,
  logPanelOpen,
  onExportFeedback,
  onStatusChange,
  onToggleLogPanel,
}: {
  active: boolean;
  logPanelOpen: boolean;
  onExportFeedback: (feedback: ExportFeedback) => void;
  onStatusChange: (status: SeparatorWorkspaceStatus) => void;
  onToggleLogPanel: () => void;
}) {
  const [inputRoot, setInputRoot] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [exportMode, setExportMode] = useState<SeparatorExportMode>("copy");
  const [images, setImages] = useState<SeparatedFile[]>([]);
  const [raws, setRaws] = useState<SeparatedFile[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [busy, setBusy] = useState<SeparatorBusy>(null);
  const [logs, setLogs] = useState<LogEntry[]>(initialSeparatorLogs);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);
  const [moveConfirmOpen, setMoveConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const fileCount = images.length + raws.length;
  const exportDirectory = exportMode === "moveInPlace" ? inputRoot : outputRoot;
  const canExport = inputRoot.length > 0 && exportDirectory.length > 0 && fileCount > 0 && busy === null;
  const actionHint = getExportHint({ inputRoot, outputRoot, exportMode, fileCount, busy });
  const inputStepComplete = inputRoot.length > 0;
  const outputStepComplete =
    inputStepComplete && (exportMode === "moveInPlace" || outputRoot.length > 0);
  const shortcutsRef = useRef({ chooseInputDirectory, chooseOutputDirectory, startExport });
  shortcutsRef.current = { chooseInputDirectory, chooseOutputDirectory, startExport };

  useEffect(() => {
    if (!active) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTextEditing || event.defaultPrevented || (!event.metaKey && !event.ctrlKey)) {
        return;
      }

      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (event.shiftKey) {
          void shortcutsRef.current.chooseOutputDirectory();
        } else {
          void shortcutsRef.current.chooseInputDirectory();
        }
      } else if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        shortcutsRef.current.startExport();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  useEffect(() => {
    onStatusChange({
      logs,
      fileCount,
      imageCount: images.length,
      rawCount: raws.length,
      skippedCount,
      hasExportReport: exportReport !== null,
    });
  }, [exportReport, fileCount, images.length, logs, onStatusChange, raws.length, skippedCount]);

  function appendLogs(messages: string[], level?: LogLevel) {
    const entries = messages.map((message) => ({
      level: level ?? inferLogLevel(message),
      message,
    }));
    setLogs((current) => [...current, ...entries].slice(-300));
  }

  async function chooseInputDirectory() {
    if (busy !== null) {
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择包含图片与 RAW 的混合文件夹",
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("scan");
    try {
      const response = await invoke<SeparatorScanResponse>("scan_separator_source", {
        root: selected,
      });
      setInputRoot(response.rootDir);
      setOutputRoot("");
      setImages(response.images);
      setRaws(response.raws);
      setSkippedCount(response.skippedCount);
      setExportReport(null);
      setLogs(
        response.logs.map((message) => ({
          level: inferLogLevel(message),
          message,
        })),
      );
    } catch (error) {
      appendLogs([`扫描混合文件夹失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function chooseOutputDirectory() {
    if (busy !== null) {
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择分离输出目录",
      canCreateDirectories: true,
    });
    if (typeof selected !== "string") {
      return;
    }

    setOutputRoot(selected);
    setExportMode("copy");
    setExportReport(null);
    appendLogs([`已选择分离输出目录: ${selected}`], "success");
  }

  function selectMoveInPlace() {
    if (busy !== null || inputRoot.length === 0) {
      return;
    }
    setExportMode("moveInPlace");
    setExportReport(null);
  }

  function startExport() {
    if (!canExport) {
      appendLogs([actionHint], "warning");
      return;
    }

    if (exportMode === "moveInPlace") {
      setMoveConfirmOpen(true);
      return;
    }

    void exportFiles();
  }

  async function exportFiles() {
    if (!canExport) {
      appendLogs([actionHint], "warning");
      return;
    }

    setMoveConfirmOpen(false);
    setBusy("export");
    try {
      const response = await invoke<SeparatorExportResponse>("export_separated_files", {
        inputRoot,
        files: [...images, ...raws],
        exportDir: exportDirectory,
        mode: exportMode,
      });
      appendLogs(response.logs);
      setExportReport({ directory: exportDirectory, mode: exportMode, summary: response.summary });
      onExportFeedback(separatorExportFeedback(response.summary, exportMode));
      if (exportMode === "moveInPlace") {
        setImages([]);
        setRaws([]);
        setSkippedCount(0);
      }
    } catch (error) {
      appendLogs([`分离文件失败: ${String(error)}`], "error");
      onExportFeedback(exportFailureFeedback("一键分离", error));
    } finally {
      setBusy(null);
    }
  }

  async function openOutputDirectory(path: string) {
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      appendLogs([`打开输出目录失败: ${String(error)}`], "error");
    }
  }

  function clearWorkspace() {
    if (busy !== null) {
      return;
    }
    setInputRoot("");
    setOutputRoot("");
    setExportMode("copy");
    setImages([]);
    setRaws([]);
    setSkippedCount(0);
    setExportReport(null);
    setMoveConfirmOpen(false);
    setClearConfirmOpen(false);
    setLogs([{ level: "info", message: "已清空一键分离任务" }]);
  }

  return (
    <section
      aria-label="一键分离工作区"
      className={cn(
    "grid h-full min-h-0 grid-cols-1 overflow-auto bg-panel min-[960px]:grid-cols-[296px_minmax(0,1fr)] min-[960px]:overflow-hidden",
        !active && "hidden",
      )}
    >
      <aside className="mac-sidebar mac-inspector min-h-[520px] border-r border-border min-[960px]:min-h-0">
        <ScrollArea className="h-full min-h-0">
          <div className="grid min-h-[600px] content-start gap-0 px-3 pb-6 pt-3 min-[960px]:min-h-0">
            <Pane
              complete={inputStepComplete}
              current={!inputStepComplete}
              icon={<FolderInput className="size-4" />}
              step={1}
              title="混合文件夹"
              subtitle={fileCount > 0 ? `已识别 ${fileCount} 个文件` : "包含图片与 RAW"}
            >
              <PathDisplay path={inputRoot} fallback="尚未选择混合文件夹" />
              <Button disabled={busy !== null} onClick={chooseInputDirectory} type="button">
                {busy === "scan" ? <Loader2 className="animate-spin" /> : <FolderInput />}
                选择混合文件夹
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                递归识别 JPG、JPEG、PNG 与已支持的 RAW 格式。
              </p>
            </Pane>

            <Pane
              complete={outputStepComplete}
              current={inputStepComplete && !outputStepComplete}
              icon={<FolderOutput className="size-4" />}
              step={2}
              title="处理方式"
              subtitle={exportMode === "copy" ? "复制到新文件夹" : "当前文件夹内移动"}
            >
              <div aria-label="分离处理方式" className="grid grid-cols-2 gap-2" role="group">
                <Button
                  aria-pressed={exportMode === "copy"}
                  disabled={busy !== null || inputRoot.length === 0}
                  onClick={() => {
                    setExportMode("copy");
                    setExportReport(null);
                  }}
                  size="sm"
                  type="button"
                  variant={exportMode === "copy" ? "accent" : "utility"}
                >
                  新目录复制
                </Button>
                <Button
                  aria-pressed={exportMode === "moveInPlace"}
                  disabled={busy !== null || inputRoot.length === 0}
                  onClick={selectMoveInPlace}
                  size="sm"
                  type="button"
                  variant={exportMode === "moveInPlace" ? "accent" : "utility"}
                >
                  当前目录移动
                </Button>
              </div>

              {exportMode === "copy" ? (
                <>
                  <PathDisplay path={outputRoot} fallback="尚未选择输出目录" />
                  <Button
                    disabled={busy !== null || inputRoot.length === 0}
                    onClick={chooseOutputDirectory}
                    variant="utility"
                    type="button"
                  >
                    <FolderOutput />
                    选择输出目录
                  </Button>
                  <p className="text-xs leading-5 text-muted-foreground">
                    保留源目录结构并复制文件；原始文件不会移动或改写。
                  </p>
                </>
              ) : (
                <>
                  <PathDisplay path={inputRoot} fallback="请先选择混合文件夹" />
                  <p className="flex gap-2 text-xs leading-5 text-warning">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    将在当前文件夹创建“图片”和“RAW”目录，并移动已识别文件；源文件不会保留。
                  </p>
                </>
              )}
            </Pane>
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[620px] min-w-0 flex-col bg-card min-[960px]:min-h-0">
        <header className="mac-workbench-toolbar flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">一键分离</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">{actionHint}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button disabled={!canExport} onClick={startExport} type="button">
              {busy === "export" ? <Loader2 className="animate-spin" /> : <Split />}
              {exportMode === "moveInPlace" ? "开始移动" : "开始复制"}
            </Button>
            <Separator orientation="vertical" className="h-8" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="清空一键分离任务"
                  disabled={busy !== null}
                  onClick={() => setClearConfirmOpen(true)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <RotateCcw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>清空当前任务</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={logPanelOpen ? "隐藏日志" : "显示日志"}
                  aria-pressed={logPanelOpen}
                  className={cn(
                    "size-9",
                    logPanelOpen && "border-accent/30 bg-accent/10 text-accent hover:bg-accent/14",
                  )}
                  variant="ghost"
                  size="icon"
                  onClick={onToggleLogPanel}
                  type="button"
                >
                  <PanelBottom />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{logPanelOpen ? "隐藏日志" : "显示日志"}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 overflow-auto p-5">
          <section
            className={cn(
              "flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden bg-card",
              inputRoot.length > 0 && "rounded-[10px] border border-border",
            )}
          >
            {inputRoot.length === 0 ? (
              <SeparatorEmptyState disabled={busy !== null} onChoose={chooseInputDirectory} />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 border-b border-border bg-card p-3">
                  <StatTile label="图片" value={images.length} tone="success" />
                  <StatTile label="RAW" value={raws.length} />
                  <StatTile label="已跳过" value={skippedCount} tone={skippedCount > 0 ? "danger" : "neutral"} />
                </div>
                <SeparatorFileTable images={images} raws={raws} />
              </>
            )}
          </section>
        </div>

        {exportReport ? (
          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-success/8 px-4 py-3 text-sm">
            <p className="min-w-0 truncate text-success">
              已完成分离：{exportReport.mode === "moveInPlace" ? "移动" : "复制"}{" "}
              {exportReport.mode === "moveInPlace"
                ? exportReport.summary.movedCount
                : exportReport.summary.copiedCount}
              个文件到“图片”和“RAW”目录。
            </p>
            <Button
              onClick={() => openOutputDirectory(exportReport.directory)}
              size="sm"
              type="button"
              variant="utility"
            >
              <FolderOutput />
              打开输出目录
            </Button>
          </footer>
        ) : null}
      </section>
      <MoveConfirmDialog
        fileCount={fileCount}
        inputRoot={inputRoot}
        onConfirm={() => void exportFiles()}
        onOpenChange={setMoveConfirmOpen}
        open={moveConfirmOpen}
      />
      <ClearSeparatorDialog
        onConfirm={clearWorkspace}
        onOpenChange={setClearConfirmOpen}
        open={clearConfirmOpen}
      />
    </section>
  );
}

function SeparatorEmptyState({
  disabled,
  onChoose,
}: {
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <div className="empty-workbench grid flex-1 place-items-center p-8 text-center">
      <div className="grid max-w-md justify-items-center gap-4">
        <span className="grid size-12 place-items-center rounded-[12px] bg-accent/10 text-accent">
          <Files className="size-6" />
        </span>
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.015em]">等待扫描混合文件夹</h3>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            选择目录后会预览可分离的图片和 RAW；可复制到新目录，或在当前目录内移动整理。
          </p>
        </div>
        <Button disabled={disabled} onClick={onChoose} type="button">
          <FolderInput />
          选择混合文件夹
        </Button>
      </div>
    </div>
  );
}

function MoveConfirmDialog({
  fileCount,
  inputRoot,
  onConfirm,
  onOpenChange,
  open,
}: {
  fileCount: number;
  inputRoot: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <AlertTriangle className="size-5 text-warning" />
            <DialogTitle>确认在当前目录移动文件</DialogTitle>
          </div>
          <DialogDescription>
            将在混合文件夹内创建“图片”和“RAW”目录，并移动 {fileCount} 个已识别文件。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 p-5">
          <PathDisplay fallback="当前混合文件夹" path={inputRoot} />
          <p className="text-sm leading-6 text-muted-foreground">
            移动完成后，原路径中的文件不再保留。遇到同名但内容不同的目标文件时会跳过，不会覆盖。
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            取消
          </Button>
          <Button onClick={onConfirm} type="button">
            确认移动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClearSeparatorDialog({
  onConfirm,
  onOpenChange,
  open,
}: {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>清空一键分离任务？</DialogTitle>
          <DialogDescription>
            将清空已选目录、扫描结果、导出结果和运行日志，不会删除或改动任何本地文件。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            取消
          </Button>
          <Button onClick={onConfirm} type="button" variant="destructive">
            清空任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SeparatorFileTable({
  images,
  raws,
}: {
  images: SeparatedFile[];
  raws: SeparatedFile[];
}) {
  const files = [...images, ...raws];
  const previewFiles = files.slice(0, previewLimit);

  return (
    <section aria-label="待分离文件预览" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <h3 className="text-sm font-semibold">待分离文件</h3>
        <span className="text-xs text-muted-foreground">
          {files.length > previewLimit ? `预览前 ${previewLimit} 个 / 共 ${files.length} 个` : `共 ${files.length} 个`}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-[460px] divide-y divide-border text-xs">
          <div className="grid grid-cols-[72px_minmax(0,1fr)_88px] gap-3 bg-secondary/72 px-4 py-2.5 text-[11px] font-medium text-muted-foreground">
            <span>类型</span>
            <span>相对路径</span>
            <span className="text-right">大小</span>
          </div>
          {previewFiles.map((file) => (
            <div
              className="grid grid-cols-[72px_minmax(0,1fr)_88px] items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/45"
              key={file.path}
            >
              <span
                className={cn(
                  "inline-flex w-fit items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-medium",
                  file.kind === "image"
                    ? "border-success/35 bg-success/10 text-success"
                    : "border-accent/30 bg-accent/10 text-accent",
                )}
              >
                {file.kind === "image" ? <FileImage className="size-3" /> : <Files className="size-3" />}
                {file.kind === "image" ? "图片" : "RAW"}
              </span>
              <span className="truncate font-mono text-foreground/85" title={file.relativePath}>
                {file.relativePath}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

function getExportHint({
  inputRoot,
  outputRoot,
  exportMode,
  fileCount,
  busy,
}: {
  inputRoot: string;
  outputRoot: string;
  exportMode: SeparatorExportMode;
  fileCount: number;
  busy: SeparatorBusy;
}) {
  if (busy === "scan") {
    return "正在扫描混合文件夹…";
  }
  if (busy === "export") {
    return exportMode === "moveInPlace" ? "正在移动分离文件…" : "正在复制分离文件…";
  }
  if (inputRoot.length === 0) {
    return "先选择包含图片与 RAW 的混合文件夹";
  }
  if (fileCount === 0) {
    return "未发现可分离的图片或 RAW 文件";
  }
  if (exportMode === "copy" && outputRoot.length === 0) {
    return "选择新输出目录后即可开始复制";
  }
  return exportMode === "moveInPlace"
    ? `将移动 ${fileCount} 个文件到当前目录的“图片”和“RAW”目录`
    : `将复制 ${fileCount} 个文件，原始文件保持不变`;
}
