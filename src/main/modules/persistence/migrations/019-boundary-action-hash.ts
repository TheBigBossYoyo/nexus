/**
 * 0.8: a boundary request carries the SHA-256 of the exact tool call it was raised for. A "once" grant is bound
 * to it: the text shown to the user is redacted and shortened, which is not exact enough to bind an approval to.
 * Different actions of the same need (one capability and resource) are different questions for the user, so the
 * one-pending-request rule now holds per need AND per action. Requests made before this have no hash, and a
 * "once" grant of such a request is never usable.
 */
export const boundaryActionHashSchema = /* sql */ `
ALTER TABLE boundary_requests ADD COLUMN action_hash TEXT;
DROP INDEX idx_boundary_requests_pending;
CREATE UNIQUE INDEX idx_boundary_requests_pending ON boundary_requests(dedupe_key, COALESCE(action_hash, '')) WHERE state = 'PENDING';
CREATE INDEX idx_boundary_requests_run_capability ON boundary_requests(run_id, capability);
`
