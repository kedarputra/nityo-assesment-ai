import assert from "node:assert/strict";
import { test } from "node:test";
import { effortMatchesBranch, resolveProject, rootHoldReason, selectTickets } from "../lib/selection.mjs";

const PROJECTS = {
  "backend": { aliases: ["be", "backend", "api"] },
  "frontend": { aliases: ["web", "frontend"] },
  "devops": { aliases: ["devops"] },
};

test("resolveProject reads the spellings the notes use", () => {
  assert.deepEqual(resolveProject("`backend`", PROJECTS), { project: "backend" });
  assert.deepEqual(resolveProject("`../frontend`", PROJECTS), { project: "frontend" });
  assert.deepEqual(resolveProject("web", PROJECTS), { project: "frontend" });
  assert.deepEqual(resolveProject("frontend/src/app (frontend)", PROJECTS), {
    project: "frontend",
  });
});

test("resolveProject holds a ticket naming two repos, none, or an operational step", () => {
  assert.match(resolveProject("`backend`, `../frontend`", PROJECTS).reason, /one ticket per repo/);
  assert.match(resolveProject("n/a — operational", PROJECTS).reason, /operational/);
  assert.match(resolveProject("somewhere-else", PROJECTS).reason, /names no project/);
  assert.match(resolveProject(null, PROJECTS).reason, /no Repo field/);
});

test("effortMatchesBranch matches on the Jira key, never on main", () => {
  assert.equal(effortMatchesBranch("hp-15-order-intake", "feat/hp-15-order-intake"), true);
  assert.equal(effortMatchesBranch("hp-15-order-intake", "feat/hp-15-intake"), true);
  assert.equal(effortMatchesBranch("hp-16-review-ui", "feat/hp-15-order-intake"), false);
  assert.equal(effortMatchesBranch("hp-1-short", "feat/hp-15-order-intake"), false);
  assert.equal(effortMatchesBranch("hp-15-x", "main"), false);
  assert.equal(effortMatchesBranch("hp-15-x", null), false);
  assert.equal(effortMatchesBranch("hp-1-order-intake", "feat/hp-1-intake"), true);
  assert.equal(effortMatchesBranch("hp-1-order-intake", "feat/hp-12-review-ui"), false);
});

test("selectTickets starts only unblocked, routable tickets on their effort's branch, once", () => {
  const issue = (id, fields) => ({
    id,
    title: id,
    map: "hp-15-order-intake",
    repos: "`backend`",
    blockedByOpen: [],
    ...fields,
  });
  const issues = [
    issue("01-ready"),
    issue("02-blocked", { blockedByOpen: ["01"] }),
    issue("03-two-repos", { repos: "`backend`, `../frontend`" }),
    issue("04-other-effort", { map: "hp-16-review-ui" }),
    issue("05-web-on-main", { repos: "`../frontend`" }),
    issue("06-done-earlier"),
    issue("07-shared/name", { map: "hp-15-order-intake" }),
  ];
  const branches = {
    "backend": "feat/hp-15-order-intake",
    "frontend": "main",
  };

  const { ready, held } = selectTickets(issues, {
    projects: PROJECTS,
    checkoutBranch: (project) => branches[project] ?? null,
    attempted: new Set(["06-done-earlier"]),
  });

  assert.deepEqual(
    ready.map((t) => [t.id, t.project, t.base, t.branch]),
    [
      ["01-ready", "backend", "feat/hp-15-order-intake", "sandcastle/issue-01-ready"],
      ["07-shared/name", "backend", "feat/hp-15-order-intake", "sandcastle/issue-07-shared/name"],
    ],
  );
  const reasons = Object.fromEntries(held.map((h) => [h.id, h.reason]));
  assert.match(reasons["02-blocked"], /blocked by 01/);
  assert.match(reasons["03-two-repos"], /one ticket per repo/);
  assert.match(reasons["04-other-effort"], /not hp-16-review-ui's branch/);
  assert.match(reasons["05-web-on-main"], /frontend is on main/);
  assert.match(reasons["06-done-earlier"], /already attempted/);

  // Only a ticket held for want of its effort's branch says where it waits.
  const waiting = held.filter((h) => h.project).map((h) => [h.id, h.project, h.checkout]);
  assert.deepEqual(waiting, [
    ["04-other-effort", "backend", "feat/hp-15-order-intake"],
    ["05-web-on-main", "frontend", "main"],
  ]);
});

test("rootHoldReason: the root must be on the branch of every effort that runs", () => {
  assert.equal(rootHoldReason("main", ["hp-15-order-intake"]), null, "main is moved, not held");
  assert.equal(rootHoldReason(null, ["hp-15-order-intake"]), null, "detached is moved, not held");
  assert.equal(
    rootHoldReason("docs/hp-15-order-intake", ["hp-15-order-intake"]),
    null,
  );
  const reason = rootHoldReason("docs/hp-17-audit-trail", ["hp-15-order-intake"]);
  assert.match(reason, /is on docs\/hp-17-audit-trail, not the branch of hp-15/);
  assert.match(
    rootHoldReason("docs/hp-15-order-intake", ["hp-15-order-intake", "hp-17-x"]),
    /not the branch of hp-17-x/,
  );
});
