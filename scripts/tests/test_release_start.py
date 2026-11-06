from __future__ import annotations

import argparse
from datetime import date
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / 'release_start.py'
SPEC = importlib.util.spec_from_file_location('release_start', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

HISTORY = '''## [0.62.0] - 2026-11-03

### Fixed

- Preserve historical text, including **formatting** and Unicode: café.

## [0.61.0] - 2026-10-29

### Added

- An older feature.
'''
LINKS = '''[Unreleased]: https://github.com/nwtgck/naidan/compare/v0.62.0...develop
[0.62.0]: https://github.com/nwtgck/naidan/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/nwtgck/naidan/releases/tag/v0.61.0
'''
PREAMBLE = '''# Changelog

<!-- Keep standard Markdown headings. -->

## [Unreleased]
'''
NOTES = '''
### Added

- A reviewed feature, with **formatting** intact.

### Fixed

- A reviewed fix.

'''
CHANGELOG = PREAMBLE + NOTES + HISTORY + '\n' + LINKS


class ChangelogTests(unittest.TestCase):
    def render(self, *, content: str, allow_empty: bool = False) -> str:
        return release.prepare_changelog(content=content, next_version='0.62.1', release_date=date(2026, 11, 4), allow_empty=allow_empty)

    def test_moves_notes_and_preserves_history(self) -> None:
        actual = self.render(content=CHANGELOG)
        self.assertIn('## [Unreleased]\n\n## [0.62.1] - 2026-11-04\n' + NOTES, actual)
        self.assertEqual(actual.count('A reviewed feature'), 1)
        self.assertIn(HISTORY, actual)
        self.assertIn('[Unreleased]: https://github.com/nwtgck/naidan/compare/v0.62.1...develop\n', actual)
        self.assertIn('[0.62.1]: https://github.com/nwtgck/naidan/compare/v0.62.0...v0.62.1\n', actual)
        self.assertTrue(actual.endswith(LINKS.split('\n', 1)[1]))

    def test_supports_changelog_without_reference_links(self) -> None:
        actual = self.render(content=PREAMBLE + NOTES + HISTORY)
        self.assertTrue(actual.endswith(HISTORY))
        self.assertNotIn('[0.62.1]:', actual)

    def test_supports_first_release(self) -> None:
        actual = release.prepare_changelog(content=PREAMBLE + NOTES, next_version='0.1.0', release_date=date(2026, 1, 27), allow_empty=False)
        self.assertIn('## [0.1.0] - 2026-01-27', actual)
        self.assertEqual(actual.count('## [Unreleased]'), 1)

    def test_preserves_crlf_and_no_final_newline(self) -> None:
        content = (PREAMBLE + NOTES + HISTORY.rstrip('\n')).replace('\n', '\r\n')
        actual = self.render(content=content)
        self.assertNotIn('\n', actual.replace('\r\n', ''))
        self.assertTrue(actual.endswith(HISTORY.rstrip('\n').replace('\n', '\r\n')))

    def test_comments_and_fenced_examples_are_not_release_headings(self) -> None:
        notes = '''
### Added

- Added support for this example:

````markdown
## [Unreleased]
## [99.0.0] - 2099-01-01
```
<!-- a literal comment inside the example
````

~~~text
## Not a release heading
~~~~

<!--
## [Unreleased]
## [98.0.0] - 2098-01-01
-->

'''
        actual = self.render(content=PREAMBLE + notes + HISTORY)
        self.assertIn(notes, actual)
        self.assertTrue(actual.endswith(HISTORY))

    def test_ignores_indented_examples_and_blockquotes_as_boundaries(self) -> None:
        notes = '\n- An example:\n\n    ## [Unreleased]\n\n> ## [Unreleased]\n\n'
        self.assertIn(notes, self.render(content=PREAMBLE + notes + HISTORY))

    def test_accepts_standard_categories_and_paragraph_notes(self) -> None:
        for category in sorted(release.CHANGE_CATEGORIES):
            with self.subTest(category=category):
                notes = f'\n### {category}\n\nA reviewed change.\n\n'
                self.assertIn(notes, self.render(content=PREAMBLE + notes + HISTORY))

    def test_rejects_missing_duplicate_or_noncanonical_unreleased(self) -> None:
        for content in (
            HISTORY,
            PREAMBLE + NOTES + '## [Unreleased]\n\n' + HISTORY,
            CHANGELOG.replace('## [Unreleased]', '## Unreleased'),
            CHANGELOG.replace('## [Unreleased]', '## [Unreleased] - 2026-11-04'),
            CHANGELOG.replace('## [Unreleased]', '  ## [Unreleased]'),
        ):
            with self.subTest(content=content[:90]):
                with self.assertRaises(SystemExit):
                    self.render(content=content)

    def test_rejects_malformed_duplicate_and_out_of_order_releases(self) -> None:
        for history in (
            HISTORY + '\n' + HISTORY,
            HISTORY.replace('0.61.0', '0.63.0'),
            HISTORY.replace('0.61.0', '0.061.0'),
            HISTORY.replace('2026-11-03', '2026-02-30'),
            HISTORY.replace('## [0.61.0] - 2026-10-29', '## Notes'),
            HISTORY.replace('## [0.61.0]', '## [v0.61.0]'),
        ):
            with self.subTest(history=history):
                with self.assertRaises(SystemExit):
                    self.render(content=PREAMBLE + NOTES + history)

    def test_rejects_existing_older_or_invalid_target_version(self) -> None:
        for version in ('0.62.0', '0.61.9', '0.062.1', 'v0.62.1', '0.62.1-dev', '０.62.1'):
            with self.subTest(version=version):
                with self.assertRaises(SystemExit):
                    release.prepare_changelog(content=CHANGELOG, next_version=version, release_date=date(2026, 11, 4), allow_empty=False)

    def test_rejects_date_before_latest_release(self) -> None:
        with self.assertRaisesRegex(SystemExit, 'date'):
            release.prepare_changelog(content=CHANGELOG, next_version='0.63.0', release_date=date(2026, 11, 2), allow_empty=False)

    def test_empty_notes_require_explicit_opt_in(self) -> None:
        for notes in ('\n', '\n  \n', '\n<!-- Draft notes later. -->\n\n', '\n### Added\n\n### Fixed\n\n'):
            with self.subTest(notes=notes):
                content = PREAMBLE + notes + HISTORY
                with self.assertRaisesRegex(SystemExit, 'no release notes'):
                    self.render(content=content)
                actual = self.render(content=content, allow_empty=True)
                self.assertIn('## [0.62.1] - 2026-11-04', actual)
                self.assertTrue(actual.endswith(HISTORY))
                self.assertNotIn('No notable changes', actual)

    def test_rejects_duplicate_or_unknown_categories(self) -> None:
        for notes in ('\n### Enhancements\n\n- New.\n\n', '\n### Added\n\n- One.\n\n### Added\n\n- Two.\n\n'):
            with self.subTest(notes=notes):
                with self.assertRaisesRegex(SystemExit, 'category'):
                    self.render(content=PREAMBLE + notes + HISTORY)

    def test_rejects_unterminated_comments_and_fences(self) -> None:
        for notes in ('\n<!-- unfinished\n', '\n```markdown\n', '\n~~~\n', '\n````\n```\n'):
            with self.subTest(notes=notes):
                with self.assertRaisesRegex(SystemExit, 'unterminated'):
                    self.render(content=PREAMBLE + notes + HISTORY)

    def test_rejects_mismatched_or_duplicate_comparison_links(self) -> None:
        for links in (
            LINKS.replace('v0.62.0...develop', 'v0.61.0...develop'),
            LINKS + '[unreleased]: https://example.test/compare/v0.62.0...develop\n',
            LINKS + '[0.62.1]: https://example.test/compare/v0.62.0...v0.62.1\n',
            LINKS.replace('https://github.com/nwtgck/naidan/compare/v0.62.0...develop', 'https://example.test/not-a-compare-link'),
        ):
            with self.subTest(links=links):
                with self.assertRaises(SystemExit):
                    self.render(content=PREAMBLE + NOTES + HISTORY + '\n' + links)

    def test_rejects_v_prefixed_version_link_labels(self) -> None:
        for label in ('v0.62.0', 'V0.62.0', '  v0.62.0  '):
            with self.subTest(label=label):
                content = CHANGELOG.replace('[0.62.0]:', f'[{label}]:')
                with self.assertRaisesRegex(SystemExit, 'omit the v prefix'):
                    self.render(content=content)

    def test_rejects_normalized_existing_target_link(self) -> None:
        with self.assertRaisesRegex(SystemExit, 'already exists'):
            self.render(content=CHANGELOG + '[  0.62.1  ]: https://example.test/release\n')

    def test_rejects_unprefixed_git_tag_in_unreleased_link(self) -> None:
        with self.assertRaisesRegex(SystemExit, 'latest changelog tag'):
            self.render(content=CHANGELOG.replace('v0.62.0...develop', '0.62.0...develop'))

    def test_compares_unprefixed_versions_numerically(self) -> None:
        for older, newer in (('0.9.0', '0.10.0'), ('9.0.0', '10.0.0'), ('10.0.0', '10.0.1')):
            with self.subTest(older=older, newer=newer):
                content = PREAMBLE + NOTES + f'## [{older}] - 2026-11-03\n'
                actual = release.prepare_changelog(content=content, next_version=newer, release_date=date(2026, 11, 4), allow_empty=False)
                self.assertIn(f'## [{newer}] - 2026-11-04', actual)
                with self.assertRaisesRegex(SystemExit, 'newer'):
                    release.prepare_changelog(content=actual, next_version=older, release_date=date(2026, 11, 5), allow_empty=True)

    def test_preserves_comparison_target(self) -> None:
        actual = self.render(content=CHANGELOG.replace('...develop', '...HEAD'))
        self.assertIn('v0.62.1...HEAD', actual)

    def test_second_release_does_not_reuse_previous_notes(self) -> None:
        once = self.render(content=CHANGELOG)
        with self.assertRaisesRegex(SystemExit, 'no release notes'):
            release.prepare_changelog(content=once, next_version='0.63.0', release_date=date(2026, 11, 5), allow_empty=False)
        twice = release.prepare_changelog(content=once, next_version='0.63.0', release_date=date(2026, 11, 5), allow_empty=True)
        self.assertEqual(twice.count('A reviewed feature'), 1)
        self.assertEqual(twice.count('## [0.62.1]'), 1)

    def test_rejects_repeat_of_same_release(self) -> None:
        with self.assertRaisesRegex(SystemExit, 'newer'):
            self.render(content=self.render(content=CHANGELOG), allow_empty=True)

    def test_validates_date_argument_strictly(self) -> None:
        self.assertEqual(release.parse_release_date('2028-02-29'), date(2028, 2, 29))
        for text in ('2026-02-29', '2026-2-03', '20261104', '0000-01-01', '2026-11-04T00:00:00', '２０２６-11-04'):
            with self.subTest(text=text):
                with self.assertRaises(argparse.ArgumentTypeError):
                    release.parse_release_date(text)

    def test_preserves_existing_version_bump_behavior(self) -> None:
        for current, kind, expected in (
            ('0.62.1-dev', 'patch', '0.62.1'),
            ('0.62.0', 'patch', '0.62.1'),
            ('0.62.1-dev', 'minor', '0.63.0'),
            ('0.62.1-dev', 'major', '1.0.0'),
            ('0.62.0', 'dev', '0.62.1-dev'),
            ('0.62.1-dev', 'dev', '0.62.2-dev'),
        ):
            with self.subTest(current=current, kind=kind):
                self.assertEqual(release.bump_version(current_version=current, bump_kind=kind), expected)


    def test_literal_comment_markers_in_code_do_not_hide_sections(self) -> None:
        for notes in (
            '\n### Added\n\n- Handles `<!--` and ``<!-- literal `text` -->``.\n\n',
            '\n### Added\n\n- Example:\n\n```html <!--\n<!-- literal\n```\n\n',
            '\n### Added\n\n- Example:\n\n    <!-- literal code\n\n',
        ):
            with self.subTest(notes=notes):
                actual = self.render(content=PREAMBLE + notes + HISTORY)
                self.assertIn(notes, actual)
                self.assertTrue(actual.endswith(HISTORY))

    def test_preserves_standard_reference_titles_and_angle_destinations(self) -> None:
        url = 'https://github.com/nwtgck/naidan/compare/v0.62.0...develop'
        for destination in (url, '<' + url + '>'):
            for title in (' "Upcoming changes"', " 'Upcoming changes'", ' (Upcoming changes)', ' "Literal <!-- marker -->"', ' "Literal <!--"', ''):
                with self.subTest(destination=destination, title=title):
                    links = LINKS.replace(url, destination + title)
                    actual = self.render(content=PREAMBLE + NOTES + HISTORY + '\n' + links)
                    self.assertIn(destination.replace('v0.62.0', 'v0.62.1') + title, actual)
                    self.assertEqual(actual.count('[0.62.1]:'), 1)
                    self.assertTrue(actual.endswith(LINKS.split('\n', 1)[1]))

    def test_normalizes_comparison_reference_label_whitespace_and_case(self) -> None:
        actual = self.render(content=CHANGELOG.replace('[Unreleased]:', '[  UnReleased  ]:'))
        self.assertIn('[  UnReleased  ]: https://github.com/nwtgck/naidan/compare/v0.62.1...develop', actual)
        with self.assertRaisesRegex(SystemExit, 'Duplicate'):
            self.render(content=CHANGELOG + '[  unreleased  ]: https://example.test/link\n')

    def test_rejects_unsupported_managed_link_without_silently_skipping_it(self) -> None:
        for links in (
            LINKS.replace('[Unreleased]: https://', '[Unreleased]:\n  https://'),
            LINKS.replace('...develop\n', '...develop invalid-title\n'),
            LINKS.replace('[0.61.0]: https://', '[0.61.0]:\n  https://'),
        ):
            with self.subTest(links=links):
                with self.assertRaisesRegex(SystemExit, 'single-line'):
                    self.render(content=PREAMBLE + NOTES + HISTORY + '\n' + links)

    def test_empty_bullets_checkboxes_and_headings_are_not_notes(self) -> None:
        for notes in ('\n### Added\n\n-\n', '\n- [ ]\n', '\n1.\n', '\n#### Detail\n', '\n---\n', '\n* * *\n'):
            with self.subTest(notes=notes):
                with self.assertRaisesRegex(SystemExit, 'no release notes'):
                    self.render(content=PREAMBLE + notes + HISTORY)

    def test_rejects_unreleased_link_between_history_sections(self) -> None:
        history = HISTORY.replace('## [0.61.0]', LINKS.split('\n')[0] + '\n\n## [0.61.0]')
        with self.assertRaisesRegex(SystemExit, 'after the release sections'):
            self.render(content=PREAMBLE + NOTES + history)

    def test_repository_changelog_preserves_all_history_on_release(self) -> None:
        source = SCRIPT.parents[1] / 'CHANGELOG.md'
        with source.open(encoding='utf-8', newline='') as stream:
            content = stream.read()
        # Do not freeze the current release count or date in a maintenance test.
        tags = [release.RELEASE_HEADING_PATTERN.fullmatch(line) for line in content.splitlines()]
        versions = [match for match in tags if match is not None]
        self.assertGreater(len(versions), 0)
        latest = versions[0]
        target = release.bump_version(current_version=latest.group(1), bump_kind='patch')
        history = content[content.index(latest.group(0)):content.index('[Unreleased]:')]
        actual = release.prepare_changelog(content=content, next_version=target, release_date=date.fromisoformat(latest.group(2)), allow_empty=True)
        self.assertIn(history, actual)
        self.assertEqual(len([line for line in actual.splitlines() if release.RELEASE_HEADING_PATTERN.fullmatch(line)]), len(versions) + 1)


class AtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='naidan-release-write-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'CHANGELOG.md'
        self.path.write_bytes(b'original\r\n')

    def test_atomic_write_preserves_permissions_and_exact_newlines(self) -> None:
        self.path.chmod(0o640)
        release.write_text_file(path=self.path, content='updated\r\n')
        self.assertEqual(self.path.read_bytes(), b'updated\r\n')
        if os.name != 'nt':
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o640)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_failed_replace_preserves_destination_and_cleans_staging_file(self) -> None:
        with mock.patch.object(release.os, 'replace', side_effect=OSError('simulated replacement failure')):
            with self.assertRaisesRegex(OSError, 'simulated'):
                release.write_text_file(path=self.path, content='updated\n')
        self.assertEqual(self.path.read_bytes(), b'original\r\n')
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_failed_flush_preserves_destination_and_cleans_staging_file(self) -> None:
        with mock.patch.object(release.os, 'fsync', side_effect=OSError('simulated disk failure')):
            with self.assertRaisesRegex(OSError, 'simulated'):
                release.write_text_file(path=self.path, content='updated\n')
        self.assertEqual(self.path.read_bytes(), b'original\r\n')
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])


class ReleaseIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='naidan-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        self.env.update({
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_AUTHOR_NAME': 'Release Test',
            'GIT_AUTHOR_EMAIL': 'release-test@example.invalid',
            'GIT_COMMITTER_NAME': 'Release Test',
            'GIT_COMMITTER_EMAIL': 'release-test@example.invalid',
            'GIT_TERMINAL_PROMPT': '0',
            'PYTHONDONTWRITEBYTECODE': '1',
        })
        (self.root / 'scripts').mkdir()
        shutil.copyfile(SCRIPT, self.root / 'scripts/release_start.py')
        self.write_json(name='package.json', value={'name': 'naidan', 'version': '0.62.1-dev'})
        self.write_json(name='package-lock.json', value={'name': 'naidan', 'version': '0.62.1-dev', 'lockfileVersion': 3, 'packages': {'': {'name': 'naidan', 'version': '0.62.1-dev'}, 'node_modules/example': {'version': '9.8.7'}}})
        (self.root / 'CHANGELOG.md').write_text(CHANGELOG, encoding='utf-8')
        self.git(args=['init', '-b', 'develop'])
        self.git(args=['config', 'commit.gpgsign', 'false'])
        self.git(args=['config', 'core.autocrlf', 'false'])
        self.git(args=['config', 'core.hooksPath', str(self.root / '.git/hooks')])
        self.commit_fixture()

    def git(self, *, args: list[str]) -> str:
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env, text=True, stderr=subprocess.STDOUT)

    def invoke(self, *, args: list[str]) -> subprocess.CompletedProcess[str]:
        # Also prove invocation does not depend on the shell's working directory.
        return subprocess.run([sys.executable, str(self.root / 'scripts/release_start.py'), *args], cwd=self.root / 'scripts', env=self.env, capture_output=True, text=True, check=False)

    def invoke_at_time(self, *, args: list[str], instant: str, local_timezone: str) -> subprocess.CompletedProcess[str]:
        # Freeze time only in the test subprocess. No production clock override
        # or environment flag is added to the release script.
        wrapper = '''
from datetime import date, datetime
import importlib.util
import sys
import time

if hasattr(time, 'tzset'):
    time.tzset()
script, instant, *arguments = sys.argv[1:]
fixed = datetime.fromisoformat(instant)
assert fixed.tzinfo is not None

class FrozenDate(date):
    @classmethod
    def today(cls):
        if arguments[0] == 'dev' or '--date' in arguments:
            raise AssertionError('An explicit date or dev bump must not read the release clock.')
        return fixed.astimezone().date()

class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        if arguments[0] == 'dev' or '--date' in arguments:
            raise AssertionError('An explicit date or dev bump must not read the release clock.')
        return fixed.astimezone(tz)

spec = importlib.util.spec_from_file_location('release_start', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.date = FrozenDate
module.datetime = FrozenDatetime
sys.argv = [script, *arguments]
sys.exit(module.main())
'''
        return subprocess.run([sys.executable, '-c', wrapper, str(self.root / 'scripts/release_start.py'), instant, *args], cwd=self.root / 'scripts', env={**self.env, 'TZ': local_timezone}, capture_output=True, text=True, check=False)

    def write_json(self, *, name: str, value: object) -> None:
        (self.root / name).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')

    def commit_fixture(self) -> None:
        self.git(args=['add', '--all'])
        self.git(args=['commit', '--allow-empty', '-m', 'test: prepare fixture'])

    def snapshot(self) -> tuple[dict[str, bytes], str, str, str, str]:
        files = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob('*') if path.is_file() and '.git' not in path.relative_to(self.root).parts}
        return (files, self.git(args=['rev-parse', 'HEAD']), self.git(args=['branch', '--show-current']), self.git(args=['for-each-ref', '--format=%(refname):%(objectname)']), self.git(args=['diff', '--cached', '--binary']))

    def assert_unchanged_failure(self, *, args: list[str], message: str) -> None:
        before = self.snapshot()
        result = self.invoke(args=args)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_patch_release_commits_exactly_three_files(self) -> None:
        result = self.invoke(args=['patch', '--date', '2026-11-04'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git(args=['branch', '--show-current']).strip(), 'release/0.62.1')
        self.assertEqual(self.git(args=['log', '-1', '--format=%s']).strip(), 'bump: 0.62.1')
        self.assertEqual(set(self.git(args=['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).splitlines()), {'CHANGELOG.md', 'package.json', 'package-lock.json'})
        self.assertEqual(self.git(args=['status', '--porcelain']), '')
        self.assertEqual(self.git(args=['tag', '--list']), '')
        changelog = (self.root / 'CHANGELOG.md').read_text(encoding='utf-8')
        self.assertIn('## [Unreleased]\n\n## [0.62.1] - 2026-11-04', changelog)
        self.assertIn(HISTORY, changelog)
        package = json.loads((self.root / 'package.json').read_text())
        lock = json.loads((self.root / 'package-lock.json').read_text())
        self.assertEqual(package['version'], '0.62.1')
        self.assertEqual(lock['version'], '0.62.1')
        self.assertEqual(lock['packages']['']['version'], '0.62.1')
        self.assertEqual(lock['packages']['node_modules/example']['version'], '9.8.7')

    @unittest.skipUnless(hasattr(time, 'tzset'), 'Testing local time zones requires time.tzset().')
    def test_default_date_is_utc_across_calendar_boundaries_and_timezones(self) -> None:
        before = self.snapshot()
        for instant, expected in (
            ('2026-11-04T00:00:00+00:00', '2026-11-04'),
            ('2026-11-04T23:59:59+00:00', '2026-11-04'),
            ('2026-12-31T23:59:59+00:00', '2026-12-31'),
            ('2027-01-01T00:00:00+00:00', '2027-01-01'),
            ('2028-02-29T23:59:59+00:00', '2028-02-29'),
            ('2028-03-01T00:00:00+00:00', '2028-03-01'),
        ):
            for zone in ('UTC0', 'JST-9', 'EST5', 'LINT-14', 'IDLW12'):
                with self.subTest(instant=instant, zone=zone):
                    result = self.invoke_at_time(args=['patch', '--dry-run'], instant=instant, local_timezone=zone)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn(f'Changelog release: 0.62.1 - {expected} (UTC)', result.stdout)
        self.assertEqual(self.snapshot(), before)

    def test_default_date_written_to_changelog_is_utc(self) -> None:
        result = self.invoke_at_time(args=['patch'], instant='2026-11-04T23:30:00+00:00', local_timezone='JST-9')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        actual = (self.root / 'CHANGELOG.md').read_text()
        self.assertIn('## [0.62.1] - 2026-11-04', actual)
        self.assertIn('[0.62.1]: https://github.com/nwtgck/naidan/compare/v0.62.0...v0.62.1', actual)
        self.assertEqual(self.git(args=['status', '--porcelain']), '')

    def test_explicit_utc_date_is_not_shifted_or_replaced_by_clock(self) -> None:
        before = self.snapshot()
        for zone in ('UTC0', 'JST-9', 'EST5'):
            with self.subTest(zone=zone):
                result = self.invoke_at_time(args=['patch', '--date', '2026-11-10', '--dry-run'], instant='2026-11-04T23:30:00+00:00', local_timezone=zone)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Changelog release: 0.62.1 - 2026-11-10 (UTC)', result.stdout)
        self.assertEqual(self.snapshot(), before)
        result = self.invoke_at_time(args=['patch', '--date', '2026-11-10'], instant='2026-11-04T23:30:00+00:00', local_timezone='JST-9')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('## [0.62.1] - 2026-11-10', (self.root / 'CHANGELOG.md').read_text())

    def test_dev_does_not_read_changelog_or_release_clock(self) -> None:
        (self.root / 'CHANGELOG.md').unlink()
        self.commit_fixture()
        result = self.invoke_at_time(args=['dev'], instant='2026-11-04T23:30:00+00:00', local_timezone='JST-9')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / 'CHANGELOG.md').exists())
        self.assertEqual(self.git(args=['branch', '--show-current']).strip(), 'develop')
        self.assertEqual(set(self.git(args=['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).splitlines()), {'package.json', 'package-lock.json'})

    def test_help_documents_utc_date(self) -> None:
        result = self.invoke(args=['--help'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('UTC calendar date in YYYY-MM-DD (default: today in UTC)', ' '.join(result.stdout.split()))

    def test_minor_release(self) -> None:
        result = self.invoke(args=['minor', '--date', '2026-11-04'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('## [0.63.0] - 2026-11-04', (self.root / 'CHANGELOG.md').read_text())
        self.assertEqual(self.git(args=['branch', '--show-current']).strip(), 'release/0.63.0')

    def test_major_release(self) -> None:
        result = self.invoke(args=['major', '--date', '2026-11-04'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('## [1.0.0] - 2026-11-04', (self.root / 'CHANGELOG.md').read_text())

    def test_dev_leaves_even_unparseable_changelog_untouched(self) -> None:
        content = b'# Changelog\r\n\r\nUnfinished notes\r\n'
        (self.root / 'CHANGELOG.md').write_bytes(content)
        self.commit_fixture()
        result = self.invoke(args=['dev'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git(args=['branch', '--show-current']).strip(), 'develop')
        self.assertEqual((self.root / 'CHANGELOG.md').read_bytes(), content)
        self.assertEqual(json.loads((self.root / 'package.json').read_text())['version'], '0.62.2-dev')
        self.assertEqual(set(self.git(args=['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).splitlines()), {'package.json', 'package-lock.json'})

    def test_dev_rejects_release_only_options(self) -> None:
        for args in (['dev', '--date', '2026-11-04'], ['dev', '--allow-empty-changelog']):
            with self.subTest(args=args):
                self.assert_unchanged_failure(args=args, message='only valid')

    def test_dry_run_validates_without_mutating_dirty_worktree(self) -> None:
        (self.root / 'CHANGELOG.md').write_text(CHANGELOG.replace('A reviewed feature', 'A revised feature'))
        (self.root / 'untracked.txt').write_text('not part of the release')
        before = self.snapshot()
        result = self.invoke(args=['minor', '--date', '2026-11-04', '--dry-run'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('- CHANGELOG.md', result.stdout)
        self.assertEqual(self.snapshot(), before)

    def test_rejects_dirty_and_staged_worktrees(self) -> None:
        (self.root / 'extra.txt').write_text('untracked')
        self.assert_unchanged_failure(args=['patch'], message='clean')
        self.git(args=['add', 'extra.txt'])
        self.assert_unchanged_failure(args=['patch'], message='clean')

    def test_rejects_wrong_and_detached_branches(self) -> None:
        self.git(args=['checkout', '-b', 'feature/work'])
        self.assert_unchanged_failure(args=['patch'], message='develop')
        self.git(args=['checkout', '--detach'])
        self.assert_unchanged_failure(args=['patch'], message='develop')

    def test_rejects_existing_branch_and_tag(self) -> None:
        self.git(args=['branch', 'release/0.62.1'])
        self.assert_unchanged_failure(args=['patch'], message='Branch already exists')
        self.git(args=['branch', '-D', 'release/0.62.1'])
        self.git(args=['tag', 'v0.62.1'])
        self.assert_unchanged_failure(args=['patch'], message='Tag already exists')

    def test_empty_release_requires_opt_in(self) -> None:
        (self.root / 'CHANGELOG.md').write_text(PREAMBLE + '\n' + HISTORY + '\n' + LINKS)
        self.commit_fixture()
        self.assert_unchanged_failure(args=['patch', '--dry-run'], message='no release notes')
        self.assert_unchanged_failure(args=['patch'], message='no release notes')
        result = self.invoke(args=['patch', '--allow-empty-changelog', '--date', '2026-11-04'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('## [0.62.1] - 2026-11-04\n\n## [0.62.0]', (self.root / 'CHANGELOG.md').read_text())

    def test_missing_changelog_fails_before_branch_or_files_change(self) -> None:
        (self.root / 'CHANGELOG.md').unlink()
        self.commit_fixture()
        self.assert_unchanged_failure(args=['patch', '--allow-empty-changelog'], message='Cannot read required file')

    def test_invalid_lockfile_fails_preflight_including_dry_run(self) -> None:
        for lock in ({}, {'packages': []}, {'packages': {}}, {'packages': {'': []}}, []):
            with self.subTest(lock=lock):
                self.write_json(name='package-lock.json', value=lock)
                self.commit_fixture()
                self.assert_unchanged_failure(args=['patch'], message='package-lock.json')
                self.assert_unchanged_failure(args=['patch', '--dry-run'], message='package-lock.json')

    def test_invalid_package_json_and_version_fail_preflight(self) -> None:
        for package in ({}, {'version': 12}, {'version': '01.2.3'}, ['not an object']):
            with self.subTest(package=package):
                self.write_json(name='package.json', value=package)
                self.commit_fixture()
                self.assert_unchanged_failure(args=['patch'], message='version' if isinstance(package, dict) else 'JSON object')
        (self.root / 'package.json').write_text('{not JSON}')
        self.commit_fixture()
        self.assert_unchanged_failure(args=['patch'], message='Invalid JSON')

    def test_malformed_changelog_fails_before_creating_branch(self) -> None:
        (self.root / 'CHANGELOG.md').write_text(CHANGELOG + '\n## [Unreleased]\n')
        self.commit_fixture()
        self.assert_unchanged_failure(args=['patch'], message='heading')

    def test_invalid_date_fails_without_changes(self) -> None:
        self.assert_unchanged_failure(args=['patch', '--date', '2026-02-29'], message='YYYY-MM-DD')

    @unittest.skipIf(os.name == 'nt', 'Symlink creation may require extra privileges on Windows.')
    def test_symlink_release_files_fail_before_branch_or_target_changes(self) -> None:
        for name in ('CHANGELOG.md', 'package.json', 'package-lock.json'):
            with self.subTest(name=name):
                path = self.root / name
                target = self.root / ('original-' + name)
                path.rename(target)
                path.symlink_to(target.name)
                self.commit_fixture()
                self.assert_unchanged_failure(args=['patch'], message='regular file')
                path.unlink()
                target.rename(path)
                self.commit_fixture()

    def test_untracked_files_cannot_be_hidden_by_user_status_configuration(self) -> None:
        self.git(args=['config', 'status.showUntrackedFiles', 'no'])
        (self.root / 'untracked.txt').write_text('preserve')
        self.assert_unchanged_failure(args=['patch'], message='clean')

    def test_failed_commit_preserves_inspectable_work_and_reports_failure(self) -> None:
        # Do not depend on executing hooks from /tmp: hardened CI containers
        # may mount it noexec and Git silently skips non-executable hooks.
        # Force a failure at `git commit` using a deliberately missing signer.
        self.git(args=['config', 'commit.gpgsign', 'true'])
        self.git(args=['config', 'gpg.program', str(self.root / 'missing-test-gpg')])
        before_head = self.git(args=['rev-parse', 'HEAD'])
        result = self.invoke(args=['patch', '--date', '2026-11-04'])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Release preparation failed', result.stderr)
        self.assertNotIn('Release branch ready:', result.stdout)
        self.assertEqual(self.git(args=['rev-parse', 'HEAD']), before_head)
        self.assertEqual(self.git(args=['branch', '--show-current']).strip(), 'release/0.62.1')
        self.assertEqual(set(self.git(args=['diff', '--cached', '--name-only']).splitlines()), {'CHANGELOG.md', 'package.json', 'package-lock.json'})


if __name__ == '__main__':
    unittest.main()
