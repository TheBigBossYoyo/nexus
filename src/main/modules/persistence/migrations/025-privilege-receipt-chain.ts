/**
 * 0.9.2: tamper-evident privileged-operation receipts. Purely additive.
 *
 * Each receipt that reaches a final outcome gets a place in a hash chain: `chain_seq` (its position), `chain_prev` (the
 * hash before it), `chain_hash` (SHA-256 over that and the receipt's canonical JSON) and `chain_hmac` (an HMAC of the
 * hash with a key NEXUS keeps protected; NULL when the key is not available). Receipts written before this migration
 * keep NULL chain columns. `privilege_chain_meta` records the legacy boundary once, at migration: the highest `seq` and
 * the number of receipts that existed then. `privilege_chain_spans` keeps what is needed to verify the chain across
 * old refusals that were evicted: the positions they covered, the hash before them and the hash they ended at.
 */
export const privilegeReceiptChainSchema = /* sql */ `
ALTER TABLE privileged_operations ADD COLUMN chain_seq INTEGER;
ALTER TABLE privileged_operations ADD COLUMN chain_prev TEXT;
ALTER TABLE privileged_operations ADD COLUMN chain_hash TEXT;
ALTER TABLE privileged_operations ADD COLUMN chain_hmac TEXT;
CREATE UNIQUE INDEX privileged_operations_chain_seq ON privileged_operations (chain_seq) WHERE chain_seq IS NOT NULL;
CREATE TABLE privilege_chain_spans (
  from_chain_seq INTEGER PRIMARY KEY, to_chain_seq INTEGER NOT NULL, start_prev TEXT NOT NULL, end_hash TEXT NOT NULL,
  hmac TEXT NOT NULL
);
CREATE TABLE privilege_chain_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1), legacy_max_seq INTEGER NOT NULL, legacy_count INTEGER NOT NULL
);
INSERT INTO privilege_chain_meta (id, legacy_max_seq, legacy_count)
  SELECT 1, COALESCE(MAX(seq), 0), COUNT(*) FROM privileged_operations;
`
