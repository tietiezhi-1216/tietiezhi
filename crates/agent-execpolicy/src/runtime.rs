use std::path::Path;
use std::sync::Arc;
use std::sync::RwLock;

use tietiezhi_agent_shell_command::bash::parse_shell_lc_plain_commands;
use tietiezhi_agent_shell_command::bash::parse_shell_lc_single_command_prefix;
use tietiezhi_agent_shell_command::is_dangerous_command::dangerous_command_match;
use tietiezhi_agent_shell_command::is_safe_command::is_known_safe_command;
use tietiezhi_agent_shell_command::powershell::parse_powershell_command_into_plain_commands;

use crate::Decision;
use crate::MatchOptions;
use crate::Policy;
use crate::PolicyParser;
use crate::RuleMatch;

const BANNED_PREFIX_SUGGESTIONS: &[&[&str]] = &[
    &["bash"],
    &["bash", "-c"],
    &["bash", "-lc"],
    &["sh"],
    &["sh", "-c"],
    &["sh", "-lc"],
    &["zsh"],
    &["zsh", "-c"],
    &["zsh", "-lc"],
    &["cmd"],
    &["cmd", "/c"],
    &["cmd.exe"],
    &["cmd.exe", "/c"],
    &["powershell"],
    &["powershell", "-Command"],
    &["powershell.exe"],
    &["powershell.exe", "-Command"],
    &["pwsh"],
    &["pwsh", "-Command"],
    &["python"],
    &["python", "-c"],
    &["python3"],
    &["python3", "-c"],
    &["node"],
    &["node", "-e"],
    &["sudo"],
    &["rm"],
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalPolicy {
    Untrusted,
    OnRequest,
    Never,
    Granular { rules: bool, sandbox_approval: bool },
}

#[derive(Debug, Clone, Copy)]
pub struct EvaluationContext {
    pub approval_policy: ApprovalPolicy,
    pub sandbox_restricted: bool,
    pub requests_sandbox_override: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecPolicyOutcome {
    Allow {
        bypass_sandbox: bool,
        proposed_amendment: Option<Vec<String>>,
    },
    Prompt {
        reason: String,
        proposed_amendment: Option<Vec<String>>,
    },
    Forbidden {
        reason: String,
    },
}

#[derive(Clone)]
pub struct ExecPolicyRuntime {
    policy: Arc<RwLock<Policy>>,
}

impl Default for ExecPolicyRuntime {
    fn default() -> Self {
        Self::new(Policy::empty())
    }
}

impl ExecPolicyRuntime {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy: Arc::new(RwLock::new(policy)),
        }
    }

    pub fn parse(identifier: &str, source: &str) -> crate::Result<Self> {
        let mut parser = PolicyParser::new();
        parser.parse(identifier, source)?;
        Ok(Self::new(parser.build()))
    }

    pub fn load_files(paths: impl IntoIterator<Item = impl AsRef<Path>>) -> crate::Result<Self> {
        let mut parser = PolicyParser::new();
        for path in paths {
            let path = path.as_ref();
            let source = std::fs::read_to_string(path).map_err(|error| {
                crate::Error::InvalidRule(format!("failed to read {}: {error}", path.display()))
            })?;
            parser.parse(&path.to_string_lossy(), &source)?;
        }
        Ok(Self::new(parser.build()))
    }

    pub fn add_allow_prefix(&self, prefix: &[String]) -> crate::Result<()> {
        self.policy
            .write()
            .expect("exec policy lock poisoned")
            .add_prefix_rule(prefix, Decision::Allow)
    }

    pub fn merge(&self, overlay: &Policy) {
        let mut policy = self.policy.write().expect("exec policy lock poisoned");
        *policy = policy.merge_overlay(overlay);
    }

    pub fn policy(&self) -> Policy {
        self.policy
            .read()
            .expect("exec policy lock poisoned")
            .clone()
    }

    pub fn evaluate(&self, command: &[String], context: EvaluationContext) -> ExecPolicyOutcome {
        let parsed = commands_for_exec_policy(command);
        let policy = self.policy();
        let options = MatchOptions {
            resolve_host_executables: true,
        };
        let fallback =
            |candidate: &[String]| unmatched_decision(candidate, context, parsed.complex);
        let evaluation =
            policy.check_multiple_with_options(parsed.commands.iter(), &fallback, &options);
        let explicit_prompt = evaluation.matched_rules.iter().any(|matched| {
            matches!(matched, RuleMatch::PrefixRuleMatch { .. })
                && matched.decision() == Decision::Prompt
        });
        let explicit_allow_all = parsed.commands.iter().all(|candidate| {
            policy
                .matches_for_command_with_options(candidate, None, &options)
                .iter()
                .any(|matched| matched.decision() == Decision::Allow)
        });
        let proposed_amendment = (!parsed.complex)
            .then(|| proposed_amendment(&evaluation.matched_rules))
            .flatten();

        match evaluation.decision {
            Decision::Allow => ExecPolicyOutcome::Allow {
                bypass_sandbox: explicit_allow_all,
                proposed_amendment,
            },
            Decision::Prompt => {
                let prompts_allowed = match context.approval_policy {
                    ApprovalPolicy::Never => false,
                    ApprovalPolicy::Granular {
                        rules,
                        sandbox_approval,
                    } => {
                        if explicit_prompt {
                            rules
                        } else {
                            sandbox_approval || !context.requests_sandbox_override
                        }
                    }
                    ApprovalPolicy::Untrusted | ApprovalPolicy::OnRequest => true,
                };
                if prompts_allowed {
                    ExecPolicyOutcome::Prompt {
                        reason: prompt_reason(command, &evaluation.matched_rules),
                        proposed_amendment,
                    }
                } else {
                    ExecPolicyOutcome::Forbidden {
                        reason: if explicit_prompt {
                            "approval required by policy rule, but rules approval is disabled"
                                .into()
                        } else {
                            "approval required by policy, but approval policy forbids prompts"
                                .into()
                        },
                    }
                }
            }
            Decision::Forbidden => ExecPolicyOutcome::Forbidden {
                reason: forbidden_reason(command, &evaluation.matched_rules),
            },
        }
    }
}

struct ParsedPolicyCommands {
    commands: Vec<Vec<String>>,
    complex: bool,
}

fn commands_for_exec_policy(command: &[String]) -> ParsedPolicyCommands {
    if let Some(commands) = parse_shell_lc_plain_commands(command)
        && !commands.is_empty()
    {
        return ParsedPolicyCommands {
            commands,
            complex: false,
        };
    }
    if let Some(commands) = parse_powershell_command_into_plain_commands(command)
        && !commands.is_empty()
    {
        return ParsedPolicyCommands {
            commands,
            complex: false,
        };
    }
    if let Some(command) = parse_shell_lc_single_command_prefix(command) {
        return ParsedPolicyCommands {
            commands: vec![command],
            complex: true,
        };
    }
    ParsedPolicyCommands {
        commands: vec![command.to_vec()],
        complex: false,
    }
}

fn unmatched_decision(command: &[String], context: EvaluationContext, complex: bool) -> Decision {
    let dangerous = dangerous_command_match(command).is_some();
    if dangerous {
        return if context.approval_policy == ApprovalPolicy::Never {
            Decision::Forbidden
        } else {
            Decision::Prompt
        };
    }

    match context.approval_policy {
        ApprovalPolicy::Never => Decision::Allow,
        ApprovalPolicy::Untrusted if is_known_safe_command(command) && !complex => Decision::Allow,
        ApprovalPolicy::Untrusted => Decision::Prompt,
        ApprovalPolicy::OnRequest | ApprovalPolicy::Granular { .. } => {
            if context.sandbox_restricted && context.requests_sandbox_override {
                Decision::Prompt
            } else {
                Decision::Allow
            }
        }
    }
}

fn proposed_amendment(matches: &[RuleMatch]) -> Option<Vec<String>> {
    if matches.iter().any(|matched| {
        matches!(matched, RuleMatch::PrefixRuleMatch { .. })
            && matched.decision() == Decision::Prompt
    }) {
        return None;
    }
    let command = matches.iter().find_map(|matched| match matched {
        RuleMatch::HeuristicsRuleMatch {
            command,
            decision: Decision::Prompt,
        } => Some(command.clone()),
        _ => None,
    })?;
    if BANNED_PREFIX_SUGGESTIONS.iter().any(|banned| {
        command.starts_with(&banned.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }) {
        None
    } else {
        Some(command)
    }
}

fn prompt_reason(command: &[String], matches: &[RuleMatch]) -> String {
    let justification = matches.iter().find_map(|matched| match matched {
        RuleMatch::PrefixRuleMatch {
            justification: Some(value),
            decision: Decision::Prompt,
            ..
        } => Some(value.as_str()),
        _ => None,
    });
    justification.map_or_else(
        || format!("command requires approval: {}", render_command(command)),
        ToOwned::to_owned,
    )
}

fn forbidden_reason(command: &[String], matches: &[RuleMatch]) -> String {
    let justification = matches.iter().find_map(|matched| match matched {
        RuleMatch::PrefixRuleMatch {
            justification: Some(value),
            decision: Decision::Forbidden,
            ..
        } => Some(value.as_str()),
        _ => None,
    });
    justification.map_or_else(
        || {
            format!(
                "command is forbidden by policy: {}",
                render_command(command)
            )
        },
        ToOwned::to_owned,
    )
}

fn render_command(command: &[String]) -> String {
    shlex::try_join(command.iter().map(String::as_str))
        .unwrap_or_else(|_| "<command included NUL byte>".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(policy: ApprovalPolicy) -> EvaluationContext {
        EvaluationContext {
            approval_policy: policy,
            sandbox_restricted: true,
            requests_sandbox_override: false,
        }
    }

    #[test]
    fn strictest_rule_wins_across_pipeline() {
        let runtime = ExecPolicyRuntime::parse(
            "test.rules",
            r#"
prefix_rule(pattern = ["git", "status"], decision = "allow")
prefix_rule(pattern = ["curl"], decision = "forbidden", justification = "offline")
"#,
        )
        .unwrap();
        let command = vec![
            "bash".into(),
            "-lc".into(),
            "git status | curl https://example.com".into(),
        ];
        assert_eq!(
            runtime.evaluate(&command, context(ApprovalPolicy::OnRequest)),
            ExecPolicyOutcome::Forbidden {
                reason: "offline".into()
            }
        );
    }

    #[test]
    fn alternatives_and_host_executable_match() {
        let executable = std::env::current_exe().unwrap();
        let executable_name = executable.file_name().unwrap().to_string_lossy();
        let source = format!(
            "host_executable(name = \"{executable_name}\", paths = [\"{}\"])\n\
             prefix_rule(pattern = [\"{executable_name}\", [\"check\", \"test\"]], decision = \"allow\")",
            executable.display()
        );
        let runtime = ExecPolicyRuntime::parse("test.rules", &source).unwrap();
        let command = vec![executable.to_string_lossy().into_owned(), "test".into()];
        assert!(matches!(
            runtime.evaluate(&command, context(ApprovalPolicy::Untrusted)),
            ExecPolicyOutcome::Allow {
                bypass_sandbox: true,
                ..
            }
        ));
    }

    #[test]
    fn quoted_shell_pipeline_is_parsed_without_splitting_arguments() {
        let runtime = ExecPolicyRuntime::parse(
            "test.rules",
            r#"prefix_rule(pattern = ["printf", "a b"], decision = "allow")"#,
        )
        .unwrap();
        let command = vec!["bash".into(), "-lc".into(), "printf 'a b'".into()];
        assert!(matches!(
            runtime.evaluate(&command, context(ApprovalPolicy::Untrusted)),
            ExecPolicyOutcome::Allow { .. }
        ));
    }

    #[test]
    fn never_blocks_dangerous_unmatched_command() {
        let runtime = ExecPolicyRuntime::default();
        let command = vec!["rm".into(), "-rf".into(), "/tmp/example".into()];
        assert!(matches!(
            runtime.evaluate(&command, context(ApprovalPolicy::Never)),
            ExecPolicyOutcome::Forbidden { .. }
        ));
    }

    #[test]
    fn untrusted_allows_read_only_and_prompts_unknown() {
        let runtime = ExecPolicyRuntime::default();
        assert!(matches!(
            runtime.evaluate(
                &["git".into(), "status".into()],
                context(ApprovalPolicy::Untrusted)
            ),
            ExecPolicyOutcome::Allow { .. }
        ));
        assert!(matches!(
            runtime.evaluate(
                &["cargo".into(), "build".into()],
                context(ApprovalPolicy::Untrusted)
            ),
            ExecPolicyOutcome::Prompt { .. }
        ));
    }

    #[test]
    fn broad_shell_prefix_is_never_suggested() {
        let runtime = ExecPolicyRuntime::default();
        let command = vec!["bash".into(), "-lc".into(), "cargo build".into()];
        let outcome = runtime.evaluate(&command, context(ApprovalPolicy::Untrusted));
        assert!(matches!(
            outcome,
            ExecPolicyOutcome::Prompt {
                proposed_amendment: Some(_),
                ..
            }
        ));
        let opaque = vec!["bash".into(), "-lc".into(), "x=$(whoami)".into()];
        assert!(matches!(
            runtime.evaluate(&opaque, context(ApprovalPolicy::Untrusted)),
            ExecPolicyOutcome::Prompt {
                proposed_amendment: None,
                ..
            }
        ));
    }
}
