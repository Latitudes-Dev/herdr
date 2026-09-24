#!/usr/bin/env python3
"""Release tooling for the shuv1337/herdr fork.

Fork releases are tagged `v<cargo-version>-shuv.<N>` and publish their update
manifest (`latest.json`) as a GitHub release asset instead of committing it to
`distribution/latest.json`, so upstream syncs never conflict with fork releases.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
FORK_LABEL = "shuv"
DEFAULT_REPO = "shuv1337/herdr"
UPSTREAM_REPO = "herdrdev/herdr"
TAG_RE = re.compile(rf"^v(?P<base>\d+\.\d+\.\d+)-{FORK_LABEL}\.(?P<revision>[1-9]\d*)$")
VERSION_RE = re.compile(rf"^v?(\d+)\.(\d+)\.(\d+)(?:-{FORK_LABEL}\.([1-9]\d*))?$")
ASSET_NAMES = {
    "linux-x86_64": "herdr-linux-x86_64",
    "linux-aarch64": "herdr-linux-aarch64",
    "macos-x86_64": "herdr-macos-x86_64",
    "macos-aarch64": "herdr-macos-aarch64",
    "windows-x86_64": "herdr-windows-x86_64.zip",
}


class ForkReleaseError(ValueError):
    pass


def parse_tag(tag: str) -> tuple[str, int]:
    match = TAG_RE.fullmatch(tag.strip())
    if match is None:
        raise ForkReleaseError(
            f"fork release tags must look like v0.9.1-{FORK_LABEL}.1, got {tag!r}"
        )
    return match.group("base"), int(match.group("revision"))


def version_key(version: str) -> tuple[int, int, int, int]:
    match = VERSION_RE.fullmatch(version.strip())
    if match is None:
        raise ForkReleaseError(f"invalid fork release version: {version!r}")
    major, minor, patch, fork = match.groups()
    return int(major), int(minor), int(patch), int(fork or 0)


def cargo_version(root: Path = REPO_ROOT) -> str:
    text = (root / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, flags=re.MULTILINE)
    if match is None:
        raise ForkReleaseError("Cargo.toml has no package version")
    return match.group(1)


def read_source_constant(path: Path, name: str) -> int:
    match = re.search(rf"pub const {name}: u32 = (\d+);", path.read_text(encoding="utf-8"))
    if match is None:
        raise ForkReleaseError(f"{path} does not define {name}")
    return int(match.group(1))


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        raise ForkReleaseError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def fork_tags() -> list[str]:
    tags = [tag for tag in git("tag", "--list", f"v*-{FORK_LABEL}.*").splitlines() if TAG_RE.fullmatch(tag)]
    return sorted(tags, key=version_key)


def previous_fork_tag(tag: str, tags: list[str]) -> str | None:
    current = version_key(tag)
    earlier = [candidate for candidate in tags if version_key(candidate) < current]
    return earlier[-1] if earlier else None


def next_fork_tag(base: str, tags: list[str]) -> str:
    revisions = [parse_tag(tag)[1] for tag in tags if parse_tag(tag)[0] == base]
    return f"v{base}-{FORK_LABEL}.{max(revisions, default=0) + 1}"


def ref_exists(ref: str) -> bool:
    return bool(git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False))


def build_notes(
    tag: str,
    previous_tag: str | None,
    fork_commits: list[str],
    upstream_base: str | None,
    upstream_commit_count: int | None,
    repo: str = DEFAULT_REPO,
) -> str:
    base, _ = parse_tag(tag)
    lines = [
        f"Fork build of [herdr](https://github.com/{UPSTREAM_REPO}) {base} with the "
        f"[{repo}](https://github.com/{repo}) changes below.",
        "",
        "### Fork changes",
    ]
    if fork_commits:
        lines.extend(f"- {subject}" for subject in fork_commits)
    elif previous_tag:
        lines.append(f"- No fork-only changes since {previous_tag}.")
    else:
        lines.append("- No fork-only changes.")

    if upstream_base:
        lines.extend(["", "### Upstream"])
        summary = f"- Based on {UPSTREAM_REPO}@{upstream_base[:12]}"
        if previous_tag and upstream_commit_count:
            summary += f" ({upstream_commit_count} new upstream commits since {previous_tag})"
        lines.append(summary + ".")

    lines.extend(
        [
            "",
            "### Install",
            f"- `curl -fsSL https://github.com/{repo}/releases/latest/download/install.sh | sh`",
            "- Existing fork installs update with `herdr update`.",
        ]
    )
    return "\n".join(lines) + "\n"


def collect_notes(tag: str, upstream_ref: str | None, repo: str) -> str:
    previous_tag = previous_fork_tag(tag, fork_tags())
    exclude: list[str] = []
    upstream_base = None
    upstream_commit_count = None
    if upstream_ref and ref_exists(upstream_ref):
        exclude.append(upstream_ref)
        upstream_base = git("merge-base", tag, upstream_ref, check=False) or None
    if previous_tag:
        exclude.append(previous_tag)
        if upstream_base:
            upstream_commit_count = int(
                git("rev-list", "--count", "--no-merges", upstream_base, "--not", previous_tag)
            )
    log_args = ["log", "--no-merges", "--format=%s (%h)", tag]
    if exclude:
        log_args.extend(["--not", *exclude])
    fork_commits = [line for line in git(*log_args).splitlines() if line.strip()]
    return build_notes(tag, previous_tag, fork_commits, upstream_base, upstream_commit_count, repo)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_asset(assets_dir: Path, name: str) -> Path:
    # actions/download-artifact places each artifact in a directory named after it.
    for candidate in (assets_dir / name / name, assets_dir / name):
        if candidate.is_file():
            return candidate
    raise ForkReleaseError(f"missing release asset {name} under {assets_dir}")


def build_manifest(
    version: str,
    notes: str,
    assets: dict[str, str],
    sha256: dict[str, str],
    protocol: int,
    endpoint_generation: int,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    version = version.lstrip("v")
    version_key(version)
    notes = notes.strip()
    if not notes:
        raise ForkReleaseError("release notes are empty")
    missing = [target for target in ASSET_NAMES if target not in assets or target not in sha256]
    if missing:
        raise ForkReleaseError(f"manifest is missing assets for {', '.join(missing)}")

    releases: dict[str, Any] = {}
    if previous:
        previous_releases = previous.get("releases")
        if isinstance(previous_releases, dict):
            for key, value in previous_releases.items():
                if isinstance(value, dict) and VERSION_RE.fullmatch(key) and key != version:
                    releases[key] = value
    current = {
        "notes": notes,
        "protocol": protocol,
        "endpoint_generation": endpoint_generation,
        "assets": dict(assets),
        "sha256": dict(sha256),
    }
    releases[version] = current
    ordered = {key: releases[key] for key in sorted(releases, key=version_key, reverse=True)}
    return {
        "version": version,
        "protocol": protocol,
        "endpoint_generation": endpoint_generation,
        "notes": notes,
        "assets": dict(assets),
        "sha256": dict(sha256),
        "releases": ordered,
    }


def cmd_check_tag(args: argparse.Namespace) -> int:
    base, revision = parse_tag(args.tag)
    expected = cargo_version()
    if base != expected:
        raise ForkReleaseError(
            f"tag {args.tag} does not match Cargo.toml version {expected}; "
            f"tag v{expected}-{FORK_LABEL}.<N> instead"
        )
    outputs = {"version": args.tag.lstrip("v"), "revision": str(revision)}
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            for key, value in outputs.items():
                handle.write(f"{key}={value}\n")
    else:
        for key, value in outputs.items():
            print(f"{key}={value}")
    return 0


def cmd_notes(args: argparse.Namespace) -> int:
    parse_tag(args.tag)
    notes = collect_notes(args.tag, args.upstream_ref, args.repo)
    Path(args.output).write_text(notes, encoding="utf-8")
    return 0


def cmd_manifest(args: argparse.Namespace) -> int:
    parse_tag(args.tag)
    version = args.tag.lstrip("v")
    assets_dir = Path(args.assets_dir)
    assets: dict[str, str] = {}
    checksums: dict[str, str] = {}
    for target, name in ASSET_NAMES.items():
        assets[target] = f"https://github.com/{args.repo}/releases/download/{args.tag}/{name}"
        checksums[target] = sha256_file(find_asset(assets_dir, name))

    previous = None
    if args.previous and Path(args.previous).is_file():
        previous = json.loads(Path(args.previous).read_text(encoding="utf-8"))

    manifest = build_manifest(
        version,
        Path(args.notes).read_text(encoding="utf-8"),
        assets,
        checksums,
        read_source_constant(REPO_ROOT / "src/protocol/wire.rs", "PROTOCOL_VERSION"),
        read_source_constant(
            REPO_ROOT / "src/protocol/endpoint.rs", "ENDPOINT_PROTOCOL_GENERATION"
        ),
        previous,
    )
    Path(args.output).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


def cmd_tag(args: argparse.Namespace) -> int:
    git("fetch", "--tags", args.remote, "master")
    head = git("rev-parse", "HEAD")
    remote_master = git("rev-parse", "FETCH_HEAD")
    if head != remote_master:
        raise ForkReleaseError(
            f"HEAD {head[:12]} is not {args.remote}/master {remote_master[:12]}; "
            "push master first so the release builds a published commit"
        )
    tag = next_fork_tag(cargo_version(), fork_tags())
    if args.dry_run:
        print(tag)
        return 0
    git("tag", "-a", tag, "-m", f"herdr {tag.lstrip('v')}")
    git("push", args.remote, f"refs/tags/{tag}")
    print(f"pushed {tag}; the Fork Release workflow will publish it")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    check_tag = commands.add_parser("check-tag", help="validate a fork release tag")
    check_tag.add_argument("--tag", required=True)
    check_tag.add_argument("--github-output")
    check_tag.set_defaults(func=cmd_check_tag)

    notes = commands.add_parser("notes", help="write release notes for a fork tag")
    notes.add_argument("--tag", required=True)
    notes.add_argument("--upstream-ref", default="upstream/master")
    notes.add_argument("--repo", default=DEFAULT_REPO)
    notes.add_argument("--output", required=True)
    notes.set_defaults(func=cmd_notes)

    manifest = commands.add_parser("manifest", help="write latest.json for a fork release")
    manifest.add_argument("--tag", required=True)
    manifest.add_argument("--repo", default=DEFAULT_REPO)
    manifest.add_argument("--assets-dir", required=True)
    manifest.add_argument("--notes", required=True)
    manifest.add_argument("--previous", help="previous release latest.json, if any")
    manifest.add_argument("--output", required=True)
    manifest.set_defaults(func=cmd_manifest)

    tag = commands.add_parser("tag", help="create and push the next fork release tag")
    tag.add_argument("--remote", default="origin")
    tag.add_argument("--dry-run", action="store_true")
    tag.set_defaults(func=cmd_tag)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except ForkReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
