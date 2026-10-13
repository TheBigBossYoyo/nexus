/**
 * 0.9.1: what a call's security really was, and the calls NEXUS placed. Purely additive, except for one correction.
 *
 * `peer_verified` is whether the other end of the call was verified (the ZRTP string compared). Until now `end_to_end`
 * was true for any ZRTP or DTLS-SRTP call, which claimed more than was known: it is true now only for ZRTP whose string
 * was verified, and the rows written before are set back to false, since nothing was ever verified then.
 *
 * `director_line_placed_calls` holds the times of the calls NEXUS placed, so that the daily limit holds across a
 * restart of the application and a change of settings. Only the time: never who, never why.
 */
export const voiceLineVerificationSchema = /* sql */ `
ALTER TABLE director_line_calls ADD COLUMN peer_verified INTEGER;
UPDATE director_line_calls SET end_to_end = 0, peer_verified = 0 WHERE end_to_end = 1;
CREATE TABLE director_line_placed_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, placed_at TEXT NOT NULL
);
CREATE INDEX director_line_placed_calls_at ON director_line_placed_calls (placed_at);
`
