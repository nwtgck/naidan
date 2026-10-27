import { computed, isReactive, shallowReactive, toRaw, type ComputedRef } from 'vue';
import type { ChatId, MessageId } from '@/01-models/ids';
import type { AssistantMessageNode, Chat } from '@/01-models/types';
import { chatModelBindingAssistantFingerprint } from '@/01-models/chat-message';
import type { ChatGenerationTelemetryEvent } from '@/logic/generate-chat-turn';
import { parseGenerationMetrics, type GenerationMetrics, type GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import { aggregateGenerationMetrics, LIVE_SPEED_INTERVAL_MS, LIVE_SPEED_STALE_MS } from '@/logic/generation-metrics/measurement';
import { getChatBranchIterator } from '@/logic/chat-tree';
import { createSha256Hasher } from '@/utils/sha256';
import { normalizeLmParameters } from '@/utils/lm-parameters';

const MAX_RETAINED_CALLS = 256;

type Entry = {
  phase: 'live' | 'complete' | 'interrupted',
  metrics: GenerationMetrics | undefined,
  updatedAt: number,
  proof: string | undefined,
  snapshot: 'final' | 'last_sample' | undefined,
  liveNode: AssistantMessageNode | undefined,
};
type Run = {
  id: number,
  chatId: ChatId,
  phase: 'running' | 'complete' | 'interrupted',
  messageIds: MessageId[],
  currentMessageId: MessageId | undefined,
  nOmittedCalls: number,
  entries: Map<MessageId, Entry>,
};

function isLastSample({ snapshot }: { snapshot: Entry['snapshot'] }): boolean {
  switch (snapshot) {
  case 'last_sample': return true;
  case 'final': case undefined: return false;
  default: {
    const exhaustive: never = snapshot;
    throw new Error(`Unhandled generation snapshot: ${exhaustive}`);
  }
  }
}

/** Page-local history, retained until reload or deletion. Never persisted or sent over RPC. */
export function createGenerationMetricsState({ now = () => performance.now() }: { now?: () => number } = {}) {
  const runs = shallowReactive(new Map<number, Run>());
  const active = new Map<ChatId, { owner: AbortSignal, run: Run }>();
  const proofs = new WeakMap<AssistantMessageNode, ComputedRef<string>>();
  let sequence = 0;

  function proofFor({ node }: { node: AssistantMessageNode }): string {
    const fingerprint = () => {
      const hasher = createSha256Hasher();
      // Persistence normalizes empty parameters to undefined. Apply the same
      // equivalence here without weakening content or non-empty parameter checks.
      const normalized = { ...node, lmParameters: normalizeLmParameters({ lmParameters: node.lmParameters }) };
      hasher.update({ bytes: new TextEncoder().encode(JSON.stringify([node.modelId, chatModelBindingAssistantFingerprint({ node: normalized })])) });
      return hasher.digestHex();
    };
    // Plain snapshots can be mutated without Vue invalidating a computed value.
    if (!isReactive(node)) {
      return fingerprint();
    }
    let cached = proofs.get(node);
    if (cached === undefined) {
      cached = computed(fingerprint);
      proofs.set(node, cached);
    }
    return cached.value;
  }

  function start({ chatId, owner }: { chatId: ChatId, owner: AbortSignal }): void {
    const previous = active.get(chatId);
    if (previous !== undefined) {
      previous.run.phase = 'interrupted';
      previous.run.currentMessageId = undefined;
      runs.delete(previous.run.id);
    }
    if (owner.aborted) {
      active.delete(chatId);
      return;
    }
    const run = shallowReactive<Run>({ id: ++sequence, chatId, phase: 'running', messageIds: [], currentMessageId: undefined, nOmittedCalls: 0, entries: shallowReactive(new Map<MessageId, Entry>()) });
    runs.set(run.id, run);
    active.set(chatId, { owner, run });
  }

  function observe({ chatId, owner, node, event }: { chatId: ChatId, owner: AbortSignal, node: AssistantMessageNode, event: ChatGenerationTelemetryEvent }): void {
    const owned = active.get(chatId);
    if (owned?.owner !== owner || owned.run.phase !== 'running' || node.id !== event.messageId) {
      return;
    }
    const run = owned.run;
    switch (event.type) {
    case 'started':
      if (owner.aborted || run.entries.has(node.id)) {
        return;
      }
      // Reusing an assistant ID starts a new measurement; old completed data must
      // not remain visible while the replacement call is waiting for its first sample.
      for (const [id, other] of runs) {
        if (id !== run.id && other.chatId === chatId && other.messageIds.includes(node.id)) {
          runs.delete(id);
        }
      }
      if (run.messageIds.length >= MAX_RETAINED_CALLS) {
        const oldest = run.messageIds[0]!;
        run.entries.delete(oldest);
        run.messageIds = run.messageIds.slice(1);
        run.nOmittedCalls++;
      }
      run.messageIds = [...run.messageIds, node.id];
      run.currentMessageId = node.id;
      run.entries.set(node.id, { phase: 'live', metrics: undefined, updatedAt: -Infinity, proof: undefined, snapshot: undefined, liveNode: toRaw(node) });
      return;
    case 'sample': {
      const entry = run.entries.get(node.id);
      if (owner.aborted || run.currentMessageId !== node.id || entry?.phase !== 'live' || entry.liveNode !== toRaw(node)) {
        return;
      }
      const time = now();
      const metrics = parseGenerationMetrics({ value: event.metrics });
      // The provider also throttles samples. Preserve its one-time promotion from
      // received characters to native tokens instead of dropping it a second time.
      const nativeUpgrade = entry.metrics?.speed.measurement === 'received_text' && metrics?.speed.measurement === 'llama_cpp_predicted';
      if (time < entry.updatedAt || (!nativeUpgrade && time - entry.updatedAt < LIVE_SPEED_INTERVAL_MS)) {
        return;
      }
      if (metrics !== undefined) {
        run.entries.set(node.id, { ...entry, metrics, updatedAt: time });
      }
      return;
    }
    case 'finished': {
      const entry = run.entries.get(node.id);
      if (run.currentMessageId !== node.id || entry?.phase !== 'live' || entry.liveNode !== toRaw(node)) {
        return;
      }
      const result = event.result;
      let completed = false;
      let metrics: GenerationMetrics | undefined;
      switch (result?.type) {
      case 'finished': completed = true;
        metrics = parseGenerationMetrics({ value: result.generationMetrics });
        break;
      case 'interrupted': completed = result.reason === 'limit' || result.reason === 'stop_sequence';
        metrics = completed ? parseGenerationMetrics({ value: result.generationMetrics }) : undefined;
        break;
      case 'error': case undefined: break;
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
      completed = completed && !owner.aborted;
      const finishedAt = now();
      let snapshot: Entry['snapshot'] = metrics === undefined ? undefined : 'final';
      if (completed && metrics === undefined && entry.metrics !== undefined && finishedAt >= entry.updatedAt && finishedAt - entry.updatedAt < LIVE_SPEED_STALE_MS) {
        metrics = entry.metrics;
        snapshot = 'last_sample';
      }
      run.entries.set(node.id, { phase: completed ? 'complete' : 'interrupted', metrics: completed ? metrics : undefined, updatedAt: isLastSample({ snapshot }) ? entry.updatedAt : finishedAt, proof: completed && metrics !== undefined ? proofFor({ node }) : undefined, snapshot: completed ? snapshot : undefined, liveNode: undefined });
      run.currentMessageId = undefined;
      return;
    }
    default: {
      const exhaustive: never = event;
      throw new Error(String(exhaustive));
    }
    }
  }

  function finish({ chatId, owner, completed }: { chatId: ChatId, owner: AbortSignal, completed: boolean }): void {
    const owned = active.get(chatId);
    if (owned?.owner !== owner) {
      return;
    }
    owned.run.currentMessageId = undefined;
    owned.run.phase = completed && !owner.aborted ? 'complete' : 'interrupted';
    active.delete(chatId);
    // Live object identities are only held while the matching call is active.
    for (const [messageId, entry] of owned.run.entries) {
      if (entry.liveNode !== undefined) {
        owned.run.entries.set(messageId, { phase: 'interrupted', metrics: undefined, updatedAt: entry.updatedAt, proof: undefined, snapshot: undefined, liveNode: undefined });
      }
    }
    if (!completed || owner.aborted || ![...owned.run.entries.values()].some(entry => entry.metrics !== undefined)) {
      runs.delete(owned.run.id);
    }
  }

  function presentations({ chat }: { chat: Chat }): { messageId: MessageId, presentation: GenerationMetricsPresentation }[] {
    const branch = new Map([...getChatBranchIterator({ chat })].map(node => [node.id, node]));
    const result: { messageId: MessageId, presentation: GenerationMetricsPresentation }[] = [];
    for (const run of runs.values()) {
      if (run.chatId !== chat.id || run.phase === 'interrupted' || !run.messageIds.every(id => branch.has(id))) {
        continue;
      }
      const messageId = (() => {
        switch (run.phase) {
        case 'running': return run.currentMessageId;
        case 'complete': return run.messageIds.at(-1);
        default: {
          const exhaustive: never = run.phase;
          throw new Error(String(exhaustive));
        }
        }
      })();
      if (messageId === undefined) {
        continue;
      }
      const entry = run.entries.get(messageId);
      const node = branch.get(messageId);
      if (entry?.metrics === undefined || node?.role !== 'assistant') {
        continue;
      }
      const live = run.phase === 'running';
      if (live && (entry.phase !== 'live' || entry.liveNode !== toRaw(node) || active.get(chat.id)?.owner.aborted)) {
        continue;
      }
      const calls = run.messageIds.map(id => {
        const recorded = run.entries.get(id);
        const recordedNode = branch.get(id);
        const valid = recorded?.metrics !== undefined && (recorded.phase === 'live' || (recorded.phase === 'complete' && recordedNode?.role === 'assistant' && proofFor({ node: recordedNode }) === recorded.proof));
        return { metrics: valid ? recorded?.metrics : undefined, ...(valid && isLastSample({ snapshot: recorded?.snapshot }) ? { snapshot: 'last_sample' as const } : {}) };
      });
      const lastMetrics = calls.at(-1)?.metrics;
      if (lastMetrics === undefined) {
        continue;
      }
      const aggregate = live || run.nOmittedCalls > 0 || calls.some(call => isLastSample({ snapshot: call.snapshot })) ? undefined : aggregateGenerationMetrics({ calls: calls.map(call => call.metrics) });
      result.push({ messageId, presentation: { runId: run.id, live, updatedAt: entry.updatedAt, metrics: aggregate ?? lastMetrics, scope: live ? 'current' : isLastSample({ snapshot: entry.snapshot }) ? 'last_sample' : aggregate === undefined ? 'last' : 'turn', nOmittedCalls: run.nOmittedCalls, calls } });
    }
    return result;
  }

  function clearChat({ chatId }: { chatId: ChatId }): void {
    active.delete(chatId);
    for (const [id, run] of runs) {
      if (run.chatId === chatId) {
        runs.delete(id);
      }
    }
  }

  function clear(): void {
    active.clear();
    runs.clear();
  }

  function prune({ chat }: { chat: Chat }): void {
    const ids = new Set<MessageId>();
    const stack = [...chat.root.items];
    while (stack.length) {
      const node = stack.pop()!;
      ids.add(node.id);
      stack.push(...node.replies.items);
    }
    for (const [id, run] of runs) {
      if (run.chatId === chat.id && run.phase !== 'running' && run.messageIds.some(messageId => !ids.has(messageId))) {
        runs.delete(id);
      }
    }
  }

  return {
    start,
    observe,
    finish,
    presentations,
    clearChat,
    clear,
    prune,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { runs } }) || {}),
  };
}

export const generationMetricsState = createGenerationMetricsState();

export const TEST_ONLY = {
};
