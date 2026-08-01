import type {
  NaidanPersistenceControlV1,
  NaidanPersistenceEndpointV1,
  NaidanPersistenceModeV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  validatePersistenceEndpointReadiness,
  type TransitionEndpointReadiness,
  type TransitionEndpointReadinessProvider,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-endpoint-readiness';


type HizoFSMode = Extract<NaidanPersistenceModeV1, { readonly type: 'hizofs' }>;
type FileSystemId = HizoFSMode['activeFileSystemId'];

export type PersistenceEndpointOpenProfile = 'normal_read' | 'root_key_proof';

type EndpointInspectionProfile = PersistenceEndpointOpenProfile | 'not_required';

export type OpenedAuthenticationEndpoint = Readonly<{
  fileSystemId: FileSystemId;
  openProfile: PersistenceEndpointOpenProfile;
}>;

export interface PhaseSpecificEndpointInspectionPort {
  inspectHizoFSEndpoint({ fileSystemId, openProfile }: {
    fileSystemId: FileSystemId;
    openProfile: PersistenceEndpointOpenProfile;
  }): Promise<TransitionEndpointReadiness>;
  inspectPlainEndpoint(): Promise<TransitionEndpointReadiness>;
}

function endpointMatches({ first, second }: {
  first: NaidanPersistenceEndpointV1;
  second: NaidanPersistenceEndpointV1;
}): boolean {
  if (first.type !== second.type) return false;
  switch (first.type) {
  case 'plain': return true;
  case 'hizofs': return second.type === 'hizofs' && first.fileSystemId === second.fileSystemId;
  default: return first satisfies never;
  }
}

function endpointInspectionProfile({ endpoint, mode }: {
  endpoint: NaidanPersistenceEndpointV1;
  mode: NaidanPersistenceModeV1;
}): EndpointInspectionProfile {
  switch (mode.type) {
  case 'plain':
    switch (endpoint.type) {
    case 'plain': return 'normal_read';
    case 'hizofs': return 'not_required';
    default: return endpoint satisfies never;
    }
  case 'hizofs':
    switch (endpoint.type) {
    case 'plain': return 'not_required';
    case 'hizofs': return endpoint.fileSystemId === mode.activeFileSystemId ? 'normal_read' : 'not_required';
    default: return endpoint satisfies never;
    }
  case 'transitioning': {
    const { operation, phase } = mode;
    if (endpointMatches({ first: endpoint, second: phase.source })) {
      switch (phase.type) {
      case 'building_target': return 'normal_read';
      case 'cleaning_up_source':
        switch (operation) {
        case 'decrypt': return 'root_key_proof';
        case 'encrypt':
        case 're_encrypt': return 'not_required';
        default: return operation satisfies never;
        }
      default: return phase.type satisfies never;
      }
    }
    if (endpointMatches({ first: endpoint, second: phase.target })) {
      switch (phase.type) {
      case 'cleaning_up_source': return 'normal_read';
      case 'building_target':
        switch (operation) {
        case 'encrypt':
        case 're_encrypt': return 'root_key_proof';
        case 'decrypt': return 'not_required';
        default: return operation satisfies never;
        }
      default: return phase.type satisfies never;
      }
    }
    return 'not_required';
  }
  default: return mode satisfies never;
  }
}

function openedAuthenticationReadiness({ endpoint, opened }: {
  endpoint: NaidanPersistenceEndpointV1;
  opened: OpenedAuthenticationEndpoint;
}): TransitionEndpointReadiness | undefined {
  if (endpoint.type !== 'hizofs' || endpoint.fileSystemId !== opened.fileSystemId) return undefined;
  switch (opened.openProfile) {
  case 'normal_read': return 'fully_verified';
  case 'root_key_proof': return 'root_key_ready';
  default: return opened.openProfile satisfies never;
  }
}

function expectedReadiness({ profile }: {
  profile: PersistenceEndpointOpenProfile;
}): TransitionEndpointReadiness {
  switch (profile) {
  case 'normal_read': return 'fully_verified';
  case 'root_key_proof': return 'root_key_ready';
  default: return profile satisfies never;
  }
}

function createPhaseSpecificEndpointReadinessProvider({ mode, openedAuthenticationEndpoint, port }: {
  mode: NaidanPersistenceModeV1;
  openedAuthenticationEndpoint: OpenedAuthenticationEndpoint;
  port: PhaseSpecificEndpointInspectionPort;
}): TransitionEndpointReadinessProvider {
  return {
    async inspectEndpoint({ endpoint }) {
      const profile = endpointInspectionProfile({ endpoint, mode });
      switch (profile) {
      case 'not_required': return 'absent';
      case 'normal_read':
      case 'root_key_proof': break;
      default: return profile satisfies never;
      }

      const openedReadiness = openedAuthenticationReadiness({ endpoint, opened: openedAuthenticationEndpoint });
      if (openedReadiness !== undefined) {
        if (openedReadiness !== expectedReadiness({ profile })) {
          throw new TypeError('opened authentication endpoint profile does not match Persistence Control phase readiness');
        }
        return openedReadiness;
      }

      switch (endpoint.type) {
      case 'plain':
        switch (profile) {
        case 'normal_read': return await port.inspectPlainEndpoint();
        case 'root_key_proof': throw new TypeError('plain endpoint cannot use a HizoFS root-key proof profile');
        default: return profile satisfies never;
        }
      case 'hizofs':
        return await port.inspectHizoFSEndpoint({ fileSystemId: endpoint.fileSystemId, openProfile: profile });
      default: return endpoint satisfies never;
      }
    },
  };
}

/**
 * Validates every endpoint named by an authenticated Persistence Control mode.
 *
 * The already-open authentication endpoint is projected from its proven open
 * profile instead of being reopened. Other HizoFS endpoints are inspected only
 * with the phase-specific minimum profile. Non-authoritative targets may remain
 * absent or root-key-only, while every routing endpoint requires normal open.
 */
export async function validatePhaseSpecificPersistenceEndpointReadiness({
  control,
  openedAuthenticationEndpoint,
  port,
}: {
  control: NaidanPersistenceControlV1;
  openedAuthenticationEndpoint: OpenedAuthenticationEndpoint;
  port: PhaseSpecificEndpointInspectionPort;
}): Promise<'invalid' | 'valid'> {
  return await validatePersistenceEndpointReadiness({
    mode: control.mode,
    provider: createPhaseSpecificEndpointReadinessProvider({
      mode: control.mode,
      openedAuthenticationEndpoint,
      port,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createPhaseSpecificEndpointReadinessProvider,
  endpointInspectionProfile,
};
