// Source-adapted from OpenAI Codex rust-v0.145.0
// codex-rs/windows-sandbox-rs/{setup,identity,dpapi,wfp}.rs.
#![allow(unsafe_op_in_unsafe_fn)]

mod firewall;
mod wfp;

use super::windows::quote_windows_arg;
use std::ffi::{OsStr, c_void};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rand::rngs::SmallRng;
use rand::{RngCore, SeedableRng};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, ERROR_INSUFFICIENT_BUFFER, GetLastError, HLOCAL, LocalFree,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::NetworkManagement::NetManagement::{
    LOCALGROUP_INFO_1, LOCALGROUP_MEMBERS_INFO_3, NERR_Success, NetLocalGroupAdd,
    NetLocalGroupAddMembers, NetUserAdd, NetUserSetInfo, UF_DONT_EXPIRE_PASSWD, UF_SCRIPT,
    USER_INFO_1, USER_INFO_1003, USER_PRIV_USER,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    CryptUnprotectData,
};
use windows_sys::Win32::Security::{
    AllocateAndInitializeSid, CheckTokenMembership, FreeSid, LookupAccountNameW,
    SECURITY_NT_AUTHORITY, SID_NAME_USE,
};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    REPLACEFILE_IGNORE_MERGE_ERRORS, ReplaceFileW,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessWithLogonW, GetExitCodeProcess, INFINITE,
    LOGON_WITH_PROFILE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    WaitForSingleObject,
};
use windows_sys::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// Bumped when provisioning changes in a way that invalidates an existing
/// marker (v2 renamed the sandbox accounts to fit the SAM length limit).
const SETUP_VERSION: u32 = 2;
const SETUP_ARG: &str = "--tietiezhi-windows-sandbox-setup";
const LAUNCH_ARG: &str = "--tietiezhi-windows-sandbox-launch";
const INLINE_ARG: &str = "--tietiezhi-windows-sandbox-inline";
const INLINE_ENV: &str = "TIETIEZHI_WINDOWS_SANDBOX_REQUEST";
const OFFLINE_USERNAME: &str = "TietiezhiSbxOffline";
const ONLINE_USERNAME: &str = "TietiezhiSbxOnline";
const USERS_GROUP: &str = "TietiezhiSandboxUsers";

/// Windows caps local (SAM) account names at 20 characters. A longer name
/// makes `NetUserAdd` fail with `NERR_BadUsername` (2202), which took down
/// the whole sandbox provisioning. Group names allow up to 256, so only the
/// user names are constrained here.
const MAX_LOCAL_USERNAME_LEN: usize = 20;

/// Upper bound for the elevated provisioning helper (users, firewall, WFP).
const ELEVATED_SETUP_TIMEOUT_MS: u32 = 180_000;
const _: () = assert!(OFFLINE_USERNAME.len() <= MAX_LOCAL_USERNAME_LEN);
const _: () = assert!(ONLINE_USERNAME.len() <= MAX_LOCAL_USERNAME_LEN);
const USERS_GROUP_COMMENT: &str = "Tietiezhi sandbox internal group (managed)";
const SECURITY_BUILTIN_DOMAIN_RID: u32 = 0x20;
const DOMAIN_ALIAS_RID_ADMINS: u32 = 0x220;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupErrorCode {
    ComInitFailed,
    PolicyAccessFailed,
    PolicyIneffective,
    RuleCreateOrAddFailed,
    RuleVerifyFailed,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SetupFailure {
    pub code: SetupErrorCode,
    pub message: String,
}

impl SetupFailure {
    pub fn new(code: SetupErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SetupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for SetupFailure {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupMarker {
    pub version: u32,
    pub offline_username: String,
    pub online_username: String,
    pub offline_sid: String,
    pub online_sid: String,
    pub proxy_ports: Vec<u16>,
    pub allow_local_binding: bool,
    pub firewall_configured: bool,
    pub wfp_filter_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SandboxUserRecord {
    username: String,
    encrypted_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SandboxUsersFile {
    version: u32,
    offline: SandboxUserRecord,
    online: SandboxUserRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    version: u32,
    home: PathBuf,
    proxy_ports: Vec<u16>,
    allow_local_binding: bool,
}

#[derive(Debug, Clone)]
pub struct SandboxCredentials {
    pub username: String,
    pub password: String,
}

pub fn default_home() -> PathBuf {
    if let Some(home) = std::env::var_os("TIETIEZHI_WINDOWS_SANDBOX_HOME") {
        return PathBuf::from(home);
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Tietiezhi")
        .join("agent-runtime")
        .join("windows-sandbox")
}

pub fn readiness() -> &'static str {
    match load_marker(&default_home()) {
        Ok(Some(marker))
            if marker.version == SETUP_VERSION
                && marker.firewall_configured
                && marker.wfp_filter_count > 0
                && users_path(&default_home()).is_file() =>
        {
            "ready"
        }
        Ok(Some(_)) => "updateRequired",
        _ => "notConfigured",
    }
}

pub fn ensure_ready(proxy_ports: &[u16], allow_local_binding: bool) -> Result<()> {
    let home = default_home();
    let existing = load_marker(&home)?;
    let mut desired_ports = proxy_ports
        .iter()
        .copied()
        .filter(|port| *port != 0)
        .collect::<Vec<_>>();
    desired_ports.sort_unstable();
    desired_ports.dedup();
    if desired_ports.is_empty()
        && let Some(marker) = existing.as_ref()
        && marker.version == SETUP_VERSION
    {
        desired_ports.clone_from(&marker.proxy_ports);
    }
    if let Some(marker) = existing
        && marker.version == SETUP_VERSION
        && marker.proxy_ports == desired_ports
        && marker.allow_local_binding == allow_local_binding
        && marker.firewall_configured
        && marker.wfp_filter_count > 0
        && users_path(&home).is_file()
    {
        return Ok(());
    }
    run_elevated_setup(&SetupRequest {
        version: SETUP_VERSION,
        home,
        proxy_ports: desired_ports,
        allow_local_binding,
    })
}

pub fn run_setup_for_current_process(proxy_ports: &[u16], allow_local_binding: bool) -> Result<()> {
    let request = SetupRequest {
        version: SETUP_VERSION,
        home: default_home(),
        proxy_ports: proxy_ports.to_vec(),
        allow_local_binding,
    };
    if is_elevated()? {
        run_setup(request)
    } else {
        run_elevated_setup(&request)
    }
}

pub fn run_helper_if_requested() -> bool {
    let mut args = std::env::args_os();
    let _ = args.next();
    match args.next().as_deref().and_then(OsStr::to_str) {
        Some(SETUP_ARG) => {
            let result = args
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or_else(|| anyhow!("Windows sandbox setup payload is missing"))
                .and_then(|encoded| {
                    let bytes = BASE64_STANDARD
                        .decode(encoded)
                        .context("decode Windows sandbox setup payload")?;
                    let request = serde_json::from_slice::<SetupRequest>(&bytes)
                        .context("parse Windows sandbox setup payload")?;
                    run_setup(request)
                });
            if let Err(error) = result {
                eprintln!("Windows sandbox setup failed: {error:#}");
                std::process::exit(1);
            }
            std::process::exit(0);
        }
        Some(LAUNCH_ARG) => {
            let result = args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| anyhow!("Windows sandbox launch request path is missing"))
                .and_then(|path| launch_as_sandbox_user(&path));
            let code = result.unwrap_or_else(|error| {
                eprintln!("Windows sandbox identity launch failed: {error:#}");
                1
            });
            std::process::exit(code);
        }
        Some(INLINE_ARG) => false,
        _ => false,
    }
}

pub fn launcher_command(request_path: &Path) -> Result<Vec<String>> {
    let executable = helper_executable().context("locate Windows sandbox launcher")?;
    Ok(vec![
        executable.to_string_lossy().into_owned(),
        LAUNCH_ARG.into(),
        request_path.to_string_lossy().into_owned(),
    ])
}

pub fn inline_request() -> Result<Option<Vec<u8>>> {
    let mut args = std::env::args_os();
    let _ = args.next();
    if args.next().as_deref() != Some(OsStr::new(INLINE_ARG)) {
        return Ok(None);
    }
    let encoded = std::env::var(INLINE_ENV).context("inline sandbox request is missing")?;
    BASE64_STANDARD
        .decode(encoded)
        .context("decode inline sandbox request")
        .map(Some)
}

fn run_elevated_setup(request: &SetupRequest) -> Result<()> {
    if is_elevated()? {
        return run_setup(request.clone());
    }
    fs::create_dir_all(&request.home)
        .with_context(|| format!("create sandbox home {}", request.home.display()))?;
    let payload = BASE64_STANDARD.encode(serde_json::to_vec(request)?);
    let executable = helper_executable().context("locate setup helper")?;
    let verb = to_wide("runas");
    let file = to_wide(executable.as_os_str());
    let parameters = to_wide(format!(
        "{} {}",
        quote_windows_arg(SETUP_ARG),
        quote_windows_arg(&payload)
    ));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_CANCELLED {
            return Err(anyhow!("Windows sandbox setup elevation was canceled"));
        }
        return Err(anyhow!("ShellExecuteExW(runas) failed: {error}"));
    }
    // Provisioning is bounded work. Waiting forever on the elevated helper
    // means a stalled helper hangs the caller with no way out, so give up
    // with a clear error instead.
    let waited = unsafe { WaitForSingleObject(info.hProcess, ELEVATED_SETUP_TIMEOUT_MS) };
    if waited == WAIT_TIMEOUT {
        unsafe { CloseHandle(info.hProcess) };
        return Err(anyhow!(
            "elevated Windows sandbox setup did not finish within {}s",
            ELEVATED_SETUP_TIMEOUT_MS / 1_000
        ));
    }
    let mut exit_code = 1;
    unsafe {
        GetExitCodeProcess(info.hProcess, &mut exit_code);
        CloseHandle(info.hProcess);
    }
    if exit_code != 0 {
        return Err(anyhow!(
            "elevated Windows sandbox setup exited with code {exit_code}"
        ));
    }
    let marker = load_marker(&request.home)?
        .ok_or_else(|| anyhow!("elevated setup completed without a setup marker"))?;
    if marker.version != SETUP_VERSION {
        return Err(anyhow!("elevated setup marker version mismatch"));
    }
    Ok(())
}

fn run_setup(mut request: SetupRequest) -> Result<()> {
    if request.version != SETUP_VERSION {
        return Err(anyhow!(
            "Windows sandbox setup version mismatch: expected {SETUP_VERSION}, got {}",
            request.version
        ));
    }
    if !is_elevated()? {
        return Err(anyhow!("Windows sandbox setup helper is not elevated"));
    }
    request.proxy_ports.retain(|port| *port != 0);
    request.proxy_ports.sort_unstable();
    request.proxy_ports.dedup();
    fs::create_dir_all(&request.home)
        .with_context(|| format!("create sandbox home {}", request.home.display()))?;
    let log_path = request.home.join("setup.log");
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("open {}", log_path.display()))?;
    writeln!(
        log,
        "starting Windows sandbox setup version={SETUP_VERSION}"
    )?;
    let offline_password = random_password();
    let online_password = random_password();
    ensure_local_group(USERS_GROUP, USERS_GROUP_COMMENT)?;
    ensure_local_user(OFFLINE_USERNAME, &offline_password)?;
    ensure_local_user(ONLINE_USERNAME, &online_password)?;
    ensure_local_group_member(USERS_GROUP, OFFLINE_USERNAME)?;
    ensure_local_group_member(USERS_GROUP, ONLINE_USERNAME)?;
    let offline_sid = resolve_sid_string(OFFLINE_USERNAME)?;
    let online_sid = resolve_sid_string(ONLINE_USERNAME)?;
    firewall::ensure_offline_proxy_allowlist(
        &offline_sid,
        &request.proxy_ports,
        request.allow_local_binding,
        &mut log,
    )?;
    firewall::ensure_offline_outbound_block(&offline_sid, &mut log)?;
    let wfp_filter_count = wfp::install_wfp_filters_for_account(OFFLINE_USERNAME)?;
    let users = SandboxUsersFile {
        version: SETUP_VERSION,
        offline: SandboxUserRecord {
            username: OFFLINE_USERNAME.into(),
            encrypted_password: BASE64_STANDARD.encode(protect(offline_password.as_bytes())?),
        },
        online: SandboxUserRecord {
            username: ONLINE_USERNAME.into(),
            encrypted_password: BASE64_STANDARD.encode(protect(online_password.as_bytes())?),
        },
    };
    atomic_write(
        &users_path(&request.home),
        &serde_json::to_vec_pretty(&users)?,
    )?;
    let marker = SetupMarker {
        version: SETUP_VERSION,
        offline_username: OFFLINE_USERNAME.into(),
        online_username: ONLINE_USERNAME.into(),
        offline_sid,
        online_sid,
        proxy_ports: request.proxy_ports,
        allow_local_binding: request.allow_local_binding,
        firewall_configured: true,
        wfp_filter_count,
    };
    atomic_write(
        &marker_path(&request.home),
        &serde_json::to_vec_pretty(&marker)?,
    )?;
    writeln!(
        log,
        "Windows sandbox setup completed firewall=true wfpFilters={wfp_filter_count}"
    )?;
    Ok(())
}

fn launch_as_sandbox_user(request_path: &Path) -> Result<i32> {
    let request_bytes = fs::read(request_path)
        .with_context(|| format!("read sandbox request {}", request_path.display()))?;
    let request: super::windows::WindowsSandboxRequest =
        serde_json::from_slice(&request_bytes).context("decode sandbox request")?;
    let _ = fs::remove_file(request_path);
    let use_offline = !request.policy.network_access()
        || !super::managed_proxy_ports(&std::env::vars().collect()).is_empty();
    let credentials = credentials(use_offline)?;
    let executable = helper_executable().context("locate sandbox wrapper")?;
    let command_line = format!(
        "{} {}",
        quote_windows_arg(&executable.to_string_lossy()),
        quote_windows_arg(INLINE_ARG)
    );
    let mut command_line = to_wide(command_line);
    let executable_w = to_wide(executable.as_os_str());
    let cwd = to_wide(request.cwd.as_os_str());
    let username = to_wide(&credentials.username);
    let domain = to_wide(".");
    let password = to_wide(&credentials.password);
    let mut environment = std::env::vars().collect::<std::collections::HashMap<_, _>>();
    environment.insert(INLINE_ENV.into(), BASE64_STANDARD.encode(request_bytes));
    let mut environment = environment_block(&environment);
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessWithLogonW(
            username.as_ptr(),
            domain.as_ptr(),
            password.as_ptr(),
            LOGON_WITH_PROFILE,
            executable_w.as_ptr(),
            command_line.as_mut_ptr(),
            CREATE_UNICODE_ENVIRONMENT,
            environment.as_mut_ptr() as *const c_void,
            cwd.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(anyhow!("CreateProcessWithLogonW failed: {}", unsafe {
            GetLastError()
        }));
    }
    unsafe {
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
    }
    let mut exit_code = 1;
    unsafe {
        GetExitCodeProcess(process.hProcess, &mut exit_code);
        CloseHandle(process.hProcess);
    }
    Ok(exit_code as i32)
}

fn credentials(offline: bool) -> Result<SandboxCredentials> {
    let home = default_home();
    let users = serde_json::from_slice::<SandboxUsersFile>(
        &fs::read(users_path(&home)).context("read Windows sandbox credentials")?,
    )
    .context("decode Windows sandbox credentials")?;
    if users.version != SETUP_VERSION {
        return Err(anyhow!("Windows sandbox credentials require setup update"));
    }
    let record = if offline { users.offline } else { users.online };
    let encrypted = BASE64_STANDARD
        .decode(record.encrypted_password)
        .context("decode encrypted sandbox password")?;
    let password =
        String::from_utf8(unprotect(&encrypted)?).context("sandbox password is not UTF-8")?;
    Ok(SandboxCredentials {
        username: record.username,
        password,
    })
}

pub fn identity_sids() -> Result<Vec<String>> {
    let marker = load_marker(&default_home())?
        .ok_or_else(|| anyhow!("Windows sandbox setup marker is missing"))?;
    if marker.version != SETUP_VERSION {
        return Err(anyhow!("Windows sandbox setup marker requires update"));
    }
    Ok(vec![marker.offline_sid, marker.online_sid])
}

fn helper_executable() -> std::io::Result<PathBuf> {
    if cfg!(debug_assertions)
        && let Some(path) = std::env::var_os("TIETIEZHI_WINDOWS_SANDBOX_WRAPPER")
    {
        return Ok(PathBuf::from(path));
    }
    std::env::current_exe()
}

fn is_elevated() -> Result<bool> {
    unsafe {
        let mut administrators_group: *mut c_void = std::ptr::null_mut();
        if AllocateAndInitializeSid(
            &SECURITY_NT_AUTHORITY,
            2,
            SECURITY_BUILTIN_DOMAIN_RID,
            DOMAIN_ALIAS_RID_ADMINS,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut administrators_group,
        ) == 0
        {
            return Err(anyhow!(
                "AllocateAndInitializeSid failed: {}",
                GetLastError()
            ));
        }
        let mut member = 0;
        let checked = CheckTokenMembership(0, administrators_group, &mut member);
        FreeSid(administrators_group);
        if checked == 0 {
            return Err(anyhow!("CheckTokenMembership failed: {}", GetLastError()));
        }
        Ok(member != 0)
    }
}

fn ensure_local_group(name: &str, comment: &str) -> Result<()> {
    const ERROR_ALIAS_EXISTS: u32 = 1379;
    const NERR_GROUP_EXISTS: u32 = 2223;
    let name = to_wide(name);
    let comment = to_wide(comment);
    let info = LOCALGROUP_INFO_1 {
        lgrpi1_name: name.as_ptr() as *mut u16,
        lgrpi1_comment: comment.as_ptr() as *mut u16,
    };
    let mut parameter_error = 0;
    let status = unsafe {
        NetLocalGroupAdd(
            std::ptr::null(),
            1,
            &info as *const _ as *mut u8,
            &mut parameter_error,
        )
    };
    if ![NERR_Success, ERROR_ALIAS_EXISTS, NERR_GROUP_EXISTS].contains(&status) {
        return Err(anyhow!(
            "NetLocalGroupAdd failed: status={status}, parameter={parameter_error}"
        ));
    }
    Ok(())
}

fn ensure_local_user(username: &str, password: &str) -> Result<()> {
    let name = to_wide(username);
    let password = to_wide(password);
    let info = USER_INFO_1 {
        usri1_name: name.as_ptr() as *mut u16,
        usri1_password: password.as_ptr() as *mut u16,
        usri1_password_age: 0,
        usri1_priv: USER_PRIV_USER,
        usri1_home_dir: std::ptr::null_mut(),
        usri1_comment: std::ptr::null_mut(),
        usri1_flags: UF_SCRIPT | UF_DONT_EXPIRE_PASSWD,
        usri1_script_path: std::ptr::null_mut(),
    };
    let status = unsafe {
        NetUserAdd(
            std::ptr::null(),
            1,
            &info as *const _ as *mut u8,
            std::ptr::null_mut(),
        )
    };
    if status == NERR_Success {
        return Ok(());
    }
    let password_info = USER_INFO_1003 {
        usri1003_password: password.as_ptr() as *mut u16,
    };
    let updated = unsafe {
        NetUserSetInfo(
            std::ptr::null(),
            name.as_ptr(),
            1003,
            &password_info as *const _ as *mut u8,
            std::ptr::null_mut(),
        )
    };
    if updated != NERR_Success {
        // NERR_BadUsername(2202) here almost always means the name exceeds the
        // 20-character SAM limit; ERROR_ACCESS_DENIED(5) means not elevated.
        return Err(anyhow!(
            "create/update sandbox user {username:?} failed: NetUserAdd={status}, NetUserSetInfo={updated}"
        ));
    }
    Ok(())
}

fn ensure_local_group_member(group: &str, member: &str) -> Result<()> {
    let group = to_wide(group);
    let member = to_wide(member);
    let info = LOCALGROUP_MEMBERS_INFO_3 {
        lgrmi3_domainandname: member.as_ptr() as *mut u16,
    };
    unsafe {
        let _ = NetLocalGroupAddMembers(
            std::ptr::null(),
            group.as_ptr(),
            3,
            &info as *const _ as *mut u8,
            1,
        );
    }
    Ok(())
}

fn resolve_sid_string(account: &str) -> Result<String> {
    let account = to_wide(account);
    let mut sid = vec![0u8; 68];
    let mut sid_len = sid.len() as u32;
    let mut domain = Vec::<u16>::new();
    let mut domain_len = 0;
    let mut use_type: SID_NAME_USE = 0;
    loop {
        let ok = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account.as_ptr(),
                sid.as_mut_ptr() as *mut c_void,
                &mut sid_len,
                domain.as_mut_ptr(),
                &mut domain_len,
                &mut use_type,
            )
        };
        if ok != 0 {
            break;
        }
        let error = unsafe { GetLastError() };
        if error != ERROR_INSUFFICIENT_BUFFER {
            return Err(anyhow!("LookupAccountNameW failed: {error}"));
        }
        sid.resize(sid_len as usize, 0);
        domain.resize(domain_len as usize, 0);
    }
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid.as_ptr() as *mut c_void, &mut text) } == 0 {
        return Err(anyhow!("ConvertSidToStringSidW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut len = 0;
    unsafe {
        while *text.add(len) != 0 {
            len += 1;
        }
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe {
        LocalFree(text as HLOCAL);
    }
    Ok(result)
}

fn random_password() -> String {
    const CHARS: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";
    let mut bytes = [0u8; 28];
    SmallRng::from_entropy().fill_bytes(&mut bytes);
    let mut password = String::from("Aa1!");
    password.extend(
        bytes
            .iter()
            .map(|byte| CHARS[*byte as usize % CHARS.len()] as char),
    );
    password
}

fn protect(data: &[u8]) -> Result<Vec<u8>> {
    crypt(data, true)
}

fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    crypt(data, false)
}

fn crypt(data: &[u8], protect: bool) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let flags = CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE;
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                flags,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                flags,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(anyhow!("Windows DPAPI operation failed: {}", unsafe {
            GetLastError()
        }));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as HLOCAL);
    }
    Ok(bytes)
}

fn marker_path(home: &Path) -> PathBuf {
    home.join("setup-marker.json")
}

fn users_path(home: &Path) -> PathBuf {
    home.join("sandbox-users.json")
}

fn load_marker(home: &Path) -> Result<Option<SetupMarker>> {
    match fs::read(marker_path(home)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .context("decode Windows sandbox setup marker")
            .map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("state path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)?;
    let temporary_w = to_wide(temporary.as_os_str());
    let path_w = to_wide(path.as_os_str());
    let moved = unsafe {
        if path.exists() {
            ReplaceFileW(
                path_w.as_ptr(),
                temporary_w.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_IGNORE_MERGE_ERRORS,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                temporary_w.as_ptr(),
                path_w.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if moved == 0 {
        let error = unsafe { GetLastError() };
        let _ = fs::remove_file(&temporary);
        return Err(anyhow!("atomic Windows state replacement failed: {error}"));
    }
    Ok(())
}

fn environment_block(env: &std::collections::HashMap<String, String>) -> Vec<u16> {
    let mut entries = env.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(name, _)| name.to_uppercase());
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(format!("{name}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

pub(super) fn to_wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_marker_roundtrips_proxy_scope() {
        let marker = SetupMarker {
            version: SETUP_VERSION,
            offline_username: OFFLINE_USERNAME.into(),
            online_username: ONLINE_USERNAME.into(),
            offline_sid: "S-1-5-21-1".into(),
            online_sid: "S-1-5-21-2".into(),
            proxy_ports: vec![1080, 3128],
            allow_local_binding: false,
            firewall_configured: true,
            wfp_filter_count: 12,
        };
        assert_eq!(
            serde_json::from_slice::<SetupMarker>(&serde_json::to_vec(&marker).unwrap()).unwrap(),
            marker
        );
    }

    #[test]
    fn generated_password_has_required_entropy_and_classes() {
        let password = random_password();
        assert_eq!(password.len(), 32);
        assert!(password.bytes().any(|value| value.is_ascii_uppercase()));
        assert!(password.bytes().any(|value| value.is_ascii_lowercase()));
        assert!(password.bytes().any(|value| value.is_ascii_digit()));
    }
}
