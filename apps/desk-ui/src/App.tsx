import { useEffect, useMemo, useState } from "react";
import { api, MOCK } from "./api";
import { ArmColumn } from "./components/ArmColumn";
import { AuditorPanel, auditable } from "./components/AuditorPanel";
import { DecisionCard } from "./components/DecisionCard";
import { Header } from "./components/Header";
import certNt from "./mocks/certificate.nt.json";
import { mockElapsed, restartMock } from "./mocks/engine";
import type { ApiResult } from "./api";
import type { ClaimCase, GroupRun, GroupView } from "./types";
import { useResource, useRunData } from "./useRunData";

const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const GROUP_ID = q.get("group") ?? (MOCK ? "g4x8p2nd" : null);
const ARM_PARAM = q.get("arm");
const MANIFEST_PARAM = q.get("manifest");

export function App() {
  const [picked, setPicked] = useState<string | null>(null);
  const [armSel, setArmSel] = useState<string>(ARM_PARAM ?? "nt");
  const [override, setOverride] = useState<boolean | null>(null); // null: the case file collapses by itself once payments exist

  const groupNow = useResource(GROUP_ID, () => api.group(GROUP_ID!), 0, 3000);
  // keep the last good group so a dropped request does not blank the screen; the banner says it is stale
  const [groupKept, setGroupKept] = useState<GroupView | null>(null);
  useEffect(() => {
    if (groupNow?.ok) setGroupKept(groupNow.data);
  }, [groupNow]);
  const group: ApiResult<GroupView> | null = groupKept ? { ok: true, data: groupKept } : groupNow;
  const runs: GroupRun[] = groupKept?.runs ?? [];
  const nt = runs.find((r) => r.arm === "nt");
  const control = runs.find((r) => r.arm === "control" || r.arm === "documented");
  const mutant = runs.find((r) => r.arm === "nt_mutant");

  const ntData = useRunData(nt, picked, true);
  const selectedKey = picked ?? ntData.selectedKey;
  const controlData = useRunData(control, selectedKey, true);
  const mutantData = useRunData(mutant, null, false);

  // the case file in focus: the claim behind the selected entitlement (earliest claim wins; merged duplicates are listed inside it)
  const claims = useResource(nt ? `cl:${nt.run_id}` : null, () => api.claims(nt!.run_id), 0, 5000);
  const claimId = useMemo(() => {
    if (!claims?.ok) return null;
    const list = claims.data;
    const bySelection = selectedKey ? list.filter((c) => c.effect_keys.includes(selectedKey)) : [];
    const ofP02 = list.filter((c) => c.effect_keys.some((k) => k.split(".")[1] === "P02")); // default case file: Daniel Whitlock's
    const pool = bySelection.length > 0 ? bySelection : ofP02.length > 0 ? ofP02 : list;
    return [...pool].sort((a, b) => a.received_at.localeCompare(b.received_at))[0]?.claim_id ?? null;
  }, [claims, selectedKey]);
  const claim = useResource(nt && claimId ? `c:${nt.run_id}:${claimId}` : null, () => api.claim(nt!.run_id, claimId!), 0, 5000);
  const [lastGood, setLastGood] = useState<ApiResult<ClaimCase> | null>(null);
  useEffect(() => {
    if (claim?.ok) setLastGood(claim);
  }, [claim]);
  const shownClaim = claim?.ok ? claim : lastGood ?? claim;

  const entries = [nt, control, mutant].flatMap((r, i) => (r ? [{ run: r, cert: [ntData, controlData, mutantData][i].certificate }] : []));
  const anyAudited = entries.some((e) => auditable(e.cert));
  const paymentsStarted = (ntData.payments?.ok ? ntData.payments.data.length : 0) > 0 || (controlData.payments?.ok ? controlData.payments.data.length : 0) > 0;
  const compact = override ?? (paymentsStarted || anyAudited);

  const certForManifest = entries.map((e) => (auditable(e.cert) ? e.cert.data : null)).find((c) => c !== null) ?? null;
  const groupManifest = groupKept?.manifest_sha256 ?? null;
  const manifest = {
    hash: groupManifest ?? MANIFEST_PARAM ?? certForManifest?.manifest_sha256 ?? (MOCK ? certNt.manifest_sha256 : null),
    commitment: certForManifest?.commitment_sha256 ?? (MOCK ? certNt.commitment_sha256 : null),
  };
  const groupIntake = groupKept?.intake_mode;
  const intakeReplay = groupIntake ? groupIntake === "replay" : shownClaim?.ok ? shownClaim.data.extraction_meta?.mode === "replay" : false;

  // mock rehearsal helper: a tiny clock and "r" to restart the progression
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!MOCK) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        restartMock();
        setPicked(null);
        setOverride(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!GROUP_ID) {
    return (
      <main className="empty">
        <h1>Never Twice</h1>
        <p>the claims desk that refuses to guess</p>
        <p>
          Open this page as <span className="mono">?group=&lt;group_id&gt;</span>, or add <span className="mono">?mock=1</span> to rehearse without a backend.
        </p>
      </main>
    );
  }

  return (
    <div className="desk">
      <Header groupId={GROUP_ID} group={group} manifest={manifest} mock={MOCK} stream={ntData.stream} intakeReplay={intakeReplay} />
      {groupNow && !groupNow.ok && (
        <div className="banner banner--error">
          Desk API unavailable ({groupNow.error}){groupKept ? ": what you see is the last data received" : ". Nothing below is shown as zero or green"}.
        </div>
      )}
      <DecisionCard claim={shownClaim} claims={claims?.ok ? claims.data : []} compact={compact} onToggle={() => setOverride(!compact)} />
      <main className="cols">
        <ArmColumn title="Ordinary agent (control)" kind="control" run={control} data={controlData} selectedKey={selectedKey} onSelect={setPicked} groupReady={groupKept !== null} />
        <ArmColumn title="Never Twice" kind="nt" run={nt} data={ntData} selectedKey={selectedKey} onSelect={setPicked} groupReady={groupKept !== null} />
      </main>
      <AuditorPanel entries={entries} selectedArm={armSel} onSelect={setArmSel} />
      {MOCK && (
        <div className="mockclock" aria-hidden>
          mock clock {Math.floor(mockElapsed())} s · r restarts
        </div>
      )}
    </div>
  );
}
