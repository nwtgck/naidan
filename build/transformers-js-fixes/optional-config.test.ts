// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { applyTransformersJsFixes } from './transform';

const original = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
const { code } = applyTransformersJsFixes({ code: original, version: '4.2.0' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve; reject = onReject;
  });
  return { promise, resolve, reject };
}

function modelFixture({ names, read, select, create }: {
  names: Record<string, string> | undefined;
  read: (modelId: string, file: string, fatal: boolean, options: object) => Promise<unknown>;
  select: () => Record<string, string>;
  create: () => Promise<unknown>;
}) {
  const from = code.indexOf('    const { typeConfig, textOnly, modelType } = resolveTypeConfig(modelName, config);');
  const end = code.indexOf('    return new this(config, ...info);', from) + '    return new this(config, ...info);'.length;
  const optionalFrom = code.indexOf('async function get_optional_configs(');
  const optionalEnd = code.indexOf('// src/models/models.js', optionalFrom);
  if (from < 0 || end <= from || optionalFrom < 0 || optionalEnd <= optionalFrom) throw new Error('Upstream preparation sections were not found');
  // Execute the same transformed source as Vite. Only the JSON reader, session
  // selector and backend are fixtures; no test-only source replacement exists.
  const execute = new Function('getModelJSON', 'constructSessions', 'resolveTypeConfig', `\
const config = { fixture: true };
const options = { revision: 'synthetic-exact' };
function Fixture(config, ...info) { this.config = config; this.info = info; }
async function load() {
  const pretrained_model_name_or_path = 'synthetic/model';
  const modelName = 'Fixture';
  const progress_callback = null;
${code.slice(from, end)}
}
${code.slice(optionalFrom, optionalEnd)}
return () => load.call(Fixture);
`);
  return execute(read, create, () => ({
    typeConfig: { sessions: select, optional_configs: names }, textOnly: false, modelType: 0,
  })) as () => Promise<{ config: unknown; info: unknown[] }>;
}

it('does not select or create sessions until optional configuration preparation has completed', async () => {
  const pending = deferred<unknown>();
  const read = vi.fn(() => pending.promise);
  const select = vi.fn(() => ({ model: 'model' }));
  const create = vi.fn(async () => 'session');
  const result = modelFixture({ names: { generation_config: 'generation_config.json' }, read, select, create })();
  try {
    expect(read).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  } finally {
    pending.resolve({});
    await result;
  }
});

it('retains the optional configuration failure origin and cause without creating a session', async () => {
  const failure = new SyntaxError('Synthetic malformed JSON');
  const create = vi.fn(async () => 'session');
  const result = modelFixture({
    names: { generation_config: 'generation_config.json' },
    read: async () => {
      throw failure;
    }, select: () => ({ model: 'model' }), create,
  })();
  const error = await result.catch((error: unknown) => error);
  expect(error).toMatchObject({ name: 'TransformersJsOptionalConfigurationError', cause: failure });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('generation_config.json');
  expect((error as Error).message).toContain('SyntaxError: Synthetic malformed JSON');
  expect(create).not.toHaveBeenCalled();
});

it('reports optional preparation failure before a session selector can fail', async () => {
  const failure = new SyntaxError('Synthetic optional failure');
  const select = vi.fn(() => {
    throw new Error('Synthetic selector failure');
  });
  const create = vi.fn(async () => 'session');
  const result = modelFixture({
    names: { generation_config: 'generation_config.json' }, read: async () => {
      throw failure;
    }, select, create,
  })();
  await expect(result).rejects.toMatchObject({ name: 'TransformersJsOptionalConfigurationError', cause: failure });
  expect(select).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it('preserves constructor arity when the family has no optional configurations', async () => {
  const read = vi.fn(async () => ({}));
  const result = await modelFixture({ names: undefined, read, select: () => ({ model: 'model' }), create: async () => 'session' })();
  expect(result.info).toEqual(['session']);
  expect(read).not.toHaveBeenCalled();
});

it('preserves the empty optional mapping as an additional constructor argument', async () => {
  const read = vi.fn(async () => ({}));
  const result = await modelFixture({ names: {}, read, select: () => ({ model: 'model' }), create: async () => 'session' })();
  expect(result.info).toEqual(['session', {}]);
  expect(read).not.toHaveBeenCalled();
});

it('preserves the JSON reader default for absent optional files', async () => {
  const absentDefault = {};
  const read = vi.fn(async () => absentDefault);
  const result = await modelFixture({ names: { generation_config: 'generation_config.json' }, read, select: () => ({ model: 'model' }), create: async () => 'session' })();
  expect(read).toHaveBeenCalledExactlyOnceWith('synthetic/model', 'generation_config.json', false, { revision: 'synthetic-exact' });
  expect(result.info).toEqual(['session', { generation_config: {} }]);
  expect((result.info[1] as { generation_config: unknown }).generation_config).toBe(absentDefault);
});

it('does not relabel a session failure after successful optional preparation', async () => {
  const failure = new Error('Synthetic backend failure');
  const result = modelFixture({
    names: { generation_config: 'generation_config.json' }, read: async () => ({ eos_token_id: 2 }),
    select: () => ({ model: 'model' }), create: async () => {
      throw failure;
    },
  })();
  await expect(result).rejects.toBe(failure);
});

it('observes a later optional rejection after the first optional failure', async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const create = vi.fn(async () => 'session');
  const result = modelFixture({ names: { first: 'first.json', second: 'second.json' }, read, select: () => ({ model: 'model' }), create })();
  const failure = new Error('First optional failure');
  const observed = result.catch((error: unknown) => error);
  first.reject(failure);
  try {
    expect(await observed).toMatchObject({ name: 'TransformersJsOptionalConfigurationError', cause: failure });
    expect(create).not.toHaveBeenCalled();
  } finally {
    second.reject(new Error('Second optional failure'));
    // Pass the host rejection-reporting turn without suppressing unhandled errors.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});
