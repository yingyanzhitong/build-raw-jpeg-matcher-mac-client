import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  FileArchive,
  FileImage,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { JpegInput, MatchResult, MatchStatus, RawCandidate } from "./types";
import { LogPanel, Pane, PathDisplay, StatTile, type LogEntry } from "../shared/ui";

export type RawBusy = "collect" | "match" | "export" | null;

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

export function RawJpegMatcherView({
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

function rawResultLabel(result: MatchResult) {
  if (result.selectedRaw) {
    return result.selectedRaw.fileName;
  }
  if (result.status === "conflict") {
    return `${result.candidates.length} 个 RAW 候选`;
  }
  return "-";
}
