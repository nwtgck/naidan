import { describe, expect, it } from "vitest";
import { renderGitLogGraph } from "./graph";

const oneSpace = " ";
const twoSpaces = "  ";

describe("wesh git log graph renderer", () => {
  it("renders linear history and a two-parent topic merge", () => {
    expect(renderGitLogGraph({
      entries: [
        { objectId: "merge", parentObjectIds: ["main", "topic2"], lines: ["merge"] },
        { objectId: "topic2", parentObjectIds: ["topic1"], lines: ["topic2"] },
        { objectId: "topic1", parentObjectIds: ["base"], lines: ["topic1"] },
        { objectId: "main", parentObjectIds: ["base"], lines: ["main"] },
        { objectId: "base", parentObjectIds: [], lines: ["base"] },
      ],
    })).toBe(`\
*   merge
|\\${twoSpaces}
| * topic2
| * topic1
* | main
|/${twoSpaces}
* base
`);
  });

  it("uses transition rows for multiline commit output", () => {
    expect(renderGitLogGraph({
      entries: [
        {
          objectId: "merge",
          parentObjectIds: ["main", "topic"],
          lines: ["commit merge", "Merge: main topic", "Author: Test", "", "    merge", ""],
        },
        {
          objectId: "topic",
          parentObjectIds: ["base"],
          lines: ["commit topic", "Author: Test", "", "    topic", ""],
        },
        {
          objectId: "main",
          parentObjectIds: ["base"],
          lines: ["commit main", "Author: Test", "", "    main", ""],
        },
        {
          objectId: "base",
          parentObjectIds: [],
          lines: ["commit base", "Author: Test", "", "    base"],
        },
      ],
    })).toBe(`\
*   commit merge
|\\${twoSpaces}Merge: main topic
| | Author: Test
| |${oneSpace}
| |     merge
| |${oneSpace}
| * commit topic
| | Author: Test
| |${oneSpace}
| |     topic
| |${oneSpace}
* | commit main
|/${twoSpaces}Author: Test
|${oneSpace}
|     main
|${oneSpace}
* commit base
${twoSpaces}Author: Test
${twoSpaces}
      base
`);
  });

  it("rejects nested merges before rendering an approximate graph", () => {
    expect(() => renderGitLogGraph({
      entries: [
        { objectId: "outer", parentObjectIds: ["inner", "right"], lines: ["outer"] },
        { objectId: "right", parentObjectIds: ["base"], lines: ["right"] },
        { objectId: "inner", parentObjectIds: ["main", "left"], lines: ["inner"] },
        { objectId: "left", parentObjectIds: ["base"], lines: ["left"] },
        { objectId: "main", parentObjectIds: ["base"], lines: ["main"] },
        { objectId: "base", parentObjectIds: [], lines: ["base"] },
      ],
    })).toThrow("log --graph does not support this commit topology yet");
  });
});
