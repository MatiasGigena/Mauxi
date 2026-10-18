const plans = [
  { name: "Taster", price: "$18", detail: "One 250 g bag a month" },
  { name: "Daily", price: "$32", detail: "Two 340 g bags a month" },
  { name: "Office", price: "$96", detail: "Four 1 kg bags a month" },
];

export function PricingTable() {
  return (
    <div className="pricing" data-testid="pricing-table">
      {plans.map((plan) => <article className="plan" key={plan.name}><h3>{plan.name}</h3><p className="plan-price">{plan.price}</p><p>{plan.detail}</p><button type="button">Choose {plan.name}</button></article>)}
    </div>
  );
}
