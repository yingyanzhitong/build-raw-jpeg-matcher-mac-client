import { AlertTriangle, Check, CheckCircle2, CircleX } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ExportToastState } from "./exportFeedback";

export type LogLevel = "info" | "success" | "warning" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
}

const logLevelCode: Record<LogLevel, string> = {
  info: "INF",
  success: "SUC",
  warning: "WRN",
  error: "ERR",
};

export function ExportResultToast({
  toast,
  onDismiss,
}: {
  toast: ExportToastState | null;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    if (!toast) {
      return;
    }

    const toastId = toast.id;
    const timeoutId = window.setTimeout(
      () => onDismiss(toastId),
      toast.tone === "error" ? 5_000 : 3_200,
    );
    return () => window.clearTimeout(timeoutId);
  }, [onDismiss, toast]);

  if (!toast) {
    return null;
  }

  const Icon =
    toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? CircleX : AlertTriangle;

  return (
    <aside
      aria-atomic="true"
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={cn(
        "pointer-events-none fixed right-5 top-[70px] z-[80] grid max-w-[min(440px,calc(100vw-2rem))] grid-cols-[auto_minmax(0,1fr)] gap-2.5 rounded-[9px] border bg-card px-4 py-3.5 text-card-foreground shadow-[0_18px_54px_rgba(32,33,36,0.2)] animate-in fade-in-0 slide-in-from-top-2 duration-200 motion-reduce:animate-none",
        toast.tone === "success" && "border-success/30",
        toast.tone === "warning" && "border-warning/30",
        toast.tone === "error" && "border-destructive/35",
      )}
      key={toast.id}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <span
        className={cn(
          "mt-0.5 grid size-6 place-items-center rounded-full",
          toast.tone === "success" && "bg-success/12 text-success",
          toast.tone === "warning" && "bg-warning/12 text-warning",
          toast.tone === "error" && "bg-destructive/12 text-destructive",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <strong className="block text-sm font-semibold leading-5">{toast.title}</strong>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
          {toast.message}
        </span>
      </span>
    </aside>
  );
}

export function Pane({
  icon,
  title,
  subtitle,
  children,
  complete = false,
  current = false,
  step,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
  complete?: boolean;
  current?: boolean;
  step?: number;
}) {
  const stepLabel = complete ? "已完成" : current ? "当前步骤" : "待完成";

  return (
    <section className="mac-inspector-section py-4 first:pt-1 last:pb-0">
      <div className="mb-3 flex items-center gap-2.5 px-1">
        {step !== undefined ? (
          <span
            aria-current={current ? "step" : undefined}
            aria-label={`第 ${step} 步，${stepLabel}`}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-full border border-transparent text-[11px] font-semibold",
              complete
                ? "bg-success text-white"
                : current
                  ? "bg-accent text-accent-foreground"
                  : "border-border bg-card/55 text-muted-foreground",
            )}
          >
            {complete ? <Check className="size-4" /> : step}
          </span>
        ) : null}
        <span className="grid size-5 place-items-center text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h2 className="truncate text-[13px] font-semibold leading-none">{title}</h2>
            {step !== undefined ? (
              <span
                className={cn(
                  "shrink-0 text-[10px] font-medium",
                  complete
                    ? "text-success"
                    : current
                      ? "text-accent"
                      : "text-muted-foreground",
                )}
              >
                {stepLabel}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="grid gap-2.5">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div className="rounded-[6px] bg-secondary/60 px-3 py-2">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "mt-1 block font-mono text-xl leading-none tabular-nums",
          tone === "success" && "text-success",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </strong>
    </div>
  );
}

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  return (
    <section
      aria-label="运行日志"
      aria-live="polite"
      className="flex min-h-[220px] flex-1 flex-col overflow-hidden rounded-[8px] border border-border bg-card text-panel-foreground"
    >
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <h2 className="text-sm font-semibold">运行日志</h2>
        <Badge variant="muted">
          {logs.length}
        </Badge>
      </div>
      <ScrollArea className="log-surface min-h-0 flex-1">
        <div className="divide-y divide-border py-1 font-mono text-[12px]">
          {logs.map((log, index) => (
            <div
              className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 px-3 py-2"
              key={`${log.message}-${index}`}
            >
              <span className="grid gap-1">
                <span className="text-accent tabular-nums">{String(index + 1).padStart(3, "0")}</span>
                <span
                  className={cn(
                    "h-5 w-10 rounded-[4px] border text-center text-[10px] font-semibold uppercase leading-5",
                    log.level === "info" && "border-border bg-card text-muted-foreground",
                    log.level === "success" && "border-success/40 bg-success/12 text-success",
                    log.level === "warning" && "border-warning/45 bg-warning/12 text-warning",
                    log.level === "error" && "border-destructive/45 bg-destructive/12 text-destructive",
                  )}
                  title={log.level}
                >
                  {logLevelCode[log.level]}
                </span>
              </span>
              <p className="min-w-0 [overflow-wrap:anywhere] text-panel-foreground/82">
                {log.message}
              </p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

export function PathDisplay({
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
        "codex-scrollbar flex min-w-0 items-center overflow-x-auto rounded-[7px] border border-input bg-card px-2.5 font-mono text-xs text-muted-foreground",
        compact ? "h-9" : "min-h-10",
        className,
      )}
      title={path || fallback}
    >
      <span className="min-w-max whitespace-nowrap py-2">{path || fallback}</span>
    </div>
  );
}

export function inferLogLevel(message: string): LogLevel {
  if (/失败|错误|不存在|不是目录|无法/.test(message)) {
    return "error";
  }
  if (/跳过|冲突|未找到|缺少|重复/.test(message)) {
    return "warning";
  }
  if (/完成|已匹配|已导出|已确认|已加入|已复制|已移动|准备完成|扫描完成/.test(message)) {
    return "success";
  }
  return "info";
}

export function formatBytes(bytes: number) {
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

export function formatTime(timestamp: number | null) {
  if (!timestamp) {
    return "-";
  }
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    hour12: false,
  });
}
