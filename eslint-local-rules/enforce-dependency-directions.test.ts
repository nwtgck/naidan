import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import { rule } from './enforce-dependency-directions.js';

describe('enforce-dependency-directions rule', () => {
  let eslint: ESLint;
  const repoRoot = path.resolve(__dirname, '..');

  beforeAll(() => {
    eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts', '**/*.vue'],
        linterOptions: {
          reportUnusedDisableDirectives: 'error',
        },
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules': {
            rules: {
              'enforce-dependency-directions': rule,
            },
          },
        },
        rules: {
          'local-rules/enforce-dependency-directions': [
            'error',
            { rootDir: 'src', aliasPrefixes: ['@', '~'] },
          ],
        },
      },
    });
  });

  async function lintText({ code, filePath }: { code: string; filePath: string }) {
    const [result] = await eslint.lintText(code, {
      filePath: path.resolve(repoRoot, filePath),
    });
    if (result === undefined) {
      throw new Error(`ESLint returned no result for ${filePath}`);
    }
    return result;
  }

  async function expectAllowed({ code, filePath }: { code: string; filePath: string }) {
    const result = await lintText({ code, filePath });
    expect(result.messages).toHaveLength(0);
  }

  async function expectForbidden({ code, filePath }: { code: string; filePath: string }) {
    const result = await lintText({ code, filePath });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
    expect(result.messages[0]?.messageId).toBe('forbiddenDependencyDirection');
  }

  async function expectCspForbidden({ code, filePath }: { code: string; filePath: string }) {
    const result = await lintText({ code, filePath });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
    expect(result.messages[0]?.messageId).toBe('forbiddenCspDisplayDependency');
  }

  it.each([
    { filePath: 'src/utils/csp/index.ts', code: `import type { ParsedCsp } from './types';` },
    { filePath: 'src/logic/csp-message-hints/observation.ts', code: `import { parseCsp } from '@/utils/csp';` },
    { filePath: 'src/composables/useCspMessageHintsOnly.ts', code: `import { describeCspForUiMessagesOnly, getCspDeveloperSnapshotForDisplayOnly } from '@/logic/csp-message-hints';` },
    { filePath: 'src/composables/useCspMessageHintsOnly.ts', code: `import type { CspDeveloperSnapshot } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import { useCspMessageHintsOnly as useMessages } from '@/composables/useCspMessageHintsOnly';` },
    { filePath: 'src/components/csp/DeveloperCspDiagnosticsContent.vue', code: `import { useCachedCspParseResultForDeveloperDisplayOnly } from '@/composables/useCspMessageHintsOnly';` },
    { filePath: 'src/components/csp/hint-copy.ts', code: `import type { CspHintMessage } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspDeploymentGuidance.vue', code: `import type { CspHintMessage } from '@/logic/csp-message-hints/types'; type Deployments = CspHintMessage['suggestedDeployments'];` },
    { filePath: 'src/components/csp/CspMessageHint.vue', code: `import type { CspHintTarget } from '@/logic/csp-message-hints/types'; const content = import('./CspMessageHintContent.vue');` },
    { filePath: 'src/components/DeveloperCspDiagnostics.vue', code: `const inspector = import('./csp/DeveloperCspDiagnosticsContent.vue');` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import { copy } from './hint-copy';` },
    { filePath: 'src/logic/example.test.ts', code: `import { parseCsp } from '@/utils/csp'; import { getCspDeveloperSnapshotForDisplayOnly } from '@/logic/csp-message-hints';` },
    { filePath: 'src/logic/example.test-support.ts', code: `export { getCspDeveloperSnapshotForDisplayOnly } from '@/logic/csp-message-hints';` },
  ])('allows the explicit CSP display path from $filePath', async ({ filePath, code }) => {
    await expectAllowed({ code, filePath });
  });

  it.each([
    { filePath: 'src/logic/development-meta-csp/owner.ts', code: `const parser = import('@/utils/csp');` },
    { filePath: 'src/logic/development-meta-csp/types.ts', code: `import type { ParsedCsp } from '@/utils/csp';` },
    { filePath: 'src/logic/development-meta-csp/document-messages-only.ts', code: `import { getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly } from './owner'; import type { AppliedDevelopmentMetaCspForDocumentMessagesOnly } from './types';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import { getAppliedDevelopmentMetaCspForDocumentMessagesOnly, subscribeDevelopmentMetaCspMessagesOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/composables/useDevelopmentMetaCspNotForSecurity.ts', code: `import { getDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner'; import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types'; import { useSettings } from '@/composables/useSettings'; const owner = getDevelopmentMetaCspOwnerNotForSecurity(); owner.addForDevelopmentNotForSecurity({ serialized: "connect-src 'none'", source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });` },
    { filePath: 'src/components/csp/DeveloperCspDiagnosticsContent.vue', code: `import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity';` },
    { filePath: 'src/components/csp/DevelopmentMetaCspRecoveryContent.vue', code: `import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity'; import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types';` },
    { filePath: 'src/components/csp/DevelopmentMetaCspRecovery.vue', code: `const recovery = import('./DevelopmentMetaCspRecoveryContent.vue');` },
    { filePath: 'src/components/AppAuxiliaryUi.vue', code: `import Recovery from './csp/DevelopmentMetaCspRecovery.vue';` },
  ])('allows the development-only native meta owner boundary from $filePath', async ({ filePath, code }) => {
    await expectAllowed({ code, filePath });
  });

  it.each([
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import { getDevelopmentMetaCspSnapshotForDeveloperDisplayOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import { getDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import * as meta from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `export * from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `const meta = import('@/logic/development-meta-csp/document-messages-only');` },
    { filePath: 'src/logic/csp-message-hints/types.ts', code: `import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types';` },
    { filePath: 'src/logic/development-meta-csp/document-messages-only.ts', code: `import { getDevelopmentMetaCspOwnerNotForSecurity } from './owner';` },
    { filePath: 'src/logic/development-meta-csp/document-messages-only.ts', code: `export * from './owner';` },
    { filePath: 'src/logic/development-meta-csp/document-messages-only.ts', code: `const owner = import('./owner');` },
    { filePath: 'src/logic/development-meta-csp/document-messages-only.ts', code: `import { parseCsp } from '@/utils/csp';` },
    { filePath: 'src/logic/development-meta-csp/types.ts', code: `import { parseCsp } from '@/utils/csp';` },
    { filePath: 'src/logic/development-meta-csp/owner.ts', code: `import { useSettings } from '@/composables/useSettings';` },
    { filePath: 'src/logic/development-meta-csp/owner.ts', code: `const presentation = import('@/logic/csp-message-hints');` },
    { filePath: 'src/composables/useCspMessageHintsOnly.ts', code: `import { useDevelopmentMetaCspNotForSecurity } from './useDevelopmentMetaCspNotForSecurity';` },
    { filePath: 'src/composables/useDevelopmentMetaCspNotForSecurity.ts', code: `import { createDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';` },
    { filePath: 'src/composables/useDevelopmentMetaCspNotForSecurity.ts', code: `import { parseCsp } from '@/utils/csp';` },
    { filePath: 'src/composables/useDevelopmentMetaCspNotForSecurity.ts', code: `const presentation = import('@/logic/csp-message-hints');` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity';` },
    { filePath: 'src/components/csp/DevelopmentMetaCspRecovery.vue', code: `import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity';` },
    { filePath: 'src/components/csp/DeveloperCspDiagnosticsContent.vue', code: `import { getDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';` },
    { filePath: 'src/components/csp/DeveloperCspDiagnosticsContent.vue', code: `import * as meta from '@/composables/useDevelopmentMetaCspNotForSecurity';` },
    { filePath: 'src/components/AppAuxiliaryUi.vue', code: `import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity';` },
    { filePath: 'src/components/ConnectionTab.vue', code: `import Recovery from './csp/DevelopmentMetaCspRecovery.vue';` },
    { filePath: 'src/features/lm/openai.ts', code: `import { getAppliedDevelopmentMetaCspForDocumentMessagesOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/components/ConnectionTab.vue', code: `import { getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly } from '@/logic/development-meta-csp/owner';` },
  ])('rejects native development meta writes and observations outside their owner from $filePath', async ({ filePath, code }) => {
    await expectCspForbidden({ code, filePath });
  });

  it.each([
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity as getNativeSync } from '@/logic/development-meta-csp/privacy-broker-sync';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import { getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity } from './owner'; import type { DevelopmentMetaCspPrivacyBrokerStateNotForSecurity } from './types';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import { getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly, subscribeDevelopmentMetaCspMessagesOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/features/privacy-fetch/broker-entry.ts', code: `import { developmentMetaCspSyncMessageSchema } from './development-meta-csp-protocol'; import { createBrokerDevelopmentMetaCspNotForSecurity } from './broker-development-meta-csp';` },
  ])('allows only the raw native privacy-broker synchronization contract from $filePath', async ({ filePath, code }) => {
    await expectAllowed({ code, filePath });
  });

  it.each([
    'src/features/privacy-fetch/client-hosted.ts',
    'src/features/privacy-fetch/stream-fetch.ts',
    'src/features/privacy-fetch/broker-entry.ts',
    'src/features/tools/wikipedia/client.ts',
    'src/features/lm/openai.ts',
    'src/logic/csp-message-hints/index.ts',
    'src/composables/useDevelopmentMetaCspNotForSecurity.ts',
  ])('keeps the raw native synchronization adapter private to broker-client: %s', async filePath => {
    await expectCspForbidden({
      code: `import { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from '@/logic/development-meta-csp/privacy-broker-sync';`,
      filePath,
    });
  });

  it.each([
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import * as sync from '@/logic/development-meta-csp/privacy-broker-sync';` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `const sync = import('@/logic/development-meta-csp/privacy-broker-sync');` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `export * from '@/logic/development-meta-csp/privacy-broker-sync';` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `type Sync = typeof import('@/logic/development-meta-csp/privacy-broker-sync');` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `const sync = import.meta.glob('@/logic/development-meta-csp/privacy-broker-sync.ts');` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import { getDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import { getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import type { DevelopmentMetaCspPrivacyBrokerStateNotForSecurity } from '@/logic/development-meta-csp/types';` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import type { ParsedCsp } from '@/utils/csp';` },
    { filePath: 'src/features/privacy-fetch/broker-entry.ts', code: `import { getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import { getDevelopmentMetaCspOwnerNotForSecurity } from './owner';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import { getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly } from './owner';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import { getAppliedDevelopmentMetaCspForDocumentMessagesOnly } from './document-messages-only';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import type { AppliedDevelopmentMetaCspForDocumentMessagesOnly } from './types';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import type { ParsedCsp } from '@/utils/csp';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `import * as owner from './owner';` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `const owner = import('./owner');` },
    { filePath: 'src/logic/development-meta-csp/privacy-broker-sync.ts', code: `export * from './owner';` },
    { filePath: 'src/logic/development-meta-csp/index.ts', code: `export { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from './privacy-broker-sync';` },
    { filePath: 'src/logic/development-meta-csp/document-messages-only.ts', code: `import { getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity } from './owner';` },
    { filePath: 'src/logic/csp-message-hints/messages.ts', code: `import { getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import { getAppliedDevelopmentMetaCspForPrivacyBrokerMessagesOnly } from '@/logic/development-meta-csp/document-messages-only';` },
    { filePath: 'src/features/privacy-fetch/broker-client.ts', code: `import { createBrokerDevelopmentMetaCspNotForSecurity } from './broker-development-meta-csp';` },
    { filePath: 'src/features/privacy-fetch/stream-fetch.ts', code: `import { createBrokerDevelopmentMetaCspNotForSecurity } from './broker-development-meta-csp';` },
    { filePath: 'src/features/lm/openai.ts', code: `import { createBrokerDevelopmentMetaCspNotForSecurity } from '@/features/privacy-fetch/broker-development-meta-csp';` },
    { filePath: 'src/features/privacy-fetch/broker-entry.ts', code: `const applier = import('./broker-development-meta-csp');` },
    { filePath: 'src/features/privacy-fetch/broker-entry.ts', code: `export { createBrokerDevelopmentMetaCspNotForSecurity } from './broker-development-meta-csp';` },
    { filePath: 'src/features/privacy-fetch/broker-entry.ts', code: `import * as applier from './broker-development-meta-csp';` },
    { filePath: 'src/features/privacy-fetch/broker-entry.ts', code: `const applier = import.meta.glob('./broker-development-meta-csp.ts');` },
  ])('rejects privacy synchronization capability or AST bypasses from $filePath', async ({ filePath, code }) => {
    await expectCspForbidden({ code, filePath });
  });

  it.each([
    { filePath: 'src/composables/useDevelopmentMetaCspNotForSecurity.ts', code: `const saved = settings.experimental?.metaCspForDevelopmentNotForSecurity; const update = { metaCspForDevelopmentNotForSecurity: undefined };` },
    { filePath: 'src/01-models/types.ts', code: `type Experimental = { metaCspForDevelopmentNotForSecurity?: string };` },
    { filePath: 'src/00-storage/mapper/mappers.ts', code: `const { metaCspForDevelopmentNotForSecurity } = experimental;` },
    { filePath: 'src/00-storage/mapper/mappers.ts', code: `const dtoValue = dto.experimental.metaCsp;` },
    { filePath: 'src/features/example/example.ts', code: `const unrelated = response.metaCsp; const experimental = settings.experimental;` },
    { filePath: 'src/logic/example.test.ts', code: `const value = settings.experimental.metaCspForDevelopmentNotForSecurity;` },
  ])('keeps saved development meta access in persistence or its dedicated adapter: $filePath', async ({ filePath, code }) => {
    await expectAllowed({ code, filePath });
  });

  it.each([
    `const enabled = settings.experimental.metaCspForDevelopmentNotForSecurity;`,
    `const enabled = settings.experimental?.['metaCspForDevelopmentNotForSecurity'];`,
    `const { metaCspForDevelopmentNotForSecurity: enabled } = settings.experimental;`,
    `const update = { ['metaCspForDevelopmentNotForSecurity']: undefined };`,
    `type SavedMeta = Experimental['metaCspForDevelopmentNotForSecurity'];`,
    `const raw = dto.experimental.metaCsp;`,
  ])('rejects direct saved-meta field use by ordinary feature logic: %s', async code => {
    const result = await lintText({ code, filePath: 'src/features/lm/example.ts' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenDevelopmentMetaCspSetting');
  });

  it('checks saved fields and native adapters in Vue template expressions', async () => {
    const vueEslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.vue'],
        languageOptions: { parser: vueParser, parserOptions: { parser: tsParser, sourceType: 'module' } },
        plugins: { 'local-rules': { rules: { 'enforce-dependency-directions': rule } } },
        rules: { 'local-rules/enforce-dependency-directions': ['error', { rootDir: 'src', aliasPrefixes: ['@', '~'] }] },
      },
    });
    const [result] = await vueEslint.lintText(`\
<template>
  <button :disabled="settings.experimental.metaCspForDevelopmentNotForSecurity" @click="import('@/composables/useDevelopmentMetaCspNotForSecurity')">Send</button>
</template>`, { filePath: path.resolve(repoRoot, 'src/components/Example.vue') });
    expect(result?.messages.map(message => message.messageId).sort()).toEqual([
      'forbiddenCspDisplayDependency',
      'forbiddenDevelopmentMetaCspSetting',
    ]);
  });

  it.each([
    'src/features/lm/openai.ts',
    'src/features/tools/wikipedia/client.ts',
    'src/features/tools/tool-config.ts',
    'src/features/privacy-fetch/broker-entry.ts',
    'src/logic/execute-chat-tool-calls.ts',
    'src/composables/useSettings.ts',
    'src/00-storage/service/index.ts',
    'src/01-models/tool.ts',
    'src/components/ConnectionTab.vue',
  ])('keeps CSP parser data out of execution and ordinary UI code: %s', async filePath => {
    await expectCspForbidden({ code: `import type { ParsedCsp } from '@/utils/csp/types';`, filePath });
  });

  it.each([
    { filePath: 'src/utils/index.ts', code: `export { parseCsp } from './csp';` },
    { filePath: 'src/logic/csp.ts', code: `export * from './csp-message-hints';` },
    { filePath: 'src/components/ConnectionTab.vue', code: `import type { CspHintMessage } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/features/tools/components/ToolConfigHierarchySettings.vue', code: `const hints = import('@/composables/useCspMessageHintsOnly');` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import { useCachedCspParseResultForDeveloperDisplayOnly as useHints } from '@/composables/useCspMessageHintsOnly';` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import * as hints from '@/composables/useCspMessageHintsOnly';` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `const hints = import('@/composables/useCspMessageHintsOnly');` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `export { useCspMessageHintsOnly } from '@/composables/useCspMessageHintsOnly';` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import { getCspDeveloperSnapshotForDisplayOnly } from '@/logic/csp-message-hints';` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import { CspHintMessage } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspMessageHintContent.vue', code: `import type { CspDeveloperSnapshot } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspDeploymentGuidance.vue', code: `import type { CspDeveloperSnapshot } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspDeploymentGuidance.vue', code: `import type { CspHintTarget } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspDeploymentGuidance.vue', code: `import type * as Messages from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspDeploymentGuidance.vue', code: `import { CspHintMessage } from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/components/csp/CspMessageHint.vue', code: `import type * as Snapshot from '@/logic/csp-message-hints/types';` },
    { filePath: 'src/composables/useCspMessageHintsOnly.ts', code: `import { getOwner } from '@/logic/csp-message-hints/observation';` },
    { filePath: 'src/logic/csp-message-hints/index.ts', code: `import { loadLmProvider } from '@/features/lm/provider-factory';` },
    { filePath: 'src/logic/csp-message-hints/observation.ts', code: `import { storageService } from '@/00-storage/service';` },
    { filePath: 'src/components/ConnectionTab.vue', code: `import Content from './csp/CspMessageHintContent.vue';` },
    { filePath: 'src/components/ConnectionTab.vue', code: `import Content from './csp/CspMessageHintContent';` },
    { filePath: 'src/components/DeveloperTab.vue', code: `import Content from './csp/DeveloperCspDiagnosticsContent.vue';` },
    { filePath: 'src/features/example/example.ts', code: `type Policy = import('@/utils/csp').ParsedCsp;` },
  ])('rejects CSP observation or private display bypasses from $filePath', async ({ filePath, code }) => {
    await expectCspForbidden({ code, filePath });
  });

  it.each([
    `import { parseCsp } from '../utils/csp/index.ts?raw';`,
    `export * from '~/utils/csp';`,
    'const parser = import(`@/utils/csp`);',
    `const parser = import('@/utils/' + 'csp');`,
    'const parser = import(`@/${"utils"}/csp`);',
    `const parser = import('@/utils/csp' as const);`,
    `require('@/utils/csp');`,
    `require.resolve('@/utils/csp');`,
    `const entries = import.meta.glob('@/utils/csp/*.ts');`,
    `const parserUrl = new URL('../utils/csp/index.ts', import.meta.url);`,
  ])('checks every existing static reference form for CSP: %s', async code => {
    await expectCspForbidden({ code, filePath: 'src/logic/example.ts' });
  });

  it.each([
    `const modules = import.meta.glob('@/utils/**/*.ts');`,
    `const modules = import.meta.glob('@/logic/**/*');`,
    `const modules = import.meta.glob(['./local/*.ts', '../utils/**/types.ts']);`,
    `const modules = import.meta.glob('@/components/csp/*.vue');`,
    `const modules = import.meta.glob('@/logic/development-meta-csp/*.ts');`,
    `const modules = import.meta.glob('@/composables/*MetaCsp*.ts');`,
  ])('checks protected CSP paths inside broad globs: %s', async code => {
    await expectCspForbidden({ code, filePath: 'src/logic/example.ts' });
  });

  it('honors negative globs that exclude the entire CSP parser', async () => {
    await expectAllowed({
      code: `const modules = import.meta.glob(['@/utils/**/*.ts', '!@/utils/csp/**']);`,
      filePath: 'src/logic/example.ts',
    });
  });

  it('honors negative globs that exclude both CSP logic owners', async () => {
    await expectAllowed({
      code: `const modules = import.meta.glob(['@/logic/**/*.ts', '!@/logic/csp-message-hints/**', '!@/logic/development-meta-csp/**']);`,
      filePath: 'src/logic/example.ts',
    });
  });

  it.each([
    'src/features/example/example.ts',
    'src/components/Example.ts',
    'src/composables/useExample.ts',
    'src/logic/example.ts',
    'src/pages/example.vue.ts',
  ])('allows application code to depend on 01-models from %s', async (filePath) => {
    await expectAllowed({ code: `import type { Chat } from '@/01-models/types';`, filePath });
  });

  it('allows application code to depend on storage service', async () => {
    await expectAllowed({
      code: `import { storageService } from '@/00-storage/service';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('allows unrestricted dependencies between application directories', async () => {
    await expectAllowed({
      code: `import { useExample } from '@/composables/useExample';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it.each([
    '@/00-storage/00-dto/dto',
    '@/00-storage/mapper/mappers',
  ])('rejects application dependencies on storage internals: %s', async (importPath) => {
    await expectForbidden({
      code: `import type { Example } from '${importPath}';`,
      filePath: 'src/components/Example.ts',
    });
  });

  it.each([
    '@/features/example/example',
    '@/components/Example.vue',
    '@/composables/useExample',
    '@/logic/example',
    '@/pages/example.vue',
    '@/00-storage/service',
    '@/00-storage/mapper/mappers',
    '@/00-storage/00-dto/dto',
    '@/strings',
  ])('rejects 01-models dependencies on upper or persistence code: %s', async (importPath) => {
    await expectForbidden({
      code: `import type { Example } from '${importPath}';`,
      filePath: 'src/01-models/example.ts',
    });
  });

  it('allows 01-models dependencies on stable foundations', async () => {
    await expectAllowed({
      code: `import { VALUE } from '@/constants'; import { helper } from '@/utils/helper';`,
      filePath: 'src/01-models/example.ts',
    });
  });

  it('allows storage service dependencies on mapper and DTO', async () => {
    await expectAllowed({
      code: `import { map } from '@/00-storage/mapper/mappers'; import type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/00-storage/service/example.ts',
    });
  });

  it('rejects storage service dependencies on application code', async () => {
    await expectForbidden({
      code: `import { useExample } from '@/composables/useExample';`,
      filePath: 'src/00-storage/service/example.ts',
    });
  });

  it('allows mapper dependencies on DTO', async () => {
    await expectAllowed({
      code: `import type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/00-storage/mapper/example.ts',
    });
  });

  it('rejects mapper dependencies on storage service', async () => {
    await expectForbidden({
      code: `import { storageService } from '@/00-storage/service';`,
      filePath: 'src/00-storage/mapper/example.ts',
    });
  });

  it('rejects DTO dependencies on mapper', async () => {
    await expectForbidden({
      code: `import { map } from '@/00-storage/mapper/mappers';`,
      filePath: 'src/00-storage/00-dto/example.ts',
    });
  });

  it('rejects utils dependencies on 01-models', async () => {
    await expectForbidden({
      code: `import type { Chat } from '@/01-models/types';`,
      filePath: 'src/utils/example.ts',
    });
  });

  it('allows dependencies within the same Wesh command', async () => {
    await expectAllowed({
      code: `import { helper } from '@/features/wesh/commands/git/diff/helper';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
  });

  it('allows Wesh commands to depend on commands/_shared', async () => {
    await expectAllowed({
      code: `import { helper } from '@/features/wesh/commands/_shared/helper';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
  });

  it('allows Wesh command tests to import the root command registry', async () => {
    await expectAllowed({
      code: `import { commandDefinitions } from '@/features/wesh/commands/index';`,
      filePath: 'src/features/wesh/commands/git/git.help.test.ts',
    });
  });

  it('allows the root command registry to register specific commands', async () => {
    await expectAllowed({
      code: `import { gitCommandDefinition } from '@/features/wesh/commands/git';`,
      filePath: 'src/features/wesh/commands/index.ts',
    });
  });

  it('rejects production Wesh commands depending on the root command registry', async () => {
    const result = await lintText({
      code: `import { commandDefinitions } from '@/features/wesh/commands/index';`,
      filePath: 'src/features/wesh/commands/git/help.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandRegistryDependency');
  });

  it('rejects production Wesh commands depending on the root registry directory barrel', async () => {
    const result = await lintText({
      code: `import { commandDefinitions } from '@/features/wesh/commands';`,
      filePath: 'src/features/wesh/commands/git/help.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandRegistryDependency');
  });

  it('rejects commands/_shared depending on the root command registry', async () => {
    const result = await lintText({
      code: `import { commandDefinitions } from '@/features/wesh/commands/index';`,
      filePath: 'src/features/wesh/commands/_shared/registry-helper.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandRegistryDependency');
  });

  it('rejects direct dependencies between sibling Wesh commands', async () => {
    const result = await lintText({
      code: `import { helper } from '@/features/wesh/commands/diff/algorithm';`,
      filePath: 'src/features/wesh/commands/git/diff.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects sibling Wesh command directory barrel imports', async () => {
    const result = await lintText({
      code: `import { diffCommand } from '@/features/wesh/commands/diff';`,
      filePath: 'src/features/wesh/commands/git/diff.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects relative dependencies between sibling Wesh commands', async () => {
    const result = await lintText({
      code: `import type { DiffInput } from '../diff/model';`,
      filePath: 'src/features/wesh/commands/git/diff.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects sibling Wesh command re-exports', async () => {
    const result = await lintText({
      code: `export { helper } from '@/features/wesh/commands/diff/algorithm';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects sibling Wesh command dynamic imports', async () => {
    const result = await lintText({
      code: `const implementation = import('@/features/wesh/commands/patch/engine');`,
      filePath: 'src/features/wesh/commands/git/subcommands/apply.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects commands/_shared dependencies on a specific command', async () => {
    const result = await lintText({
      code: `import { helper } from '@/features/wesh/commands/git/diff/helper';`,
      filePath: 'src/features/wesh/commands/_shared/example.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('checks relative imports', async () => {
    await expectForbidden({
      code: `import type { Dto } from '../00-storage/00-dto/dto';`,
      filePath: 'src/components/Example.ts',
    });
  });

  it('checks re-exports', async () => {
    await expectForbidden({
      code: `export type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks dynamic imports', async () => {
    await expectForbidden({
      code: `const dto = import('@/00-storage/00-dto/dto');`,
      filePath: 'src/logic/example.ts',
    });
  });

  it('checks dynamic imports with static template literals', async () => {
    await expectForbidden({
      code: 'const dto = import(`@/00-storage/00-dto/dto`);',
      filePath: 'src/logic/example.ts',
    });
  });

  it('checks TypeScript import types', async () => {
    await expectForbidden({
      code: `type Dto = import('@/00-storage/00-dto/dto').Dto;`,
      filePath: 'src/pages/example.ts',
    });
  });

  it('checks vi.mock dependencies', async () => {
    await expectForbidden({
      code: `vi.mock('@/00-storage/mapper/mappers');`,
      filePath: 'src/components/Example.test.ts',
    });
  });

  it.each([
    `vi.importActual('@/00-storage/mapper/mappers')`,
    `vi.importMock('@/00-storage/mapper/mappers')`,
    `jest.requireActual('@/00-storage/mapper/mappers')`,
    `jest.requireMock('@/00-storage/mapper/mappers')`,
    `require('@/00-storage/mapper/mappers')`,
    `require.resolve('@/00-storage/mapper/mappers')`,
  ])('checks other static module-reference calls: %s', async (code) => {
    await expectForbidden({
      code: `${code};`,
      filePath: 'src/components/Example.test.ts',
    });
  });

  it('checks static template literals in test module-reference calls', async () => {
    await expectForbidden({
      code: 'vi.mock(`@/00-storage/mapper/mappers`);',
      filePath: 'src/components/Example.test.ts',
    });
  });

  it('checks import.meta.glob dependencies', async () => {
    await expectForbidden({
      code: `const modules = import.meta.glob('../../00-storage/00-dto/*.ts');`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks import.meta.glob dependency arrays', async () => {
    const result = await lintText({
      code: `const modules = import.meta.glob(['./local/*.ts', '../../00-storage/00-dto/*.ts']);`,
      filePath: 'src/features/example/example.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
  });

  it('checks import.meta.glob dependencies with static template literals', async () => {
    await expectForbidden({
      code: 'const modules = import.meta.glob(`../../00-storage/00-dto/*.ts`);',
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks new URL dependencies', async () => {
    await expectForbidden({
      code: `const workerUrl = new URL('../../00-storage/00-dto/worker.ts', import.meta.url);`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks new URL dependencies with static template literals', async () => {
    await expectForbidden({
      code: 'const workerUrl = new URL(`../../00-storage/00-dto/worker.ts`, import.meta.url);',
      filePath: 'src/features/example/example.ts',
    });
  });

  it('ignores runtime URLs that are not resolved from import.meta.url', async () => {
    await expectAllowed({
      code: `const url = new URL('../00-storage/00-dto/worker.ts', runtimeBaseUrl);`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('allows one explicitly suppressed existing violation', async () => {
    await expectAllowed({
      code: `\
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the DTO dependency with the storage service API.
import type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('ignores package imports', async () => {
    await expectAllowed({
      code: `import { ref } from 'vue';`,
      filePath: 'src/01-models/example.ts',
    });
  });
  it('allows the Git entrypoint to import a subcommand', async () => {
    await expectAllowed({
      code: `import { runStatus } from './subcommands/status';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
  });

  it('allows a Git subcommand to import a Git domain module', async () => {
    await expectAllowed({
      code: `import { collectStatus } from '../status';`,
      filePath: 'src/features/wesh/commands/git/subcommands/status.ts',
    });
  });

  it('rejects a Git domain module importing a subcommand', async () => {
    const result = await lintText({
      code: `import { runStatus } from './subcommands/status';`,
      filePath: 'src/features/wesh/commands/git/status.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshGitLayerDependency');
  });

  it('rejects one Git subcommand importing another', async () => {
    const result = await lintText({
      code: `import { runCommit } from './commit';`,
      filePath: 'src/features/wesh/commands/git/subcommands/status.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshGitLayerDependency');
  });

  it('allows private modules within the same Git subcommand directory', async () => {
    await expectAllowed({
      code: `import { writeCombinedDiff } from './combined';`,
      filePath: 'src/features/wesh/commands/git/subcommands/diff/index.ts',
    });
  });

  it('rejects a nested Git subcommand helper importing another subcommand', async () => {
    const result = await lintText({
      code: `import { renderGraph } from '../log/graph';`,
      filePath: 'src/features/wesh/commands/git/subcommands/diff/combined.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshGitLayerDependency');
  });

});
