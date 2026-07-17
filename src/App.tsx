import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Images,
  Loader2,
  Maximize2,
  Minus,
  PanelBottom,
  RotateCcw,
  Split,
  Stamp,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  defaultRawWorkspaceStatus,
  RawMatcherWorkspace,
} from "@/features/raw-matcher/RawMatcherWorkspace";
import { getDirectionConfig } from "@/features/raw-matcher/RawJpegMatcherView";
import {
  defaultSeparatorWorkspaceStatus,
  FileSeparatorWorkspace,
  type SeparatorWorkspaceStatus,
} from "@/features/file-separator/FileSeparatorWorkspace";
import {
  defaultWatermarkWorkspaceStatus,
  WatermarkWorkspace,
  type WatermarkWorkspaceStatus,
} from "@/features/watermark/WatermarkWorkspace";
import type { ExportFeedback, ExportToastState } from "@/features/shared/exportFeedback";
import { scrollLogViewportToTail } from "@/features/shared/logTail";
import {
  separatorWorkspaceStatusMetrics,
  watermarkWorkspaceStatusMetrics,
  type WorkspaceStatusMetric,
} from "@/features/shared/workspaceStatus";
import {
  ExportResultToast,
  formatBytes,
  type LogEntry,
  type LogLevel,
} from "@/features/shared/ui";

type Workspace = "matcher" | "separator" | "watermark";

const workspaceOrder: Workspace[] = ["matcher", "separator", "watermark"];
const workspaceLabels: Record<Workspace, string> = {
  matcher: "图片 / RAW 匹配",
  separator: "一键分离",
  watermark: "图片水印",
};

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "notAvailable"
  | "downloading"
  | "installing"
  | "installed"
  | "error";

interface UpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

const updateCheckTimeoutMs = 30_000;
const updateCheckIntervalMs = 60 * 60 * 1000;
const updateSourceLabel = "Gitee Release";
const updateManifestUrl =
  "https://gitee.com/masongzhi1/raw-jperaw-jpeg-matcher-mac-clientg-matcher-mac-client/raw/main/release/latest.json";

function App() {
  const [rawStatus, setRawStatus] = useState(defaultRawWorkspaceStatus);
  const [separatorStatus, setSeparatorStatus] = useState<SeparatorWorkspaceStatus>(
    defaultSeparatorWorkspaceStatus,
  );
  const [watermarkStatus, setWatermarkStatus] = useState<WatermarkWorkspaceStatus>(
    defaultWatermarkWorkspaceStatus,
  );
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>("matcher");
  const [exportToast, setExportToast] = useState<ExportToastState | null>(null);
  const nextExportToastIdRef = useRef(0);
  const closeLogPanel = useCallback(() => setLogPanelOpen(false), []);

  const reportExportFeedback = useCallback(
    (workspace: Workspace, feedback: ExportFeedback) => {
      nextExportToastIdRef.current += 1;
      setExportToast({ ...feedback, id: nextExportToastIdRef.current });
      if (feedback.tone === "error") {
        setActiveWorkspace(workspace);
        setLogPanelOpen(true);
      }
    },
    [],
  );

  const dismissExportToast = useCallback((id: number) => {
    setExportToast((current) => (current?.id === id ? null : current));
  }, []);

  function activateWorkspace(workspace: Workspace) {
    setActiveWorkspace(workspace);
    setLogPanelOpen(false);
  }

  useEffect(() => {
    function handleWorkspaceShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTextEditing || event.defaultPrevented || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      if (event.key === "1") {
        event.preventDefault();
        activateWorkspace("matcher");
      } else if (event.key === "2") {
        event.preventDefault();
        activateWorkspace("separator");
      } else if (event.key === "3") {
        event.preventDefault();
        activateWorkspace("watermark");
      } else if (event.key.toLowerCase() === "l" && event.shiftKey) {
        event.preventDefault();
        setLogPanelOpen((open) => !open);
      }
    }

    window.addEventListener("keydown", handleWorkspaceShortcut);
    return () => window.removeEventListener("keydown", handleWorkspaceShortcut);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("workspace-command", (event) => {
      if (event.payload === "toggle-log") {
        setLogPanelOpen((open) => !open);
        return;
      }

      const shortcut =
        event.payload === "choose-source"
          ? { key: "o", shiftKey: false }
          : event.payload === "choose-auxiliary"
            ? { key: "o", shiftKey: true }
            : event.payload === "export"
              ? { key: "e", shiftKey: false }
              : null;
      if (shortcut) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: shortcut.key,
            metaKey: true,
            shiftKey: shortcut.shiftKey,
          }),
        );
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Workspace>("workspace-menu-select", (event) => {
      if (!workspaceOrder.includes(event.payload)) {
        return;
      }
      setActiveWorkspace(event.payload);
      setLogPanelOpen(false);
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <TooltipProvider>
      <main className="desk-grid relative grid h-screen grid-rows-[54px_minmax(0,1fr)_30px] overflow-hidden text-foreground">
        <WindowTitlebar activeWorkspace={activeWorkspace} onChange={activateWorkspace} />
        <section className="codex-main min-h-0 overflow-hidden">
          <div
            aria-labelledby="workspace-tab-matcher"
            className={cn("h-full", activeWorkspace !== "matcher" && "hidden")}
            id="workspace-panel-matcher"
            role="tabpanel"
          >
            <RawMatcherWorkspace
              active={activeWorkspace === "matcher"}
              onExportFeedback={(feedback) => reportExportFeedback("matcher", feedback)}
              onStatusChange={setRawStatus}
              logPanelOpen={logPanelOpen}
              onToggleLogPanel={() => setLogPanelOpen((open) => !open)}
            />
          </div>
          <div
            aria-labelledby="workspace-tab-separator"
            className={cn("h-full", activeWorkspace !== "separator" && "hidden")}
            id="workspace-panel-separator"
            role="tabpanel"
          >
            <FileSeparatorWorkspace
              active={activeWorkspace === "separator"}
              logPanelOpen={logPanelOpen}
              onExportFeedback={(feedback) => reportExportFeedback("separator", feedback)}
              onStatusChange={setSeparatorStatus}
              onToggleLogPanel={() => setLogPanelOpen((open) => !open)}
            />
          </div>
          <div
            aria-labelledby="workspace-tab-watermark"
            className={cn("h-full", activeWorkspace !== "watermark" && "hidden")}
            id="workspace-panel-watermark"
            role="tabpanel"
          >
            <WatermarkWorkspace
              active={activeWorkspace === "watermark"}
              logPanelOpen={logPanelOpen}
              onExportFeedback={(feedback) => reportExportFeedback("watermark", feedback)}
              onStatusChange={setWatermarkStatus}
              onToggleLogPanel={() => setLogPanelOpen((open) => !open)}
            />
          </div>
        </section>
        {activeWorkspace === "matcher" ? (
          <MatcherStatusOverlay status={rawStatus} />
        ) : activeWorkspace === "separator" ? (
          <SeparatorStatusOverlay status={separatorStatus} />
        ) : (
          <WatermarkStatusOverlay status={watermarkStatus} />
        )}
        <LogBottomSheet
          open={logPanelOpen}
          logs={
            activeWorkspace === "matcher"
              ? rawStatus.logs
              : activeWorkspace === "separator"
                ? separatorStatus.logs
                : watermarkStatus.logs
          }
          onClose={closeLogPanel}
        />
        <ExportResultToast onDismiss={dismissExportToast} toast={exportToast} />
      </main>
    </TooltipProvider>
  );
}

function WorkspaceSwitcher({
  activeWorkspace,
  onChange,
}: {
  activeWorkspace: Workspace;
  onChange: (workspace: Workspace) => void;
}) {
  function activateWithFocus(workspace: Workspace) {
    onChange(workspace);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-workspace-tab="${workspace}"]`)?.focus();
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const currentIndex = workspaceOrder.indexOf(activeWorkspace);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? workspaceOrder.length - 1
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + workspaceOrder.length) % workspaceOrder.length
            : (currentIndex + 1) % workspaceOrder.length;
    activateWithFocus(workspaceOrder[nextIndex]);
  }

  return (
    <nav aria-label="功能工作区" className="pointer-events-auto" data-tauri-drag-region="false">
      <div className="mac-segmented-control flex h-8 items-center gap-0.5 rounded-[8px] p-[3px]" role="tablist">
        {workspaceOrder.map((workspace) => (
          <button
            aria-controls={`workspace-panel-${workspace}`}
            aria-selected={activeWorkspace === workspace}
            className={cn(
              "inline-flex h-[26px] min-w-[126px] items-center justify-center gap-1.5 rounded-[6px] px-3 text-[12px] font-medium transition-[background,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              activeWorkspace === workspace
                ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.08)]"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-workspace-tab={workspace}
            id={`workspace-tab-${workspace}`}
            key={workspace}
            onClick={() => onChange(workspace)}
            onKeyDown={handleKeyDown}
            role="tab"
            tabIndex={activeWorkspace === workspace ? 0 : -1}
            type="button"
          >
            {workspace === "matcher" ? (
              <Images className="size-3.5" />
            ) : workspace === "separator" ? (
              <Split className="size-3.5" />
            ) : (
              <Stamp className="size-3.5" />
            )}
            {workspaceLabels[workspace]}
          </button>
        ))}
      </div>
    </nav>
  );
}

function WindowTitlebar({
  activeWorkspace,
  onChange,
}: {
  activeWorkspace: Workspace;
  onChange: (workspace: Workspace) => void;
}) {
  return (
    <header className="mac-titlebar relative grid h-[54px] grid-cols-[1fr_auto_1fr] items-center border-b border-border/70 px-3">
      <div className="absolute inset-0" data-tauri-drag-region />
      {!isTauriRuntime() ? <BrowserWindowControls /> : null}
      <div className="pointer-events-none relative z-10 col-start-1 flex min-w-0 items-center pl-[84px]">
        <div className="min-w-0">
          <h1 className="truncate text-[12px] font-semibold leading-none tracking-[-0.01em] text-foreground/90">
            照片配对助手
          </h1>
          <p className="mt-1 truncate text-[10px] leading-none text-muted-foreground">
            本地摄影工作流
          </p>
        </div>
      </div>
      <div className="relative z-20 col-start-2">
        <WorkspaceSwitcher activeWorkspace={activeWorkspace} onChange={onChange} />
      </div>
      <div className="relative z-20 col-start-3 flex justify-end" data-tauri-drag-region="false">
        <UpdateButton />
      </div>
    </header>
  );
}

function BrowserWindowControls() {
  return (
    <div className="absolute left-4 top-[17px] z-10 flex items-center gap-2">
      <WindowControl
        ariaLabel="关闭窗口"
        className="after:bg-[#ff5f57]"
        icon={<X />}
        onClick={() => getCurrentWindow().close()}
      />
      <WindowControl
        ariaLabel="最小化窗口"
        className="after:bg-[#ffbd2e]"
        icon={<Minus />}
        onClick={() => getCurrentWindow().minimize()}
      />
      <WindowControl
        ariaLabel="缩放窗口"
        className="after:bg-[#28c840]"
        icon={<Maximize2 />}
        onClick={() => getCurrentWindow().toggleMaximize()}
      />
    </div>
  );
}

function WindowControl({
  ariaLabel,
  className,
  icon,
  onClick,
}: {
  ariaLabel: string;
  className: string;
  icon: ReactNode;
  onClick: () => Promise<void>;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn(
        "group relative grid size-5 place-items-center rounded-full text-black/60 transition-transform after:absolute after:size-3 after:rounded-full after:content-[''] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      onClick={() => {
        if (isTauriRuntime()) {
          void onClick();
        }
      }}
      type="button"
    >
      <span className="sr-only">{ariaLabel}</span>
      <span className="relative z-10 opacity-0 transition-opacity group-hover:opacity-100 [&_svg]:size-2 [&_svg]:stroke-[2.5]">
        {icon}
      </span>
    </button>
  );
}

function MatcherStatusOverlay({
  status,
}: {
  status: typeof defaultRawWorkspaceStatus;
}) {
  const config = getDirectionConfig(status.direction);

  return (
    <WorkspaceStatusOverlay
      ariaLabel="当前配对统计"
      metrics={[
        { label: config.inputNoun, value: status.inputCount },
        {
          label: "匹配",
          value: status.counts.matched + status.counts.confirmed,
          tone: "success",
        },
        { label: "冲突", value: status.counts.conflict, tone: "danger" },
        { label: "可导出", value: status.exportableCount, tone: "accent" },
      ]}
    />
  );
}

function SeparatorStatusOverlay({ status }: { status: SeparatorWorkspaceStatus }) {
  return (
    <WorkspaceStatusOverlay
      ariaLabel="当前分离统计"
      metrics={separatorWorkspaceStatusMetrics(status)}
    />
  );
}

function WatermarkStatusOverlay({ status }: { status: WatermarkWorkspaceStatus }) {
  return (
    <WorkspaceStatusOverlay
      ariaLabel="当前水印统计"
      metrics={watermarkWorkspaceStatusMetrics(status)}
    />
  );
}

function WorkspaceStatusOverlay({
  ariaLabel,
  metrics,
}: {
  ariaLabel: string;
  metrics: WorkspaceStatusMetric[];
}) {
  return (
    <footer
      aria-label={ariaLabel}
      className="mac-statusbar flex min-w-0 items-center justify-end border-t border-border px-5 text-xs"
    >
      <div className="flex items-center gap-4">
        {metrics.map((metric) => (
          <HeaderMetric key={metric.label} {...metric} />
        ))}
      </div>
    </footer>
  );
}

function HeaderMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: WorkspaceStatusMetric["tone"];
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px]">
      <span className="truncate text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "font-mono text-[12px] tabular-nums text-foreground",
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

const logLevelLabel: Record<LogLevel, string> = {
  info: "INF",
  success: "SUC",
  warning: "WRN",
  error: "ERR",
};

function LogBottomSheet({
  open,
  logs,
  onClose,
}: {
  open: boolean;
  logs: LogEntry[];
  onClose: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const latestLogMessage = logs.at(-1)?.message ?? "";

  useEffect(() => {
    if (!open) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (viewportRef.current) {
        scrollLogViewportToTail(viewportRef.current);
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [latestLogMessage, logs.length, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const frameId = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <section
      aria-label="运行日志"
      aria-live="polite"
      className="absolute bottom-[42px] left-4 right-4 z-30 h-[280px] max-h-[46vh] animate-in fade-in slide-in-from-bottom-3 duration-150 min-[960px]:left-[312px]"
    >
      <div className="grid h-full grid-rows-[48px_minmax(0,1fr)] overflow-hidden rounded-[8px] border border-border bg-card shadow-[0_14px_42px_rgba(32,33,36,0.16)]">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-7 place-items-center rounded-[7px] border border-border bg-secondary text-muted-foreground">
              <PanelBottom className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold leading-none">运行日志</h2>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{logs.length} 条记录</p>
            </div>
          </div>
          <Button ref={closeButtonRef} aria-label="关闭日志" variant="ghost" size="icon-sm" onClick={onClose} type="button">
            <X />
          </Button>
        </header>
        <ScrollArea className="min-h-0 bg-panel" viewportRef={viewportRef}>
          <div className="divide-y divide-border font-mono text-[12px]">
            {logs.map((log, index) => (
              <div
                className="grid grid-cols-[48px_42px_minmax(0,1fr)] items-start gap-2 px-4 py-2.5"
                key={`${log.message}-${index}`}
              >
                <span className="text-muted-foreground tabular-nums">
                  {String(index + 1).padStart(3, "0")}
                </span>
                <span
                  className={cn(
                    "h-5 rounded-[4px] border text-center text-[10px] font-semibold uppercase leading-5",
                    log.level === "info" && "border-border bg-card text-muted-foreground",
                    log.level === "success" && "border-success/40 bg-success/12 text-success",
                    log.level === "warning" && "border-warning/45 bg-warning/12 text-warning",
                    log.level === "error" && "border-destructive/45 bg-destructive/12 text-destructive",
                  )}
                  title={log.level}
                >
                  {logLevelLabel[log.level]}
                </span>
                <p className="min-w-0 [overflow-wrap:anywhere] text-panel-foreground/82">
                  {log.message}
                </p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </section>
  );
}

function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<UpdateProgress>({
    downloadedBytes: 0,
    totalBytes: null,
  });
  const checkInFlightRef = useRef(false);
  const installInFlightRef = useRef(false);
  const pendingUpdateRef = useRef<Update | null>(null);

  useEffect(() => {
    pendingUpdateRef.current = pendingUpdate;
  }, [pendingUpdate]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    void getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(""));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;
    const runCheck = () => {
      if (!cancelled) {
        void checkForUpdates();
      }
    };
    runCheck();
    const intervalId = window.setInterval(runCheck, updateCheckIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  async function checkForUpdates() {
    if (
      !isTauriRuntime() ||
      checkInFlightRef.current ||
      installInFlightRef.current ||
      pendingUpdateRef.current
    ) {
      return;
    }

    checkInFlightRef.current = true;
    setStatus("checking");
    setMessage("");
    setProgress({ downloadedBytes: 0, totalBytes: null });

    try {
      const latestUpdate = await check({ timeout: updateCheckTimeoutMs });
      setPendingUpdate(latestUpdate);

      if (latestUpdate) {
        setStatus("available");
        setMessage(`发现新版本 ${latestUpdate.version}`);
        return;
      }

      setStatus("notAvailable");
      setMessage("");
    } catch {
      setPendingUpdate(null);
      setStatus("idle");
      setMessage("");
    } finally {
      checkInFlightRef.current = false;
    }
  }

  async function installPendingUpdate() {
    if (installInFlightRef.current || !pendingUpdate) {
      return;
    }

    installInFlightRef.current = true;
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
      await relaunch();
    } catch (error) {
      setStatus("error");
      setMessage(formatUpdateError(error));
    } finally {
      installInFlightRef.current = false;
    }
  }

  function handleButtonClick() {
    setDialogOpen(true);
  }

  const label = getUpdateButtonLabel(status, pendingUpdate, progress);
  const visibleLabel = status === "available" ? "更新" : label;

  if (
    !pendingUpdate &&
    status !== "downloading" &&
    status !== "installing" &&
    status !== "installed" &&
    status !== "error"
  ) {
    return null;
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={label}
            className={cn(
              "h-6 max-w-[7rem] overflow-hidden rounded-[6px] border-accent bg-accent px-2.5 text-[11px] font-semibold leading-none text-accent-foreground shadow-none hover:bg-accent/90 disabled:opacity-100",
              status === "error" &&
                "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
            disabled={status === "installed"}
            onClick={handleButtonClick}
            type="button"
            variant="utility"
          >
            <UpdateButtonIcon status={status} />
            <span className="min-w-0 truncate">{visibleLabel}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {message || `发现 ${pendingUpdate?.version ?? "新版本"}，打开更新详情`}
        </TooltipContent>
      </Tooltip>
      <UpdateDialog
        currentVersion={currentVersion}
        message={message}
        onCheck={() => void checkForUpdates()}
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

export default App;
