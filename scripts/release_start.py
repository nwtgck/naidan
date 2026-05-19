#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
PACKAGE_JSON_PATH = REPO_ROOT / 'package.json'
PACKAGE_LOCK_JSON_PATH = REPO_ROOT / 'package-lock.json'
VERSION_PATTERN = re.compile(r'^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$')


def main() -> int:
    args = parse_args()

    ensure_git_branch(expected_branch='develop')

    package_json = read_json_file(path=PACKAGE_JSON_PATH)
    package_lock_json = read_json_file(path=PACKAGE_LOCK_JSON_PATH)

    current_version = read_current_version(package_json=package_json)
    next_version = bump_version(
        current_version=current_version,
        bump_kind=args.bump_kind,
    )
    release_branch_name = create_release_branch_name(
        bump_kind=args.bump_kind,
        next_version=next_version,
    )

    if release_branch_name is not None:
        ensure_branch_does_not_exist(branch_name=release_branch_name)

    print(f'Current version: {current_version}')
    print(f'Next version: {next_version}')
    if release_branch_name is not None:
        print(f'Creating branch: {release_branch_name}')
    else:
        print('No release branch will be created for dev bump.')

    if args.dry_run:
        print('Dry run only. No branch, file, or commit changes were made.')
        if release_branch_name is not None:
            print(f'Branch to create: {release_branch_name}')
        print('Files to update:')
        print('- package.json')
        print('- package-lock.json')
        print(f'Commit message: bump: {next_version}')
        return 0

    ensure_clean_worktree()

    if release_branch_name is not None:
        run_git_command(args=['checkout', '-b', release_branch_name])

    try:
        update_versions(
            package_json=package_json,
            package_lock_json=package_lock_json,
            next_version=next_version,
        )
        write_json_file(
            path=PACKAGE_JSON_PATH,
            content=package_json,
        )
        write_json_file(
            path=PACKAGE_LOCK_JSON_PATH,
            content=package_lock_json,
        )

        run_git_command(args=['add', 'package.json', 'package-lock.json'])
        run_git_command(args=['commit', '-m', f'bump: {next_version}'])
    except Exception:
        print('Release branch was created before the failure.', file=sys.stderr)
        print(f'Inspect branch: {release_branch_name}', file=sys.stderr)
        raise

    if release_branch_name is not None:
        print(f'Release branch ready: {release_branch_name}')
    else:
        print(f'Development version committed on develop: {next_version}')
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Start a release branch from develop without git-flow.',
    )
    parser.add_argument(
        'bump_kind',
        choices=['major', 'minor', 'patch', 'dev'],
        help='Release bump kind or the next development bump.',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print the planned release actions without changing files or git state.',
    )
    return parser.parse_args()


def ensure_git_branch(*, expected_branch: str) -> None:
    current_branch = run_git_command(
        args=['branch', '--show-current'],
        capture_output=True,
    ).strip()

    if current_branch != expected_branch:
        raise SystemExit(
            f'Expected current branch to be "{expected_branch}", but found "{current_branch}".'
        )


def ensure_clean_worktree() -> None:
    status_output = run_git_command(
        args=['status', '--short'],
        capture_output=True,
    ).strip()

    if status_output != '':
        raise SystemExit('Working tree must be clean before starting a release.')


def ensure_branch_does_not_exist(*, branch_name: str) -> None:
    branch_output = run_git_command(
        args=['branch', '--list', branch_name],
        capture_output=True,
    ).strip()

    if branch_output != '':
        raise SystemExit(f'Branch already exists: {branch_name}')


def read_json_file(*, path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError as exc:
        raise SystemExit(f'Missing required file: {path}') from exc


def write_json_file(*, path: Path, content: dict[str, Any]) -> None:
    serialized = json.dumps(content, ensure_ascii=True, indent=2)
    path.write_text(f'{serialized}\n', encoding='utf-8')


def read_current_version(*, package_json: dict[str, Any]) -> str:
    raw_version = package_json.get('version')
    if not isinstance(raw_version, str):
        raise SystemExit('package.json version must be a string.')

    if VERSION_PATTERN.fullmatch(raw_version) is None:
        raise SystemExit(f'Unsupported version format: {raw_version}')

    return raw_version


def bump_version(*, current_version: str, bump_kind: str) -> str:
    match = VERSION_PATTERN.fullmatch(current_version)
    if match is None:
        raise SystemExit(f'Unsupported version format: {current_version}')

    has_dev_suffix = current_version.endswith('-dev')
    major = int(match.group('major'))
    minor = int(match.group('minor'))
    patch = int(match.group('patch'))

    if bump_kind == 'dev':
        return f'{major}.{minor}.{patch + 1}-dev'
    if bump_kind == 'major':
        return f'{major + 1}.0.0'
    if bump_kind == 'minor':
        return f'{major}.{minor + 1}.0'
    if has_dev_suffix:
        return f'{major}.{minor}.{patch}'
    return f'{major}.{minor}.{patch + 1}'


def create_release_branch_name(*, bump_kind: str, next_version: str) -> str | None:
    if bump_kind == 'dev':
        return None
    return f'release/{next_version}'


def update_versions(*, package_json: dict[str, Any], package_lock_json: dict[str, Any], next_version: str) -> None:
    package_json['version'] = next_version
    package_lock_json['version'] = next_version

    packages_section = package_lock_json.get('packages')
    if not isinstance(packages_section, dict):
        raise SystemExit('package-lock.json must contain a packages object.')

    root_package = packages_section.get('')
    if not isinstance(root_package, dict):
        raise SystemExit('package-lock.json must contain packages[""].')

    root_package['version'] = next_version


def run_git_command(*, args: list[str], capture_output: bool = False) -> str:
    completed = subprocess.run(
        ['git', *args],
        cwd=REPO_ROOT,
        check=False,
        capture_output=capture_output,
        text=True,
    )

    if completed.returncode != 0:
        stderr = completed.stderr.strip() if completed.stderr is not None else ''
        raise SystemExit(stderr or f'Git command failed: git {" ".join(args)}')

    if capture_output:
        return completed.stdout
    return ''


if __name__ == '__main__':
    sys.exit(main())
