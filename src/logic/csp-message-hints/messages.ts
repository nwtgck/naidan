import { parseCsp } from '@/utils/csp';
import type { ParsedCsp, ParsedCspDirective, ParsedCspPolicy, ParsedCspSourceExpression } from '@/utils/csp';
import type { CspHintDetail, CspHintMessage, CspHintTarget, CspObservationSnapshot, CspResourceDescription, CspSourceDescription, CspSuggestedDeployment, CspSuggestedDeploymentId } from './types';

type Match = 'matches' | 'does-not-match' | 'unknown';
type RequestDescription = {
  url: URL,
  fallback: readonly string[],
  context: CspHintDetail['context'],
  path: 'known' | 'unknown',
  /** A family denotes all proper subdomains of url.hostname. */
  host: 'exact' | 'subdomains',
  stage: 'operation' | 'broker-bootstrap',
};

type MatchBudget = { remaining: number };

function directiveFor({ policy, names }: { policy: ParsedCspPolicy, names: readonly string[] }): ParsedCspDirective | undefined {
  for (const name of names) {
    const directive = policy.directives.find(value => value.occurrence === 'first' && value.name === name);
    if (directive !== undefined) {
      return directive;
    }
  }
  return undefined;
}

function schemeMatches({ source, target }: { source: string, target: string }): boolean {
  return source === target
    || (source === 'http' && target === 'https')
    || (source === 'ws' && ['wss', 'http', 'https'].includes(target))
    || (source === 'wss' && target === 'https');
}

function pathMatches({ source, target }: { source: string, target: string }): Match {
  try {
    const a = source.split('/'), b = target.split('/');
    const prefix = source.endsWith('/');
    if (a.length > b.length || (!prefix && a.length !== b.length)) {
      return 'does-not-match';
    }
    if (prefix) {
      a.pop();
    }
    return a.every((value, index) => decodeURIComponent(value) === decodeURIComponent(b[index] ?? '')) ? 'matches' : 'does-not-match';
  } catch {
    return 'unknown';
  }
}

function expressionMatches({ expression, request, documentUrl }: { expression: ParsedCspSourceExpression, request: RequestDescription, documentUrl: URL }): Match {
  const { url, context, path, host } = request;
  const scheme = url.protocol.slice(0, -1);
  switch (expression.kind) {
  case 'keyword': {
    if (expression.value === 'none') {
      return 'does-not-match';
    }
    if (expression.value !== 'self') {
      // Nonce/strict-dynamic and future keywords must not become exclusions.
      return 'unknown';
    }
    if (documentUrl.origin === 'null' || url.protocol === 'blob:') {
      return 'unknown';
    }
    switch (context) {
    case 'privacy-broker': {
      // The managed HTTP(S) broker's protected URL shares this host. Redirects
      // outside that deployment contract are not inferred. A sandboxed origin
      // cannot expand 'self' to an unrelated host, while same-host upgrades and
      // browser differences remain intentionally undecided here.
      if (!['http:', 'https:'].includes(documentUrl.protocol)) {
        return 'unknown';
      }
      switch (host) {
      case 'subdomains': return documentUrl.hostname === url.hostname || documentUrl.hostname.endsWith(`.${url.hostname}`) ? 'unknown' : 'does-not-match';
      case 'exact': return url.hostname === documentUrl.hostname ? 'unknown' : 'does-not-match';
      default: {
        const exhaustive: never = host;
        return exhaustive;
      }
      }
    }
    case 'document':
    case 'same-origin-worker': break;
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
    }
    switch (host) {
    case 'subdomains': return documentUrl.hostname.endsWith(`.${url.hostname}`) ? 'unknown' : 'does-not-match';
    case 'exact': break;
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
    }
    if (url.origin === documentUrl.origin) {
      return 'matches';
    }
    const sameHost = url.hostname === documentUrl.hostname;
    const compatiblePort = url.port === documentUrl.port || (url.port === '' && documentUrl.port === '');
    if (sameHost && compatiblePort && (scheme === 'https' || scheme === 'wss' || (documentUrl.protocol === 'http:' && scheme === 'ws'))) {
      return 'matches';
    }
    return 'does-not-match';
  }
  case 'scheme':
    return schemeMatches({ source: expression.scheme, target: scheme }) ? 'matches' : 'does-not-match';
  case 'host': {
    const { scheme: sourceScheme, host: sourceHost, wildcard, port, path: sourcePath } = expression;
    if (wildcard === 'any' && sourceScheme === undefined && port === undefined && sourcePath === undefined) {
      return ['http', 'https'].includes(scheme) || scheme === documentUrl.protocol.slice(0, -1) ? 'matches' : 'unknown';
    }
    if (sourceScheme === undefined && context === 'privacy-broker') {
      return 'unknown';
    }
    if (!schemeMatches({ source: sourceScheme ?? documentUrl.protocol.slice(0, -1), target: scheme })) {
      return 'does-not-match';
    }
    switch (host) {
    case 'subdomains': {
      switch (wildcard) {
      case 'any': break;
      case 'subdomains':
        if (sourceHost !== url.hostname && !url.hostname.endsWith(`.${sourceHost}`)) {
          return sourceHost.endsWith(`.${url.hostname}`) ? 'unknown' : 'does-not-match';
        }
        break;
      case 'none': return sourceHost.endsWith(`.${url.hostname}`) ? 'unknown' : 'does-not-match';
      default: {
        const exhaustive: never = wildcard;
        return exhaustive;
      }
      }
      break;
    }
    case 'exact': break;
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
    }
    if (host === 'exact' && wildcard === 'none' && url.hostname.toLowerCase() !== sourceHost) {
      return 'does-not-match';
    }
    if (host === 'exact' && wildcard === 'subdomains' && !url.hostname.toLowerCase().endsWith(`.${sourceHost}`)) {
      return 'does-not-match';
    }
    if (url.hostname === '') {
      return 'unknown';
    }
    const defaultPort = scheme === 'https' || scheme === 'wss' ? '443' : scheme === 'http' || scheme === 'ws' ? '80' : undefined;
    if (port !== '*') {
      if (port === undefined && url.port !== '') {
        return 'does-not-match';
      }
      if (port !== undefined && Number(port) !== Number(url.port || defaultPort)) {
        // Browser upgrade behavior around explicit insecure ports is not uniform.
        return sourceScheme === 'http' && port === '80' && scheme === 'https' ? 'unknown' : 'does-not-match';
      }
    }
    if (sourcePath !== undefined && sourcePath !== '') {
      switch (path) {
      case 'unknown': return 'unknown';
      case 'known': return pathMatches({ source: sourcePath, target: url.pathname });
      default: {
        const exhaustive: never = path;
        return exhaustive;
      }
      }
    }
    return 'matches';
  }
  case 'nonce':
  case 'hash':
  case 'unknown':
  case 'invalid':
    return 'unknown';
  default: {
    const exhaustive: never = expression;
    return exhaustive;
  }
  }
}

function listMatches({ directive, request, documentUrl, budget }: { directive: ParsedCspDirective, request: RequestDescription, documentUrl: URL, budget: MatchBudget }): Match {
  if (directive.tokens.length === 0) {
    return 'does-not-match';
  }
  const expressions = directive.sourceExpressions;
  if (expressions === undefined) {
    return 'unknown';
  }
  let unknown = false;
  for (const expression of expressions) {
    if (--budget.remaining < 0) {
      throw new Error('CSP presentation comparison budget exhausted.');
    }
    const match = expressionMatches({ expression, request, documentUrl });
    switch (match) {
    case 'matches': return 'matches';
    case 'unknown': unknown = true;
      break;
    case 'does-not-match': break;
    default: {
      const exhaustive: never = match;
      return exhaustive;
    }
    }
  }
  return unknown ? 'unknown' : 'does-not-match';
}

function sourceDescription({ expression }: { expression: ParsedCspSourceExpression }): CspSourceDescription {
  switch (expression.kind) {
  case 'keyword':
    return expression.value === 'self' || expression.value === 'none'
      ? Object.freeze({ kind: expression.value })
      : Object.freeze({ kind: 'other', value: expression.serialized });
  case 'scheme':
    return Object.freeze({ kind: 'scheme', value: `${expression.scheme}:` });
  case 'host':
    return expression.wildcard === 'none' && ['localhost', '127.0.0.1', '[::1]'].includes(expression.host)
      ? Object.freeze({ kind: 'loopback' })
      : Object.freeze({ kind: 'host', value: expression.serialized });
  case 'nonce':
  case 'hash':
  case 'unknown':
  case 'invalid':
    return Object.freeze({ kind: 'other', value: expression.serialized });
  default: {
    const exhaustive: never = expression;
    return exhaustive;
  }
  }
}

function detailFor({ directive, context }: { directive: ParsedCspDirective, context: CspHintDetail['context'] }): CspHintDetail {
  if (directive.value.length > 3_500) {
    throw new Error('CSP presentation detail exceeds its budget.');
  }
  const sourceDescriptions = directive.tokens.length === 0
    ? [Object.freeze({ kind: 'none' as const })]
    : (directive.sourceExpressions ?? [])
      .filter(expression => directive.tokens.length === 1 || expression.kind !== 'keyword' || expression.value !== 'none')
      .map(expression => sourceDescription({ expression }));
  const seen = new Set<string>();
  const uniqueDescriptions = sourceDescriptions.filter(value => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return Object.freeze({
    directive: directive.name,
    sources: Object.freeze([...directive.tokens]),
    sourceDescriptions: Object.freeze(uniqueDescriptions),
    context,
  });
}

function resourceFallback({ destination, realm }: { destination: CspResourceDescription['destination'], realm: CspResourceDescription['realm'] }): readonly string[] {
  switch (destination) {
  case 'connect': return ['connect-src', 'default-src'];
  case 'image': return ['img-src', 'default-src'];
  case 'media': return ['media-src', 'default-src'];
  case 'frame': return ['frame-src', 'child-src', 'default-src'];
  case 'worker': return ['worker-src', 'child-src', 'script-src', 'default-src'];
  case 'script':
    switch (realm) {
    case 'document': return ['script-src-elem', 'script-src', 'default-src'];
    case 'same-origin-worker': return ['script-src', 'default-src'];
    default: {
      const exhaustive: never = realm;
      return exhaustive;
    }
    }
  case 'style': return ['style-src-elem', 'style-src', 'default-src'];
  case 'font': return ['font-src', 'default-src'];
  case 'manifest': return ['manifest-src', 'default-src'];
  case 'form': return ['form-action'];
  default: {
    const exhaustive: never = destination;
    return exhaustive;
  }
  }
}

function requestForResource({ resource, documentUrl }: { resource: CspResourceDescription, documentUrl: URL }): RequestDescription {
  return {
    url: new URL(resource.url, documentUrl),
    fallback: resourceFallback({ destination: resource.destination, realm: resource.realm }),
    context: resource.realm,
    path: 'known',
    host: 'exact',
    stage: 'operation',
  };
}

function privacyContext({ broker }: { broker: 'hosted' | 'absent' }): CspHintDetail['context'] {
  switch (broker) {
  case 'hosted': return 'privacy-broker';
  case 'absent': return 'document';
  default: {
    const exhaustive: never = broker;
    return exhaustive;
  }
  }
}

function withBrokerRequests({ requests, broker, documentUrl }: { requests: RequestDescription[], broker: 'hosted' | 'absent', documentUrl: URL }): RequestDescription[] {
  switch (broker) {
  case 'hosted':
    requests.push({ url: new URL('/privacy-fetch-broker.html', documentUrl), fallback: ['frame-src', 'child-src', 'default-src'], context: 'document', path: 'known', host: 'exact', stage: 'broker-bootstrap' });
    requests.push({ url: documentUrl, fallback: ['frame-ancestors'], context: 'privacy-broker', path: 'unknown', host: 'exact', stage: 'broker-bootstrap' });
    requests.push({ url: documentUrl, fallback: ['script-src-elem', 'script-src', 'default-src'], context: 'privacy-broker', path: 'unknown', host: 'exact', stage: 'broker-bootstrap' });
    return requests;
  case 'absent': return requests;
  default: {
    const exhaustive: never = broker;
    return exhaustive;
  }
  }
}

function requestsFor({ target, documentUrl, broker }: { target: CspHintTarget, documentUrl: URL, broker: 'hosted' | 'absent' }): RequestDescription[] {
  const connect = ['connect-src', 'default-src'];
  switch (target.kind) {
  case 'connection': {
    if (target.endpoint === undefined || target.endpoint.length > 4_096 || target.apiPath.length > 512) {
      return [];
    }
    const url = new URL(`${target.endpoint.replace(/\/$/, '')}${target.apiPath}`, documentUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? [{ url, fallback: connect, context: 'document', path: 'known', host: 'exact', stage: 'operation' }] : [];
  }
  case 'relay': {
    if (target.url === undefined) {
      return [];
    }
    const url = new URL(target.url, documentUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? [{ url, fallback: connect, context: 'document', path: 'unknown', host: 'exact', stage: 'operation' }] : [];
  }
  case 'resource':
    return [requestForResource({ resource: target, documentUrl })];
  case 'resource-list':
    if (target.resources.length > 16) {
      return [];
    }
    return target.resources.map(resource => requestForResource({ resource, documentUrl }));
  case 'wikipedia':
  case 'huggingface-metadata':
  case 'huggingface-download': {
    const context = privacyContext({ broker });
    const requests: RequestDescription[] = [];
    switch (target.kind) {
    case 'wikipedia':
      requests.push({ url: new URL('https://wikipedia.org/w/api.php'), fallback: connect, context, path: 'known', host: 'subdomains', stage: 'operation' });
      break;
    case 'huggingface-download':
      requests.push({ url: documentUrl, fallback: ['worker-src', 'child-src', 'script-src', 'default-src'], context: 'document', path: 'unknown', host: 'exact', stage: 'operation' });
      // The display profile assumes delivery may use any HTTPS subdomain of
      // hf.co. This symbolic family does not define the transport allowlist.
      requests.push({ url: new URL('https://hf.co/'), fallback: connect, context, path: 'unknown', host: 'subdomains', stage: 'operation' });
      requests.push({ url: new URL('https://huggingface.co/api/models'), fallback: connect, context, path: 'unknown', host: 'exact', stage: 'operation' });
      break;
    case 'huggingface-metadata':
      requests.push({ url: new URL('https://huggingface.co/api/models'), fallback: connect, context, path: 'unknown', host: 'exact', stage: 'operation' });
      break;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
    }
    return withBrokerRequests({ requests, broker, documentUrl });
  }
  default: {
    const exhaustive: never = target;
    return exhaustive;
  }
  }
}

function subjectFor({ target }: { target: CspHintTarget }): CspHintMessage['subject'] {
  switch (target.kind) {
  case 'connection':
  case 'relay': return 'connection';
  case 'wikipedia': return 'wikipedia';
  case 'huggingface-metadata':
  case 'huggingface-download': return 'huggingface';
  case 'resource-list': return 'resource';
  case 'resource':
    switch (target.destination) {
    case 'connect': return 'connection';
    case 'image':
    case 'media':
    case 'frame':
    case 'worker':
    case 'script':
    case 'style':
    case 'font':
    case 'manifest':
    case 'form': return target.destination;
    default: {
      const exhaustive: never = target.destination;
      return exhaustive;
    }
    }
  default: {
    const exhaustive: never = target;
    return exhaustive;
  }
  }
}

function describeForPolicyDelivery({ observation, target, broker, budget, delivery, documentUpgrade, privacyBroker, failure }: {
  observation: CspObservationSnapshot,
  target: CspHintTarget | undefined,
  broker: 'hosted' | 'absent',
  budget: MatchBudget,
  delivery: 'response-header' | 'document-meta' | 'privacy-broker-meta',
  documentUpgrade: 'present' | 'absent',
  privacyBroker: Readonly<{ lifetime: 'not-created' | 'ready', evidence: 'complete' | 'unavailable', upgrade: 'present' | 'absent' }>,
  failure: { failed: boolean },
}): CspHintMessage | undefined {
  try {
    if (observation.kind !== 'observed' || observation.enforce === undefined || target === undefined) {
      return undefined;
    }
    if (!withinTargetBudget({ target })) {
      failure.failed = true;
      return undefined;
    }
    const documentUrl = new URL(observation.documentUrl);
    const requests = requestsFor({ target, documentUrl, broker });
    // URL upgrading is a setting contributed by the enforced policy set, not
    // a rule local to whichever policy happens to contain the directive.
    const hasInsecureUpgrade = observation.enforce.parsed.policies.some(policy => directiveFor({ policy, names: ['upgrade-insecure-requests'] }) !== undefined);
    const details: CspHintDetail[] = [];
    const seen = new Set<string>();
    let detailUnits = 0;
    for (const policy of observation.enforce.parsed.policies) {
      for (const request of requests) {
        // A ready broker has already completed its frame/script bootstrap.
        // Later meta additions cannot retroactively block those loaded assets.
        if (privacyBroker.lifetime === 'ready' && request.stage === 'broker-bootstrap') {
          continue;
        }
        if (privacyBroker.evidence === 'unavailable' && request.context === 'privacy-broker' && request.stage === 'operation') {
          continue;
        }
        switch (delivery) {
        case 'response-header': break;
        case 'document-meta':
          switch (request.context) {
          case 'document': break;
          case 'privacy-broker':
          case 'same-origin-worker': continue;
          default: {
            const exhaustive: never = request.context;
            throw exhaustive;
          }
          }
          break;
        case 'privacy-broker-meta':
          // Only a confirmed post-bootstrap fetch policy is relevant here.
          // Meta frame-ancestors and bootstrap script-src never justify hints.
          if (request.context !== 'privacy-broker' || request.stage !== 'operation' || request.fallback[0] !== 'connect-src') {
            continue;
          }
          break;
        default: {
          const exhaustive: never = delivery;
          throw exhaustive;
        }
        }
        // This hint engine does not emulate URL upgrading before enforcement.
        if (request.url.protocol === 'http:' && (hasInsecureUpgrade || (request.context === 'document' && documentUpgrade === 'present') || (request.context === 'privacy-broker' && privacyBroker.upgrade === 'present'))) {
          continue;
        }
        const directive = directiveFor({ policy, names: request.fallback });
        if (directive !== undefined && listMatches({ directive, request, documentUrl, budget }) === 'does-not-match') {
          const detail = detailFor({ directive, context: request.context });
          const key = JSON.stringify(detail);
          if (!seen.has(key)) {
            detailUnits += key.length;
            if (detailUnits > 3_800) {
              failure.failed = true;
              return undefined;
            }
            seen.add(key);
            details.push(detail);
          }
        }
      }
    }
    if (details.length === 0) {
      return undefined;
    }
    const message: CspHintMessage = Object.freeze({ tone: 'caution', subject: subjectFor({ target }), details: Object.freeze(details), suggestedDeployments: Object.freeze([]) });
    if (JSON.stringify(message).length > 4_096) {
      failure.failed = true;
      return undefined;
    }
    return message;
  } catch {
    failure.failed = true;
    return undefined;
  }
}

/** Only presentation messages escape. An absent message is never permission. */
export function describeCspObservationForUiMessagesOnly({ observation, target, broker, budget }: {
  observation: CspObservationSnapshot,
  target: CspHintTarget | undefined,
  broker: 'hosted' | 'absent',
  budget: MatchBudget,
}): CspHintMessage | undefined {
  return describeForPolicyDelivery({ observation, target, broker, budget, delivery: 'response-header', documentUpgrade: 'absent', privacyBroker: { lifetime: 'not-created', evidence: 'complete', upgrade: 'absent' }, failure: { failed: false } });
}

export function describeCspAndDevelopmentMetaForUiMessagesOnly({ observation, documentMetas, privacyBroker, target, broker, budget }: {
  observation: CspObservationSnapshot,
  documentMetas: readonly Readonly<{ serialized: string, parsed: ParsedCsp }>[] | undefined,
  privacyBroker: Readonly<{ lifetime: 'not-created' | 'ready', metas: readonly Readonly<{ serialized: string, parsed: ParsedCsp }>[] | undefined }>,
  target: CspHintTarget | undefined,
  broker: 'hosted' | 'absent',
  budget: MatchBudget,
}): CspHintMessage | undefined {
  try {
    if (documentMetas === undefined || observation.kind !== 'observed') {
      return undefined;
    }
    const documentPolicies = [...(observation.enforce?.parsed.policies ?? []), ...documentMetas.flatMap(meta => meta.parsed.policies)];
    const documentUpgrade = documentPolicies.some(policy => directiveFor({ policy, names: ['upgrade-insecure-requests'] }) !== undefined) ? 'present' : 'absent';
    const brokerPolicies = [...(observation.enforce?.parsed.policies ?? []), ...(privacyBroker.metas ?? []).flatMap(meta => meta.parsed.policies)];
    const privacyContext = { lifetime: privacyBroker.lifetime, evidence: privacyBroker.metas === undefined ? 'unavailable' as const : 'complete' as const, upgrade: brokerPolicies.some(policy => directiveFor({ policy, names: ['upgrade-insecure-requests'] }) !== undefined) ? 'present' as const : 'absent' as const };
    const failure = { failed: false };
    const header = describeForPolicyDelivery({ observation, target, broker, budget, delivery: 'response-header', documentUpgrade, privacyBroker: privacyContext, failure });
    const details = [...(header?.details ?? [])];
    const keys = new Set(details.map(detail => JSON.stringify(detail)));
    let subject = header?.subject;
    const deliveries = [...documentMetas.map(meta => ({ meta, delivery: 'document-meta' as const })), ...(privacyBroker.metas ?? []).map(meta => ({ meta, delivery: 'privacy-broker-meta' as const }))];
    for (const { meta: appliedMeta, delivery } of deliveries) {
      const meta = describeForPolicyDelivery({ observation: { kind: 'observed', documentUrl: observation.documentUrl, enforce: appliedMeta, reportOnly: undefined }, target, broker, budget, delivery, documentUpgrade, privacyBroker: privacyContext, failure });
      if (failure.failed) {
        return undefined;
      }
      if (meta === undefined) {
        continue;
      }
      subject = meta.subject;
      for (const detail of meta.details) {
        const key = JSON.stringify(detail);
        if (!keys.has(key)) {
          keys.add(key);
          details.push(detail);
        }
      }
    }
    if (failure.failed || subject === undefined || details.length === 0) {
      return undefined;
    }
    const combined: CspHintMessage = Object.freeze({ tone: 'caution', subject, details: Object.freeze(details), suggestedDeployments: Object.freeze([]) });
    return JSON.stringify(combined).length <= 4_096 ? combined : undefined;
  } catch {
    return undefined;
  }
}

function withinTargetBudget({ target }: { target: CspHintTarget }): boolean {
  switch (target.kind) {
  case 'connection': return (target.endpoint?.length ?? 0) + target.apiPath.length <= 4_096;
  case 'relay': return (target.url?.length ?? 0) <= 4_096;
  case 'wikipedia':
  case 'huggingface-metadata':
  case 'huggingface-download': return true;
  case 'resource': return target.url.length <= 4_096;
  case 'resource-list': return target.resources.length <= 16 && target.resources.reduce((total, resource) => total + resource.url.length, 0) <= 4_096;
  default: {
    const exhaustive: never = target;
    return exhaustive;
  }
  }
}

export function getCspTargetMemoKeyForMessagesOnly({ target }: { target: CspHintTarget | undefined }): string | undefined {
  try {
    if (target === undefined || !withinTargetBudget({ target })) {
      return undefined;
    }
    const key = JSON.stringify(target);
    return key.length <= 4_096 ? key : undefined;
  } catch {
    return undefined;
  }
}

type ReferenceDeployment = Readonly<{
  id: CspSuggestedDeploymentId,
  documentUrl: string,
  policy: Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'serialized', serialized: string }>,
}>;

type ReferencePolicy = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'parsed', parsed: ParsedCsp }> | Readonly<{ kind: 'unavailable' }>;

// References to the committed deployment workflow, not observations of remote
// servers. Keep the policy and its source contract test in sync with that file.
const curatedReferencePolicy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://naidan-curated.pages.dev https://*.naidan-curated.pages.dev; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:* http://127.0.0.1:* https://*.wikipedia.org https://*.wikimedia.org https://huggingface.co https://*.hf.co; frame-src 'self'; child-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'; form-action 'none'; manifest-src 'self'";
const referenceDeployments: readonly ReferenceDeployment[] = Object.freeze([
  Object.freeze({ id: 'standard', documentUrl: 'https://naidan.pages.dev/', policy: Object.freeze({ kind: 'absent' }) }),
  Object.freeze({ id: 'curated', documentUrl: 'https://naidan-curated.pages.dev/', policy: Object.freeze({ kind: 'serialized', serialized: curatedReferencePolicy }) }),
]);
const referencePolicyCache = new Map<CspSuggestedDeploymentId, ReferencePolicy>();

function readReferencePolicy({ deployment }: { deployment: ReferenceDeployment }): ReferencePolicy {
  const cached = referencePolicyCache.get(deployment.id);
  if (cached !== undefined) {
    return cached;
  }
  switch (deployment.policy.kind) {
  case 'absent': return deployment.policy;
  case 'serialized': break;
  default: {
    const exhaustive: never = deployment.policy;
    throw exhaustive;
  }
  }
  let policy: ReferencePolicy;
  try {
    const parsed = parseCsp({ serialized: deployment.policy.serialized });
    switch (parsed.kind) {
    case 'failed': policy = Object.freeze({ kind: 'unavailable' });
      break;
    case 'parsed': policy = Object.freeze({ kind: 'parsed', parsed: parsed.value });
      break;
    default: {
      const exhaustive: never = parsed;
      throw exhaustive;
    }
    }
  } catch {
    policy = Object.freeze({ kind: 'unavailable' });
  }
  referencePolicyCache.set(deployment.id, policy);
  return policy;
}

function independentExternalUrl({ serialized, currentDocumentUrl }: { serialized: string | undefined, currentDocumentUrl: URL }): boolean {
  if (serialized === undefined || !/^https?:\/\//i.test(serialized)) {
    return false;
  }
  const url = new URL(serialized);
  return url.origin !== currentDocumentUrl.origin && url.username === '' && url.password === '';
}

function hasPortableTargetMeaning({ target, currentDocumentUrl }: { target: CspHintTarget, currentDocumentUrl: URL }): boolean {
  switch (target.kind) {
  case 'connection': return independentExternalUrl({ serialized: target.endpoint, currentDocumentUrl });
  case 'relay': return independentExternalUrl({ serialized: target.url, currentDocumentUrl });
  case 'wikipedia':
  case 'huggingface-metadata':
  case 'huggingface-download': return true;
  case 'resource': return independentExternalUrl({ serialized: target.url, currentDocumentUrl });
  case 'resource-list': return target.resources.length > 0 && target.resources.every(resource => independentExternalUrl({ serialized: resource.url, currentDocumentUrl }));
  default: {
    const exhaustive: never = target;
    return exhaustive;
  }
  }
}

function usesWorkerForReference({ target }: { target: CspHintTarget }): boolean {
  switch (target.kind) {
  case 'huggingface-download': return true;
  case 'resource': return target.realm === 'same-origin-worker';
  case 'resource-list': return target.resources.some(resource => resource.realm === 'same-origin-worker');
  case 'connection':
  case 'relay':
  case 'wikipedia':
  case 'huggingface-metadata': return false;
  default: {
    const exhaustive: never = target;
    return exhaustive;
  }
  }
}

function requestsForReference({ target, documentUrl }: { target: CspHintTarget, documentUrl: URL }): RequestDescription[] {
  const requests = requestsFor({ target, documentUrl, broker: 'hosted' });
  if (requests.length === 0) {
    return [];
  }
  // Include the application assets that make the operation's UI available.
  requests.push({ url: documentUrl, fallback: ['script-src-elem', 'script-src', 'default-src'], context: 'document', path: 'unknown', host: 'exact', stage: 'operation' });
  requests.push({ url: documentUrl, fallback: ['style-src-elem', 'style-src', 'default-src'], context: 'document', path: 'unknown', host: 'exact', stage: 'operation' });
  requests.push({ url: documentUrl, fallback: ['font-src', 'default-src'], context: 'document', path: 'unknown', host: 'exact', stage: 'operation' });
  if (usesWorkerForReference({ target })) {
    const workerFallback = ['worker-src', 'child-src', 'script-src', 'default-src'];
    // The download profile already includes this same creation request.
    const includesCreation = requests.some(request => request.context === 'document' && request.url.href === documentUrl.href && request.fallback.length === workerFallback.length && workerFallback.every((name, index) => request.fallback[index] === name));
    if (!includesCreation) {
      requests.push({ url: documentUrl, fallback: workerFallback, context: 'document', path: 'unknown', host: 'exact', stage: 'operation' });
    }
    requests.push({ url: documentUrl, fallback: ['script-src', 'default-src'], context: 'same-origin-worker', path: 'unknown', host: 'exact', stage: 'operation' });
  }
  return requests;
}

function hasUnderstoodReferencePolicy({ parsed }: { parsed: ParsedCsp }): boolean {
  if (parsed.issues.length > 0) {
    return false;
  }
  const understoodDirectives = new Set(['default-src', 'script-src', 'script-src-elem', 'style-src', 'style-src-elem', 'img-src', 'font-src', 'connect-src', 'frame-src', 'child-src', 'worker-src', 'frame-ancestors', 'form-action', 'manifest-src']);
  for (const policy of parsed.policies) {
    for (const directive of policy.directives) {
      if (!understoodDirectives.has(directive.name)) {
        return false;
      }
      for (const expression of directive.sourceExpressions ?? []) {
        switch (expression.kind) {
        case 'keyword':
          if (!['self', 'none', 'unsafe-inline', 'unsafe-eval'].includes(expression.value)) {
            return false;
          }
          break;
        case 'host':
        case 'scheme': break;
        case 'nonce':
        case 'hash':
        case 'unknown':
        case 'invalid': return false;
        default: {
          const exhaustive: never = expression;
          return exhaustive;
        }
        }
      }
    }
  }
  return true;
}

function referenceRequestHasCompleteEvidence({ parsed, request, documentUrl, budget }: { parsed: ParsedCsp, request: RequestDescription, documentUrl: URL, budget: MatchBudget }): boolean {
  for (const policy of parsed.policies) {
    const directive = directiveFor({ policy, names: request.fallback });
    if (directive === undefined) {
      continue;
    }
    // A header's frame-ancestors self-origin is the broker response URL's
    // origin, independently of the sandboxed opaque execution origin.
    const matchingRequest = request.fallback[0] === 'frame-ancestors'
      ? { ...request, context: 'document' as const }
      : request;
    const match = listMatches({ directive, request: matchingRequest, documentUrl, budget });
    switch (match) {
    case 'matches': break;
    case 'does-not-match':
    case 'unknown': return false;
    default: {
      const exhaustive: never = match;
      throw exhaustive;
    }
    }
  }
  return true;
}

function referenceHasCompleteEvidenceForUiOnly({ deployment, target, budget }: { deployment: ReferenceDeployment, target: CspHintTarget, budget: MatchBudget }): boolean {
  const documentUrl = new URL(deployment.documentUrl);
  const requests = requestsForReference({ target, documentUrl });
  if (requests.length === 0) {
    return false;
  }
  const policy = readReferencePolicy({ deployment });
  switch (policy.kind) {
  // Explicitly known header absence is independent of another candidate's parse.
  case 'absent': return true;
  case 'unavailable': return false;
  case 'parsed': break;
  default: {
    const exhaustive: never = policy;
    throw exhaustive;
  }
  }
  const parsed = policy.parsed;
  if (budget.remaining <= 0 || !hasUnderstoodReferencePolicy({ parsed })) {
    return false;
  }
  for (const policy of parsed.policies) {
    const styles = directiveFor({ policy, names: ['style-src-elem', 'style-src', 'default-src'] });
    if (styles !== undefined && !styles.sourceExpressions?.some(expression => expression.kind === 'keyword' && expression.value === 'unsafe-inline')) {
      return false;
    }
  }
  for (const request of requests) {
    if (!referenceRequestHasCompleteEvidence({ parsed, request, documentUrl, budget })) {
      return false;
    }
  }
  return true;
}

/**
 * Static reference links for a person to consider, never routing or permission
 * for execution. A failure here retains the original hint without any links.
 */
export function appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget }: {
  message: CspHintMessage,
  observation: CspObservationSnapshot,
  target: CspHintTarget | undefined,
  budget: MatchBudget,
}): CspHintMessage {
  try {
    if (observation.kind !== 'observed' || target === undefined || !Number.isFinite(budget.remaining) || budget.remaining <= 0 || !withinTargetBudget({ target })) {
      return message;
    }
    const currentDocumentUrl = new URL(observation.documentUrl);
    if (!hasPortableTargetMeaning({ target, currentDocumentUrl })) {
      return message;
    }
    // Fix each candidate's allowance before evaluation and debit actual work
    // afterwards, so candidate order or one candidate's failure cannot starve
    // another. The shared Document budget still bounds total comparison work.
    const allowance = Math.min(4_096, Math.floor(budget.remaining / referenceDeployments.length));
    const suggested: CspSuggestedDeployment[] = [];
    const seen = new Set<string>();
    for (const deployment of referenceDeployments) {
      const candidateBudget = { remaining: allowance };
      try {
        const url = new URL(deployment.documentUrl);
        if (url.origin === currentDocumentUrl.origin || seen.has(url.href)) {
          continue;
        }
        if (!referenceHasCompleteEvidenceForUiOnly({ deployment, target, budget: candidateBudget })) {
          continue;
        }
        const candidate = Object.freeze({ id: deployment.id });
        const proposed = [...suggested, candidate];
        if (JSON.stringify({ ...message, suggestedDeployments: proposed }).length > 4_096) {
          continue;
        }
        suggested.push(candidate);
        seen.add(url.href);
      } catch {
        // Preserve other independently established candidates and the base hint.
      } finally {
        budget.remaining -= allowance - Math.max(0, candidateBudget.remaining);
      }
    }
    if (suggested.length === 0) {
      return message;
    }
    const withSuggestions: CspHintMessage = Object.freeze({ ...message, suggestedDeployments: Object.freeze(suggested) });
    return JSON.stringify(withSuggestions).length <= 4_096 ? withSuggestions : message;
  } catch {
    return message;
  }
}

/** Separate policy rows intentionally preserve the intersection of policies. */
export function summarizeCspConnectionsForDisplayOnly({ parsed }: { parsed: ParsedCsp | undefined }): readonly CspHintDetail[] | undefined {
  try {
    if (parsed === undefined) {
      return undefined;
    }
    const details: CspHintDetail[] = [];
    for (const policy of parsed.policies) {
      const directive = directiveFor({ policy, names: ['connect-src', 'default-src'] });
      if (directive !== undefined) {
        details.push(detailFor({ directive, context: 'document' }));
      }
    }
    return Object.freeze(details);
  } catch {
    return undefined;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
