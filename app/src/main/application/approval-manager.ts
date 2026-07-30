import { randomUUID } from "node:crypto";

interface PendingApproval {
  resolve(approved: boolean): void;
  reject(error: Error): void;
}

export class ApprovalManager {
  readonly #pending = new Map<string, PendingApproval>();

  request(
    signal: AbortSignal,
    onRequest: (approvalId: string) => void,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.reject(new Error("操作已取消"));
    const approvalId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(approvalId);
        reject(new Error("操作已取消"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(approvalId, {
        resolve: (approved) => {
          signal.removeEventListener("abort", abort);
          resolve(approved);
        },
        reject,
      });
      onRequest(approvalId);
    });
  }

  resolve(id: string, approved: boolean): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error("审批请求不存在或已经结束");
    this.#pending.delete(id);
    pending.resolve(approved);
  }

  dispose(): void {
    for (const pending of this.#pending.values()) pending.reject(new Error("应用正在退出"));
    this.#pending.clear();
  }
}
