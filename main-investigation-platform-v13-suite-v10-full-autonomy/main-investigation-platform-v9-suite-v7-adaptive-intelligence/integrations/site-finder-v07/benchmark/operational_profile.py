"""Instrument one deterministic Site Finder round without changing its workload.

The trace includes every statement SQLite executes, including statements from
executescript and triggers. Phase durations are inclusive and can overlap.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from collections import Counter, defaultdict
from unittest.mock import patch

from app.v2 import active, engine, intelligence, netio, selection
from benchmark.intelligence_ab import run


class Meter:
    def __init__(self):
        self.active = False
        self.connections = 0
        self.connect_seconds = 0.0
        self.commits = 0
        self.commit_seconds = 0.0
        self.rollbacks = 0
        self.statements = 0
        self.writes = 0
        self.sql_seconds = 0.0
        self.patterns = Counter()
        self.phases = defaultdict(float)
        self.calls = Counter()
        self.rounds = []

    def trace(self, sql):
        if not self.active:
            return
        self.statements += 1
        token = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
        self.writes += token in ("INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP")
        normalized = re.sub(r"'(?:''|[^'])*'", "?", sql)
        normalized = re.sub(r"\b\d+(?:\.\d+)?\b", "?", normalized)
        self.patterns[" ".join(normalized.split())[:190]] += 1


def measure(seed=101, split="eval", rounds=1):
    meter = Meter()
    original_connect = sqlite3.connect
    original_round = engine.run_round

    class MeasuredConnection(sqlite3.Connection):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.set_trace_callback(meter.trace)

        def execute(self, *args, **kwargs):
            started = time.perf_counter()
            try:
                return super().execute(*args, **kwargs)
            finally:
                if meter.active:
                    meter.sql_seconds += time.perf_counter() - started

        def executemany(self, *args, **kwargs):
            started = time.perf_counter()
            try:
                return super().executemany(*args, **kwargs)
            finally:
                if meter.active:
                    meter.sql_seconds += time.perf_counter() - started

        def executescript(self, *args, **kwargs):
            started = time.perf_counter()
            try:
                return super().executescript(*args, **kwargs)
            finally:
                if meter.active:
                    meter.sql_seconds += time.perf_counter() - started

        def commit(self):
            started = time.perf_counter()
            try:
                return super().commit()
            finally:
                if meter.active:
                    meter.commits += 1
                    meter.commit_seconds += time.perf_counter() - started

        def rollback(self):
            if meter.active:
                meter.rollbacks += 1
            return super().rollback()

    def connect(*args, **kwargs):
        started = time.perf_counter()
        connection = original_connect(*args, **{**kwargs, "factory": MeasuredConnection})
        if meter.active:
            meter.connections += 1
            meter.connect_seconds += time.perf_counter() - started
        return connection

    def timed(obj, name, phase):
        original = getattr(obj, name)

        def wrapper(*args, **kwargs):
            started = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                if meter.active:
                    meter.phases[phase] += time.perf_counter() - started
                    meter.calls[phase] += 1
        return patch.object(obj, name, wrapper)

    def round_wrapper(*args, **kwargs):
        previous = meter.active
        meter.active = True
        before = time.perf_counter()
        try:
            return original_round(*args, **kwargs)
        finally:
            meter.rounds.append(time.perf_counter() - before)
            meter.active = previous

    from contextlib import ExitStack
    with ExitStack() as stack:
        stack.enter_context(patch.object(sqlite3, "connect", connect))
        for obj, name, phase in (
            (active, "plan", "frontier_plan"), (active, "execute", "pivot_execute"),
            (intelligence, "ingest", "graph_ingest"), (intelligence, "rebuild", "campaign_rebuild"),
            (intelligence, "campaign_for", "campaign_lookup"),
            (selection, "shortlist", "candidate_intelligence"),
            (netio, "crtsh", "external_ct"), (netio, "resolve", "external_dns"),
            (netio, "fetch", "external_http")):
            stack.enter_context(timed(obj, name, phase))
        stack.enter_context(patch.object(engine, "run_round", round_wrapper))
        result = run(seed, split, rounds)
    return {"seed": seed, "split": split, "rounds": rounds, "wall_seconds": round(sum(meter.rounds), 4),
            "connections": meter.connections, "statements": meter.statements, "writes": meter.writes,
            "commits": meter.commits, "rollbacks": meter.rollbacks,
            "connect_seconds": round(meter.connect_seconds, 4),
            "sql_seconds": round(meter.sql_seconds, 4),
            "commit_seconds": round(meter.commit_seconds, 4),
            "phases_seconds_inclusive": {k: round(v, 4) for k, v in meter.phases.items()},
            "phase_calls": dict(meter.calls), "repeated_sql": meter.patterns.most_common(20),
            "selection": result["rounds"][0]["upgraded"],
            "graph": {k: result[k] for k in ("relationships", "false_relationships")}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=101)
    parser.add_argument("--split", default="eval")
    parser.add_argument("--rounds", type=int, default=1)
    args = parser.parse_args()
    print(json.dumps(measure(args.seed, args.split, args.rounds), indent=2))
