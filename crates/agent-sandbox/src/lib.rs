//! Source-native OS sandbox policy and command transformation.
//!
//! The macOS Seatbelt policy layout follows OpenAI Codex `rust-v0.145.0`.
//! Windows enforcement is added by R16 through the same `SandboxPolicy` API.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
const SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";
#[cfg(target_os = "macos")]
const SEATBELT_BASE_POLICY: &str = include_str!("policies/seatbelt_base_policy.sbpl");
#[cfg(target_os = "macos")]
const SEATBELT_NETWORK_POLICY: &str = include_str!("policies/seatbelt_network_policy.sbpl");
const PROTECTED_METADATA_NAMES: [&str; 3] = [".git", ".agents", ".codex"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SandboxPolicy {
    DangerFullAccess,
    ReadOnly {
        #[serde(default)]
        network_access: bool,
    },
    ExternalSandbox {
        #[serde(default = "restricted_network")]
        network_access: String,
    },
    WorkspaceWrite {
        #[serde(default)]
        writable_roots: Vec<PathBuf>,
        #[serde(default)]
        network_access: bool,
        #[serde(default)]
        exclude_tmpdir_env_var: bool,
        #[serde(default)]
        exclude_slash_tmp: bool,
    },
}

fn restricted_network() -> String {
    "restricted".into()
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        Self::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        }
    }
}

impl SandboxPolicy {
    pub fn from_value(value: Value) -> Result<Self, SandboxError> {
        serde_json::from_value(value)
            .map_err(|error| SandboxError::InvalidPolicy(error.to_string()))
    }

    pub fn is_restricted(&self) -> bool {
        matches!(self, Self::ReadOnly { .. } | Self::WorkspaceWrite { .. })
    }

    pub fn network_access(&self) -> bool {
        match self {
            Self::ReadOnly { network_access } | Self::WorkspaceWrite { network_access, .. } => {
                *network_access
            }
            Self::DangerFullAccess => true,
            Self::ExternalSandbox { network_access } => network_access == "enabled",
        }
    }

    pub fn with_additional_permissions(
        &self,
        permissions: &Value,
        cwd: &Path,
    ) -> Result<Self, SandboxError> {
        let mut policy = self.clone();
        let Some(permissions) = permissions.as_object() else {
            return Err(SandboxError::InvalidPolicy(
                "additional permissions must be an object".into(),
            ));
        };
        let network = permissions
            .get("network")
            .and_then(Value::as_object)
            .and_then(|network| network.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let write_roots = permissions
            .get("file_system")
            .or_else(|| permissions.get("fileSystem"))
            .and_then(Value::as_object)
            .and_then(|file_system| file_system.get("write"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|path| {
                let path = PathBuf::from(path);
                if path.is_absolute() {
                    path
                } else {
                    cwd.join(path)
                }
            })
            .collect::<Vec<_>>();
        match &mut policy {
            Self::WorkspaceWrite {
                writable_roots,
                network_access,
                ..
            } => {
                writable_roots.extend(write_roots);
                *network_access |= network;
            }
            Self::ReadOnly { .. } => {
                if write_roots.is_empty() {
                    if let Self::ReadOnly { network_access } = &mut policy {
                        *network_access |= network;
                    }
                } else {
                    policy = Self::WorkspaceWrite {
                        writable_roots: write_roots,
                        network_access: network,
                        exclude_tmpdir_env_var: true,
                        exclude_slash_tmp: true,
                    };
                }
            }
            Self::DangerFullAccess | Self::ExternalSandbox { .. } => {}
        }
        Ok(policy)
    }

    pub fn can_write_path(
        &self,
        path: &Path,
        cwd: &Path,
        inherited_env: &std::collections::HashMap<String, String>,
    ) -> Result<bool, SandboxError> {
        match self {
            Self::DangerFullAccess | Self::ExternalSandbox { .. } => Ok(true),
            Self::ReadOnly { .. } => Ok(false),
            Self::WorkspaceWrite {
                writable_roots,
                exclude_tmpdir_env_var,
                exclude_slash_tmp,
                ..
            } => {
                let target = if path.is_absolute() {
                    normalize_absolute(path)?
                } else {
                    normalize_absolute(&cwd.join(path))?
                };
                for root in materialize_writable_roots(
                    writable_roots,
                    cwd,
                    inherited_env,
                    *exclude_tmpdir_env_var,
                    *exclude_slash_tmp,
                )? {
                    if !target.starts_with(&root) {
                        continue;
                    }
                    let protected = PROTECTED_METADATA_NAMES
                        .iter()
                        .any(|name| target.starts_with(root.join(name)));
                    if !protected {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxInvocation {
    pub command: Vec<String>,
    pub applied: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowsWorldWritableAudit {
    pub paths: Vec<PathBuf>,
    pub failed_scan: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("sandbox command must not be empty")]
    EmptyCommand,
    #[error("invalid sandbox policy: {0}")]
    InvalidPolicy(String),
    #[error("sandbox path must be absolute: {0}")]
    RelativePath(PathBuf),
    #[error("macOS Seatbelt is unavailable: {0}")]
    SeatbeltUnavailable(PathBuf),
    #[error("restricted sandbox is not implemented on this platform")]
    UnsupportedPlatform,
}

pub fn sandbox_command(
    command: Vec<String>,
    cwd: &Path,
    inherited_env: &std::collections::HashMap<String, String>,
    policy: &SandboxPolicy,
) -> Result<SandboxInvocation, SandboxError> {
    if command.is_empty() {
        return Err(SandboxError::EmptyCommand);
    }
    if matches!(
        policy,
        SandboxPolicy::DangerFullAccess | SandboxPolicy::ExternalSandbox { .. }
    ) {
        return Ok(SandboxInvocation {
            command,
            applied: false,
        });
    }
    #[cfg(target_os = "macos")]
    {
        let command = seatbelt_command(command, cwd, inherited_env, policy)?;
        Ok(SandboxInvocation {
            command,
            applied: true,
        })
    }
    #[cfg(windows)]
    {
        let command = windows::wrap_command(command, cwd, inherited_env, policy)?;
        Ok(SandboxInvocation {
            command,
            applied: true,
        })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (cwd, inherited_env);
        Err(SandboxError::UnsupportedPlatform)
    }
}

/// Handles the source-built Windows sandbox wrapper before the desktop runtime starts.
///
/// Returns `false` for normal launches. A wrapper launch exits the process after
/// forwarding the restricted child's exit code and therefore never returns.
pub fn run_windows_sandbox_wrapper_if_requested() -> bool {
    #[cfg(windows)]
    {
        windows::run_wrapper_if_requested()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn audit_windows_world_writable(
    cwd: &Path,
    inherited_env: &std::collections::HashMap<String, String>,
) -> WindowsWorldWritableAudit {
    #[cfg(windows)]
    {
        windows::audit_world_writable(cwd, inherited_env)
    }
    #[cfg(not(windows))]
    {
        let _ = (cwd, inherited_env);
        WindowsWorldWritableAudit::default()
    }
}

#[cfg(target_os = "macos")]
fn seatbelt_command(
    command: Vec<String>,
    cwd: &Path,
    inherited_env: &std::collections::HashMap<String, String>,
    policy: &SandboxPolicy,
) -> Result<Vec<String>, SandboxError> {
    let executable = PathBuf::from(SEATBELT_EXECUTABLE);
    if !executable.is_file() {
        return Err(SandboxError::SeatbeltUnavailable(executable));
    }
    let cwd = normalize_absolute(cwd)?;
    let mut writable_roots = BTreeSet::new();
    let mut network_access = false;
    if let SandboxPolicy::WorkspaceWrite {
        writable_roots: configured,
        network_access: enabled,
        exclude_tmpdir_env_var,
        exclude_slash_tmp,
    } = policy
    {
        network_access = *enabled;
        writable_roots = materialize_writable_roots(
            configured,
            &cwd,
            inherited_env,
            *exclude_tmpdir_env_var,
            *exclude_slash_tmp,
        )?;
    } else if let SandboxPolicy::ReadOnly {
        network_access: enabled,
    } = policy
    {
        network_access = *enabled;
    }

    let mut policy_sections = vec![
        SEATBELT_BASE_POLICY.to_string(),
        "; allow read-only file operations\n(allow file-read*)".into(),
        build_write_policy(&writable_roots),
    ];
    if network_access {
        policy_sections.push(
            "(allow network-outbound)\n(allow network-inbound)\n".to_string()
                + SEATBELT_NETWORK_POLICY,
        );
    }
    let full_policy = policy_sections.join("\n");

    let mut args = vec![SEATBELT_EXECUTABLE.into(), "-p".into(), full_policy];
    for (index, root) in writable_roots.iter().enumerate() {
        args.push(format!("-DWRITABLE_ROOT_{index}={}", root.display()));
        for (protected_index, name) in PROTECTED_METADATA_NAMES.iter().enumerate() {
            args.push(format!(
                "-DPROTECTED_{index}_{protected_index}={}",
                root.join(name).display()
            ));
        }
    }
    args.push("--".into());
    args.extend(command);
    Ok(args)
}

#[cfg(target_os = "macos")]
fn build_write_policy(roots: &BTreeSet<PathBuf>) -> String {
    roots
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let exclusions = PROTECTED_METADATA_NAMES
                .iter()
                .enumerate()
                .flat_map(|(protected_index, _)| {
                    [
                        format!(
                            "(require-not (literal (param \"PROTECTED_{index}_{protected_index}\")))"
                        ),
                        format!(
                            "(require-not (subpath (param \"PROTECTED_{index}_{protected_index}\")))"
                        ),
                    ]
                })
                .collect::<Vec<_>>()
                .join("\n    ");
            format!(
                "(allow file-write*\n  (require-all\n    (subpath (param \"WRITABLE_ROOT_{index}\"))\n    {exclusions}))"
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn materialize_writable_roots(
    configured: &[PathBuf],
    cwd: &Path,
    inherited_env: &std::collections::HashMap<String, String>,
    exclude_tmpdir_env_var: bool,
    exclude_slash_tmp: bool,
) -> Result<BTreeSet<PathBuf>, SandboxError> {
    let mut roots = BTreeSet::new();
    if configured.is_empty() {
        roots.insert(normalize_absolute(cwd)?);
    } else {
        for root in configured {
            let absolute = if root.is_absolute() {
                root.clone()
            } else {
                cwd.join(root)
            };
            roots.insert(normalize_absolute(&absolute)?);
        }
    }
    if !exclude_tmpdir_env_var
        && let Some(tmpdir) = inherited_env.get("TMPDIR")
        && Path::new(tmpdir).is_absolute()
    {
        roots.insert(normalize_absolute(Path::new(tmpdir))?);
    }
    if !exclude_slash_tmp {
        for root in ["/tmp", "/private/tmp"] {
            roots.insert(normalize_absolute(Path::new(root))?);
        }
    }
    Ok(roots)
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, SandboxError> {
    if !path.is_absolute() {
        return Err(SandboxError::RelativePath(path.to_path_buf()));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
        }
    }
    if let Ok(canonical) = normalized.canonicalize() {
        return Ok(canonical);
    }

    let mut existing = normalized.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = existing.parent() else {
            break;
        };
        existing = parent;
    }
    let mut canonical = existing
        .canonicalize()
        .map_err(|error| SandboxError::InvalidPolicy(error.to_string()))?;
    for component in suffix.into_iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

#[cfg(test)]
fn default_env() -> std::collections::HashMap<String, String> {
    std::env::vars().collect()
}

#[cfg(test)]
fn workspace_policy(root: &Path) -> SandboxPolicy {
    SandboxPolicy::WorkspaceWrite {
        writable_roots: vec![root.to_path_buf()],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
    }
}

#[cfg(test)]
fn read_only_policy() -> SandboxPolicy {
    SandboxPolicy::ReadOnly {
        network_access: false,
    }
}

#[cfg(test)]
mod path_policy_tests {
    use super::*;

    #[test]
    fn network_only_permission_does_not_grant_workspace_write() {
        let policy = read_only_policy()
            .with_additional_permissions(
                &serde_json::json!({"network":{"enabled":true}}),
                Path::new("/tmp/project"),
            )
            .unwrap();
        assert_eq!(
            policy,
            SandboxPolicy::ReadOnly {
                network_access: true
            }
        );
    }

    #[test]
    fn writable_path_check_rejects_metadata_and_parent_escape() {
        let root = tempfile::tempdir().unwrap();
        let policy = workspace_policy(root.path());
        let env = default_env();
        assert!(
            policy
                .can_write_path(&root.path().join("src/new.rs"), root.path(), &env)
                .unwrap()
        );
        assert!(
            !policy
                .can_write_path(&root.path().join(".git/config"), root.path(), &env)
                .unwrap()
        );
        assert!(
            !policy
                .can_write_path(&root.path().join("../outside"), root.path(), &env)
                .unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_path_check_resolves_existing_symlink_parent() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        let policy = workspace_policy(root.path());
        assert!(
            !policy
                .can_write_path(
                    &root.path().join("escape/new.txt"),
                    root.path(),
                    &default_env(),
                )
                .unwrap()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn v2_policies_parse_with_codex_defaults() {
        assert_eq!(
            SandboxPolicy::from_value(serde_json::json!({"type":"readOnly"})).unwrap(),
            SandboxPolicy::ReadOnly {
                network_access: false
            }
        );
        assert_eq!(
            SandboxPolicy::from_value(serde_json::json!({"type":"workspaceWrite"})).unwrap(),
            SandboxPolicy::default()
        );
        assert!(
            !SandboxPolicy::from_value(serde_json::json!({"type":"externalSandbox"}))
                .unwrap()
                .is_restricted()
        );
    }

    #[test]
    fn full_access_and_external_do_not_wrap_commands() {
        for policy in [
            SandboxPolicy::DangerFullAccess,
            SandboxPolicy::ExternalSandbox {
                network_access: "restricted".into(),
            },
        ] {
            let invocation = sandbox_command(
                vec!["tool".into(), "arg".into()],
                Path::new("/"),
                &HashMap::new(),
                &policy,
            )
            .unwrap();
            assert_eq!(invocation.command, ["tool", "arg"]);
            assert!(!invocation.applied);
        }
    }

    #[test]
    fn additional_permissions_extend_only_the_requested_surface() {
        let policy = SandboxPolicy::ReadOnly {
            network_access: false,
        }
        .with_additional_permissions(
            &serde_json::json!({
                "file_system":{"write":["generated"]},
                "network":{"enabled":true}
            }),
            Path::new("/tmp/project"),
        )
        .unwrap();
        assert_eq!(
            policy,
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from("/tmp/project/generated")],
                network_access: true,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            }
        );
    }

    #[cfg(target_os = "macos")]
    fn run(
        policy: SandboxPolicy,
        cwd: &Path,
        script: &str,
        args: &[&Path],
    ) -> std::process::Output {
        let mut command = vec![
            "/bin/sh".into(),
            "-c".into(),
            script.into(),
            "sandbox".into(),
        ];
        command.extend(args.iter().map(|path| path.to_string_lossy().into_owned()));
        let invocation =
            sandbox_command(command, cwd, &std::env::vars().collect(), &policy).unwrap();
        std::process::Command::new(&invocation.command[0])
            .args(&invocation.command[1..])
            .current_dir(cwd)
            .output()
            .unwrap()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_write_allows_root_and_denies_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let allowed = root.path().join("allowed");
        let denied = outside.path().join("denied");
        let output = run(
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![root.path().to_path_buf()],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            root.path(),
            "printf ok > \"$1\"; printf no > \"$2\"",
            &[&allowed, &denied],
        );
        assert!(!output.status.success());
        assert_eq!(std::fs::read_to_string(allowed).unwrap(), "ok");
        assert!(!denied.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn read_only_and_protected_metadata_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let normal = root.path().join("normal");
        let protected = root.path().join(".git/config");
        let read_only = root.path().join("read-only");
        assert!(
            !run(
                SandboxPolicy::ReadOnly {
                    network_access: false
                },
                root.path(),
                "printf no > \"$1\"",
                &[&read_only],
            )
            .status
            .success()
        );
        let output = run(
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![root.path().to_path_buf()],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            root.path(),
            "printf ok > \"$1\"; printf no > \"$2\"",
            &[&normal, &protected],
        );
        assert!(!output.status.success());
        assert_eq!(std::fs::read_to_string(normal).unwrap(), "ok");
        assert!(!protected.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn symlink_escape_and_tmp_exclusion_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        let escaped = root.path().join("escape/denied");
        let temp_target = PathBuf::from(format!(
            "/tmp/tietiezhi-seatbelt-denied-{}",
            std::process::id()
        ));
        let output = run(
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![root.path().to_path_buf()],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
            },
            root.path(),
            "printf no > \"$1\"; printf no > \"$2\"",
            &[&escaped, &temp_target],
        );
        assert!(!output.status.success());
        assert!(!escaped.exists());
        assert!(!temp_target.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn network_switch_controls_outbound_connections() {
        use std::net::TcpListener;
        use std::time::Duration;

        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        let denied = run(
            SandboxPolicy::ReadOnly {
                network_access: false,
            },
            root.path(),
            "/usr/bin/nc -z -w 1 127.0.0.1 \"$1\"",
            &[Path::new(&port)],
        );
        assert!(!denied.status.success());
        listener.set_nonblocking(true).unwrap();
        let allowed = run(
            SandboxPolicy::ReadOnly {
                network_access: true,
            },
            root.path(),
            "/usr/bin/nc -z -w 1 127.0.0.1 \"$1\"",
            &[Path::new(&port)],
        );
        assert!(allowed.status.success(), "{allowed:?}");
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok(_) => return,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("{error}"),
            }
        }
        panic!("enabled sandbox did not connect to loopback listener");
    }
}
