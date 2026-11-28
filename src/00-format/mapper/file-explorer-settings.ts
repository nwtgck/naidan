import type { SettingsDto } from '@/00-format/00-dto/dto';
import type { Settings } from '@/01-models/types';
import { exactObject } from '@/utils/exact-object';

type FileExplorerSettings = NonNullable<NonNullable<Settings['experimental']>['fileExplorer']>;
type FileExplorerSettingsDto = NonNullable<NonNullable<SettingsDto['experimental']>['fileExplorer']>;

export function fileExplorerSettingsToDomain({ dto }: { dto: FileExplorerSettingsDto | undefined }): FileExplorerSettings | undefined {
  if (dto === undefined) {
    return undefined;
  }
  const {
    viewMode,
    previewVisibility,
    previewWidthPx,
    treeVisibility,
    treeWidthPx,
    fileInformationVisibility,
    sortField,
    sortDirection,
    wordWrap,
    editorLineNumbers,
    unreadable: _unreadable,
    ...unhandled
  } = dto;
  unhandled satisfies Record<PropertyKey, never>;

  const preferences = exactObject<FileExplorerSettings>()({
    viewMode,
    previewVisibility,
    previewWidthPx,
    treeVisibility,
    treeWidthPx,
    fileInformationVisibility,
    sortField,
    sortDirection,
    wordWrap,
    editorLineNumbers,
  });
  return Object.values(preferences).some(value => value !== undefined) ? preferences : undefined;
}

export function fileExplorerSettingsToDto({ domain }: { domain: FileExplorerSettings | undefined }): FileExplorerSettingsDto | undefined {
  if (domain === undefined) {
    return undefined;
  }
  const {
    viewMode,
    previewVisibility,
    previewWidthPx,
    treeVisibility,
    treeWidthPx,
    fileInformationVisibility,
    sortField,
    sortDirection,
    wordWrap,
    editorLineNumbers,
    ...unhandled
  } = domain;
  unhandled satisfies Record<PropertyKey, never>;

  const preferences = exactObject<FileExplorerSettingsDto>()({
    viewMode,
    previewVisibility,
    previewWidthPx,
    treeVisibility,
    treeWidthPx,
    fileInformationVisibility,
    sortField,
    sortDirection,
    wordWrap,
    editorLineNumbers,
    unreadable: undefined,
  });
  return Object.values(preferences).some(value => value !== undefined) ? preferences : undefined;
}

export const TEST_ONLY = {
};
