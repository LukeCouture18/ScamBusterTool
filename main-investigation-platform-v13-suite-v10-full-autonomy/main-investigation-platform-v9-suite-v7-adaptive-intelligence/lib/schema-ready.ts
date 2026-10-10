/** Refuse requests and scheduled work while required migration columns are absent. */
export async function assertSchemaReady(db: D1Database) {
  try {
    await db.prepare("SELECT diff FROM monitoring_snapshots LIMIT 0").all();
    await db.prepare("SELECT status,evidence_sha256 FROM report_candidates LIMIT 0").all();
    await db.prepare("SELECT status,available_at FROM event_store LIMIT 0").all();
    await db.prepare("SELECT status,lease_expires_at FROM jobs LIMIT 0").all();
    await db.prepare("SELECT status FROM approval_gates LIMIT 0").all();
    await db.prepare("SELECT last_heartbeat_at FROM module_registry LIMIT 0").all();
    await db.prepare("SELECT status,score,cluster_key FROM inbox_candidates LIMIT 0").all();
    await db.prepare("SELECT seq FROM inbox_decisions LIMIT 0").all();
    await db.prepare("SELECT status,deadline_at,used_actions FROM agent_runs LIMIT 0").all();
    await db.prepare("SELECT validation,fingerprint FROM agent_steps LIMIT 0").all();
    await db.prepare("SELECT evidence_watermark FROM human_checkpoints LIMIT 0").all();
    await db.prepare("SELECT basis FROM finder_outcomes LIMIT 0").all();
    await db.prepare("SELECT basis FROM memory_facts LIMIT 0").all();
    await db.prepare("SELECT status,max_parallel FROM campaigns LIMIT 0").all();
    await db.prepare("SELECT basis,source_ref FROM campaign_edges LIMIT 0").all();
    await db.prepare("SELECT fingerprint,priority FROM opportunities LIMIT 0").all();
    await db.prepare("SELECT status,confidence FROM hypotheses LIMIT 0").all();
    await db.prepare("SELECT basis,useful FROM experience LIMIT 0").all();
    await db.prepare("SELECT generic,degree FROM intel_nodes LIMIT 0").all();
    await db.prepare("SELECT basis,active FROM intel_edges LIMIT 0").all();
    await db.prepare("SELECT value_hash,observations FROM entity_facets LIMIT 0").all();
    await db.prepare("SELECT change_kind,work_item_id FROM entity_changes LIMIT 0").all();
    await db.prepare("SELECT fingerprint,lease_until,not_before FROM work_items LIMIT 0").all();
    await db.prepare("SELECT value FROM ops_state LIMIT 0").all();
    await db.prepare("SELECT max_units FROM budget_limits LIMIT 0").all();
    await db.prepare("SELECT status,gap_kind FROM evidence_gaps LIMIT 0").all();
    await db.prepare("SELECT fingerprint,status FROM contradictions LIMIT 0").all();
    await db.prepare("SELECT visible_state,is_replay FROM ai_decisions LIMIT 0").all();
    await db.prepare("SELECT dedupe_key,count FROM ops_notifications LIMIT 0").all();
    await db.prepare("SELECT external_id,model_status,campaign_id FROM hunter_operations LIMIT 0").all();
    await db.prepare("SELECT proposal_key,outcome FROM hunter_proposals LIMIT 0").all();
    await db.prepare("SELECT state,found,stop_reason FROM finder_hunts LIMIT 0").all();
    await db.prepare("SELECT identity,validation_status,best_context FROM wallet_candidates LIMIT 0").all();
    await db.prepare("SELECT context_class,content_sha256 FROM wallet_observations LIMIT 0").all();
    await db.prepare("SELECT summary,ready,destination_sha256 FROM report_contents LIMIT 0").all();
    await db.prepare("SELECT destination_sha256 FROM module_destinations LIMIT 0").all();
    await db.prepare("SELECT state,lease_until FROM director_investigations LIMIT 0").all();
    await db.prepare("SELECT fingerprint,status FROM director_actions LIMIT 0").all();
    await db.prepare("SELECT generation,next_at FROM director_retries LIMIT 0").all();
    await db.prepare("SELECT provider_calls,max_requests FROM director_resources LIMIT 0").all();
    await db.prepare("SELECT objective,evidence_refs FROM director_objectives LIMIT 0").all();
    await db.prepare("SELECT network,next_probe_at FROM director_provider_health LIMIT 0").all();
    await db.prepare("SELECT job_id,cost FROM director_reservations LIMIT 0").all();
    await db.prepare("SELECT dirty,boundary_revision FROM operation_state LIMIT 0").all();
    await db.prepare("SELECT assertion_kind,independence_key FROM operation_edges LIMIT 0").all();
    await db.prepare("SELECT supports,contradicts,content_hash FROM operation_hypotheses LIMIT 0").all();
    await db.prepare("SELECT review_hash,status FROM operation_decisions LIMIT 0").all();
    await db.prepare("SELECT association,origin FROM operation_entities LIMIT 0").all();
    await db.prepare("SELECT content_hash,detail FROM operation_history LIMIT 0").all();
    await db.prepare("SELECT value,last_seen FROM operation_facets LIMIT 0").all();
    await db.prepare("SELECT fingerprint,evidence_ids FROM operation_contradictions LIMIT 0").all();
    await db.prepare("SELECT fingerprint,baseline,status FROM operation_hunts LIMIT 0").all();
    await db.prepare("SELECT target_operation_id,decision_id FROM operation_aliases LIMIT 0").all();
    // v7 adaptive investigation intelligence (0018).
    await db.prepare("SELECT family,status,content_hash FROM adaptive_gaps LIMIT 0").all();
    await db.prepare("SELECT state_hash,stop_state FROM adaptive_decisions LIMIT 0").all();
    await db.prepare("SELECT component,contribution FROM adaptive_decision_components LIMIT 0").all();
    await db.prepare("SELECT inputs_hash,generation,attributed_at FROM adaptive_tests LIMIT 0").all();
    await db.prepare("SELECT reserved,consumed,measured FROM adaptive_costs LIMIT 0").all();
    await db.prepare("SELECT stage,strength FROM adaptive_lineage LIMIT 0").all();
    await db.prepare("SELECT outcome_kind,credit FROM adaptive_outcomes LIMIT 0").all();
    await db.prepare("SELECT delta,after_max FROM adaptive_budget_adjustments LIMIT 0").all();
    await db.prepare("SELECT watermark,skipped_evaluations FROM adaptive_parking LIMIT 0").all();
    await db.prepare("SELECT level,state FROM adaptive_saturation LIMIT 0").all();
    await db.prepare("SELECT bonus,consecutive_starts FROM adaptive_scope_state LIMIT 0").all();
    await db.prepare("SELECT score,started FROM adaptive_portfolio LIMIT 0").all();
    await db.prepare("SELECT predictions_hash,assessed_at FROM scientific_plans LIMIT 0").all();
    await db.prepare("SELECT content_hash,status FROM scientific_hypotheses LIMIT 0").all();
    await db.prepare("SELECT status FROM scientific_contradictions LIMIT 0").all();
    await db.prepare("SELECT state,next_at FROM autonomy_investigations LIMIT 0").all();
    await db.prepare("SELECT outcome FROM scientific_matches LIMIT 0").all();
  } catch (cause) {
    throw new Error("SCHEMA_UPGRADE_INCOMPLETE: stop workers, restore or complete ordered D1 migrations, then restart", { cause });
  }
}
