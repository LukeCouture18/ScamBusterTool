"""
Every collector is just a function that yields (url, source_label) pairs.
Add new sources by writing a new module here and registering it in __init__.py.
"""
from typing import Iterator, Tuple

Candidate = Tuple[str, str]  # (url, source_label)


class BaseCollector:
    name = "base"

    def collect(self) -> Iterator[Candidate]:
        raise NotImplementedError
