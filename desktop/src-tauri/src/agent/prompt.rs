use crate::commands::workspace::TaskMode;
use crate::skills::SkillMeta;

/// Built-in default system prompt (opencode-flavored). User settings and
/// per-agent prompts override it; workspace/skills context is always appended.
pub const DEFAULT_SYSTEM_PROMPT: &str = "\
你是铁铁汁（Tietiezhi），一个运行在用户桌面上的智能体助手。

# 工作方式
- 回答默认使用简体中文，除非用户使用其它语言。
- 你可以调用本轮实际提供的工具来读写文件、搜索、抓取网页或执行操作；不同模式的工具不同。需要动手时直接调用可用工具，不要口头描述你\"将要\"做什么。
- 工具的文件路径一律使用相对工作区的路径。
- 修改文件前先用 read_file 确认原文；编辑使用 edit_file 做精确替换。
- 执行有风险的命令前先向用户说明意图。
- 完成任务后简要总结做了什么；出错时如实报告错误内容。

# 输出
- 使用 Markdown。代码引用用代码块并标注语言。
- 保持简洁：直接给结论，再给必要的细节。";

/// Compose the final system prompt: (agent prompt || user override || builtin)
/// + workspace + enabled skills.
pub fn compose(
    base_override: &str,
    agent_prompt: &str,
    workspace: &str,
    skills: &[SkillMeta],
    task_mode: TaskMode,
) -> String {
    let mut prompt = if !agent_prompt.trim().is_empty() {
        agent_prompt.trim().to_string()
    } else if !base_override.trim().is_empty() {
        base_override.trim().to_string()
    } else {
        DEFAULT_SYSTEM_PROMPT.to_string()
    };

    prompt.push_str(&format!(
        "\n\n# 环境\n- 当前执行模式：{}\n- 当前工作区目录：{workspace}\n- Work 与 Code 共享任务上下文，但文件工作区相互隔离；不要假设另一模式中的文件存在于当前目录。",
        task_mode.label()
    ));
    match task_mode {
        TaskMode::Work => prompt.push_str(
            "\n- 这是成果导向的 Work 模式：优先研究、整理资料并生成清晰命名的文档、表格、报告或其它可交付文件。\n- Work 不提供通用终端；使用文件、搜索、Fetch、Skills 或 MCP 完成任务，不要声称运行了命令。\n- 完成时列出生成的成果文件、使用的主要来源，以及仍需用户确认的外部操作。",
        ),
        TaskMode::Code => prompt.push_str(
            "\n- 这是工程交付导向的 Code 模式：先理解仓库，再修改文件，并使用终端、测试或构建验证结果。\n- 完成时列出关键变更文件和实际运行的检查；没有运行验证时必须明确说明。",
        ),
    }

    prompt.push_str(
        "\n\n# 工具执行规则\n\
- 优先使用最专用的工具：读写和修改文本用 read_file、write_file、edit_file，检索用 glob、grep；不要为了简单文件操作绕到 shell。\n\
- 调用工具后必须检查实际结果。失败后先根据错误换方法，不要用完全相同的参数连续重试；相同调用连续 3 次会触发循环保护并停止任务。\n\
- bash 只运行非交互、会自行结束的前台命令。不要运行等待键盘输入、打开 GUI、watch、开发服务器或常驻守护进程的命令；确需较长时间时显式设置合理的 timeout_ms。\n\
- 使用外部程序前先确认工作区和依赖是否存在。缺少 Python、Excel 等能力时，改用现有工具可真实生成的格式或如实说明，不要反复尝试不存在的命令。\n\
- 不得通过修改扩展名伪造二进制文件。无法真正生成 XLSX 时应生成 Markdown 或 UTF-8 CSV，并明确其真实格式；不得把 HTML 命名为 .xls/.xlsx。\n\
- 只报告实际完成并验证过的操作。工具超时、被取消、输出截断或退出码非零时必须如实说明，不得宣称成功。\n\
- 用户可发送 /context 查看上下文占用，发送 /compact（或 /summarize、/压缩）提前压缩；系统会在 256K 上下文约 80% 时自动压缩。",
    );

    let enabled: Vec<&SkillMeta> = skills.iter().filter(|s| s.enabled).collect();
    prompt.push_str(
        "\n\n# 技能\n技能是用户安装的扩展指令，与读写文件、搜索、命令执行等内置工具能力不同。\n",
    );
    if enabled.is_empty() {
        prompt.push_str("当前没有可供本轮使用的技能。技能可能尚未安装、已被禁用或未分配给当前智能体。不要调用 skill 工具，也不要编造技能名称。询问能力时直接说明可用的内置工具。\n");
    } else {
        prompt.push_str("以下是本轮唯一可用的技能。仅在任务与描述相关时，使用精确名称调用 skill 工具加载完整说明：\n");
        for s in enabled {
            prompt.push_str(&format!("- {}: {}\n", s.name, s.description));
        }
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, enabled: bool) -> SkillMeta {
        SkillMeta {
            name: name.into(),
            description: format!("{name} 描述"),
            enabled,
        }
    }

    #[test]
    fn agent_prompt_wins_over_override_and_default() {
        let p = compose("用户覆盖", "智能体提示词", "/ws", &[], TaskMode::Code);
        assert!(p.starts_with("智能体提示词"));
        let p = compose("用户覆盖", "", "/ws", &[], TaskMode::Code);
        assert!(p.starts_with("用户覆盖"));
        let p = compose("", "", "/ws", &[], TaskMode::Code);
        assert!(p.starts_with("你是铁铁汁"));
    }

    #[test]
    fn skills_only_lists_enabled() {
        let p = compose(
            "",
            "",
            "/ws",
            &[skill("a", true), skill("b", false)],
            TaskMode::Code,
        );
        assert!(p.contains("- a: a 描述"));
        assert!(!p.contains("- b:"));
    }

    #[test]
    fn empty_skills_are_explicitly_distinguished_from_builtin_tools() {
        let p = compose("", "", "/ws", &[], TaskMode::Code);
        assert!(p.contains("当前没有可供本轮使用的技能"));
        assert!(p.contains("内置工具能力不同"));
        assert!(p.contains("不要调用 skill 工具"));
    }

    #[test]
    fn task_mode_is_always_part_of_the_environment_contract() {
        let p = compose("", "", "/ws", &[], TaskMode::Work);
        assert!(p.contains("当前执行模式：Work"));
        assert!(p.contains("文件工作区相互隔离"));
        assert!(p.contains("Work 不提供通用终端"));
    }

    #[test]
    fn execution_rules_survive_custom_prompts() {
        let p = compose("", "自定义智能体", "/ws", &[], TaskMode::Code);
        assert!(p.contains("相同调用连续 3 次"));
        assert!(p.contains("不得通过修改扩展名伪造二进制文件"));
        assert!(p.contains("/compact"));
    }
}
