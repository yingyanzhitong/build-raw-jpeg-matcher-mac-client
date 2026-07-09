import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  PanelBottom,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { formatBytes, type LogEntry, type LogLevel } from "@/features/shared/ui";

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
  const [logPanelOpen, setLogPanelOpen] = useState(false);

  return (
    <TooltipProvider>
      <main className="desk-grid relative h-screen overflow-hidden text-foreground">
        <section className="codex-main grid h-full min-h-0 grid-rows-[64px_minmax(0,1fr)_28px] overflow-hidden">
          <AppHeader
            status={rawStatus}
            logPanelOpen={logPanelOpen}
            onToggleLogPanel={() => setLogPanelOpen((open) => !open)}
          />
          <div className="min-h-0 overflow-hidden">
            <RawMatcherWorkspace
              active
              onStatusChange={setRawStatus}
            />
          </div>

          <FooterStatus
            jpegCount={rawStatus.jpegCount}
            rawDirectory={rawStatus.rawDirectory}
            rawStatusText={rawStatus.statusText}
          />
        </section>
        <LogBottomSheet
          open={logPanelOpen}
          logs={rawStatus.logs}
          onClose={() => setLogPanelOpen(false)}
        />
      </main>
    </TooltipProvider>
  );
}

function AppHeader({
  status,
  logPanelOpen,
  onToggleLogPanel,
}: {
  status: typeof defaultRawWorkspaceStatus;
  logPanelOpen: boolean;
  onToggleLogPanel: () => void;
}) {
  return (
    <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-card px-6">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center">
          <h2 className="truncate text-[15px] font-semibold leading-none">RAW/JPEG 配对</h2>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          按 JPG 文件名查找并导出对应 RAW 原片
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-2 justify-self-end">
        <div className="hidden items-center gap-1.5 rounded-[8px] border border-border bg-secondary/62 p-1 lg:flex">
          <HeaderMetric label="JPG" value={status.jpegCount} />
          <HeaderMetric
            label="匹配"
            value={status.counts.matched + status.counts.confirmed}
            tone="success"
          />
          <HeaderMetric label="冲突" value={status.counts.conflict} tone="danger" />
          <HeaderMetric label="可导出" value={status.exportableCount} tone="accent" />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={logPanelOpen ? "隐藏日志" : "显示日志"}
              aria-pressed={logPanelOpen}
              className={cn(
                "size-8 rounded-[8px]",
                logPanelOpen && "border-accent/30 bg-accent/10 text-accent hover:bg-accent/14",
              )}
              variant="utility"
              size="icon-sm"
              onClick={onToggleLogPanel}
              type="button"
            >
              <PanelBottom />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{logPanelOpen ? "隐藏日志" : "显示日志"}</TooltipContent>
        </Tooltip>
        <UpdateButton />
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
    <div className="grid h-7 min-w-[4.25rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 rounded-[6px] px-2 text-[11px]">
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
  if (!open) {
    return null;
  }

  return (
    <section
      aria-label="运行日志"
      aria-live="polite"
      className="absolute bottom-9 left-4 right-4 z-30 h-[260px] max-h-[42vh] animate-in fade-in slide-in-from-bottom-3 duration-150 min-[960px]:left-[312px]"
    >
      <div className="grid h-full grid-rows-[44px_minmax(0,1fr)] overflow-hidden rounded-[8px] border border-border bg-card shadow-[0_-12px_40px_rgba(0,0,0,0.12)]">
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
          <Button aria-label="关闭日志" variant="ghost" size="icon-sm" onClick={onClose} type="button">
            <X />
          </Button>
        </header>
        <ScrollArea className="min-h-0 bg-panel">
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
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<UpdateProgress>({
    downloadedBytes: 0,
    totalBytes: null,
  });
  const checkInFlightRef = useRef(false);
  const installInFlightRef = useRef(false);
  const pendingUpdateRef = useRef<Update | null>(null);

  const isBusy =
    status === "checking" || status === "downloading" || status === "installing";

  useEffect(() => {
    pendingUpdateRef.current = pendingUpdate;
  }, [pendingUpdate]);

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

      setStatus("idle");
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
    if (isBusy || status === "installed") {
      return;
    }
    void installPendingUpdate();
  }

  const label = getUpdateButtonLabel(status, pendingUpdate, progress);

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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            "h-8 max-w-[11.5rem] overflow-hidden border-accent/24 bg-accent/10 px-2.5 text-xs text-accent shadow-none hover:bg-accent/14 disabled:opacity-100",
            status === "error" &&
              "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/14",
          )}
          disabled={status === "downloading" || status === "installing" || status === "installed"}
          onClick={handleButtonClick}
          type="button"
          variant="utility"
        >
          <UpdateButtonIcon status={status} />
          <span className="min-w-0 truncate">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {message || `发现 ${pendingUpdate?.version ?? "新版本"}，点击自动更新并重启`}
      </TooltipContent>
    </Tooltip>
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

function FooterStatus({
  jpegCount,
  rawDirectory,
  rawStatusText,
}: {
  jpegCount: number;
  rawDirectory: string;
  rawStatusText: string;
}) {
  return (
    <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-border bg-card px-6 text-[11px] text-muted-foreground">
      <span className="truncate">
        JPG {jpegCount} · RAW {rawDirectory ? "已选择" : "未选择"}
      </span>
      <span className="font-mono tabular-nums">{rawStatusText}</span>
    </footer>
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
