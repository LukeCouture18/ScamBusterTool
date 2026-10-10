-- v7 Adaptive Investigation Intelligence. Additive and replayable: CREATE ... IF NOT EXISTS only.
-- Every table here is coordination / decision-learning metadata. None of it is evidence, none of
-- it is copied into reports, and benchmark truth never enters it.

-- Typed evidence gaps (current state) and their immutable status history.
CREATE TABLE IF NOT EXISTS adaptive_gaps (
 scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, gap_key TEXT NOT NULL, family TEXT NOT NULL, subject TEXT NOT NULL,
 current_knowledge TEXT NOT NULL, missing_knowledge TEXT NOT NULL, why_matters TEXT NOT NULL,
 supporting TEXT NOT NULL DEFAULT '[]', contradicting TEXT NOT NULL DEFAULT '[]', uncertainty REAL NOT NULL,
 possible_tests TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
 exhaustion_condition TEXT NOT NULL, revisit_condition TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL,
 first_seen TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
 PRIMARY KEY(scope_kind,scope_id,gap_key)
);
CREATE INDEX IF NOT EXISTS adaptive_gap_status ON adaptive_gaps(scope_kind,scope_id,status);
CREATE INDEX IF NOT EXISTS adaptive_gap_family ON adaptive_gaps(family,status);
CREATE TABLE IF NOT EXISTS adaptive_gap_history (
 id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, gap_key TEXT NOT NULL, status TEXT NOT NULL,
 content_hash TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL,
 UNIQUE(scope_kind,scope_id,gap_key,content_hash)
);
CREATE INDEX IF NOT EXISTS adaptive_gap_history_time ON adaptive_gap_history(scope_kind,scope_id,at);

-- One decision per (scope, observable state). Replaying the same state replays the same decision.
CREATE TABLE IF NOT EXISTS adaptive_decisions (
 id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, seq INTEGER NOT NULL, state_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'decided', -- decided|reserved|executing|finished|stopped|superseded
 chosen_key TEXT, chosen_family TEXT, test_id TEXT, exploration INTEGER NOT NULL DEFAULT 0,
 question TEXT, why_matters TEXT, why_selected TEXT, deferred TEXT NOT NULL DEFAULT '[]',
 stop_state TEXT, stop_reason TEXT, utility REAL, expected_cost TEXT NOT NULL DEFAULT '{}',
 actual_cost TEXT, changed TEXT, created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(scope_kind,scope_id,state_hash)
);
CREATE INDEX IF NOT EXISTS adaptive_decision_scope ON adaptive_decisions(scope_kind,scope_id,seq DESC);
CREATE INDEX IF NOT EXISTS adaptive_decision_status ON adaptive_decisions(status,created_at);
-- Information-value components, persisted individually per candidate.
CREATE TABLE IF NOT EXISTS adaptive_decision_components (
 decision_id TEXT NOT NULL REFERENCES adaptive_decisions(id), candidate_key TEXT NOT NULL, family TEXT NOT NULL, subject TEXT NOT NULL,
 component TEXT NOT NULL, value REAL NOT NULL, weight REAL NOT NULL, contribution REAL NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(decision_id,candidate_key,component)
);

-- Test instances: the bounded action a decision chose, and its handoff to an existing specialist.
CREATE TABLE IF NOT EXISTS adaptive_tests (
 id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES adaptive_decisions(id), scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
 family TEXT NOT NULL, subject TEXT NOT NULL, inputs_hash TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 gap_keys TEXT NOT NULL DEFAULT '[]', objective TEXT NOT NULL DEFAULT '{}', safety_class TEXT NOT NULL, specialist TEXT NOT NULL,
 hunt_id TEXT, work_item_id TEXT, job_id TEXT, exploration INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'reserved', -- reserved|running|finished|failed|cancelled
 baseline TEXT NOT NULL DEFAULT '{}', outcome TEXT NOT NULL DEFAULT '{}', useful INTEGER,
 attributed_at TEXT, budget_checked INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 UNIQUE(scope_kind,scope_id,family,inputs_hash,generation)
);
CREATE INDEX IF NOT EXISTS adaptive_test_scope ON adaptive_tests(scope_kind,scope_id,status,created_at);
CREATE INDEX IF NOT EXISTS adaptive_test_family ON adaptive_tests(family,status,finished_at);
CREATE INDEX IF NOT EXISTS adaptive_test_job ON adaptive_tests(job_id);
CREATE INDEX IF NOT EXISTS adaptive_test_work ON adaptive_tests(work_item_id);

-- Actual-cost ledger: reserved and consumed are separate; consumed is NULL unless measured.
CREATE TABLE IF NOT EXISTS adaptive_costs (
 test_id TEXT NOT NULL REFERENCES adaptive_tests(id), dimension TEXT NOT NULL, reserved REAL NOT NULL DEFAULT 0,
 consumed REAL, measured INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'reservation', recorded_at TEXT NOT NULL,
 PRIMARY KEY(test_id,dimension)
);

-- Causal lineage (decision -> test -> specialist action -> outputs -> downstream) and credited outcomes.
CREATE TABLE IF NOT EXISTS adaptive_lineage (
 id TEXT PRIMARY KEY, test_id TEXT NOT NULL REFERENCES adaptive_tests(id), stage TEXT NOT NULL, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL,
 parent_ref TEXT, strength TEXT NOT NULL DEFAULT 'provenance', detail TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL,
 UNIQUE(test_id,stage,ref_kind,ref_id)
);
CREATE INDEX IF NOT EXISTS adaptive_lineage_ref ON adaptive_lineage(ref_kind,ref_id);
CREATE TABLE IF NOT EXISTS adaptive_outcomes (
 outcome_kind TEXT NOT NULL, outcome_ref TEXT NOT NULL, test_id TEXT NOT NULL REFERENCES adaptive_tests(id), credit REAL NOT NULL,
 basis TEXT NOT NULL, family TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL,
 PRIMARY KEY(outcome_kind,outcome_ref,test_id)
);
CREATE INDEX IF NOT EXISTS adaptive_outcome_family ON adaptive_outcomes(family,outcome_kind,at);
CREATE INDEX IF NOT EXISTS adaptive_outcome_test ON adaptive_outcomes(test_id);

-- Bounded dynamic budgets: every adjustment, with its reason, at most once per triggering test.
CREATE TABLE IF NOT EXISTS adaptive_scope_state (
 scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, bonus INTEGER NOT NULL DEFAULT 0, decisions INTEGER NOT NULL DEFAULT 0,
 consecutive_starts INTEGER NOT NULL DEFAULT 0, last_started_at TEXT, last_utility REAL, last_summary TEXT NOT NULL DEFAULT '{}',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(scope_kind,scope_id)
);
CREATE TABLE IF NOT EXISTS adaptive_budget_adjustments (
 id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, test_id TEXT NOT NULL, delta INTEGER NOT NULL,
 before_max INTEGER NOT NULL, after_max INTEGER NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL,
 UNIQUE(scope_kind,scope_id,test_id)
);

-- Parked work with explicit wake conditions and a cheap watermark (unchanged parked work is not re-planned).
CREATE TABLE IF NOT EXISTS adaptive_parking (
 scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
 wake_conditions TEXT NOT NULL DEFAULT '[]', watermark TEXT NOT NULL DEFAULT '{}', parked_at TEXT NOT NULL,
 next_check_at TEXT NOT NULL, skipped_evaluations INTEGER NOT NULL DEFAULT 0, woke_at TEXT, wake_reason TEXT,
 PRIMARY KEY(scope_kind,scope_id)
);
-- Saturation at test, gap, branch, investigation, operation and portfolio level.
CREATE TABLE IF NOT EXISTS adaptive_saturation (
 level TEXT NOT NULL, scope_key TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(level,scope_key)
);
-- Portfolio ranking per tick (bounded retention), for explanation of cross-operation choices.
CREATE TABLE IF NOT EXISTS adaptive_portfolio (
 tick_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, rank INTEGER NOT NULL, score REAL NOT NULL,
 started INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(tick_id,scope_kind,scope_id)
);
CREATE INDEX IF NOT EXISTS adaptive_portfolio_time ON adaptive_portfolio(at);

INSERT OR IGNORE INTO ops_state(key,value) VALUES ('adaptive_enabled','true'),('adaptive_bonus_cap','4'),('adaptive_local_tests_per_evaluation','3');
