import { describe, expect, it, vi } from 'vitest';
import type { Endpoint } from '@/01-models/types';
import type { WorkflowModelConfiguration } from '@/01-models/workflow';
import { toNaidanRpcRegistrationId } from '@/01-models/ids';
import { createWorkflowModelPermissions, describeWorkflowConnection, TEST_ONLY } from './model-permissions';
import type { WorkflowValueSource } from './provenance';

function target({ endpoint, modelId }: { endpoint?: Endpoint, modelId?: string }): WorkflowModelConfiguration {
  return { endpoint: endpoint ?? { type: 'ollama', url: 'http://localhost:11434', httpHeaders: [['Authorization', 'secret']] }, modelId: modelId ?? 'model', lmParameters: undefined };
}

function fixture() {
  const permissions = createWorkflowModelPermissions();
  const controller = new AbortController();
  const request = vi.fn(async () => true);
  const authorize = ({ run, value, sources }: { run: ReturnType<typeof permissions.beginRun>, value: WorkflowModelConfiguration, sources?: readonly WorkflowValueSource[] }) => run.authorize({ target: value, sources: sources ?? ['definition'], signal: controller.signal, request });
  return {
    permissions,
    controller,
    request,
    authorize,
    [Symbol.dispose]() {
      controller.abort();
    },
  };
}

describe('Workflow model authority', () => {
  it('reuses an explicitly selected fixed target without calling approval', async () => {
    using test = fixture();
    test.permissions.review({ target: target({}) });
    for (let index = 0; index < 3; index++) {
      await test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    }
    expect(test.request).not.toHaveBeenCalled();
  });

  it('does not treat definition provenance as approval of an imported literal', async () => {
    using test = fixture();
    await test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    expect(test.request).toHaveBeenCalledOnce();
    expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ review: expect.objectContaining({ scope: 'editing_session' }) }));
    await test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    expect(test.request).toHaveBeenCalledOnce();
  });

  it.each(['model_output', 'file_input', 'interactive_input', 'unknown'] as const)('requires a separate per-run grant for %s even at a reviewed fixed target', async source => {
    using test = fixture();
    test.permissions.review({ target: target({}) });
    const run = test.permissions.beginRun();
    await test.authorize({ run, value: target({}), sources: [source] });
    await test.authorize({ run, value: target({}), sources: ['definition', source] });
    expect(test.request).toHaveBeenCalledOnce();
    expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ review: expect.objectContaining({ scope: 'run' }) }));
    await test.authorize({ run: test.permissions.beginRun(), value: target({}), sources: [source] });
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('fails closed on missing evidence, and never promotes dynamic approval to future fixed approval', async () => {
    using test = fixture();
    await test.authorize({ run: test.permissions.beginRun(), value: target({}), sources: [] });
    await test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('takes the fixed target snapshot before asynchronous run setup', async () => {
    using test = fixture();
    const started = test.permissions.beginRun();
    test.permissions.review({ target: target({}) });
    await test.authorize({ run: started, value: target({}) });
    expect(test.request).toHaveBeenCalledOnce();
  });

  it('does not import approvals after a document switch or explicit clearing', async () => {
    using test = fixture();
    const gate = Promise.withResolvers<boolean>();
    test.request.mockReturnValueOnce(gate.promise);
    const pending = test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    test.permissions.reset();
    gate.resolve(true);
    await pending;
    await test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'URL', value: target({ endpoint: { type: 'ollama', url: 'http://different.example/' } }) },
    { name: 'header value', value: target({ endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: [['Authorization', 'different']] } }) },
    { name: 'header presence', value: target({ endpoint: { type: 'ollama', url: 'http://localhost:11434' } }) },
    { name: 'model', value: target({ modelId: 'different' }) },
    { name: 'backend', value: target({ endpoint: { type: 'openai', url: 'http://localhost:11434', httpHeaders: [['Authorization', 'secret']] } }) },
  ])('does not broaden approval across a changed $name', async ({ value }) => {
    using test = fixture();
    test.permissions.review({ target: target({}) });
    await test.authorize({ run: test.permissions.beginRun(), value });
    expect(test.request).toHaveBeenCalledOnce();
  });

  it('ignores generation parameter changes but retains exact header order and RPC identity', async () => {
    using test = fixture();
    const value = target({});
    test.permissions.review({ target: value });
    await test.authorize({ run: test.permissions.beginRun(), value: { ...value, lmParameters: { temperature: 0.8, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } } });
    expect(test.request).not.toHaveBeenCalled();
    const endpoint: Endpoint = { type: 'naidan_rpc', registrationId: toNaidanRpcRegistrationId({ raw: 'first' }) };
    test.permissions.review({ target: target({ endpoint }) });
    await test.authorize({ run: test.permissions.beginRun(), value: target({ endpoint: { type: 'naidan_rpc', registrationId: toNaidanRpcRegistrationId({ raw: 'second' }) } }) });
    expect(test.request).toHaveBeenCalledOnce();
    const headers: [string, string][] = [['A', '1'], ['B', '2']];
    test.permissions.review({ target: target({ endpoint: { type: 'ollama', url: 'http://localhost', httpHeaders: headers } }) });
    await test.authorize({ run: test.permissions.beginRun(), value: target({ endpoint: { type: 'ollama', url: 'http://localhost', httpHeaders: [...headers].reverse() } }) });
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('does not cache denial or an approval arriving after cancellation', async () => {
    using test = fixture();
    test.request.mockResolvedValueOnce(false);
    await expect(test.authorize({ run: test.permissions.beginRun(), value: target({}) })).rejects.toThrow('denied');
    const gate = Promise.withResolvers<boolean>();
    test.request.mockReturnValueOnce(gate.promise);
    const pending = test.authorize({ run: test.permissions.beginRun(), value: target({}) });
    test.controller.abort(new Error('stopped'));
    gate.resolve(true);
    await expect(pending).rejects.toThrow('stopped');
    const request = vi.fn(async () => true);
    await test.permissions.beginRun().authorize({ target: target({}), sources: ['definition'], signal: new AbortController().signal, request });
    expect(request).toHaveBeenCalledOnce();
  });

  it('checks cancellation on the cached path too', async () => {
    using test = fixture();
    test.permissions.review({ target: target({}) });
    test.controller.abort(new Error('stopped'));
    await expect(test.authorize({ run: test.permissions.beginRun(), value: target({}) })).rejects.toThrow('stopped');
    expect(test.request).not.toHaveBeenCalled();
  });

  it('rejects a mutable target changing while its prompt is pending', async () => {
    using test = fixture();
    const gate = Promise.withResolvers<boolean>();
    test.request.mockReturnValueOnce(gate.promise);
    const value = target({});
    const pending = test.authorize({ run: test.permissions.beginRun(), value });
    value.modelId = 'changed';
    gate.resolve(true);
    await expect(pending).rejects.toThrow('changed during review');
    await test.authorize({ run: test.permissions.beginRun(), value });
    expect(test.request).toHaveBeenCalledTimes(2);
  });

  it('does not open parallel approval requests within a sequential run', async () => {
    using test = fixture();
    const gate = Promise.withResolvers<boolean>();
    test.request.mockReturnValueOnce(gate.promise);
    const run = test.permissions.beginRun();
    const pending = test.authorize({ run, value: target({}) });
    await expect(test.authorize({ run, value: target({ modelId: 'other' }) })).rejects.toThrow('active');
    gate.resolve(true);
    await pending;
  });

  it.each(['javascript:alert(1)', 'file:///tmp/model', '/relative', 'not an address'])('rejects invalid connection %s before asking or granting', async url => {
    using test = fixture();
    const value = target({ endpoint: { type: 'ollama', url } });
    test.permissions.review({ target: value });
    await expect(test.authorize({ run: test.permissions.beginRun(), value })).rejects.toThrow('absolute HTTP');
    expect(test.request).not.toHaveBeenCalled();
  });

  it('bounds remembered targets and refuses to cache oversized identities', async () => {
    using test = fixture();
    for (let index = 0; index <= TEST_ONLY.MAX_REVIEWED_TARGETS; index++) {
      test.permissions.review({ target: target({ modelId: String(index) }) });
    }
    await test.authorize({ run: test.permissions.beginRun(), value: target({ modelId: '0' }) });
    expect(test.request).toHaveBeenCalledOnce();
    const large = target({ endpoint: { type: 'ollama', url: 'http://localhost', httpHeaders: [['Authorization', 'x'.repeat(TEST_ONLY.MAX_IDENTITY_LENGTH)]] } });
    const run = test.permissions.beginRun();
    await test.authorize({ run, value: large });
    await test.authorize({ run, value: large });
    expect(test.request).toHaveBeenCalledTimes(3);
  });

  it('redacts common credential locations while keeping a structured, non-executable target description', () => {
    const review = describeWorkflowConnection({ target: target({ endpoint: { type: 'openai', url: 'https://user:password@example.com/v1?token=secret&token=another#private', httpHeaders: [['Authorization', 'bearer secret']] } }), scope: 'run', sources: ['model_output'] });
    expect(review.endpoint).toContain('example.com/v1');
    expect(review.headerNames).toEqual(['Authorization']);
    for (const secret of ['user', 'password', 'secret', 'another', 'private', 'bearer']) {
      expect(JSON.stringify(review)).not.toContain(secret);
    }
  });
});
