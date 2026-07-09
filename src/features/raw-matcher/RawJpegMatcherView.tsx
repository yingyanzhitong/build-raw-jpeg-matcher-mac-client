import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleHelp,
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
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { JpegInput, MatchResult, MatchStatus, RawCandidate } from "./types";
import { Pane, PathDisplay } from "../shared/ui";

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

interface GuideStepData {
  target: string;
  title: string;
  body: string;
}

const guideStorageKey = "raw-jpeg-matcher-guide-seen-v2";

const guideSteps: GuideStepData[] = [
  {
    target: "jpg-input",
    title: "第一步：选择 JPG",
    body: "点击“文件”选择一批 JPG，或点击“目录”扫描整个 JPG 文件夹。你也可以直接把 JPG 文件拖到这里。",
  },
  {
    target: "raw-source",
    title: "第二步：选择 RAW 源目录",
    body: "选择存放 CR2、CR3、NEF、ARW、RAF、DNG 等原片的文件夹，系统会递归扫描子目录。",
  },
  {
    target: "match-action",
    title: "第三步：查找 RAW",
    body: "JPG 和 RAW 需要同名，例如 IMG_1024.JPG 会匹配 IMG_1024.CR3。准备好后点击“查找 RAW”。",
  },
  {
    target: "result-area",
    title: "第四步：复核并导出",
    body: "匹配结果会显示在这里。有冲突时先点“复核”确认正确 RAW，然后点击“导出对应 RAW”。",
  },
];

export function RawJpegMatcherView({
  active,
  busy,
  canExport,
  canMatch,
  dragActive,
  jpegInputs,
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
  dragActive: boolean;
  jpegInputs: JpegInput[];
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
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStepIndex, setGuideStepIndex] = useState(0);
  const [guideStepDirection, setGuideStepDirection] = useState<"next" | "back">("next");
  const exportableCount = results.filter(
    (result) => result.status === "matched" || result.status === "confirmed",
  ).length;
  const conflictCount = results.filter((result) => result.status === "conflict").length;
  const matchUnavailableReason = getMatchUnavailableReason({
    busy,
    jpegCount: jpegInputs.length,
    rawSourceDirectory,
    selectedRawFormatCount: selectedRawFormats.length,
  });
  const exportUnavailableReason = getExportUnavailableReason({
    busy,
    conflictCount,
    exportableCount,
    resultCount: results.length,
  });

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(guideStorageKey)) {
        setGuideOpen(true);
      }
    } catch {
      setGuideOpen(true);
    }
  }, []);

  function startGuide() {
    setGuideStepDirection("next");
    setGuideStepIndex(0);
    setGuideOpen(true);
  }

  function closeGuide() {
    setGuideOpen(false);
    try {
      window.localStorage.setItem(guideStorageKey, "true");
    } catch {
      // Ignore storage failures; the guide can still be dismissed for this session.
    }
  }

  return (
    <>
      <section
        className={cn(
          "grid h-full min-h-0 grid-cols-1 overflow-auto bg-card min-[960px]:grid-cols-[296px_minmax(0,1fr)] min-[960px]:overflow-hidden",
          !active && "hidden",
        )}
      >
        <aside className="min-h-[520px] border-r border-border bg-background min-[960px]:min-h-0">
          <ScrollArea className="h-full min-h-0">
            <div className="grid min-h-[720px] content-start gap-3 p-4 pb-6 min-[960px]:min-h-0">
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

        <section
          className="flex min-h-[620px] min-w-0 flex-col bg-card min-[960px]:min-h-0"
          data-guide-target="result-area"
        >
          <WorkbenchToolbar
            busy={busy}
            canMatch={canMatch}
            canExport={canExport}
            matchUnavailableReason={matchUnavailableReason}
            exportUnavailableReason={exportUnavailableReason}
            onMatch={onMatch}
            onExport={onExport}
            onClear={onClear}
          />
          <ResultTable
            results={results}
            onConflictClick={onResultConflictClick}
            onOpenPath={onOpenPath}
            onStartGuide={startGuide}
          />
        </section>
      </section>
      <GuidedTourOverlay
        open={guideOpen}
        stepDirection={guideStepDirection}
        stepIndex={guideStepIndex}
        steps={guideSteps}
        onBack={() => {
          setGuideStepDirection("back");
          setGuideStepIndex((index) => Math.max(0, index - 1));
        }}
        onClose={closeGuide}
        onNext={() => {
          if (guideStepIndex >= guideSteps.length - 1) {
            closeGuide();
            return;
          }
          setGuideStepDirection("next");
          setGuideStepIndex((index) => index + 1);
        }}
      />
    </>
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
      <div data-guide-target="jpg-input">
        <Pane
          icon={<FileImage className="size-4" />}
          title="JPG 输入"
          subtitle={`${jpegInputs.length} 个文件已加入`}
        >
          <button
            className={cn(
              "drop-raster grid min-h-28 place-items-center rounded-[8px] border border-dashed border-border p-4 text-center transition-[background,border-color,box-shadow] duration-150 hover:border-accent/55 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
              dragActive && "border-accent shadow-[0_0_0_4px_color-mix(in_oklch,var(--accent)_18%,transparent)]",
            )}
            onClick={onChooseJpegFiles}
            disabled={busy !== null}
            type="button"
          >
            <div className="grid justify-items-center gap-2">
              <span className="grid size-9 place-items-center rounded-[7px] border border-accent/24 bg-accent/10 text-accent">
                {busy === "collect" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FileImage className="size-4" />
                )}
              </span>
              <strong className="text-sm font-semibold">
                {busy === "collect" ? "正在扫描输入..." : "拖入 JPG 文件或目录"}
              </strong>
              <span className="text-xs text-muted-foreground">{jpegInputs.length} 个 JPG</span>
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
      </div>

      <div data-guide-target="raw-source">
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
                  "grid h-7 place-items-center rounded-[7px] border text-[11px] font-semibold transition-colors",
                  selectedRawFormats.includes(format)
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-border bg-secondary text-muted-foreground hover:border-accent/60 hover:bg-card",
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
      </div>
    </>
  );
}

function getMatchUnavailableReason({
  busy,
  jpegCount,
  rawSourceDirectory,
  selectedRawFormatCount,
}: {
  busy: RawBusy;
  jpegCount: number;
  rawSourceDirectory: string;
  selectedRawFormatCount: number;
}) {
  if (busy !== null) {
    return "任务正在运行，请稍候再查找。";
  }

  const missingItems = [
    jpegCount === 0 ? "JPG 输入" : "",
    rawSourceDirectory.length === 0 ? "RAW 源目录" : "",
    selectedRawFormatCount === 0 ? "RAW 格式" : "",
  ].filter(Boolean);

  if (missingItems.length === 0) {
    return "";
  }

  return `还不能查找：缺少 ${missingItems.join("、")}。`;
}

function getExportUnavailableReason({
  busy,
  conflictCount,
  exportableCount,
  resultCount,
}: {
  busy: RawBusy;
  conflictCount: number;
  exportableCount: number;
  resultCount: number;
}) {
  if (busy !== null) {
    return "任务正在运行，请稍候再导出。";
  }

  if (resultCount === 0) {
    return "还不能导出：缺少匹配结果，请先点击“查找 RAW”。";
  }

  if (exportableCount === 0 && conflictCount > 0) {
    return "还不能导出：冲突项还没确认，请先复核正确的 RAW。";
  }

  return "还不能导出：当前没有已匹配或已确认的 RAW。";
}

function WorkbenchToolbar({
  busy,
  canMatch,
  canExport,
  matchUnavailableReason,
  exportUnavailableReason,
  onMatch,
  onExport,
  onClear,
}: {
  busy: RawBusy;
  canMatch: boolean;
  canExport: boolean;
  matchUnavailableReason: string;
  exportUnavailableReason: string;
  onMatch: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="border-b border-border bg-card px-5 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-none">匹配工作台</h2>
        </div>
        <WorkbenchActions
          busy={busy}
          canMatch={canMatch}
          canExport={canExport}
          matchUnavailableReason={matchUnavailableReason}
          exportUnavailableReason={exportUnavailableReason}
          onMatch={onMatch}
          onExport={onExport}
          onClear={onClear}
        />
      </div>
    </div>
  );
}

function WorkbenchActions({
  busy,
  canMatch,
  canExport,
  matchUnavailableReason,
  exportUnavailableReason,
  onMatch,
  onExport,
  onClear,
}: {
  busy: RawBusy;
  canMatch: boolean;
  canExport: boolean;
  matchUnavailableReason: string;
  exportUnavailableReason: string;
  onMatch: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const [toast, setToast] = useState<ActionToastState | null>(null);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const toastId = toast.id;
    const timeoutId = window.setTimeout(() => {
      setToast((currentToast) => (currentToast?.id === toastId ? null : currentToast));
    }, 2800);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  function showToast(message: string) {
    setToast((currentToast) => ({
      id: (currentToast?.id ?? 0) + 1,
      message,
    }));
  }

  function handleMatchClick() {
    if (canMatch) {
      setToast(null);
      onMatch();
      return;
    }

    showToast(matchUnavailableReason);
  }

  function handleExportClick() {
    if (canExport) {
      setToast(null);
      onExport();
      return;
    }

    showToast(exportUnavailableReason);
  }

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          data-guide-target="match-action"
          aria-disabled={!canMatch}
          className={cn(!canMatch && "cursor-not-allowed opacity-45")}
          onClick={handleMatchClick}
          type="button"
        >
          {busy === "match" ? <Loader2 className="animate-spin" /> : <Search />}
          查找 RAW
        </Button>
        <Button
          variant="accent"
          aria-disabled={!canExport}
          className={cn(!canExport && "cursor-not-allowed opacity-45")}
          onClick={handleExportClick}
          type="button"
        >
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
      <ActionToast toast={toast} />
    </>
  );
}

interface ActionToastState {
  id: number;
  message: string;
}

function ActionToast({ toast }: { toast: ActionToastState | null }) {
  if (!toast) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-5 top-[136px] z-50 flex max-w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-[8px] border border-warning/25 bg-card px-3.5 py-3 text-sm text-card-foreground shadow-[0_16px_48px_rgba(0,0,0,0.18)] animate-in fade-in-0 slide-in-from-top-2 duration-200"
      key={toast.id}
      role="status"
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-warning/12 text-warning">
        <AlertTriangle className="size-3.5" />
      </span>
      <p className="min-w-0 leading-5">{toast.message}</p>
    </div>
  );
}

function ResultTable({
  results,
  onConflictClick,
  onOpenPath,
  onStartGuide,
}: {
  results: MatchResult[];
  onConflictClick: (index: number) => void;
  onOpenPath: (path: string) => void;
  onStartGuide: () => void;
}) {
  if (results.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card p-6">
        <EmptyResultState onStartGuide={onStartGuide} />
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 items-center justify-between border-b border-border px-5">
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
          <thead className="bg-secondary/72 text-[11px] font-semibold text-muted-foreground">
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
                  "h-16 transition-colors hover:bg-secondary/72",
                  result.status === "conflict" && "bg-destructive/6 hover:bg-destructive/10",
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
                    className="block max-w-60 truncate font-mono text-xs font-semibold text-foreground"
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

function EmptyResultState({ onStartGuide }: { onStartGuide: () => void }) {
  return (
    <section className="grid max-w-sm justify-items-center gap-3 text-center">
      <span className="grid size-12 place-items-center rounded-[8px] border border-border bg-secondary text-muted-foreground">
        <Search className="size-5" />
      </span>
      <div>
        <h2 className="text-base font-semibold">暂无匹配结果</h2>
        <p className="mt-1 text-sm text-muted-foreground">还不确定怎么开始？打开分步引导。</p>
      </div>
      <Button variant="utility" onClick={onStartGuide} type="button">
        <CircleHelp />
        开始引导
      </Button>
    </section>
  );
}

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function GuidedTourOverlay({
  open,
  steps,
  stepDirection,
  stepIndex,
  onBack,
  onClose,
  onNext,
}: {
  open: boolean;
  steps: GuideStepData[];
  stepDirection: "next" | "back";
  stepIndex: number;
  onBack: () => void;
  onClose: () => void;
  onNext: () => void;
}) {
  const [highlight, setHighlight] = useState<HighlightRect | null>(null);
  const step = steps[stepIndex];

  useEffect(() => {
    if (!open || !step) {
      return;
    }

    let frameId = 0;

    function updateHighlight() {
      const target = document.querySelector<HTMLElement>(
        `[data-guide-target="${step.target}"]`,
      );
      if (!target) {
        setHighlight(null);
        return;
      }

      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = target.getBoundingClientRect();
      const padding = 8;
      const top = Math.max(8, rect.top - padding);
      const left = Math.max(8, rect.left - padding);
      const right = Math.min(window.innerWidth - 8, rect.right + padding);
      const bottom = Math.min(window.innerHeight - 8, rect.bottom + padding);
      setHighlight({
        top,
        left,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      });
    }

    function scheduleUpdate() {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateHighlight);
    }

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [open, step]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open || !step) {
    return null;
  }

  const safeHighlight = highlight ?? {
    top: window.innerHeight / 2 - 80,
    left: window.innerWidth / 2 - 150,
    width: 300,
    height: 160,
  };
  const targetRight = safeHighlight.left + safeHighlight.width;
  const targetBottom = safeHighlight.top + safeHighlight.height;
  const cardWidth = 352;
  const cardTop =
    targetBottom + 14 < window.innerHeight - 190
      ? targetBottom + 14
      : Math.max(16, safeHighlight.top - 190);
  const cardLeft = Math.min(
    Math.max(16, safeHighlight.left),
    Math.max(16, window.innerWidth - cardWidth - 16),
  );
  const topOverlayStyle: CSSProperties = {
    height: safeHighlight.top,
  };
  const leftOverlayStyle: CSSProperties = {
    top: safeHighlight.top,
    width: safeHighlight.left,
    height: safeHighlight.height,
  };
  const rightOverlayStyle: CSSProperties = {
    top: safeHighlight.top,
    left: targetRight,
    height: safeHighlight.height,
  };
  const bottomOverlayStyle: CSSProperties = {
    top: targetBottom,
  };
  const highlightStyle: CSSProperties = {
    top: safeHighlight.top,
    left: safeHighlight.left,
    width: safeHighlight.width,
    height: safeHighlight.height,
  };
  const cardStyle: CSSProperties = {
    top: cardTop,
    left: cardLeft,
    width: cardWidth,
  };
  const tourEase = "ease-[cubic-bezier(0.22,1,0.36,1)]";
  const movingSurfaceClass = cn("duration-500", tourEase);
  const isLastStep = stepIndex === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={cn("absolute left-0 right-0 top-0 bg-foreground/55 transition-[height]", movingSurfaceClass)}
        style={topOverlayStyle}
      />
      <div
        className={cn("absolute left-0 bg-foreground/55 transition-[top,width,height]", movingSurfaceClass)}
        style={leftOverlayStyle}
      />
      <div
        className={cn("absolute right-0 bg-foreground/55 transition-[top,left,height]", movingSurfaceClass)}
        style={rightOverlayStyle}
      />
      <div
        className={cn("absolute bottom-0 left-0 right-0 bg-foreground/55 transition-[top]", movingSurfaceClass)}
        style={bottomOverlayStyle}
      />
      <div
        className={cn(
          "pointer-events-none absolute rounded-[10px] border-2 border-accent bg-transparent shadow-[0_0_0_4px_rgba(59,155,255,0.22),0_14px_48px_rgba(0,0,0,0.24)] transition-[top,left,width,height,box-shadow]",
          movingSurfaceClass,
        )}
        style={highlightStyle}
      />
      <div
        className={cn(
          "absolute grid gap-3 rounded-[8px] border border-border bg-card p-4 text-card-foreground shadow-[0_18px_60px_rgba(0,0,0,0.22)] transition-[top,left,transform]",
          movingSurfaceClass,
        )}
        style={cardStyle}
      >
        <div className="flex items-start justify-between gap-3">
          <Badge variant="accent">
            {stepIndex + 1}/{steps.length}
          </Badge>
          <button
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
            type="button"
          >
            跳过
          </button>
        </div>
        <div
          key={step.target}
          className={cn(
            "guide-step-copy",
            stepDirection === "next" ? "guide-step-copy-next" : "guide-step-copy-back",
          )}
        >
          <h2 className="text-base font-semibold leading-6">{step.title}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            disabled={stepIndex === 0}
            type="button"
          >
            上一步
          </Button>
          <Button size="sm" onClick={onNext} type="button">
            {isLastStep ? "完成" : "下一步"}
          </Button>
        </div>
      </div>
    </div>
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
      className="grid size-11 place-items-center overflow-hidden rounded-[7px] border border-border bg-secondary text-muted-foreground transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
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

function FileList({
  files,
  onOpen,
}: {
  files: JpegInput[];
  onOpen: (path: string) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="rounded-[7px] border border-border bg-secondary/72 px-3 py-2 text-xs text-muted-foreground">
        等待输入
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {files.slice(0, 6).map((file) => (
        <button
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[7px] border border-border bg-secondary/64 px-2 text-left text-xs transition-colors hover:border-accent/50 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:border-border disabled:hover:bg-secondary/64"
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
        <div className="rounded-[7px] border border-dashed border-border bg-secondary/72 px-2 py-1 text-center text-xs text-muted-foreground">
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
