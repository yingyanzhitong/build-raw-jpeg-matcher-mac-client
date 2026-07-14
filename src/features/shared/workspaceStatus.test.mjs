import assert from "node:assert/strict";
import test from "node:test";

import {
  separatorWorkspaceStatusMetrics,
  watermarkWorkspaceStatusMetrics,
} from "./workspaceStatus.ts";

test("一键分离状态显示文件分类与跳过数量", () => {
  const metrics = separatorWorkspaceStatusMetrics({
    fileCount: 9,
    imageCount: 4,
    rawCount: 5,
    skippedCount: 2,
  });

  assert.deepEqual(
    metrics.map(({ label, value }) => [label, value]),
    [
      ["文件", 9],
      ["图片", 4],
      ["RAW", 5],
      ["跳过", 2],
    ],
  );
  assert.equal(metrics.at(-1)?.tone, "danger");
});

test("一键分离没有跳过文件时使用中性色", () => {
  const metrics = separatorWorkspaceStatusMetrics({
    fileCount: 3,
    imageCount: 2,
    rawCount: 1,
    skippedCount: 0,
  });

  assert.equal(metrics.at(-1)?.tone, "neutral");
});

test("图片水印状态显示总数与三种画幅数量", () => {
  const metrics = watermarkWorkspaceStatusMetrics({
    imageCount: 7,
    landscapeCount: 3,
    portraitCount: 2,
    squareCount: 2,
  });

  assert.deepEqual(
    metrics.map(({ label, value }) => [label, value]),
    [
      ["图片", 7],
      ["横图", 3],
      ["竖图", 2],
      ["方图", 2],
    ],
  );
});
