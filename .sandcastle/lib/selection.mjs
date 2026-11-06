// Which open tickets a run starts, decided by rules rather than by a model.
//
// The planner model used to do this, reading every open ticket's whole body on
// each iteration: ~211k tokens on 2026-10-30, to produce a list that the tracker's
// own fields already determine. Each rule below is one the planner prompt stated:
//
//   - `tracker list` has already dropped closed, unlabelled and parked tickets
//   - a ticket whose `blockedByOpen` is not empty waits
//   - `Repo` names exactly one project (AGENTS.md: one repo per ticket); an
//     operational ticket and one naming two repos are held, with the reason
//   - the branch is `sandcastle/issue-<id>`, id verbatim, so a re-run resumes it
//
// Two rules are new:
//
//   - a ticket runs only when its project's checkout is on its effort's branch.
//     Sandcastle cuts the ticket branch from that checkout and merges back into
//     it, so an hp-2 ticket picked up while the checkout sat on
//     feat/hp-1-order-intake would land in hp-1's branch. On `main` nothing runs, since nothing may be committed there; the
//     runner moves such a checkout to the effort's branch (lib/effort-branch.mjs),
//     and the hold names the project and branch so it can find the tickets.
//   - a ticket is attempted at most once per invocation, so a failure does not
//     buy the same work again on the next iteration.
//
// File overlap between two ready tickets no longer holds one back. The planner
// itself let it through as a "known cost", and a real conflict now goes to a
// resolver on the ticket's own branch.

/** The id's branch. Fixed: a different spelling would orphan the earlier run's work. */
export const branchFor = (id) => `sandcastle/issue-${id}`;

/**
 * The one project a `Repo` / `Repos` field names, or why there is not one.
 *
 * `projects` maps each project name to its `aliases`. A token counts when it is a
 * project name or an alias, after the markdown and a leading `../` are stripped
 * and anything after the first path separator is dropped.
 */
export function resolveProject(repos, projects) {
  if (!repos) return { reason: "no Repo field" };

  const vocabulary = new Map();
  for (const [name, { aliases }] of Object.entries(projects)) {
    vocabulary.set(name.toLowerCase(), name);
    for (const alias of aliases) vocabulary.set(alias.toLowerCase(), name);
  }

  const named = new Set();
  for (const raw of repos.split(/[\s,;`*()[\]]+/)) {
    const token = raw.toLowerCase().replace(/^(\.\.\/)+/, "");
    const project = vocabulary.get(token) ?? vocabulary.get(token.split("/")[0]);
    if (project) named.add(project);
  }

  if (named.size === 1) return { project: [...named][0] };
  if (named.size > 1) {
    return { reason: `Repo names ${[...named].join(" and ")}; one ticket per repo` };
  }
  if (/n\/a|operational/i.test(repos)) return { reason: "operational: a human's to do" };
  return { reason: `Repo "${repos}" names no project this runner knows` };
}

/**
 * Whether a checkout on `branch` is the place for `map`'s work.
 *
 * Effort branches are `<type>/<key>-<slug>`, the slug matching the effort
 * directory (AGENTS.md, "Branches"), and the key a prefix and a number: `hp-1`
 * here, `abc-123` where efforts are named for a tracker's ticket key. The key is what is
 * matched, so a branch whose slug was shortened still counts.
 */
export function effortMatchesBranch(map, branch) {
  if (!branch || /^(main|master)$/.test(branch)) return false;
  const key = map.match(/^[a-z]+-\d+/i)?.[0];
  const needle = (key ?? map).toLowerCase();
  return new RegExp(`(^|[/_-])${needle}($|[/_-])`).test(branch.toLowerCase());
}

/**
 * Why the workspace root holds every ticket, or null when it may take their
 * closes. The root is where `tracker` reads the tickets and where `close` commits,
 * so it must be on the branch of every effort that runs, as a project checkout
 * must. On `main`, or detached, it is not judged here: the runner moves it first.
 * (A root on another effort's branch would take this run's closes.)
 */
export function rootHoldReason(rootBranch, maps) {
  if (!rootBranch || /^(main|master)$/.test(rootBranch)) return null;
  const others = [...maps].filter((map) => !effortMatchesBranch(map, rootBranch)).sort();
  if (others.length === 0) return null;
  return (
    `is on ${rootBranch}, not the branch of ${others.join(", ")}: its tickets would be read ` +
    `from there and closed there; switch it to docs/<effort>, or run with --map <effort>`
  );
}

/**
 * Splits `tracker list`'s tickets into those to start now and those held, each
 * held one with its reason. A ticket held only because its project's checkout is
 * not on its effort's branch also carries `project`, and `checkout`, the branch
 * that checkout is on (null when detached or absent).
 *
 * `checkoutBranch(project)` is the branch the project's checkout is on (null when
 * detached or absent); `attempted` holds the ids this invocation already ran.
 */
export function selectTickets(issues, { projects, checkoutBranch, attempted }) {
  const ready = [];
  const held = [];

  for (const issue of issues) {
    const hold = (reason, extra = {}) => held.push({ id: issue.id, map: issue.map, reason, ...extra });

    if (attempted.has(issue.id)) {
      hold("already attempted in this run");
      continue;
    }
    if (issue.blockedByOpen?.length > 0) {
      hold(`blocked by ${issue.blockedByOpen.join(", ")} (still open)`);
      continue;
    }
    const resolved = resolveProject(issue.repos, projects);
    if (!resolved.project) {
      hold(resolved.reason);
      continue;
    }
    const base = checkoutBranch(resolved.project);
    if (!effortMatchesBranch(issue.map, base)) {
      hold(
        `${resolved.project} is on ${base ?? "no branch"}, not ${issue.map}'s branch; ` +
          `switch it to the effort's branch to run this ticket`,
        { project: resolved.project, checkout: base },
      );
      continue;
    }

    ready.push({
      id: issue.id,
      title: issue.title,
      map: issue.map,
      project: resolved.project,
      base,
      branch: branchFor(issue.id),
    });
  }

  return { ready, held };
}
