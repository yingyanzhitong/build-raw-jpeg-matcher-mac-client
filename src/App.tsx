import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  defaultRawWorkspaceStatus,
  RawMatcherWorkspace,
} from "@/features/raw-matcher/RawMatcherWorkspace";
import type { MatchStatus } from "@/features/raw-matcher/types";
import { formatBytes } from "@/features/shared/ui";

type WorkspaceId = "raw-jpeg-matcher";
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
  "https://gitee.com/masongzhi1/raw-jpeg-matcher-mac-client/raw/main/release/latest.json";

function App() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("raw-jpeg-matcher");
  const [rawStatus, setRawStatus] = useState(defaultRawWorkspaceStatus);

  return (
    <TooltipProvider>
      <main className="desk-grid h-screen overflow-hidden text-foreground">
        <div className="grid h-full grid-rows-[64px_40px_minmax(0,1fr)_28px]">
          <AppHeader
            jpegCount={rawStatus.jpegCount}
            counts={rawStatus.counts}
            exportableCount={rawStatus.exportableCount}
          />

          <WorkspaceTabs activeWorkspace={activeWorkspace} onChange={setActiveWorkspace} />

          <div className="min-h-0 overflow-hidden">
            <RawMatcherWorkspace
              active={activeWorkspace === "raw-jpeg-matcher"}
              onStatusChange={setRawStatus}
            />
          </div>

          <FooterStatus
            jpegCount={rawStatus.jpegCount}
            rawDirectory={rawStatus.rawDirectory}
            rawStatusText={rawStatus.statusText}
          />
        </div>

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
    { id: "raw-jpeg-matcher", label: "RAW/JPEG配对", icon: <Search /> },
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
            RAW 原片配对导出
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
            "h-8 max-w-[11.5rem] overflow-hidden border-[#0c3b2e] bg-[#123f2d] px-2.5 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.12)] hover:bg-[#0f3526] disabled:opacity-100",
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
    <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-border bg-card/92 px-4 text-[11px] text-muted-foreground">
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
