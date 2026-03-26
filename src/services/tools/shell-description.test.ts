import { describe, it, expect } from 'vitest';
import { buildShellDescription } from './shell-description';
import type { WeshMount } from '@/services/wesh/types';

const noMounts: WeshMount[] = [];
const mounts: WeshMount[] = [
  { path: '/tmp', handle: {} as FileSystemDirectoryHandle, readOnly: false },
  { path: '/home/user/project', handle: {} as FileSystemDirectoryHandle, readOnly: true },
];

describe('buildShellDescription', () => {
  it('includes the base description with backtick help command', () => {
    const result = buildShellDescription({ mounts: noMounts, detectedExtensions: new Set() });
    expect(result).toContain('Run `help` to see available utilities.');
  });

  it('omits the mounted directories section when there are no mounts', () => {
    const result = buildShellDescription({ mounts: noMounts, detectedExtensions: new Set() });
    expect(result).not.toContain('Mounted directories');
  });

  it('lists mounted directories with their access mode', () => {
    const result = buildShellDescription({ mounts, detectedExtensions: new Set() });
    expect(result).toContain('Mounted directories:');
    expect(result).toContain('- /tmp (read-write)');
    expect(result).toContain('- /home/user/project (read-only)');
  });

  it('omits the file type section when no known extensions are detected', () => {
    const result = buildShellDescription({ mounts, detectedExtensions: new Set(['.txt', '.rs']) });
    expect(result).not.toContain('unzip');
  });

  it('adds a file type hint for a single known extension', () => {
    const result = buildShellDescription({ mounts, detectedExtensions: new Set(['.docx']) });
    expect(result).toContain('To read .docx files in the mounts, unzip them to /tmp first:');
    expect(result).toContain('  unzip example.docx -d /tmp/example');
  });

  it('formats two known extensions with "and"', () => {
    const result = buildShellDescription({ mounts, detectedExtensions: new Set(['.docx', '.xlsx']) });
    expect(result).toContain('To read .docx and .xlsx files in the mounts, unzip them to /tmp first:');
    expect(result).toContain('  unzip example.docx -d /tmp/example');
    expect(result).toContain('  unzip example.xlsx -d /tmp/example');
  });

  it('formats three known extensions with Oxford comma', () => {
    const result = buildShellDescription({
      mounts,
      detectedExtensions: new Set(['.docx', '.xlsx', '.pptx']),
    });
    expect(result).toContain('To read .docx, .xlsx, and .pptx files in the mounts, unzip them to /tmp first:');
    expect(result).toContain('  unzip example.docx -d /tmp/example');
    expect(result).toContain('  unzip example.xlsx -d /tmp/example');
    expect(result).toContain('  unzip example.pptx -d /tmp/example');
  });

  it('ignores unknown extensions when building the file type section', () => {
    const result = buildShellDescription({
      mounts,
      detectedExtensions: new Set(['.docx', '.csv', '.unknown']),
    });
    expect(result).toContain('To read .docx files in the mounts');
    expect(result).not.toContain('.csv');
    expect(result).not.toContain('.unknown');
  });
});
