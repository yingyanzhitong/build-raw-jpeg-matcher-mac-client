import assert from "node:assert/strict";
import test from "node:test";

import {
  canStartDirectionTransition,
  canSwitchDirection,
  clearDirectionWorkspaceState,
  createDirectionWorkspaceStates,
  invalidateMatchState,
  isDirectionReadyForMatch,
  updateDirectionWorkspaceState,
} from "./state.ts";

const rawFormats = ["CR3", "ARW"];

function matchedResult() {
  const input = {
    path: "/images/IMG_1001.JPG",
    fileName: "IMG_1001.JPG",
    baseName: "IMG_1001",
    extension: "jpg",
    size: 12,
    modifiedTime: null,
    manual: false,
  };
  const candidate = {
    ...input,
    path: "/raw/IMG_1001.CR3",
    fileName: "IMG_1001.CR3",
    extension: "cr3",
  };
  return {
    input,
    status: "matched",
    candidates: [candidate],
    selectedCandidate: candidate,
  };
}

test("默认创建两个相互独立的方向状态", () => {
  const states = createDirectionWorkspaceStates(rawFormats);

  assert.deepEqual(states.imageToRaw.selectedRawFormats, rawFormats);
  assert.deepEqual(states.rawToImage.selectedRawFormats, rawFormats);
  assert.notStrictEqual(states.imageToRaw, states.rawToImage);
  assert.notStrictEqual(
    states.imageToRaw.selectedRawFormats,
    states.rawToImage.selectedRawFormats,
  );
  assert.match(states.imageToRaw.logs[0].message, /JPG、JPEG、PNG/);
  assert.match(states.rawToImage.logs[0].message, /RAW/);
});

test("运行中任务禁止切换方向", () => {
  const states = createDirectionWorkspaceStates(rawFormats);

  assert.equal(canSwitchDirection(states.imageToRaw), true);
  assert.equal(canSwitchDirection({ ...states.imageToRaw, busy: "collect" }), false);
  assert.equal(canSwitchDirection({ ...states.imageToRaw, busy: "match" }), false);
  assert.equal(canSwitchDirection({ ...states.imageToRaw, busy: "export" }), false);
});

test("输入、查找目录和 RAW 格式就绪后可自动匹配", () => {
  const states = createDirectionWorkspaceStates(rawFormats);
  const readyState = {
    ...states.imageToRaw,
    inputs: [matchedResult().input],
    searchDirectory: "/raw-source",
  };

  assert.equal(isDirectionReadyForMatch(readyState), true);
  assert.equal(isDirectionReadyForMatch({ ...readyState, searchDirectory: "" }), false);
  assert.equal(isDirectionReadyForMatch({ ...readyState, selectedRawFormats: [] }), false);
  assert.equal(isDirectionReadyForMatch({ ...readyState, busy: "match" }), false);
});

test("方向交换动效期间禁止重复切换，完成后恢复可切换", () => {
  const states = createDirectionWorkspaceStates(rawFormats);
  const transition = {
    from: "imageToRaw",
    to: "rawToImage",
    phase: "exiting",
    sequence: 1,
  };

  assert.equal(canStartDirectionTransition(states.imageToRaw, transition), false);
  assert.equal(canStartDirectionTransition(states.imageToRaw, null), true);
  assert.equal(
    canStartDirectionTransition({ ...states.imageToRaw, busy: "match" }, null),
    false,
  );
});

test("更新一个方向不会修改另一个方向", () => {
  const states = createDirectionWorkspaceStates(rawFormats);
  const next = updateDirectionWorkspaceState(states, "rawToImage", {
    searchDirectory: "/images",
  });

  assert.equal(next.rawToImage.searchDirectory, "/images");
  assert.equal(next.imageToRaw.searchDirectory, "");
  assert.strictEqual(next.imageToRaw, states.imageToRaw);
});

test("交换方向后保留两个工作区各自的数据", () => {
  let states = createDirectionWorkspaceStates(rawFormats);
  states = updateDirectionWorkspaceState(states, "imageToRaw", {
    searchDirectory: "/raw-source",
  });
  states = updateDirectionWorkspaceState(states, "rawToImage", {
    searchDirectory: "/image-source",
  });

  const afterReturning = updateDirectionWorkspaceState(states, "imageToRaw", {
    exportDirectory: "/exports/raw",
  });

  assert.equal(afterReturning.imageToRaw.searchDirectory, "/raw-source");
  assert.equal(afterReturning.imageToRaw.exportDirectory, "/exports/raw");
  assert.equal(afterReturning.rawToImage.searchDirectory, "/image-source");
  assert.equal(afterReturning.rawToImage.exportDirectory, "");
});

test("RAW 文本清单与图片方向状态相互隔离", () => {
  const states = createDirectionWorkspaceStates(rawFormats);
  const rawManualInput = {
    path: "manual:IMG_9001.CR3",
    fileName: "IMG_9001.CR3",
    baseName: "IMG_9001",
    extension: "cr3",
    size: 0,
    modifiedTime: null,
    manual: true,
  };
  const next = updateDirectionWorkspaceState(states, "rawToImage", {
    inputs: [rawManualInput],
    manualRefs: ["IMG_9001.CR3"],
  });

  assert.deepEqual(next.rawToImage.manualRefs, ["IMG_9001.CR3"]);
  assert.equal(next.rawToImage.inputs[0].manual, true);
  assert.deepEqual(next.imageToRaw.manualRefs, []);
  assert.deepEqual(next.imageToRaw.inputs, []);
});

test("匹配条件变化会清除结果和导出报告", () => {
  const states = createDirectionWorkspaceStates(rawFormats);
  const result = matchedResult();
  const current = {
    ...states.imageToRaw,
    results: [result],
    exportReport: {
      directory: "/exports",
      summary: {
        copiedCount: 1,
        alreadyPresentCount: 0,
        skippedMissingCount: 0,
        skippedConflictCount: 0,
        collisionCount: 0,
        sourceErrorCount: 0,
      },
    },
  };

  const next = invalidateMatchState(current);

  assert.deepEqual(next.results, []);
  assert.equal(next.exportReport, null);
  assert.deepEqual(next.inputs, current.inputs);
  assert.deepEqual(next.selectedRawFormats, rawFormats);
});

test("清空只重置指定方向", () => {
  let states = createDirectionWorkspaceStates(rawFormats);
  states = updateDirectionWorkspaceState(states, "imageToRaw", {
    searchDirectory: "/raw",
  });
  states = updateDirectionWorkspaceState(states, "rawToImage", {
    searchDirectory: "/images",
  });

  const next = clearDirectionWorkspaceState(states, "imageToRaw", rawFormats);

  assert.equal(next.imageToRaw.searchDirectory, "");
  assert.match(next.imageToRaw.logs[0].message, /已清空当前方向任务/);
  assert.equal(next.rawToImage.searchDirectory, "/images");
  assert.strictEqual(next.rawToImage, states.rawToImage);
});
