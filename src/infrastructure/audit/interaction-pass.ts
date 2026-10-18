import type { AuditProfile } from "../../application/audit-contract";
import { INTERACTION_LIMITS, type InteractionIssue, type InteractionRequest, type InteractionResult, type InteractionRun } from "../../application/audit-interactions";

type Point = { x: number; y: number };

/** What the pass needs from the audit window; every call goes through CDP on the offscreen page. */
export interface InteractionDriver {
  step(request: InteractionRequest): Promise<InteractionResult>;
  press(key: "Tab" | "Escape"): Promise<void>;
  click(point: Point): Promise<void>;
  hover(point: Point): Promise<void>;
  /** Waits for layout: one animation frame when ms is 0, otherwise two frames and then the delay. */
  settle(ms: number): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  capture(): Promise<string>;
  /** Navigations of the audit window blocked since the pass started. */
  blockedNavigations(): number;
}

/**
 * Bounded, deterministic interaction pass: a Tab-only keyboard focus walk, then opening closed disclosures, then
 * hovering tooltips. Failures become notes; only an aborted audit propagates.
 */
export async function runInteractionPass(driver: InteractionDriver, profiles: readonly AuditProfile[], signal: AbortSignal, onProfile: (profile: AuditProfile) => void): Promise<InteractionRun> {
  const started = Date.now();
  const run: InteractionRun = { durationMs: 0, profiles: [], focusStops: 0, disclosures: 0, hovers: 0, notes: [], samples: [], snapshots: [] };
  const over = () => Date.now() - started > INTERACTION_LIMITS.budgetMs;

  const note = (text: string) => { if (run.notes.length < 24 && !run.notes.includes(text)) run.notes.push(text.slice(0, 300)); };

  const snapshot = async (profile: AuditProfile, id: string, label: string, detail: string) => {
    const image = await driver.capture();
    run.snapshots = [...run.snapshots.filter((item) => item.profileId !== id), { profileId: id, label, note: detail, width: profile.width, height: profile.height, imageHeight: profile.height, image }];
    run.samples = run.samples.map((sample) => sample.snapshotId === id ? { ...sample, snapshotId: null } : sample);

    return id;
  };

  const record = (profile: AuditProfile, issue: InteractionIssue, snapshotId: string | null) => { run.samples.push({ profileId: profile.id, width: profile.width, height: profile.height, issue, snapshotId }); };

  const focusWalk = async (profile: AuditProfile) => {
    const start = await driver.step({ action: "focus-start" });

    if (!start.count) { note(`No focusable elements at ${profile.label}.`);

 return; }

    let captured: "full" | "partial" | null = null;
    let recorded = 0;
    let stops = 0;

    for (let index = 0; index < INTERACTION_LIMITS.focusStops; index++) {
      if (over()) { note("The interaction time budget ran out during the keyboard focus walk."); break; }

      await driver.press("Tab");
      await driver.settle(0);
      const result = await driver.step({ action: "focus-measure" });

      if (result.done) {
        if (!stops || result.reason === "focus entered an iframe") note(`Keyboard focus walk at ${profile.label} stopped after ${stops} stops: ${result.reason ?? "no focus"}.`);
        break;
      }

      stops++;

      if (stops === INTERACTION_LIMITS.focusStops) note(`Keyboard focus walk at ${profile.label} stopped at the ${INTERACTION_LIMITS.focusStops}-stop limit.`);

      for (const issue of result.issues ?? []) {
        if (recorded >= INTERACTION_LIMITS.issuesPerWalk) break;
        recorded++;
        const better = issue.kind === "focus-obscured" && (!captured || (captured === "partial" && issue.variant === "full"));

        if (better) captured = issue.variant === "full" ? "full" : "partial";
        record(profile, issue, better ? await snapshot(profile, `focus-${profile.id}`, `Focus · ${profile.label}`, `Tab stop ${stops}: ${issue.element.label}`.slice(0, 120)) : null);
      }
    }

    run.focusStops += stops;
  };

  /** Opens each closed disclosure, measures it and closes it again. Returns false when the page could not be restored. */
  const disclosures = async (profile: AuditProfile): Promise<boolean> => {
    const list = await driver.step({ action: "disclosure-list" });

    for (const skipped of list.skipped ?? []) note(`Not activated: ${skipped}.`);
    let captured = false;

    for (let index = 0; index < (list.count ?? 0); index++) {
      if (over()) { note("The interaction time budget ran out during the disclosure pass.");

 return true; }

      const target = await driver.step({ action: "disclosure-target", index });

      if (!target.point) { note(`Did not open ${target.label ?? "a disclosure"} at ${profile.label}: ${target.reason}.`); continue; }

      const blocked = driver.blockedNavigations();
      await driver.click(target.point);
      await driver.settle(120);
      const measured = await driver.step({ action: "disclosure-measure", index });
      const navigated = measured.urlChanged || driver.blockedNavigations() > blocked;

      if (measured.opened) run.disclosures++;
      else if (!navigated) note(`${target.label} at ${profile.label}: ${measured.reason}.`);

      for (const issue of measured.issues ?? []) {
        record(profile, issue, captured ? null : await snapshot(profile, `menu-${profile.id}`, `Menu open · ${profile.label}`, `${target.label}`.slice(0, 120)));
        captured = true;
      }

      if (navigated) {
        note(`Activating ${target.label} tried to change the page URL; it was blocked or reverted and the remaining interaction checks were skipped.`);
        await driver.step({ action: "disclosure-force-close", index });
        await driver.settle(250);

        return false;
      }

      if (measured.point) await driver.click(measured.point); else await driver.press("Escape");
      await driver.settle(120);
      let check = await driver.step({ action: "disclosure-check", index });

      if (!check.restored && !check.urlChanged && measured.point) {
        await driver.press("Escape");
        await driver.settle(120);
        check = await driver.step({ action: "disclosure-check", index });
      }

      if (!check.restored) check = await driver.step({ action: "disclosure-force-close", index });

      if (!check.restored || check.urlChanged) { note(`Could not return ${target.label} to its initial state at ${profile.label}; the remaining interaction checks were skipped.`);

 return false; }
    }

    return true;
  };

  const hovers = async (profile: AuditProfile) => {
    const list = await driver.step({ action: "hover-list" });
    let captured = false;

    for (let index = 0; index < Math.min(list.count ?? 0, INTERACTION_LIMITS.hovers); index++) {
      if (over()) { note("The interaction time budget ran out during the hover pass.");

 return; }

      const target = await driver.step({ action: "hover-target", index });

      if (!target.point) { note(`Did not hover ${target.label ?? "a tooltip trigger"} at ${profile.label}: ${target.reason}.`); continue; }

      await driver.hover(target.point);
      await driver.settle(120);
      const measured = await driver.step({ action: "hover-measure", index });

      if (!measured.opened) { note(`${target.label} at ${profile.label}: ${measured.reason}.`); continue; }

      run.hovers++;

      for (const issue of measured.issues ?? []) {
        record(profile, issue, captured ? null : await snapshot(profile, `hover-${profile.id}`, `Hover · ${profile.label}`, `${target.label}`.slice(0, 120)));
        captured = true;
      }

      if (!measured.point) continue;
      await driver.hover(measured.point);
      await driver.settle(120);

      for (const issue of (await driver.step({ action: "hover-check", index })).issues ?? []) record(profile, issue, null);
    }

    await driver.hover({ x: 0, y: 0 });
  };

  let intact = true;

  for (const [position, profile] of profiles.entries()) {
    if (!intact) break;

    if (over()) { note("The interaction time budget ran out; remaining profiles were skipped."); break; }

    onProfile(profile);
    run.profiles.push(profile.id);

    try {
      await driver.resize(profile.width, profile.height);
      await focusWalk(profile);
      await driver.step({ action: "cleanup" });
      intact = await disclosures(profile);

      if (intact && position === profiles.length - 1) await hovers(profile);
    } catch (error) {
      if (signal.aborted) throw error;
      note(`Interaction checks at ${profile.label} stopped: ${error instanceof Error ? error.message : String(error)}`);
    }

    try { await driver.step({ action: "cleanup" }); } catch (error) { if (signal.aborted) throw error; }
  }

  run.durationMs = Date.now() - started;

  return run;
}
