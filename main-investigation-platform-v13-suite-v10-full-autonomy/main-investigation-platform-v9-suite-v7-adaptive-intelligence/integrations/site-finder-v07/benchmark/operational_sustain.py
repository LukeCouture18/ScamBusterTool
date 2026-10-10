"""Deterministic sustained run with public-source failures injected by SimNet."""
from __future__ import annotations
import argparse
import json
import shutil
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from benchmark.world import World
from benchmark.run import Judge
from benchmark.simnet import SimNet, installed
from benchmark.run import _fresh_finder_state
from app.v2 import engine, inbox, operations, store


def evaluate(rounds=50, split='eval', seed=101):
    world = World(seed=seed, split=split)
    net = SimNet(world)
    folder = Path(tempfile.mkdtemp(prefix='finder-sustained-'))
    judge = Judge(world)
    counts = {'delivered': 0, 'useful': 0, 'unique': set(), 'source_failures': 0}
    original = engine.run_round
    def judged_round(*args, **kwargs):
        if counts['rounds']:
            world.advance()
        counts['rounds'] += 1
        outcome = original(*args, **kwargs)
        counts['delivered'] += len(outcome['delivered'])
        counts['unique'].update(x['domain'] for x in outcome['delivered'])
        while (candidate := inbox.next_candidate()):
            verdict = judge.judge(candidate['domain'])
            if verdict['useful']:
                counts['useful'] += 1
            inbox.decide(candidate['id'], 'useful' if verdict['useful'] else 'skip',
                         reason=None if verdict['useful'] else 'not_useful')
        return outcome
    counts['rounds'] = 0
    try:
        with installed(net), patch.object(engine, 'run_round', judged_round):
            _fresh_finder_state(folder)
            engine.configure_for_benchmark(nameserver_fn=net.nameservers)
            before = time.monotonic()
            rid = operations.create_run({'max_rounds': rounds, 'idle_stop': rounds,
                                         'max_seconds': 3600, 'max_requests': 10000})
            result = operations.run_sustained(rid)
            elapsed = time.monotonic()-before
            with store.conn() as conn:
                cost = conn.execute('SELECT SUM(connections),SUM(statements),SUM(external_requests),'
                                    'SUM(external_seconds),SUM(sql_seconds),SUM(elapsed) FROM ig_round_cost').fetchone()
                pages = conn.execute('SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()').fetchone()[0]
            return {'rounds_requested': rounds, 'rounds_completed': result['run']['rounds'],
                    'state': result['run']['state'], 'stop_reason': result['run']['reason'],
                    'elapsed_seconds': round(elapsed,3), 'delivered': counts['delivered'],
                    'unique_delivered': len(counts['unique']), 'useful_review': counts['useful'],
                    'connections': cost[0], 'statements': cost[1], 'requests': cost[2],
                    'external_seconds': round(cost[3] or 0,3), 'sql_seconds': round(cost[4] or 0,3),
                    'round_seconds': round(cost[5] or 0,3), 'db_bytes': pages,
                    'source_counts': net.counts}
    finally:
        engine.configure_for_benchmark(nameserver_fn=None)
        shutil.rmtree(folder)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rounds',type=int,default=50)
    parser.add_argument('--split',default='eval')
    args = parser.parse_args()
    print(json.dumps(evaluate(args.rounds,args.split),indent=2))
