export type NaidanPipingRole = 'initiator' | 'responder';



export function isInitiator({ role }: { role: NaidanPipingRole }): boolean {
  switch (role) {
  case 'initiator': return true;
  case 'responder': return false;
  default: { const unreachable: never = role; throw new Error(`Invalid role: ${unreachable}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
