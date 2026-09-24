import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffLines } from "../../src/presentation/IntegrationChanges";
import { ProjectSetup, integrationSummary } from "../../src/presentation/ProjectSetup";
import { discovery } from "../setup-e2e/fixtures";

describe("project setup", () => {
  it("renders real file counts rather than the prototype's fixed four files", () => {
    const data = discovery();
    expect(integrationSummary(data.plans[0])).toContain("1 file modified, 3 artifacts created");
    expect(integrationSummary(data.plans[1])).toContain("1 artifact created");
    expect(integrationSummary({ ...data.plans[0], integration: { supported: true, summary: "", files: [] } })).toBe("No file changes required.");
  });
  it("colors additions/removals without treating diff headers as changes, and escapes markup", () => {
    const html = renderToStaticMarkup(<DiffLines diff={"--- before\n+++ after\n unchanged\n- <script>\n+ <new>"} />);
    expect(html).toContain('class="diff-line removed">- &lt;script&gt;');
    expect(html).toContain('class="diff-line added">+ &lt;new&gt;');
    expect(html.match(/diff-line context/g)).toHaveLength(3);
    expect(html).not.toContain("<script>");
  });
  it("shows real command/path/diagnostics with no prototype picker or upload input", () => {
    const data = discovery();
    const plan = data.plans[1];
    plan.diagnostics = [{ level: "error", code: "blocked", message: "Server cannot be started." }];
    const html = renderToStaticMarkup(<ProjectSetup discovery={data} plan={plan} busy={false} onSelectPlan={() => {}} onChooseProject={() => {}} onConfirm={() => {}} />);
    expect(html).toContain("pnpm run start");
    expect(html).toContain("/projects/rondo/storefront");
    expect(html).toContain("Server cannot be started.");
    expect(html).toContain('class="primary" disabled=""');
    expect(html).not.toMatch(/proto-picker|webkitdirectory|type="file"|PROJECT READY/);
  });
});
