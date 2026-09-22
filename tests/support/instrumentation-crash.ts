// A disposable child process, never loaded by the application. Kill at durable
// journal boundaries, including after a mutation but before its flag is saved.
import { JournalStore, type InstrumentationJournal } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, prepareIntegrationPlan, transactionIdFor } from "../../src/infrastructure/instrumentation/plan";

const [root, directory, bridge, framework, operation, boundary, when] = process.argv.slice(2);
class CrashStore extends JournalStore {
  writes = 0;
  override async write(journal: InstrumentationJournal) {
    this.writes++;
    if (this.writes === Number(boundary) && when === "before") process.kill(process.pid, "SIGKILL");
    await super.write(journal);
    if (this.writes === Number(boundary) && when === "after") process.kill(process.pid, "SIGKILL");
  }
}
const plan = await prepareIntegrationPlan(root, framework as "vite" | "next").catch(() => undefined);
const store = new CrashStore(directory);
if (operation === "apply") {
  if (!plan) throw new Error("No disposable integration plan");
  await applyIntegration(plan, store, bridge);
} else {
  const journal = (await store.list())[0];
  await cleanupIntegration(journal?.transactionId ?? transactionIdFor(plan!), store);
}
// If this exits normally, the parent selected a nonexistent boundary and fails.
