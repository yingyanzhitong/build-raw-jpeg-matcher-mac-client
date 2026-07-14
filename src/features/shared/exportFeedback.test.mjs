import assert from "node:assert/strict";
import test from "node:test";

import {
  exportFailureFeedback,
  matcherExportFeedback,
  separatorExportFeedback,
  watermarkExportFeedback,
} from "./exportFeedback.ts";
import { scrollLogViewportToTail } from "./logTail.ts";

function matcherSummary(overrides = {}) {
  return {
    copiedCount: 3,
    alreadyPresentCount: 1,
    skippedMissingCount: 2,
    skippedConflictCount: 1,
    collisionCount: 1,
    sourceErrorCount: 0,
    ...overrides,
  };
}

function separatorSummary(overrides = {}) {
  return {
    copiedCount: 5,
    copiedImageCount: 3,
    copiedRawCount: 2,
    movedCount: 0,
    movedImageCount: 0,
    movedRawCount: 0,
    alreadyPresentCount: 1,
    collisionCount: 2,
    failedCount: 0,
    ...overrides,
  };
}

function watermarkSummary(overrides = {}) {
  return {
    totalCount: 5,
    processedCount: 5,
    exportedCount: 4,
    skippedExistingCount: 1,
    failedCount: 0,
    cancelledRemainingCount: 0,
    ...overrides,
  };
}

test("匹配导出无源文件错误时显示成功并汇总跳过数量", () => {
  const feedback = matcherExportFeedback(matcherSummary());

  assert.equal(feedback.tone, "success");
  assert.match(feedback.message, /已复制 3 个/);
  assert.match(feedback.message, /跳过 4 个/);
});

test("匹配导出存在源文件错误时显示失败", () => {
  const feedback = matcherExportFeedback(matcherSummary({ sourceErrorCount: 2 }));

  assert.equal(feedback.tone, "error");
  assert.match(feedback.message, /源文件失败 2 个/);
});

test("一键分离按复制或移动模式显示完成数量", () => {
  assert.match(separatorExportFeedback(separatorSummary(), "copy").message, /已复制 5 个/);
  assert.match(
    separatorExportFeedback(
      separatorSummary({ copiedCount: 0, movedCount: 4 }),
      "moveInPlace",
    ).message,
    /已移动 4 个/,
  );
});

test("一键分离存在失败项时显示失败", () => {
  const feedback = separatorExportFeedback(separatorSummary({ failedCount: 1 }), "copy");

  assert.equal(feedback.tone, "error");
  assert.match(feedback.message, /失败 1 个/);
});

test("水印全部处理完成时显示成功", () => {
  const feedback = watermarkExportFeedback(watermarkSummary());

  assert.equal(feedback.tone, "success");
  assert.match(feedback.message, /已导出 4 张/);
  assert.match(feedback.message, /同名跳过 1 张/);
});

test("水印仅取消时显示警告", () => {
  const feedback = watermarkExportFeedback(
    watermarkSummary({ processedCount: 2, exportedCount: 2, cancelledRemainingCount: 3 }),
  );

  assert.equal(feedback.tone, "warning");
  assert.match(feedback.message, /剩余 3 张未处理/);
});

test("水印存在失败项时优先显示失败", () => {
  const feedback = watermarkExportFeedback(
    watermarkSummary({ exportedCount: 2, failedCount: 1, cancelledRemainingCount: 2 }),
  );

  assert.equal(feedback.tone, "error");
  assert.match(feedback.message, /失败 1 张/);
});

test("导出调用异常生成失败反馈并提示日志已打开", () => {
  const feedback = exportFailureFeedback("一键分离", new Error("目录不可写"));

  assert.equal(feedback.tone, "error");
  assert.equal(feedback.title, "一键分离失败");
  assert.match(feedback.message, /目录不可写/);
  assert.match(feedback.message, /已打开运行日志/);
});

test("日志 tail 将滚动位置对齐到最新记录", () => {
  const viewport = { scrollHeight: 860, scrollTop: 0 };

  scrollLogViewportToTail(viewport);

  assert.equal(viewport.scrollTop, 860);
});
