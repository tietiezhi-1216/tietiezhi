use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tietiezhi_agent_git::{ExecutionEnvironment, WorkspaceRuntime};
use uuid::Uuid;

use super::model::{AutomationDocument, AutomationRun, AutomationRunStatus, MissedSchedulePolicy};
use super::store;
use crate::AppState;

const SCHEDULER_POLL: Duration = Duration::from_secs(30);
const COMPLETION_POLL: Duration = Duration::from_millis(250);
const MISSED_GRACE_MS: u64 = 90_000;

pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = recover_incomplete_runs(&app) {
            eprintln!("[automation] recover: {error}");
        }
        loop {
            if let Err(error) = tick(&app).await {
                eprintln!("[automation] scheduler: {error}");
            }
            tokio::time::sleep(SCHEDULER_POLL).await;
        }
    });
}

pub fn publish(app: &AppHandle, id: &str) -> Result<super::AutomationMeta, String> {
    let document = store::load(app, id)?;
    let next = next_schedule_ms(&document, now_ms())?.unwrap_or_default();
    store::publish(app, id, next)
}

pub fn set_paused(
    app: &AppHandle,
    id: &str,
    paused: bool,
) -> Result<super::AutomationMeta, String> {
    let next = if paused {
        0
    } else {
        let document = store::load_published(app, id)?;
        next_schedule_ms(&document, now_ms())?.unwrap_or_default()
    };
    store::set_paused(app, id, paused, next)
}

pub async fn start_run(
    app: &AppHandle,
    automation_id: &str,
    trigger: &str,
    input: Value,
) -> Result<AutomationRun, String> {
    let document = store::load_published(app, automation_id)?;
    let running = store::list_runs(app, Some(automation_id), 500)?
        .into_iter()
        .filter(|run| {
            matches!(
                run.status,
                AutomationRunStatus::Queued | AutomationRunStatus::Running
            )
        })
        .count();
    if running >= usize::try_from(document.settings.max_concurrency).unwrap_or(usize::MAX) {
        return Err(format!(
            "Automation 已达到最大并发数 {}",
            document.settings.max_concurrency
        ));
    }
    let run_id = Uuid::new_v4().to_string();
    let started_at = now_ms();
    let planned_workspace = store::run_workspace_path(app, &document.id, &run_id)?;
    let mut run = AutomationRun {
        id: run_id.clone(),
        automation_id: automation_id.into(),
        revision: document.revision,
        trigger: trigger.into(),
        status: AutomationRunStatus::Queued,
        input,
        thread_id: String::new(),
        turn_id: String::new(),
        workspace_path: planned_workspace.to_string_lossy().into_owned(),
        started_at,
        finished_at: 0,
        output: None,
        error: None,
    };
    store::save_run(app, &run)?;
    let workspace = match prepare_workspace(app, &document, &run_id) {
        Ok(workspace) => workspace,
        Err(error) => {
            store::finish_run(
                app,
                automation_id,
                &run_id,
                AutomationRunStatus::Failed,
                None,
                Some(error.clone()),
            )?;
            return Err(error);
        }
    };
    run.workspace_path = workspace.to_string_lossy().into_owned();
    let prompt = match execution_prompt(&document, trigger, &run.input) {
        Ok(prompt) => prompt,
        Err(error) => {
            store::finish_run(
                app,
                automation_id,
                &run_id,
                AutomationRunStatus::Failed,
                None,
                Some(error.clone()),
            )?;
            return Err(error);
        }
    };
    let (thread_id, turn_id) = match crate::commands::codex::launch_automation_turn(
        app,
        &app.state::<AppState>(),
        &run_id,
        &workspace,
        prompt,
    ) {
        Ok(ids) => ids,
        Err(error) => {
            store::finish_run(
                app,
                automation_id,
                &run_id,
                AutomationRunStatus::Failed,
                None,
                Some(error.clone()),
            )?;
            return Err(error);
        }
    };
    run.status = AutomationRunStatus::Running;
    run.thread_id = thread_id.clone();
    run.turn_id = turn_id.clone();
    store::save_run(app, &run)?;
    monitor_run(
        app.clone(),
        run.clone(),
        Duration::from_millis(document.settings.max_duration_ms),
    );
    Ok(run)
}

fn recover_incomplete_runs(app: &AppHandle) -> Result<(), String> {
    for run in store::list_runs(app, None, 500)?.into_iter().filter(|run| {
        matches!(
            run.status,
            AutomationRunStatus::Queued | AutomationRunStatus::Running
        )
    }) {
        if !run.thread_id.is_empty() && !run.turn_id.is_empty() {
            let _ = crate::commands::codex::interrupt_automation_turn(
                app,
                &app.state::<AppState>(),
                &run.thread_id,
                &run.turn_id,
            );
        }
        store::finish_run(
            app,
            &run.automation_id,
            &run.id,
            AutomationRunStatus::Failed,
            None,
            Some(
                "应用重启前运行未完成；对应 Thread、Turn 与 Rollout 已保留，可从运行历史检查"
                    .into(),
            ),
        )?;
    }
    Ok(())
}

pub fn cancel_run(
    app: &AppHandle,
    automation_id: &str,
    run_id: &str,
) -> Result<AutomationRun, String> {
    let run = store::load_run(app, automation_id, run_id)?;
    if !matches!(
        run.status,
        AutomationRunStatus::Queued | AutomationRunStatus::Running
    ) {
        return Ok(run);
    }
    if !run.thread_id.is_empty() && !run.turn_id.is_empty() {
        crate::commands::codex::interrupt_automation_turn(
            app,
            &app.state::<AppState>(),
            &run.thread_id,
            &run.turn_id,
        )?;
    }
    store::finish_run(
        app,
        automation_id,
        run_id,
        AutomationRunStatus::Cancelled,
        None,
        Some("cancelled by user".into()),
    )
}

pub fn delete(app: &AppHandle, automation_id: &str) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?;
    let workspace_runtime =
        WorkspaceRuntime::open(app_data.join("agent-runtime").join("workspaces"))
            .map_err(|error| format!("初始化 Automation Workspace 失败：{error}"))?;
    for run in store::list_runs(app, Some(automation_id), 500)? {
        if matches!(
            run.status,
            AutomationRunStatus::Queued | AutomationRunStatus::Running
        ) {
            let _ = cancel_run(app, automation_id, &run.id);
        }
        workspace_runtime
            .cleanup(&run.id)
            .map_err(|error| format!("清理 Automation 工作目录失败：{error}"))?;
    }
    store::delete(app, automation_id)
}

async fn tick(app: &AppHandle) -> Result<(), String> {
    let now = now_ms();
    for automation in store::list(app, false)?.into_iter().filter(|item| {
        item.published_revision > 0
            && !item.paused
            && item.trigger_type == "scheduleTrigger"
            && item.next_run_at > 0
            && item.next_run_at <= now
    }) {
        let document = store::load_published(app, &automation.id)?;
        let next = next_schedule_ms(&document, now)?.unwrap_or_default();
        store::update_next_run(app, &automation.id, next)?;
        let missed = now.saturating_sub(automation.next_run_at) > MISSED_GRACE_MS;
        if missed
            && matches!(
                document.settings.on_missed_schedule,
                MissedSchedulePolicy::Skip
            )
        {
            continue;
        }
        if let Err(error) = start_run(
            app,
            &automation.id,
            "schedule",
            json!({"scheduledAt":automation.next_run_at,"startedAt":now}),
        )
        .await
        {
            eprintln!("[automation:{}] {error}", automation.id);
        }
    }
    Ok(())
}

fn monitor_run(app: AppHandle, run: AutomationRun, max_duration: Duration) {
    tauri::async_runtime::spawn(async move {
        let manager = match crate::commands::codex::thread_manager(&app, &app.state::<AppState>()) {
            Ok(manager) => manager,
            Err(error) => {
                let _ = store::finish_run(
                    &app,
                    &run.automation_id,
                    &run.id,
                    AutomationRunStatus::Failed,
                    None,
                    Some(error),
                );
                return;
            }
        };
        let started = tokio::time::Instant::now();
        loop {
            if started.elapsed() >= max_duration {
                let _ = crate::commands::codex::interrupt_automation_turn(
                    &app,
                    &app.state::<AppState>(),
                    &run.thread_id,
                    &run.turn_id,
                );
                let _ = store::finish_run(
                    &app,
                    &run.automation_id,
                    &run.id,
                    AutomationRunStatus::Failed,
                    None,
                    Some(format!(
                        "maximum duration exceeded: {} ms",
                        max_duration.as_millis()
                    )),
                );
                return;
            }
            match manager.active_turn_id(&run.thread_id) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    let read = manager.dispatch(
                        "automation-monitor",
                        json!({
                            "id":Uuid::new_v4().to_string(),
                            "method":"thread/read",
                            "params":{"threadId":run.thread_id,"includeTurns":true}
                        }),
                    );
                    let turn = read
                        .response
                        .pointer("/result/thread/turns")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .find(|turn| {
                            turn.get("id").and_then(Value::as_str) == Some(run.turn_id.as_str())
                        });
                    let status = turn
                        .and_then(|turn| turn.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("failed");
                    let output = manager.latest_agent_message(&run.thread_id).ok().flatten();
                    let (run_status, error) = match status {
                        "completed" => (AutomationRunStatus::Completed, None),
                        "interrupted" => (
                            AutomationRunStatus::Cancelled,
                            Some("automation turn interrupted".into()),
                        ),
                        _ => (
                            AutomationRunStatus::Failed,
                            turn.and_then(|turn| turn.pointer("/error/message"))
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .or_else(|| Some("automation turn failed".into())),
                        ),
                    };
                    let _ = store::finish_run(
                        &app,
                        &run.automation_id,
                        &run.id,
                        run_status,
                        output,
                        error,
                    );
                    return;
                }
                Err(error) => {
                    let _ = store::finish_run(
                        &app,
                        &run.automation_id,
                        &run.id,
                        AutomationRunStatus::Failed,
                        None,
                        Some(format!("read Automation Thread: {error:?}")),
                    );
                    return;
                }
            }
            tokio::time::sleep(COMPLETION_POLL).await;
        }
    });
}

fn prepare_workspace(
    app: &AppHandle,
    document: &AutomationDocument,
    run_id: &str,
) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位数据目录：{error}"))?;
    let runtime = WorkspaceRuntime::open(app_data.join("agent-runtime").join("workspaces"))
        .map_err(|error| format!("初始化 Automation Workspace 失败：{error}"))?;
    let project_root = document
        .settings
        .project_root
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let managed = store::run_workspace_path(app, &document.id, run_id)?;
    let descriptor = runtime
        .resolve(
            run_id,
            project_root.as_deref(),
            &managed,
            Some(ExecutionEnvironment::Local),
        )
        .map_err(|error| format!("创建 Automation 本地工作目录失败：{error}"))?;
    Ok(descriptor.active_root)
}

fn execution_prompt(
    document: &AutomationDocument,
    trigger: &str,
    input: &Value,
) -> Result<String, String> {
    let order = topological_order(document)?;
    let workflow = serde_json::to_string_pretty(document)
        .map_err(|error| format!("序列化 Automation 失败：{error}"))?;
    let input = serde_json::to_string_pretty(input)
        .map_err(|error| format!("序列化 Automation 输入失败：{error}"))?;
    Ok(format!(
        "Execute published Automation `{}` revision {} as an unattended run.\n\
Trigger: {trigger}\n\
Topological node order: {}\n\
\n\
Rules:\n\
- Execute enabled nodes in the declared DAG order and honor every edge, input binding, condition branch, merge strategy and output node.\n\
- Use only capabilities declared by the workflow. Do not invent missing credentials, tools, paths or user answers.\n\
- Never ask for user input or approval. The runtime uses approvalPolicy=never; report a blocked step instead of bypassing it.\n\
- Keep all filesystem changes inside the current Local workspace and finish with a concise run result.\n\
\n\
Trigger input:\n{input}\n\
\n\
Published workflow:\n{workflow}",
        document.name,
        document.revision,
        order.join(" -> ")
    ))
}

fn topological_order(document: &AutomationDocument) -> Result<Vec<String>, String> {
    let mut indegree = document
        .nodes
        .iter()
        .filter(|node| !node.disabled)
        .map(|node| (node.id.as_str(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &document.edges {
        if !indegree.contains_key(edge.source_node_id.as_str())
            || !indegree.contains_key(edge.target_node_id.as_str())
        {
            continue;
        }
        *indegree
            .get_mut(edge.target_node_id.as_str())
            .expect("checked") += 1;
        outgoing
            .entry(edge.source_node_id.as_str())
            .or_default()
            .push(edge.target_node_id.as_str());
    }
    let mut queue = document
        .nodes
        .iter()
        .filter(|node| !node.disabled && indegree.get(node.id.as_str()) == Some(&0))
        .map(|node| node.id.as_str())
        .collect::<VecDeque<_>>();
    let mut result = Vec::new();
    while let Some(id) = queue.pop_front() {
        let node = document
            .nodes
            .iter()
            .find(|node| node.id == id)
            .expect("node ids originate from document");
        result.push(format!("{} [{}]", node.name, node.kind));
        for target in outgoing.get(id).into_iter().flatten() {
            if let Some(degree) = indegree.get_mut(target) {
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target);
                }
            }
        }
    }
    if result.len() != indegree.len() {
        return Err("Automation DAG contains a cycle".into());
    }
    Ok(result)
}

pub fn next_schedule_ms(
    document: &AutomationDocument,
    after_ms: u64,
) -> Result<Option<u64>, String> {
    let Some(trigger) = document
        .nodes
        .iter()
        .find(|node| !node.disabled && node.kind == "scheduleTrigger")
    else {
        return Ok(None);
    };
    let expression = trigger
        .config
        .get("cron")
        .and_then(Value::as_str)
        .ok_or_else(|| "定时触发器缺少 Cron 表达式".to_string())?;
    let timezone = trigger
        .config
        .get("timezone")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&document.settings.timezone);
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| format!("无效时区：{timezone}"))?;
    let cron = CronExpression::parse(expression)?;
    let start = i64::try_from(after_ms).unwrap_or(i64::MAX);
    let mut minute = start
        .saturating_div(60_000)
        .saturating_add(1)
        .saturating_mul(60_000);
    let end = minute.saturating_add(366 * 24 * 60 * 60_000i64);
    while minute <= end {
        let Some(utc) = Utc.timestamp_millis_opt(minute).single() else {
            break;
        };
        if cron.matches(utc.with_timezone(&timezone)) {
            return Ok(u64::try_from(minute).ok());
        }
        minute = minute.saturating_add(60_000);
    }
    Err("Cron 在未来 366 天内没有可执行时间".into())
}

#[derive(Debug, Clone)]
struct CronExpression {
    minute: CronField,
    hour: CronField,
    day: CronField,
    month: CronField,
    weekday: CronField,
}

#[derive(Debug, Clone)]
struct CronField {
    values: Vec<u32>,
    wildcard: bool,
}

impl CronExpression {
    fn parse(expression: &str) -> Result<Self, String> {
        let fields = expression.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err("Cron 必须包含 minute hour day month weekday 五个字段".into());
        }
        Ok(Self {
            minute: CronField::parse(fields[0], 0, 59, false)?,
            hour: CronField::parse(fields[1], 0, 23, false)?,
            day: CronField::parse(fields[2], 1, 31, false)?,
            month: CronField::parse(fields[3], 1, 12, false)?,
            weekday: CronField::parse(fields[4], 0, 7, true)?,
        })
    }

    fn matches<T: TimeZone>(&self, value: chrono::DateTime<T>) -> bool {
        if !self.minute.contains(value.minute())
            || !self.hour.contains(value.hour())
            || !self.month.contains(value.month())
        {
            return false;
        }
        let day = self.day.contains(value.day());
        let weekday = self
            .weekday
            .contains(value.weekday().num_days_from_sunday());
        match (self.day.wildcard, self.weekday.wildcard) {
            (true, true) => true,
            (true, false) => weekday,
            (false, true) => day,
            (false, false) => day || weekday,
        }
    }
}

impl CronField {
    fn parse(raw: &str, min: u32, max: u32, sunday_alias: bool) -> Result<Self, String> {
        let wildcard = raw == "*";
        let mut values = Vec::new();
        for segment in raw.split(',') {
            let (range, step) = segment
                .split_once('/')
                .map_or((segment, 1), |(range, step)| {
                    (range, step.parse::<u32>().unwrap_or_default())
                });
            if step == 0 {
                return Err(format!("Cron 步长无效：{segment}"));
            }
            let (start, end) = if range == "*" {
                (min, max)
            } else if let Some((start, end)) = range.split_once('-') {
                (
                    parse_cron_number(start, min, max)?,
                    parse_cron_number(end, min, max)?,
                )
            } else {
                let value = parse_cron_number(range, min, max)?;
                (value, value)
            };
            if start > end {
                return Err(format!("Cron 范围无效：{segment}"));
            }
            values.extend((start..=end).step_by(step as usize).map(|value| {
                if sunday_alias && value == 7 {
                    0
                } else {
                    value
                }
            }));
        }
        values.sort_unstable();
        values.dedup();
        Ok(Self { values, wildcard })
    }

    fn contains(&self, value: u32) -> bool {
        self.values.binary_search(&value).is_ok()
    }
}

fn parse_cron_number(raw: &str, min: u32, max: u32) -> Result<u32, String> {
    let value = raw
        .parse::<u32>()
        .map_err(|_| format!("Cron 数字无效：{raw}"))?;
    if !(min..=max).contains(&value) {
        return Err(format!("Cron 数字超出范围：{raw}"));
    }
    Ok(value)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::automation::model::{
        AutomationEdge, AutomationNode, AutomationPosition, AutomationSettings,
    };

    #[test]
    fn cron_supports_timezone_steps_ranges_lists_and_sunday_alias() {
        let cron = CronExpression::parse("*/15 9-10 * 1,7 0,7").unwrap();
        let timezone = "Asia/Shanghai".parse::<Tz>().unwrap();
        let matching = timezone.with_ymd_and_hms(2026, 7, 26, 9, 30, 0).unwrap();
        assert!(cron.matches(matching));
        let not_matching = timezone.with_ymd_and_hms(2026, 7, 27, 9, 30, 0).unwrap();
        assert!(!cron.matches(not_matching));
    }

    #[test]
    fn next_schedule_uses_declared_timezone() {
        let document = document_with_schedule("0 9 * * *", "Asia/Shanghai");
        let after = Utc
            .with_ymd_and_hms(2026, 7, 25, 1, 1, 0)
            .unwrap()
            .timestamp_millis() as u64;
        let next = next_schedule_ms(&document, after).unwrap().unwrap();
        assert_eq!(
            Utc.timestamp_millis_opt(next as i64).unwrap().to_rfc3339(),
            "2026-07-26T01:00:00+00:00"
        );
    }

    #[test]
    fn prompt_uses_topological_order_and_unattended_policy() {
        let document = document_with_schedule("* * * * *", "UTC");
        let prompt = execution_prompt(&document, "manual", &json!({"value":1})).unwrap();
        assert!(prompt.contains("Trigger [scheduleTrigger] -> Output [output]"));
        assert!(prompt.contains("approvalPolicy=never"));
        assert!(prompt.contains("\"value\": 1"));
    }

    fn document_with_schedule(cron: &str, timezone: &str) -> AutomationDocument {
        let node = |id: &str, kind: &str, config: Value| AutomationNode {
            id: id.into(),
            kind: kind.into(),
            type_version: 1,
            name: if kind == "output" {
                "Output".into()
            } else {
                "Trigger".into()
            },
            position: AutomationPosition { x: 0.0, y: 0.0 },
            disabled: false,
            config,
            inputs: BTreeMap::new(),
        };
        AutomationDocument {
            schema_version: 1,
            id: Uuid::new_v4().to_string(),
            name: "Scheduled".into(),
            description: String::new(),
            revision: 1,
            nodes: vec![
                node(
                    "trigger",
                    "scheduleTrigger",
                    json!({"cron":cron,"timezone":timezone}),
                ),
                node("output", "output", json!({})),
            ],
            edges: vec![AutomationEdge {
                id: "edge".into(),
                source_node_id: "trigger".into(),
                source_port: "output".into(),
                target_node_id: "output".into(),
                target_port: "input".into(),
            }],
            settings: AutomationSettings {
                timezone: timezone.into(),
                max_duration_ms: 300_000,
                max_concurrency: 1,
                on_missed_schedule: MissedSchedulePolicy::Skip,
                project_root: None,
            },
            created_at: 1,
            updated_at: 1,
        }
    }
}
