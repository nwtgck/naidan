import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('print ownership boundary', () => {
  it('keeps print orchestration out of the startup-critical App.vue', () => {
    const appSource = readSource('src/App.vue');

    expect(appSource).not.toContain('usePrint');
    expect(appSource).not.toContain('PrintView');
    expect(appSource).not.toContain('ChatPrintContent');
  });

  it('keeps print UI lazy-owned by the post-startup auxiliary UI', () => {
    const auxiliarySource = readSource('src/components/AppAuxiliaryUi.vue');

    expect(auxiliarySource).toContain("import { usePrint } from '@/composables/usePrint';");
    expect(auxiliarySource).toMatch(
      /const PrintView = defineAsyncComponent\(\(\) => import\('@\/components\/PrintView\.vue'\)\);/u,
    );
    expect(auxiliarySource).toMatch(
      /const ChatPrintContent = defineAsyncComponent\(\(\) => import\('@\/components\/ChatPrintContent\.vue'\)\);/u,
    );
    expect(auxiliarySource).toContain('const { activePrintMode } = usePrint();');
  });
});
