use serde_json::Value;

use super::{str_arg, ToolCtx};

pub async fn device_call(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let device_id = str_arg(args, "device_id")?;
    let capability = str_arg(args, "capability")?;
    let mut input = args
        .get("input")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    crate::commands::tietiezhi::resolve_json_secret_references(&ctx.app, &mut input)?;
    let result = crate::commands::devices::invoke_device_inner(
        &ctx.app, &ctx.http, device_id, capability, input,
    )
    .await?;
    let output = serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?;
    Ok(crate::commands::tietiezhi::redact_tietiezhi_secret_values(
        &ctx.app, &output,
    ))
}
