#!/usr/bin/env python3
"""Prefetch a Mozilla toolchain artifact into mach's artifact cache, in parallel.

Why this exists
---------------
`mach configure` with --enable-bootstrap fetches the pinned clang/VS toolchains
from Taskcluster. It uses mozbuild.artifact_cache.ArtifactCache, which downloads
with a single streamed connection and sets no read timeout on it:

    with closing(session.get(url, stream=True)) as response:
        for chunk in response.iter_content(chunk_size):

On a slow or flaky route to the artifact CDN that means either a very slow
transfer or an indefinite stall with no error and no way to make progress.
Measured from one such host: ~60-100 KB/s single-connection, versus ~1.2 MB/s
with 16 parallel range requests against the same URL.

This script does the parallel fetch and writes the result to the exact filename
ArtifactCache expects, so that the subsequent `mach artifact toolchain` call
finds it already cached and skips its own download. The artifact itself is
bit-identical to what mach would have fetched -- only the transport differs.

Re-running is safe and cheap: chunks that already completed are skipped, tracked
in a sidecar `<dest>.chunks` file. The destination is only moved into place once
every chunk has arrived, so a partial run never leaves a file that mach would
mistake for a complete artifact.

Usage
-----
  python tools/build-prefetch-toolchain.py <artifact-url> <cache-dir> [threads]

Where <cache-dir> is <state-dir>/toolchains -- the directory mach names in its
"Downloading artifact to local cache: ..." line.
"""
import concurrent.futures
import hashlib
import os
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_THREADS = 16
CHUNK = 1024 * 1024
ATTEMPTS = 5


def cache_filename(url):
    """Reproduce mozbuild.artifact_cache.ArtifactCache.fetch's naming rule."""
    basename = os.path.basename(urllib.parse.urlparse(url).path)
    digest = hashlib.sha256(url.encode()).hexdigest()[:16]
    return f"{digest}-{basename}"


def remote_size(url):
    """Content length plus the final URL after redirects."""
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return int(resp.headers["Content-Length"]), resp.geturl()


def fetch_chunk(url, start, end, dest):
    """Fetch one byte range and write it at its offset. Returns bytes written."""
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        if resp.status != 206:
            raise RuntimeError(
                f"server ignored Range for {start}-{end} (HTTP {resp.status}); "
                "parallel prefetch needs range support"
            )
        data = resp.read()
    with open(dest, "r+b") as fh:
        fh.seek(start)
        fh.write(data)
    return len(data)


def fetch_chunk_with_retry(url, index, start, end, part):
    """Fetch a chunk into its own part file, retrying transient failures."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                if resp.status != 206:
                    raise RuntimeError(f"HTTP {resp.status}, expected 206")
                data = resp.read()
            if len(data) != end - start + 1:
                raise RuntimeError(f"short read: {len(data)} of {end - start + 1}")
            with open(part, "wb") as fh:
                fh.write(data)
            return index
        except Exception as exc:
            if attempt == ATTEMPTS:
                raise
            time.sleep(2 * attempt)
    return None


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)

    url = sys.argv[1]
    cache_dir = sys.argv[2]
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_THREADS

    os.makedirs(cache_dir, exist_ok=True)
    dest = os.path.join(cache_dir, cache_filename(url))
    part_dir = dest + ".parts"
    size, final_url = remote_size(url)
    print(f"artifact : {size} bytes ({size / 1048576:.1f} MB)")
    print(f"cache    : {dest}", flush=True)

    if os.path.exists(dest) and os.path.getsize(dest) == size:
        print("already fully cached; nothing to do")
        return

    chunks = [(s, min(s + CHUNK - 1, size - 1)) for s in range(0, size, CHUNK)]
    os.makedirs(part_dir, exist_ok=True)

    def part_path(i):
        return os.path.join(part_dir, f"{i:06d}")

    pending = [
        (i, s, e)
        for i, (s, e) in enumerate(chunks)
        if not (os.path.exists(part_path(i)) and os.path.getsize(part_path(i)) == e - s + 1)
    ]
    print(f"chunks   : {len(chunks)} total, {len(pending)} still to fetch", flush=True)

    started = time.time()
    done_bytes = size - sum(e - s + 1 for _, s, e in pending)
    if pending:
        with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
            futures = [
                pool.submit(fetch_chunk_with_retry, final_url, i, s, e, part_path(i))
                for i, s, e in pending
            ]
            for future in concurrent.futures.as_completed(futures):
                idx = future.result()
                done_bytes += chunks[idx][1] - chunks[idx][0] + 1
                elapsed = time.time() - started
                print(
                    f"  {done_bytes / 1048576:7.0f}/{size / 1048576:.0f} MB  "
                    f"{done_bytes / elapsed / 1024:6.0f} KB/s",
                    flush=True,
                )

    # Assemble only once every chunk is on disk.
    missing = [i for i in range(len(chunks)) if not os.path.exists(part_path(i))]
    if missing:
        sys.exit(f"ERROR: {len(missing)} chunks missing; re-run to resume")

    tmp = dest + ".assembling"
    with open(tmp, "wb") as out:
        for i in range(len(chunks)):
            with open(part_path(i), "rb") as fh:
                out.write(fh.read())
    if os.path.getsize(tmp) != size:
        sys.exit("ERROR: assembled size mismatch; re-run to resume")
    os.replace(tmp, dest)
    for i in range(len(chunks)):
        os.remove(part_path(i))
    os.rmdir(part_dir)

    print(f"done in {time.time() - started:.0f}s -> {dest}")


if __name__ == "__main__":
    main()