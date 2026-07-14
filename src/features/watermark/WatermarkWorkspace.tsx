import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FolderInput,
  FolderOutput,
  Image as ImageIcon,
  Images,
  Loader2,
  MapPin,
  PanelBottom,
  SlidersHorizontal,
  Stamp,
  Type,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  exportFailureFeedback,
  watermarkExportFeedback,
  type ExportFeedback,
} from "@/features/shared/exportFeedback";
import {
  formatBytes,
  inferLogLevel,
  Pane,
  PathDisplay,
  type LogEntry,
  type LogLevel,
} from "@/features/shared/ui";
import { cn } from "@/lib/utils";
import {
  completeWatermarkProgress,
  computeWatermarkPlacements,
  createDefaultWatermarkSettings,
  createWatermarkProgress,
  glassAlphaFactor,
  loadWatermarkSettings,
  maxTextWatermarkCharacters,
  markWatermarkCancelling,
  reduceWatermarkProgress,
  resolveWatermarkFont,
  saveWatermarkSettings,
  syncWatermarkProfiles,
  thumbnailWindow,
  updateWatermarkProfile,
} from "./state";
import type {
  AspectKind,
  WatermarkAnchor,
  WatermarkAssetInfo,
  WatermarkExportEvent,
  WatermarkExportRequest,
  WatermarkExportSummary,
  WatermarkFontCatalog,
  WatermarkFontInfo,
  WatermarkGeometry,
  WatermarkImageInput,
  WatermarkPreviewAsset,
  WatermarkProfile,
  WatermarkProgress,
  WatermarkScanResponse,
  WatermarkSourceKind,
  TextWatermarkRequest,
} from "./types";

type WatermarkBusy = "scan" | "asset" | "export" | null;

interface WatermarkExportReport {
  directory: string;
  summary: WatermarkExportSummary;
}

export interface WatermarkWorkspaceStatus {
  logs: LogEntry[];
}

const initialWatermarkLogs: LogEntry[] = [
  { level: "info", message: "等待选择图片目录和图片或文字水印" },
];

export const defaultWatermarkWorkspaceStatus: WatermarkWorkspaceStatus = {
  logs: initialWatermarkLogs,
};

const aspectLabels: Record<AspectKind, string> = {
  landscape: "横图",
  portrait: "竖图",
  square: "方图",
};

const aspectRatios: Record<AspectKind, string> = {
  landscape: "3 / 2",
  portrait: "2 / 3",
  square: "1 / 1",
};

const anchorLabels: Record<WatermarkAnchor, string> = {
  topLeft: "左上",
  topCenter: "上中",
  topRight: "右上",
  centerLeft: "左中",
  center: "居中",
  centerRight: "右中",
  bottomLeft: "左下",
  bottomCenter: "下中",
  bottomRight: "右下",
};

const anchors = Object.keys(anchorLabels) as WatermarkAnchor[];
const thumbnailWindowSize = 15;
let watermarkFontCatalogPromise: Promise<WatermarkFontCatalog> | null = null;

function requestWatermarkFontCatalog() {
  if (!watermarkFontCatalogPromise) {
    watermarkFontCatalogPromise = invoke<WatermarkFontCatalog>("list_watermark_fonts").catch(
      (error) => {
        watermarkFontCatalogPromise = null;
        throw error;
      },
    );
  }
  return watermarkFontCatalogPromise;
}

function initialSettings() {
  if (typeof window === "undefined") {
    return createDefaultWatermarkSettings();
  }
  return loadWatermarkSettings(window.localStorage);
}

export function WatermarkWorkspace({
  active,
  logPanelOpen,
  onExportFeedback,
  onStatusChange,
  onToggleLogPanel,
}: {
  active: boolean;
  logPanelOpen: boolean;
  onExportFeedback: (feedback: ExportFeedback) => void;
  onStatusChange: (status: WatermarkWorkspaceStatus) => void;
  onToggleLogPanel: () => void;
}) {
  const [rememberedSettings] = useState(initialSettings);
  const [inputRoot, setInputRoot] = useState("");
  const [images, setImages] = useState<WatermarkImageInput[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [activeAspect, setActiveAspect] = useState<AspectKind>("landscape");
  const [profilesBySource, setProfilesBySource] = useState(
    rememberedSettings.profilesBySource,
  );
  const [sourceKind, setSourceKind] = useState<WatermarkSourceKind>(
    rememberedSettings.sourceKind,
  );
  const [watermarkPath, setWatermarkPath] = useState(rememberedSettings.watermarkPath);
  const [text, setText] = useState(rememberedSettings.text);
  const [fontId, setFontId] = useState(rememberedSettings.fontId);
  const [fonts, setFonts] = useState<WatermarkFontInfo[]>([]);
  const [fontCatalogError, setFontCatalogError] = useState("");
  const [imageAsset, setImageAsset] = useState<WatermarkAssetInfo | null>(null);
  const [textAsset, setTextAsset] = useState<WatermarkAssetInfo | null>(null);
  const [textAssetLoading, setTextAssetLoading] = useState(false);
  const [previewPaths, setPreviewPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<WatermarkBusy>(null);
  const [logs, setLogs] = useState<LogEntry[]>(initialWatermarkLogs);
  const [progress, setProgress] = useState<WatermarkProgress>(createWatermarkProgress);
  const [exportReport, setExportReport] = useState<WatermarkExportReport | null>(null);
  const previewPathsRef = useRef<Record<string, string>>({});
  const previewRequestsRef = useRef<Map<string, Promise<string>>>(new Map());
  const currentJobIdRef = useRef<string | null>(null);
  const restoredWatermarkRef = useRef(false);
  const textAssetRequestRef = useRef(0);

  const watermarkAsset = sourceKind === "image" ? imageAsset : textAsset;
  const profiles = profilesBySource[sourceKind];
  const selectedImage = selectedIndex >= 0 ? images[selectedIndex] : undefined;
  const activeProfile = profiles[activeAspect];
  const counts = useMemo(
    () =>
      images.reduce<Record<AspectKind, number>>(
        (result, image) => {
          result[image.aspect] += 1;
          return result;
        },
        { landscape: 0, portrait: 0, square: 0 },
      ),
    [images],
  );
  const windowRange = thumbnailWindow(images.length, Math.max(0, selectedIndex), thumbnailWindowSize);
  const visibleImages = useMemo(
    () => images.slice(windowRange.start, windowRange.end),
    [images, windowRange.end, windowRange.start],
  );
  const visiblePathKey = visibleImages.map((image) => image.path).join("\u0000");
  const mainPreviewKey = selectedImage ? previewKey(selectedImage.path, 1_400) : "";
  const mainPreviewPath = mainPreviewKey ? previewPaths[mainPreviewKey] ?? "" : "";
  const canExport =
    inputRoot.length > 0 &&
    images.length > 0 &&
    watermarkAsset !== null &&
    busy === null &&
    !textAssetLoading &&
    !progress.running;
  const actionHint = getActionHint({
    busy: textAssetLoading ? "asset" : busy,
    images,
    inputRoot,
    progress,
    sourceKind,
    watermarkAsset,
  });

  useEffect(() => {
    onStatusChange({ logs });
  }, [logs, onStatusChange]);

  useEffect(() => {
    saveWatermarkSettings(window.localStorage, {
      sourceKind,
      watermarkPath,
      text,
      fontId,
      profilesBySource,
    });
  }, [fontId, profilesBySource, sourceKind, text, watermarkPath]);

  useEffect(() => {
    if (restoredWatermarkRef.current || rememberedSettings.watermarkPath.length === 0) {
      return;
    }
    restoredWatermarkRef.current = true;
    let disposed = false;
    invoke<WatermarkAssetInfo>("inspect_watermark_asset", {
      path: rememberedSettings.watermarkPath,
    })
      .then((asset) => {
        if (disposed) {
          return;
        }
        setImageAsset(asset);
        setWatermarkPath(asset.path);
        appendLogs([`已恢复水印素材: ${asset.fileName}`], "success");
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setImageAsset(null);
        setWatermarkPath("");
        appendLogs([`上次水印素材已失效，已清除: ${String(error)}`], "warning");
      });
    return () => {
      disposed = true;
    };
  }, [rememberedSettings.watermarkPath]);

  useEffect(() => {
    let disposed = false;
    requestWatermarkFontCatalog()
      .then((catalog) => {
        if (disposed) {
          return;
        }
        setFonts(catalog.fonts);
        setFontCatalogError("");
        const resolved = resolveWatermarkFont(
          catalog.fonts,
          rememberedSettings.fontId,
          catalog.defaultFontId,
        );
        setFontId(resolved.fontId);
        if (resolved.fellBack) {
          appendLogs(["上次使用的字体已失效，已回退到本机默认字体"], "warning");
        }
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setFonts([]);
        setFontCatalogError(String(error));
        appendLogs([`读取本机字体失败，文字水印暂不可用: ${String(error)}`], "error");
      });
    return () => {
      disposed = true;
    };
  }, [rememberedSettings.fontId]);

  useEffect(() => {
    const trimmed = text.trim();
    const invalid =
      trimmed.length === 0 ||
      [...trimmed].length > maxTextWatermarkCharacters ||
      [...trimmed].some((character) => /[\u0000-\u001f\u007f]/.test(character));
    const requestId = ++textAssetRequestRef.current;
    if (!fontId || invalid) {
      setTextAsset(null);
      setTextAssetLoading(false);
      return;
    }
    setTextAssetLoading(true);
    const timer = window.setTimeout(() => {
      const request: TextWatermarkRequest = { text: trimmed, fontId };
      invoke<WatermarkAssetInfo>("inspect_text_watermark", { request })
        .then((asset) => {
          if (textAssetRequestRef.current === requestId) {
            setTextAsset(asset);
          }
        })
        .catch((error) => {
          if (textAssetRequestRef.current === requestId) {
            setTextAsset(null);
            appendLogs([`生成文字玻璃水印失败: ${String(error)}`], "error");
          }
        })
        .finally(() => {
          if (textAssetRequestRef.current === requestId) {
            setTextAssetLoading(false);
          }
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [fontId, text]);

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
      if (event.key.toLowerCase() === "o" && !event.shiftKey) {
        event.preventDefault();
        void chooseInputDirectory();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, busy, progress.running]);

  const requestPreview = useCallback(
    (image: WatermarkImageInput, maxEdge: number) => {
      if (!inputRoot) {
        return Promise.reject(new Error("尚未选择图片目录"));
      }
      const key = previewKey(image.path, maxEdge);
      const cached = previewPathsRef.current[key];
      if (cached) {
        return Promise.resolve(cached);
      }
      const pending = previewRequestsRef.current.get(key);
      if (pending) {
        return pending;
      }
      const request = invoke<WatermarkPreviewAsset>("watermark_preview_asset", {
        inputRoot,
        path: image.path,
        maxEdge,
      })
        .then((asset) => {
          previewPathsRef.current = { ...previewPathsRef.current, [key]: asset.previewPath };
          setPreviewPaths((current) => ({ ...current, [key]: asset.previewPath }));
          return asset.previewPath;
        })
        .finally(() => {
          previewRequestsRef.current.delete(key);
        });
      previewRequestsRef.current.set(key, request);
      return request;
    },
    [inputRoot],
  );

  useEffect(() => {
    if (!selectedImage) {
      return;
    }
    void requestPreview(selectedImage, 1_400).catch((error) => {
      appendLogs([`生成主预览失败 ${selectedImage.relativePath}: ${String(error)}`], "error");
    });
  }, [requestPreview, selectedImage]);

  useEffect(() => {
    if (!inputRoot || visiblePathKey.length === 0) {
      return;
    }
    const batch = visibleImages.filter(
      (image) => !previewPathsRef.current[previewKey(image.path, 180)],
    );
    void Promise.all(
      batch.map((image) =>
        requestPreview(image, 180).catch(() => ""),
      ),
    );
  }, [inputRoot, requestPreview, visibleImages, visiblePathKey]);

  function appendLogs(messages: string[], level?: LogLevel) {
    setLogs((current) => [
      ...current,
      ...messages.map((message) => ({ level: level ?? inferLogLevel(message), message })),
    ].slice(-500));
  }

  async function chooseInputDirectory() {
    if (busy !== null || progress.running) {
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择需要添加水印的图片目录",
    });
    if (typeof selected !== "string") {
      return;
    }
    setBusy("scan");
    try {
      const response = await invoke<WatermarkScanResponse>("scan_watermark_source", {
        root: selected,
      });
      setInputRoot(response.rootDir);
      setImages(response.images);
      setSkippedCount(response.skippedCount);
      setSelectedIndex(response.images.length > 0 ? 0 : -1);
      setActiveAspect(response.images[0]?.aspect ?? "landscape");
      setExportReport(null);
      setProgress(createWatermarkProgress());
      previewPathsRef.current = {};
      previewRequestsRef.current.clear();
      setPreviewPaths({});
      setLogs(
        response.logs.map((message) => ({
          level: inferLogLevel(message),
          message,
        })),
      );
    } catch (error) {
      appendLogs([`扫描图片目录失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  async function chooseWatermarkAsset() {
    if (busy !== null || progress.running) {
      return;
    }
    const selected = await open({
      directory: false,
      multiple: false,
      title: "选择 PNG、JPG 或 JPEG 图片水印",
      filters: [{ name: "图片水印", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof selected !== "string") {
      return;
    }
    setBusy("asset");
    try {
      const asset = await invoke<WatermarkAssetInfo>("inspect_watermark_asset", {
        path: selected,
      });
      setImageAsset(asset);
      setWatermarkPath(asset.path);
      setExportReport(null);
      appendLogs(
        [
          `已选择水印素材: ${asset.fileName}（${asset.width}×${asset.height}）`,
          asset.sourceHasTransparency
            ? "检测到原生透明素材，已在本地转换为玻璃水印"
            : "检测到纯色背景素材，已移除背景并转换为玻璃水印",
        ],
        "success",
      );
    } catch (error) {
      appendLogs([`读取水印素材失败: ${String(error)}`], "error");
    } finally {
      setBusy(null);
    }
  }

  function selectSourceKind(nextKind: WatermarkSourceKind) {
    if (busy !== null || progress.running) {
      return;
    }
    setSourceKind(nextKind);
    setExportReport(null);
  }

  function selectImage(index: number) {
    const image = images[index];
    if (!image) {
      return;
    }
    setSelectedIndex(index);
    setActiveAspect(image.aspect);
  }

  function selectAspect(aspect: AspectKind) {
    setActiveAspect(aspect);
    setSelectedIndex(images.findIndex((image) => image.aspect === aspect));
  }

  function updateProfile(update: Partial<WatermarkProfile>) {
    setProfilesBySource((current) => ({
      ...current,
      [sourceKind]: updateWatermarkProfile(current[sourceKind], activeAspect, update),
    }));
    setExportReport(null);
  }

  function syncProfiles() {
    setProfilesBySource((current) => ({
      ...current,
      [sourceKind]: syncWatermarkProfiles(current[sourceKind], activeAspect),
    }));
    setExportReport(null);
    appendLogs([`已将${aspectLabels[activeAspect]}水印参数同步到全部画幅`], "success");
  }

  async function startExport() {
    if (!canExport || !watermarkAsset) {
      appendLogs([actionHint], "warning");
      return;
    }
    const exportDir = await open({
      directory: true,
      multiple: false,
      title: "选择水印图片输出目录",
      canCreateDirectories: true,
    });
    if (typeof exportDir !== "string") {
      return;
    }

    const jobId = crypto.randomUUID();
    const request: WatermarkExportRequest = {
      jobId,
      inputRoot,
      exportDir,
      source:
        sourceKind === "image"
          ? { type: "image", path: watermarkAsset.path }
          : { type: "text", text: text.trim(), fontId },
      imagePaths: images.map((image) => image.path),
      profiles,
    };
    const onEvent = new Channel<WatermarkExportEvent>();
    onEvent.onmessage = (event) => {
      setProgress((current) => reduceWatermarkProgress(current, event));
      if (event.type === "started") {
        appendLogs([`开始导出 ${event.totalCount} 张水印图片`]);
      } else if (event.type === "itemFinished") {
        appendLogs(
          [`${event.index}/${event.totalCount} ${event.relativePath}: ${event.message}`],
          event.status === "exported"
            ? "success"
            : event.status === "failed"
              ? "error"
              : "warning",
        );
      } else if (event.type === "warning") {
        appendLogs([`${event.relativePath}: ${event.message}`], "warning");
      } else if (event.type === "cancelled") {
        appendLogs(
          [`导出已取消：完成 ${event.processedCount} 张，剩余 ${event.remainingCount} 张未处理`],
          "warning",
        );
      }
    };

    currentJobIdRef.current = jobId;
    setBusy("export");
    setExportReport(null);
    setProgress({ ...createWatermarkProgress(), running: true, totalCount: images.length });
    try {
      const summary = await invoke<WatermarkExportSummary>("export_watermarked_images", {
        request,
        onEvent,
      });
      setProgress((current) => completeWatermarkProgress(current, summary));
      setExportReport({ directory: exportDir, summary });
      appendLogs(
        [
          `水印导出完成：成功 ${summary.exportedCount}，同名跳过 ${summary.skippedExistingCount}，失败 ${summary.failedCount}，取消剩余 ${summary.cancelledRemainingCount}`,
        ],
        summary.failedCount > 0 || summary.cancelledRemainingCount > 0 ? "warning" : "success",
      );
      onExportFeedback(watermarkExportFeedback(summary));
    } catch (error) {
      setProgress((current) => ({ ...current, running: false, cancelling: false }));
      appendLogs([`批量导出水印失败: ${String(error)}`], "error");
      onExportFeedback(exportFailureFeedback("水印图片导出", error));
    } finally {
      currentJobIdRef.current = null;
      setBusy(null);
    }
  }

  async function cancelExport() {
    const jobId = currentJobIdRef.current;
    if (!jobId || !progress.running || progress.cancelling) {
      return;
    }
    setProgress((current) => markWatermarkCancelling(current));
    try {
      const accepted = await invoke<boolean>("cancel_watermark_export", { jobId });
      appendLogs(
        [accepted ? "已请求取消，将在当前图片完成后停止" : "当前没有可取消的水印任务"],
        accepted ? "warning" : "info",
      );
    } catch (error) {
      setProgress((current) => ({ ...current, cancelling: false }));
      appendLogs([`取消水印任务失败: ${String(error)}`], "error");
    }
  }

  async function openOutputDirectory(path: string) {
    try {
      await invoke("open_file_path", { path });
    } catch (error) {
      appendLogs([`打开输出目录失败: ${String(error)}`], "error");
    }
  }

  const exportHasWarnings =
    exportReport !== null &&
    (exportReport.summary.failedCount > 0 || exportReport.summary.cancelledRemainingCount > 0);

  return (
    <section
      aria-label="图片水印工作区"
      className={cn(
        "grid h-full min-h-0 grid-cols-1 overflow-auto bg-panel min-[960px]:grid-cols-[320px_minmax(0,1fr)] min-[960px]:overflow-hidden",
        !active && "hidden",
      )}
    >
      <aside className="min-h-[640px] border-r border-border bg-background/82 min-[960px]:min-h-0">
        <ScrollArea className="h-full min-h-0">
          <div className="grid min-h-[700px] content-start p-4 pb-6 min-[960px]:min-h-0">
            <Pane
              icon={<FolderInput className="size-4" />}
              title="照片来源"
              subtitle={images.length > 0 ? `${images.length} 张可处理图片` : "递归识别 JPG、JPEG、PNG"}
            >
              <PathDisplay path={inputRoot} fallback="尚未选择图片目录" />
              <Button
                disabled={busy !== null || progress.running}
                onClick={chooseInputDirectory}
                type="button"
              >
                {busy === "scan" ? <Loader2 className="animate-spin" /> : <FolderInput />}
                选择图片目录
              </Button>
              {inputRoot ? (
                <div className="flex flex-wrap gap-2">
                  <Badge variant="success">图片 {images.length}</Badge>
                  <Badge variant={skippedCount > 0 ? "warning" : "muted"}>跳过 {skippedCount}</Badge>
                </div>
              ) : null}
            </Pane>

            <Pane
              icon={<Stamp className="size-4" />}
              title="水印素材"
              subtitle={watermarkAsset ? `${watermarkAsset.width}×${watermarkAsset.height}` : "图片或文字"}
            >
              <div aria-label="水印素材类型" className="grid grid-cols-2 gap-1.5" role="group">
                <Button
                  aria-pressed={sourceKind === "image"}
                  disabled={busy !== null || progress.running}
                  onClick={() => selectSourceKind("image")}
                  size="sm"
                  type="button"
                  variant={sourceKind === "image" ? "accent" : "utility"}
                >
                  <ImageIcon />
                  图片
                </Button>
                <Button
                  aria-pressed={sourceKind === "text"}
                  disabled={busy !== null || progress.running || Boolean(fontCatalogError)}
                  onClick={() => selectSourceKind("text")}
                  size="sm"
                  type="button"
                  variant={sourceKind === "text" ? "accent" : "utility"}
                >
                  <Type />
                  文字
                </Button>
              </div>

              {sourceKind === "image" ? (
                <>
                  <PathDisplay path={watermarkPath} fallback="尚未选择图片水印" />
                  <Button
                    disabled={busy !== null || progress.running}
                    onClick={chooseWatermarkAsset}
                    type="button"
                    variant="utility"
                  >
                    {busy === "asset" ? <Loader2 className="animate-spin" /> : <ImageIcon />}
                    选择图片水印
                  </Button>
                  {imageAsset ? <WatermarkAssetCard asset={imageAsset} /> : null}
                </>
              ) : (
                <>
                  <label className="grid gap-1.5 text-xs font-medium">
                    文字内容
                    <input
                      aria-label="文字水印内容"
                      className="h-9 w-full rounded-[7px] border border-border bg-card px-2.5 text-xs font-normal outline-none transition-colors placeholder:text-muted-foreground focus:border-accent"
                      disabled={progress.running}
                      maxLength={maxTextWatermarkCharacters}
                      onChange={(event) => {
                        setText(event.target.value);
                        setExportReport(null);
                      }}
                      placeholder="输入姓名、品牌或版权说明"
                      type="text"
                      value={text}
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs font-medium">
                    字体
                    <select
                      aria-label="文字水印字体"
                      className="h-9 w-full rounded-[7px] border border-border bg-card px-2 text-xs font-normal outline-none transition-colors focus:border-accent disabled:opacity-50"
                      disabled={fonts.length === 0 || progress.running}
                      onChange={(event) => {
                        setFontId(event.target.value);
                        setExportReport(null);
                      }}
                      value={fontId}
                    >
                      {fonts.map((font) => (
                        <option key={font.id} value={font.id}>
                          {font.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  {fontCatalogError ? (
                    <p className="text-xs leading-5 text-destructive">{fontCatalogError}</p>
                  ) : textAssetLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      正在生成玻璃文字…
                    </div>
                  ) : textAsset ? (
                    <WatermarkAssetCard asset={textAsset} />
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      输入单行文字后，将在本地生成透明玻璃水印。
                    </p>
                  )}
                </>
              )}
            </Pane>

            <Pane
              icon={<SlidersHorizontal className="size-4" />}
              title="画幅配置"
              subtitle={`${aspectLabels[activeAspect]}独立参数`}
            >
              <div aria-label="水印画幅配置" className="grid grid-cols-3 gap-1.5" role="tablist">
                {(["landscape", "portrait", "square"] as AspectKind[]).map((aspect) => (
                  <Button
                    aria-selected={activeAspect === aspect}
                    key={aspect}
                    onClick={() => selectAspect(aspect)}
                    role="tab"
                    size="sm"
                    type="button"
                    variant={activeAspect === aspect ? "accent" : "utility"}
                  >
                    {aspectLabels[aspect]} {counts[aspect]}
                  </Button>
                ))}
              </div>

              <div>
                <span className="mb-2 block text-xs font-medium">布局</span>
                <div aria-label="水印布局" className="grid grid-cols-2 gap-1.5" role="group">
                  <Button
                    aria-pressed={activeProfile.layout === "single"}
                    onClick={() => updateProfile({ layout: "single" })}
                    size="sm"
                    type="button"
                    variant={activeProfile.layout === "single" ? "accent" : "utility"}
                  >
                    单个
                  </Button>
                  <Button
                    aria-pressed={activeProfile.layout === "tile"}
                    onClick={() => updateProfile({ layout: "tile" })}
                    size="sm"
                    type="button"
                    variant={activeProfile.layout === "tile" ? "accent" : "utility"}
                  >
                    平铺
                  </Button>
                </div>
              </div>

              {activeProfile.layout === "single" ? (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">九宫格位置</span>
                    <span className="text-[11px] text-muted-foreground">
                      {anchorLabels[activeProfile.anchor]}
                    </span>
                  </div>
                  <AnchorGrid
                    value={activeProfile.anchor}
                    onChange={(anchor) => updateProfile({ anchor })}
                  />
                </div>
              ) : (
                <p className="rounded-[7px] border border-accent/20 bg-accent/8 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
                  平铺会覆盖整张图片；横纵偏移用于移动整个图案。
                </p>
              )}

              <RangeControl
                label="通透度"
                max={100}
                min={0}
                onChange={(value) => updateProfile({ clarity: value / 100 })}
                suffix="%"
                value={Math.round(activeProfile.clarity * 100)}
              />
              <RangeControl
                label={sourceKind === "text" ? "文字大小（目标短边）" : "尺寸（目标短边）"}
                max={100}
                min={1}
                onChange={(value) => updateProfile({ sizePercent: value })}
                suffix="%"
                value={activeProfile.sizePercent}
              />
              <RangeControl
                label="旋转"
                max={180}
                min={-180}
                onChange={(value) => updateProfile({ rotationDegrees: value })}
                suffix="°"
                value={activeProfile.rotationDegrees}
              />
              <RangeControl
                label={activeProfile.layout === "tile" ? "平铺横向偏移" : "横向偏移"}
                max={50}
                min={-50}
                onChange={(value) => updateProfile({ offsetXPercent: value })}
                suffix="%"
                value={activeProfile.offsetXPercent}
              />
              <RangeControl
                label={activeProfile.layout === "tile" ? "平铺纵向偏移" : "纵向偏移"}
                max={50}
                min={-50}
                onChange={(value) => updateProfile({ offsetYPercent: value })}
                suffix="%"
                value={activeProfile.offsetYPercent}
              />
              {activeProfile.layout === "tile" ? (
                <RangeControl
                  label="平铺间距（目标短边）"
                  max={50}
                  min={1}
                  onChange={(value) => updateProfile({ tileSpacingPercent: value })}
                  suffix="%"
                  value={activeProfile.tileSpacingPercent}
                />
              ) : null}

              <Button
                disabled={progress.running}
                onClick={syncProfiles}
                type="button"
                variant="utility"
              >
                <Images />
                同步到全部画幅
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                JPEG 固定质量 100，PNG 无损；源文件不会改写，已有同名目标会跳过。
              </p>
            </Pane>
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-[660px] min-w-0 flex-col bg-card min-[960px]:min-h-0">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">图片水印</h2>
              {selectedImage ? <Badge variant="accent">{aspectLabels[selectedImage.aspect]}</Badge> : null}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{actionHint}</p>
          </div>
          <div className="flex items-center gap-2">
            {progress.running ? (
              <Button
                disabled={progress.cancelling}
                onClick={() => void cancelExport()}
                type="button"
                variant="outline"
              >
                {progress.cancelling ? <Loader2 className="animate-spin" /> : <X />}
                {progress.cancelling ? "正在停止" : "取消导出"}
              </Button>
            ) : (
              <Button disabled={!canExport} onClick={() => void startExport()} type="button">
                <FolderOutput />
                导出水印图片
              </Button>
            )}
            <Separator className="h-8" orientation="vertical" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={logPanelOpen ? "隐藏水印日志" : "显示水印日志"}
                  aria-pressed={logPanelOpen}
                  className={cn(
                    "size-9",
                    logPanelOpen && "border-accent/30 bg-accent/10 text-accent hover:bg-accent/14",
                  )}
                  onClick={onToggleLogPanel}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <PanelBottom />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{logPanelOpen ? "隐藏日志" : "显示日志"}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {progress.running || progress.processedCount > 0 ? <WatermarkProgressBar progress={progress} /> : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel p-5 pb-3">
          <section className="watermark-preview-surface relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[10px] border border-border bg-card p-5">
            {selectedImage && mainPreviewPath ? (
              <WatermarkCanvas
                aspect={selectedImage.aspect}
                photoUrl={convertFileSrc(mainPreviewPath)}
                profile={profiles[selectedImage.aspect]}
                title={selectedImage.relativePath}
                watermark={watermarkAsset}
              />
            ) : selectedImage ? (
              <div className="grid justify-items-center gap-3 text-center text-muted-foreground">
                <Loader2 className="size-6 animate-spin" />
                <p className="text-sm">正在准备方向校正预览…</p>
              </div>
            ) : (
              <EmptyWatermarkPreview aspect={activeAspect} hasImages={images.length > 0} />
            )}
          </section>

          <div className="mt-3 flex min-h-[92px] shrink-0 items-center gap-3 rounded-[9px] border border-border bg-card px-3 py-2">
            <Button
              aria-label="上一张预览图片"
              disabled={selectedIndex <= 0}
              onClick={() => selectImage(selectedIndex - 1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeft />
            </Button>
            <div aria-label="预览图片缩略图" className="codex-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto py-1">
              {visibleImages.length > 0 ? (
                visibleImages.map((image, offset) => {
                  const index = windowRange.start + offset;
                  const thumbnailPath = previewPaths[previewKey(image.path, 180)];
                  return (
                    <ThumbnailButton
                      image={image}
                      index={index}
                      key={image.path}
                      onSelect={selectImage}
                      selected={index === selectedIndex}
                      thumbnailUrl={thumbnailPath ? convertFileSrc(thumbnailPath) : ""}
                    />
                  );
                })
              ) : (
                <p className="m-auto text-xs text-muted-foreground">选择图片目录后显示可选样片</p>
              )}
            </div>
            <Button
              aria-label="下一张预览图片"
              disabled={selectedIndex < 0 || selectedIndex >= images.length - 1}
              onClick={() => selectImage(selectedIndex + 1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ArrowRight />
            </Button>
            <span className="min-w-14 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {selectedIndex >= 0 ? `${selectedIndex + 1}/${images.length}` : `0/${images.length}`}
            </span>
          </div>
        </div>

        {exportReport ? (
          <footer
            className={cn(
              "flex shrink-0 items-center justify-between gap-4 border-t border-border px-4 py-3 text-sm",
              exportHasWarnings ? "bg-warning/8" : "bg-success/8",
            )}
          >
            <p className={cn("min-w-0 truncate", exportHasWarnings ? "text-warning" : "text-success")}>
              已导出 {exportReport.summary.exportedCount} 张；跳过 {exportReport.summary.skippedExistingCount}，失败 {exportReport.summary.failedCount}
              {exportReport.summary.cancelledRemainingCount > 0
                ? `，取消剩余 ${exportReport.summary.cancelledRemainingCount}`
                : ""}
              。
            </p>
            <Button
              onClick={() => void openOutputDirectory(exportReport.directory)}
              size="sm"
              type="button"
              variant="utility"
            >
              <FolderOutput />
              打开输出目录
            </Button>
          </footer>
        ) : null}
      </section>
    </section>
  );
}

function AnchorGrid({
  value,
  onChange,
}: {
  value: WatermarkAnchor;
  onChange: (anchor: WatermarkAnchor) => void;
}) {
  return (
    <div aria-label="水印九宫格位置" className="grid grid-cols-3 gap-1.5" role="group">
      {anchors.map((anchor) => (
        <button
          aria-label={anchorLabels[anchor]}
          aria-pressed={value === anchor}
          className={cn(
            "grid h-8 place-items-center rounded-[6px] border bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === anchor
              ? "border-accent/45 bg-accent/10 text-accent"
              : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
          key={anchor}
          onClick={() => onChange(anchor)}
          title={anchorLabels[anchor]}
          type="button"
        >
          <span className={cn("size-1.5 rounded-full bg-current", value === anchor && "size-2")} />
        </button>
      ))}
    </div>
  );
}

function WatermarkAssetCard({ asset }: { asset: WatermarkAssetInfo }) {
  return (
    <div className="flex items-center gap-2 rounded-[7px] border border-border bg-card p-2">
      <div className="watermark-checkerboard grid size-12 shrink-0 place-items-center overflow-hidden rounded-[5px] border border-border">
        <img
          alt={asset.sourceKind === "text" ? "当前文字水印" : "当前图片水印"}
          className="max-h-full max-w-full object-contain"
          src={convertFileSrc(asset.previewPath)}
        />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{asset.fileName}</p>
        <Badge className="mt-1" variant="success">
          {asset.glassProcessed ? "已转换玻璃水印" : "等待处理"}
        </Badge>
      </div>
    </div>
  );
}

function RangeControl({
  label,
  min,
  max,
  suffix,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  suffix: string;
  value: number;
  onChange: (value: number) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(Number(event.target.value));
  }

  return (
    <label className="grid gap-1.5 rounded-[7px] border border-border bg-card px-2.5 py-2">
      <span className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        <output className="font-mono tabular-nums text-muted-foreground">
          {Math.round(value)}{suffix}
        </output>
      </span>
      <input
        aria-label={label}
        aria-valuetext={`${Math.round(value)}${suffix}`}
        className="watermark-range w-full accent-accent"
        max={max}
        min={min}
        onChange={handleChange}
        step={1}
        type="range"
        value={value}
      />
    </label>
  );
}

const WatermarkCanvas = memo(function WatermarkCanvas({
  aspect,
  photoUrl,
  profile,
  title,
  watermark,
}: {
  aspect: AspectKind;
  photoUrl: string;
  profile: WatermarkProfile;
  title: string;
  watermark: WatermarkAssetInfo | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let disposed = false;
    setStatus("loading");
    const photo = new window.Image();
    const logo = watermark ? new window.Image() : null;
    const photoReady = loadImage(photo, photoUrl);
    const logoReady = logo && watermark ? loadImage(logo, convertFileSrc(watermark.previewPath)) : null;
    Promise.all([photoReady, logoReady])
      .then(() => {
        if (disposed || !canvasRef.current) {
          return;
        }
        const canvas = canvasRef.current;
        canvas.width = photo.naturalWidth;
        canvas.height = photo.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("无法创建 Canvas 预览上下文");
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(photo, 0, 0, canvas.width, canvas.height);
        if (logo && watermark) {
          const placements = computeWatermarkPlacements({
            targetWidth: canvas.width,
            targetHeight: canvas.height,
            watermarkWidth: logo.naturalWidth,
            watermarkHeight: logo.naturalHeight,
            profile,
            sizeBasis: watermark.sizeBasis,
          });
          for (const geometry of placements) {
            drawCanvasWatermark(context, logo, geometry, profile);
          }
        }
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) {
          setStatus("error");
        }
      });
    return () => {
      disposed = true;
    };
  }, [photoUrl, profile, watermark]);

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <canvas
        aria-label={`${title} 的${aspectLabels[aspect]}水印预览`}
        className={cn(
          "max-h-full max-w-full rounded-[5px] object-contain shadow-[0_12px_32px_rgba(32,33,36,0.18)]",
          status !== "ready" && "invisible",
        )}
        ref={canvasRef}
        role="img"
      >
        {title} 的水印预览
      </canvas>
      {status === "loading" ? <Loader2 className="absolute size-6 animate-spin text-muted-foreground" /> : null}
      {status === "error" ? (
        <div className="absolute grid justify-items-center gap-2 text-center text-destructive">
          <AlertTriangle className="size-6" />
          <p className="text-sm">预览加载失败，请重新选择图片或水印</p>
        </div>
      ) : null}
    </div>
  );
});

function drawCanvasWatermark(
  context: CanvasRenderingContext2D,
  logo: HTMLImageElement,
  geometry: WatermarkGeometry,
  profile: WatermarkProfile,
) {
  context.save();
  context.globalAlpha = glassAlphaFactor(profile.clarity);
  context.translate(geometry.centerX, geometry.centerY);
  context.rotate((profile.rotationDegrees * Math.PI) / 180);
  context.drawImage(
    logo,
    -geometry.drawWidth / 2,
    -geometry.drawHeight / 2,
    geometry.drawWidth,
    geometry.drawHeight,
  );
  context.restore();
}

function loadImage(image: HTMLImageElement, url: string) {
  return new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`图片加载失败: ${url}`));
    image.src = url;
  });
}

const ThumbnailButton = memo(function ThumbnailButton({
  image,
  index,
  onSelect,
  selected,
  thumbnailUrl,
}: {
  image: WatermarkImageInput;
  index: number;
  onSelect: (index: number) => void;
  selected: boolean;
  thumbnailUrl: string;
}) {
  return (
    <button
      aria-label={`预览 ${image.relativePath}，${aspectLabels[image.aspect]}`}
      aria-pressed={selected}
      className={cn(
        "watermark-thumbnail relative grid h-[68px] w-[82px] shrink-0 place-items-center overflow-hidden rounded-[6px] border bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-accent ring-1 ring-accent/30" : "border-border hover:border-ring/45",
      )}
      onClick={() => onSelect(index)}
      title={image.relativePath}
      type="button"
    >
      {thumbnailUrl ? (
        <img alt="" className="h-full w-full object-cover" loading="lazy" src={thumbnailUrl} />
      ) : (
        <ImageIcon className="size-5 text-muted-foreground" />
      )}
      <span className="absolute bottom-1 right-1 rounded-[3px] bg-black/65 px-1 py-0.5 text-[9px] font-medium text-white">
        {aspectLabels[image.aspect]}
      </span>
    </button>
  );
});

function EmptyWatermarkPreview({ aspect, hasImages }: { aspect: AspectKind; hasImages: boolean }) {
  return (
    <div className="grid h-full w-full place-items-center p-6 text-center">
      <div
        className="empty-workbench grid max-h-full w-full max-w-[520px] place-items-center rounded-[10px] border border-dashed border-border p-8"
        style={{ aspectRatio: aspectRatios[aspect] }}
      >
        <div className="grid max-w-sm justify-items-center gap-3">
          <span className="grid size-12 place-items-center rounded-[9px] border border-accent/20 bg-card text-accent">
            <Stamp className="size-5" />
          </span>
          <div>
            <h3 className="text-base font-semibold">
              {hasImages ? `没有可预览的${aspectLabels[aspect]}` : "等待图片与水印素材"}
            </h3>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              {hasImages
                ? "仍可先配置该画幅参数；选择包含此画幅的目录后会显示真实预览。"
                : "选择图片目录并准备图片或文字水印后，可实时检查三种画幅的玻璃效果。"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function WatermarkProgressBar({ progress }: { progress: WatermarkProgress }) {
  const percentage = progress.totalCount > 0
    ? Math.min(100, Math.round((progress.processedCount / progress.totalCount) * 100))
    : 0;
  return (
    <section aria-label="水印导出进度" className="border-b border-border bg-card px-5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-2 font-medium">
          {progress.running ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5 text-success" />}
          {progress.cancelling ? "正在完成当前图片并停止" : progress.running ? "正在导出" : "导出已结束"}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {progress.processedCount}/{progress.totalCount} · {percentage}%
        </span>
      </div>
      <div
        aria-valuemax={progress.totalCount}
        aria-valuemin={0}
        aria-valuenow={progress.processedCount}
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </section>
  );
}

function previewKey(path: string, maxEdge: number) {
  return `${maxEdge}:${path}`;
}

function getActionHint({
  busy,
  images,
  inputRoot,
  progress,
  sourceKind,
  watermarkAsset,
}: {
  busy: WatermarkBusy;
  images: WatermarkImageInput[];
  inputRoot: string;
  progress: WatermarkProgress;
  sourceKind: WatermarkSourceKind;
  watermarkAsset: WatermarkAssetInfo | null;
}) {
  if (busy === "scan") {
    return "正在扫描图片目录…";
  }
  if (busy === "asset") {
    return "正在检查水印素材…";
  }
  if (progress.running) {
    return progress.cancelling
      ? "取消请求已发送，将在当前图片完成后停止"
      : `正在处理 ${progress.processedCount}/${progress.totalCount} 张图片`;
  }
  if (!inputRoot) {
    return "先选择需要批量添加水印的图片目录";
  }
  if (images.length === 0) {
    return "目录中没有可处理的 JPG、JPEG 或 PNG";
  }
  if (!watermarkAsset) {
    return sourceKind === "text"
      ? "输入文字并选择本机字体后即可预览和导出"
      : "选择 PNG、JPG 或 JPEG 图片水印后即可预览和导出";
  }
  return `已就绪：将为 ${images.length} 张图片添加本地水印`;
}
