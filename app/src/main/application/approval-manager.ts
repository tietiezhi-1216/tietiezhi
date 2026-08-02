import type { ApprovalDecision, ApprovalRecord } from "@shared/contracts";

export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export interface ApprovalStore {
  approvals(conversationId?: string): ApprovalRecord[];
  saveApproval(approval: ApprovalRecord): void;
}

interface PendingApproval {
  record: ApprovalRecord;
  resolve(decision: ApprovalDecision): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class ApprovalManager {
  readonly #pending = new Map<string, PendingApproval>();

  constructor(private readonly database: ApprovalStore) {}

  list(conversationId?: string): ApprovalRecord[] {
    return this.database.approvals(conversationId);
  }

  request(
    record: Omit<ApprovalRecord, "status" | "createdAt" | "expiresAt">,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.reject(new Error("操作已取消"));
    const createdAt = Date.now();
    const approval: ApprovalRecord = {
      ...record,
      status: "pending",
      createdAt,
      expiresAt: createdAt + APPROVAL_TIMEOUT_MS,
    };
    this.database.saveApproval(approval);
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const finish = (decision: ApprovalDecision, reason?: string): void => {
        const pending = this.#pending.get(approval.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        signal.removeEventListener("abort", abort);
        this.#pending.delete(approval.id);
        const resolved: ApprovalRecord = {
          ...approval,
          status: decision === "deny" ? "denied" : "approved",
          decision,
          reason,
          resolvedAt: Date.now(),
        };
        this.database.saveApproval(resolved);
        resolve(decision);
      };
      const abort = () => {
        const pending = this.#pending.get(approval.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(approval.id);
        this.database.saveApproval({
          ...approval,
          status: "cancelled",
          resolvedAt: Date.now(),
          reason: "任务已取消",
        });
        reject(new Error("操作已取消"));
      };
      const timer = setTimeout(() => finish("deny", "等待确认超时，已拒绝该操作"), APPROVAL_TIMEOUT_MS);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(approval.id, { record: approval, resolve: finish, reject, timer });
    });
  }

  resolve(id: string, decision: ApprovalDecision): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error("审批请求不存在或已经结束");
    pending.resolve(decision);
  }

  dispose(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("应用正在退出"));
    }
    this.#pending.clear();
  }
}
