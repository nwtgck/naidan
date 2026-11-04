from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import plan_release_notes as planner

ROOT = Path(__file__).resolve().parents[2]
PREAMBLE = '# Changelog\n\n## [Unreleased]\n\n- Future work.\n\n'
HISTORY = '''## [0.2.0] - 2026-11-04

### Added

- New **feature** with Unicode: 日本語.\x20\x20
  Continuation.

## [0.1.0] - 2026-11-01

### Fixed

- Old fix.
'''
LINKS = '''
[Unreleased]: https://example.test/compare/v0.2.0...develop
[0.2.0]: https://example.test/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.test/tag/v0.1.0
'''
CHANGELOG = PREAMBLE + HISTORY + LINKS


def release(*, release_id: int = 1, tag: str = 'v0.2.0', body: str | None = 'old', **extra) -> dict:
    return {'id': release_id, 'tag_name': tag, 'body': body, 'draft': False, 'prerelease': False, **extra}


class RenderNotesTests(unittest.TestCase):
    def test_preserves_prose_and_hard_breaks_with_only_own_comparison_link(self):
        notes = planner.render_notes(content=CHANGELOG)
        self.assertEqual(list(notes), ['v0.2.0', 'v0.1.0'])
        self.assertIn('日本語.  \n  Continuation.', notes['v0.2.0'])
        self.assertIn('[Full Changelog][0.2.0]', notes['v0.2.0'])
        self.assertNotIn('[0.1.0]:', notes['v0.2.0'])
        self.assertNotIn('Future work', ''.join(notes.values()))
        self.assertNotIn('Unreleased', ''.join(notes.values()))
        self.assertNotIn('## [0.2.0]', notes['v0.2.0'])

    def test_line_endings_and_outer_blank_lines_do_not_change_body(self):
        notes = planner.render_notes(content=CHANGELOG)
        self.assertEqual(notes, planner.render_notes(content=CHANGELOG.replace('\n', '\r\n')))
        self.assertEqual(notes, planner.render_notes(content=CHANGELOG.rstrip('\n')))
        self.assertEqual(notes, planner.render_notes(content=CHANGELOG.replace('### Added', '\n\n### Added')))

    def test_no_reference_definitions_and_intentionally_empty_release(self):
        notes = planner.render_notes(content=PREAMBLE + '## [0.1.0] - 2026-11-01\n\n')
        self.assertEqual(notes, {'v0.1.0': ''})
        self.assertEqual(planner.render_notes(content=PREAMBLE), {})

    def test_only_referenced_definitions_are_copied(self):
        content = CHANGELOG.replace('- Old fix.', '- See [Guide][doc], [shortcut], [collapsed][], and ![picture][pic].')
        content += '''[doc]: <https://example.test/doc> "User guide"
[shortcut]: https://example.test/short
[collapsed]: https://example.test/collapsed
[pic]: https://example.test/image.png
[unused]: https://example.test/unused
'''
        old = planner.render_notes(content=content)['v0.1.0']
        for label in ['doc', 'shortcut', 'collapsed', 'pic']:
            self.assertIn(f'[{label}]:', old)
        self.assertNotIn('[unused]:', old)
        self.assertIn('<https://example.test/doc> "User guide"', old)

    def test_reference_labels_are_case_and_whitespace_insensitive(self):
        content = CHANGELOG.replace('- Old fix.', '- [Read][USER   GUIDE].')
        content += '[User Guide]: https://example.test/guide\n'
        self.assertIn('[User Guide]:', planner.render_notes(content=content)['v0.1.0'])

    def test_unreleased_changes_do_not_update_historical_bodies(self):
        notes = planner.render_notes(content=CHANGELOG)
        edited = CHANGELOG.replace('Future work.', 'Entirely different future work.').replace('...develop', '...future')
        self.assertEqual(notes, planner.render_notes(content=edited))

    def test_referenced_url_change_updates_only_dependent_section(self):
        edited = CHANGELOG.replace('/tag/v0.1.0', '/tag/new')
        before, after = planner.render_notes(content=CHANGELOG), planner.render_notes(content=edited)
        self.assertEqual(before['v0.2.0'], after['v0.2.0'])
        self.assertNotEqual(before['v0.1.0'], after['v0.1.0'])

    def test_comments_and_code_are_not_structural_or_reference_uses(self):
        literal = '''
<!--
## [9.0.0] - 2099-01-01
[unused]
-->
````md
## [8.0.0] - 2099-01-01
```
[unused]
````
~~~text
## [7.0.0] - 2099-01-01
~~~
    ## [6.0.0] - 2099-01-01
    [unused]
- An inline literal `[unused]`.
'''
        content = CHANGELOG.replace('- Old fix.', '- Old fix.\n' + literal) + '[unused]: https://example.test/unused\n'
        notes = planner.render_notes(content=content)
        self.assertEqual(len(notes), 2)
        self.assertIn(literal.strip(), notes['v0.1.0'])
        self.assertNotIn('[unused]:', notes['v0.1.0'])

    def test_malformed_structure_fails_closed(self):
        bad = [
            CHANGELOG.replace('## [Unreleased]', '## Unreleased'),
            CHANGELOG.replace('## [0.2.0]', '## [Unreleased]'),
            CHANGELOG.replace('## [0.1.0]', '## [0.2.0]'),
            CHANGELOG.replace('## [0.1.0]', '## [0.3.0]'),
            CHANGELOG.replace('2026-11-04', '2026-02-30'),
            CHANGELOG.replace('## [0.1.0]', '## [v0.1.0]'),
            CHANGELOG.replace('## [0.1.0]', '## [0.1.0-beta]'),
            CHANGELOG + '\n<!-- unclosed', CHANGELOG + '\n```\nunclosed',
            CHANGELOG + '[0.1.0]: https://duplicate.test\n',
            CHANGELOG.replace('[0.2.0]: https:', '[0.2.0]:\n https:'),
            CHANGELOG + '\nNot a reference.\n',
            CHANGELOG + '\n```\ncode after footer\n```\n',
            CHANGELOG.replace('## [0.1.0]', '[doc]: https://early.test\n\n## [0.1.0]'),
        ]
        for content in bad:
            with self.subTest(content=content[-100:]), self.assertRaises(ValueError):
                planner.render_notes(content=content)

    def test_oversized_utf8_body_is_rejected_not_truncated(self):
        with self.assertRaisesRegex(ValueError, 'size limit'):
            planner.render_notes(content=PREAMBLE + '## [0.1.0] - 2026-11-01\n\n' + 'あ' * 42_000)

    def test_current_repository_changelog_all_versions(self):
        content = (ROOT / 'CHANGELOG.md').read_text()
        notes = planner.render_notes(content=content)
        expected = sum(planner.RELEASE_HEADING_PATTERN.fullmatch(line) is not None for line in content.splitlines())
        self.assertEqual(len(notes), expected)
        self.assertGreater(len(notes), 60)
        for tag, body in notes.items():
            self.assertNotIn('[Unreleased]:', body, tag)
            self.assertIn(f'[Full Changelog][{tag[1:]}]', body)


class PlanTests(unittest.TestCase):
    def plan(self, releases, **kwargs):
        return planner.build_plan(changelog=CHANGELOG, releases=releases, **kwargs)

    def test_all_changed_historical_releases_sorted_by_id(self):
        plan = self.plan([release(release_id=10), release(release_id=2, tag='v0.1.0')])
        self.assertEqual([item['id'] for item in plan['updates']], [2, 10])
        self.assertIsNone(plan['create'])

    def test_exact_body_comparison_and_idempotency(self):
        releases = [release(), release(release_id=2, tag='v0.1.0')]
        first = self.plan(releases)
        for update in first['updates']:
            next(item for item in releases if item['id'] == update['id'])['body'] = update['body']
        self.assertEqual(self.plan(releases)['updates'], [])
        releases[1]['body'] = 'manually edited remotely'
        self.assertEqual([entry['id'] for entry in self.plan(releases)['updates']], [2])

    def test_drafts_prereleases_and_unknown_tags_are_never_changed(self):
        plan = self.plan([release(draft=True), release(release_id=2, tag='v0.1.0', prerelease=True),
                          release(release_id=3, tag='nightly')])
        self.assertEqual(plan['updates'], [])
        self.assertEqual(len(plan['skipped']), 3)
        self.assertIsNone(self.plan([])['create'])

    def test_new_publication_prefers_canonical_notes_over_tag_snapshot(self):
        old = CHANGELOG.replace('New **feature**', 'Stale tagged description')
        plan = self.plan([], publish_tag='v0.2.0', tag_changelog=old)
        self.assertIn('New **feature**', plan['create']['body'])
        self.assertEqual(plan['create']['tag_name'], 'v0.2.0')

    def test_tag_fallback_is_limited_to_requested_missing_version(self):
        tag_content = PREAMBLE + '## [0.3.0] - 2026-11-05\n\n- Just released.\n\n' + HISTORY.replace('Old fix.', 'Stale history.') + LINKS
        plan = self.plan([release(release_id=2, tag='v0.1.0')], publish_tag='v0.3.0', tag_changelog=tag_content)
        self.assertIn('Just released.', plan['create']['body'])
        self.assertIn('Old fix.', plan['updates'][0]['body'])
        self.assertNotIn('Stale history.', plan['updates'][0]['body'])

    def test_missing_canonical_section_never_rolls_back_existing_nonempty_notes(self):
        tag = PREAMBLE + '## [0.3.0] - 2026-11-05\n\n- Stale tag notes.\n'
        existing = release(tag='v0.3.0', body='Already reviewed notes')
        plan = self.plan([existing], publish_tag='v0.3.0', tag_changelog=tag)
        self.assertEqual(plan['updates'], [])
        self.assertEqual(len(plan['skipped']), 1)
        for body in ['', None]:
            with self.subTest(body=body):
                plan = self.plan([release(tag='v0.3.0', body=body)], publish_tag='v0.3.0', tag_changelog=tag)
                self.assertIn('Stale tag notes.', plan['updates'][0]['body'])

    def test_publishing_requires_tagged_notes_even_when_canonical_has_them(self):
        for kwargs in [
            {'publish_tag': 'v0.2.0'},
            {'publish_tag': 'v0.2.0', 'tag_changelog': PREAMBLE},
            {'publish_tag': 'v0.2.0-dev', 'tag_changelog': CHANGELOG},
            {'publish_tag': '../bad', 'tag_changelog': CHANGELOG},
        ]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.plan([], **kwargs)

    def test_publishing_never_undrafts_or_promotes_prereleases(self):
        for extra in [{'draft': True}, {'prerelease': True}]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.plan([release(**extra)], publish_tag='v0.2.0', tag_changelog=CHANGELOG)

    def test_no_duplicate_creation_on_rerun(self):
        created = self.plan([], publish_tag='v0.2.0', tag_changelog=CHANGELOG)['create']
        plan = self.plan([release(body=created['body'])], publish_tag='v0.2.0', tag_changelog=CHANGELOG)
        self.assertIsNone(plan['create'])
        self.assertEqual(plan['updates'], [])

    def test_partial_previous_sync_is_recovered_by_full_comparison(self):
        canonical = planner.render_notes(content=CHANGELOG)
        plan = self.plan([release(body=canonical['v0.2.0']), release(release_id=2, tag='v0.1.0')])
        self.assertEqual([entry['id'] for entry in plan['updates']], [2])

    def test_invalid_snapshots_rejected_before_any_plan(self):
        bad = [None, {}, [None], [release(), release()], [release(), release(release_id=2)],
               [release(body=42)], [release(draft=0)], [release(prerelease=None)]]
        for release_id in [0, -1, True, 1.5, 2**53, '1']:
            bad.append([release(release_id=release_id)])
        for snapshot in bad:
            with self.subTest(snapshot=snapshot), self.assertRaises(ValueError):
                self.plan(snapshot)

    def test_null_remote_body_equals_intentionally_empty_notes(self):
        plan = planner.build_plan(changelog=PREAMBLE + '## [0.2.0] - 2026-11-04\n', releases=[release(body=None)])
        self.assertEqual(plan['updates'], [])

    def test_cli_outputs_only_complete_json_and_never_changes_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            changelog = Path(directory) / 'CHANGELOG.md'
            releases = Path(directory) / 'releases.json'
            changelog.write_text(CHANGELOG)
            releases.write_text(json.dumps([release()]))
            command = [sys.executable, str(ROOT / 'scripts/plan_release_notes.py'),
                       '--changelog', str(changelog), '--releases', str(releases)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(json.loads(result.stdout)['updates']), 1)
            self.assertEqual(changelog.read_text(), CHANGELOG)
            releases.write_text('{broken')
            failed = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(failed.stdout, '')
            self.assertIn('planning failed', failed.stderr)


if __name__ == '__main__':
    unittest.main()
