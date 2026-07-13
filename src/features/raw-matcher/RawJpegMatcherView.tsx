import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  Download,
  FileArchive,
  FileImage,
  FolderOpen,
  Loader2,
  PanelBottom,
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
import type {
  DirectionTransition,
  MatchDirection,
  MatchFile,
  MatchResult,
  MatchStatus,
  MatcherBusy,
} from "./types";
import { PathDisplay } from "../shared/ui";

export type RawBusy = MatcherBusy;

export interface DirectionConfig {
  directionLabel: string;
  switchTargetLabel: string;
  inputKind: "image" | "raw";
  candidateKind: "image" | "raw";
  inputNoun: string;
  candidateNoun: string;
  inputTitle: string;
  inputFormatDescription: string;
  dropLabel: string;
  searchTitle: string;
  searchDescription: string;
  searchFallback: string;
  searchButton: string;
  matchButton: string;
  exportButton: string;
  inputColumn: string;
  counterpartColumn: string;
  resultHint: string;
  emptyDescription: string;
}

export const directionConfig: Record<MatchDirection, DirectionConfig> = {
  imageToRaw: {
    directionLabel: "图片 → RAW",
    switchTargetLabel: "RAW → 图片",
    inputKind: "image",
    candidateKind: "raw",
    inputNoun: "图片",
    candidateNoun: "RAW",
    inputTitle: "图片输入",
    inputFormatDescription: "支持 JPG、JPEG、PNG",
    dropLabel: "拖入图片文件或目录",
    searchTitle: "RAW 查找目录",
    searchDescription: "递归扫描已启用的 RAW 格式",
    searchFallback: "尚未选择 RAW 查找目录",
    searchButton: "选择 RAW 目录",
    matchButton: "重新查找 RAW",
    exportButton: "导出对应 RAW",
    inputColumn: "图片 / 清单",
    counterpartColumn: "对应 RAW",
    resultHint: "单击缩略图可在系统中打开 RAW",
    emptyDescription: "添加图片并选择 RAW 查找目录后，系统会自动开始查找。",
  },
  rawToImage: {
    directionLabel: "RAW → 图片",
    switchTargetLabel: "图片 → RAW",
    inputKind: "raw",
    candidateKind: "image",
    inputNoun: "RAW",
    candidateNoun: "图片",
    inputTitle: "RAW 输入",
    inputFormatDescription: "支持当前已启用的 RAW 格式",
    dropLabel: "拖入 RAW 文件或目录",
    searchTitle: "图片查找目录",
    searchDescription: "递归扫描 JPG、JPEG、PNG",
    searchFallback: "尚未选择图片查找目录",
    searchButton: "选择图片目录",
    matchButton: "重新查找图片",
    exportButton: "导出对应图片",
    inputColumn: "RAW 输入",
    counterpartColumn: "对应图片",
    resultHint: "单击缩略图可在系统中打开图片",
    emptyDescription: "添加 RAW 并选择图片查找目录后，系统会自动开始查找。",
  },
};

export function getDirectionConfig(direction: MatchDirection) {
  return directionConfig[direction];
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

interface GuideStepData {
  target: string;
  title: string;
  body: string;
}

const guideStorageKey = "raw-image-matcher-guide-seen-v4";

const guideStepsByDirection: Record<MatchDirection, GuideStepData[]> = {
  imageToRaw: [
    {
      target: "match-input",
      title: "第一步：添加图片",
      body: "选择文件、递归扫描目录，或直接拖入 JPG、JPEG、PNG。也可以通过文本清单添加图片引用。",
    },
    {
      target: "direction-connector",
      title: "按同名文件向下查找",
      body: "当前是“图片 → RAW”。需要反向查找时，可在这里切换为“RAW → 图片”。",
    },
    {
      target: "search-directory",
      title: "第二步：选择 RAW 查找目录",
      body: "系统会在这个目录及其子目录中查找同名 RAW。两步都完成后会自动开始扫描；你也可以提前选择目录。",
    },
    {
      target: "result-area",
      title: "第三步：复核并导出",
      body: "前两步就绪后会自动查找。冲突项需要先确认唯一 RAW，随后可将已匹配和已确认的 RAW 导出到目标目录。",
    },
  ],
  rawToImage: [
    {
      target: "match-input",
      title: "第一步：添加 RAW",
      body: "选择 RAW 文件、递归扫描目录、直接拖入，或通过文本清单粘贴 RAW 文件名；带扩展名时只会加入当前已启用的 RAW 格式。",
    },
    {
      target: "direction-connector",
      title: "按同名文件向下查找",
      body: "当前是“RAW → 图片”。需要反向查找时，可在这里切换为“图片 → RAW”。",
    },
    {
      target: "search-directory",
      title: "第二步：选择图片查找目录",
      body: "系统会在这个目录及其子目录中查找同名 JPG、JPEG、PNG。两步都完成后会自动开始扫描；你也可以提前选择目录。",
    },
    {
      target: "result-area",
      title: "第三步：复核并导出",
      body: "前两步就绪后会自动查找。同名图片存在多个版本时先确认唯一候选，随后可导出已匹配和已确认的图片。",
    },
  ],
};

export interface RawJpegMatcherViewProps {
  active: boolean;
  capabilitiesReady: boolean;
  direction: MatchDirection;
  directionAnnouncement: string;
  directionTransition: DirectionTransition | null;
  interactionsLocked: boolean;
  logPanelOpen: boolean;
  busy: MatcherBusy;
  canExport: boolean;
  canMatch: boolean;
  dragActive: boolean;
  inputs: MatchFile[];
  searchDirectory: string;
  results: MatchResult[];
  supportedRawFormats: string[];
  selectedRawFormats: string[];
  onToggleDirection: () => void;
  onToggleLogPanel: () => void;
  onChooseInputDirectories: () => void;
  onChooseInputFiles: () => void;
  onChooseSearchDirectory: () => void;
  onClear: () => void;
  onExport: () => void;
  onMatch: () => void;
  onOpenInput: (path: string) => void;
  onOpenManualDialog: () => void;
  onOpenPath: (path: string) => void;
  onResultConflictClick: (index: number) => void;
  onSelectAllRawFormats: () => void;
  onToggleRawFormat: (format: string) => void;
}

export function RawJpegMatcherView({
  active,
  capabilitiesReady,
  direction,
  directionAnnouncement,
  directionTransition,
  interactionsLocked,
  logPanelOpen,
  busy,
  canExport,
  canMatch,
  dragActive,
  inputs,
  searchDirectory,
  results,
  supportedRawFormats,
  selectedRawFormats,
  onToggleDirection,
  onToggleLogPanel,
  onChooseInputDirectories,
  onChooseInputFiles,
  onChooseSearchDirectory,
  onClear,
  onExport,
  onMatch,
  onOpenInput,
  onOpenManualDialog,
  onOpenPath,
  onResultConflictClick,
  onSelectAllRawFormats,
  onToggleRawFormat,
}: RawJpegMatcherViewProps) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStepIndex, setGuideStepIndex] = useState(0);
  const [guideStepDirection, setGuideStepDirection] = useState<"next" | "back">("next");
  const config = getDirectionConfig(direction);
  const guideSteps = guideStepsByDirection[direction];
  const exportableCount = results.filter(
    (result) => result.status === "matched" || result.status === "confirmed",
  ).length;
  const conflictCount = results.filter((result) => result.status === "conflict").length;
  const matchUnavailableReason = getMatchUnavailableReason({
    busy,
    interactionsLocked,
    capabilitiesReady,
    inputCount: inputs.length,
    searchDirectory,
    selectedRawFormatCount: selectedRawFormats.length,
    config,
  });
  const exportUnavailableReason = getExportUnavailableReason({
    busy,
    interactionsLocked,
    conflictCount,
    exportableCount,
    resultCount: results.length,
    config,
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

  useEffect(() => {
    setGuideStepIndex(0);
    setGuideStepDirection("next");
  }, [direction]);

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
      // The guide can still be dismissed for this session.
    }
  }

  return (
    <>
      <section
        className={cn(
          "grid h-full min-h-0 grid-cols-1 overflow-auto bg-card min-[960px]:grid-cols-[312px_minmax(0,1fr)] min-[960px]:overflow-hidden",
          !active && "hidden",
        )}
      >
        <aside className="min-h-[520px] border-r border-border bg-background min-[960px]:min-h-0">
          <ScrollArea className="h-full min-h-0">
            <div className="grid min-h-[720px] content-start min-[960px]:min-h-0">
              <div className="border-b border-border bg-card/72 px-4 py-2.5">
                <DirectionConnector
                  busy={busy}
                  config={config}
                  directionAnnouncement={directionAnnouncement}
                  directionTransition={directionTransition}
                  interactionsLocked={interactionsLocked}
                  onToggleDirection={onToggleDirection}
                />
              </div>
              <div className="p-4 pb-6">
                <InputPane
                  busy={busy}
                  capabilitiesReady={capabilitiesReady}
                  config={config}
                  direction={direction}
                  directionTransition={directionTransition}
                  dragActive={dragActive}
                  interactionsLocked={interactionsLocked}
                  inputs={inputs}
                  searchDirectory={searchDirectory}
                  supportedRawFormats={supportedRawFormats}
                  selectedRawFormats={selectedRawFormats}
                  onOpenManualDialog={onOpenManualDialog}
                  onChooseInputFiles={onChooseInputFiles}
                  onChooseInputDirectories={onChooseInputDirectories}
                  onChooseSearchDirectory={onChooseSearchDirectory}
                  onOpenInput={onOpenInput}
                  onToggleRawFormat={onToggleRawFormat}
                  onSelectAllRawFormats={onSelectAllRawFormats}
                />
              </div>
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
            config={config}
            interactionsLocked={interactionsLocked}
            logPanelOpen={logPanelOpen}
            matchUnavailableReason={matchUnavailableReason}
            exportUnavailableReason={exportUnavailableReason}
            resultCount={results.length}
            onMatch={onMatch}
            onExport={onExport}
            onClear={onClear}
            onToggleLogPanel={onToggleLogPanel}
          />
          <ResultTable
            config={config}
            direction={direction}
            interactionsLocked={interactionsLocked}
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
  capabilitiesReady,
  config,
  direction,
  directionTransition,
  dragActive,
  interactionsLocked,
  inputs,
  searchDirectory,
  supportedRawFormats,
  selectedRawFormats,
  onOpenManualDialog,
  onChooseInputFiles,
  onChooseInputDirectories,
  onChooseSearchDirectory,
  onOpenInput,
  onToggleRawFormat,
  onSelectAllRawFormats,
}: {
  busy: MatcherBusy;
  capabilitiesReady: boolean;
  config: DirectionConfig;
  direction: MatchDirection;
  directionTransition: DirectionTransition | null;
  dragActive: boolean;
  interactionsLocked: boolean;
  inputs: MatchFile[];
  searchDirectory: string;
  supportedRawFormats: string[];
  selectedRawFormats: string[];
  onOpenManualDialog: () => void;
  onChooseInputFiles: () => void;
  onChooseInputDirectories: () => void;
  onChooseSearchDirectory: () => void;
  onOpenInput: (path: string) => void;
  onToggleRawFormat: (format: string) => void;
  onSelectAllRawFormats: () => void;
}) {
  const inputComplete = inputs.length > 0;
  const directoryComplete = searchDirectory.length > 0;
  const inputDisabled = busy !== null || !capabilitiesReady || interactionsLocked;
  const topCardMotion = getCardMotion(directionTransition, "top");
  const bottomCardMotion = getCardMotion(directionTransition, "bottom");

  return (
    <div className="grid gap-3">
      <WorkflowCard
        complete={inputComplete}
        current={!inputComplete}
        guideTarget="match-input"
        icon={config.inputKind === "image" ? <FileImage /> : <FileArchive />}
        motion={topCardMotion}
        step={1}
        subtitle={config.inputFormatDescription}
        title={config.inputTitle}
      >
        <button
          className={cn(
            "drop-raster grid min-h-28 place-items-center rounded-[8px] border border-dashed border-border p-4 text-center transition-[background,border-color,box-shadow] duration-150 motion-reduce:transition-none hover:border-accent/55 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            dragActive &&
              "border-accent shadow-[0_0_0_4px_color-mix(in_oklch,var(--accent)_18%,transparent)]",
          )}
          onClick={onChooseInputFiles}
          disabled={inputDisabled}
          type="button"
        >
          <div className="grid justify-items-center gap-2">
            <span className="grid size-9 place-items-center rounded-[7px] border border-accent/24 bg-accent/10 text-accent">
              {!capabilitiesReady || busy === "collect" ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : config.inputKind === "image" ? (
                <FileImage className="size-4" />
              ) : (
                <FileArchive className="size-4" />
              )}
            </span>
            <strong className="text-sm font-semibold">
              {!capabilitiesReady
                ? "正在读取支持格式..."
                : busy === "collect"
                  ? "正在扫描输入..."
                  : config.dropLabel}
            </strong>
            <span className="text-xs text-muted-foreground">
              {inputs.length} 个{config.inputNoun}文件
            </span>
          </div>
        </button>

        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="utility"
            size="sm"
            onClick={onChooseInputFiles}
            disabled={inputDisabled}
            type="button"
          >
            {config.inputKind === "image" ? <FileImage /> : <FileArchive />}
            文件
          </Button>
          <Button
            variant="utility"
            size="sm"
            onClick={onChooseInputDirectories}
            disabled={inputDisabled}
            type="button"
          >
            <FolderOpen />
            目录
          </Button>
          <Button
            variant="utility"
            size="sm"
            onClick={onOpenManualDialog}
            disabled={inputDisabled}
            type="button"
          >
            <ClipboardList />
            文本
          </Button>
        </div>

        {config.inputKind === "raw" ? (
          <RawFormatSelector
            busy={busy}
            disabled={!capabilitiesReady || interactionsLocked}
            supportedRawFormats={supportedRawFormats}
            selectedRawFormats={selectedRawFormats}
            onSelectAll={onSelectAllRawFormats}
            onToggle={onToggleRawFormat}
          />
        ) : null}

        <FileList files={inputs} kind={config.inputKind} onOpen={onOpenInput} />
      </WorkflowCard>

      <WorkflowCard
        complete={directoryComplete}
        current={inputComplete && !directoryComplete}
        guideTarget="search-directory"
        icon={config.candidateKind === "raw" ? <FileArchive /> : <FileImage />}
        motion={bottomCardMotion}
        step={2}
        subtitle={config.searchDescription}
        title={config.searchTitle}
      >
        <PathDisplay path={searchDirectory} fallback={config.searchFallback} />
        <Button
          variant="default"
          onClick={onChooseSearchDirectory}
          disabled={busy !== null || interactionsLocked}
          type="button"
        >
          <FolderOpen />
          {config.searchButton}
        </Button>
        {config.candidateKind === "raw" ? (
          <RawFormatSelector
            busy={busy}
            disabled={!capabilitiesReady || interactionsLocked}
            supportedRawFormats={supportedRawFormats}
            selectedRawFormats={selectedRawFormats}
            onSelectAll={onSelectAllRawFormats}
            onToggle={onToggleRawFormat}
          />
        ) : null}
      </WorkflowCard>
    </div>
  );
}

function WorkflowCard({
  children,
  complete,
  current,
  guideTarget,
  icon,
  motion,
  step,
  subtitle,
  title,
}: {
  children: ReactNode;
  complete: boolean;
  current: boolean;
  guideTarget: string;
  icon: ReactNode;
  motion?: CardMotion;
  step: 1 | 2;
  subtitle: string;
  title: string;
}) {
  const stepLabel = complete ? "已完成" : current ? "当前步骤" : "待完成";

  return (
    <section
      className={cn(
        "rounded-[8px] border bg-card p-3 shadow-[0_1px_1px_rgba(0,0,0,0.025)]",
        current ? "border-accent/42" : "border-border",
        motion && `matcher-direction-card-${motion}`,
      )}
      data-guide-target={guideTarget}
    >
      <header className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-[7px] border text-xs font-semibold",
            complete
              ? "border-success/30 bg-success/10 text-success"
              : current
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-secondary text-muted-foreground",
          )}
          aria-label={`第 ${step} 步，${stepLabel}`}
        >
          {complete ? <Check className="size-4" /> : step}
        </span>
        <span className="grid size-8 shrink-0 place-items-center rounded-[7px] border border-border bg-secondary text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h2 className="truncate text-sm font-semibold leading-none">{title}</h2>
            <span
              className={cn(
                "shrink-0 text-[10px] font-medium",
                complete ? "text-success" : current ? "text-accent" : "text-muted-foreground",
              )}
            >
              {stepLabel}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </header>
      <div className="grid gap-2.5">{children}</div>
    </section>
  );
}

type CardMotion = "leave-down" | "leave-up" | "enter-from-bottom" | "enter-from-top";

function getCardMotion(
  transition: DirectionTransition | null,
  position: "top" | "bottom",
): CardMotion | undefined {
  if (!transition) {
    return undefined;
  }

  if (transition.phase === "exiting") {
    return position === "top" ? "leave-down" : "leave-up";
  }

  return position === "top" ? "enter-from-bottom" : "enter-from-top";
}

function DirectionConnector({
  busy,
  config,
  directionAnnouncement,
  directionTransition,
  interactionsLocked,
  onToggleDirection,
}: {
  busy: MatcherBusy;
  config: DirectionConfig;
  directionAnnouncement: string;
  directionTransition: DirectionTransition | null;
  interactionsLocked: boolean;
  onToggleDirection: () => void;
}) {
  const disabled = busy !== null || interactionsLocked;
  const switchLabel = `当前方向：${config.directionLabel}。切换为 ${config.switchTargetLabel}`;
  const transitionClass = directionTransition
    ? `matcher-direction-switcher-${directionTransition.phase}`
    : undefined;

  return (
    <section
      className={cn(
        "matcher-direction-switcher grid h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5",
        transitionClass,
      )}
      data-guide-target="direction-connector"
      role="group"
      aria-label="配对方向"
    >
      <span className="min-w-0 truncate text-xs font-medium tracking-[0.01em] text-foreground/85">
        {config.directionLabel}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-direction-toggle
            aria-label={switchLabel}
            className="inline-flex size-7 items-center justify-center rounded-[6px] border border-accent bg-accent text-accent-foreground shadow-[0_1px_3px_color-mix(in_oklch,var(--accent)_20%,transparent)] transition-[background-color,box-shadow,transform] duration-150 motion-reduce:transition-none hover:bg-accent/90 hover:shadow-[0_2px_5px_color-mix(in_oklch,var(--accent)_24%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={onToggleDirection}
            type="button"
          >
            <ArrowLeftRight
              className={cn(
                "size-3.5",
                directionTransition && "matcher-direction-switch-icon",
              )}
              aria-hidden="true"
            />
            <span className="sr-only">切换配对方向</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {interactionsLocked
            ? "正在交换上下任务区域，请稍候"
            : disabled
              ? "当前任务完成后才能切换方向"
              : `切换为 ${config.switchTargetLabel}`}
        </TooltipContent>
      </Tooltip>
      <span className="sr-only" aria-live="polite" role="status">
        {directionAnnouncement}
      </span>
    </section>
  );
}

function RawFormatSelector({
  busy,
  disabled = false,
  supportedRawFormats,
  selectedRawFormats,
  onSelectAll,
  onToggle,
}: {
  busy: MatcherBusy;
  disabled?: boolean;
  supportedRawFormats: string[];
  selectedRawFormats: string[];
  onSelectAll: () => void;
  onToggle: (format: string) => void;
}) {
  const allSelected =
    supportedRawFormats.length > 0 && selectedRawFormats.length === supportedRawFormats.length;

  return (
    <section aria-label="RAW 格式筛选" className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          RAW 格式 · 已选 {selectedRawFormats.length}/{supportedRawFormats.length}
        </span>
        <Button
          variant={allSelected ? "accent" : "ghost"}
          size="sm"
          onClick={onSelectAll}
          disabled={disabled || busy !== null || supportedRawFormats.length === 0}
          type="button"
          aria-pressed={allSelected}
        >
          {allSelected ? <Check /> : null}
          全选
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {supportedRawFormats.map((format) => {
          const selected = selectedRawFormats.includes(format);
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "grid h-7 place-items-center rounded-[7px] border text-[11px] font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-55",
                selected
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border bg-secondary text-muted-foreground hover:border-accent/60 hover:bg-card",
              )}
              disabled={disabled || busy !== null}
              key={format}
              onClick={() => onToggle(format)}
              type="button"
            >
              {format}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function getMatchUnavailableReason({
  busy,
  capabilitiesReady,
  interactionsLocked,
  inputCount,
  searchDirectory,
  selectedRawFormatCount,
  config,
}: {
  busy: MatcherBusy;
  capabilitiesReady: boolean;
  interactionsLocked: boolean;
  inputCount: number;
  searchDirectory: string;
  selectedRawFormatCount: number;
  config: DirectionConfig;
}) {
  if (interactionsLocked) {
    return "正在切换配对方向，请稍候。";
  }
  if (!capabilitiesReady) {
    return "正在读取支持格式，请稍候再查找。";
  }
  if (busy !== null) {
    return "任务正在运行，请稍候再查找。";
  }

  const missingItems = [
    inputCount === 0 ? `${config.inputNoun}输入` : "",
    searchDirectory.length === 0 ? config.searchTitle : "",
    selectedRawFormatCount === 0 ? "RAW 格式" : "",
  ].filter(Boolean);

  return missingItems.length === 0 ? "" : `还不能查找：缺少 ${missingItems.join("、")}。`;
}

function getExportUnavailableReason({
  busy,
  interactionsLocked,
  conflictCount,
  exportableCount,
  resultCount,
  config,
}: {
  busy: MatcherBusy;
  interactionsLocked: boolean;
  conflictCount: number;
  exportableCount: number;
  resultCount: number;
  config: DirectionConfig;
}) {
  if (interactionsLocked) {
    return "正在切换配对方向，请稍候。";
  }
  if (busy !== null) {
    return "任务正在运行，请稍候再导出。";
  }
  if (resultCount === 0) {
    return "还不能导出：请先完成输入和查找目录选择，系统会自动开始查找。";
  }
  if (exportableCount === 0 && conflictCount > 0) {
    return `还不能导出：冲突项尚未确认，请先复核正确的${config.candidateNoun}。`;
  }
  return `还不能导出：当前没有已匹配或已确认的${config.candidateNoun}。`;
}

function WorkbenchToolbar({
  busy,
  canMatch,
  canExport,
  config,
  interactionsLocked,
  logPanelOpen,
  matchUnavailableReason,
  exportUnavailableReason,
  resultCount,
  onMatch,
  onExport,
  onClear,
  onToggleLogPanel,
}: {
  busy: MatcherBusy;
  canMatch: boolean;
  canExport: boolean;
  config: DirectionConfig;
  interactionsLocked: boolean;
  logPanelOpen: boolean;
  matchUnavailableReason: string;
  exportUnavailableReason: string;
  resultCount: number;
  onMatch: () => void;
  onExport: () => void;
  onClear: () => void;
  onToggleLogPanel: () => void;
}) {
  return (
    <div className="border-b border-border bg-card px-5">
      <div className="grid h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="shrink-0 text-sm font-semibold leading-none">匹配结果</h2>
          <Badge variant="muted" className="shrink-0">{resultCount} 条</Badge>
          <p className="hidden min-w-0 truncate text-xs text-muted-foreground min-[1260px]:block">
            {resultCount > 0
              ? config.resultHint
              : "完成输入与查找目录后，系统会自动开始查找"}
          </p>
        </div>
        <WorkbenchActions
          busy={busy}
          canMatch={canMatch}
          canExport={canExport}
          config={config}
          interactionsLocked={interactionsLocked}
          logPanelOpen={logPanelOpen}
          matchUnavailableReason={matchUnavailableReason}
          exportUnavailableReason={exportUnavailableReason}
          onMatch={onMatch}
          onExport={onExport}
          onClear={onClear}
          onToggleLogPanel={onToggleLogPanel}
        />
      </div>
    </div>
  );
}

function WorkbenchActions({
  busy,
  canMatch,
  canExport,
  config,
  interactionsLocked,
  logPanelOpen,
  matchUnavailableReason,
  exportUnavailableReason,
  onMatch,
  onExport,
  onClear,
  onToggleLogPanel,
}: {
  busy: MatcherBusy;
  canMatch: boolean;
  canExport: boolean;
  config: DirectionConfig;
  interactionsLocked: boolean;
  logPanelOpen: boolean;
  matchUnavailableReason: string;
  exportUnavailableReason: string;
  onMatch: () => void;
  onExport: () => void;
  onClear: () => void;
  onToggleLogPanel: () => void;
}) {
  const [toast, setToast] = useState<ActionToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const toastId = toast.id;
    const timeoutId = window.setTimeout(() => {
      setToast((current) => (current?.id === toastId ? null : current));
    }, 2800);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  function showToast(message: string) {
    setToast((current) => ({ id: (current?.id ?? 0) + 1, message }));
  }

  return (
    <>
      <div className="flex min-w-0 items-center justify-end gap-2">
        <Button
          data-guide-target="match-action"
          aria-disabled={!canMatch}
          className={cn(!canMatch && "cursor-not-allowed opacity-45")}
          variant="utility"
          onClick={() => (canMatch ? (setToast(null), onMatch()) : showToast(matchUnavailableReason))}
          type="button"
        >
          {busy === "match" ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Search />
          )}
          {config.matchButton}
        </Button>
        <Button
          variant="accent"
          aria-disabled={!canExport}
          className={cn(!canExport && "cursor-not-allowed opacity-45")}
          onClick={() =>
            canExport ? (setToast(null), onExport()) : showToast(exportUnavailableReason)
          }
          type="button"
        >
          {busy === "export" ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Download />
          )}
          {config.exportButton}
        </Button>
        <Separator orientation="vertical" className="hidden h-8 sm:block" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="清空当前方向任务"
              variant="ghost"
              size="icon"
              onClick={onClear}
              disabled={busy !== null || interactionsLocked}
              type="button"
            >
              <RotateCcw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>只清空当前方向任务</TooltipContent>
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
      <ActionToast toast={toast} />
    </>
  );
}

interface ActionToastState {
  id: number;
  message: string;
}

function ActionToast({ toast }: { toast: ActionToastState | null }) {
  if (!toast) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-5 top-[136px] z-50 flex max-w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-[8px] border border-warning/25 bg-card px-3.5 py-3 text-sm text-card-foreground shadow-[0_16px_48px_rgba(0,0,0,0.18)] animate-in fade-in-0 slide-in-from-top-2 duration-200 motion-reduce:animate-none"
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
  config,
  direction,
  interactionsLocked,
  results,
  onConflictClick,
  onOpenPath,
  onStartGuide,
}: {
  config: DirectionConfig;
  direction: MatchDirection;
  interactionsLocked: boolean;
  results: MatchResult[];
  onConflictClick: (index: number) => void;
  onOpenPath: (path: string) => void;
  onStartGuide: () => void;
}) {
  if (results.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card p-6">
        <EmptyResultState config={config} onStartGuide={onStartGuide} />
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
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
              <th className="whitespace-nowrap px-3 text-left">{config.counterpartColumn}</th>
              <th className="whitespace-nowrap px-3 text-left">状态</th>
              <th className="whitespace-nowrap px-3 text-left">{config.inputColumn}</th>
              <th className="whitespace-nowrap px-3 text-right">候选</th>
              <th className="whitespace-nowrap px-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {results.map((result, index) => (
              <tr
                className={cn(
                  "h-16 transition-colors motion-reduce:transition-none hover:bg-secondary/72",
                  result.status === "conflict" && "bg-destructive/6 hover:bg-destructive/10",
                )}
                key={`${result.input.path || result.input.fileName}-${index}`}
              >
                <td className="whitespace-nowrap px-3 py-2 align-middle">
                  <FilePreview
                    file={result.selectedCandidate ?? result.candidates[0] ?? null}
                    kind={direction === "imageToRaw" ? "raw" : "image"}
                    onOpen={onOpenPath}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-middle">
                  <span
                    className="block max-w-60 truncate font-mono text-xs font-semibold text-foreground"
                    title={result.selectedCandidate?.path ?? ""}
                  >
                    {counterpartResultLabel(result, config.candidateNoun)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-middle">
                  <StatusBadge status={result.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 align-middle">
                  <span
                    className="block max-w-56 truncate font-medium"
                    title={result.input.manual ? result.input.fileName : result.input.path}
                  >
                    {result.input.fileName}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-middle font-mono text-xs tabular-nums text-muted-foreground">
                  {result.candidates.length}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-middle">
                  {result.status === "conflict" ? (
                    <Button
                      aria-label={`复核 ${result.input.fileName} 的${config.candidateNoun}候选`}
                      variant="utility"
                      size="sm"
                      onClick={() => onConflictClick(index)}
                      disabled={interactionsLocked}
                      type="button"
                    >
                      <AlertTriangle />
                      复核
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" aria-hidden="true">-</span>
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

function EmptyResultState({
  config,
  onStartGuide,
}: {
  config: DirectionConfig;
  onStartGuide: () => void;
}) {
  return (
    <section className="grid max-w-sm justify-items-center gap-3 text-center">
      <span className="grid size-12 place-items-center rounded-[8px] border border-border bg-secondary text-muted-foreground">
        <Search className="size-5" />
      </span>
      <div>
        <h2 className="text-base font-semibold">暂无{config.candidateNoun}匹配结果</h2>
        <p className="mt-1 text-sm text-muted-foreground">{config.emptyDescription}</p>
      </div>
      <Button variant="utility" onClick={onStartGuide} type="button">
        <CircleHelp />
        查看分步引导
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
    if (!open || !step) return;
    let frameId = 0;
    function updateHighlight() {
      const target = document.querySelector<HTMLElement>(`[data-guide-target="${step.target}"]`);
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
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open || !step) return null;

  const safeHighlight = highlight ?? {
    top: window.innerHeight / 2 - 80,
    left: window.innerWidth / 2 - 150,
    width: 300,
    height: 160,
  };
  const targetRight = safeHighlight.left + safeHighlight.width;
  const targetBottom = safeHighlight.top + safeHighlight.height;
  const cardWidth = Math.min(352, window.innerWidth - 32);
  const cardTop =
    targetBottom + 14 < window.innerHeight - 190
      ? targetBottom + 14
      : Math.max(16, safeHighlight.top - 190);
  const cardLeft = Math.min(
    Math.max(16, safeHighlight.left),
    Math.max(16, window.innerWidth - cardWidth - 16),
  );
  const topOverlayStyle: CSSProperties = { height: safeHighlight.top };
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
  const bottomOverlayStyle: CSSProperties = { top: targetBottom };
  const highlightStyle: CSSProperties = { ...safeHighlight };
  const cardStyle: CSSProperties = { top: cardTop, left: cardLeft, width: cardWidth };
  const movingSurfaceClass = "duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0";
  const isLastStep = stepIndex === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="配对分步引导" aria-modal="true">
      <div className={cn("absolute left-0 right-0 top-0 bg-foreground/55 transition-[height]", movingSurfaceClass)} style={topOverlayStyle} />
      <div className={cn("absolute left-0 bg-foreground/55 transition-[top,width,height]", movingSurfaceClass)} style={leftOverlayStyle} />
      <div className={cn("absolute right-0 bg-foreground/55 transition-[top,left,height]", movingSurfaceClass)} style={rightOverlayStyle} />
      <div className={cn("absolute bottom-0 left-0 right-0 bg-foreground/55 transition-[top]", movingSurfaceClass)} style={bottomOverlayStyle} />
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
          <Badge variant="accent">{stepIndex + 1}/{steps.length}</Badge>
          <button className="text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClose} type="button">跳过</button>
        </div>
        <div
          key={step.target}
          className={cn(
            "guide-step-copy motion-reduce:animate-none",
            stepDirection === "next" ? "guide-step-copy-next" : "guide-step-copy-back",
          )}
        >
          <h2 className="text-base font-semibold leading-6">{step.title}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onBack} disabled={stepIndex === 0} type="button">上一步</Button>
          <Button size="sm" onClick={onNext} type="button">{isLastStep ? "完成" : "下一步"}</Button>
        </div>
      </div>
    </div>
  );
}

export function FilePreview({
  file,
  kind,
  onOpen,
  size = "sm",
}: {
  file: MatchFile | null;
  kind: "image" | "raw";
  onOpen: (path: string) => void;
  size?: "sm" | "lg";
}) {
  return kind === "raw" ? (
    <RawFilePreview file={file} onOpen={onOpen} size={size} />
  ) : (
    <ImageFilePreview file={file} onOpen={onOpen} size={size} />
  );
}

function RawFilePreview({
  file,
  onOpen,
  size,
}: {
  file: MatchFile | null;
  onOpen: (path: string) => void;
  size: "sm" | "lg";
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl("");
    setFailed(false);
    if (!file?.path) return () => { cancelled = true; };
    invoke<string>("file_thumbnail_path", { path: file.path })
      .then((thumbnailPath) => {
        if (!cancelled) setThumbnailUrl(convertFileSrc(thumbnailPath));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [file?.path]);

  return (
    <PreviewButton file={file} onOpen={onOpen} label="RAW" size={size}>
      {thumbnailUrl ? (
        <img className="size-full object-cover" src={thumbnailUrl} alt={file?.fileName ?? "RAW 缩略图"} loading="lazy" />
      ) : (
        <FileArchive className={cn("size-4", failed && "opacity-45")} />
      )}
    </PreviewButton>
  );
}

function ImageFilePreview({
  file,
  onOpen,
  size,
}: {
  file: MatchFile | null;
  onOpen: (path: string) => void;
  size: "sm" | "lg";
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThumbnailUrl("");
    setFailed(false);
    if (!file?.path) return () => { cancelled = true; };
    invoke<string>("file_thumbnail_path", { path: file.path })
      .then((thumbnailPath) => {
        if (!cancelled) setThumbnailUrl(convertFileSrc(thumbnailPath));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [file?.path]);

  return (
    <PreviewButton file={file} onOpen={onOpen} label="图片" size={size}>
      {thumbnailUrl && !failed ? (
        <img
          className="size-full object-cover"
          src={thumbnailUrl}
          alt={file?.fileName ?? "图片缩略图"}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <FileImage className={cn("size-4", failed && "opacity-45")} />
      )}
    </PreviewButton>
  );
}

function PreviewButton({
  children,
  file,
  label,
  onOpen,
  size,
}: {
  children: ReactNode;
  file: MatchFile | null;
  label: string;
  onOpen: (path: string) => void;
  size: "sm" | "lg";
}) {
  const available = Boolean(file?.path);
  return (
    <button
      aria-label={available ? `打开${label} ${file?.fileName}` : `无${label}预览`}
      className={cn(
        "grid place-items-center overflow-hidden rounded-[7px] border border-border bg-secondary text-muted-foreground transition-colors motion-reduce:transition-none hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
        size === "lg" ? "h-32 w-full" : "size-11",
      )}
      disabled={!available}
      onClick={(event) => {
        event.stopPropagation();
        if (file?.path) onOpen(file.path);
      }}
      title={file?.fileName ?? `无${label}预览`}
      type="button"
    >
      {children}
    </button>
  );
}

function FileList({
  files,
  kind,
  onOpen,
}: {
  files: MatchFile[];
  kind: "image" | "raw";
  onOpen: (path: string) => void;
}) {
  if (files.length === 0) {
    return <div className="rounded-[7px] border border-border bg-secondary/72 px-3 py-2 text-xs text-muted-foreground">等待输入</div>;
  }

  return (
    <div className="grid gap-1.5">
      {files.slice(0, 6).map((file, index) => (
        <button
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[7px] border border-border bg-secondary/64 px-2 text-left text-xs transition-colors motion-reduce:transition-none hover:border-accent/50 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:border-border disabled:hover:bg-secondary/64"
          disabled={file.manual || !file.path}
          key={`${file.path || file.fileName}-${index}`}
          onClick={() => onOpen(file.path)}
          title={file.path || file.fileName}
          type="button"
        >
          {file.manual ? <ClipboardList className="size-3.5 text-muted-foreground" /> : kind === "image" ? <FileImage className="size-3.5 text-muted-foreground" /> : <FileArchive className="size-3.5 text-muted-foreground" />}
          <span className="min-w-0 truncate">{file.fileName}</span>
          {file.manual ? <Badge variant="muted">清单</Badge> : null}
        </button>
      ))}
      {files.length > 6 ? (
        <div className="rounded-[7px] border border-dashed border-border bg-secondary/72 px-2 py-1 text-center text-xs text-muted-foreground">
          另有 {files.length - 6} 个{kind === "image" ? "图片" : "RAW"}文件
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

function counterpartResultLabel(result: MatchResult, candidateNoun: string) {
  if (result.selectedCandidate) return result.selectedCandidate.fileName;
  if (result.status === "conflict") return `${result.candidates.length} 个${candidateNoun}候选`;
  return "-";
}
