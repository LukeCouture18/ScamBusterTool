"""Test-only stand-in: raises unless a test installs its own synthetic resolver."""


class NXDOMAIN(Exception):
    pass


class NoAnswer(Exception):
    pass


def resolve(*_args, **_kwargs):
    raise RuntimeError("dnspython stand-in: real DNS is not available; tests must install a fixture resolver")
