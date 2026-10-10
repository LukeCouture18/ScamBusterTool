"""Uncontended identical-world full wall runtime, internal graph toggle."""
import json
import time
from unittest.mock import patch
from benchmark.world import World
from benchmark.run import run_v2
from app.v2 import active, intelligence


def measure(enabled, split='eval', seeds=(101,202,303), rounds=5):
    patches = [] if enabled else [patch.object(intelligence,'ingest',return_value={}),
        patch.object(intelligence,'rebuild',return_value={}), patch.object(intelligence,'suggest',return_value=None),
        patch.object(intelligence,'campaign_for',return_value=None), patch.object(active,'execute',return_value=[]),
        patch.object(active,'plan',return_value=[]), patch.object(active,'note_decision',return_value=None),
        patch.object(active,'source_report',return_value={'sources':[]})]
    from contextlib import ExitStack
    started=time.monotonic()
    with ExitStack() as stack:
        for p in patches: stack.enter_context(p)
        results=[run_v2(World(seed=seed,split=split),rounds,decision_error=0) for seed in seeds]
    return {'seconds':round(time.monotonic()-started,3),
            'useful':sum(r['total']['useful'] for r in results)}

if __name__=='__main__':
    print(json.dumps({'graph_disabled':measure(False),'graph_enabled':measure(True)},indent=2))
