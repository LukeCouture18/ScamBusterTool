-- 0013 · Wallet keys reported with their network already attached ("tron:T…") were stored with the
-- network twice ("tron:tron:t…"), so the same wallet reported by Site Finder and by Site Investigator
-- or Wallet Logger became two entities. Main now never prefixes twice (lib/domain.mjs). This
-- migration renames the stored keys where that is safe: only when no entity with the corrected key
-- exists yet. Rows that already have a correctly keyed twin are left untouched (nothing is deleted or
-- merged); they keep their history and remain readable. Additive and idempotent.
UPDATE entities
SET canonical_key = substr(canonical_key, instr(canonical_key, ':') + 1),
    updated_at = CURRENT_TIMESTAMP
WHERE entity_type IN ('wallet', 'token', 'transaction', 'counterparty')
  AND instr(canonical_key, ':') > 1
  AND substr(canonical_key, 1, instr(canonical_key, ':'))
      = substr(canonical_key, instr(canonical_key, ':') + 1, instr(canonical_key, ':'))
  AND NOT EXISTS (
    SELECT 1 FROM entities twin
    WHERE twin.entity_type = entities.entity_type
      AND twin.canonical_key = substr(entities.canonical_key, instr(entities.canonical_key, ':') + 1)
  );
