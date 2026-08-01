import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import type { NaidanPersistenceControlV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types';
import PersistenceControlInspectionPanel from './PersistenceControlInspectionPanel.vue';

const ACTIVE_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const RETIRED_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: 'RETIRED_FS_0123456789' });

function persistedControl(): NaidanPersistenceControlV1 {
  return {
    copy: 0,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { activeFileSystemId: ACTIVE_FILE_SYSTEM_ID, type: 'hizofs' },
    protection: {
      authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
      authenticatorTag: 'persisted-authenticator-tag',
      nonce: 'persisted-nonce',
      type: 'hizofs_aes_256_gcm',
    },
    retiredFileSystemIds: [RETIRED_FILE_SYSTEM_ID],
    sequence: 14,
  };
}

function inspection(): PersistenceControlInspection {
  const control = persistedControl();
  return {
    copies: [
      {
        authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
        control,
        copy: 0,
        mode: control.mode,
        physicalPath: ['persistence-control', 'state-0.json'],
        protection: 'hizofs_aes_256_gcm',
        reason: undefined,
        retiredFileSystemIds: [RETIRED_FILE_SYSTEM_ID],
        selected: true,
        sequence: 14,
        state: 'proof_valid',
      },
      {
        authenticationFileSystemId: undefined,
        control: undefined,
        copy: 1,
        mode: undefined,
        physicalPath: ['hizofs', 'state-1.json'],
        protection: undefined,
        reason: 'SyntaxError: invalid JSON',
        retiredFileSystemIds: [],
        selected: false,
        sequence: undefined,
        state: 'structurally_invalid',
      },
    ],
    observedSequences: [14, undefined],
    selection: { copy: 0, redundancy: 'degraded', sequence: 14, state: 'selected' },
  };
}

describe('PersistenceControlInspectionPanel', () => {
  it('shows both physical copies and the exact persisted control DTO', () => {
    const wrapper = mount(PersistenceControlInspectionPanel, { props: { inspection: inspection() } });
    expect(wrapper.get('[data-testid="persistence-control-selection"]').text()).toBe('copy 0, sequence 14, degraded');
    expect(wrapper.get('[data-testid="persistence-control-copy-0"]').text()).toContain('persistence-control/state-0.json');
    expect(wrapper.get('[data-testid="persistence-control-copy-0"]').text()).toContain('hizofs_aes_256_gcm');
    expect(wrapper.get('[data-testid="persistence-control-copy-0"]').text()).toContain('RETIRED_FS_0123456789');
    expect(wrapper.get('[data-testid="persistence-control-copy-1"]').text()).toContain('structurally_invalid');
    expect(wrapper.get('[data-testid="persistence-control-copy-1"]').text()).toContain('SyntaxError: invalid JSON');
    const persistedDto = wrapper.get('[data-testid="persistence-control-control-dto-0"]').text();
    expect(persistedDto).toContain('"format": "naidan-persistence-control"');
    expect(persistedDto).toContain('"formatVersion": 1');
    expect(persistedDto).toContain('"authenticatorTag": "persisted-authenticator-tag"');
    expect(persistedDto).toContain('"nonce": "persisted-nonce"');
    expect(wrapper.get('[data-testid="persistence-control-mode-dto-0"]').text()).toContain('"activeFileSystemId": "0123456789_ABCDEFGHIJ"');
  });
});
