import os from "node:os";
import path from "node:path";
import { JournalStore } from "../src/infrastructure/instrumentation/journal";
import {
  applyIntegration,
  cleanupIntegration,
  createIntegrationPlan,
  prepareIntegrationPlan,
  transactionIdFor,
} from "../src/infrastructure/instrumentation/plan";

const action = process.argv[2];
if (!new Set(["apply", "clean", "recover"]).has(action)) {
  throw new Error("Usage: tsx scripts/instrument.ts <apply|clean|recover>");
}

const stateDirectory = process.env.MAUXI_STATE_DIR ?? path.join(os.homedir(), ".config", "Mauxi", "recovery");
const store = new JournalStore(stateDirectory);
const targets = [
  { root: "fixtures/vite", framework: "vite" as const },
  { root: "fixtures/next", framework: "next" as const },
];

for (const target of targets) {
  const plan = action === "apply"
    ? await prepareIntegrationPlan(target.root, target.framework)
    : createIntegrationPlan(target.root, target.framework);
  const id = transactionIdFor(plan);
  const result = action === "apply"
    ? await applyIntegration(plan, store)
    : await cleanupIntegration(id, store);
  console.log(`${plan.framework}: ${result.state} (${store.pathFor(id)})`);
  if (result.conflicts.length) {
    for (const conflict of result.conflicts) console.error(`  conflict: ${conflict}`);
    process.exitCode = 2;
  }
}
