import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InboxRunProgress, InboxRunProvider } from "./inbox-run";

vi.mock("@/server/inbox/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function render(going: boolean, canStop: boolean): string {
  return renderToStaticMarkup(
    <InboxRunProvider>
      <InboxRunProgress going={going} canStop={canStop} />
    </InboxRunProvider>,
  );
}

describe("InboxRunProgress, Run all on the server", () => {
  it("says Run all is going and goes on without this tab, with Stop for an admin", () => {
    const html = render(true, true);

    expect(html).toContain("Run all is going: the agent reads one email after another, even with this tab closed.");
    expect(html).toContain(">Stop</button>");
  });

  it("offers no Stop to a reviewer", () => {
    expect(render(true, false)).not.toContain(">Stop</button>");
  });

  it("shows nothing while no run is going and nothing has been said", () => {
    const html = render(false, true);

    expect(html).toContain("hidden");
    expect(html).not.toContain("Run all is going");
  });
});
