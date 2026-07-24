import assert from "node:assert/strict";
import test from "node:test";

import {
  canMountWorkspace,
  formatDeviceCode,
  licenseErrorCode,
  licenseErrorMessage,
  type LicenseStatus,
} from "./state.ts";

function status(state: LicenseStatus["state"]): LicenseStatus {
  return {
    state,
    deviceCode: "a".repeat(64),
    leaseExpiresAt: null,
    graceUntil: null,
    lastOnlineCheckAt: null,
    message: "",
  };
}

test("只有有效租约与离线宽限可以挂载业务工作区", () => {
  assert.equal(canMountWorkspace(status("active")), true);
  assert.equal(canMountWorkspace(status("offlineGrace")), true);
  assert.equal(canMountWorkspace(status("needsActivation")), false);
  assert.equal(canMountWorkspace(status("expired")), false);
  assert.equal(canMountWorkspace(status("clockRollback")), false);
});

test("设备码按八位分组，复制值仍可使用原始哈希", () => {
  assert.equal(formatDeviceCode("12345678abcdefgh"), "12345678 abcdefgh");
});

test("稳定错误码映射为可操作的中文文案", () => {
  assert.equal(licenseErrorCode({ code: "ALREADY_BOUND", message: "bound" }), "ALREADY_BOUND");
  assert.match(
    licenseErrorMessage({ code: "ALREADY_BOUND", message: "bound" }),
    /另一台设备/,
  );
  assert.match(licenseErrorMessage('{"code":"RATE_LIMITED"}'), /稍后/);
  assert.match(licenseErrorMessage(new Error("network failed")), /暂时不可用/);
});
