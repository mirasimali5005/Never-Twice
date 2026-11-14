import { useEffect } from "react";
import { isBaseline } from "../trailSteps";
import { formatMoney, shortHash } from "../format";
import type { ApiResult } from "../api";
import type { AnyTrail } from "../types";

// Beat 13: one compact card. Every sentence follows the wording rules of HANDOVER section 2.
export function HowItWorks(props: { open: boolean; onClose: () => void; trail: ApiResult<AnyTrail> | null; goodwill: boolean }) {
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!props.open) return null;
  const t = props.trail?.ok && !isBaseline(props.trail.data) ? props.trail.data : null;
  const i = t?.intent;
  return (
    <div className="modal" role="dialog" aria-label="How it works" onClick={props.onClose}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>How it works</h2>
          <button type="button" className="label label--button" onClick={props.onClose}>
            Close
          </button>
        </div>
        <ul className="how">
          <li>
            <b>One transaction.</b> The payment intent, its audit event{props.goodwill ? " and any goodwill reservation" : ""} commit together in one MongoDB
            transaction. The intent's id is the entitlement key, so a second intent for the same entitlement cannot exist.
          </li>
          <li>
            <b>The model proposes and investigates. Deterministic code authorizes and verifies.</b> Fixed code decides: it checks marker, amount, currency and
            payee, and it re-sends only the identical request under a recorded licence.
          </li>
          <li>
            <b>The auditor</b> is a separate process with read-only access to the provider ledgers and no access to the system's database.
          </li>
          <li>
            <b>Simulated:</b> the payout provider. <b>Real:</b> Stripe in test mode (the ticket refund). <b>Confirmed</b> means the provider holds one matching
            payment object, not that money arrived.
          </li>
        </ul>
        {i && (
          <div className="how__intent" aria-label="The selected payment's intent">
            <div className="small muted">The selected payment, as stored</div>
            <div className="mono">_id {String(i._id)}</div>
            <div>
              state <b>{i.state}</b> · {typeof i.amount_minor === "number" ? formatMoney(i.amount_minor) : "amount unknown"}
              {i.frozen_request_sha256 && (
                <>
                  {" "}
                  · frozen request <span className="mono">{shortHash(i.frozen_request_sha256, 12)}</span>
                </>
              )}
            </div>
            <div className="small">audit events written with it: {(t?.audit ?? []).map((a) => a.type).join(", ") || "none shown"}</div>
          </div>
        )}
        <div className="how__foot">Built today: all code. Prepared: design documents. Simulated: payout provider. Prior work: Anchor.</div>
      </div>
    </div>
  );
}
