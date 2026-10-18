"""APFS copy-on-write clone of a trezor-suite checkout, minus the peer worktrees.

    python3 clone.py <checkout> <dest>

clonefile() clones a directory recursively in ~19 s for the whole repo (.git, node_modules, build
output included); src and dest must be on the same APFS volume (/Users and /private/tmp are).
Each top-level entry is cloned on its own so .claude (nested worktrees, each with its own
node_modules) and .perf-ab are skipped. clonefile follows a symlink source: symlinked files
(CLAUDE.md -> AGENTS.md) arrive as regular files; build.mjs restores them with a forced checkout.
"""
import ctypes
import os
import sys
import time

src, dst = sys.argv[1], sys.argv[2]
skip = {'.claude', '.perf-ab', '.DS_Store'}
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libc.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]

os.makedirs(dst, exist_ok=False)
t0 = time.time()
for name in sorted(os.listdir(src)):
    # .env / .env.*: a developer's local settings (and a read the sandbox denies); build.mjs would set
    # them aside anyway, and a tracked one comes back with the forced checkout
    if name in skip or name == '.env' or name.startswith('.env.'):
        continue
    s, d = os.path.join(src, name), os.path.join(dst, name)
    if libc.clonefile(s.encode(), d.encode(), 0) != 0:
        err = ctypes.get_errno()
        sys.exit(f'clonefile {name} failed: {os.strerror(err)}')
print(f'cloned {src} -> {dst} in {time.time() - t0:.1f} s')
