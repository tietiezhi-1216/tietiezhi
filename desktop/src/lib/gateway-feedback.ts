import { errorMessage } from "@/lib/api";
import { message, type AppMessageTone } from "@/components/app-message";

export interface GatewayFeedback {
  title: string;
  description?: string;
  tone: AppMessageTone;
}

function matches(raw: string, pattern: RegExp): boolean {
  return pattern.test(raw.toLowerCase());
}

export function actionableGatewayFeedback(error: unknown): GatewayFeedback | null {
  const raw = errorMessage(error).trim();

  if (
    matches(
      raw,
      /请先登录|login required|session.*(invalid|expired)|会话.*(无效|失效|过期)|登录状态.*(无效|失效|过期)/,
    )
  ) {
    return {
      title: "请先登录中转站",
      description: "登录后即可刷新模型并使用当前账号额度。",
      tone: "warning",
    };
  }
  if (matches(raw, /api key quota exceeded|quota exceeded|key.*额度.*(不足|用尽)/)) {
    return {
      title: "API Key 额度已用尽",
      description: "请调整 Key 限额，或更换可用的 API Key。",
      tone: "warning",
    };
  }
  if (matches(raw, /http\s*402|insufficient balance|余额不足|额度不足/)) {
    return {
      title: "当前额度不足",
      description: "请充值或购买套餐后重试。",
      tone: "warning",
    };
  }
  if (
    matches(
      raw,
      /http\s*401|unauthorized|invalid api key|missing api key|认证.*(失败|无效|失效|过期)/,
    )
  ) {
    return {
      title: "认证状态已失效",
      description: "请重新登录中转站，或检查自定义供应商的 API Key。",
      tone: "warning",
    };
  }
  if (matches(raw, /account[ _]disabled|账号.*(停用|禁用)/)) {
    return {
      title: "当前账号已停用",
      description: "请联系管理员处理账号状态。",
      tone: "error",
    };
  }
  if (matches(raw, /http\s*429|too many requests|请求过于频繁/)) {
    return {
      title: "请求过于频繁",
      description: "请稍等片刻后重试。",
      tone: "warning",
    };
  }
  return null;
}

export function gatewayFeedback(
  error: unknown,
  fallbackTitle: string,
): GatewayFeedback {
  const actionable = actionableGatewayFeedback(error);
  if (actionable) return actionable;

  const raw = errorMessage(error).trim();
  const description =
    !raw || /http\s*\d{3}|\{.*["']error["']/is.test(raw)
      ? "请稍后重试。"
      : raw.slice(0, 180);
  return {
    title: fallbackTitle,
    description,
    tone: "error",
  };
}

function emitFeedback(feedback: GatewayFeedback) {
  message[feedback.tone](feedback.title, feedback.description);
}

export function notifyActionableGatewayError(error: unknown): boolean {
  const feedback = actionableGatewayFeedback(error);
  if (!feedback) return false;
  emitFeedback(feedback);
  return true;
}

export function notifyGatewayError(error: unknown, fallbackTitle: string) {
  emitFeedback(gatewayFeedback(error, fallbackTitle));
}
