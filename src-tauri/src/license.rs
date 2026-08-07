use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

const PRODUCT_ID: &str = "raw-jpeg-matcher-licensed";
const DEVICE_HASH_DOMAIN: &str = "raw-jpeg-matcher-licensed:v1";
const SERVICE_URL: &str = "https://licensed.xyyamsz.cn";
const LICENSE_PUBLIC_KEY_BASE64: &str = "m3taKybxr3VM88UWDhzYFyR5F+AtTH25OHxQNY5TvIE=";
const LICENSE_SCHEMA_VERSION: u8 = 1;
const LICENSED_APP_VERSION: &str = "1.0.5";
const RENEW_INTERVAL_SECONDS: i64 = 24 * 60 * 60;
const CLOCK_ROLLBACK_TOLERANCE_SECONDS: i64 = 5 * 60;
const CREDENTIAL_SERVICE: &str = "com.masongzhi.rawjpegmatcher.licensed";
const CREDENTIAL_USER: &str = "device-license";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LicenseStatus {
    pub state: LicenseState,
    pub device_code: String,
    pub lease_expires_at: Option<i64>,
    pub grace_until: Option<i64>,
    pub last_online_check_at: Option<i64>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LicenseState {
    NeedsActivation,
    Active,
    OfflineGrace,
    Expired,
    ClockRollback,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LicenseCommandError {
    pub code: String,
    pub message: String,
}

impl LicenseCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn local(message: impl Into<String>) -> Self {
        Self::new("SERVER_ERROR", message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedLease {
    payload: String,
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct LeasePayload {
    schema_version: u8,
    license_id: String,
    product: String,
    device_hash: String,
    generation: i64,
    issued_at: i64,
    renew_after: i64,
    expires_at: i64,
    grace_until: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredLicense {
    lease: SignedLease,
    max_seen_unix: i64,
    last_online_check_unix: i64,
    #[serde(default)]
    last_renewal_attempt_unix: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivateRequest<'a> {
    token: &'a str,
    device_hash: &'a str,
    platform: &'static str,
    version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenewRequest<'a> {
    lease: &'a SignedLease,
    device_hash: &'a str,
    platform: &'static str,
    version: &'static str,
}

#[derive(Debug, Deserialize)]
struct ApiSuccess {
    lease: SignedLease,
}

#[derive(Debug, Deserialize)]
struct ApiFailureEnvelope {
    error: ApiFailure,
}

#[derive(Debug, Deserialize)]
struct ApiFailure {
    code: String,
    message: String,
}

trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredLicense>, String>;
    fn save(&self, license: &StoredLicense) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Default)]
struct NativeCredentialStore;

impl NativeCredentialStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))
    }
}

impl CredentialStore for NativeCredentialStore {
    fn load(&self) -> Result<Option<StoredLicense>, String> {
        match Self::entry()?.get_password() {
            Ok(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|error| format!("系统凭据中的许可证格式无效: {error}")),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取系统凭据失败: {error}")),
        }
    }

    fn save(&self, license: &StoredLicense) -> Result<(), String> {
        let serialized =
            serde_json::to_string(license).map_err(|error| format!("序列化许可证失败: {error}"))?;
        Self::entry()?
            .set_password(&serialized)
            .map_err(|error| format!("写入系统凭据失败: {error}"))
    }

    fn delete(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("删除系统凭据失败: {error}")),
        }
    }
}

trait Clock: Send + Sync {
    fn now_unix(&self) -> i64;
}

#[derive(Default)]
struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default()
    }
}

pub(crate) struct LicenseManager {
    device_hash: String,
    verifying_key: [u8; 32],
    store: Arc<dyn CredentialStore>,
    clock: Arc<dyn Clock>,
    http: reqwest::Client,
    service_url: String,
}

impl LicenseManager {
    pub(crate) fn new() -> Result<Self, String> {
        let hardware_id = hardware::hardware_identifier()?;
        Ok(Self {
            device_hash: device_hash(&hardware_id),
            verifying_key: production_verifying_key()?,
            store: Arc::new(NativeCredentialStore),
            clock: Arc::new(SystemClock),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .https_only(true)
                .build()
                .map_err(|error| format!("初始化许可证网络客户端失败: {error}"))?,
            service_url: SERVICE_URL.to_string(),
        })
    }

    #[cfg(test)]
    fn with_dependencies(
        device_hash: String,
        verifying_key: [u8; 32],
        store: Arc<dyn CredentialStore>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            device_hash,
            verifying_key,
            store,
            clock,
            http: reqwest::Client::new(),
            service_url: SERVICE_URL.to_string(),
        }
    }

    pub(crate) fn status(&self) -> LicenseStatus {
        self.evaluate_stored_license(true)
            .unwrap_or_else(|error| LicenseStatus {
                state: LicenseState::NeedsActivation,
                device_code: self.device_hash.clone(),
                lease_expires_at: None,
                grace_until: None,
                last_online_check_at: None,
                message: error,
            })
    }

    pub(crate) fn require_active(&self) -> Result<(), String> {
        let status = self.evaluate_stored_license(true)?;
        match status.state {
            LicenseState::Active | LicenseState::OfflineGrace => Ok(()),
            LicenseState::NeedsActivation => {
                Err("LICENSE_REQUIRED: 此设备尚未激活，请先完成 token 激活。".to_string())
            }
            LicenseState::Expired => {
                Err("LICENSE_EXPIRED: 设备租约及离线宽限均已过期，请联网续签。".to_string())
            }
            LicenseState::ClockRollback => {
                Err("CLOCK_ROLLBACK: 检测到系统时间回拨，请校准系统时间后重试。".to_string())
            }
        }
    }

    async fn activate(&self, token: String) -> Result<LicenseStatus, LicenseCommandError> {
        let token = normalize_token(&token)
            .map_err(|message| LicenseCommandError::new("INVALID_TOKEN", message))?;
        let response = self
            .http
            .post(format!("{}/api/v1/activate", self.service_url))
            .json(&ActivateRequest {
                token: &token,
                device_hash: &self.device_hash,
                platform: platform_name(),
                version: LICENSED_APP_VERSION,
            })
            .send()
            .await
            .map_err(|error| {
                LicenseCommandError::local(format!("无法连接激活服务，请检查网络后重试: {error}"))
            })?;

        let success = parse_api_response(response).await?;
        let now = self.clock.now_unix();
        let payload = verify_lease(&success.lease, &self.device_hash, &self.verifying_key)?;
        self.store
            .save(&StoredLicense {
                lease: success.lease,
                max_seen_unix: now.max(payload.issued_at),
                last_online_check_unix: now,
                last_renewal_attempt_unix: now,
            })
            .map_err(LicenseCommandError::local)?;
        Ok(self.status())
    }

    async fn renew_if_due(&self) -> Result<LicenseStatus, LicenseCommandError> {
        let mut stored = self
            .store
            .load()
            .map_err(LicenseCommandError::local)?
            .ok_or_else(|| LicenseCommandError::new("LICENSE_EXPIRED", "此设备尚未激活。"))?;
        let now = self.clock.now_unix();
        let payload = verify_lease(&stored.lease, &self.device_hash, &self.verifying_key)?;
        if !renewal_is_due(now, &payload, &stored) {
            return Ok(self.status());
        }
        stored.last_renewal_attempt_unix = now;
        stored.max_seen_unix = stored.max_seen_unix.max(now);
        self.store
            .save(&stored)
            .map_err(LicenseCommandError::local)?;

        let response = self
            .http
            .post(format!("{}/api/v1/renew", self.service_url))
            .json(&RenewRequest {
                lease: &stored.lease,
                device_hash: &self.device_hash,
                platform: platform_name(),
                version: LICENSED_APP_VERSION,
            })
            .send()
            .await
            .map_err(|error| {
                LicenseCommandError::local(format!("暂时无法续签，将按本地租约继续运行: {error}"))
            })?;

        match parse_api_response(response).await {
            Ok(success) => {
                let payload = verify_lease(&success.lease, &self.device_hash, &self.verifying_key)?;
                stored.lease = success.lease;
                stored.last_online_check_unix = now;
                stored.last_renewal_attempt_unix = now;
                stored.max_seen_unix = stored.max_seen_unix.max(now).max(payload.issued_at);
                self.store
                    .save(&stored)
                    .map_err(LicenseCommandError::local)?;
                Ok(self.status())
            }
            Err(error) if error.code == "REVOKED" || error.code == "LICENSE_EXPIRED" => {
                self.store.delete().map_err(LicenseCommandError::local)?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    fn evaluate_stored_license(&self, persist_time: bool) -> Result<LicenseStatus, String> {
        let Some(mut stored) = self.store.load()? else {
            return Ok(LicenseStatus {
                state: LicenseState::NeedsActivation,
                device_code: self.device_hash.clone(),
                lease_expires_at: None,
                grace_until: None,
                last_online_check_at: None,
                message: "请输入购买后获得的激活 token。".to_string(),
            });
        };
        let payload = verify_lease(&stored.lease, &self.device_hash, &self.verifying_key)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let now = self.clock.now_unix();

        if now.saturating_add(CLOCK_ROLLBACK_TOLERANCE_SECONDS) < stored.max_seen_unix {
            return Ok(LicenseStatus {
                state: LicenseState::ClockRollback,
                device_code: self.device_hash.clone(),
                lease_expires_at: Some(payload.expires_at),
                grace_until: Some(payload.grace_until),
                last_online_check_at: Some(stored.last_online_check_unix),
                message: "检测到系统时间早于上次可信时间，请联网校时后重试。".to_string(),
            });
        }

        if persist_time && now > stored.max_seen_unix {
            stored.max_seen_unix = now;
            self.store.save(&stored)?;
        }

        let (state, message) = if now <= payload.expires_at {
            (
                LicenseState::Active,
                "许可证有效，当前设备已激活。".to_string(),
            )
        } else if now <= payload.grace_until {
            (
                LicenseState::OfflineGrace,
                "在线租约已到期，当前处于 7 天离线宽限期，请尽快联网。".to_string(),
            )
        } else {
            (
                LicenseState::Expired,
                "设备租约及离线宽限均已过期，请联网续签。".to_string(),
            )
        };

        Ok(LicenseStatus {
            state,
            device_code: self.device_hash.clone(),
            lease_expires_at: Some(payload.expires_at),
            grace_until: Some(payload.grace_until),
            last_online_check_at: Some(stored.last_online_check_unix),
            message,
        })
    }
}

fn renewal_is_due(now: i64, payload: &LeasePayload, stored: &StoredLicense) -> bool {
    let last_attempt = stored
        .last_renewal_attempt_unix
        .max(stored.last_online_check_unix);
    now >= payload.renew_after
        && now.saturating_sub(last_attempt) >= RENEW_INTERVAL_SECONDS
}

#[tauri::command]
pub(crate) fn license_status(manager: tauri::State<'_, LicenseManager>) -> LicenseStatus {
    manager.status()
}

#[tauri::command]
pub(crate) async fn activate_license(
    token: String,
    manager: tauri::State<'_, LicenseManager>,
    app: tauri::AppHandle,
) -> Result<LicenseStatus, LicenseCommandError> {
    let status = manager.activate(token).await?;
    use tauri::Emitter;
    let _ = app.emit("license-activated", &status);
    Ok(status)
}

#[tauri::command]
pub(crate) async fn renew_license(
    manager: tauri::State<'_, LicenseManager>,
) -> Result<LicenseStatus, LicenseCommandError> {
    manager.renew_if_due().await
}

async fn parse_api_response(
    response: reqwest::Response,
) -> Result<ApiSuccess, LicenseCommandError> {
    let status = response.status();
    if status.is_success() {
        return response.json::<ApiSuccess>().await.map_err(|error| {
            LicenseCommandError::local(format!("激活服务返回了无法识别的数据: {error}"))
        });
    }

    let fallback_code = if status == StatusCode::TOO_MANY_REQUESTS {
        "RATE_LIMITED"
    } else {
        "SERVER_ERROR"
    };
    let failure = response.json::<ApiFailureEnvelope>().await.ok();
    Err(match failure {
        Some(failure) => LicenseCommandError::new(failure.error.code, failure.error.message),
        None => LicenseCommandError::new(
            fallback_code,
            format!("激活服务请求失败，HTTP 状态码 {status}。"),
        ),
    })
}

fn verify_lease(
    lease: &SignedLease,
    expected_device_hash: &str,
    public_key_array: &[u8; 32],
) -> Result<LeasePayload, LicenseCommandError> {
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(&lease.payload)
        .map_err(|_| LicenseCommandError::new("LICENSE_EXPIRED", "许可证载荷编码无效。"))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&lease.signature)
        .map_err(|_| LicenseCommandError::new("LICENSE_EXPIRED", "许可证签名编码无效。"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| LicenseCommandError::new("LICENSE_EXPIRED", "许可证签名长度无效。"))?;
    VerifyingKey::from_bytes(public_key_array)
        .and_then(|key| key.verify(&payload_bytes, &signature))
        .map_err(|_| LicenseCommandError::new("LICENSE_EXPIRED", "许可证签名校验失败。"))?;

    let payload: LeasePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| LicenseCommandError::new("LICENSE_EXPIRED", "许可证载荷格式无效。"))?;
    if payload.schema_version != LICENSE_SCHEMA_VERSION {
        return Err(LicenseCommandError::new(
            "LICENSE_EXPIRED",
            "许可证版本与当前应用不兼容。",
        ));
    }
    if payload.product != PRODUCT_ID {
        return Err(LicenseCommandError::new(
            "LICENSE_EXPIRED",
            "许可证不属于当前产品。",
        ));
    }
    if payload.device_hash != expected_device_hash {
        return Err(LicenseCommandError::new(
            "ALREADY_BOUND",
            "许可证绑定的设备与当前设备不一致。",
        ));
    }
    if payload.generation < 1
        || payload.issued_at <= 0
        || payload.renew_after < payload.issued_at
        || payload.expires_at < payload.renew_after
        || payload.grace_until < payload.expires_at
    {
        return Err(LicenseCommandError::new(
            "LICENSE_EXPIRED",
            "许可证时间或绑定代次无效。",
        ));
    }
    Ok(payload)
}

fn production_verifying_key() -> Result<[u8; 32], String> {
    base64::engine::general_purpose::STANDARD
        .decode(LICENSE_PUBLIC_KEY_BASE64)
        .map_err(|_| "内置许可证公钥无效。".to_string())?
        .try_into()
        .map_err(|_| "内置许可证公钥长度无效。".to_string())
}

fn normalize_token(input: &str) -> Result<String, String> {
    let compact: String = input
        .chars()
        .filter(|character| !character.is_ascii_whitespace() && *character != '-')
        .map(|character| character.to_ascii_uppercase())
        .collect();
    let Some(body) = compact.strip_prefix("RJM") else {
        return Err("token 必须以 RJM 开头。".to_string());
    };
    const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    if body.len() != 25 || !body.chars().all(|character| ALPHABET.contains(character)) {
        return Err("token 格式无效，请粘贴完整的 25 位激活码。".to_string());
    }
    let groups = body
        .as_bytes()
        .chunks(5)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>();
    Ok(format!("RJM-{}", groups.join("-")))
}

fn device_hash(hardware_identifier: &str) -> String {
    let normalized: String = hardware_identifier
        .trim()
        .trim_matches(['{', '}'])
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect();
    let mut hasher = Sha256::new();
    hasher.update(DEVICE_HASH_DOMAIN.as_bytes());
    hasher.update([0]);
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unsupported"
    }
}

#[cfg(target_os = "macos")]
mod hardware {
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        ptr,
    };

    type IoObject = u32;
    type CfStringRef = *const c_void;
    type CfTypeRef = *const c_void;
    type CfAllocatorRef = *const c_void;
    type CfMutableDictionaryRef = *mut c_void;

    const UTF8_ENCODING: u32 = 0x0800_0100;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> CfMutableDictionaryRef;
        fn IOServiceGetMatchingService(
            main_port: u32,
            matching: CfMutableDictionaryRef,
        ) -> IoObject;
        fn IORegistryEntryCreateCFProperty(
            entry: IoObject,
            key: CfStringRef,
            allocator: CfAllocatorRef,
            options: u32,
        ) -> CfTypeRef;
        fn IOObjectRelease(object: IoObject) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: CfAllocatorRef,
            value: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFStringGetCString(
            string: CfStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFRelease(value: CfTypeRef);
    }

    pub(super) fn hardware_identifier() -> Result<String, String> {
        let service_name =
            CString::new("IOPlatformExpertDevice").map_err(|error| error.to_string())?;
        let property_name = CString::new("IOPlatformUUID").map_err(|error| error.to_string())?;
        let mut buffer = [0_i8; 128];

        unsafe {
            let matching = IOServiceMatching(service_name.as_ptr());
            if matching.is_null() {
                return Err("无法创建 IOPlatformExpertDevice 查询。".to_string());
            }
            let service = IOServiceGetMatchingService(0, matching);
            if service == 0 {
                return Err("未找到 IOPlatformExpertDevice。".to_string());
            }
            let key = CFStringCreateWithCString(ptr::null(), property_name.as_ptr(), UTF8_ENCODING);
            if key.is_null() {
                IOObjectRelease(service);
                return Err("无法创建 IOPlatformUUID 属性键。".to_string());
            }
            let value = IORegistryEntryCreateCFProperty(service, key, ptr::null(), 0);
            CFRelease(key);
            IOObjectRelease(service);
            if value.is_null() {
                return Err("未读取到 IOPlatformUUID。".to_string());
            }
            let copied = CFStringGetCString(
                value,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                UTF8_ENCODING,
            );
            CFRelease(value);
            if !copied {
                return Err("IOPlatformUUID 不是有效 UTF-8 字符串。".to_string());
            }
            CStr::from_ptr(buffer.as_ptr())
                .to_str()
                .map(str::to_owned)
                .map_err(|error| format!("IOPlatformUUID 编码无效: {error}"))
        }
    }
}

#[cfg(target_os = "windows")]
mod hardware {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    pub(super) fn hardware_identifier() -> Result<String, String> {
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
            .map_err(|error| format!("无法打开 MachineGuid 注册表项: {error}"))?;
        key.get_value("MachineGuid")
            .map_err(|error| format!("无法读取 MachineGuid: {error}"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod hardware {
    pub(super) fn hardware_identifier() -> Result<String, String> {
        Err("激活版仅支持 macOS 和 Windows。".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<StoredLicense>>);

    impl CredentialStore for MemoryStore {
        fn load(&self) -> Result<Option<StoredLicense>, String> {
            Ok(self.0.lock().map_err(|error| error.to_string())?.clone())
        }

        fn save(&self, license: &StoredLicense) -> Result<(), String> {
            *self.0.lock().map_err(|error| error.to_string())? = Some(license.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), String> {
            *self.0.lock().map_err(|error| error.to_string())? = None;
            Ok(())
        }
    }

    struct FixedClock(i64);

    impl Clock for FixedClock {
        fn now_unix(&self) -> i64 {
            self.0
        }
    }

    struct FailingStore;

    impl CredentialStore for FailingStore {
        fn load(&self) -> Result<Option<StoredLicense>, String> {
            Err("credential backend unavailable".to_string())
        }

        fn save(&self, _license: &StoredLicense) -> Result<(), String> {
            Err("credential backend unavailable".to_string())
        }

        fn delete(&self) -> Result<(), String> {
            Err("credential backend unavailable".to_string())
        }
    }

    fn signed_lease(payload: LeasePayload) -> (SignedLease, [u8; 32]) {
        let key = SigningKey::from_bytes(&[13_u8; 32]);
        let payload_bytes = serde_json::to_vec(&payload).unwrap();
        let public_key = key.verifying_key().to_bytes();
        (
            SignedLease {
                payload: URL_SAFE_NO_PAD.encode(&payload_bytes),
                signature: URL_SAFE_NO_PAD.encode(key.sign(&payload_bytes).to_bytes()),
            },
            public_key,
        )
    }

    fn payload(device_hash: &str) -> LeasePayload {
        LeasePayload {
            schema_version: 1,
            license_id: "license-test".to_string(),
            product: PRODUCT_ID.to_string(),
            device_hash: device_hash.to_string(),
            generation: 1,
            issued_at: 1_000,
            renew_after: 1_100,
            expires_at: 2_000,
            grace_until: 2_700,
        }
    }

    #[test]
    fn device_hash_is_normalized_and_product_scoped() {
        assert_eq!(device_hash("{ABCD-1234}"), device_hash("  abcd1234  "));
        assert_eq!(device_hash("ABCD-1234").len(), 64);
    }

    #[test]
    fn token_normalization_rejects_invalid_alphabet_and_length() {
        assert_eq!(
            normalize_token("rjm-01234-56789-abcde-fghjk-mnpqr").unwrap(),
            "RJM-01234-56789-ABCDE-FGHJK-MNPQR"
        );
        assert!(normalize_token("RJM-01234-56789-ABCDE-FGHIL-MNPQR").is_err());
        assert!(normalize_token("too-short").is_err());
    }

    #[test]
    fn tampered_signature_and_wrong_device_are_rejected() {
        let (mut lease, public_key) = signed_lease(payload("device-a"));
        lease.signature.replace_range(0..1, "A");
        assert_eq!(
            verify_lease(&lease, "device-a", &public_key)
                .unwrap_err()
                .code,
            "LICENSE_EXPIRED"
        );

        let (lease, public_key) = signed_lease(payload("device-a"));
        assert_eq!(
            verify_lease(&lease, "device-b", &public_key)
                .unwrap_err()
                .code,
            "ALREADY_BOUND"
        );

        let mut wrong_product = payload("device-a");
        wrong_product.product = "another-product".to_string();
        let (lease, public_key) = signed_lease(wrong_product);
        assert_eq!(
            verify_lease(&lease, "device-a", &public_key)
                .unwrap_err()
                .code,
            "LICENSE_EXPIRED"
        );
    }

    #[test]
    fn active_grace_expired_and_clock_rollback_are_distinguished() {
        let device = "device-a".to_string();
        let store = Arc::new(MemoryStore::default());
        let (lease, public_key) = signed_lease(payload(&device));
        store
            .save(&StoredLicense {
                lease,
                max_seen_unix: 1_500,
                last_online_check_unix: 1_000,
                last_renewal_attempt_unix: 1_000,
            })
            .unwrap();

        let active = LicenseManager::with_dependencies(
            device.clone(),
            public_key,
            store.clone(),
            Arc::new(FixedClock(1_800)),
        );
        assert_eq!(active.status().state, LicenseState::Active);

        let grace = LicenseManager::with_dependencies(
            device.clone(),
            public_key,
            store.clone(),
            Arc::new(FixedClock(2_300)),
        );
        assert_eq!(grace.status().state, LicenseState::OfflineGrace);

        let expired = LicenseManager::with_dependencies(
            device.clone(),
            public_key,
            store.clone(),
            Arc::new(FixedClock(2_800)),
        );
        assert_eq!(expired.status().state, LicenseState::Expired);

        store
            .save(&StoredLicense {
                lease: store.load().unwrap().unwrap().lease,
                max_seen_unix: 3_000,
                last_online_check_unix: 1_000,
                last_renewal_attempt_unix: 1_000,
            })
            .unwrap();
        let rollback = LicenseManager::with_dependencies(
            device,
            public_key,
            store,
            Arc::new(FixedClock(1_000)),
        );
        assert_eq!(rollback.status().state, LicenseState::ClockRollback);
    }

    #[test]
    fn missing_or_unavailable_credentials_never_unlock_commands() {
        let device = "device-a".to_string();
        let key = SigningKey::from_bytes(&[13_u8; 32])
            .verifying_key()
            .to_bytes();
        let missing = LicenseManager::with_dependencies(
            device.clone(),
            key,
            Arc::new(MemoryStore::default()),
            Arc::new(FixedClock(1_000)),
        );
        assert_eq!(missing.status().state, LicenseState::NeedsActivation);
        assert!(missing
            .require_active()
            .unwrap_err()
            .starts_with("LICENSE_REQUIRED"));

        let unavailable = LicenseManager::with_dependencies(
            device,
            key,
            Arc::new(FailingStore),
            Arc::new(FixedClock(1_000)),
        );
        assert!(unavailable
            .require_active()
            .unwrap_err()
            .contains("credential backend unavailable"));
    }

    #[test]
    fn renewal_attempts_are_throttled_for_twenty_four_hours() {
        let (lease, _) = signed_lease(payload("device-a"));
        let mut stored = StoredLicense {
            lease,
            max_seen_unix: 1_000,
            last_online_check_unix: 1_000,
            last_renewal_attempt_unix: 1_000,
        };
        let lease_payload = payload("device-a");
        assert!(!renewal_is_due(1_100, &lease_payload, &stored));

        stored.last_renewal_attempt_unix = 100_000;
        assert!(!renewal_is_due(
            100_000 + RENEW_INTERVAL_SECONDS - 1,
            &lease_payload,
            &stored,
        ));
        assert!(renewal_is_due(
            100_000 + RENEW_INTERVAL_SECONDS,
            &lease_payload,
            &stored,
        ));
    }
}
