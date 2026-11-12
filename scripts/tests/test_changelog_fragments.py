from __future__ import annotations

from datetime import date
import itertools
import os
from pathlib import Path, PureWindowsPath
import random
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import changelog_format as format
import release_start as release
import test_release_start as legacy


NAME = 'changes-20261112T063045.123Z-workflow-branching.md'
ENTRY = '### Fixed\n\n- Fix conditional branching.\n'
INSTRUCTIONS = '''<!-- changelog-unreleased:instructions
See changelog-unreleased/AGENTS.md.
-->
'''


def fragment(*, category: str = 'Fixed', body: str = 'Independent fix.',
             name: str = NAME) -> release.ChangelogFragment:
    return release.parse_changelog_fragment(path=Path(name), content=f'### {category}\n\n- {body}\n')


def prepare(*, notes: str, fragments: tuple[release.ChangelogFragment, ...],
            newline: str = '\n', allow_empty: bool = False) -> str:
    content = (legacy.PREAMBLE + '\n' + notes + '\n\n' + legacy.HISTORY + '\n' + legacy.LINKS).replace('\n', newline)
    return release.prepare_changelog(content=content, next_version='0.62.1', release_date=date(2026, 11, 12),
                                     allow_empty=allow_empty, fragments=fragments)


class FragmentParsingTests(unittest.TestCase):
    def test_all_categories_and_inline_markup_preserve_exact_prose(self):
        for category in release.CHANGE_CATEGORY_ORDER:
            with self.subTest(category=category):
                item = fragment(category=category, body='**Breaking:** Fix `<!--`, café and [a link](https://example.test).  \n  Keep the hard break.')
                self.assertEqual(item.category, category)
                self.assertIn('test).  \n  Keep', item.bullet)

    def test_inline_code_with_long_backtick_delimiters_is_not_a_fenced_block(self):
        for body in ('```literal```', '````literal`backtick````', 'Fix the example.\n  ```literal```'):
            with self.subTest(body=body):
                self.assertEqual(fragment(body=body).bullet, '- ' + body)

    def test_line_endings_outer_blank_lines_and_no_final_newline(self):
        for content in (ENTRY, ENTRY.rstrip('\n'), '\n \n' + ENTRY + '\n ', ENTRY.replace('\n', '\r\n')):
            with self.subTest(content=content):
                item = release.parse_changelog_fragment(path=Path(NAME), content=content)
                self.assertEqual(item.bullet, '- Fix conditional branching.')
                self.assertEqual(item.original, content)

    def test_filename_dates_are_real_utc_calendar_values_not_release_dates(self):
        for timestamp in ('00010101T000000.000Z', '20280229T235959.999Z', '99991231T235959.999Z'):
            with self.subTest(timestamp=timestamp):
                item = fragment(name=f'changes-{timestamp}-topic-2.md')
                self.assertEqual(item.category, 'Fixed')
        for timestamp in ('20260229T000000.000Z', '20261301T000000.000Z', '20261131T000000.000Z',
                          '00000101T000000.000Z', '20261112T240000.000Z', '20261112T006000.000Z',
                          '20261112T000060.000Z', '20261112T000000.00Z', '20261112T000000.0000Z',
                          '20261112T000000Z', '20261112T000000.000+0000', '２０２６1112T000000.000Z'):
            with self.subTest(timestamp=timestamp), self.assertRaises(SystemExit):
                fragment(name=f'changes-{timestamp}-topic.md')

    def test_invalid_topics_and_names_are_rejected(self):
        for name in ('changes.md', 'changes-bad.md', NAME.upper(), NAME.replace('workflow-branching', '-bad'),
                     NAME.replace('workflow-branching', 'bad--topic'), NAME.replace('workflow-branching', 'bad_thing'),
                     NAME.replace('workflow-branching', 'bad-'), NAME.replace('workflow-branching', 'é'),
                     NAME.replace('workflow-branching', 'Topic'), NAME.replace('changes-', 'entry-', 1)):
            with self.subTest(name=name), self.assertRaisesRegex(SystemExit, 'filename'):
                fragment(name=name)

    def test_rejects_invalid_or_ambiguous_item_structures(self):
        for content in ('', '### Fix\n\n- A fix.', '### Fixed\n- A fix.', '### Fixed\n\n',
                        '### Fixed\n\n- ', '### Fixed\n\n- [ ]', '### Fixed\n\n- [x]',
                        '### Fixed\n\n- A fix.\n- Another fix.', '### Fixed\n\n* A fix.',
                        '### Fixed\n\n- A fix.\n### Added\n\n- A feature.',
                        '### Fixed\n\n- A fix.\n\nA paragraph.', '### Fixed\n\n- A fix.\n  - Nested.',
                        '### Fixed\n\n- A fix.\n  1. Nested.', '### Fixed\n\n- ### Heading',
                        '### Fixed\n\n- A fix.\n\n  Another paragraph.', '### Fixed\n\n- A fix.\nnot indented.',
                        '### Fixed\n\n- A fix.\n    Four spaces.', '### Fixed\n\n- A fix.\n  ```python\n  pass\n  ```',
                        '### Fixed\n\n- A fix.\n  > A quote.', '### Fixed\n\n- A fix.\n  [doc]: https://example.test',
                        '### Fixed\n\n- ---', '### Fixed\n\n- A fix.\n  ===',
                        '### Fixed\n\n- <!-- hidden -->', '### Fixed\n\n- A fix. <!-- unfinished',
                        '### Fixed\n\n- A fix.\n    <!-- hidden', '### Fixed\n\n- A fix.\n  <!-- hidden -->'):
            with self.subTest(content=content), self.assertRaises(SystemExit):
                release.parse_changelog_fragment(path=Path(NAME), content=content)

    def test_rejects_non_lf_separators_and_bom(self):
        for marker in ('\x00', '\r', '\x0b', '\x0c', '\x85', '\u2028', '\u2029', '\ufeff'):
            with self.subTest(marker=repr(marker)), self.assertRaisesRegex(SystemExit, 'control character|BOM'):
                release.parse_changelog_fragment(path=Path(NAME), content=ENTRY.replace('branching', 'branch' + marker + 'ing'))


class FragmentFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'changelog-unreleased'
        self.directory.mkdir()

    def write(self, *, name: str = NAME, text: str = ENTRY) -> Path:
        path = self.directory / name
        path.write_text(text, encoding='utf-8')
        return path

    def test_missing_empty_and_ignored_files(self):
        self.assertEqual(release.load_changelog_fragments(directory=self.root / 'missing'), ())
        self.assertEqual(release.load_changelog_fragments(directory=self.directory), ())
        for name in ('AGENTS.md', 'notes.md', 'changes-draft.txt', 'changes-draft.MD'):
            (self.directory / name).write_bytes(b'\xff ignored')
        nested = self.directory / 'nested'
        nested.mkdir()
        (nested / NAME).write_text('invalid nested file')
        self.write()
        self.assertEqual([item.path.name for item in release.load_changelog_fragments(directory=self.directory)], [NAME])

    def test_candidate_malformed_name_is_not_silently_skipped(self):
        self.write(name='changes-invalid.md')
        with self.assertRaisesRegex(SystemExit, 'filename'):
            release.load_changelog_fragments(directory=self.directory)

    def test_invalid_utf8_and_candidate_directory_fail(self):
        path = self.write()
        path.write_bytes(b'\xff')
        with self.assertRaisesRegex(SystemExit, 'Cannot read'):
            release.load_changelog_fragments(directory=self.directory)
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(SystemExit, 'regular file'):
            release.load_changelog_fragments(directory=self.directory)

    @unittest.skipIf(os.name == 'nt', 'Symlinks may require additional privileges.')
    def test_symlinks_including_dangling_paths_are_rejected(self):
        target = self.root / 'target.md'
        target.write_text(ENTRY)
        path = self.directory / NAME
        for destination in (target, self.root / 'missing'):
            path.symlink_to(destination)
            with self.assertRaisesRegex(SystemExit, 'regular file'):
                release.load_changelog_fragments(directory=self.directory)
            path.unlink()
        for destination in (self.directory, self.root / 'missing'):
            alias = self.root / 'alias'
            alias.symlink_to(destination, target_is_directory=True)
            with self.assertRaisesRegex(SystemExit, 'real directory'):
                release.load_changelog_fragments(directory=alias)
            alias.unlink()
        (self.directory / 'AGENTS.md').symlink_to(target)
        self.assertEqual(release.load_changelog_fragments(directory=self.directory), ())

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'Named pipes are not available.')
    def test_special_file_is_rejected_without_opening_or_blocking(self):
        os.mkfifo(self.directory / NAME)
        with self.assertRaisesRegex(SystemExit, 'regular file'):
            release.load_changelog_fragments(directory=self.directory)

    def test_git_inventory_uses_forward_slash_paths_on_windows_too(self):
        root = PureWindowsPath('C:/repo')
        item = fragment()._replace(path=root / 'changelog-unreleased' / NAME)
        name = 'changelog-unreleased/' + NAME
        with mock.patch.object(release, 'REPO_ROOT', root), mock.patch.object(
                release, 'FRAGMENTS_PATH', root / 'changelog-unreleased'), mock.patch.object(
                release, 'run_git_command', return_value='H ' + name + '\0') as git:
            release.ensure_fragments_tracked(fragments=(item,))
        git.assert_called_once_with(args=['ls-files', '-v', '-z', '--', 'changelog-unreleased/'], capture_output=True)

    def test_staging_many_paths_uses_exact_nul_delimited_stdin(self):
        root = PureWindowsPath('C:/repo')
        paths = [root / f'changelog-unreleased/changes-20261112T063045.123Z-entry-{i}.md' for i in range(2000)]
        with mock.patch.object(release, 'REPO_ROOT', root), mock.patch.object(release, 'run_git_command') as git:
            release.stage_release_paths(paths=paths)
        args = git.call_args.kwargs
        self.assertEqual(args['args'], ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'])
        self.assertEqual(args['input_text'].split('\0')[:-1], [path.relative_to(root).as_posix() for path in paths])
        self.assertTrue(args['input_text'].endswith('\0'))

    def test_capture_is_sorted_and_checks_exact_content_and_inventory(self):
        late = self.write()
        self.write(name=NAME.replace('063045', '063044'))
        items = release.load_changelog_fragments(directory=self.directory)
        self.assertEqual([item.path.name for item in items], sorted(item.path.name for item in items))
        release.ensure_fragments_unchanged(directory=self.directory, fragments=items)
        self.write(name='notes.md', text='Unrelated edits are allowed.')
        release.ensure_fragments_unchanged(directory=self.directory, fragments=items)
        late.write_bytes(ENTRY.replace('\n', '\r\n').encode())
        with self.assertRaisesRegex(SystemExit, 'changed'):
            release.ensure_fragments_unchanged(directory=self.directory, fragments=items)
        late.write_text(ENTRY)
        self.write(name=NAME.replace('branching', 'different'))
        with self.assertRaisesRegex(SystemExit, 'inventory'):
            release.ensure_fragments_unchanged(directory=self.directory, fragments=items)
        late.unlink()
        with self.assertRaisesRegex(SystemExit, 'inventory'):
            release.ensure_fragments_unchanged(directory=self.directory, fragments=items)


class FragmentIntegrationFormatTests(unittest.TestCase):
    def body(self, *, actual: str) -> str:
        return format.render_notes(content=actual)['v0.62.1']

    def test_legacy_and_fragments_keep_both_without_duplicate_headings(self):
        items = (fragment(category='Added', body='New feature.'), fragment(body='New fix.', name=NAME.replace('branching', 'fix')))
        actual = prepare(notes=legacy.NOTES, fragments=items)
        body = self.body(actual=actual)
        self.assertEqual(body.count('### Added'), 1)
        self.assertEqual(body.count('### Fixed'), 1)
        self.assertLess(body.index('A reviewed feature'), body.index('New feature.'))
        self.assertLess(body.index('A reviewed fix'), body.index('New fix.'))
        self.assertIn(legacy.HISTORY, actual)

    def test_fragment_only_is_sorted_by_category_timestamp_and_topic(self):
        items = tuple(fragment(category=category, body=category, name=NAME.replace('branching', category.lower()))
                      for category in reversed(release.CHANGE_CATEGORY_ORDER))
        body = self.body(actual=prepare(notes=INSTRUCTIONS, fragments=items))
        positions = [body.index(f'### {category}') for category in release.CHANGE_CATEGORY_ORDER]
        self.assertEqual(positions, sorted(positions))
        ties = (fragment(body='Later.', name=NAME.replace('063045', '063046')),
                fragment(body='Tie Z.', name=NAME.replace('branching', 'z')),
                fragment(body='Tie A.', name=NAME.replace('branching', 'a')))
        results = {prepare(notes='', fragments=permutation) for permutation in itertools.permutations(ties)}
        self.assertEqual(len(results), 1)
        body = self.body(actual=results.pop())
        self.assertLess(body.index('Tie A.'), body.index('Tie Z.'))
        self.assertLess(body.index('Tie Z.'), body.index('Later.'))

    def test_preserves_legacy_category_order_and_adds_only_missing_categories(self):
        notes = 'Introduction.\n\n### Security\n\n- Existing security fix.\n\n### Added\n\n- Existing feature.'
        items = tuple(fragment(category=category, name=NAME.replace('branching', category.lower()))
                      for category in release.CHANGE_CATEGORY_ORDER)
        body = self.body(actual=prepare(notes=notes, fragments=items))
        categories = [line for line in body.splitlines() if line.startswith('### ')]
        self.assertEqual(categories, ['### Security', '### Added', '### Changed', '### Deprecated', '### Removed', '### Fixed'])
        self.assertTrue(body.startswith('Introduction.'))

    def test_legacy_prose_comments_code_and_subsections_are_not_rewritten(self):
        notes = '''### Fixed

A paragraph with a hard break.\x20\x20
Continued prose.

<!-- Keep this release comment. -->

- An existing example:

````markdown
### Added
#### Not a real subsection
<!-- literal
````

#### Details

- This belongs to the existing subsection.
'''
        body = self.body(actual=prepare(notes=notes, fragments=(fragment(),)))
        self.assertIn(notes.split('### Fixed\n', 1)[1].split('#### Details', 1)[0].rstrip('\n'), body)
        self.assertIn(notes[notes.index('#### Details'):].rstrip('\n'), body)
        self.assertLess(body.index('Independent fix.'), body.index('#### Details'))
        self.assertLess(body.index('Independent fix.'), body.index('A paragraph'))
        self.assertIn(notes.split('### Fixed\n', 1)[1].strip('\n'), body)

    def test_nested_subheading_does_not_steal_the_existing_list_item(self):
        notes = '''### Fixed

- Existing item:
  #### Its nested details
  These details belong only to the existing item.
'''
        body = self.body(actual=prepare(notes=notes, fragments=(fragment(),)))
        self.assertIn(notes.split('### Fixed\n', 1)[1].strip('\n'), body)
        self.assertLess(body.index('Independent fix.'), body.index('Existing item:'))

    def test_instruction_marker_tolerates_markdown_indentation_and_trailing_spaces(self):
        for indent in ('', ' ', '  ', '   '):
            marked = ''.join(indent + line + '  \n' for line in INSTRUCTIONS.splitlines())
            with self.subTest(indent=indent):
                actual = prepare(notes=marked, fragments=(fragment(),))
                self.assertIn(marked.rstrip('\n'), actual.split('## [0.62.1]')[0])
                self.assertNotIn('changelog-unreleased:instructions', self.body(actual=actual))

    def test_duplicate_text_is_not_automatically_discarded(self):
        body = self.body(actual=prepare(notes='### Fixed\n\n- Same note.', fragments=(fragment(body='Same note.'),)))
        self.assertEqual(body.count('- Same note.'), 2)

    def test_crlf_legacy_history_and_hard_breaks_survive(self):
        actual = prepare(notes=INSTRUCTIONS + '\n' + legacy.NOTES,
                         fragments=(fragment(body='A fix.  \n  A continuation.'),), newline='\r\n')
        self.assertNotIn('\n', actual.replace('\r\n', ''))
        self.assertIn('- A fix.  \r\n  A continuation.', actual)
        self.assertIn(legacy.HISTORY.replace('\n', '\r\n'), actual)
        self.assertIn(INSTRUCTIONS.replace('\n', '\r\n'), actual)

    def test_leading_instruction_comment_stays_unreleased_across_releases(self):
        once = prepare(notes=INSTRUCTIONS + '\n' + legacy.NOTES, fragments=(fragment(),))
        prefix, released = once.split('## [0.62.1]', 1)
        self.assertIn(INSTRUCTIONS, prefix)
        self.assertNotIn('changelog-unreleased:instructions', released)
        self.assertNotIn('changelog-unreleased:instructions', self.body(actual=once))
        twice = release.prepare_changelog(content=once, next_version='0.62.2', release_date=date(2026, 11, 13),
                                          allow_empty=False, fragments=(fragment(body='Second release.'),))
        self.assertEqual(twice.count(INSTRUCTIONS), 1)
        self.assertEqual(twice.count('Independent fix.'), 1)
        self.assertIn('Second release.', format.render_notes(content=twice)['v0.62.2'])
        self.assertNotIn('Independent fix.', format.render_notes(content=twice)['v0.62.2'])

    def test_instruction_comment_is_not_required_and_ordinary_comments_move(self):
        for notes in (legacy.NOTES, '<!-- ordinary comment -->\n' + legacy.NOTES):
            actual = prepare(notes=notes, fragments=())
            self.assertIn(notes.strip('\n'), self.body(actual=actual))

    def test_marker_examples_in_code_are_not_instructions(self):
        for notes in ('- Example:\n\n```html\n' + INSTRUCTIONS + '```\n',
                      '- Example:\n\n' + ''.join('    ' + line + '\n' for line in INSTRUCTIONS.splitlines()),
                      '- Example: `<!-- changelog-unreleased:instructions` is literal.'):
            with self.subTest(notes=notes):
                body = self.body(actual=prepare(notes=notes, fragments=(fragment(),)))
                self.assertIn(notes.rstrip('\n'), body)

    def test_misplaced_duplicated_or_malformed_marked_comment_is_rejected(self):
        for notes in (legacy.NOTES + INSTRUCTIONS, INSTRUCTIONS + INSTRUCTIONS,
                      INSTRUCTIONS.replace('-->\n', '--> trailing text\n') + legacy.NOTES,
                      INSTRUCTIONS.replace('See ', '<!-- nested -->\nSee ') + legacy.NOTES):
            with self.subTest(notes=notes), self.assertRaises(SystemExit):
                prepare(notes=notes, fragments=(fragment(),))

    def test_empty_sources_need_opt_in_even_with_instruction_comment(self):
        for notes in ('', INSTRUCTIONS, INSTRUCTIONS + '\n### Added\n'):
            with self.subTest(notes=notes), self.assertRaisesRegex(SystemExit, 'no release notes'):
                prepare(notes=notes, fragments=())
            actual = prepare(notes=notes, fragments=(), allow_empty=True)
            self.assertIn('## [0.62.1]', actual)

    def test_no_history_first_release_is_supported(self):
        actual = release.prepare_changelog(content=legacy.PREAMBLE + '\n' + INSTRUCTIONS,
            next_version='0.1.0', release_date=date(2026, 11, 12), allow_empty=False, fragments=(fragment(),))
        self.assertEqual(set(format.render_notes(content=actual)), {'v0.1.0'})
        self.assertIn('Independent fix.', actual)

    def test_historical_published_notes_are_unchanged(self):
        before = format.render_notes(content=legacy.CHANGELOG)
        after = format.render_notes(content=prepare(notes=INSTRUCTIONS + '\n' + legacy.NOTES, fragments=(fragment(),)))
        for tag, body in before.items():
            self.assertEqual(after[tag], body)

    def test_large_input_is_checked_after_combining_both_sources(self):
        notes = '### Fixed\n\n- ' + 'a' * 65000
        items = (fragment(body='あ' * 21000),)
        actual = prepare(notes=notes, fragments=items)
        with self.assertRaisesRegex(ValueError, 'size limit'):
            format.render_notes(content=actual)

    def test_randomized_input_order_preserves_every_unique_item_once(self):
        rng = random.Random(7)
        items = [fragment(category=rng.choice(release.CHANGE_CATEGORY_ORDER), body=f'Unique item {i:03d}.',
                          name=f'changes-20261112T063045.{i:03d}Z-topic.md') for i in range(120)]
        expected = prepare(notes=legacy.NOTES, fragments=tuple(items))
        for _ in range(25):
            rng.shuffle(items)
            self.assertEqual(prepare(notes=legacy.NOTES, fragments=tuple(items)), expected)
        body = self.body(actual=expected)
        for i in range(120):
            self.assertEqual(body.count(f'Unique item {i:03d}.'), 1)


if __name__ == '__main__':
    unittest.main()
