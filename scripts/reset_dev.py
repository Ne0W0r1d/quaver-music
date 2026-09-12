#!/usr/bin/env python3
"""Kill whatever listens on TCP 4321 (the Astro dev server), then wipe caches."""
import os, shutil, signal, subprocess, sys

out = subprocess.run(["ss", "-tlnp", "sport", "=", "4321"], capture_output=True, text=True).stdout
pids = set()
import re
for m in re.finditer(r"pid=(\d+)", out):
    pids.add(int(m.group(1)))
print("listeners:", pids or "none")
for pid in pids:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

shutil.rmtree(os.path.expanduser("~/Desktop/quaver/ui/.astro"), ignore_errors=True)
shutil.rmtree(os.path.expanduser("~/Desktop/quaver/ui/node_modules/.vite"), ignore_errors=True)
print("caches cleaned")
