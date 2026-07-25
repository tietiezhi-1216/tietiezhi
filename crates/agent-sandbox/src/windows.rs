// Source-adapted from OpenAI Codex rust-v0.145.0
// codex-rs/windows-sandbox-rs/{acl,cap,process,token,wrapper}.rs.
#![allow(unsafe_op_in_unsafe_fn)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_SUCCESS, GetLastError, HANDLE, HLOCAL, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    EXPLICIT_ACCESS_W, GRANT_ACCESS, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    AdjustTokenPrivileges, CreateRestrictedToken, CreateWellKnownSid, DACL_SECURITY_INFORMATION,
    DISABLE_MAX_PRIVILEGE, EqualSid, GetAce, GetAclInformation, LUID_AND_ATTRIBUTES,
    LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED, SID_AND_ATTRIBUTES, SetTokenInformation,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenDefaultDacl, WRITE_RESTRICTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, GetCurrentProcess,
    GetExitCodeProcess, INFINITE, OpenProcessToken, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOW, WaitForSingleObject,
};

use super::{
    PROTECTED_METADATA_NAMES, SandboxError, SandboxPolicy, WindowsWorldWritableAudit,
    materialize_writable_roots, normalize_absolute,
};

const WRAPPER_ARG: &str = "--tietiezhi-windows-sandbox";
const LUA_TOKEN: u32 = 0x04;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const SE_FILE_OBJECT: i32 = 1;
const SET_ACCESS: i32 = 2;
const DENY_ACCESS: i32 = 3;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const GENERIC_WRITE_MASK: u32 = 0x4000_0000;
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static PREPARED_AUDITS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
struct WindowsSandboxRequest {
    command: Vec<String>,
    cwd: PathBuf,
    #[serde(default, skip_serializing)]
    env: HashMap<String, String>,
    policy: SandboxPolicy,
    #[serde(default)]
    prepared: bool,
}

pub(super) fn wrap_command(
    command: Vec<String>,
    cwd: &Path,
    _env: &HashMap<String, String>,
    policy: &SandboxPolicy,
) -> Result<Vec<String>, SandboxError> {
    let run_audit = should_run_audit(cwd, _env, policy);
    if let Err(error) = prepare_access(cwd, _env, policy, run_audit) {
        if run_audit {
            clear_prepared_audits();
        }
        return Err(SandboxError::InvalidPolicy(error));
    }
    let executable = if cfg!(debug_assertions) {
        std::env::var_os("TIETIEZHI_WINDOWS_SANDBOX_WRAPPER")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(std::env::current_exe)
    } else {
        std::env::current_exe()
    }
    .map_err(|error| SandboxError::InvalidPolicy(error.to_string()))?;
    let request = WindowsSandboxRequest {
        command,
        cwd: normalize_absolute(cwd)?,
        env: HashMap::new(),
        policy: policy.clone(),
        prepared: true,
    };
    let path = request_path();
    let bytes = serde_json::to_vec(&request)
        .map_err(|error| SandboxError::InvalidPolicy(error.to_string()))?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    options
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
        .map_err(|error| SandboxError::InvalidPolicy(error.to_string()))?;
    Ok(vec![
        executable.to_string_lossy().into_owned(),
        WRAPPER_ARG.into(),
        path.to_string_lossy().into_owned(),
    ])
}

pub(super) fn run_wrapper_if_requested() -> bool {
    let mut args = std::env::args_os();
    let _executable = args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new(WRAPPER_ARG)) {
        return false;
    }
    let Some(path) = args.next().map(PathBuf::from) else {
        eprintln!("windows sandbox request path is missing");
        std::process::exit(1);
    };
    let result = fs::read(&path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<WindowsSandboxRequest>(&bytes)
                .map_err(|error| error.to_string())
        })
        .map(|mut request| {
            request.env = std::env::vars().collect();
            request
        });
    let _ = fs::remove_file(&path);
    let exit_code = result.and_then(run_request).unwrap_or_else(|error| {
        eprintln!("windows sandbox failed: {error}");
        1
    });
    std::process::exit(exit_code);
}

fn request_path() -> PathBuf {
    let sequence = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "tietiezhi-sandbox-{}-{sequence}.json",
        std::process::id()
    ))
}

fn run_request(request: WindowsSandboxRequest) -> Result<i32, String> {
    if request.command.is_empty() {
        return Err("sandboxed command must not be empty".into());
    }
    let roots = match &request.policy {
        SandboxPolicy::WorkspaceWrite {
            writable_roots,
            exclude_tmpdir_env_var,
            exclude_slash_tmp,
            ..
        } => materialize_writable_roots(
            writable_roots,
            &request.cwd,
            &request.env,
            *exclude_tmpdir_env_var,
            *exclude_slash_tmp,
        )
        .map_err(|error| error.to_string())?,
        SandboxPolicy::ReadOnly { .. } => Default::default(),
        SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => {
            return run_unrestricted(&request);
        }
    };

    unsafe {
        let sid_strings = capability_sids(&roots, &request.cwd);
        let sids = sid_strings
            .iter()
            .map(|sid| LocalSid::new(sid))
            .collect::<Result<Vec<_>, _>>()?;
        if !request.prepared {
            prepare_access(
                &request.cwd,
                &request.env,
                &request.policy,
                /*run_audit*/ true,
            )?;
        }
        let token =
            create_restricted_token(&sids.iter().map(LocalSid::as_ptr).collect::<Vec<_>>())?;
        let result = spawn_restricted(&request, token);
        CloseHandle(token);
        result
    }
}

fn should_run_audit(cwd: &Path, env: &HashMap<String, String>, policy: &SandboxPolicy) -> bool {
    let key = format!(
        "{}\0{}\0{}\0{}\0{}",
        cwd.to_string_lossy().to_ascii_lowercase(),
        serde_json::to_string(policy).unwrap_or_default(),
        env.get("TEMP").map(String::as_str).unwrap_or_default(),
        env.get("TMP").map(String::as_str).unwrap_or_default(),
        env.get("PATH").map(String::as_str).unwrap_or_default()
    );
    PREPARED_AUDITS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .map(|mut prepared| prepared.insert(key))
        .unwrap_or(true)
}

fn clear_prepared_audits() {
    if let Some(cache) = PREPARED_AUDITS.get()
        && let Ok(mut prepared) = cache.lock()
    {
        prepared.clear();
    }
}

fn capability_sids(roots: &std::collections::BTreeSet<PathBuf>, cwd: &Path) -> Vec<String> {
    if roots.is_empty() {
        vec![capability_sid("readonly", cwd)]
    } else {
        roots
            .iter()
            .map(|root| capability_sid("write", root))
            .collect()
    }
}

fn prepare_access(
    cwd: &Path,
    env: &HashMap<String, String>,
    policy: &SandboxPolicy,
    run_audit: bool,
) -> Result<(), String> {
    let roots = match policy {
        SandboxPolicy::WorkspaceWrite {
            writable_roots,
            exclude_tmpdir_env_var,
            exclude_slash_tmp,
            ..
        } => materialize_writable_roots(
            writable_roots,
            cwd,
            env,
            *exclude_tmpdir_env_var,
            *exclude_slash_tmp,
        )
        .map_err(|error| error.to_string())?,
        SandboxPolicy::ReadOnly { .. } => Default::default(),
        SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. } => {
            return Ok(());
        }
    };
    unsafe {
        let sid_strings = capability_sids(&roots, cwd);
        let sids = sid_strings
            .iter()
            .map(|sid| LocalSid::new(sid))
            .collect::<Result<Vec<_>, _>>()?;
        for (root, sid) in roots.iter().zip(&sids) {
            ensure_write_access(root, sid.as_ptr())?;
            for protected in PROTECTED_METADATA_NAMES {
                let path = root.join(protected);
                if path.exists() {
                    ensure_deny_write(&path, sid.as_ptr())?;
                }
            }
        }
        if run_audit {
            let audit = audit_world_writable(cwd, env);
            for path in &audit.paths {
                if roots.iter().any(|root| path.starts_with(root)) {
                    continue;
                }
                for sid in &sids {
                    ensure_deny_write(path, sid.as_ptr())?;
                }
            }
            hide_user_profile(cwd, env, &roots, &sids)?;
        }
    }
    Ok(())
}

unsafe fn hide_user_profile(
    cwd: &Path,
    env: &HashMap<String, String>,
    writable_roots: &std::collections::BTreeSet<PathBuf>,
    sids: &[LocalSid],
) -> Result<(), String> {
    let Some(profile) = env.get("USERPROFILE").map(PathBuf::from) else {
        return Ok(());
    };
    let Ok(profile) = profile.canonicalize() else {
        return Ok(());
    };
    let mut allowed = vec![normalize_absolute(cwd).map_err(|error| error.to_string())?];
    allowed.extend(writable_roots.iter().cloned());
    if let Some(path) = env.get("PATH") {
        allowed.extend(std::env::split_paths(path).filter_map(|path| path.canonicalize().ok()));
    }
    let entries = fs::read_dir(&profile).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let overlaps_allowed = allowed
            .iter()
            .any(|root| canonical.starts_with(root) || root.starts_with(&canonical));
        if overlaps_allowed {
            continue;
        }
        for sid in sids {
            ensure_deny_read(&path, sid.as_ptr())?;
        }
    }
    Ok(())
}

pub(super) fn audit_world_writable(
    cwd: &Path,
    env: &HashMap<String, String>,
) -> WindowsWorldWritableAudit {
    const MAX_ITEMS_PER_DIR: usize = 1000;
    const MAX_CHECKED: usize = 50_000;
    let started = std::time::Instant::now();
    let deadline = std::time::Duration::from_secs(2);
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |path: PathBuf| {
        if let Ok(path) = path.canonicalize() {
            let key = path.to_string_lossy().to_ascii_lowercase();
            if seen.insert(key) {
                candidates.push(path);
            }
        }
    };
    push(cwd.to_path_buf());
    for name in ["TEMP", "TMP", "USERPROFILE", "PUBLIC"] {
        if let Some(value) = env.get(name) {
            push(PathBuf::from(value));
        }
    }
    if let Some(path) = env.get("PATH") {
        for entry in std::env::split_paths(path) {
            push(entry);
        }
    }
    let system_drive = env
        .get("SystemDrive")
        .cloned()
        .unwrap_or_else(|| "C:".into());
    push(PathBuf::from(format!("{system_drive}\\")));
    push(PathBuf::from(format!("{system_drive}\\Windows")));

    let Ok(mut world) = (unsafe { world_sid() }) else {
        return WindowsWorldWritableAudit {
            paths: Vec::new(),
            failed_scan: true,
        };
    };
    let world = world.as_mut_ptr() as *mut c_void;
    let mut flagged = Vec::new();
    let mut checked = 0;
    let mut failed_scan = false;
    for root in candidates {
        if started.elapsed() > deadline || checked >= MAX_CHECKED {
            failed_scan = true;
            break;
        }
        checked += 1;
        match unsafe { path_has_world_write(&root, world) } {
            Ok(true) => flagged.push(root.clone()),
            Ok(false) => {}
            Err(_) => failed_scan = true,
        }
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten().take(MAX_ITEMS_PER_DIR) {
                if started.elapsed() > deadline || checked >= MAX_CHECKED {
                    failed_scan = true;
                    break;
                }
                let Ok(file_type) = entry.file_type() else {
                    failed_scan = true;
                    continue;
                };
                if !file_type.is_dir() || file_type.is_symlink() {
                    continue;
                }
                checked += 1;
                let path = entry.path();
                match unsafe { path_has_world_write(&path, world) } {
                    Ok(true) => flagged.push(path),
                    Ok(false) => {}
                    Err(_) => failed_scan = true,
                }
            }
        }
    }
    flagged.sort();
    flagged.dedup();
    WindowsWorldWritableAudit {
        paths: flagged,
        failed_scan,
    }
}

unsafe fn world_sid() -> Result<Vec<u8>, String> {
    const WIN_WORLD_SID: i32 = 1;
    let mut size = 0;
    CreateWellKnownSid(
        WIN_WORLD_SID,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut size,
    );
    let mut bytes = vec![0; size as usize];
    if CreateWellKnownSid(
        WIN_WORLD_SID,
        std::ptr::null_mut(),
        bytes.as_mut_ptr() as *mut c_void,
        &mut size,
    ) == 0
    {
        return Err(format!("CreateWellKnownSid failed: {}", GetLastError()));
    }
    Ok(bytes)
}

unsafe fn path_has_world_write(path: &Path, world: *mut c_void) -> Result<bool, String> {
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;

    let mut acl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let code = GetNamedSecurityInfoW(
        to_wide(path.as_os_str()).as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut acl,
        std::ptr::null_mut(),
        &mut descriptor,
    );
    if code != ERROR_SUCCESS {
        return Err(format!("GetNamedSecurityInfoW failed: {code}"));
    }
    if acl.is_null() {
        LocalFree(descriptor as HLOCAL);
        return Ok(true);
    }
    let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
    if GetAclInformation(
        acl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
        AclSizeInformation,
    ) == 0
    {
        LocalFree(descriptor as HLOCAL);
        return Err(format!("GetAclInformation failed: {}", GetLastError()));
    }
    let write_mask = FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | DELETE
        | GENERIC_WRITE_MASK;
    let mut writable = false;
    for index in 0..info.AceCount {
        let mut ace = std::ptr::null_mut();
        if GetAce(acl, index, &mut ace) == 0 {
            continue;
        }
        let header = &*(ace as *const ACE_HEADER);
        if header.AceType != 0 {
            continue;
        }
        let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
        let sid = (ace as usize + std::mem::size_of::<ACE_HEADER>() + std::mem::size_of::<u32>())
            as *mut c_void;
        if EqualSid(sid, world) != 0 && allowed.Mask & write_mask != 0 {
            writable = true;
            break;
        }
    }
    LocalFree(descriptor as HLOCAL);
    Ok(writable)
}

fn run_unrestricted(request: &WindowsSandboxRequest) -> Result<i32, String> {
    let status = std::process::Command::new(&request.command[0])
        .args(&request.command[1..])
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.env)
        .status()
        .map_err(|error| error.to_string())?;
    Ok(status.code().unwrap_or(1))
}

fn capability_sid(kind: &str, path: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(b"tietiezhi-windows-sandbox-v1\0");
    hash.update(kind.as_bytes());
    hash.update(b"\0");
    hash.update(path.to_string_lossy().to_lowercase().as_bytes());
    let digest = hash.finalize();
    let value =
        |offset| u32::from_le_bytes(digest[offset..offset + 4].try_into().expect("four bytes"));
    format!(
        "S-1-5-21-{}-{}-{}-{}",
        value(0),
        value(4),
        value(8),
        value(12)
    )
}

struct LocalSid(*mut c_void);

impl LocalSid {
    unsafe fn new(value: &str) -> Result<Self, String> {
        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn ConvertStringSidToSidW(value: *const u16, sid: *mut *mut c_void) -> i32;
        }
        let mut sid = std::ptr::null_mut();
        if ConvertStringSidToSidW(to_wide(value).as_ptr(), &mut sid) == 0 {
            return Err(format!("ConvertStringSidToSidW failed: {}", GetLastError()));
        }
        Ok(Self(sid))
    }

    fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }
}

unsafe fn create_restricted_token(sids: &[*mut c_void]) -> Result<HANDLE, String> {
    let desired = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut base = 0;
    if OpenProcessToken(GetCurrentProcess(), desired, &mut base) == 0 {
        return Err(format!("OpenProcessToken failed: {}", GetLastError()));
    }
    let mut entries = sids
        .iter()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: *sid,
            Attributes: 0,
        })
        .collect::<Vec<_>>();
    let mut token = 0;
    let ok = CreateRestrictedToken(
        base,
        DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
        0,
        std::ptr::null(),
        0,
        std::ptr::null(),
        entries.len() as u32,
        entries.as_mut_ptr(),
        &mut token,
    );
    CloseHandle(base);
    if ok == 0 {
        return Err(format!("CreateRestrictedToken failed: {}", GetLastError()));
    }
    if let Err(error) = set_default_dacl(token, sids) {
        CloseHandle(token);
        return Err(error);
    }
    if let Err(error) = enable_change_notify(token) {
        CloseHandle(token);
        return Err(error);
    }
    Ok(token)
}

#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

unsafe fn set_default_dacl(token: HANDLE, sids: &[*mut c_void]) -> Result<(), String> {
    let entries = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: 0x1000_0000,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: trustee(*sid),
        })
        .collect::<Vec<_>>();
    let mut acl = std::ptr::null_mut();
    let code = SetEntriesInAclW(
        entries.len() as u32,
        entries.as_ptr(),
        std::ptr::null_mut(),
        &mut acl,
    );
    if code != ERROR_SUCCESS {
        return Err(format!("SetEntriesInAclW(default) failed: {code}"));
    }
    let mut info = TokenDefaultDaclInfo { default_dacl: acl };
    let ok = SetTokenInformation(
        token,
        TokenDefaultDacl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
    );
    LocalFree(acl as HLOCAL);
    if ok == 0 {
        return Err(format!(
            "SetTokenInformation(TokenDefaultDacl) failed: {}",
            GetLastError()
        ));
    }
    Ok(())
}

unsafe fn enable_change_notify(token: HANDLE) -> Result<(), String> {
    let mut luid = std::mem::zeroed();
    if LookupPrivilegeValueW(
        std::ptr::null(),
        to_wide("SeChangeNotifyPrivilege").as_ptr(),
        &mut luid,
    ) == 0
    {
        return Err(format!("LookupPrivilegeValueW failed: {}", GetLastError()));
    }
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    if AdjustTokenPrivileges(
        token,
        0,
        &privileges,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    ) == 0
    {
        return Err(format!("AdjustTokenPrivileges failed: {}", GetLastError()));
    }
    Ok(())
}

unsafe fn ensure_write_access(path: &Path, sid: *mut c_void) -> Result<(), String> {
    update_acl(
        path,
        sid,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD,
        SET_ACCESS,
    )
}

unsafe fn ensure_deny_write(path: &Path, sid: *mut c_void) -> Result<(), String> {
    update_acl(
        path,
        sid,
        FILE_GENERIC_WRITE
            | FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_EA
            | FILE_WRITE_ATTRIBUTES
            | DELETE
            | FILE_DELETE_CHILD,
        DENY_ACCESS,
    )
}

unsafe fn ensure_deny_read(path: &Path, sid: *mut c_void) -> Result<(), String> {
    update_acl(path, sid, FILE_GENERIC_READ, DENY_ACCESS)
}

unsafe fn update_acl(path: &Path, sid: *mut c_void, mask: u32, mode: i32) -> Result<(), String> {
    use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;

    let wide = to_wide(path.as_os_str());
    let mut old_acl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let code = GetNamedSecurityInfoW(
        wide.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut old_acl,
        std::ptr::null_mut(),
        &mut descriptor,
    );
    if code != ERROR_SUCCESS {
        return Err(format!(
            "GetNamedSecurityInfoW failed for {}: {code}",
            path.display()
        ));
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
        Trustee: trustee(sid),
    };
    let mut new_acl = std::ptr::null_mut();
    let merge = SetEntriesInAclW(1, &entry, old_acl, &mut new_acl);
    if merge != ERROR_SUCCESS {
        LocalFree(descriptor as HLOCAL);
        return Err(format!("SetEntriesInAclW failed: {merge}"));
    }
    let set = SetNamedSecurityInfoW(
        wide.as_ptr() as *mut u16,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        new_acl,
        std::ptr::null_mut(),
    );
    LocalFree(new_acl as HLOCAL);
    LocalFree(descriptor as HLOCAL);
    if set != ERROR_SUCCESS {
        return Err(format!(
            "SetNamedSecurityInfoW failed for {}: {set}",
            path.display()
        ));
    }
    Ok(())
}

fn trustee(sid: *mut c_void) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: 0,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid as *mut u16,
    }
}

unsafe fn spawn_restricted(request: &WindowsSandboxRequest, token: HANDLE) -> Result<i32, String> {
    let mut command_line = to_wide(argv_to_command_line(&request.command));
    let mut environment = environment_block(&request.env);
    let cwd = to_wide(request.cwd.as_os_str());
    let mut startup: STARTUPINFOW = std::mem::zeroed();
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    let mut process: PROCESS_INFORMATION = std::mem::zeroed();
    let created = CreateProcessAsUserW(
        token,
        std::ptr::null(),
        command_line.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        1,
        CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
        environment.as_mut_ptr() as *mut c_void,
        cwd.as_ptr(),
        &startup,
        &mut process,
    );
    if created == 0 {
        return Err(format!("CreateProcessAsUserW failed: {}", GetLastError()));
    }
    let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
    if job == 0 {
        terminate_and_close(&process);
        return Err(format!("CreateJobObjectW failed: {}", GetLastError()));
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &mut limits as *mut _ as *mut c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    ) == 0
        || AssignProcessToJobObject(job, process.hProcess) == 0
    {
        let error = GetLastError();
        CloseHandle(job);
        terminate_and_close(&process);
        return Err(format!("configure sandbox Job Object failed: {error}"));
    }
    if ResumeThread(process.hThread) == u32::MAX {
        let error = GetLastError();
        CloseHandle(job);
        terminate_and_close(&process);
        return Err(format!("ResumeThread failed: {error}"));
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    let mut exit_code = 1;
    if GetExitCodeProcess(process.hProcess, &mut exit_code) == 0 {
        exit_code = 1;
    }
    CloseHandle(process.hProcess);
    CloseHandle(job);
    Ok(exit_code as i32)
}

unsafe fn terminate_and_close(process: &PROCESS_INFORMATION) {
    use windows_sys::Win32::System::Threading::TerminateProcess;
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
}

fn environment_block(env: &HashMap<String, String>) -> Vec<u16> {
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

fn argv_to_command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| quote_windows_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => slashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(slashes * 2 + 1));
                quoted.push('"');
                slashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(slashes));
                slashes = 0;
                quoted.push(ch);
            }
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

fn to_wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_matches_command_line_rules() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg("two words"), "\"two words\"");
        assert_eq!(quote_windows_arg("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn capability_sids_are_stable_and_path_scoped() {
        let first = capability_sid("write", Path::new(r"C:\Workspace"));
        let equivalent = capability_sid("write", Path::new(r"c:\workspace"));
        let other = capability_sid("write", Path::new(r"C:\Other"));
        assert_eq!(first, equivalent);
        assert_ne!(first, other);
    }

    #[test]
    fn restricted_token_enforces_workspace_acl_and_job() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let allowed = workspace.path().join("allowed.txt");
        let denied = outside.path().join("denied.txt");
        let request = WindowsSandboxRequest {
            command: vec![
                "cmd.exe".into(),
                "/d".into(),
                "/s".into(),
                "/c".into(),
                format!(
                    "(echo ok>\"{}\") && (echo no>\"{}\" 2>nul || exit /b 0)",
                    allowed.display(),
                    denied.display()
                ),
            ],
            cwd: workspace.path().to_path_buf(),
            env: std::env::vars().collect(),
            policy: SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![workspace.path().to_path_buf()],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            prepared: false,
        };
        let code = run_request(request).unwrap();
        assert_eq!(code, 0);
        assert!(allowed.exists());
        assert!(!denied.exists());
    }

    #[test]
    fn read_only_denies_workspace_write() {
        let workspace = tempfile::tempdir().unwrap();
        let denied = workspace.path().join("denied.txt");
        let request = WindowsSandboxRequest {
            command: vec![
                "cmd.exe".into(),
                "/d".into(),
                "/s".into(),
                "/c".into(),
                format!("echo no>\"{}\"", denied.display()),
            ],
            cwd: workspace.path().to_path_buf(),
            env: std::env::vars().collect(),
            policy: SandboxPolicy::ReadOnly {
                network_access: false,
            },
            prepared: false,
        };
        let _ = run_request(request).unwrap();
        assert!(!denied.exists());
    }

    #[test]
    fn protected_metadata_and_junction_escape_are_denied() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let junction = workspace.path().join("escape");
        let status = std::process::Command::new("cmd.exe")
            .args([
                "/d",
                "/s",
                "/c",
                &format!(
                    "mklink /J \"{}\" \"{}\"",
                    junction.display(),
                    outside.path().display()
                ),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let normal = workspace.path().join("normal.txt");
        let metadata = workspace.path().join(".git/config");
        let escaped = junction.join("escaped.txt");
        let request = WindowsSandboxRequest {
            command: vec![
                "cmd.exe".into(),
                "/d".into(),
                "/s".into(),
                "/c".into(),
                format!(
                    "echo ok>\"{}\" & (echo no>\"{}\" 2>nul) & (echo no>\"{}\" 2>nul) & exit /b 0",
                    normal.display(),
                    metadata.display(),
                    escaped.display()
                ),
            ],
            cwd: workspace.path().to_path_buf(),
            env: std::env::vars().collect(),
            policy: SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![workspace.path().to_path_buf()],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            prepared: false,
        };
        assert_eq!(run_request(request).unwrap(), 0);
        assert!(normal.exists());
        assert!(!metadata.exists());
        assert!(!escaped.exists());
    }

    #[test]
    fn original_user_profile_siblings_are_hidden() {
        let profile = tempfile::tempdir().unwrap();
        let workspace = profile.path().join("workspace");
        let secret_dir = profile.path().join("secrets");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&secret_dir).unwrap();
        let secret = secret_dir.join("token.txt");
        fs::write(&secret, "private").unwrap();
        let copied = workspace.join("copied.txt");
        let mut env = std::env::vars().collect::<HashMap<_, _>>();
        env.insert(
            "USERPROFILE".into(),
            profile.path().to_string_lossy().into_owned(),
        );
        let request = WindowsSandboxRequest {
            command: vec![
                "cmd.exe".into(),
                "/d".into(),
                "/s".into(),
                "/c".into(),
                format!(
                    "type \"{}\" > \"{}\" 2>nul",
                    secret.display(),
                    copied.display()
                ),
            ],
            cwd: workspace.clone(),
            env,
            policy: SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![workspace],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            prepared: false,
        };
        let _ = run_request(request).unwrap();
        assert!(!copied.exists());
    }

    #[test]
    fn job_object_kills_descendants_when_wrapper_finishes() {
        let workspace = tempfile::tempdir().unwrap();
        let marker = workspace.path().join("survived.txt");
        let child_script = format!(
            "Start-Sleep -Seconds 2; Set-Content -LiteralPath '{}' -Value survived",
            marker.display().to_string().replace('\'', "''")
        );
        let request = WindowsSandboxRequest {
            command: vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-Command".into(),
                format!(
                    "Start-Process powershell.exe -ArgumentList @('-NoProfile','-Command',{}) -WindowStyle Hidden",
                    powershell_literal(&child_script)
                ),
            ],
            cwd: workspace.path().to_path_buf(),
            env: std::env::vars().collect(),
            policy: SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![workspace.path().to_path_buf()],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            prepared: false,
        };
        assert_eq!(run_request(request).unwrap(), 0);
        std::thread::sleep(std::time::Duration::from_secs(3));
        assert!(!marker.exists(), "sandbox descendant survived Job close");
    }

    fn powershell_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }
}
