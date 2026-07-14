import type { SeparatorExportMode, SeparatorExportSummary } from "@/features/file-separator/types";
import type { ExportSummary } from "@/features/raw-matcher/types";
import type { WatermarkExportSummary } from "@/features/watermark/types";

export type ExportFeedbackTone = "success" | "warning" | "error";

export interface ExportFeedback {
  tone: ExportFeedbackTone;
  title: string;
  message: string;
}

export interface ExportToastState extends ExportFeedback {
  id: number;
}

export function matcherExportFeedback(summary: ExportSummary): ExportFeedback {
  const skippedCount =
    summary.skippedMissingCount +
    summary.skippedConflictCount +
    summary.collisionCount;

  if (summary.sourceErrorCount > 0) {
    return {
      tone: "error",
      title: "匹配文件导出失败",
      message: `已复制 ${summary.copiedCount} 个，源文件失败 ${summary.sourceErrorCount} 个。已打开运行日志。`,
    };
  }

  return {
    tone: "success",
    title: "匹配文件导出成功",
    message: `已复制 ${summary.copiedCount} 个，已存在 ${summary.alreadyPresentCount} 个，跳过 ${skippedCount} 个。`,
  };
}

export function separatorExportFeedback(
  summary: SeparatorExportSummary,
  mode: SeparatorExportMode,
): ExportFeedback {
  const action = mode === "moveInPlace" ? "移动" : "复制";
  const completedCount = mode === "moveInPlace" ? summary.movedCount : summary.copiedCount;

  if (summary.failedCount > 0) {
    return {
      tone: "error",
      title: "一键分离失败",
      message: `已${action} ${completedCount} 个，失败 ${summary.failedCount} 个。已打开运行日志。`,
    };
  }

  return {
    tone: "success",
    title: "一键分离成功",
    message: `已${action} ${completedCount} 个，已存在 ${summary.alreadyPresentCount} 个，冲突 ${summary.collisionCount} 个。`,
  };
}

export function watermarkExportFeedback(summary: WatermarkExportSummary): ExportFeedback {
  if (summary.failedCount > 0) {
    return {
      tone: "error",
      title: "水印图片导出失败",
      message: `已导出 ${summary.exportedCount} 张，失败 ${summary.failedCount} 张。已打开运行日志。`,
    };
  }

  if (summary.cancelledRemainingCount > 0) {
    return {
      tone: "warning",
      title: "水印导出已取消",
      message: `已导出 ${summary.exportedCount} 张，剩余 ${summary.cancelledRemainingCount} 张未处理。`,
    };
  }

  return {
    tone: "success",
    title: "水印图片导出成功",
    message: `已导出 ${summary.exportedCount} 张，同名跳过 ${summary.skippedExistingCount} 张。`,
  };
}

export function exportFailureFeedback(label: string, error: unknown): ExportFeedback {
  return {
    tone: "error",
    title: `${label}失败`,
    message: `${String(error)}。已打开运行日志。`,
  };
}
