import fs from 'node:fs/promises';
import type { Plugin } from 'vite';
import { assertMatchingSystemJsSourceMap, assertSupportedSystemJsRuntime } from '../systemjs.js';

export function createSystemJsRuntimeValidationPlugin({
  systemRuntimePath,
  systemRuntimeSourceMapPath,
}: Readonly<{
  systemRuntimePath: string;
  systemRuntimeSourceMapPath?: string;
}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-systemjs-runtime-validation',
    async buildStart() {
      const runtimeSource = await fs.readFile(systemRuntimePath, 'utf8');
      assertSupportedSystemJsRuntime({ source: runtimeSource });
      if (systemRuntimeSourceMapPath === undefined) return;

      const sourceMapSource = await fs.readFile(systemRuntimeSourceMapPath);
      assertMatchingSystemJsSourceMap({ runtimeSource, sourceMapSource });
    },
  };
}
