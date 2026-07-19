import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';

export type HizoFSHeadScope =
  | { readonly type: 'root' }
  | {
      readonly type: 'subvolume';
      readonly subvolumeId: string;
    };

const UTF8 = new TextEncoder();

export function encodeHizoFSHeadScope({
  scope,
}: {
  scope: HizoFSHeadScope;
}): string {
  switch (scope.type) {
  case 'root':
    return 'root';
  case 'subvolume':
    validateHizoFSStableId({
      value: scope.subvolumeId,
      fieldName: 'HizoFS head subvolume ID',
    });
    return `subvolume/${scope.subvolumeId}`;
  default: {
    const _ex: never = scope;
    throw new Error(`Unhandled HizoFS head scope: ${String(_ex)}`);
  }
  }
}

export function encodeHizoFSHeadScopeBytes({
  scope,
}: {
  scope: HizoFSHeadScope;
}): Uint8Array {
  return UTF8.encode(encodeHizoFSHeadScope({ scope }));
}

export function getHizoFSHeadPath({
  scope,
  slot,
}: {
  scope: HizoFSHeadScope;
  slot: 0 | 1;
}): readonly string[] {
  switch (scope.type) {
  case 'root':
    return [`head-${String(slot)}.hfs`];
  case 'subvolume': {
    validateHizoFSStableId({
      value: scope.subvolumeId,
      fieldName: 'HizoFS head subvolume ID',
    });
    return [
      'subvolume-heads',
      scope.subvolumeId.slice(0, 2),
      `${scope.subvolumeId}-${String(slot)}.hfs`,
    ];
  }
  default: {
    const _ex: never = scope;
    throw new Error(`Unhandled HizoFS head scope: ${String(_ex)}`);
  }
  }
}
