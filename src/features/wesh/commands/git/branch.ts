
export function branchRefName({ name }: {
    name: string;
}): string {
  return `refs/heads/${name}`;
}

export const TEST_ONLY = {
};
