export type EffectDefinition = { name: string, arguments: 'resource' | 'none' };

/** Recognition of a name does not imply that every browser entry point is modeled. */
export const DEFAULT_EFFECT_DEFINITIONS: readonly EffectDefinition[] = [
  ...['opfs', 'hostfs', 'indexeddb', 'localstorage', 'sessionstorage', 'cachestorage', 'cookie']
    .flatMap(name => [
      { name: `${name}.read`, arguments: 'resource' as const },
      { name: `${name}.write`, arguments: 'resource' as const },
    ]),
  ...['network.http', 'network.websocket', 'network.webrtc', 'network.webtransport', 'download.start', 'messaging.crossorigin.send']
    .map(name => ({ name, arguments: 'resource' as const })),
  { name: 'vue.reactive', arguments: 'none' },
];
