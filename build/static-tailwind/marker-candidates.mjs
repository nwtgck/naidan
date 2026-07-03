const markerPattern = /^(?:group|peer)(?:\/[A-Za-z0-9_-]+)?$/u;

export function isTailwindMarkerCandidate({ candidate }) {
  return markerPattern.test(candidate) || candidate === 'not-prose';
}
