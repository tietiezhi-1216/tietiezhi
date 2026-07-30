import type { EngineDescriptor } from "@shared/contracts";

import type { AIEngine } from "../engines/engine.js";

export class EngineManager {
  readonly #engines = new Map<string, AIEngine>();

  async registerReady(engine: AIEngine): Promise<void> {
    const descriptor = await engine.descriptor();
    this.#engines.set(descriptor.id, engine);
  }

  require(id: string): AIEngine {
    const engine = this.#engines.get(id);
    if (engine === undefined) throw new Error(`引擎 ${id} 不存在`);
    return engine;
  }

  async list(): Promise<EngineDescriptor[]> {
    return Promise.all([...this.#engines.values()].map((engine) => engine.descriptor()));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#engines.values()].map((engine) => engine.dispose()));
  }
}
