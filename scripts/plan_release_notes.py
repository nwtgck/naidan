#!/usr/bin/env python3
"""Offline CHANGELOG + GitHub release snapshot -> deterministic JSON update plan.

No credentials, network, Git commands, or subprocesses are used here. The workflow
owns fetching, authorization, validation of destinations, and all GitHub writes.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

# Re-export the existing format helpers for callers of this planner module.
from changelog_format import (
    MAX_BODY_BYTES, REFERENCE_PATTERN, RELEASE_HEADING_PATTERN, VERSION_CORE,
    markdown_lines, reference_key, render_notes,
)
from release_start import read_text_file

TAG_PATTERN = re.compile(rf'v{VERSION_CORE}')
ATTESTATION_REFERENCE = re.compile(r'\[(attestation(?:-[1-9][0-9]*)?)\]: (\S+)')


def split_reference_footer(*, body: str) -> tuple[str, list[str]]:
    text = body.replace('\r\n', '\n').rstrip('\n')
    prose, separator, footer = text.rpartition('\n\n')
    references = footer.split('\n')
    if separator and all(REFERENCE_PATTERN.fullmatch(line) for line in references):
        return prose, references
    return text, []


def without_attestation(*, body: str, tag: str, url_pattern: re.Pattern[str]) -> tuple[str, str | None]:
    prose, references = split_reference_footer(body=body)
    match = ATTESTATION_REFERENCE.fullmatch(references[-1]) if references else None
    if match is None or not url_pattern.fullmatch(match[2]):
        return body, None
    link = f'[Build Attestation][{match[1]}]'
    last_line = prose.rsplit('\n', 1)[-1]
    if last_line == f'[Full Changelog][{tag[1:]}] · {link}':
        prose = prose.removesuffix(f' · {link}')
    elif last_line == link:
        prose = prose.removesuffix(link).rstrip('\n')
    else:
        return body, None
    original = '\n\n'.join(filter(None, (prose, '\n'.join(references[:-1]))))
    return original + ('\n' if original else ''), match[2]


def with_attestation(*, body: str, tag: str, url: str) -> str:
    prose, references = split_reference_footer(body=body)
    labels = {reference_key(label=label) for label in re.findall(r'\[([^\[\]]+)\]', body)}
    label = 'attestation'
    suffix = 1
    while label in labels:
        label = f'attestation-{suffix}'
        suffix += 1
    link = f'[Build Attestation][{label}]'
    if prose.rsplit('\n', 1)[-1] == f'[Full Changelog][{tag[1:]}]':
        prose += f' · {link}'
    else:
        prose = '\n\n'.join(filter(None, (prose, link)))
    references.append(f'[{label}]: {url}')
    body = prose + '\n\n' + '\n'.join(references) + '\n'
    if len(body.encode('utf-8')) > MAX_BODY_BYTES:
        raise ValueError(f'Release {tag} exceeds the release-note size limit.')
    return body


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


def build_plan(*, changelog: str, releases: object, publish_tag: str = '', tag_changelog: str | None = None,
               repository: str = 'nwtgck/naidan', attestation_url: str | None = None) -> dict:
    notes = render_notes(content=changelog)
    releases = validate_releases(releases=releases)
    by_tag = {release['tag_name']: release for release in releases}
    url_pattern = re.compile(rf'https://github\.com/{re.escape(repository)}/attestations/[1-9][0-9]*')
    if attestation_url is not None and (not publish_tag or not url_pattern.fullmatch(attestation_url)):
        raise ValueError('Expected an attestation URL for the release repository and publication tag.')
    creation, publication = None, None
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
        if attestation_url is not None:
            previous = (existing['body'] or '') if existing is not None else ''
            previous_body, previous_url = without_attestation(body=previous, tag=publish_tag, url_pattern=url_pattern)
            body = notes.get(publish_tag, previous_body)
            publication = {
                'body': with_attestation(body=body, tag=publish_tag, url=attestation_url),
                'reset_body': body if previous_url is not None and previous_url != attestation_url else None,
            }

    updates, skipped = [], []
    for release in releases:
        tag = release['tag_name']
        if release['draft'] or release['prerelease'] or tag not in notes:
            skipped.append({'tag_name': tag, 'reason': 'draft/prerelease or absent from canonical changelog'})
            continue
        body = notes[tag]
        _, existing_url = without_attestation(body=release['body'] or '', tag=tag, url_pattern=url_pattern)
        if existing_url is not None:
            body = with_attestation(body=body, tag=tag, url=existing_url)
        if (release['body'] or '') != body:
            updates.append({'id': release['id'], 'tag_name': tag, 'body': body})
    return {'updates': sorted(updates, key=lambda item: item['id']), 'create': creation,
            'publication': publication,
            'skipped': sorted(skipped, key=lambda item: item['tag_name'])}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--changelog', type=Path, required=True)
    parser.add_argument('--releases', type=Path, required=True)
    parser.add_argument('--publish-tag', default='')
    parser.add_argument('--tag-changelog', type=Path)
    parser.add_argument('--repository', default='nwtgck/naidan')
    parser.add_argument('--attestation-url')
    args = parser.parse_args()
    try:
        plan = build_plan(
            changelog=read_text_file(path=args.changelog),
            releases=json.loads(read_text_file(path=args.releases)),
            publish_tag=args.publish_tag,
            tag_changelog=read_text_file(path=args.tag_changelog) if args.tag_changelog else None,
            repository=args.repository,
            attestation_url=args.attestation_url,
        )
        # Emit only a complete, validated plan. The workflow owns the output file.
        print(json.dumps(plan, ensure_ascii=False, indent=2))
    except (ValueError, OSError, UnicodeError) as exc:
        parser.exit(1, f'Release-note planning failed: {exc}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
