import assert from "node:assert/strict";
import test from "node:test";

import {
  completeWatermarkProgress,
  computeWatermarkGeometry,
  computeWatermarkPlacements,
  createDefaultProfiles,
  createDefaultProfilesBySource,
  createDefaultWatermarkSettings,
  createWatermarkProgress,
  glassAlphaFactor,
  defaultTextWatermarkClarity,
  defaultTextWatermarkTileSpacingPercent,
  legacyWatermarkV4SettingsKey,
  legacyWatermarkV3SettingsKey,
  legacyWatermarkV2SettingsKey,
  loadWatermarkSettings,
  legacyWatermarkSettingsKey,
  markWatermarkCancelling,
  reduceWatermarkProgress,
  resolveWatermarkFont,
  saveWatermarkSettings,
  syncWatermarkProfiles,
  thumbnailWindow,
  updateWatermarkProfile,
  watermarkWorkflowStepStates,
  watermarkSettingsKey,
} from "./state.ts";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    values,
  };
}

function firstPlacementsByRow(placements) {
  const rows = new Map();
  for (const placement of placements) {
    if (!rows.has(placement.centerY)) {
      rows.set(placement.centerY, placement);
    }
  }
  return [...rows.values()];
}

test("默认创建三套相互独立的画幅配置", () => {
  const profiles = createDefaultProfiles();

  assert.equal(profiles.landscape.anchor, "bottomRight");
  assert.equal(profiles.landscape.layout, "single");
  assert.equal(profiles.landscape.tileSpacingPercent, 8);
  assert.equal(profiles.landscape.sizePercent, 20);
  assert.notStrictEqual(profiles.landscape, profiles.portrait);
  assert.notStrictEqual(profiles.portrait, profiles.square);
});

test("文字与图片使用相互独立的默认参数", () => {
  const profilesBySource = createDefaultProfilesBySource();

  assert.equal(profilesBySource.image.landscape.clarity, 1);
  assert.equal(profilesBySource.image.landscape.tileSpacingPercent, 8);
  assert.equal(profilesBySource.text.landscape.clarity, defaultTextWatermarkClarity);
  assert.equal(
    profilesBySource.text.landscape.tileSpacingPercent,
    defaultTextWatermarkTileSpacingPercent,
  );
  assert.notStrictEqual(profilesBySource.image.landscape, profilesBySource.text.landscape);
});

test("水印三步流程按来源与素材就绪状态推进", () => {
  assert.deepEqual(watermarkWorkflowStepStates(0, false), ["current", "pending", "pending"]);
  assert.deepEqual(watermarkWorkflowStepStates(3, false), ["complete", "current", "pending"]);
  assert.deepEqual(watermarkWorkflowStepStates(3, true), ["complete", "complete", "current"]);
  assert.deepEqual(watermarkWorkflowStepStates(0, true), ["current", "complete", "pending"]);
});

test("更新一个画幅不会修改其他画幅", () => {
  const profiles = createDefaultProfiles();
  const next = updateWatermarkProfile(profiles, "portrait", { sizePercent: 32 });

  assert.equal(next.portrait.sizePercent, 32);
  assert.equal(next.landscape.sizePercent, 20);
  assert.equal(next.square.sizePercent, 20);
  assert.strictEqual(next.landscape, profiles.landscape);
});

test("同步按值复制且后续仍相互独立", () => {
  const updated = updateWatermarkProfile(createDefaultProfiles(), "landscape", {
    anchor: "topLeft",
    rotationDegrees: 28,
  });
  const synced = syncWatermarkProfiles(updated, "landscape");

  assert.deepEqual(synced.portrait, synced.landscape);
  assert.notStrictEqual(synced.portrait, synced.landscape);
  const next = updateWatermarkProfile(synced, "portrait", { rotationDegrees: 10 });
  assert.equal(next.landscape.rotationDegrees, 28);
});

test("v5 配置保存素材来源、文字字体与来源独立参数", () => {
  const storage = memoryStorage();
  const settings = {
    sourceKind: "text",
    watermarkPath: "/logos/watermark.png",
    text: "© 本地摄影",
    fontId: "PingFangSC-Regular",
    profilesBySource: {
      image: createDefaultProfiles("image"),
      text: updateWatermarkProfile(createDefaultProfiles("text"), "square", {
        clarity: 0.25,
      }),
    },
  };

  assert.equal(saveWatermarkSettings(storage, settings), true);
  assert.ok(storage.values.has(watermarkSettingsKey));
  assert.deepEqual(loadWatermarkSettings(storage), settings);
});

test("v4 文字配置仅迁移仍为旧默认值的通透度与间距", () => {
  const storage = memoryStorage({
    [legacyWatermarkV4SettingsKey]: JSON.stringify({
      sourceKind: "text",
      text: "本地摄影",
      fontId: "PingFangSC-Regular",
      profiles: {
        landscape: {
          ...createDefaultProfiles().landscape,
          layout: "tile",
        },
        portrait: {
          ...createDefaultProfiles().portrait,
          clarity: 0.65,
          tileSpacingPercent: 11,
        },
      },
    }),
  });

  const loaded = loadWatermarkSettings(storage);
  assert.equal(loaded.sourceKind, "text");
  assert.equal(loaded.profilesBySource.image.landscape.clarity, 1);
  assert.equal(loaded.profilesBySource.image.landscape.tileSpacingPercent, 8);
  assert.equal(loaded.profilesBySource.text.landscape.clarity, 0.4);
  assert.equal(loaded.profilesBySource.text.landscape.tileSpacingPercent, 2);
  assert.equal(loaded.profilesBySource.text.portrait.clarity, 0.65);
  assert.equal(loaded.profilesBySource.text.portrait.tileSpacingPercent, 11);
});

test("v3 图片配置迁移后保持图片来源和原参数", () => {
  const storage = memoryStorage({
    [legacyWatermarkV3SettingsKey]: JSON.stringify({
      watermarkPath: "/logos/v3.png",
      profiles: {
        square: {
          layout: "tile",
          anchor: "center",
          clarity: 0.8,
          sizePercent: 27,
          rotationDegrees: -12,
          offsetXPercent: 4,
          offsetYPercent: 5,
          tileSpacingPercent: 9,
        },
      },
    }),
  });

  const loaded = loadWatermarkSettings(storage);
  assert.equal(loaded.sourceKind, "image");
  assert.equal(loaded.watermarkPath, "/logos/v3.png");
  assert.equal(loaded.text, "");
  assert.equal(loaded.fontId, "");
  assert.equal(loaded.profilesBySource.image.square.sizePercent, 27);
  assert.equal(loaded.profilesBySource.text.square.clarity, 0.4);
});

test("v1 配置迁移时为布局和平铺间距补默认值", () => {
  const storage = memoryStorage({
    [legacyWatermarkSettingsKey]: JSON.stringify({
      watermarkPath: "/logos/legacy.png",
      profiles: {
        landscape: {
          anchor: "topLeft",
          opacity: 0.5,
          sizePercent: 30,
          rotationDegrees: 15,
          offsetXPercent: 2,
          offsetYPercent: -3,
        },
      },
    }),
  });

  const loaded = loadWatermarkSettings(storage);
  assert.equal(loaded.watermarkPath, "/logos/legacy.png");
  assert.equal(loaded.profilesBySource.image.landscape.layout, "single");
  assert.equal(loaded.profilesBySource.image.landscape.tileSpacingPercent, 8);
  assert.equal(loaded.profilesBySource.image.landscape.anchor, "topLeft");
  assert.equal(loaded.profilesBySource.image.landscape.clarity, 0.5);
});

test("v2 配置将透明度数值迁移为通透度", () => {
  const storage = memoryStorage({
    [legacyWatermarkV2SettingsKey]: JSON.stringify({
      watermarkPath: "/logos/v2.png",
      profiles: {
        portrait: {
          layout: "single",
          anchor: "bottomRight",
          opacity: 0.72,
          sizePercent: 20,
          rotationDegrees: 0,
          offsetXPercent: 0,
          offsetYPercent: 0,
          tileSpacingPercent: 8,
        },
      },
    }),
  });

  const loaded = loadWatermarkSettings(storage);
  assert.equal(loaded.watermarkPath, "/logos/v2.png");
  assert.equal(loaded.profilesBySource.image.portrait.clarity, 0.72);
  assert.equal("opacity" in loaded.profilesBySource.image.portrait, false);
});

test("损坏或越界配置安全恢复并钳制", () => {
  const invalidJson = memoryStorage({ [watermarkSettingsKey]: "{" });
  assert.deepEqual(loadWatermarkSettings(invalidJson), createDefaultWatermarkSettings());

  const outOfRange = memoryStorage({
    [watermarkSettingsKey]: JSON.stringify({
      watermarkPath: 42,
      profilesBySource: {
        image: {
          landscape: { clarity: 5, sizePercent: -3, rotationDegrees: 999 },
        },
      },
    }),
  });
  const loaded = loadWatermarkSettings(outOfRange);
  assert.equal(loaded.watermarkPath, "");
  assert.equal(loaded.profilesBySource.image.landscape.clarity, 1);
  assert.equal(loaded.profilesBySource.image.landscape.sizePercent, 1);
  assert.equal(loaded.profilesBySource.image.landscape.rotationDegrees, 180);
});

test("失效字体回退默认字体且保留图片与文字设置", () => {
  const fonts = [
    { id: "Default-Regular", displayName: "Default", familyName: "Default" },
    { id: "Other-Regular", displayName: "Other", familyName: "Other" },
  ];

  assert.deepEqual(resolveWatermarkFont(fonts, "Other-Regular", "Default-Regular"), {
    fontId: "Other-Regular",
    fellBack: false,
  });
  assert.deepEqual(resolveWatermarkFont(fonts, "Missing-Regular", "Default-Regular"), {
    fontId: "Default-Regular",
    fellBack: true,
  });
});

test("通透度 100% 仍保留最低玻璃可见度", () => {
  assert.equal(glassAlphaFactor(0), 1);
  assert.equal(glassAlphaFactor(1), 0.35);
  assert.equal(glassAlphaFactor(2), 0.35);
});

test("Canvas 几何默认值与 Rust 表格样例一致", () => {
  const geometry = computeWatermarkGeometry({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 100,
    watermarkHeight: 50,
    profile: createDefaultProfiles().landscape,
  });

  assert.equal(geometry.drawWidth, 100);
  assert.equal(geometry.drawHeight, 50);
  assert.equal(geometry.centerX, 935);
  assert.equal(geometry.centerY, 460);
  assert.equal(geometry.margin, 15);
});

test("文字大小按素材高度计算且长文字保持宽高比", () => {
  const geometry = computeWatermarkGeometry({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 400,
    watermarkHeight: 100,
    profile: createDefaultProfiles().landscape,
    sizeBasis: "height",
  });

  assert.equal(geometry.drawHeight, 100);
  assert.equal(geometry.drawWidth, 400);
});

test("极端旋转和偏移仍限制在安全边距内", () => {
  const profile = {
    ...createDefaultProfiles().landscape,
    rotationDegrees: 42,
    offsetXPercent: 50,
    offsetYPercent: -50,
  };
  const geometry = computeWatermarkGeometry({
    targetWidth: 800,
    targetHeight: 600,
    watermarkWidth: 200,
    watermarkHeight: 80,
    profile,
  });
  const left = geometry.centerX - geometry.boundsWidth / 2;
  const top = geometry.centerY - geometry.boundsHeight / 2;

  assert.ok(left >= geometry.margin - 0.001);
  assert.ok(top >= geometry.margin - 0.001);
  assert.ok(left + geometry.boundsWidth <= 800 - geometry.margin + 0.001);
  assert.ok(top + geometry.boundsHeight <= 600 - geometry.margin + 0.001);
});

test("平铺位置覆盖画面并响应间距与整体偏移", () => {
  const profile = {
    ...createDefaultProfiles().landscape,
    layout: "tile",
    sizePercent: 20,
    tileSpacingPercent: 8,
  };
  const placements = computeWatermarkPlacements({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 100,
    watermarkHeight: 50,
    profile,
  });
  const shifted = computeWatermarkPlacements({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 100,
    watermarkHeight: 50,
    profile: { ...profile, offsetXPercent: 10 },
  });

  assert.ok(placements.length > 20);
  assert.equal(placements[0].drawWidth, 100);
  assert.equal(placements[0].drawHeight, 50);
  assert.notEqual(placements[0].centerX, shifted[0].centerX);
  assert.ok(placements.some((placement) => placement.centerX >= 0 && placement.centerX <= 1000));
  assert.ok(placements.some((placement) => placement.centerY >= 0 && placement.centerY <= 500));
});

test("旋转文字平铺保持局部短边间距并覆盖画面", () => {
  const rotationDegrees = -25;
  const placements = computeWatermarkPlacements({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 300,
    watermarkHeight: 100,
    profile: {
      ...createDefaultProfiles("text").landscape,
      layout: "tile",
      sizePercent: 10,
      rotationDegrees,
    },
    sizeBasis: "height",
  });
  const shifted = computeWatermarkPlacements({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 300,
    watermarkHeight: 100,
    profile: {
      ...createDefaultProfiles("text").landscape,
      layout: "tile",
      sizePercent: 10,
      rotationDegrees,
      offsetXPercent: 10,
      offsetYPercent: -10,
    },
    sizeBasis: "height",
  });
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const nearest = (targetX, targetY) =>
    placements.reduce((closest, placement) => {
      const distance = (placement.centerX - targetX) ** 2 + (placement.centerY - targetY) ** 2;
      const closestDistance =
        (closest.centerX - targetX) ** 2 + (closest.centerY - targetY) ** 2;
      return distance < closestDistance ? placement : closest;
    });
  const center = nearest(500, 250);
  const nextRow = nearest(500 + 80 * cos - 60 * sin, 250 + 80 * sin + 60 * cos);
  const deltaX = nextRow.centerX - center.centerX;
  const deltaY = nextRow.centerY - center.centerY;
  const localLongAxisDistance = deltaX * cos + deltaY * sin;
  const localShortAxisDistance = -deltaX * sin + deltaY * cos;

  assert.ok(placements.length > 0);
  assert.equal(placements[0].drawHeight, 50);
  assert.equal(placements[0].drawWidth, 150);
  assert.ok(placements[0].boundsHeight > 60);
  assert.deepEqual([center.centerX, center.centerY], [500, 250.5]);
  assert.deepEqual([nextRow.centerX, nextRow.centerY], [598, 270.5]);
  assert.ok(Math.abs(localLongAxisDistance - 80) <= 1);
  assert.ok(Math.abs(localShortAxisDistance - 60) <= 1);
  assert.ok(
    placements.some(
      ({ boundsWidth, centerX }) => centerX - boundsWidth / 2 <= 0 && centerX > 0,
    ),
  );
  assert.ok(
    placements.some(
      ({ boundsWidth, centerX }) => centerX < 1000 && centerX + boundsWidth / 2 >= 1000,
    ),
  );
  assert.ok(
    placements.some(
      ({ boundsHeight, centerY }) => centerY - boundsHeight / 2 <= 0 && centerY > 0,
    ),
  );
  assert.ok(
    placements.some(
      ({ boundsHeight, centerY }) => centerY < 500 && centerY + boundsHeight / 2 >= 500,
    ),
  );
  assert.notDeepEqual(
    placements.map(({ centerX, centerY }) => [centerX, centerY]),
    shifted.map(({ centerX, centerY }) => [centerX, centerY]),
  );
});

test("图片平铺继续保持各行对齐", () => {
  const placements = computeWatermarkPlacements({
    targetWidth: 1000,
    targetHeight: 500,
    watermarkWidth: 150,
    watermarkHeight: 50,
    profile: {
      ...createDefaultProfiles("image").landscape,
      layout: "tile",
      sizePercent: 30,
    },
    sizeBasis: "width",
  });
  const firstPlacementByRow = firstPlacementsByRow(placements);

  assert.equal(firstPlacementByRow[0].centerX, firstPlacementByRow[1].centerX);
});

test("进度事件累计成功、跳过、失败并支持取消状态", () => {
  let progress = reduceWatermarkProgress(createWatermarkProgress(), {
    type: "started",
    jobId: "job",
    totalCount: 3,
  });
  progress = reduceWatermarkProgress(progress, {
    type: "itemFinished",
    jobId: "job",
    index: 1,
    totalCount: 3,
    relativePath: "a.jpg",
    status: "exported",
    message: "ok",
  });
  progress = reduceWatermarkProgress(progress, {
    type: "itemFinished",
    jobId: "job",
    index: 2,
    totalCount: 3,
    relativePath: "b.jpg",
    status: "failed",
    message: "bad",
  });
  progress = markWatermarkCancelling(progress);
  progress = reduceWatermarkProgress(progress, {
    type: "cancelled",
    jobId: "job",
    processedCount: 2,
    remainingCount: 1,
  });

  assert.equal(progress.running, false);
  assert.equal(progress.cancelling, false);
  assert.equal(progress.exportedCount, 1);
  assert.equal(progress.failedCount, 1);
  assert.equal(progress.cancelledRemainingCount, 1);
});

test("最终汇总覆盖流式进度并结束运行态", () => {
  const running = { ...createWatermarkProgress(), running: true, totalCount: 4 };
  const complete = completeWatermarkProgress(running, {
    totalCount: 4,
    processedCount: 4,
    exportedCount: 2,
    skippedExistingCount: 1,
    failedCount: 1,
    cancelledRemainingCount: 0,
  });

  assert.equal(complete.running, false);
  assert.equal(complete.processedCount, 4);
  assert.equal(complete.skippedExistingCount, 1);
});

test("缩略图窗口围绕当前项并限制渲染数量", () => {
  assert.deepEqual(thumbnailWindow(100, 50, 15), { start: 43, end: 58 });
  assert.deepEqual(thumbnailWindow(8, 7, 15), { start: 0, end: 8 });
  assert.deepEqual(thumbnailWindow(100, 99, 15), { start: 85, end: 100 });
});
