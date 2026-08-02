import type { PermissionProfile, PermissionProfileId } from "@shared/contracts";

export const AI_SDK_PERMISSION_PROFILES: PermissionProfile[] = [
  {
    id: "ask",
    name: "请求批准",
    description: "写入文件或运行命令前都先询问。",
    risk: "low",
    requiresConfirmation: false,
    scope: "conversation",
  },
  {
    id: "agent-managed",
    name: "替我审批",
    description: "自动允许普通工作区修改，危险命令仍会询问。",
    risk: "medium",
    requiresConfirmation: false,
    scope: "conversation",
  },
  {
    id: "full-access",
    name: "完全访问",
    description: "当前任务内自动允许工具操作，仍受 Workspace 安全边界约束。",
    risk: "high",
    requiresConfirmation: true,
    scope: "conversation",
  },
];

const APPROVAL_TOOLS = new Set(["writeFile", "replaceText", "runCommand"]);
const DANGEROUS_SHELL =
  /(?:^|[;&|]\s*)(?:sudo\b|rm\s+-[^\n]*r|rmdir\b|dd\b|mkfs\b|shutdown\b|reboot\b|kill(?:all)?\b|chmod\b|chown\b|git\s+(?:reset|clean|checkout)\b|(?:npm|pnpm|yarn)\s+publish\b)|(?:curl|wget)[^\n|]*\|\s*(?:sh|bash|zsh)\b|(?:^|\s)(?:\.\.\/|~\/|\$HOME\b)/i;

function commandFrom(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const command = Reflect.get(input, "command");
  return typeof command === "string" ? command : "";
}

function hasRiskyPath(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return true;
  const path = Reflect.get(input, "path");
  if (typeof path !== "string") return false;
  return path.startsWith("/") || path.startsWith("~") || path.split(/[\\/]/).includes("..");
}

export function requiresToolApproval(
  profile: PermissionProfileId,
  toolName: string,
  input: unknown,
): boolean {
  if (!APPROVAL_TOOLS.has(toolName)) return false;
  if (profile === "ask") return true;
  if (profile === "full-access") return false;
  if (toolName === "runCommand") return DANGEROUS_SHELL.test(commandFrom(input));
  return hasRiskyPath(input);
}

export function permissionProfile(
  value: string | undefined,
  fallback: PermissionProfileId = "ask",
): PermissionProfileId {
  return value === "ask" || value === "agent-managed" || value === "full-access"
    ? value
    : fallback;
}
