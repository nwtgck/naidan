import type { TransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  TransitionProgressPort,
  TransitionRuntimeProgress,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';

export class InMemoryTransitionProgressPort implements TransitionProgressPort {
  #progress: TransitionRuntimeProgress | undefined;

  public async clear({ operationId }: { operationId: TransitionOperationId }): Promise<void> {
    if (this.#progress?.operationId === operationId) this.#progress = undefined;
  }

  public async load({ operationId }: { operationId: TransitionOperationId }): Promise<TransitionRuntimeProgress | undefined> {
    if (this.#progress?.operationId !== operationId) return undefined;
    return structuredClone(this.#progress);
  }

  public async save({ progress }: { progress: TransitionRuntimeProgress }): Promise<void> {
    if (this.#progress !== undefined && this.#progress.operationId !== progress.operationId) {
      throw new TypeError('runtime progress already belongs to another transition operation');
    }
    this.#progress = structuredClone(progress);
  }
}

export const TEST_ONLY = {
};
