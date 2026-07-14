export type WorkspaceStatusTone = "neutral" | "success" | "danger" | "accent";

export interface WorkspaceStatusMetric {
  label: string;
  value: number;
  tone?: WorkspaceStatusTone;
}

export function separatorWorkspaceStatusMetrics(status: {
  fileCount: number;
  imageCount: number;
  rawCount: number;
  skippedCount: number;
}): WorkspaceStatusMetric[] {
  return [
    { label: "文件", value: status.fileCount },
    { label: "图片", value: status.imageCount, tone: "success" },
    { label: "RAW", value: status.rawCount, tone: "accent" },
    {
      label: "跳过",
      value: status.skippedCount,
      tone: status.skippedCount > 0 ? "danger" : "neutral",
    },
  ];
}

export function watermarkWorkspaceStatusMetrics(status: {
  imageCount: number;
  landscapeCount: number;
  portraitCount: number;
  squareCount: number;
}): WorkspaceStatusMetric[] {
  return [
    { label: "图片", value: status.imageCount },
    { label: "横图", value: status.landscapeCount, tone: "accent" },
    { label: "竖图", value: status.portraitCount, tone: "accent" },
    { label: "方图", value: status.squareCount, tone: "accent" },
  ];
}
