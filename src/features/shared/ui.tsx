import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

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

export function Pane({
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
    <section className="rounded-[8px] border border-border bg-card p-3 shadow-[0_1px_1px_rgba(0,0,0,0.025)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-[7px] border border-border bg-secondary text-muted-foreground">
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
    <div className="rounded-[7px] border border-border bg-secondary/72 p-2.5">
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

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  return (
    <section
      aria-label="运行日志"
      aria-live="polite"
      className="flex min-h-[220px] flex-1 flex-col overflow-hidden rounded-[8px] border border-border bg-panel text-panel-foreground"
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
        "codex-scrollbar flex min-w-0 items-center overflow-x-auto rounded-[7px] border border-input bg-secondary/64 px-2.5 font-mono text-xs text-muted-foreground",
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
  if (/完成|已匹配|已导出|已确认|已加入|已复制|准备完成|扫描完成/.test(message)) {
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
