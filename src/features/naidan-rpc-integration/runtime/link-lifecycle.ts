export class RpcPeerClosedError extends Error {
  constructor() {
    super('The peer closed its connection'); this.name = 'RpcPeerClosedError';
  }
}
export type RpcLinkHealth = Readonly<{ state: 'healthy' | 'checking' }>;

export const TEST_ONLY = {
};
