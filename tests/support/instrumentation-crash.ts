import path from "node:path";
import { JournalStore, type InstrumentationJournal } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, prepareIntegrationPlan, transactionIdFor } from "../../src/infrastructure/instrumentation/plan";

const [root, directory, bridge, framework, operation, boundary, when, ownedSession] = process.argv.slice(2);
class CrashStore extends JournalStore {
  writes = 0;
  override async write(journal: InstrumentationJournal) {
    this.writes++;
    const matches = this.writes === Number(boundary)
      || (boundary.startsWith("patch-written:") && journal.patches.some(patch => patch.applied && path.basename(patch.path) === boundary.slice("patch-written:".length)))
      || (boundary.startsWith("patch-cleaned:") && journal.patches.some(patch => patch.cleaned && patch.cleanupAfterHash !== undefined && path.basename(patch.path) === boundary.slice("patch-cleaned:".length)));
    if (matches && when === "before") process.kill(process.pid, "SIGKILL");
    await super.write(journal);
    if (matches && when === "after") process.kill(process.pid, "SIGKILL");
  }
}
const plan = await prepareIntegrationPlan(root, framework as "vite" | "next", ownedSession === "owned").catch(() => undefined);
const store = new CrashStore(directory);
if (operation === "apply") {
  if (!plan) throw new Error("No disposable integration plan");
  await applyIntegration(plan, store, bridge);
} else {
  const journal = (await store.list())[0];
  await cleanupIntegration(journal?.transactionId ?? transactionIdFor(plan!), store);
}
