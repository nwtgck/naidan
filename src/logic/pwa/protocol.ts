/** Commands are versioned; an unsupported worker never grants automatic activation. */
export const USE_NETWORK_MESSAGE = 'NAIDAN_PWA_USE_NETWORK_V1';
export const BUILD_ID_MESSAGE = 'NAIDAN_PWA_BUILD_ID_V1';
export const COMPLETE_OFFLINE_MESSAGE = 'NAIDAN_PWA_COMPLETE_OFFLINE_V1';
// Only the current active worker may send this to a specific waiting worker.
export const ACTIVATE_BUILD_MESSAGE = 'NAIDAN_PWA_ACTIVATE_BUILD_V1';

export const TEST_ONLY = {
};
