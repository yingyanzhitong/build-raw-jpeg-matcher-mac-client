import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Files,
  FileImage,
  FolderInput,
  FolderOutput,
  Loader2,
  Split,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  inferLogLevel,
  LogPanel,
  Pane,
  PathDisplay,
  StatTile,
  type LogEntry,
  type LogLevel,
} from "@/features/shared/ui";
import type {
  SeparatedFile,
  SeparatorExportResponse,
  SeparatorExportSummary,
  SeparatorScanResponse,
} from "./types";

type SeparatorBusy = "scan" | "export" | null;

interface ExportReport {
  directory: string;
  summary: SeparatorExportSummary;
}

const previewLimit = 160;

export function FileSeparatorWorkspace({ active }: { active: boolean }) {
  const [inputRoot, setInputRoot] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [images, setImages] = useState<SeparatedFile[]>([]);
  const [raws, setRaws] = useState<SeparatedFile[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [busy, setBusy] = useState<SeparatorBusy>(null);
  const [logs, setLogs] = useState<LogEntry[]>([
    { level: "info", message: "等待选择包含图片与 RAW 的混合文件夹" },
  ]);
  const [exportReport, setExportReport] = useState<ExportReport | null>(null);

  const fileCount = images.length + raws.length;
  const canExport = inputRoot.length > 0 && outputRoot.length > 0 && fileCount > 0 && busy === null;
  const actionHint = getExportHint({ inputRoot, outputRoot, fileCount, busy });

  useEffect(() => {
    if (!active) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTextEditing || event.defaultPrevented || (!event.metaKey && !event.ctrlKey)) {
        return;
      }

      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (event.shiftKey) {
          void chooseOutputDirectory();
        } else {
          void chooseInputDirectory();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, busy, inputRoot]);

  function appendLogs(messages: string[], level?: LogLevel) {
    const entries = messages.map((message) => ({
      level: level ?? inferLogLevel(message),
      message,
    }));
    setLogs((current) => [...current, ...entries].slice(-300));
  }

  async function chooseInputDirectory() {
    if (busy !== null) {
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择包含图片与 RAW 的混合文件夹",
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("scan");
    try {
      const response = await invoke<SeparatorScanResponse>("scan_separator_source", {
        root: selected,
      });
      setInputRoot(response.rootDir);
      setOutputRoot("");
      setImages(response.images);
      setRaws(response.raws);
      setSkippedCount(response.skippedCount);
      setExportReport(null);
      setLogs(
        response.logs.map((message) => ({
          level: inferLogLevel(message),
          message,
        })),
      );
    } catch (error) {
      appendLogs([`扫描混合文件夹失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function chooseOutputDirectory() {
    if (busy !== null) {
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择分离输出目录",
      canCreateDirectories: true,
    });
    if (typeof selected !== "string") {
      return;
    }

    setOutputRoot(selected);
    setExportReport(null);
    appendLogs([`已选择分离输出目录: ${selected}`], "success");
  }

  async function exportFiles() {
    if (!canExport) {
      appendLogs([actionHint], "warning");
      return;
    }

    setBusy("export");
    try {
      const response = await invoke<SeparatorExportResponse>("export_separated_files", {
        inputRoot,
        files: [...images, ...raws],
        exportDir: outputRoot,
      });
      appendLogs(response.logs);
      setExportReport({ directory: outputRoot, summary: response.summary });
    } catch (error) {
      appendLogs([`分离文件失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function openOutputDirectory() {
    try {
      await invoke("open_file_path", { path: outputRoot });
    } catch (error) {
      appendLogs([`打开输出目录失败: ${String(error)}`], "error");
    }
  }

  return (
    <section
      aria-label="一键分离工作区"
      className={cn(
        "grid h-full min-h-0 grid-cols-1 overflow-auto bg-panel min-[960px]:grid-cols-[312px_minmax(0,1fr)] min-[960px]:overflow-hidden",
        !active && "hidden",
      )}
    >
      <aside className="min-h-[520px] border-r border-border bg-background/82 min-[960px]:min-h-0">
        <ScrollArea className="h-full min-h-0">
          <div className="grid min-h-[600px] content-start gap-0 p-4 pb-6 min-[960px]:min-h-0">
            <Pane
              icon={<FolderInput className="size-4" />}
              title="混合文件夹"
              subtitle={fileCount > 0 ? `已识别 ${fileCount} 个文件` : "包含图片与 RAW"}
            >
              <PathDisplay path={inputRoot} fallback="尚未选择混合文件夹" />
              <Button disabled={busy !== null} onClick={chooseInputDirectory} type="button">
                {busy === "scan" ? <Loader2 className="animate-spin" /> : <FolderInput />}
                选择混合文件夹
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                递归识别 JPG、JPEG、PNG 与已支持的 RAW 格式。
              </p>
            </Pane>

            <Pane
              icon={<FolderOutput className="size-4" />}
              title="分离输出"
              subtitle="将创建“图片”与“RAW”目录"
            >
              <PathDisplay path={outputRoot} fallback="尚未选择输出目录" />
              <Button
                disabled={busy !== null || inputRoot.length === 0}
                onClick={chooseOutputDirectory}
                variant="utility"
                type="button"
              >
                <FolderOutput />
                选择输出目录
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                保留源目录结构并复制文件；原始文件不会移动或改写。
              </p>
            </Pane>
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[620px] min-w-0 flex-col bg-card min-[960px]:min-h-0">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">一键分离</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">{actionHint}</p>
          </div>
          <Button disabled={!canExport} onClick={exportFiles} type="button">
            {busy === "export" ? <Loader2 className="animate-spin" /> : <Split />}
            开始分离
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-auto p-6 min-[1180px]:grid-cols-[minmax(0,1fr)_320px] min-[1180px]:overflow-hidden">
          <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card min-[1180px]:min-h-0">
            {inputRoot.length === 0 ? (
              <SeparatorEmptyState />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 border-b border-border bg-card p-3">
                  <StatTile label="图片" value={images.length} tone="success" />
                  <StatTile label="RAW" value={raws.length} />
                  <StatTile label="已跳过" value={skippedCount} tone={skippedCount > 0 ? "danger" : "neutral"} />
                </div>
                <SeparatorFileTable images={images} raws={raws} />
              </>
            )}
          </section>

          <div className="min-h-[240px] min-[1180px]:min-h-0">
            <LogPanel logs={logs} />
          </div>
        </div>

        {exportReport ? (
          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border bg-success/8 px-4 py-3 text-sm">
            <p className="min-w-0 truncate text-success">
              已完成分离：复制 {exportReport.summary.copiedCount} 个文件到“图片”和“RAW”目录。
            </p>
            <Button onClick={openOutputDirectory} size="sm" type="button" variant="utility">
              <FolderOutput />
              打开输出目录
            </Button>
          </footer>
        ) : null}
      </section>
    </section>
  );
}

function SeparatorEmptyState() {
  return (
    <div className="empty-workbench grid flex-1 place-items-center p-8 text-center">
      <div className="grid max-w-md justify-items-center gap-4">
        <span className="grid size-14 place-items-center rounded-[10px] border border-accent/20 bg-card text-accent shadow-[0_8px_20px_rgba(26,115,232,0.1)]">
          <Files className="size-6" />
        </span>
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.015em]">等待扫描混合文件夹</h3>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            选择目录后会预览可分离的图片和 RAW；确认输出位置后即可复制整理。
          </p>
        </div>
      </div>
    </div>
  );
}

function SeparatorFileTable({
  images,
  raws,
}: {
  images: SeparatedFile[];
  raws: SeparatedFile[];
}) {
  const files = [...images, ...raws];
  const previewFiles = files.slice(0, previewLimit);

  return (
    <section aria-label="待分离文件预览" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <h3 className="text-sm font-semibold">待分离文件</h3>
        <span className="text-xs text-muted-foreground">
          {files.length > previewLimit ? `预览前 ${previewLimit} 个 / 共 ${files.length} 个` : `共 ${files.length} 个`}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-[460px] divide-y divide-border text-xs">
          <div className="grid grid-cols-[72px_minmax(0,1fr)_88px] gap-3 bg-secondary/72 px-4 py-2.5 text-[11px] font-medium text-muted-foreground">
            <span>类型</span>
            <span>相对路径</span>
            <span className="text-right">大小</span>
          </div>
          {previewFiles.map((file) => (
            <div
              className="grid grid-cols-[72px_minmax(0,1fr)_88px] items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/45"
              key={file.path}
            >
              <span
                className={cn(
                  "inline-flex w-fit items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-medium",
                  file.kind === "image"
                    ? "border-success/35 bg-success/10 text-success"
                    : "border-accent/30 bg-accent/10 text-accent",
                )}
              >
                {file.kind === "image" ? <FileImage className="size-3" /> : <Files className="size-3" />}
                {file.kind === "image" ? "图片" : "RAW"}
              </span>
              <span className="truncate font-mono text-foreground/85" title={file.relativePath}>
                {file.relativePath}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

function getExportHint({
  inputRoot,
  outputRoot,
  fileCount,
  busy,
}: {
  inputRoot: string;
  outputRoot: string;
  fileCount: number;
  busy: SeparatorBusy;
}) {
  if (busy === "scan") {
    return "正在扫描混合文件夹…";
  }
  if (busy === "export") {
    return "正在复制分离文件…";
  }
  if (inputRoot.length === 0) {
    return "先选择包含图片与 RAW 的混合文件夹";
  }
  if (fileCount === 0) {
    return "未发现可分离的图片或 RAW 文件";
  }
  if (outputRoot.length === 0) {
    return "选择输出目录后即可开始分离";
  }
  return `将复制 ${fileCount} 个文件，原始文件保持不变`;
}
