import type { TransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import { createTransitionNamespaceCopyCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import type {
  TransitionProgressPort,
  TransitionRuntimeProgress,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import {
  type RuntimeTransitionBinding,
  sameRuntimeTransitionEndpoint,
} from './runtime-transition-binding';

export type NativePlainTransitionTargetLifecycle =
  | 'preparing'
  | 'active'
  | 'sealed'
  | 'published';

export interface NativePlainTransitionRuntime {
  readonly progressPort: TransitionProgressPort;
  currentLifecycle(): Promise<NativePlainTransitionTargetLifecycle | undefined>;
  prepareTarget(): Promise<NativePlainTransitionTargetLifecycle>;
  stageLifecycle({ lifecycle }: {
    lifecycle: NativePlainTransitionTargetLifecycle;
  }): Promise<void>;
}

function canAdvanceLifecycle({ current, next }: {
  current: NativePlainTransitionTargetLifecycle;
  next: NativePlainTransitionTargetLifecycle;
}): boolean {
  switch (current) {
  case 'preparing': return next === 'preparing' || next === 'active' || next === 'sealed';
  case 'active': return next === 'active' || next === 'sealed';
  case 'sealed': return next === 'sealed' || next === 'published';
  case 'published': return next === 'published';
  default: return current satisfies never;
  }
}

function initialProgress({ binding }: {
  binding: RuntimeTransitionBinding;
}): TransitionRuntimeProgress {
  return {
    copyCursor: createTransitionNamespaceCopyCursor(),
    operationId: binding.operationId,
    source: structuredClone(binding.sourceEndpoint),
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: 'copying',
    target: structuredClone(binding.targetEndpoint),
  };
}

function sameProgressBinding({ binding, progress }: {
  binding: RuntimeTransitionBinding;
  progress: TransitionRuntimeProgress;
}): boolean {
  return progress.operationId === binding.operationId
    && progress.sourceAuthorityIdentity === binding.sourceAuthorityIdentity
    && sameRuntimeTransitionEndpoint({ left: progress.source, right: binding.sourceEndpoint })
    && sameRuntimeTransitionEndpoint({ left: progress.target, right: binding.targetEndpoint });
}

/** Runtime-only ownership marker for the fixed native plain target namespace. */
export class NativePlainTransitionRuntimeState implements NativePlainTransitionRuntime {
  private readonly binding: RuntimeTransitionBinding;
  private lifecycle: NativePlainTransitionTargetLifecycle | undefined;
  private progress: TransitionRuntimeProgress | undefined;
  private stagedLifecycle: NativePlainTransitionTargetLifecycle | undefined;

  public constructor({ binding }: { binding: RuntimeTransitionBinding }) {
    this.binding = structuredClone(binding);
  }

  public async prepareTarget(): Promise<NativePlainTransitionTargetLifecycle> {
    if (this.lifecycle !== undefined) return this.lifecycle;
    this.lifecycle = 'preparing';
    this.progress = initialProgress({ binding: this.binding });
    return this.lifecycle;
  }

  public async stageLifecycle({ lifecycle }: {
    lifecycle: NativePlainTransitionTargetLifecycle;
  }): Promise<void> {
    const current = this.stagedLifecycle ?? this.lifecycle;
    if (current === undefined) {
      throw new TypeError('native plain transition target must be prepared before staging lifecycle');
    }
    if (!canAdvanceLifecycle({ current, next: lifecycle })) {
      throw new TypeError(`native plain transition target cannot move from ${current} to ${lifecycle}`);
    }
    this.stagedLifecycle = lifecycle;
  }

  public async currentLifecycle(): Promise<NativePlainTransitionTargetLifecycle | undefined> {
    return this.stagedLifecycle ?? this.lifecycle;
  }

  public async abandonTarget({ operationId }: {
    operationId: TransitionOperationId;
  }): Promise<void> {
    this.requireOperation({ operationId });
    this.lifecycle = undefined;
    this.progress = undefined;
    this.stagedLifecycle = undefined;
  }

  readonly progressPort: TransitionProgressPort = {
    clear: async ({ operationId }) => {
      this.requireOperation({ operationId });
      const effective = this.stagedLifecycle ?? this.lifecycle;
      switch (effective) {
      case 'sealed':
        this.lifecycle = 'published';
        this.stagedLifecycle = undefined;
        return;
      case 'preparing':
      case 'active':
      case 'published':
      case undefined:
        this.lifecycle = undefined;
        this.progress = undefined;
        this.stagedLifecycle = undefined;
        return;
      default: effective satisfies never;
      }
    },
    load: async ({ operationId }) => {
      this.requireOperation({ operationId });
      return structuredClone(this.progress);
    },
    save: async ({ progress }) => {
      if (!sameProgressBinding({ binding: this.binding, progress })) {
        throw new TypeError('cannot save runtime progress for another transition binding');
      }
      if (this.lifecycle === undefined) {
        throw new TypeError('native plain transition target must be prepared before saving progress');
      }
      if (this.stagedLifecycle !== undefined) {
        this.lifecycle = this.stagedLifecycle;
        this.stagedLifecycle = undefined;
      }
      this.progress = structuredClone(progress);
    },
  };

  private requireOperation({ operationId }: {
    operationId: TransitionOperationId | string;
  }): void {
    if (operationId !== this.binding.operationId) {
      throw new TypeError('native plain transition runtime state belongs to another operation');
    }
  }
}

export const TEST_ONLY = {
  canAdvanceLifecycle,
  initialProgress,
  sameProgressBinding,
};
