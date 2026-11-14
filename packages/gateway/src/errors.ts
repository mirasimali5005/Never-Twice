// Gateway errors. None carries a transient label, so throwing one inside a withTransaction callback aborts the
// transaction and is rethrown without a re-run.

/** The guarded goodwill update matched nothing (cap reached or grant frozen). Thrown inside the reserve callback. */
export class BudgetRefused extends Error {
  constructor() {
    super("goodwill grant has no headroom for this amount, or is frozen");
    this.name = "BudgetRefused";
  }
}

/** frozen_request_sha256 does not match the frozen request. Nothing may be transmitted. */
export class FrozenRequestHashMismatch extends Error {
  constructor(intentId: string) {
    super(`frozen request hash mismatch for ${intentId}`);
    this.name = "FrozenRequestHashMismatch";
  }
}

/** A stored invariant does not hold (for example grant counters that do not cover a held amount). Never patched. */
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}

/** A caller asked for something the state machine forbids, or data is missing that fixed code requires. */
export class ProgrammerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgrammerError";
  }
}
