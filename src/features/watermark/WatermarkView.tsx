import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Download,
  ExternalLink,
  Eye,
  FileImage,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  SlidersHorizontal,
  Type,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
  WatermarkConfig,
  WatermarkExportResponse,
  WatermarkExportSummary,
  WatermarkImageInput,
  WatermarkMode,
  WatermarkScanResponse,
  WatermarkSource,
} from "./types";
import {
  formatBytes,
  formatTime,
  inferLogLevel,
  LogPanel,
  Pane,
  PathDisplay,
  StatTile,
  type LogEntry,
  type LogLevel,
} from "../shared/ui";

type WatermarkBusy = "scan" | "export" | null;

interface Size {
  width: number;
  height: number;
}

interface ImageFrame extends Size {
  left: number;
  top: number;
}

interface WatermarkExportReport {
  directory: string;
  summary: WatermarkExportSummary;
}

const defaultWatermarkConfig: WatermarkConfig = {
  opacity: 0.72,
  sizePercent: 22,
  autoRemoveBackground: true,
  backgroundTolerance: 34,
  edgeFeather: 2,
  shadowStrength: 0.28,
  layout: "single",
};

export function WatermarkView({ active }: { active: boolean }) {
  const [inputRoot, setInputRoot] = useState("");
  const [images, setImages] = useState<WatermarkImageInput[]>([]);
  const [mode, setMode] = useState<WatermarkMode>("text");
  const [watermarkText, setWatermarkText] = useState("照片配对助手");
  const [watermarkImagePath, setWatermarkImagePath] = useState("");
  const [config, setConfig] = useState<WatermarkConfig>(defaultWatermarkConfig);
  const [logs, setLogs] = useState<LogEntry[]>([
    { level: "info", message: "等待选择图片输入目录" },
  ]);
  const [busy, setBusy] = useState<WatermarkBusy>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [exportReport, setExportReport] = useState<WatermarkExportReport | null>(null);
  const [originalPreviewOpen, setOriginalPreviewOpen] = useState(false);

  const hasValidWatermark =
    mode === "text" ? watermarkText.trim().length > 0 : watermarkImagePath.length > 0;
  const canExport = images.length > 0 && hasValidWatermark && busy === null;
  const previewImage = images[0];
  const previewImageUrl = previewImage?.path ? convertFileSrc(previewImage.path) : "";
  const previewWatermarkUrl =
    mode === "image" && watermarkImagePath ? convertFileSrc(watermarkImagePath) : previewUrl;

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    if (mode === "image") {
      setPreviewUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return "";
      });
      return;
    }

    renderTextWatermarkPreview(watermarkText || "Watermark", config)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return url;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl("");
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [config, mode, watermarkText]);

  function appendWatermarkLogs(nextLogs: string[], level?: LogLevel) {
    const entries = nextLogs.map((message) => ({
      level: level ?? inferLogLevel(message),
      message,
    }));
    setLogs((current) => [...current, ...entries].slice(-300));
  }

  async function chooseInputDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择图片输入目录",
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("scan");
    try {
      const response = await invoke<WatermarkScanResponse>("scan_watermark_images", {
        root: selected,
      });
      setInputRoot(response.rootDir);
      setImages(response.images);
      setSkippedCount(response.skippedCount);
      setDuplicateCount(response.duplicateCount);
      appendWatermarkLogs(response.logs);
    } catch (error) {
      appendWatermarkLogs([`扫描图片输入失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function chooseWatermarkImage() {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "水印图片", extensions: ["jpg", "jpeg", "png"] }],
      title: "选择水印图片",
    });
    if (typeof selected !== "string") {
      return;
    }

    setWatermarkImagePath(selected);
    appendWatermarkLogs([`已选择图片水印: ${selected}`], "success");
  }

  async function openWatermarkPath(path: string) {
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      appendWatermarkLogs([`打开图片失败: ${String(error)}`], "error");
    }
  }

  async function exportWatermarkedImages() {
    if (images.length === 0) {
      appendWatermarkLogs(["缺少图片输入，无法导出水印图片"], "warning");
      return;
    }
    if (mode === "text" && watermarkText.trim().length === 0) {
      appendWatermarkLogs(["文字水印文案为空，无法导出"], "warning");
      return;
    }
    if (mode === "image" && watermarkImagePath.length === 0) {
      appendWatermarkLogs(["尚未选择图片水印，无法导出"], "warning");
      return;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择水印导出目录",
      canCreateDirectories: true,
    });
    if (typeof selected !== "string") {
      return;
    }

    setBusy("export");
    try {
      const source: WatermarkSource =
        mode === "text"
          ? await createTextWatermarkSource(watermarkText)
          : { type: "imageFile", path: watermarkImagePath };
      const response = await invoke<WatermarkExportResponse>("export_watermarked_images", {
        inputRoot,
        images,
        exportDir: selected,
        source,
        config,
      });
      appendWatermarkLogs(response.logs);
      setExportReport({ directory: selected, summary: response.summary });
    } catch (error) {
      appendWatermarkLogs([`导出水印图片失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  function updateConfig<K extends keyof WatermarkConfig>(key: K, value: WatermarkConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  return (
    <section
      className={cn(
        "grid h-full min-h-0 grid-cols-1 overflow-auto min-[1100px]:grid-cols-[300px_minmax(0,1fr)_280px] min-[1100px]:overflow-hidden",
        !active && "hidden",
      )}
    >
      <aside className="min-h-[560px] border-r border-border bg-background/78 min-[1100px]:min-h-0">
        <ScrollArea className="h-full min-h-0">
          <div className="grid min-h-[720px] gap-3 p-3 pb-6 min-[1100px]:min-h-0">
            <Pane
              icon={<FileImage className="size-4" />}
              title="图片输入"
              subtitle={`${images.length} 张图片已加入`}
            >
              <PathDisplay path={inputRoot} fallback="尚未选择图片输入目录" />
              <Button
                variant="default"
                onClick={chooseInputDirectory}
                disabled={busy !== null}
                type="button"
              >
                {busy === "scan" ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                选择图片目录
              </Button>
              <WatermarkImageList images={images} onOpen={openWatermarkPath} />
            </Pane>

            <Pane
              icon={<SlidersHorizontal className="size-4" />}
              title="水印配置"
              subtitle={mode === "text" ? "文字水印" : "图片水印"}
            >
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={mode === "text" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => setMode("text")}
                  type="button"
                >
                  <Type />
                  文字
                </Button>
                <Button
                  variant={mode === "image" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => setMode("image")}
                  type="button"
                >
                  <ImageIcon />
                  图片
                </Button>
              </div>

              {mode === "text" ? (
                <textarea
                  aria-label="文字水印内容"
                  className="min-h-20 resize-y rounded-[5px] border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/25"
                  name="watermarkText"
                  value={watermarkText}
                  onChange={(event) => setWatermarkText(event.target.value)}
                  placeholder="输入文字水印"
                  disabled={busy !== null}
                  spellCheck={false}
                />
              ) : (
                <>
                  <PathDisplay
                    path={watermarkImagePath}
                    fallback="尚未选择图片水印"
                    compact
                  />
                  <Button
                    variant="utility"
                    onClick={chooseWatermarkImage}
                    disabled={busy !== null}
                    type="button"
                  >
                    <ImageIcon />
                    选择水印图片
                  </Button>
                </>
              )}

              <RangeControl
                label="透明度"
                value={config.opacity}
                min={0.1}
                max={1}
                step={0.01}
                suffix="%"
                formatValue={(value) => Math.round(value * 100).toString()}
                onChange={(value) => updateConfig("opacity", value)}
              />
              <RangeControl
                label="尺寸"
                value={config.sizePercent}
                min={4}
                max={60}
                step={1}
                suffix="%"
                onChange={(value) => updateConfig("sizePercent", value)}
              />
              <RangeControl
                label="阴影"
                value={config.shadowStrength}
                min={0}
                max={1}
                step={0.01}
                suffix="%"
                formatValue={(value) => Math.round(value * 100).toString()}
                onChange={(value) => updateConfig("shadowStrength", value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={config.layout === "single" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => updateConfig("layout", "single")}
                  type="button"
                >
                  <Eye />
                  单点
                </Button>
                <Button
                  variant={config.layout === "tile" ? "accent" : "utility"}
                  size="sm"
                  onClick={() => updateConfig("layout", "tile")}
                  type="button"
                >
                  <LayoutGrid />
                  平铺
                </Button>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-[5px] border border-border bg-background px-3 py-2 text-xs">
                <span className="font-medium">自动去背景</span>
                <input
                  aria-label="自动去背景"
                  className="size-4 accent-[var(--accent)]"
                  name="autoRemoveBackground"
                  type="checkbox"
                  checked={config.autoRemoveBackground}
                  onChange={(event) => updateConfig("autoRemoveBackground", event.target.checked)}
                  disabled={mode !== "image" || busy !== null}
                />
              </label>
              <RangeControl
                label="背景容差"
                value={config.backgroundTolerance}
                min={0}
                max={120}
                step={1}
                disabled={mode !== "image" || !config.autoRemoveBackground}
                onChange={(value) => updateConfig("backgroundTolerance", value)}
              />
              <RangeControl
                label="边缘柔化"
                value={config.edgeFeather}
                min={0}
                max={8}
                step={1}
                disabled={mode !== "image" || !config.autoRemoveBackground}
                onChange={(value) => updateConfig("edgeFeather", Math.round(value))}
              />
            </Pane>
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[620px] min-w-0 flex-col border-r border-border bg-card/72 min-[1100px]:min-h-0">
        <div className="border-b border-border bg-card/82 px-3 py-2.5 backdrop-blur">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="accent"
              onClick={exportWatermarkedImages}
              disabled={!canExport}
              type="button"
            >
              {busy === "export" ? <Loader2 className="animate-spin" /> : <Download />}
              导出加水印图片
            </Button>
            <Badge variant={hasValidWatermark ? "success" : "warning"}>
              {hasValidWatermark ? "配置有效" : "待配置"}
            </Badge>
          </div>
        </div>

        <section className="grid min-h-0 flex-1 grid-rows-[minmax(220px,0.9fr)_minmax(220px,1.1fr)]">
          <div className="grid min-h-0 gap-3 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">水印预览</h2>
              <Badge variant="muted">{mode === "text" ? "文字" : "图片"}</Badge>
            </div>
            <WatermarkPreviewPanel
              imageUrl={previewImageUrl}
              watermarkUrl={previewWatermarkUrl}
              config={config}
              onOpenOriginal={() => setOriginalPreviewOpen(true)}
            />
          </div>

          <WatermarkInputTable images={images} onOpen={openWatermarkPath} />
        </section>
      </section>

      <aside className="flex min-h-[440px] min-w-0 flex-col bg-background/78 min-[1100px]:min-h-0">
        <div className="flex h-full min-h-0 flex-col gap-3 p-3">
          <section className="rounded-md border border-border bg-card p-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">水印统计</h2>
              <Badge variant="accent">{images.length} 可处理</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="图片" value={images.length} tone="success" />
              <StatTile label="跳过" value={skippedCount} />
              <StatTile label="重复" value={duplicateCount} />
              <StatTile label="可导出" value={canExport ? images.length : 0} tone="success" />
            </div>
          </section>
          <LogPanel logs={logs} />
        </div>
      </aside>

      {exportReport ? (
        <WatermarkExportCompleteDialog
          report={exportReport}
          onClose={() => setExportReport(null)}
          onOpenDirectory={openWatermarkPath}
        />
      ) : null}
      {originalPreviewOpen && previewImageUrl ? (
        <WatermarkOriginalPreviewDialog
          imageName={previewImage?.fileName ?? "原图预览"}
          imageUrl={previewImageUrl}
          watermarkUrl={previewWatermarkUrl}
          config={config}
          onClose={() => setOriginalPreviewOpen(false)}
        />
      ) : null}
    </section>
  );
}

function WatermarkPreviewPanel({
  imageUrl,
  watermarkUrl,
  config,
  onOpenOriginal,
}: {
  imageUrl: string;
  watermarkUrl: string;
  config: WatermarkConfig;
  onOpenOriginal: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [imageUrl]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setContainerSize({
        width: rect.width,
        height: rect.height,
      });
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const imageFrame = useMemo(
    () => (naturalSize ? containImageFrame(containerSize, naturalSize) : null),
    [containerSize, naturalSize],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0 w-full overflow-hidden rounded-md border border-border bg-background"
    >
      {!imageUrl ? (
        <div className="absolute inset-0 grid justify-items-center place-content-center gap-2 text-center text-muted-foreground">
          <Eye className="size-6" />
          <span className="text-sm">等待预览</span>
        </div>
      ) : null}

      {imageUrl && imageFrame ? (
        <button
          aria-label="打开原图尺寸水印预览"
          className="absolute overflow-hidden bg-background text-left outline-none transition-shadow hover:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_18%,transparent)] focus-visible:ring-2 focus-visible:ring-ring"
          style={imageFrameStyle(imageFrame)}
          onClick={onOpenOriginal}
          type="button"
          title="查看原图尺寸水印预览"
        >
          <img
            className="absolute inset-0 size-full object-fill"
            src={imageUrl}
            alt="水印预览底图"
          />
          <WatermarkOverlay
            watermarkUrl={watermarkUrl}
            config={config}
            frameSize={imageFrame}
          />
        </button>
      ) : null}

      {imageUrl ? (
        <img
          className="pointer-events-none absolute size-0 opacity-0"
          src={imageUrl}
          alt=""
          aria-hidden="true"
          onLoad={(event) => {
            const image = event.currentTarget;
            setNaturalSize({
              width: image.naturalWidth || 1,
              height: image.naturalHeight || 1,
            });
          }}
        />
      ) : null}
    </div>
  );
}

function WatermarkOriginalPreviewDialog({
  imageName,
  imageUrl,
  watermarkUrl,
  config,
  onClose,
}: {
  imageName: string;
  imageUrl: string;
  watermarkUrl: string;
  config: WatermarkConfig;
  onClose: () => void;
}) {
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [imageUrl]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[92vw]">
        <DialogHeader>
          <DialogTitle>{imageName}</DialogTitle>
          <DialogDescription>
            {naturalSize
              ? `原图尺寸 ${naturalSize.width} x ${naturalSize.height}`
              : "正在读取原图尺寸"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[72vh] overflow-auto rounded-md border border-border bg-background">
          <div
            className="relative"
            style={
              naturalSize
                ? {
                    width: `${naturalSize.width}px`,
                    height: `${naturalSize.height}px`,
                  }
                : undefined
            }
          >
            <img
              className={cn(
                "block",
                naturalSize
                  ? "absolute inset-0 size-full object-fill"
                  : "max-h-[70vh] max-w-full object-contain",
              )}
              src={imageUrl}
              alt="原图尺寸水印预览"
              onLoad={(event) => {
                const image = event.currentTarget;
                setNaturalSize({
                  width: image.naturalWidth || 1,
                  height: image.naturalHeight || 1,
                });
              }}
            />
            {naturalSize ? (
              <WatermarkOverlay
                watermarkUrl={watermarkUrl}
                config={config}
                frameSize={naturalSize}
              />
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="utility" type="button">关闭</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WatermarkOverlay({
  watermarkUrl,
  config,
  frameSize,
}: {
  watermarkUrl: string;
  config: WatermarkConfig;
  frameSize: Size;
}) {
  if (!watermarkUrl) {
    return null;
  }

  const margin = watermarkMargin(frameSize);
  const shadow = watermarkShadow(config);

  if (config.layout === "tile") {
    return (
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          backgroundImage: cssImageUrl(watermarkUrl),
          backgroundRepeat: "repeat",
          backgroundSize: `${config.sizePercent}% auto`,
          backgroundPosition: `${margin / 2}px ${margin / 2}px`,
          opacity: config.opacity,
          filter: shadow,
        }}
      />
    );
  }

  return (
    <img
      className="absolute max-h-[70%] object-contain"
      src={watermarkUrl}
      alt=""
      aria-hidden="true"
      style={{
        width: `${config.sizePercent}%`,
        right: `${margin}px`,
        bottom: `${margin}px`,
        opacity: config.opacity,
        filter: shadow,
      }}
    />
  );
}

function containImageFrame(container: Size, image: Size): ImageFrame | null {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return null;
  }

  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    width,
    height,
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
  };
}

function imageFrameStyle(frame: ImageFrame) {
  return {
    left: `${frame.left}px`,
    top: `${frame.top}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`,
  };
}

function watermarkMargin(size: Size) {
  return clampNumber(Math.round(Math.min(size.width, size.height) * 0.035), 12, 48);
}

function watermarkShadow(config: WatermarkConfig) {
  if (config.shadowStrength <= 0) {
    return undefined;
  }

  return `drop-shadow(${Math.round(10 * config.shadowStrength)}px ${Math.round(12 * config.shadowStrength)}px ${Math.round(18 * config.shadowStrength)}px rgba(0,0,0,${Math.min(0.45, config.shadowStrength * 0.6)}))`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cssImageUrl(url: string) {
  return `url("${url.replace(/"/g, '\\"')}")`;
}

function WatermarkImageList({
  images,
  onOpen,
}: {
  images: WatermarkImageInput[];
  onOpen: (path: string) => void;
}) {
  if (images.length === 0) {
    return (
      <div className="rounded-[5px] border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        等待图片目录
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {images.slice(0, 7).map((image) => (
        <button
          className="grid h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border border-border bg-background px-2 text-left text-xs transition-colors hover:border-accent hover:bg-accent/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          key={image.path}
          onClick={() => onOpen(image.path)}
          title={image.path}
          type="button"
        >
          <FileImage className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 truncate">{image.fileName}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{formatBytes(image.size)}</span>
        </button>
      ))}
      {images.length > 7 ? (
        <div className="rounded-[5px] border border-dashed border-border bg-muted/60 px-2 py-1 text-center text-xs text-muted-foreground">
          另有 {images.length - 7} 张图片
        </div>
      ) : null}
    </div>
  );
}

function WatermarkInputTable({
  images,
  onOpen,
}: {
  images: WatermarkImageInput[];
  onOpen: (path: string) => void;
}) {
  if (images.length === 0) {
    return (
      <div className="grid min-h-0 place-items-center p-6">
        <div className="grid max-w-md justify-items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
            <FileImage className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">等待图片输入</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              选择图片目录后，会递归收集 JPG、JPEG 和 PNG 图片。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex h-11 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">图片列表</h2>
          <Badge variant="muted">{images.length} 张</Badge>
        </div>
        <p className="text-xs text-muted-foreground">单击文件名可在系统中打开</p>
      </div>
      <div className="table-fade min-h-0 flex-1 overflow-auto">
        <table className="min-w-full table-auto border-collapse text-sm">
          <thead className="bg-muted/55 text-[11px] font-semibold text-muted-foreground">
            <tr className="h-9 border-b border-border">
              <th className="whitespace-nowrap px-3 text-left">文件</th>
              <th className="whitespace-nowrap px-3 text-left">相对路径</th>
              <th className="whitespace-nowrap px-3 text-right">大小</th>
              <th className="whitespace-nowrap px-3 text-right">修改时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {images.map((image) => (
              <tr className="h-12 transition-colors hover:bg-muted/70" key={image.path}>
                <td className="whitespace-nowrap px-3 py-2 align-middle">
                  <button
                    className="max-w-52 truncate text-left font-medium hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(image.path)}
                    title={image.path}
                    type="button"
                  >
                    {image.fileName}
                  </button>
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-middle">
                  <span className="block max-w-80 truncate font-mono text-xs text-muted-foreground">
                    {image.relativePath}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-middle font-mono text-xs text-muted-foreground">
                  {formatBytes(image.size)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-middle font-mono text-xs text-muted-foreground">
                  {formatTime(image.modifiedTime)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled = false,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const displayValue = formatValue ? formatValue(value) : String(value);

  return (
    <label className="grid gap-1.5 rounded-[5px] border border-border bg-background px-3 py-2 text-xs">
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-muted-foreground">
          {displayValue}
          {suffix}
        </span>
      </span>
      <input
        aria-label={label}
        className="h-2 w-full accent-[var(--accent)] disabled:opacity-45"
        name={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function WatermarkExportCompleteDialog({
  report,
  onClose,
  onOpenDirectory,
}: {
  report: WatermarkExportReport;
  onClose: () => void;
  onOpenDirectory: (path: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(openState) => !openState && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="success">导出完成</Badge>
            <DialogTitle>水印图片导出完成</DialogTitle>
          </div>
          <DialogDescription>{report.directory}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 p-4">
          <StatTile label="成功" value={report.summary.exportedCount} tone="success" />
          <StatTile label="跳过" value={report.summary.skippedCount} />
          <StatTile label="失败" value={report.summary.failedCount} tone="danger" />
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

async function createTextWatermarkSource(
  text: string,
): Promise<WatermarkSource> {
  return {
    type: "text",
    text: text.trim() || "Watermark",
  };
}

async function renderTextWatermarkPreview(text: string, config: WatermarkConfig) {
  const canvas = createTextWatermarkCanvas(text, config);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("无法生成水印预览"));
      }
    }, "image/png");
  });

  return URL.createObjectURL(blob);
}

function createTextWatermarkCanvas(text: string, config: WatermarkConfig) {
  const canvas = document.createElement("canvas");
  const measureContext = canvas.getContext("2d");
  if (!measureContext) {
    throw new Error("无法创建文字水印画布");
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const safeLines = lines.length > 0 ? lines : ["Watermark"];
  const fontSize = 72;
  const padding = 52;
  const lineHeight = fontSize * 1.22;
  measureContext.font = `700 ${fontSize}px ${getComputedStyle(document.documentElement).fontFamily}`;
  const textWidth = Math.max(
    ...safeLines.map((line) => measureContext.measureText(line).width),
    240,
  );

  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = Math.ceil(safeLines.length * lineHeight + padding * 2);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建文字水印画布");
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `700 ${fontSize}px ${getComputedStyle(document.documentElement).fontFamily}`;
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.shadowColor = `rgba(0, 0, 0, ${Math.min(0.55, config.shadowStrength * 0.8)})`;
  context.shadowBlur = 20 * config.shadowStrength;
  context.shadowOffsetX = 6 * config.shadowStrength;
  context.shadowOffsetY = 8 * config.shadowStrength;
  context.fillStyle = "rgba(255, 255, 255, 0.96)";

  safeLines.forEach((line, index) => {
    context.fillText(
      line,
      canvas.width / 2,
      padding + lineHeight * index + lineHeight / 2,
    );
  });

  return canvas;
}
