import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  FileArchive,
  FileImage,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
} from "./types";

const rawFormats = ["CR2", "CR3", "NEF", "ARW", "RAF", "ORF", "RW2", "DNG"];
type LogLevel = "info" | "success" | "warning" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
}

interface ExportReport {
  directory: string;
  summary: ExportSummary;
}

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
  const [jpegInputs, setJpegInputs] = useState<JpegInput[]>([]);
  const [manualText, setManualText] = useState("");
  const [rawSourceDirectory, setRawSourceDirectory] = useState("");
  const [results, setResults] = useState<MatchResult[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([
    { level: "info", message: "等待拖入 JPG 文件、目录或粘贴清单" },
  ]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState<"collect" | "match" | "export" | null>(null);
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

    getCurrentWebview()
      .onDragDropEvent((event) => {
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
  }, [jpegInputs]);

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

  return (
    <TooltipProvider>
      <main className="desk-grid h-screen overflow-hidden text-foreground">
        <div className="grid h-full grid-rows-[88px_minmax(0,1fr)_32px]">
          <AppHeader
            jpegCount={jpegInputs.length}
            counts={counts}
            exportableCount={exportableCount}
          />

          <div className="grid min-h-0 grid-cols-1 overflow-auto min-[1100px]:grid-cols-[320px_minmax(0,1fr)_320px] min-[1100px]:overflow-hidden">
            <aside className="min-h-0 border-r border-border bg-background/80">
              <ScrollArea className="h-full min-h-0">
                <div className="grid min-h-[720px] gap-3 p-3 pb-6 min-[1100px]:min-h-0">
                <InputPane
                  busy={busy}
                  dragActive={dragActive}
                  jpegInputs={jpegInputs}
                  rawSourceDirectory={rawSourceDirectory}
                  selectedRawFormats={selectedRawFormats}
                  onOpenManualDialog={() => setManualDialogOpen(true)}
                  onChooseJpegFiles={chooseJpegFiles}
                  onChooseJpegDirectories={chooseJpegDirectories}
                  onChooseRawDirectory={chooseRawDirectory}
                  onOpenJpeg={openOriginal}
                  onToggleRawFormat={toggleRawFormat}
                  onSelectAllRawFormats={selectAllRawFormats}
                />
                </div>
              </ScrollArea>
            </aside>

            <section className="flex min-h-[720px] min-w-0 flex-col border-r border-border bg-card/72 min-[1100px]:min-h-0">
              <WorkbenchToolbar
                busy={busy}
                canMatch={canMatch}
                canExport={canExport}
                onMatch={findRawFiles}
                onExport={exportRawFiles}
                onClear={() => setClearDialogOpen(true)}
              />
              <ResultTable
                results={results}
                onConflictClick={setActiveConflictIndex}
                onOpenPath={openOriginal}
              />
            </section>

            <aside className="flex min-h-[720px] min-w-0 flex-col bg-background/80 min-[1100px]:min-h-0">
              <InspectorPane counts={counts} exportableCount={exportableCount} logs={logs} />
            </aside>
          </div>

          <FooterStatus
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
    <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border bg-card/92 px-4 shadow-[0_1px_0_rgba(18,24,31,0.04)] backdrop-blur">
      <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
        <span className="grid size-16 place-items-center overflow-visible rounded-[14px]">
          <img className="size-full object-contain" src={appIcon} alt="" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[18px] font-semibold leading-none">照片配对助手</h1>
            <Badge variant="accent" className="shrink-0">
              Mac Desk
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            本地扫描、冲突复核、按 JPG 清单导出 RAW 原片
          </p>
        </div>
      </div>

      <div className="hidden items-center gap-2 lg:flex">
        <HeaderMetric label="JPG" value={jpegCount} />
        <HeaderMetric label="匹配" value={counts.matched} tone="success" />
        <HeaderMetric label="冲突" value={counts.conflict} tone="danger" />
        <HeaderMetric label="可导出" value={exportableCount} tone="accent" />
      </div>
    </header>
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
    <div className="grid h-10 min-w-20 grid-cols-[1fr_auto] items-center gap-2 rounded-[5px] border border-border bg-background px-2.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "font-mono text-[18px] leading-none tabular-nums",
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
  busy: "collect" | "match" | "export" | null;
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
            "drop-raster grid min-h-28 place-items-center rounded-md border border-dashed border-border p-4 text-center transition-[border-color,box-shadow,transform] duration-150 hover:border-accent focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60",
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
    <section className="rounded-md border border-border bg-card p-3 shadow-[0_1px_0_rgba(18,24,31,0.04)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-[5px] border border-border bg-muted text-muted-foreground">
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
  busy: "collect" | "match" | "export" | null;
  canMatch: boolean;
  canExport: boolean;
  onMatch: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="border-b border-border bg-card px-3 py-3">
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
            <Button variant="ghost" size="icon" onClick={onClear} disabled={busy !== null} type="button">
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
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {results.map((result, index) => (
              <tr
                className={cn(
                  "h-16 transition-colors hover:bg-muted/70",
                  result.status === "conflict" && "cursor-pointer",
                  result.status === "conflict" && "bg-destructive/7 hover:bg-destructive/12",
                )}
                key={result.jpeg.path}
                onClick={() => {
                  if (result.status === "conflict") {
                    onConflictClick(index);
                  }
                }}
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
                <td aria-hidden="true" />
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
      className="grid size-11 place-items-center overflow-hidden rounded-[5px] border border-border bg-card text-muted-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)] transition-colors hover:border-accent focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-default disabled:opacity-60"
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
      <section className="rounded-md border border-border bg-card p-3">
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
    <div className="rounded-[5px] border border-border bg-background p-2.5">
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
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-panel bg-panel text-panel-foreground">
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
  jpegCount,
  rawDirectory,
  busy,
}: {
  jpegCount: number;
  rawDirectory: string;
  busy: "collect" | "match" | "export" | null;
}) {
  return (
    <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-border bg-card/92 px-4 text-[11px] text-muted-foreground">
      <span className="truncate">JPG {jpegCount} · RAW {rawDirectory ? "已选择" : "未选择"}</span>
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
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border border-border bg-background px-2 text-left text-xs transition-colors hover:border-accent hover:bg-accent/6 focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-default disabled:hover:border-border disabled:hover:bg-background"
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
  busy: "collect" | "match" | "export" | null;
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
            className="min-h-56 w-full resize-y rounded-[5px] border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={"5N6A5022.JPG\n5023\nA5024"}
            disabled={busy !== null}
            autoFocus
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
  busy: "collect" | "match" | "export" | null;
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

function busyLabel(busy: "collect" | "match" | "export") {
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
