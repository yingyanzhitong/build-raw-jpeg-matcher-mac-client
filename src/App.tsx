import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileArchive,
  FileImage,
  FolderOpen,
  Loader2,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

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
  InputCollection,
  JpegInput,
  MatchResponse,
  MatchResult,
  MatchStatus,
  RawCandidate,
} from "./types";

const rawFormats = ["CR2", "CR3", "NEF", "ARW", "RAF", "ORF", "RW2", "DNG"];

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

function App() {
  const [jpegInputs, setJpegInputs] = useState<JpegInput[]>([]);
  const [rawSourceDirectory, setRawSourceDirectory] = useState("");
  const [exportDirectory, setExportDirectory] = useState("");
  const [results, setResults] = useState<MatchResult[]>([]);
  const [logs, setLogs] = useState<string[]>(["等待拖入 JPG 文件或目录"]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState<"collect" | "match" | "export" | null>(null);
  const [activeConflictIndex, setActiveConflictIndex] = useState<number | null>(null);
  const [previewJpeg, setPreviewJpeg] = useState<JpegInput | null>(null);
  const [selectedRawFormats, setSelectedRawFormats] = useState<string[]>(rawFormats);

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
  const canExport = exportableCount > 0 && exportDirectory.length > 0 && busy === null;
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

  function appendLogs(nextLogs: string[]) {
    setLogs((current) => [...current, ...nextLogs].slice(-300));
  }

  async function collectInputs(paths: string[]) {
    if (paths.length === 0) {
      return;
    }

    setBusy("collect");
    try {
      const mergedInputs = [...jpegInputs.map((file) => file.path), ...paths];
      const collection = await invoke<InputCollection>("collect_jpeg_inputs", {
        inputs: mergedInputs,
      });
      setJpegInputs(collection.files);
      setResults([]);
      appendLogs(collection.logs);
    } catch (error) {
      appendLogs([`读取 JPEG 输入失败: ${String(error)}`]);
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

  async function chooseExportDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") {
      return;
    }
    setExportDirectory(selected);
    appendLogs([`已选择导出目录: ${selected}`]);
  }

  async function findRawFiles() {
    if (!canMatch) {
      appendLogs(["缺少 JPEG 输入、RAW 源目录或 RAW 格式选择，无法查找"]);
      return;
    }

    setBusy("match");
    try {
      const response = await invoke<MatchResponse>("match_raw_files", {
        inputs: jpegInputs.map((file) => file.path),
        rawRoot: rawSourceDirectory,
        rawExtensions: selectedRawFormats,
      });
      setJpegInputs(response.jpegInputs);
      setResults(response.results);
      appendLogs(response.logs);
    } catch (error) {
      appendLogs([`查找 RAW 失败: ${String(error)}`]);
    } finally {
      setBusy(null);
    }
  }

  async function exportRawFiles() {
    if (!canExport) {
      appendLogs(["缺少可导出的 RAW 或导出目录，无法导出"]);
      return;
    }

    setBusy("export");
    try {
      const response = await invoke<ExportResponse>("export_raw_files", {
        results,
        exportDir: exportDirectory,
      });
      appendLogs(response.logs);
    } catch (error) {
      appendLogs([`导出 RAW 失败: ${String(error)}`]);
    } finally {
      setBusy(null);
    }
  }

  async function openOriginal(path: string) {
    try {
      await openPath(path);
    } catch (error) {
      appendLogs([`打开原始文件失败: ${String(error)}`]);
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
    setResults([]);
    setRawSourceDirectory("");
    setExportDirectory("");
    setActiveConflictIndex(null);
    setPreviewJpeg(null);
    setSelectedRawFormats(rawFormats);
    setLogs(["已清空当前任务"]);
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
        <div className="grid h-full grid-rows-[64px_minmax(0,1fr)_32px]">
          <AppHeader
            jpegCount={jpegInputs.length}
            counts={counts}
            exportableCount={exportableCount}
            busy={busy}
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
                  exportDirectory={exportDirectory}
                  selectedRawFormats={selectedRawFormats}
                  onChooseJpegFiles={chooseJpegFiles}
                  onChooseJpegDirectories={chooseJpegDirectories}
                  onChooseRawDirectory={chooseRawDirectory}
                  onChooseExportDirectory={chooseExportDirectory}
                  onPreviewJpeg={setPreviewJpeg}
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
                exportDirectory={exportDirectory}
                onMatch={findRawFiles}
                onExport={exportRawFiles}
                onClear={clearAll}
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
            exportDirectory={exportDirectory}
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
            onLog={appendLogs}
          />
        ) : null}

        {previewJpeg ? (
          <JpegPreviewDialog
            open={previewJpeg !== null}
            jpeg={previewJpeg}
            onOpenChange={(openState) => {
              if (!openState) {
                setPreviewJpeg(null);
              }
            }}
            onOpenPath={openOriginal}
            onLog={appendLogs}
          />
        ) : null}
      </main>
    </TooltipProvider>
  );
}

function AppHeader({
  jpegCount,
  counts,
  exportableCount,
  busy,
}: {
  jpegCount: number;
  counts: Record<MatchStatus, number>;
  exportableCount: number;
  busy: "collect" | "match" | "export" | null;
}) {
  return (
    <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border bg-card/92 px-4 shadow-[0_1px_0_rgba(18,24,31,0.04)] backdrop-blur">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-[5px] border border-primary bg-primary text-primary-foreground">
            <FileImage className="size-4" />
          </span>
          <h1 className="truncate text-[18px] font-semibold leading-none">RAW/JPEG Matcher</h1>
          <Badge variant="accent">Mac Desk</Badge>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          本地扫描、冲突复核、按 JPG 清单导出 RAW 原片
        </p>
      </div>

      <div className="hidden items-center gap-2 lg:flex">
        <HeaderMetric label="JPG" value={jpegCount} />
        <HeaderMetric label="匹配" value={counts.matched} tone="success" />
        <HeaderMetric label="冲突" value={counts.conflict} tone="danger" />
        <HeaderMetric label="可导出" value={exportableCount} tone="accent" />
        <Badge variant={busy ? "warning" : "muted"} className="h-7">
          {busy ? busyLabel(busy) : "Idle"}
        </Badge>
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
  exportDirectory,
  selectedRawFormats,
  onChooseJpegFiles,
  onChooseJpegDirectories,
  onChooseRawDirectory,
  onChooseExportDirectory,
  onPreviewJpeg,
  onToggleRawFormat,
  onSelectAllRawFormats,
}: {
  busy: "collect" | "match" | "export" | null;
  dragActive: boolean;
  jpegInputs: JpegInput[];
  rawSourceDirectory: string;
  exportDirectory: string;
  selectedRawFormats: string[];
  onChooseJpegFiles: () => void;
  onChooseJpegDirectories: () => void;
  onChooseRawDirectory: () => void;
  onChooseExportDirectory: () => void;
  onPreviewJpeg: (file: JpegInput) => void;
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

        <div className="grid grid-cols-2 gap-2">
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
        </div>

        <FileList files={jpegInputs} onPreview={onPreviewJpeg} />
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
          <Button variant="ghost" size="sm" onClick={onSelectAllRawFormats} type="button">
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

      <Pane
        icon={<Download className="size-4" />}
        title="导出目标"
        subtitle="匹配后复制 RAW 文件"
      >
        <PathDisplay path={exportDirectory} fallback="导出目录未选择" />
        <Button
          variant="utility"
          onClick={onChooseExportDirectory}
          disabled={busy !== null}
          type="button"
        >
          <FolderOpen />
          选择导出目录
        </Button>
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
  exportDirectory,
  onMatch,
  onExport,
  onClear,
}: {
  busy: "collect" | "match" | "export" | null;
  canMatch: boolean;
  canExport: boolean;
  exportDirectory: string;
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
          导出匹配 RAW
        </Button>
        <Separator orientation="vertical" className="hidden h-8 sm:block" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onClear} disabled={busy !== null} type="button">
              <Trash2 />
              <span className="sr-only">清空</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>清空当前任务</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1" />
        <PathDisplay
          path={exportDirectory}
          fallback="导出目录未选择"
          compact
          className="hidden max-w-[360px] min-[1100px]:flex"
        />
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
        <p className="text-xs text-muted-foreground">双击 JPG 可在系统中打开</p>
      </div>

      <div className="grid h-9 grid-cols-[minmax(170px,1.2fr)_112px_minmax(150px,1fr)_72px] items-center gap-3 border-b border-border bg-muted/55 px-3 text-[11px] font-semibold text-muted-foreground">
        <span>JPG</span>
        <span>状态</span>
        <span>RAW</span>
        <span className="text-right">候选</span>
      </div>

      <ScrollArea className="table-fade min-h-0 flex-1">
        <div className="divide-y divide-border">
          {results.map((result, index) => (
            <button
              className={cn(
                "grid min-h-12 w-full grid-cols-[minmax(170px,1.2fr)_112px_minmax(150px,1fr)_72px] items-center gap-3 px-3 text-left text-sm transition-colors hover:bg-muted/70",
                result.status === "conflict" && "bg-destructive/7 hover:bg-destructive/12",
              )}
              key={result.jpeg.path}
              onClick={() => {
                if (result.status === "conflict") {
                  onConflictClick(index);
                }
              }}
              onDoubleClick={() => onOpenPath(result.jpeg.path)}
              type="button"
            >
              <span className="min-w-0 truncate font-medium" title={result.jpeg.path}>
                {result.jpeg.fileName}
              </span>
              <StatusBadge status={result.status} />
              <span
                className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                title={result.selectedRaw?.path ?? ""}
              >
                {result.selectedRaw?.fileName ?? "-"}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                {result.candidates.length}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

function InspectorPane({
  counts,
  exportableCount,
  logs,
}: {
  counts: Record<MatchStatus, number>;
  exportableCount: number;
  logs: string[];
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

function LogPanel({ logs }: { logs: string[] }) {
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
            <div className="grid grid-cols-[42px_minmax(0,1fr)] gap-2 px-3 py-2" key={`${log}-${index}`}>
              <span className="text-accent tabular-nums">{String(index + 1).padStart(3, "0")}</span>
              <p className="min-w-0 [overflow-wrap:anywhere] text-panel-foreground/88">{log}</p>
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
  exportDirectory,
  busy,
}: {
  jpegCount: number;
  rawDirectory: string;
  exportDirectory: string;
  busy: "collect" | "match" | "export" | null;
}) {
  return (
    <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-border bg-card/92 px-4 text-[11px] text-muted-foreground">
      <span className="truncate">
        JPG {jpegCount} · RAW {rawDirectory ? "已选择" : "未选择"} · 导出{" "}
        {exportDirectory ? "已选择" : "未选择"}
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
  onPreview,
}: {
  files: JpegInput[];
  onPreview: (file: JpegInput) => void;
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
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-[5px] border border-border bg-background px-2 text-left text-xs transition-colors hover:border-accent hover:bg-accent/6 focus:outline-none focus:ring-2 focus:ring-ring"
          key={file.path}
          onClick={() => onPreview(file)}
          title={file.path}
          type="button"
        >
          <FileImage className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 truncate">{file.fileName}</span>
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

function JpegPreviewDialog({
  open,
  jpeg,
  onOpenChange,
  onOpenPath,
  onLog,
}: {
  open: boolean;
  jpeg: JpegInput;
  onOpenChange: (open: boolean) => void;
  onOpenPath: (path: string) => void;
  onLog: (logs: string[]) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }

    setPreviewUrl("");
    invoke<string>("read_jpeg_data_url", { path: jpeg.path })
      .then(setPreviewUrl)
      .catch((error) => onLog([`JPEG 预览失败: ${String(error)}`]));
  }, [open, jpeg.path]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100vh-2rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="accent">原图预览</Badge>
            <DialogTitle className="min-w-0 truncate">{jpeg.fileName}</DialogTitle>
          </div>
          <DialogDescription>{jpeg.path}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-3 overflow-hidden p-4">
          <div className="grid min-h-[420px] place-items-center overflow-hidden rounded-md border border-border bg-panel text-panel-foreground">
            {previewUrl ? (
              <img
                className="h-full max-h-[calc(100vh-18rem)] w-full object-contain"
                src={previewUrl}
                alt={jpeg.fileName}
              />
            ) : (
              <span className="text-sm text-panel-foreground/70">正在读取原图...</span>
            )}
          </div>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-background p-3 text-xs">
            <dt className="text-muted-foreground">文件</dt>
            <dd className="min-w-0 truncate">{jpeg.fileName}</dd>
            <dt className="text-muted-foreground">大小</dt>
            <dd>{formatBytes(jpeg.size)}</dd>
            <dt className="text-muted-foreground">修改时间</dt>
            <dd>{formatTime(jpeg.modifiedTime)}</dd>
          </dl>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              关闭
            </Button>
          </DialogClose>
          <Button variant="utility" onClick={() => onOpenPath(jpeg.path)} type="button">
            <ExternalLink />
            打开 JPG
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
  onLog,
}: {
  open: boolean;
  result: MatchResult;
  resultIndex: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (resultIndex: number, candidate: RawCandidate) => void;
  onOpenPath: (path: string) => void;
  onLog: (logs: string[]) => void;
}) {
  const [selectedCandidate, setSelectedCandidate] = useState<RawCandidate | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedCandidate(null);
    setPreviewUrl("");
    invoke<string>("read_jpeg_data_url", { path: result.jpeg.path })
      .then(setPreviewUrl)
      .catch((error) => onLog([`JPEG 预览失败: ${String(error)}`]));
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

        <div className="grid min-h-0 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(360px,1.1fr)]">
          <section className="grid min-h-0 grid-rows-[minmax(260px,1fr)_auto_auto] gap-3 rounded-md border border-border bg-background p-3">
            <button
              className="grid min-h-64 place-items-center overflow-hidden rounded-[5px] border border-border bg-panel text-panel-foreground"
              onDoubleClick={() => onOpenPath(result.jpeg.path)}
              type="button"
            >
              {previewUrl ? (
                <img
                  className="h-full max-h-[360px] w-full object-contain"
                  src={previewUrl}
                  alt={result.jpeg.fileName}
                />
              ) : (
                <span className="text-sm text-panel-foreground/70">无预览</span>
              )}
            </button>
            <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">文件</dt>
              <dd className="min-w-0 truncate">{result.jpeg.fileName}</dd>
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
