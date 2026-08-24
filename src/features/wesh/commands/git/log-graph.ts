export interface GitLogGraphEntry {
  objectId: string,
  parentObjectIds: readonly string[],
  lines: readonly string[],
}

type GitLogGraphShape =
  | {
      type: "normal",
      laneIndex: 0 | 1,
      beforeLaneCount: 1 | 2,
      afterLaneCount: 0 | 1 | 2,
    }
  | {
      type: "expand",
    }
  | {
      type: "collapse-left",
    };

interface PlannedGraphEntry {
  entry: GitLogGraphEntry,
  shape: GitLogGraphShape,
}

function unsupportedTopology(): never {
  throw new Error("log --graph does not support this commit topology yet");
}

function planGraph({ entries }: { entries: readonly GitLogGraphEntry[] }): PlannedGraphEntry[] {
  let lanes: string[] = [];
  const planned: PlannedGraphEntry[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    const remainingObjectIds = new Set(entries.slice(entryIndex).map(candidate => candidate.objectId));
    let laneIndex = lanes.indexOf(entry.objectId);
    if (laneIndex < 0) {
      const hasVisiblePendingLane = lanes.some(objectId => remainingObjectIds.has(objectId));
      if (hasVisiblePendingLane) unsupportedTopology();
      lanes = [entry.objectId];
      laneIndex = 0;
    }
    if (lanes.length < 1 || lanes.length > 2 || laneIndex > 1) unsupportedTopology();

    if (entry.parentObjectIds.length > 2) unsupportedTopology();
    if (entry.parentObjectIds.length === 2) {
      if (laneIndex !== 0 || lanes.length !== 1) unsupportedTopology();
      const [firstParent, secondParent] = entry.parentObjectIds;
      if (firstParent === undefined || secondParent === undefined || firstParent === secondParent) unsupportedTopology();
      planned.push({ entry, shape: { type: "expand" } });
      lanes = [firstParent, secondParent];
      continue;
    }

    const parentObjectId = entry.parentObjectIds[0];
    if (parentObjectId === undefined) {
      if (lanes.length !== 1 || laneIndex !== 0) unsupportedTopology();
      planned.push({
        entry,
        shape: {
          type: "normal",
          laneIndex: 0,
          beforeLaneCount: 1,
          afterLaneCount: 0,
        },
      });
      lanes = [];
      continue;
    }

    const existingParentLane = lanes.indexOf(parentObjectId);
    if (existingParentLane >= 0 && existingParentLane !== laneIndex) {
      if (lanes.length !== 2 || laneIndex !== 0 || existingParentLane !== 1) unsupportedTopology();
      planned.push({ entry, shape: { type: "collapse-left" } });
      lanes = [parentObjectId];
      continue;
    }

    const beforeLaneCount = lanes.length as 1 | 2;
    const normalizedLaneIndex = laneIndex as 0 | 1;
    lanes[laneIndex] = parentObjectId;
    planned.push({
      entry,
      shape: {
        type: "normal",
        laneIndex: normalizedLaneIndex,
        beforeLaneCount,
        afterLaneCount: lanes.length as 1 | 2,
      },
    });
  }
  return planned;
}

function stablePrefix({ laneCount, preserveColumnWidth }: {
  laneCount: 0 | 1 | 2,
  preserveColumnWidth: boolean,
}): string {
  if (laneCount === 0) return preserveColumnWidth ? "  " : "";
  if (laneCount === 1) return "| ";
  return "| | ";
}

function graphPrefixes({ shape }: { shape: GitLogGraphShape }): {
  first: string,
  transition: string | undefined,
  stable: string,
} {
  switch (shape.type) {
  case "expand":
    return { first: "*   ", transition: "|\\  ", stable: "| | " };
  case "collapse-left":
    return { first: "* | ", transition: "|/  ", stable: "| " };
  case "normal": {
    let first: string;
    if (shape.beforeLaneCount === 1) first = "* ";
    else first = shape.laneIndex === 0 ? "* | " : "| * ";
    return {
      first,
      transition: undefined,
      stable: stablePrefix({ laneCount: shape.afterLaneCount, preserveColumnWidth: true }),
    };
  }
  default: {
    const _ex: never = shape;
    throw new Error(`Unhandled log graph shape: ${_ex}`);
  }
  }
}

export function renderGitLogGraph({ entries }: { entries: readonly GitLogGraphEntry[] }): string {
  const planned = planGraph({ entries });
  const output: string[] = [];
  for (const { entry, shape } of planned) {
    if (entry.lines.length === 0) throw new Error("log graph entry has no output lines");
    const prefixes = graphPrefixes({ shape });
    for (let lineIndex = 0; lineIndex < entry.lines.length; lineIndex += 1) {
      const prefix = lineIndex === 0
        ? prefixes.first
        : lineIndex === 1 && prefixes.transition !== undefined
          ? prefixes.transition
          : prefixes.stable;
      output.push(`${prefix}${entry.lines[lineIndex]!}`);
    }
    if (prefixes.transition !== undefined && entry.lines.length === 1) output.push(prefixes.transition);
  }
  return output.length === 0 ? "" : `${output.join("\n")}\n`;
}

export const TEST_ONLY = {
  planGraph,
};
