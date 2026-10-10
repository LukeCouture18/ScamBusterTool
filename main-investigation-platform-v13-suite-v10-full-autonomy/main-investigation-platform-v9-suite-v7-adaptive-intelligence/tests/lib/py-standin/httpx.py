"""Test-only stand-in: the real `httpx` is unavailable in this environment; re-export `httpx2`."""
from httpx2 import *  # noqa: F401,F403
import httpx2 as _impl


def __getattr__(name):
    return getattr(_impl, name)
