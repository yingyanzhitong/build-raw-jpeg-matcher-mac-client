export type LicenseState =
  | "needsActivation"
  | "active"
  | "offlineGrace"
  | "expired"
  | "clockRollback";

export interface LicenseStatus {
  state: LicenseState;
  deviceCode: string;
  leaseExpiresAt: number | null;
  graceUntil: number | null;
  lastOnlineCheckAt: number | null;
  message: string;
}

const errorMessages: Record<string, string> = {
  INVALID_TOKEN: "这个 token 无效，请检查是否完整复制。",
  ALREADY_BOUND: "这个 token 已绑定另一台设备，如需换机请联系管理员重置。",
  REVOKED: "这份授权已被撤销，请联系管理员。",
  RATE_LIMITED: "尝试次数过多，请稍后再试。",
  LICENSE_EXPIRED: "设备租约与离线宽限均已过期，请联网后重试。",
  SERVER_ERROR: "激活服务暂时不可用，请检查网络后重试。",
};

export function canMountWorkspace(status: LicenseStatus | null) {
  return status?.state === "active" || status?.state === "offlineGrace";
}

export function formatDeviceCode(code: string) {
  return code.match(/.{1,8}/g)?.join(" ") ?? code;
}

export function licenseErrorMessage(error: unknown) {
  const parsed = parseLicenseError(error);
  return errorMessages[parsed.code] ?? parsed.message ?? errorMessages.SERVER_ERROR;
}

export function licenseErrorCode(error: unknown) {
  return parseLicenseError(error).code;
}

function parseLicenseError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        message: typeof candidate.message === "string" ? candidate.message : "",
      };
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  try {
    return parseLicenseError(JSON.parse(message));
  } catch {
    const code = Object.keys(errorMessages).find((candidate) => message.includes(candidate));
    return { code: code ?? "SERVER_ERROR", message };
  }
}
