#!/usr/bin/env python3
"""Offline CHANGELOG + GitHub release snapshot -> deterministic JSON update plan.

No credentials, network, Git commands, or subprocesses are used here. The workflow
owns fetching, authorization, validation of destinations, and all GitHub writes.
"""
from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import re
import sys

from release_start import RELEASE_HEADING_PATTERN, VERSION_CORE, markdown_lines, read_text_file

TAG_PATTERN = re.compile(rf'v{VERSION_CORE}')
REFERENCE_PATTERN = re.compile(
    r" {0,3}\[([^\]]+)\]:[ \t]+(?:<[^<>\s]+>|\S+?)"
    r"(?:[ \t]+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?[ \t]*"
)
# Conservative UTF-8 byte ceiling; never truncate user-written Markdown.
MAX_BODY_BYTES = 125_000


def reference_key(*, label: str) -> str:
    return ' '.join(label.split()).casefold()


def render_notes(*, content: str) -> dict[str, str]:
    """Render Naidan's documented Markdown subset, not arbitrary Markdown."""
    content = content.replace('\r\n', '\n')
    lines = content.splitlines(keepends=True)
    try:
        visible = markdown_lines(content=content)
    except SystemExit as exc:
        raise ValueError(str(exc)) from exc
    headings = [(i, text) for i, text in visible if re.match(r' {0,3}##(?:[ \t]|$)', text)]
    if not headings or headings[0][1].rstrip() != '## [Unreleased]':
        raise ValueError('CHANGELOG.md must begin its sections with ## [Unreleased].')
    versions: list[tuple[int, str]] = []
    previous = None
    for index, text in headings[1:]:
        match = RELEASE_HEADING_PATTERN.fullmatch(text.rstrip())
        if match is None:
            raise ValueError(f'Invalid changelog heading on line {index + 1}: {text}')
        version, released = match.groups()
        date.fromisoformat(released)
        numeric = tuple(int(part) for part in version.split('.'))
        if previous is not None and numeric >= previous:
            raise ValueError('Changelog releases must be unique and ordered newest first.')
        previous = numeric
        versions.append((index, version))

    references: dict[str, str] = {}
    footer = len(lines)
    for index, text in visible:
        if not re.match(r' {0,3}\[[^\]]+\]:', text):
            continue
        original = lines[index].rstrip('\n')
        match = REFERENCE_PATTERN.fullmatch(original)
        if match is None:
            raise ValueError('Changelog references must use single-line Markdown definitions.')
        key = reference_key(label=match.group(1))
        if key in references:
            raise ValueError(f'Duplicate changelog reference: {key}')
        if index <= headings[-1][0]:
            raise ValueError('Place reference definitions after all release sections.')
        references[key] = original
        footer = min(footer, index)
    # Avoid silently throwing away prose or fenced examples after the link block.
    visible_by_index = dict(visible)
    for index in range(footer, len(lines)):
        text = visible_by_index.get(index)
        if text is None or (text.strip() and REFERENCE_PATTERN.fullmatch(lines[index].rstrip('\n')) is None):
            raise ValueError('Only reference definitions and comments may follow the link footer.')

    notes = {}
    for position, (start, version) in enumerate(versions):
        end = versions[position + 1][0] if position + 1 < len(versions) else footer
        body_lines = lines[start + 1:end]
        # Trim separating blank lines only, retaining Markdown hard line breaks.
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        body = ''.join(body_lines).rstrip('\n')
        used = set()
        for _, text in markdown_lines(content=body):
            if text.startswith(('    ', '\t')):
                continue
            text = re.sub(r'(`+).*?\1', '', text)
            # Conservatively retain defined bracket labels, including full,
            # collapsed, shortcut, and image references; do not rewrite prose.
            for label in re.findall(r'(?<!\\)\[([^\[\]]+)\]', text):
                key = reference_key(label=label)
                if key in references:
                    used.add(key)
        if version in references:
            body += ('\n\n' if body else '') + f'[Full Changelog][{version}]'
            used.add(version)
        if used:
            body += '\n\n' + '\n'.join(references[key] for key in sorted(used))
        body += '\n' if body else ''
        if len(body.encode('utf-8')) > MAX_BODY_BYTES:
            raise ValueError(f'Release v{version} exceeds the release-note size limit.')
        notes[f'v{version}'] = body
    return notes


def validate_releases(*, releases: object) -> list[dict]:
    if not isinstance(releases, list):
        raise ValueError('Expected a release snapshot array.')
    ids, tags = set(), set()
    for release in releases:
        if not isinstance(release, dict):
            raise ValueError('Invalid release snapshot entry.')
        release_id, tag = release.get('id'), release.get('tag_name')
        if type(release_id) is not int or not 0 < release_id <= 2**53 - 1:
            raise ValueError('Invalid release ID.')
        if not isinstance(tag, str) or not tag or release_id in ids or tag in tags:
            raise ValueError('Invalid or duplicate release identity.')
        if type(release.get('draft')) is not bool or type(release.get('prerelease')) is not bool:
            raise ValueError('Missing release publication state.')
        if 'body' not in release or (release['body'] is not None and not isinstance(release['body'], str)):
            raise ValueError('Invalid release body.')
        ids.add(release_id)
        tags.add(tag)
    return releases


def build_plan(*, changelog: str, releases: object, publish_tag: str = '', tag_changelog: str | None = None) -> dict:
    notes = render_notes(content=changelog)
    releases = validate_releases(releases=releases)
    by_tag = {release['tag_name']: release for release in releases}
    creation = None
    if publish_tag:
        if TAG_PATTERN.fullmatch(publish_tag) is None or tag_changelog is None:
            raise ValueError('Publishing requires a vX.Y.Z tag and its CHANGELOG.md.')
        tag_notes = render_notes(content=tag_changelog)
        if publish_tag not in tag_notes:
            raise ValueError(f'{publish_tag} is missing from the tagged CHANGELOG.md.')
        existing = by_tag.get(publish_tag)
        if existing is not None and (existing['draft'] or existing['prerelease']):
            raise ValueError('Refusing to republish a draft or prerelease as a stable release.')
        # develop is authoritative. A tag supplies ONLY the requested version,
        # never historical sections; never roll back nonempty existing notes
        # when the canonical section has disappeared or has not been merged yet.
        if publish_tag not in notes and (existing is None or not existing['body']):
            notes[publish_tag] = tag_notes[publish_tag]
        if existing is None:
            creation = {'tag_name': publish_tag, 'body': notes[publish_tag]}

    updates, skipped = [], []
    for release in releases:
        tag = release['tag_name']
        if release['draft'] or release['prerelease'] or tag not in notes:
            skipped.append({'tag_name': tag, 'reason': 'draft/prerelease or absent from canonical changelog'})
            continue
        body = notes[tag]
        if (release['body'] or '') != body:
            updates.append({'id': release['id'], 'tag_name': tag, 'body': body})
    return {'updates': sorted(updates, key=lambda item: item['id']), 'create': creation,
            'skipped': sorted(skipped, key=lambda item: item['tag_name'])}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--changelog', type=Path, required=True)
    parser.add_argument('--releases', type=Path, required=True)
    parser.add_argument('--publish-tag', default='')
    parser.add_argument('--tag-changelog', type=Path)
    args = parser.parse_args()
    try:
        plan = build_plan(
            changelog=read_text_file(path=args.changelog),
            releases=json.loads(read_text_file(path=args.releases)),
            publish_tag=args.publish_tag,
            tag_changelog=read_text_file(path=args.tag_changelog) if args.tag_changelog else None,
        )
        # Emit only a complete, validated plan. The workflow owns the output file.
        print(json.dumps(plan, ensure_ascii=False, indent=2))
    except (ValueError, OSError, UnicodeError) as exc:
        parser.exit(1, f'Release-note planning failed: {exc}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
