import type { Artboard, Camera } from "../application/canvas-state";
import type { AuditFinding, AuditReport, AuditSnapshot } from "../application/audit-contract";

export interface SnapshotBoard extends Artboard { snapshot: AuditSnapshot }

const ROW_GAP = 220;
const BOARD_GAP = 96;

/** Lays the audit snapshots out in one row below the live previews, in canvas coordinates. */
export function snapshotBoards(report: AuditReport | null, live: Artboard[]): SnapshotBoard[] {
  if (!report?.snapshots.length) return [];
  let x = Math.min(...live.map((board) => board.x));
  const y = Math.max(...live.map((board) => board.y + board.height)) + ROW_GAP;

  return report.snapshots.map((snapshot) => {
    const board = { snapshot, x, y, width: snapshot.width, height: snapshot.imageHeight };
    x += snapshot.width + BOARD_GAP;

    return board;
  });
}

export function AuditBoards({ boards, report, camera, selected, ignored, onSelect }: {
  boards: SnapshotBoard[]; report: AuditReport; camera: Camera; selected: string | null; ignored: ReadonlySet<string>;
  onSelect: (finding: AuditFinding) => void;
}) {
  const zoom = camera.zoom;
  const visible = report.findings.filter((finding) => !ignored.has(finding.id));

  return <>{boards.map(({ snapshot, x, y, width, height }) => {
    const markers = visible.flatMap((finding) => finding.markers.filter((marker) => marker.profileId === snapshot.profileId).map((marker) => ({ finding, marker, index: report.findings.indexOf(finding) + 1 })));
    const issues = new Set(markers.map((item) => item.finding.id)).size + visible.filter((finding) => !finding.markers.length && finding.profiles.includes(snapshot.profileId)).length;

    return <section key={snapshot.profileId} className="artboard snapshot-board" data-profile-id={snapshot.profileId} aria-label={`${snapshot.label} snapshot, ${issues} findings`}
      style={{ left: camera.x + x * zoom, top: camera.y + y * zoom, width: width * zoom }}>
      <header className="artboard-header snapshot-header">
        <div className="snapshot-title">
          <strong>{snapshot.label}</strong>
          <span>{snapshot.width} × {snapshot.height}{snapshot.note ? ` · ${snapshot.note}` : ""}</span>
        </div>
        <span className="snapshot-count" data-clean={issues === 0 || undefined}>{issues === 0 ? "Clean" : `${issues} ${issues === 1 ? "issue" : "issues"}`}</span>
      </header>
      <div className="snapshot-surface" style={{ width: width * zoom, height: height * zoom }}>
        <img src={snapshot.image} alt={`${snapshot.label} at ${snapshot.width} by ${snapshot.height}`} draggable={false} style={{ width: width * zoom, height: height * zoom }} />
        {snapshot.imageHeight > snapshot.height && <div className="snapshot-fold" style={{ top: snapshot.height * zoom }} aria-hidden="true"><span>Viewport fold</span></div>}
        {markers.map(({ finding, marker, index }) => {
          const left = Math.max(0, marker.rect.x) * zoom;
          const top = Math.max(0, marker.rect.y) * zoom;
          const boxWidth = Math.max(8, Math.min(marker.rect.width, width - Math.max(0, marker.rect.x) + 40)) * zoom;
          const boxHeight = Math.max(8, Math.min(marker.rect.height, height - Math.max(0, marker.rect.y))) * zoom;

          return <button key={`${finding.id}-${snapshot.profileId}`} type="button" className="finding-marker" data-severity={finding.severity} data-classification={finding.classification} data-selected={selected === finding.id || undefined}
            aria-label={`Finding ${index}: ${finding.title}`} title={`${index}. ${finding.title}`} style={{ left, top, width: boxWidth, height: boxHeight }} onClick={(event) => { event.stopPropagation(); onSelect(finding); }}>
            <span>{index}</span>
          </button>;
        })}
      </div>
    </section>;
  })}</>;
}
