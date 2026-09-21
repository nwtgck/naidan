import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ImportExportService, type IImportExportStorage } from './service';
import type { ImportConfig } from './types';
import { EMPTY_LM_PARAMETERS, type Settings, type StorageSnapshot } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Exercise the existing archive DTO boundary until it is moved behind the storage service.
import { ChatSchemaDto, ChatContentSchemaDto, type ChatDto, type MigrationChunkDto } from '@/00-storage/00-dto/dto';
import { IMAGE_BLOCK_LANG } from '@/utils/image-generation';

vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn() }) }));
const config = ({ mode }: { mode: 'replace' | 'append' }): ImportConfig => ({
  data: { mode }, settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
});
const settings: Settings = {
  endpoint: { type: 'ollama', url: 'http://localhost:11434' }, storageType: 'local',
  titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS },
  providerProfiles: [], mounts: [], defaultModelId: undefined, heavyContentAlertDismissed: undefined,
  systemPrompt: undefined, lmParameters: undefined,
};
const chat = ({ root }: { root: unknown }): ChatDto => ChatSchemaDto.parse({
  id: 'chat', title: 'Parts', createdAt: 1, updatedAt: 2, debugEnabled: false,
  currentLeafId: 'a', titleGeneration: 'inherit', root,
});
const marker = ({ id }: { id: string }) => `\`\`\`${IMAGE_BLOCK_LANG}\n{ "binaryObjectId": "${id}", "displayWidth": 32, "displayHeight": 32, "unknown": { "binaryObjectId": "do-not-change" } }\n\`\`\``;
function binary({ id }: { id: string }): Extract<MigrationChunkDto, { type: 'binary_object' }> {
  return { type: 'binary_object', id, name: `${id}.bin`, mimeType: 'application/octet-stream', size: 4, createdAt: 1, blob: new Blob(['body']) };
}
function fixture() {
  const received: MigrationChunkDto[] = [];
  const storage = {
    loadSettings: vi.fn(async () => settings), updateSettings: vi.fn(async () => {}),
    listChats: vi.fn(async () => []), listChatGroups: vi.fn(async () => []), loadChat: vi.fn(async () => null),
    loadHierarchy: vi.fn(async () => ({ items: [] })), clearAll: vi.fn(async () => {}),
    dumpWithoutLock: vi.fn<() => Promise<StorageSnapshot>>(),
    restore: vi.fn(async ({ snapshot }: { snapshot: StorageSnapshot }) => {
      for await (const chunk of snapshot.contentStream) received.push(chunk);
    }),
  } satisfies IImportExportStorage;
  return { storage, received, service: new ImportExportService({ storage }) };
}
async function archive({ content }: { content: ChatDto }): Promise<JSZip> {
  const zip = new JSZip();
  zip.file('export-manifest.json', '{}');
  zip.file('chat-metas.json', JSON.stringify({ entries: [{ ...content, root: undefined, messages: undefined }] }));
  zip.file('chat-contents/chat.json', JSON.stringify({ root: content.root, currentLeafId: content.currentLeafId }));
  return zip;
}
function addBinary({ zip, id }: { zip: JSZip; id: string }): void {
  const dir = `binary-objects/${id.slice(-2)}`;
  zip.file(`${dir}/${id}.bin`, 'body');
  zip.file(`${dir}/index.json`, JSON.stringify({ objects: { [id]: { id, mimeType: 'application/octet-stream', size: 4, createdAt: 1, name: id } } }));
}
async function readExport({ stream }: { stream: ReadableStream<Uint8Array> }): Promise<JSZip> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break; chunks.push(Uint8Array.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSZip.loadAsync(new Blob(chunks));
}
async function exportedContent({ zip }: { zip: JSZip }) {
  const name = Object.keys(zip.files).find(name => name.endsWith('chat-contents/chat.json'));
  if (!name) throw new Error('Missing exported chat.');
  return ChatContentSchemaDto.parse(JSON.parse(await zip.file(name)!.async('string')));
}
function dump({ storage, content, binaries }: { storage: ReturnType<typeof fixture>['storage']; content: ChatDto; binaries: string[] }): void {
  storage.dumpWithoutLock.mockResolvedValue({
    structure: { settings, hierarchy: { items: [] }, chatMetas: [], chatGroups: [] },
    contentStream: (async function* () {
      for (const id of binaries) yield binary({ id }); yield { type: 'chat', data: content };
    })(),
  });
}
function modernAssistant({ parts }: { parts: unknown[] }) {
  return { id: 'a', role: 'assistant', createdAt: 0, parts,
    interruption: { type: 'error', message: '接続が切れました: offline' }, replies: { items: [] } };
}

beforeEach(() => vi.clearAllMocks());
describe('parts archive boundaries', () => {
  it('exports V1 as V2 without re-parsing tags or normalizing reasoning', async () => {
    const f = fixture();
    dump({ storage: f.storage, content: chat({ root: { items: [{ id: 'a', role: 'assistant', timestamp: 7,
      thinking: '  R\n', content: `\
<think>literal</think>
 [Generation Aborted] `, replies: { items: [] } }] } }), binaries: [] });
    const content = await exportedContent({ zip: await readExport(await f.service.exportData({})) });
    const a = content.root.items[0]!;
    expect(a.parts).toEqual([expect.objectContaining({ type: 'reasoning', text: '  R\n' }), expect.objectContaining({ type: 'text', text: `\
<think>literal</think>
 [Generation Aborted] ` })]);
    if (a.parts === undefined) throw new Error('Expected V2.');
    expect(a.createdAt).toBe(7); expect('timestamp' in a).toBe(false); expect('thinking' in a).toBe(false);
    expect(f.storage.restore).not.toHaveBeenCalled(); expect(f.storage.clearAll).not.toHaveBeenCalled();
  });
  it('keeps empty and repeated parts, partial state, time, and recorded error language', async () => {
    const a = modernAssistant({ parts: [{ id: 'r', type: 'reasoning', text: '' }, { id: 't1', type: 'text', text: '' }, { id: 't2', type: 'text', text: '  🙂\r\n', completeness: 'partial' }] });
    const original = chat({ root: { items: [a] } }); const before = JSON.stringify(original); const f = fixture();
    dump({ storage: f.storage, content: original, binaries: [] });
    const content = await exportedContent({ zip: await readExport(await f.service.exportData({})) });
    expect(content.root.items).toEqual(original.root?.items); expect(JSON.stringify(original)).toBe(before);
  });
  it('filters current-thread binary references from text and success/error tool results', async () => {
    const root = { items: [modernAssistant({ parts: [{ id: 't', type: 'text', text: marker({ id: 'image' }) }] })] };
    const content = chat({ root: { items: [{ ...root.items[0], replies: { items: [
      { id: 'tool', role: 'tool', createdAt: 1, parts: [
        { id: 'r1', type: 'tool_result', result: { toolCallId: 'c1', status: 'success', content: { type: 'binary_object', id: 'good' } } },
        { id: 'r2', type: 'tool_result', result: { toolCallId: 'c2', status: 'error', error: { code: 'other', message: { type: 'binary_object', id: 'error' } } } },
      ], replies: { items: [] } },
      { id: 'other', role: 'assistant', createdAt: 2, parts: [{ id: 'p', type: 'text', text: marker({ id: 'other-image' }) }], replies: { items: [] } },
    ] } }] } }); content.currentLeafId = 'tool';
    const f = fixture(); dump({ storage: f.storage, content, binaries: ['image', 'good', 'error', 'other-image'] });
    const zip = await readExport(await f.service.exportData({ exclude: ['chat_history'] }));
    for (const id of ['image', 'good', 'error']) expect(Object.keys(zip.files).some(name => name.endsWith(`/${id}.bin`))).toBe(true);
    expect(Object.keys(zip.files).some(name => name.endsWith('/other-image.bin'))).toBe(false);
    const saved = await exportedContent({ zip }); expect(saved.root.items[0]!.replies.items).toHaveLength(1);
  });
  it('appends V2 with stable part IDs, all binary reference forms, and no call re-execution', async () => {
    const parts = [
      { id: 'r', type: 'reasoning', text: marker({ id: 'image' }) },
      { id: 't', type: 'text', text: `leading\n${marker({ id: 'image' })}\ntrailing` },
      { id: 'c', type: 'tool_call', toolCall: { id: 'call', type: 'function', function: { name: 'f', arguments: '{"binaryObjectId":"image"}' } } },
    ];
    const dto = chat({ root: { items: [{ ...modernAssistant({ parts }), replies: { items: [{ id: 'tool', role: 'tool', createdAt: 1, parts: [
      { id: 'ok', type: 'tool_result', result: { toolCallId: 'call', status: 'success', content: { type: 'binary_object', id: 'image' } } },
      { id: 'bad', type: 'tool_result', result: { toolCallId: 'call', status: 'error', error: { code: 'other', message: { type: 'binary_object', id: 'error' } } } },
    ], replies: { items: [] } }] } }] } }); dto.currentLeafId = 'tool';
    const zip = await archive({ content: dto }); addBinary({ zip, id: 'image' }); addBinary({ zip, id: 'error' });
    const f = fixture(); await f.service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: config({ mode: 'append' }) });
    const imported = f.received.find(chunk => chunk.type === 'chat'); if (imported?.type !== 'chat') throw new Error('No imported content.');
    const assistant = imported.data.root?.items[0]; if (assistant?.role !== 'assistant' || !assistant.parts) throw new Error('No assistant.');
    const binaries = f.received.filter(chunk => chunk.type === 'binary_object');
    expect(binaries).toHaveLength(2); expect(binaries.map(b => b.id)).not.toContain('image');
    expect(assistant.parts.map(p => p.id)).toEqual(['r', 't', 'c']);
    const image = binaries.find(b => b.name === 'image')!;
    expect(assistant.parts[0]).toMatchObject({ text: marker({ id: 'image' }) });
    expect(assistant.parts[1]).toMatchObject({ text: `leading\n${marker({ id: image.id })}\ntrailing` });
    expect(assistant.parts[2]).toMatchObject({ toolCall: parts[2]!.toolCall });
    const tool = assistant.replies.items[0]; if (tool?.role !== 'tool') throw new Error('No tool.');
    expect(tool.parts[0]).toMatchObject({ result: { content: { id: image.id } } });
    expect(tool.parts[1]).toMatchObject({ result: { error: { message: { id: binaries.find(b => b.name === 'error')!.id } } } });
    expect(imported.data.currentLeafId).toBe(tool.id); expect(f.storage.clearAll).not.toHaveBeenCalled();
  });
  it('remaps escaped top-level image keys while leaving nested metadata and invalid blocks alone', async () => {
    const raw = marker({ id: 'image' }).replace('"binaryObjectId"', '"binary\\u004fbjectId"') + `\n\`\`\`${IMAGE_BLOCK_LANG}\nnot-json\n\`\`\``;
    const zip = await archive({ content: chat({ root: { items: [modernAssistant({ parts: [{ id: 't', type: 'text', text: raw }] })] } }) }); addBinary({ zip, id: 'image' });
    const f = fixture(); await f.service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: config({ mode: 'append' }) });
    const imported = f.received.find(c => c.type === 'chat'); const binary = f.received.find(c => c.type === 'binary_object');
    if (imported?.type !== 'chat' || binary?.type !== 'binary_object') throw new Error('Missing restored chunks.');
    expect(imported.data.root?.items[0]?.parts?.[0]).toMatchObject({ text: raw.replace('"image"', JSON.stringify(binary.id)) });
  });
  for (const mode of ['replace', 'append'] as const) {
    it(`preflights corrupt V2 before ${mode} mutates storage`, async () => {
      const dto = chat({ root: { items: [modernAssistant({ parts: [] })] } });
      const zip = await archive({ content: dto });
      zip.file('chat-contents/chat.json', JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', createdAt: 0, content: 'legacy lure', timestamp: 0, parts: null, replies: { items: [] } }] } }));
      const f = fixture(); await expect(f.service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: config({ mode }) })).rejects.toThrow(/chat content/);
      expect(f.storage.clearAll).not.toHaveBeenCalled(); expect(f.storage.updateSettings).not.toHaveBeenCalled(); expect(f.storage.restore).not.toHaveBeenCalled();
    });
    it(`restores valid V2 in ${mode} without interpreting a literal think block`, async () => {
      const dto = chat({ root: { items: [modernAssistant({ parts: [{ id: 'p', type: 'text', text: '<think> literal </think>', completeness: 'partial' }] })] } });
      const zip = await archive({ content: dto }); const f = fixture();
      await f.service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: config({ mode }) });
      const imported = f.received.find(c => c.type === 'chat'); if (imported?.type !== 'chat') throw new Error('No chat.');
      expect(imported.data.root?.items[0]).toMatchObject({ createdAt: 0, interruption: { type: 'error', message: '接続が切れました: offline' }, parts: [{ id: 'p', type: 'text', text: '<think> literal </think>', completeness: 'partial' }] });
    });
  }
});
