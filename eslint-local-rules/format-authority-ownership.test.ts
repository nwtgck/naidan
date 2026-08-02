import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORBIDDEN_AUTHORITY_PATHS = [
  'build/hizofs-format-codegen',
  'src/00-storage/service/hizofs/00-format/v1/registry.json',
  'src/00-storage/service/hizofs/00-format/v1/generated',
  'src/00-storage/service/naidan-persistence-control/00-format/registry.json',
  'src/00-storage/service/naidan-persistence-control/00-format/generated',
] as const;

const CENTRALIZED_AUTHORITY_DECLARATIONS = [
  {
    consumer: 'src/00-storage/service/naidan-persistence-control/store/persistence-control-store.ts',
    forbiddenDeclarations: ['function structurallyObservedSequence('],
    owner: 'src/00-storage/service/naidan-persistence-control/00-format/authority-selection.ts',
    requiredDeclarations: [
      'export function classifyPersistenceControlStructure(',
      'export function persistenceControlPublicationOutcome(',
    ],
  },
  {
    consumer: 'src/00-storage/service/hizofs/00-format/v1/canonical-json/unlock-envelope.ts',
    forbiddenDeclarations: ['export const HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD ='],
    owner: 'src/00-storage/service/hizofs/00-format/v1/credential/passphrase-credential.ts',
    requiredDeclarations: ['export const HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD ='],
  },
  {
    consumer: 'src/00-storage/service/hizofs/01-crypto/credential/passphrase-slot.ts',
    forbiddenDeclarations: [
      'export function decodePassphraseCredentialParametersV1(',
      'export function encodePassphraseCredentialParametersV1(',
      'export type PassphraseCredentialParametersV1 =',
    ],
    owner: 'src/00-storage/service/hizofs/00-format/v1/credential/passphrase-credential.ts',
    requiredDeclarations: [
      'export function decodePassphraseCredentialParametersV1(',
      'export function encodePassphraseCredentialParametersV1(',
      'export type PassphraseCredentialParametersV1 =',
    ],
  },
  {
    consumer: 'src/00-storage/service/hizofs/authenticated-store/unlock-envelope-store.ts',
    forbiddenDeclarations: [
      'function sameCredentialSlot(',
      'function sameSemanticEnvelope(',
      'function selectedAuthenticatedGroup(',
      'function maximumStructuralUnlockSequence(',
    ],
    owner: 'src/00-storage/service/hizofs/00-format/v1/unlock-envelope-authority.ts',
    requiredDeclarations: [
      'export function selectAuthenticatedUnlockEnvelopeAuthority(',
      'export function unlockEnvelopesSemanticallyEqual(',
    ],
  },
  {
    consumer: 'src/00-storage/service/hizofs/authenticated-store/superblock-store.ts',
    forbiddenDeclarations: [
      'function logicalStateFrom(',
      'function sameLogicalState(',
      'function superblockFlags(',
      'function openedFromValidCopies(',
    ],
    owner: 'src/00-storage/service/hizofs/00-format/v1/superblock-authority.ts',
    requiredDeclarations: [
      'export function selectSuperblockAuthority(',
      'export function superblockLogicalStatesSemanticallyEqual(',
    ],
  },
  {
    consumer: 'src/00-storage/service/hizofs/authenticated-store/segment-prefix-reader.ts',
    forbiddenDeclarations: [
      'function frameMaximumCount(',
      'function plaintextMaximumBytes(',
      'function segmentMaximumBytes(',
    ],
    owner: 'src/00-storage/service/hizofs/00-format/v1/segment-validity.ts',
    requiredDeclarations: [
      'export function assertRecordFrameReaderValidity(',
      'export function segmentFileSizeIsReaderValid(',
    ],
  },
  {
    consumer: 'src/00-storage/service/hizofs/authenticated-store/segment-footer-store.ts',
    forbiddenDeclarations: [
      'function footerMaximumBytes(',
      'function frameMatchesEntry(',
    ],
    owner: 'src/00-storage/service/hizofs/00-format/v1/segment-validity.ts',
    requiredDeclarations: [
      'export function segmentFooterCandidateStructureIsValid(',
      'export function segmentFooterIndexEntryMatchesFrame(',
    ],
  },
] as const;

async function exists({ relativePath }: { relativePath: string }): Promise<boolean> {
  try {
    await stat(path.join(ROOT, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

describe('production format authority ownership', () => {
  it('keeps production authority in reviewed TypeScript owner modules', async () => {
    for (const relativePath of FORBIDDEN_AUTHORITY_PATHS) {
      expect(await exists({ relativePath }), relativePath).toBe(false);
    }
  });

  it('does not make format authority depend on a Vite generator', async () => {
    const viteConfig = await readFile(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(viteConfig).not.toContain('createHizofsFormatCodegenPlugin');
    expect(viteConfig).not.toContain('build/hizofs-format-codegen');
  });

  it('does not import generated format-authority paths', async () => {
    const result = spawnSync(
      'git',
      ['grep', '-nE', '/generated/|\\.generated(\\.|["\'`])', '--', 'src', 'build', 'vite.config.ts'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('keeps moved pure authority declarations in their exact format owners', async () => {
    for (const boundary of CENTRALIZED_AUTHORITY_DECLARATIONS) {
      const owner = await readFile(path.join(ROOT, boundary.owner), 'utf8');
      const consumer = await readFile(path.join(ROOT, boundary.consumer), 'utf8');
      for (const declaration of boundary.requiredDeclarations) {
        expect(owner, `${boundary.owner}: ${declaration}`).toContain(declaration);
      }
      for (const declaration of boundary.forbiddenDeclarations) {
        expect(consumer, `${boundary.consumer}: ${declaration}`).not.toContain(declaration);
      }
    }
  });

  it('keeps Naidan application feature names out of HizoFS', () => {
    const result = spawnSync(
      'git',
      ['grep', '-nE', 'Wesh|File Explorer|Chat', '--', ':(glob)src/00-storage/service/hizofs/**/*.ts'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
