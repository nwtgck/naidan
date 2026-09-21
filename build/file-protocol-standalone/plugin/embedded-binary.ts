import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import type { Plugin } from 'vite';

export type StandaloneEmbeddedBinary = Readonly<{
  virtualId: string;
  filePath: string;
  bytes: number;
  sha256: string;
}>;

type BinaryDiagnostic = {
  virtualId: string;
  sourcePath: string;
  bytes: number;
  sha256: string;
  gzipBytes: number;
  base64Bytes: number;
  owners: string[];
};

/** Only explicitly registered inputs become lazy JavaScript modules, never assets. */
export function createEmbeddedBinaryPlugin({ binaries, diagnostics }: {
  binaries: readonly StandaloneEmbeddedBinary[];
  diagnostics: Record<string, unknown>;
}): Plugin {
  const inputs = new Map<string, StandaloneEmbeddedBinary>();
  const sources = new Set<string>();
  const records = new Map<string, BinaryDiagnostic>();
  for (const binary of binaries) {
    if (!binary.virtualId.startsWith('virtual:file-protocol-standalone/binary/')
      || binary.virtualId.includes('\0') || inputs.has(binary.virtualId)
      || !path.isAbsolute(binary.filePath) || sources.has(path.resolve(binary.filePath))
      || !Number.isSafeInteger(binary.bytes) || binary.bytes < 0 || !/^[a-f0-9]{64}$/.test(binary.sha256)) {
      throw new Error('Invalid or duplicate standalone embedded binary registration');
    }
    inputs.set(binary.virtualId, binary);
    sources.add(path.resolve(binary.filePath));
  }
  return {
    name: 'naidan-file-protocol-standalone-embedded-binary',
    enforce: 'pre',
    buildStart() {
      records.clear();
      diagnostics.embeddedBinaries = [];
    },
    resolveId(id) {
      return inputs.has(id) ? `\0${id}` : undefined;
    },
    load(id) {
      if (!id.startsWith('\0')) return;
      const input = inputs.get(id.slice(1));
      if (!input) return;
      this.addWatchFile(input.filePath);
      const bytes = readFileSync(input.filePath);
      if (bytes.length !== input.bytes || createHash('sha256').update(bytes).digest('hex') !== input.sha256) {
        throw new Error(`Standalone embedded binary integrity mismatch: ${input.virtualId}`);
      }
      const compressed = gzipSync(bytes, { level: 9 });
      const base64 = compressed.toString('base64');
      records.set(id, {
        virtualId: input.virtualId, sourcePath: input.filePath, bytes: input.bytes,
        sha256: input.sha256, gzipBytes: compressed.length, base64Bytes: base64.length, owners: [],
      });
      diagnostics.embeddedBinaries = [...records.values()];
      return `export const base64 = ${JSON.stringify(base64)}; export const byteLength = ${input.bytes}; export const sha256 = ${JSON.stringify(input.sha256)};`;
    },
    generateBundle(_options, bundle) {
      for (const [id, record] of records) {
        record.owners = Object.values(bundle).flatMap(output => output.type === 'chunk'
          && (output.modules[id]?.renderedLength ?? 0) > 0 ? [output.fileName] : []);
        if (record.owners.length > 1) throw new Error(`Duplicate embedded binary owner: ${record.virtualId}`);
      }
    },
  };
}
