import { describe, expect, it } from 'vitest';
import { reactive, computed } from 'vue';
import type { AssistantMessageNode, Chat, ToolMessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { LocalStorageProvider } from '@/00-storage/service/local-storage';
import type { GenerationMetrics } from '@/01-models/generation-metrics';
import { toChatId, toMessageId } from '@/01-models/ids';
import { createTokenMetrics } from '@/logic/generation-metrics/measurement';
import { createGenerationMetricsState } from './generation-metrics-state';

function assistant({ id }: { id: string }): AssistantMessageNode {
  return { id: toMessageId({ raw: id }), role: 'assistant', createdAt: 1, parts: [{ type: 'text', text: id, completeness: 'complete' }], modelId: 'model', lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

function metrics({ n = 20, ms = 500 }: { n?: number, ms?: number } = {}) {
  return createTokenMetrics({ measurement: 'ollama_eval', nOutputTokens: n, nMeasuredTokens: n, durationMs: ms })!;
}

function fixture({ reactiveChat = false }: { reactiveChat?: boolean } = {}) {
  let time = 0;
  const state = createGenerationMetricsState({ now: () => time });
  const first = assistant({ id: 'first' });
  const initial: Chat = { id: toChatId({ raw: 'chat' }), title: null, createdAt: 1, updatedAt: 1, debugEnabled: false, root: { items: [first] }, currentLeafId: first.id };
  const chat = reactiveChat ? reactive(initial) : initial;
  const node = chat.root.items[0];
  if (node?.role !== 'assistant') {
    throw new Error('Missing assistant');
  }
  const controller = new AbortController();
  const owner = controller.signal;
  state.start({ chatId: chat.id, owner });
  const started = ({ node: selected = node }: { node?: AssistantMessageNode } = {}) => state.observe({ chatId: chat.id, owner, node: selected, event: { type: 'started', messageId: selected.id } });
  const sampled = ({ node: selected = node, value = metrics() }: { node?: AssistantMessageNode, value?: GenerationMetrics } = {}) => state.observe({ chatId: chat.id, owner, node: selected, event: { type: 'sample', messageId: selected.id, metrics: value } });
  const finished = ({ node: selected = node, value }: { node?: AssistantMessageNode, value: GenerationMetrics | undefined }) => state.observe({ chatId: chat.id, owner, node: selected, event: { type: 'finished', messageId: selected.id, result: { type: 'finished', next: 'user', generationMetrics: value } } });
  const complete = () => state.finish({ chatId: chat.id, owner, completed: true });
  return {
    state,
    chat,
    node,
    controller,
    owner,
    started,
    sampled,
    finished,
    complete,
    tick({ value }: { value: number }) {
      time = value;
    },
  };
}

describe('memory-only generation metrics ownership', () => {
  it.each([undefined, 0.7])('retains earlier results through persisted parameter normalization (temperature=%s)', async temperature => {
    using cleanup = {
      [Symbol.dispose]() {
        localStorage.clear();
      },
    };
    const f = fixture();
    f.node.lmParameters = { ...EMPTY_LM_PARAMETERS, reasoning: { effort: undefined }, temperature };
    f.started();
    f.finished({ value: metrics() });
    f.complete();

    const storage = new LocalStorageProvider();
    await storage.saveChatMeta({ meta: f.chat });
    await storage.saveChatContent({ id: f.chat.id, content: f.chat });
    const restored = await storage.loadChat({ id: f.chat.id });
    if (restored === null) {
      throw new Error('Missing restored chat');
    }
    expect(f.state.presentations({ chat: restored })).toHaveLength(1);

    const second = assistant({ id: 'second-turn' });
    restored.root.items[0]!.replies.items.push(second);
    restored.currentLeafId = second.id;
    const owner = new AbortController().signal;
    f.state.start({ chatId: restored.id, owner });
    f.state.observe({ chatId: restored.id, owner, node: second, event: { type: 'started', messageId: second.id } });
    f.state.observe({ chatId: restored.id, owner, node: second, event: { type: 'finished', messageId: second.id, result: { type: 'finished', next: 'user', generationMetrics: metrics({ n: 30 }) } } });
    f.state.finish({ chatId: restored.id, owner, completed: true });
    expect(f.state.presentations({ chat: restored }).map(item => item.messageId)).toEqual([f.node.id, second.id]);

    const first = restored.root.items[0];
    if (first?.role !== 'assistant') {
      throw new Error('Missing first assistant');
    }
    first.lmParameters = { ...EMPTY_LM_PARAMETERS, reasoning: { effort: undefined }, temperature: 0.2 };
    expect(f.state.presentations({ chat: restored }).map(item => item.messageId)).toEqual([second.id]);
    void cleanup;
  });

  it('does not modify chat data and does not survive a fresh state instance', () => {
    const f = fixture();
    const before = JSON.stringify(f.chat);
    f.started();
    f.sampled();
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation.live).toBe(true);
    f.finished({ value: metrics() });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation.live).toBe(false);
    expect(JSON.stringify(f.chat)).toBe(before);
    expect(createGenerationMetricsState().presentations({ chat: f.chat })).toEqual([]);
    expect(f.state.presentations({ chat: { ...f.chat, id: toChatId({ raw: 'clone' }) } })).toEqual([]);
  });

  it('hides telemetry during tool wait and aggregates only after the final model call', () => {
    const f = fixture();
    f.started();
    f.sampled();
    f.finished({ value: metrics() });
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    const second = assistant({ id: 'second' });
    const tool: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 2, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [second] } };
    f.node.replies.items.push(tool);
    f.chat.currentLeafId = second.id;
    f.started({ node: second });
    f.sampled({ node: second, value: metrics({ n: 180, ms: 3000 }) });
    const live = f.state.presentations({ chat: f.chat });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ messageId: second.id, presentation: { scope: 'current', metrics: { speed: { perSecond: 60 } } } });
    f.finished({ node: second, value: metrics({ n: 180, ms: 3000 }) });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation).toMatchObject({ scope: 'turn', metrics: { nOutputTokens: 200, speed: { interval: { nUnits: 200, durationMs: 3500 } } } });
  });

  it('never falls back to an earlier tool-generating call if the final call has no telemetry', () => {
    const f = fixture();
    f.started();
    f.finished({ value: metrics() });
    const second = assistant({ id: 'second' });
    f.node.replies.items.push(second);
    f.chat.currentLeafId = second.id;
    f.started({ node: second });
    f.finished({ node: second, value: undefined });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
  });

  it('drops live telemetry on abort and rejects old callbacks after replacement', () => {
    const f = fixture();
    f.started();
    f.sampled();
    f.controller.abort();
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    const replacement = new AbortController().signal;
    f.state.start({ chatId: f.chat.id, owner: replacement });
    f.state.observe({ chatId: f.chat.id, owner: replacement, node: f.node, event: { type: 'started', messageId: f.node.id } });
    f.sampled();
    f.finished({ value: metrics() });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    f.state.observe({ chatId: f.chat.id, owner: replacement, node: f.node, event: { type: 'sample', messageId: f.node.id, metrics: metrics({ n: 50 }) } });
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation.metrics.nOutputTokens).toBe(50);
  });

  it.each([false, true])('invalidates edited content and model binding, but accepts identical reloads (reactive=%s)', reactiveChat => {
    const f = fixture({ reactiveChat });
    f.started();
    f.finished({ value: metrics() });
    f.complete();
    const visible = computed(() => f.state.presentations({ chat: f.chat }));
    expect(visible.value).toHaveLength(1);
    const reloaded: Chat = JSON.parse(JSON.stringify(f.chat));
    expect(f.state.presentations({ chat: reloaded })).toHaveLength(1);
    const part = f.node.parts[0];
    if (part?.type !== 'text') {
      throw new Error('Missing text');
    }
    part.text = 'edited';
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    if (reactiveChat) {
      expect(visible.value).toEqual([]);
    }
    part.text = 'first';
    f.node.modelId = 'other-model';
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
  });

  it('does not attach live statistics to a replacement node with the same ID', () => {
    const f = fixture({ reactiveChat: true });
    f.started();
    f.sampled();
    expect(f.state.presentations({ chat: f.chat })).toHaveLength(1);
    const replaced: Chat = JSON.parse(JSON.stringify(f.chat));
    expect(f.state.presentations({ chat: replaced })).toEqual([]);
    f.finished({ value: metrics() });
    f.complete();
    expect(f.state.presentations({ chat: replaced })).toHaveLength(1);
  });

  it('shows only the selected branch and restores an existing branch when selected again', () => {
    const f = fixture();
    f.started();
    f.finished({ value: metrics() });
    f.complete();
    const alternate = assistant({ id: 'alternate' });
    f.chat.root.items.push(alternate);
    f.chat.currentLeafId = alternate.id;
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    f.chat.currentLeafId = f.node.id;
    expect(f.state.presentations({ chat: f.chat })).toHaveLength(1);
    f.chat.root.items = [];
    f.state.prune({ chat: f.chat });
    f.chat.root.items = [f.node];
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
  });

  it('clears deleted chats without allowing a late completion to recreate them', () => {
    const f = fixture();
    f.started();
    f.sampled();
    f.state.clearChat({ chatId: f.chat.id });
    f.finished({ value: metrics() });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    expect(f.state.TEST_ONLY?.runs.size).toBe(0);
  });

  it('does not reassign a sample with a mismatched assistant ID', () => {
    const f = fixture();
    f.started();
    f.state.observe({ chatId: f.chat.id, owner: f.owner, node: f.node, event: { type: 'sample', messageId: toMessageId({ raw: 'other' }), metrics: metrics() } });
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
  });

  it('throttles state writes and lets final statistics supersede the last live sample', () => {
    const f = fixture();
    f.started();
    f.sampled();
    f.tick({ value: 100 });
    f.sampled({ value: metrics({ n: 99 }) });
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation.metrics.nOutputTokens).toBe(20);
    f.finished({ value: metrics({ n: 99 }) });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation.metrics.nOutputTokens).toBe(99);
  });

  it('retains a fresh last sample after normal completion without inventing final statistics', () => {
    const f = fixture();
    f.started();
    f.tick({ value: 100 });
    f.sampled();
    f.tick({ value: 1000 });
    f.finished({ value: undefined });
    f.complete();
    f.tick({ value: 100_000 });
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation).toMatchObject({
      live: false,
      scope: 'last_sample',
      updatedAt: 100,
      metrics: metrics(),
      calls: [{ metrics: metrics(), snapshot: 'last_sample' }],
    });
  });

  it.each([5000, 5001])('does not revive a sample that expired %s ms before completion', elapsed => {
    const f = fixture();
    f.started();
    f.sampled();
    f.tick({ value: elapsed });
    f.finished({ value: undefined });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
  });

  it.each(['error', 'unknown', 'aborted'] as const)('does not retain a live sample after %s', outcome => {
    const f = fixture();
    f.started();
    f.sampled();
    const result = outcome === 'error'
      ? { type: 'error' as const, error: new Error('failed') }
      : { type: 'interrupted' as const, reason: outcome };
    f.state.observe({ chatId: f.chat.id, owner: f.owner, node: f.node, event: { type: 'finished', messageId: f.node.id, result } });
    f.state.finish({ chatId: f.chat.id, owner: f.owner, completed: false });
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
  });

  it('does not aggregate a last sample with final statistics from another call', () => {
    const f = fixture();
    f.started();
    f.sampled();
    f.finished({ value: undefined });
    const second = assistant({ id: 'second-sampled-turn' });
    f.node.replies.items.push(second);
    f.chat.currentLeafId = second.id;
    f.started({ node: second });
    f.finished({ node: second, value: metrics({ n: 30 }) });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation).toMatchObject({
      scope: 'last',
      metrics: { nOutputTokens: 30 },
      calls: [{ snapshot: 'last_sample' }, {}],
    });
  });

  it('hides a completed measurement immediately when the same assistant is regenerated', () => {
    const f = fixture();
    f.started();
    f.finished({ value: metrics() });
    f.complete();
    expect(f.state.presentations({ chat: f.chat })).toHaveLength(1);
    f.state.start({ chatId: f.chat.id, owner: f.owner });
    f.started();
    expect(f.state.presentations({ chat: f.chat })).toEqual([]);
    f.sampled({ value: metrics({ n: 50 }) });
    expect(f.state.presentations({ chat: f.chat })).toHaveLength(1);
    expect(f.state.presentations({ chat: f.chat })[0]?.presentation.metrics.nOutputTokens).toBe(50);
  });

  it('bounds call history without claiming a truncated aggregate or renumbering retained calls', () => {
    const f = fixture();
    let node = f.node;
    for (let index = 0; index < 257; index++) {
      if (index !== 0) {
        const next = assistant({ id: `step-${index}` });
        node.replies.items.push(next);
        node = next;
      }
      f.started({ node });
      f.finished({ node, value: metrics() });
    }
    f.chat.currentLeafId = node.id;
    f.complete();
    const result = f.state.presentations({ chat: f.chat })[0]?.presentation;
    expect(result).toMatchObject({ scope: 'last', nOmittedCalls: 1, metrics: { nOutputTokens: 20 } });
    expect(result?.calls).toHaveLength(256);
  });

  it('retains every completed run until the page state is cleared', () => {
    const state = createGenerationMetricsState();
    for (let index = 0; index < 140; index++) {
      const chatId = toChatId({ raw: String(index) });
      const owner = new AbortController().signal;
      const node = assistant({ id: String(index) });
      state.start({ chatId, owner });
      state.observe({ chatId, owner, node, event: { type: 'started', messageId: node.id } });
      state.observe({ chatId, owner, node, event: { type: 'finished', messageId: node.id, result: { type: 'finished', next: 'user', generationMetrics: metrics() } } });
      state.finish({ chatId, owner, completed: true });
    }
    expect(state.TEST_ONLY?.runs.size).toBe(140);
    state.clear();
    expect(state.TEST_ONLY?.runs.size).toBe(0);
  });
});
