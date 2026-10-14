import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScriptSelect } from "../../src/presentation/ScriptSelect";
import { discovery } from "../setup-e2e/fixtures";

const callbacks = { onChange: () => {}, onOpenChange: () => {} };

describe("inline script selector", () => {
  it("renders a named command-only control instead of a native select", () => {
    const plans = discovery().plans;
    const html = renderToStaticMarkup(<ScriptSelect plans={plans} value={plans[0].id} open={false} keyboard={false} disabled={false} {...callbacks} />);
    expect(html).toContain("Application and script");
    expect(html).toContain("npm run dev");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("rondo");
    expect(html).not.toContain('role="listbox"');
  });
  it("keeps duplicate command identities and root context without displaying project names", () => {
    const first = discovery().plans[0];
    const second = { ...first, id: "second", appRoot: "/projects/another" };
    const html = renderToStaticMarkup(<ScriptSelect plans={[first, second]} value="second" open keyboard disabled={false} {...callbacks} />);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="npm run dev (/projects/another)"');
    expect(html.match(/<code>npm run dev<\/code>/g)).toHaveLength(2);
    expect(html).not.toContain("rondo — dev");
  });
  it("does not expose a menu while disabled or when its selection is missing", () => {
    const plans = discovery().plans;

    for (const props of [{ value: plans[0].id, disabled: true }, { value: "missing", disabled: false }]) {
      const html = renderToStaticMarkup(<ScriptSelect plans={plans} open keyboard={false} {...props} {...callbacks} />);
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('role="listbox"');
    }
  });
});
