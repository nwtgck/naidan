import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import type { BuildLicenseDependency } from '../license-dependencies';
const pluginName = 'file-protocol-standalone';
export function readSystemJsLicenseDependency({ packageJsonPath }: {
  packageJsonPath: string,
}): BuildLicenseDependency {
  const packageDirectory = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown,
    version?: unknown,
    license?: unknown,
  };
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error(`[${pluginName}] SystemJS package metadata is incomplete.`);
  }
  const licenseFileName = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt']
    .find((candidate) => fs.existsSync(path.join(packageDirectory, candidate)));
  if (licenseFileName === undefined) {
    throw new Error(`[${pluginName}] SystemJS license file is missing.`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: typeof packageJson.license === 'string' ? packageJson.license : null,
    licenseText: fs.readFileSync(path.join(packageDirectory, licenseFileName), 'utf8'),
  };
}

/** @internal Exported for focused plugin tests. */
export function assertSupportedSystemJsRuntime({ source }: { source: string }): void {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'file:///file-protocol-standalone/runtime-validation.html',
    runScripts: 'outside-only',
  });

  try {
    dom.window.eval(source);
    const system = (dom.window as unknown as { System?: Record<string, unknown> }).System;
    const requiredApis = ['import', 'resolve', 'instantiate', 'delete'] as const;
    const missingApis: string[] = requiredApis.filter((api) => typeof system?.[api] !== 'function');
    const constructor = system?.constructor as { prototype?: Record<string, unknown> } | undefined;
    if (typeof constructor?.prototype?.createScript !== 'function') {
      missingApis.push('createScript');
    }

    if (missingApis.length > 0) {
      throw new Error(
        `[${pluginName}] SystemJS runtime is missing APIs required by the file:// patches: ${missingApis.join(', ')}.`,
      );
    }
  } finally {
    dom.window.close();
  }
}


/** @internal Exported for focused plugin tests. */
export function assertMatchingSystemJsSourceMap({
  runtimeSource,
  sourceMapSource,
}: {
  runtimeSource: string,
  sourceMapSource: string | Uint8Array,
}): void {
  const trimmedRuntime = runtimeSource.trimEnd();
  const lastLineStart = trimmedRuntime.lastIndexOf('\n') + 1;
  const lastLine = trimmedRuntime.slice(lastLineStart).replace(/\r$/, '');
  if (lastLine !== '//# sourceMappingURL=system.min.js.map') {
    throw new Error(`[${pluginName}] SystemJS runtime must retain its exact sibling source map directive.`);
  }

  let sourceMap: unknown;
  try {
    sourceMap = JSON.parse(typeof sourceMapSource === 'string'
      ? sourceMapSource
      : Buffer.from(sourceMapSource).toString('utf8'));
  } catch {
    throw new Error(`[${pluginName}] SystemJS source map is not valid JSON.`);
  }
  if (typeof sourceMap !== 'object' || sourceMap === null) {
    throw new Error(`[${pluginName}] SystemJS source map must be an object.`);
  }
  const candidate = sourceMap as {
    version?: unknown,
    sources?: unknown,
    sourcesContent?: unknown,
  };
  if (
    candidate.version !== 3
    || !Array.isArray(candidate.sources)
    || !Array.isArray(candidate.sourcesContent)
    || candidate.sources.length !== candidate.sourcesContent.length
  ) {
    throw new Error(`[${pluginName}] SystemJS source map is missing embedded source content.`);
  }
}
