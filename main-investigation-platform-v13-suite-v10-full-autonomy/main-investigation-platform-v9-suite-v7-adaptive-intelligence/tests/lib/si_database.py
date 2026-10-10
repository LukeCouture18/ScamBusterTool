"""Deterministic SQLite handle ownership for tests that use Site Investigator's Database.

Site Investigator (frozen, unchanged) opens a new sqlite3 connection for every
query and uses it as a context manager:

    with self.connect() as c: ...

A sqlite3 connection's context manager only commits or rolls back; it does not
close. CPython's sqlite3.Connection also sits in a reference cycle with its own
statement cache, so dropping the last reference does not free it either: the
file handle stays open until the cyclic garbage collector happens to run.

On Linux and macOS an open file can be unlinked, so this never showed. On
Windows, TemporaryDirectory cleanup then fails with WinError 32 on
site_investigator.db whenever the collector has not run yet.

OwnedDatabase is the frozen Database with one addition: it records every
connection its unchanged connect() opens, and close() closes them all. Tests
close it before their temporary directory is removed. Query behaviour, schema
and connection settings are exactly the frozen module's.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from siteinvestigator.db import Database


class OwnedDatabase(Database):
    def __init__(self, data_dir):
        self._connections: list[sqlite3.Connection] = []   # before super(): __init__ connects
        super().__init__(data_dir)

    def connect(self):
        connection = super().connect()
        self._connections.append(connection)
        return connection

    def close(self) -> int:
        """Close every connection this instance opened. Returns how many."""
        count = len(self._connections)
        while self._connections:
            self._connections.pop().close()
        return count

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        leaked = open_handles_under(self.root)
        # Checked only when the block succeeded, so a real test failure is not replaced by this one.
        assert exc[0] is not None or not leaked, f"SQLite handles still open under {self.root}: {leaked}"
        return False


def open_handles_under(directory) -> list[str]:
    """Files under `directory` this process still holds open.

    Linux exposes them in /proc/self/fd, which makes a leak that only breaks
    cleanup on Windows visible on Linux as well. Elsewhere the list is empty
    and Windows' own delete semantics are the check.
    """
    fd_dir = Path("/proc/self/fd")
    if not fd_dir.is_dir():
        return []
    root = str(Path(directory).resolve())
    held = []
    for entry in fd_dir.iterdir():
        try:
            target = os.path.realpath(entry)
        except OSError:
            continue
        if target == root or target.startswith(root + os.sep):
            held.append(target)
    return held
