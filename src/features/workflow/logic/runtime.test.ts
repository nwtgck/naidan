import { describe, it, expect, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import { runtimeFixture, valueStep, literal, reference, stepId, baseStep } from './workflow.test-support';
import { materializeJson, readText } from './values';
import type { WorkflowStep } from '@/01-models/workflow';

describe('Sequential Workflow execution', () => {
  it('produces once and supports independent fan-out and joins', async () => {
    const generation = baseStep({ type: 'text_generation', id: 'generate' });
    const b = valueStep({ id: 'b', value: reference({ id: 'generate', output: 'text' }) });
    const c = valueStep({ id: 'c', value: reference({ id: 'generate', output: 'text' }) });
    await using run = await runtimeFixture({ definition: { name: '', steps: [generation, b, c] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.generate).toHaveBeenCalledTimes(1);
    for (const id of ['b', 'c']) {
      expect(await readText({ value: run.result.outputs.get(stepId({ raw: id }))!.value!, maxBytes: 100, signal: undefined })).toBe('generated');
    }
  });

  it('takes only one branch and publishes only explicit outputs', async () => {
    const branch: WorkflowStep = { id: stepId({ raw: 'branch' }), name: '', type: 'if', condition: literal({ value: false }), then: { steps: [baseStep({ type: 'text_generation', id: 'unused' })], outputs: { answer: literal({ value: 'unused' }) } }, else: { steps: [], outputs: { answer: literal({ value: 'right' }) } } };
    await using run = await runtimeFixture({ definition: { name: '', steps: [branch] }, overrides: {} });
    expect(run.generate).not.toHaveBeenCalled();
    expect(run.result.outputs.get(branch.id)).toMatchObject({ answer: { value: 'right' } });
  });

  it('rejects nonboolean conditions without truthiness coercion', async () => {
    const branch = baseStep({ type: 'if', id: 'if' });
    if (branch.type !== 'if') {
      throw new Error('fixture');
    }
    branch.condition = literal({ value: 'false' });
    await expect(runtimeFixture({ definition: { name: '', steps: [branch] }, overrides: {} })).rejects.toThrow('boolean');
    const parsed = { ...baseStep({ type: 'parse_json', id: 'parsed' }), type: 'parse_json' as const, source: literal({ value: '"false"' }) };
    branch.condition = reference({ id: 'parsed', output: 'value' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [parsed, branch] }, overrides: {} });
    expect(run.result.status).toBe('failed');
    expect(String(run.result.error)).toContain('boolean');
  });

  it('commits carried state atomically, including zero rounds', async () => {
    for (const rounds of [0, 1, 2, 3]) {
      const loop = baseStep({ type: 'repeat', id: 'loop' });
      if (loop.type !== 'repeat') {
        throw new Error('fixture');
      }
      loop.count = literal({ value: rounds });
      loop.state = { a: { initial: literal({ value: 'a' }), next: { type: 'loop_state', stepId: loop.id, key: 'b' } }, b: { initial: literal({ value: 'b' }), next: { type: 'loop_state', stepId: loop.id, key: 'a' } } };
      await using run = await runtimeFixture({ definition: { name: '', steps: [loop] }, overrides: {} });
      const state = await materializeJson({ value: run.result.outputs.get(loop.id)!.state!, signal: undefined });
      expect(state).toEqual(rounds % 2 ? { a: 'b', b: 'a' } : { a: 'a', b: 'b' });
    }
  });

  it('collects emitted items into replayable JSON Lines rather than a memory array', async () => {
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    if (loop.type !== 'for_each') {
      throw new Error('fixture');
    }
    loop.source = { type: 'literal', value: ['first', 'second'] };
    loop.emit = { type: 'loop_item', stepId: loop.id };
    const again = baseStep({ type: 'for_each', id: 'again' });
    if (again.type !== 'for_each') {
      throw new Error('fixture');
    }
    again.source = reference({ id: 'loop', output: 'items' });
    again.emit = { type: 'loop_item', stepId: again.id };
    await using run = await runtimeFixture({ definition: { name: '', steps: [loop, again] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    const output = run.result.outputs.get(again.id)!.items!;
    expect(output.type).toBe('sequence');
    if (output.type !== 'sequence') {
      throw new Error('fixture');
    }
    expect(await readText({ value: { type: 'text', output: output.output }, maxBytes: 100, signal: undefined })).toBe(`\
"first"
"second"
`);
  });

  it('keeps generation memory bounded across iterations when results are not collected', async () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    loop.count = literal({ value: 100 });
    loop.body.steps = [baseStep({ type: 'text_generation', id: 'generate' })];
    await using run = await runtimeFixture({ definition: { name: '', steps: [loop] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.generate).toHaveBeenCalledTimes(100);
    expect(run.store.getUsage().entries).toBe(0);
  });

  it('starts each debate turn with a user message and keeps independent histories', async () => {
    const loop = baseStep({ type: 'repeat', id: 'debate' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    const a = baseStep({ type: 'text_generation', id: 'a' }), b = baseStep({ type: 'text_generation', id: 'b' });
    if (a.type !== 'text_generation' || b.type !== 'text_generation') {
      throw new Error('fixture');
    }
    loop.count = literal({ value: 3 });
    loop.state = {
      a: { initial: { type: 'conversation', messages: [] }, next: reference({ id: 'a', output: 'conversation' }) },
      b: { initial: { type: 'conversation', messages: [] }, next: reference({ id: 'b', output: 'conversation' }) },
      reply: { initial: literal({ value: 'Debate this topic.' }), next: reference({ id: 'b', output: 'text' }) },
    };
    a.conversation = { type: 'loop_state', stepId: loop.id, key: 'a' };
    a.appendMessages = [{ role: 'user', parts: [{ type: 'value', value: { type: 'loop_state', stepId: loop.id, key: 'reply' } }] }];
    b.conversation = { type: 'loop_state', stepId: loop.id, key: 'b' };
    b.appendMessages = [{ role: 'user', parts: [{ type: 'value', value: reference({ id: 'a', output: 'text' }) }] }];
    loop.body.steps = [a, b];
    const roles: string[][] = [];
    await using run = await runtimeFixture({
      definition: { name: '', steps: [loop] },
      overrides: {
        onStep: async ({ outputs }) => {
          const value = outputs?.conversation;
          if (value?.type === 'conversation') {
            roles.push(value.messages.map(message => message.role));
          }
        },
      },
    });
    expect(run.result.status).toBe('completed');
    expect(run.generate).toHaveBeenCalledTimes(6);
    expect(roles.map(role => role.join(','))).toEqual(['user,assistant', 'user,assistant', 'user,assistant,user,assistant', 'user,assistant,user,assistant', 'user,assistant,user,assistant,user,assistant', 'user,assistant,user,assistant,user,assistant']);
  });

  it('retains completed outputs when a later step fails', async () => {
    const a = baseStep({ type: 'text_generation', id: 'a' });
    const fail = baseStep({ type: 'parse_json', id: 'fail' });
    if (fail.type !== 'parse_json') {
      throw new Error('fixture');
    }
    fail.source = literal({ value: 'not json' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [a, fail] }, overrides: {} });
    expect(run.result.status).toBe('failed');
    expect(await readText({ value: run.result.outputs.get(a.id)!.text!, maxBytes: 100, signal: undefined })).toBe('generated');
  });

  it('does not run side effects behind a false branch', async () => {
    const file = baseStep({ type: 'write_file', id: 'file' });
    if (file.type !== 'write_file') {
      throw new Error('fixture');
    }
    file.volumeId = toVolumeId({ raw: 'volume' });
    const branch: WorkflowStep = { id: stepId({ raw: 'if' }), name: '', type: 'if', condition: literal({ value: false }), then: { steps: [file], outputs: {} }, else: { steps: [], outputs: {} } };
    const write = vi.fn(async () => ({}));
    await using run = await runtimeFixture({ definition: { name: '', steps: [branch] }, overrides: { writeFile: write } });
    expect(write).not.toHaveBeenCalled();
    expect(run.result.status).toBe('completed');
  });

  it('builds paths structurally and rejects injected path separators', async () => {
    const path = valueStep({ id: 'path', value: { type: 'path', items: [literal({ value: 'images' }), { type: 'concat', items: [{ type: 'format_number', value: literal({ value: 1 }), minDigits: 3 }, literal({ value: '-' }), { type: 'filename', value: literal({ value: '../title' }) }, literal({ value: '.png' })] }] } });
    await using run = await runtimeFixture({ definition: { name: '', steps: [path] }, overrides: {} });
    expect(run.result.outputs.get(path.id)).toMatchObject({ value: { value: 'images/001-.._title.png' } });
    path.value = { type: 'path', items: [literal({ value: '../escape' })] };
    await using denied = await runtimeFixture({ definition: { name: '', steps: [path] }, overrides: {} });
    expect(denied.result.status).toBe('failed');
  });

  it('composes nested loop collections without a special flattening step or an in-memory result array', async () => {
    const outer = baseStep({ type: 'repeat', id: 'outer' });
    const inner = baseStep({ type: 'repeat', id: 'inner' });
    if (outer.type !== 'repeat' || inner.type !== 'repeat') {
      throw new Error('fixture');
    }
    outer.count = literal({ value: 2 });
    inner.count = literal({ value: 3 });
    inner.emit = { type: 'object', properties: { outer: { type: 'loop_index', stepId: outer.id }, inner: { type: 'loop_index', stepId: inner.id } } };
    outer.body.steps = [inner];
    outer.emit = reference({ id: 'inner', output: 'items' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [outer] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    const items = run.result.outputs.get(outer.id)!.items!;
    expect(items.type).toBe('sequence');
    expect(await materializeJson({ value: items, signal: undefined })).toEqual([
      [{ outer: 0, inner: 0 }, { outer: 0, inner: 1 }, { outer: 0, inner: 2 }],
      [{ outer: 1, inner: 0 }, { outer: 1, inner: 1 }, { outer: 1, inner: 2 }],
    ]);
    expect(run.store.getUsage().entries).toBe(1);
  });
});
