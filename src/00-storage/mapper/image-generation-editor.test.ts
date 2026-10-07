import { expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { ExperimentalRemoteImageModelEditorSchemaDto } from '@/00-storage/00-dto/experimental.dto';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import { settingsToDomain, settingsToDto } from './mappers';

it('round trips a remote editor separately from the local selection without rewriting remote paths', () => {
  const connectionId = toNaidanRpcConnectionId({ raw: 'connection-one' }), peerId = toNaidanRpcPeerId({ raw: 'B'.repeat(43) });
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    storageType: 'local',
    endpoint: { type: 'openai', url: '' },
    experimental: {
    browserImageGeneration: {
    modelSelection: { primary: { slot: 'model', location: { kind: 'opfs', path: 'models/local.gguf' } }, components: [], loras: [] },
    inferenceLocation: { kind: 'naidan_rpc', connection: { connectionId, peerId } },
    remoteModelEditors: [{ connectionId, peerId, editor: { primary: undefined, components: [], loras: [{ file: { location: { kind: 'host', directoryId: 'remote-directory', path: 'models/ off.gguf' }, expected: { size: 16, lastModified: 123 } }, strength: 0.7, enabled: 'disabled' }] } }],
  },
  },
  };
  const actual = settingsToDomain({ dto: SettingsSchemaDto.parse(settingsToDto({ domain: settings })) });
  expect(actual.experimental?.browserImageGeneration).toMatchObject(settings.experimental!.browserImageGeneration!);
  expect(actual.experimental?.browserImageGeneration?.remoteModelEditors?.[0]?.editor.primary).toBeUndefined();
});
it('accepts future object fields without mutating the known editor values', () => {
  const editor = ExperimentalRemoteImageModelEditorSchemaDto.parse({ primary: undefined, components: [], loras: [], future: 'field' });
  expect(editor).toEqual({ primary: undefined, components: [], loras: [] });
});
it('rejects duplicate component slots and invalid adapter controls', () => {
  const file = { location: { kind: 'opfs', path: 'models/test.gguf' } };
  expect(ExperimentalRemoteImageModelEditorSchemaDto.safeParse({ primary: undefined, components: [{ slot: 'vae', file }, { slot: 'vae', file }], loras: [] }).success).toBe(false);
  expect(ExperimentalRemoteImageModelEditorSchemaDto.safeParse({ primary: undefined, components: [], loras: [{ file, strength: Number.NaN, enabled: 'disabled' }] }).success).toBe(false);
});
