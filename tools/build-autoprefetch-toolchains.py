#!/usr/bin/env python3
"""Fetch every bootstrappable toolchain the configure run needs, in parallel.

mach's own downloader is a single connection with no read timeout, which on a
slow route to the artifact CDN stalls indefinitely (see
build/win-custom/README.md section 6). This walks the toolchain list out of an
existing objdir/config.log, resolves each one's Taskcluster artifact, and pulls
them in parallel through tools/build-prefetch-toolchain.py so that a subsequent
`mach configure` finds them all cached.

Usage:
  python autoprefetch.py <objdir-config.log> <cache-dir>

Idempotent: already-cached artifacts are skipped.
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

TC = "https://firefox-ci-tc.services.mozilla.com"
RESOLVE_RE = re.compile(r"Resolved (?:toolchain|fetch)-([\w.\-]+) to (\S+)")

HERE = os.path.dirname(os.path.abspath(__file__))


def resolve_task(index_path):
    url = f"{TC}/api/index/v1/task/{index_path}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)["taskId"]


def list_artifacts(task_id):
    url = f"{TC}/api/queue/v1/task/{task_id}/artifacts"
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)["artifacts"]


def artifact_url(task_id, name):
    quoted = urllib.parse.quote(name, safe="")
    return f"{TC}/api/queue/v1/task/{task_id}/artifacts/{quoted}"


def artifact_url_raw(task_id, name):
    return f"{TC}/api/queue/v1/task/{task_id}/artifacts/{name}"


def cached_names(cache_dir):
    if not os.path.isdir(cache_dir):
        return set()
    return set(os.listdir(cache_dir))


def main():
    log_path, cache_dir = sys.argv[1], sys.argv[2]

    resolved = {}
    with open(log_path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = RESOLVE_RE.search(line)
            if m:
                resolved[m.group(1)] = m.group(2)

    print(f"{len(resolved)} toolchains referenced by {log_path}")

    have = cached_names(cache_dir)
    pending = []
    for name, index_path in sorted(resolved.items()):
        try:
            task_id = resolve_task(index_path)
            arts = [a for a in list_artifacts(task_id) if a["name"].endswith(".tar.zst")]
        except Exception as exc:
            print(f"  {name}: cannot resolve ({exc})")
            continue
        if not arts:
            print(f"  {name}: no .tar.zst artifact")
            continue
        if not arts[0]["name"].startswith("public/"):
            # Private artifacts (e.g. the packed VS toolchain) are not fetched
            # over HTTP: bootstrap.configure runs an in-tree script that pulls
            # them from the vendor instead. Nothing to prefetch here.
            print(f"  {name}: vendor-side fetch, skipped")
            continue
        art = max(arts, key=lambda a: a.get("contentLength") or 0)
        url = artifact_url(task_id, art["name"])
        # Which spelling of the artifact name ends up percent-encoded in the
        # URL determines the cache filename mach will look for. Check both
        # spellings and prefer the percent-encoded one, which is what
        # ArtifactCache builds for slashed artifact names.
        import hashlib

        def cache_name(candidate):
            return (
                hashlib.sha256(candidate.encode()).hexdigest()[:16]
                + "-"
                + os.path.basename(urllib.parse.urlparse(candidate).path)
            )

        encoded = artifact_url(task_id, art["name"])
        raw = artifact_url_raw(task_id, art["name"])
        if cache_name(encoded) in have or cache_name(raw) in have:
            print(f"  {name}: cached")
            continue
        size = (art.get("contentLength") or 0) / 1048576
        print(f"  {name}: fetching {size:.1f} MB")
        pending.append((name, encoded))

    for name, url in pending:
        print(f"=== prefetching {name}", flush=True)
        rc = subprocess.call(
            [
                sys.executable,
                os.path.join(HERE, "build-prefetch-toolchain.py"),
                url,
                cache_dir,
                "16",
            ]
        )
        if rc != 0:
            print(f"  !! {name} failed with {rc}", flush=True)


if __name__ == "__main__":
    main()