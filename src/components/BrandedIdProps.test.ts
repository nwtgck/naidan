import fs from 'node:fs';
import path from 'node:path';
import { compileScript, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

describe('branded ID Vue props', () => {
  it('skips incorrect Object runtime type inference for primitive ID values', () => {
    const filename = path.resolve(process.cwd(), 'src/components/BrandedIdPropsFixture.vue');
    const source = `\
<script setup lang="ts">
import type { ChatId, MessageId } from '../01-models/ids';

const props = defineProps<{
  chatId: ChatId,
  messageId?: MessageId,
}>();

void props;
</script>
`;
    const { descriptor, errors } = parse(source, { filename });
    expect(errors).toEqual([]);

    const compiled = compileScript(descriptor, {
      id: 'branded-id-props-test',
      fs: {
        fileExists: fs.existsSync,
        readFile: filePath => fs.readFileSync(filePath, 'utf8'),
        realpath: fs.realpathSync,
      },
    });

    expect(compiled.content).toMatch(/chatId:\s*\{\s*type:\s*null,\s*required:\s*true\s*\}/u);
    expect(compiled.content).toMatch(/messageId:\s*\{\s*type:\s*null,\s*required:\s*false\s*\}/u);
    expect(compiled.content).not.toMatch(/(?:chatId|messageId):\s*\{\s*type:\s*Object/u);
  });
});
