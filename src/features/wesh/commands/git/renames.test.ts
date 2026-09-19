import { describe, expect, it } from 'vitest';
import { estimateGitRenameSimilarityScore, findExactRenames, findGitRenameMatches, findUnambiguousSimilarityRename } from '@/features/wesh/commands/git/renames';

describe('wesh git exact rename matching', () => {
  it('matches regular-file executable-bit changes without crossing file types', () => {
    const objectId = '1111111111111111111111111111111111111111';
    expect(findExactRenames({
      deleted: [{ path: 'old', objectId, mode: 0o100644 }],
      added: [{ path: 'new', objectId, mode: 0o100755 }],
    })).toEqual([{
      sourcePath: 'old',
      destinationPath: 'new',
      objectId,
      sourceMode: 0o100644,
      destinationMode: 0o100755,
    }]);

    expect(findExactRenames({
      deleted: [{ path: 'old', objectId, mode: 0o100644 }],
      added: [{ path: 'new', objectId, mode: 0o120000 }],
    })).toEqual([]);
  });

  it('pairs multiple identical files like Git, preferring equal basenames before source order', () => {
    const objectId = '1111111111111111111111111111111111111111';
    expect(findExactRenames({
      deleted: [
        { path: 'old/a.txt', objectId, mode: 0o100644 },
        { path: 'old/b.txt', objectId, mode: 0o100644 },
      ],
      added: [
        { path: 'new/a.txt', objectId, mode: 0o100644 },
        { path: 'new/b.txt', objectId, mode: 0o100644 },
      ],
    })).toEqual([
      {
        sourcePath: 'old/a.txt',
        destinationPath: 'new/a.txt',
        objectId,
        sourceMode: 0o100644,
        destinationMode: 0o100644,
      },
      {
        sourcePath: 'old/b.txt',
        destinationPath: 'new/b.txt',
        objectId,
        sourceMode: 0o100644,
        destinationMode: 0o100644,
      },
    ]);
  });

  it('uses stable source order when multiple exact candidates have no basename preference', () => {
    const objectId = '1111111111111111111111111111111111111111';
    expect(findExactRenames({
      deleted: [
        { path: 'a1', objectId, mode: 0o100644 },
        { path: 'a2', objectId, mode: 0o100644 },
      ],
      added: [
        { path: 'b1', objectId, mode: 0o100644 },
        { path: 'b2', objectId, mode: 0o100644 },
      ],
    }).map(rename => [rename.sourcePath, rename.destinationPath])).toEqual([
      ['a1', 'b1'],
      ['a2', 'b2'],
    ]);
  });
});

describe('wesh git similarity rename matching', () => {
  const encoder = new TextEncoder();

  it('uses the Git diffcore span scorer for an unambiguous modified rename', () => {
    const source = {
      path: 'old.txt',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode(`\
one
two
three
four
five
six
seven
eight
nine
ten
eleven
twelve
thirteen
fourteen
fifteen
sixteen
seventeen
eighteen
nineteen
twenty
`),
    };
    const destination = {
      ...source,
      path: 'new.txt',
      objectId: '2222222222222222222222222222222222222222',
      bytes: encoder.encode(`\
one
two
three
four
five
six
seven
eight
nine
ten
eleven
twelve
thirteen
fourteen
fifteen
sixteen
seventeen
eighteen
nineteen
changed
`),
    };

    const score = estimateGitRenameSimilarityScore({ source, destination });
    expect(score).toBeGreaterThanOrEqual(55_800);
    expect(score).toBeLessThan(56_400);
    expect(findUnambiguousSimilarityRename({ deleted: [source], added: [destination] })).toEqual({
      sourcePath: 'old.txt',
      destinationPath: 'new.txt',
      score,
    });
  });

  it('matches Git diffcore text scoring across CRLF and LF content', () => {
    const source = {
      path: 'old.txt',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode(`\
alpha\r
beta\r
gamma\r
delta\r
epsilon\r
`),
    };
    const destination = {
      ...source,
      path: 'new.txt',
      objectId: '2222222222222222222222222222222222222222',
      bytes: encoder.encode(`\
alpha
beta
gamma
delta
epsilon
`),
    };
    const score = estimateGitRenameSimilarityScore({ source, destination });
    expect(score).toBeGreaterThanOrEqual(51_600);
    expect(score).toBeLessThan(52_200);
  });

  it('does not guess when candidate pairing is ambiguous or similarity is below the default threshold', () => {
    const source = {
      path: 'old.txt',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode('aaaaaaaaaaaaaaaa\n'),
    };
    const unrelated = {
      path: 'new.txt',
      objectId: '2222222222222222222222222222222222222222',
      mode: 0o100644,
      bytes: encoder.encode('zzzzzzzzzzzzzzzz\n'),
    };
    expect(findUnambiguousSimilarityRename({ deleted: [source], added: [unrelated] })).toBeUndefined();
    expect(findUnambiguousSimilarityRename({ deleted: [source, { ...source, path: 'other.txt' }], added: [unrelated] })).toBeUndefined();
  });

  it('matches multiple modified renames without guessing across destinations', () => {
    const sourceA = {
      path: 'old-a.txt',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode(`\
alpha
needle
one
two
three
four
five
`),
    };
    const sourceB = {
      path: 'old-b.txt',
      objectId: '2222222222222222222222222222222222222222',
      mode: 0o100644,
      bytes: encoder.encode(`\
beta
needle
six
seven
eight
nine
ten
`),
    };
    const destinationA = {
      ...sourceA,
      path: 'new-x.txt',
      objectId: '3333333333333333333333333333333333333333',
      bytes: encoder.encode(`\
alpha
needle
one
two
three
four
changed-a
`),
    };
    const destinationB = {
      ...sourceB,
      path: 'new-y.txt',
      objectId: '4444444444444444444444444444444444444444',
      bytes: encoder.encode(`\
beta
needle
six
seven
eight
nine
changed-b
`),
    };

    expect(findGitRenameMatches({
      deleted: [sourceA, sourceB],
      added: [destinationB, destinationA],
      renameLimit: 1_000,
    }).map(match => [match.sourcePath, match.destinationPath]).sort()).toEqual([
      ['old-a.txt', 'new-x.txt'],
      ['old-b.txt', 'new-y.txt'],
    ]);
  });

  it('applies the Git basename shortcut before the exhaustive similarity matrix', () => {
    const basenameSource = {
      path: 'old/same.txt',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode(`\
alpha
beta
gamma
delta
epsilon
zeta
eta
theta
`),
    };
    const moreSimilarSource = {
      path: 'old/other.txt',
      objectId: '2222222222222222222222222222222222222222',
      mode: 0o100644,
      bytes: encoder.encode(`\
alpha
beta
gamma
delta
epsilon
zeta
eta
changed
`),
    };
    const destination = {
      path: 'new/same.txt',
      objectId: '3333333333333333333333333333333333333333',
      mode: 0o100644,
      bytes: encoder.encode(`\
alpha
beta
gamma
delta
epsilon
zeta
eta
changed
`),
    };

    const basenameScore = estimateGitRenameSimilarityScore({ source: basenameSource, destination });
    const otherScore = estimateGitRenameSimilarityScore({ source: moreSimilarSource, destination });
    expect(basenameScore).toBeGreaterThanOrEqual(45_000);
    expect(otherScore).toBeGreaterThan(basenameScore);
    expect(findGitRenameMatches({
      deleted: [basenameSource, moreSimilarSource],
      added: [destination],
      renameLimit: 1_000,
    })).toEqual([{
      sourcePath: 'old/same.txt',
      destinationPath: 'new/same.txt',
      score: basenameScore,
    }]);
  });

  it('stops inexact matrix matching when the rename limit is exceeded', () => {
    const sourceA = {
      path: 'a',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode(`\
alpha
beta
gamma
delta
`),
    };
    const sourceB = { ...sourceA, path: 'b', objectId: '2222222222222222222222222222222222222222' };
    const destinationA = {
      ...sourceA,
      path: 'x',
      objectId: '3333333333333333333333333333333333333333',
      bytes: encoder.encode(`\
alpha
beta
gamma
changed
`),
    };
    const destinationB = { ...destinationA, path: 'y', objectId: '4444444444444444444444444444444444444444' };

    expect(findGitRenameMatches({
      deleted: [sourceA, sourceB],
      added: [destinationA, destinationB],
      renameLimit: 1,
    })).toEqual([]);
    expect(findGitRenameMatches({
      deleted: [sourceA, sourceB],
      added: [destinationA, destinationB],
      renameLimit: 0,
    })).toHaveLength(2);
  });

  it('limits inexact matching to regular non-empty files', () => {
    const regular = {
      path: 'old',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      bytes: encoder.encode('same-ish\n'),
    };
    expect(estimateGitRenameSimilarityScore({
      source: { ...regular, mode: 0o120000 },
      destination: { ...regular, path: 'new', objectId: '2222222222222222222222222222222222222222' },
    })).toBe(0);
    expect(estimateGitRenameSimilarityScore({
      source: { ...regular, bytes: new Uint8Array() },
      destination: { ...regular, path: 'new', objectId: '2222222222222222222222222222222222222222' },
    })).toBe(0);
  });
});
