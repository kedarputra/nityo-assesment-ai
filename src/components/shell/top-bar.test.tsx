import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentPresence } from "@/server/desk/presence";
import { InboxRunProvider } from "../inbox-run";
import { SkipLink } from "../site-header";
import { ShellProvider } from "./shell-state";
import { TopBar } from "./top-bar";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/inbox/actions", () => ({}));

const idle: AgentPresence = {
  state: "idle",
  modelId: "gemini-3.5-flash-lite",
  reading: [],
  runAll: null,
  schedule: { enabled: false, intervalMinutes: 15, nextRunAt: null, configured: false },
};

function render(role: "reviewer" | "admin", presence: AgentPresence = idle): string {
  return renderToStaticMarkup(
    <InboxRunProvider>
      <ShellProvider>
        <TopBar user={{ id: 1, username: `ops.${role}`, role }} presence={presence} />
      </ShellProvider>
    </InboxRunProvider>,
  );
}

describe("TopBar", () => {
  it("searches everything from one box, by keyword or by meaning", () => {
    const html = render("reviewer");

    expect(html).toMatch(/<form class="global-search" action="\/search" role="search">/);
    expect(html).toContain('placeholder="Search emails, customers, products, orders"');
    expect(html).toContain('<option value="meaning">By meaning</option>');
  });

  it("shows the agent's presence as a dot and a word, with how many emails it is reading", () => {
    expect(render("reviewer")).toMatch(/presence-dot--idle.*Idle/);
    const active = render("reviewer", {
      ...idle,
      state: "active",
      reading: [{ emailId: "E001", fromName: "Maria Lopez", subject: "Order", startedAt: new Date() }],
    });
    expect(active).toMatch(/presence-dot--active.*Active · 1 reading/);
  });

  it("offers an admin Run all and Reset in the account menu, and a reviewer neither", () => {
    const admin = render("admin");
    expect(admin).toContain(">Run all</button>");
    expect(admin).toContain(">Reset to 07:00…</button>");

    const reviewer = render("reviewer");
    expect(reviewer).not.toContain("Run all");
    expect(reviewer).toContain("Sign out");
  });

  it("offers Stop instead of Run all while a run is going", () => {
    const html = render("admin", { ...idle, state: "active", runAll: { trigger: "person", selected: null } });

    expect(html).toContain(">Stop the run</button>");
    expect(html).not.toContain(">Run all</button>");
  });
});

describe("SkipLink", () => {
  it("jumps to the main content", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toBe('<a class="skip" href="#main">Skip to content</a>');
  });
});
