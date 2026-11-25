import type { AnimationEvent } from "react";
import { ArrowRight, X } from "lucide-react";
import type { AuditReport } from "../application/audit-contract";

/** The three snapshots the offer fans out: a phone, a tablet and a desktop, or whatever the report has first. */
const FAN = ["phone", "tablet", "desktop"];

/**
 * The small card that appears once the entry audit is done, while the canvas still shows only the two live previews:
 * it says the snapshots are ready, with how many bugs they mark, and puts them on the canvas when taken. It never takes
 * focus. leaving: it animates out (taken or dismissed), then onGone unmounts it.
 */
export function SnapshotOffer({ report, leaving, onShow, onDismiss, onGone }: {
  report: AuditReport; leaving: boolean; onShow: () => void; onDismiss: () => void; onGone: () => void;
}) {
  const fan = FAN.flatMap((id) => report.snapshots.filter((snapshot) => snapshot.profileId === id).slice(0, 1));
  const thumbs = fan.length ? fan : report.snapshots.slice(0, 3);
  const bugs = report.summary.bug;
  const captures = report.snapshots.length;

  return <div className="snapshot-offer" role="status" data-leaving={leaving || undefined} aria-label="Audit snapshots ready"
    onAnimationEnd={(event: AnimationEvent) => { if (leaving && event.target === event.currentTarget) onGone(); }}>
    <span className="snapshot-offer-fan" aria-hidden="true">
      {thumbs.map((snapshot, index) => <img key={snapshot.profileId} src={snapshot.image} alt="" draggable={false} style={{ "--i": index, "--n": thumbs.length }} />)}
    </span>
    <span className="snapshot-offer-text">
      <strong>Snapshots ready</strong>
      <span>{captures} {captures === 1 ? "capture" : "captures"} · <span data-bugs={bugs > 0 || undefined}>{bugs} {bugs === 1 ? "bug" : "bugs"}</span></span>
    </span>
    <button type="button" className="snapshot-offer-show" disabled={leaving} onClick={onShow}>Show snapshots<ArrowRight size={14} aria-hidden="true" /></button>
    <button type="button" className="snapshot-offer-dismiss" disabled={leaving} aria-label="Dismiss" title="Not now" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>
  </div>;
}
