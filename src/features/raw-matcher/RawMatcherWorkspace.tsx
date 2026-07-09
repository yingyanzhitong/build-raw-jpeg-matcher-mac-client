import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, ClipboardList, ExternalLink, FileImage, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
import {
  formatBytes,
  formatTime,
  inferLogLevel,
  StatTile,
  type LogEntry,
  type LogLevel,
} from "../shared/ui";
import { RawJpegMatcherView, type RawBusy } from "./RawJpegMatcherView";

const rawFormats = ["CR2", "CR3", "NEF", "ARW", "RAF", "ORF", "RW2", "DNG"];

interface ExportReport {
  directory: string;
  summary: ExportSummary;
}

export interface RawWorkspaceStatus {
  jpegCount: number;
  counts: Record<MatchStatus, number>;
  exportableCount: number;
  rawDirectory: string;
  busy: RawBusy;
  statusText: string;
  logs: LogEntry[];
}

const initialRawLogs: LogEntry[] = [
  { level: "info", message: "等待拖入 JPG 文件、目录或粘贴清单" },
];

export const defaultRawWorkspaceStatus: RawWorkspaceStatus = {
  jpegCount: 0,
  counts: { matched: 0, missing: 0, conflict: 0, confirmed: 0 },
  exportableCount: 0,
  rawDirectory: "",
  busy: null,
  statusText: "READY",
  logs: initialRawLogs,
};

export function RawMatcherWorkspace({
  active,
  onStatusChange,
}: {
  active: boolean;
  onStatusChange: (status: RawWorkspaceStatus) => void;
}) {
  const [jpegInputs, setJpegInputs] = useState<JpegInput[]>([]);
  const [manualText, setManualText] = useState("");
  const [rawSourceDirectory, setRawSourceDirectory] = useState("");
  const [results, setResults] = useState<MatchResult[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>(initialRawLogs);
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
    onStatusChange({
      jpegCount: jpegInputs.length,
      counts,
      exportableCount,
      rawDirectory: rawSourceDirectory,
      busy,
      statusText: busy ? busyLabel(busy) : "READY",
      logs,
    });
  }, [busy, counts, exportableCount, jpegInputs.length, logs, onStatusChange, rawSourceDirectory]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    if (!isTauriRuntime()) {
      return () => {
        unlisten?.();
      };
    }

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!active) {
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
  }, [active, jpegInputs]);

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

      if (isTextEditing || !active) {
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
  }, [active, canExport, canMatch, busy, jpegInputs, rawSourceDirectory, results, selectedRawFormats]);

  return (
    <>
      <RawJpegMatcherView
        active={active}
        busy={busy}
        canExport={canExport}
        canMatch={canMatch}
        dragActive={dragActive}
        jpegInputs={jpegInputs}
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
    </>
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

function busyLabel(busy: Exclude<RawBusy, null>) {
  return {
    collect: "SCANNING",
    match: "MATCHING",
    export: "EXPORTING",
  }[busy];
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
