"use client";

import { useState } from "react";
import styles from "./audit-lab.module.css";

const plans = [
  { name: "Taster", price: "$18", detail: "One 250 g bag a month" },
  { name: "Daily", price: "$32", detail: "Two 340 g bags a month" },
  { name: "Office", price: "$96", detail: "Four 1 kg bags a month" },
];

export function PricingTable() {
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <div className={styles.pricing} data-testid="pricing-table">
      {plans.map((plan) => <article className={styles.plan} key={plan.name}><h3>{plan.name}</h3><p className={styles["plan-price"]}>{plan.price}</p><p>{plan.detail}</p><button type="button" aria-pressed={chosen === plan.name} onClick={() => setChosen(plan.name)}>Choose {plan.name}</button></article>)}
    </div>
  );
}
