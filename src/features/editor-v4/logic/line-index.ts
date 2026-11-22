const blockSize = 256;

interface NewlineBlock {
  offset: number;
  readonly positions: readonly number[];
  linesBefore: number;
}

function appendNewlines({ text, offset, positions }: {
  text: string,
  offset: number,
  positions: number[],
}): void {
  let index = text.indexOf('\n');
  while (index !== -1) {
    positions.push(offset + index);
    index = text.indexOf('\n', index + 1);
  }
}

function buildBlocks({ positions }: { positions: readonly number[] }): NewlineBlock[] {
  const blocks: NewlineBlock[] = [];
  for (let start = 0; start < positions.length; start += blockSize) {
    const offset = positions[start]!;
    blocks.push({
      offset,
      positions: positions.slice(start, start + blockSize).map(position => position - offset),
      linesBefore: 0,
    });
  }
  return blocks;
}

export class EditorLineIndex {
  private blocks: NewlineBlock[] = [];
  private count = 0;

  constructor({ text }: { text: string }) {
    this.reset({ text });
  }

  get lineCount(): number {
    return this.count + 1;
  }

  reset({ text }: { text: string }): void {
    const positions: number[] = [];
    appendNewlines({ text, offset: 0, positions });
    this.blocks = buildBlocks({ positions });
    this.updateLineNumbers({ first: 0 });
  }

  replace({ start, end, text }: { start: number, end: number, text: string }): void {
    const changeInLength = text.length - (end - start);
    const first = this.getBlockForOffset({ offset: start });
    const last = this.getBlockForOffset({ offset: end });
    if (first === this.blocks.length && !text.includes('\n')) {
      return;
    }
    const positions: number[] = [];
    const firstBlock = this.blocks[first];
    if (firstBlock !== undefined) {
      for (const position of firstBlock.positions) {
        const absolute = firstBlock.offset + position;
        if (absolute >= start) {
          break;
        }
        positions.push(absolute);
      }
    }
    appendNewlines({ text, offset: start, positions });
    const lastBlock = this.blocks[last];
    if (lastBlock !== undefined) {
      for (const position of lastBlock.positions) {
        const absolute = lastBlock.offset + position;
        if (absolute >= end) {
          positions.push(absolute + changeInLength);
        }
      }
    }

    const replacement = buildBlocks({ positions });
    const removedCount = Math.min(last + 1, this.blocks.length) - first;
    this.blocks.splice(first, removedCount, ...replacement);
    if (changeInLength !== 0) {
      for (let index = first + replacement.length; index < this.blocks.length; index++) {
        this.blocks[index]!.offset += changeInLength;
      }
    }
    this.updateLineNumbers({ first });
  }

  getPosition({ offset }: { offset: number }): { line: number, column: number } {
    const block = this.blocks[this.getBlockForOffset({ offset })];
    if (block === undefined) {
      return { line: this.lineCount, column: offset - this.getLineStart({ line: this.lineCount }) + 1 };
    }
    let index = 0;
    while (block.offset + block.positions[index]! < offset) {
      index++;
    }
    const line = block.linesBefore + index + 1;
    return { line, column: offset - this.getLineStart({ line }) + 1 };
  }

  getLineStart({ line }: { line: number }): number {
    if (line === 1) {
      return 0;
    }
    const newlineIndex = line - 2;
    let left = 0;
    let right = this.blocks.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const block = this.blocks[middle]!;
      if (block.linesBefore + block.positions.length <= newlineIndex) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }
    const block = this.blocks[left]!;
    return block.offset + block.positions[newlineIndex - block.linesBefore]! + 1;
  }

  private getBlockForOffset({ offset }: { offset: number }): number {
    let left = 0;
    let right = this.blocks.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      const block = this.blocks[middle]!;
      if (block.offset + block.positions.at(-1)! < offset) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }
    return left;
  }

  private updateLineNumbers({ first }: { first: number }): void {
    const previous = this.blocks[first - 1];
    let linesBefore = previous === undefined ? 0 : previous.linesBefore + previous.positions.length;
    for (let index = first; index < this.blocks.length; index++) {
      const block = this.blocks[index]!;
      block.linesBefore = linesBefore;
      linesBefore += block.positions.length;
    }
    this.count = linesBefore;
  }
}

export const TEST_ONLY = {
};
