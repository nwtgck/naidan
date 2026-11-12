// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { compactBoundaryStringsModule, createBoundaryStringsCompactionState } from './boundary-strings/compaction';

describe('image-generation monitor production strings', () => {
  it.each(['inline', 'separate'] as const)('compacts request progress in the real %s template', (templateMode) => {
    const root = process.cwd();
    const filename = path.join(root, 'src/features/image-generation/components/ImageGenerationMonitor.vue');
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
    expect(errors).toEqual([]);
    const script = compileScript(descriptor, { id: 'image-generation-monitor', isProd: true, inlineTemplate: templateMode === 'inline' });
    let code = script.content;
    if (templateMode === 'separate') {
      if (descriptor.template === null) {
        throw new Error('The image-generation monitor must have a template.');
      }
      const template = compileTemplate({
        source: descriptor.template.content,
        filename,
        id: 'image-generation-monitor',
        isProd: true,
        compilerOptions: { bindingMetadata: script.bindings },
      });
      expect(template.errors).toEqual([]);
      code = template.code;
    }
    const state = createBoundaryStringsCompactionState({
      root,
      messages: [{ key: 'ImageGenerationMonitor__request_position' }],
    });
    const result = compactBoundaryStringsModule({
      allowedBindingNames: ['lazyStrings'],
      code,
      moduleId: `${filename}?vue&type=${templateMode === 'inline' ? 'script&setup=true&lang.ts' : 'template'}`,
      state,
    });
    expect(result?.code).toContain('.a({ a:');
    expect(result?.code).not.toContain('ImageGenerationMonitor__request_position');
  });
});
