# Issue tracker: local markdown under `grilled/`

Maps, decision tickets and implementation tickets live as markdown files under `grilled/`. There is
no CLI to log into, no token, and no network call: the notes are files in this repository.

## Layout

```text
grilled/
└── hp-1-order-intake/
    ├── map.md                  ← the map (/wayfinder), labelled wayfinder:map
    ├── README.md               ← the frontier: what is takeable now
    ├── assets/                 ← screenshots, sample outputs, research findings
    ├── issues/01-…md …         ← decision tickets (/wayfinder), no label
    └── tickets/
        ├── 00-README.md        ← the slice order
        └── 01-…md …            ← implementation tickets (/to-tickets), Label: sandcastle
```

- One effort per directory, `grilled/<identifier>/`, the identifier being `hp-<n>-<slug>`.
- **The map** is `grilled/<identifier>/map.md`, or a sibling `grilled/<identifier>.md`.
- **Tasks live only in `issues/` and `tickets/`**, the tracker's `TASK_DIRS`. A markdown file
  anywhere else under an effort is map material. `README.md`, `00-README.md` and `index.md` are
  excluded by name.
- Files are numbered from `01`, one ticket per file.
- **A task's id is its filename without `.md`** (e.g. `03-draft-order-tool`), which makes the
  `sandcastle/issue-<id>` branch name deterministic. On a collision the id is qualified as
  `<map>/<file>`.

| Directory | Written by | Holds | `Label` |
| --- | --- | --- | --- |
| `grilled/<identifier>/` | `/wayfinder` | the map, the `README.md` frontier, assets | `wayfinder:map` on the map |
| `grilled/<identifier>/issues/` | `/wayfinder` | decision tickets: research, grilling, prototype, task | none |
| `grilled/<identifier>/tickets/` | `/to-tickets` | implementation tickets, tracer-bullet vertical slices | `sandcastle` |

## Assets

`grilled/<identifier>/assets/` holds what an effort was shown or produced. **Name the file for what
it shows** (`E017-forwarded-thread-two-customers.png`, not `1.png`), and **link it from the thing
that rests on it** with a relative path: `assets/…` from a map, `../assets/…` from `issues/` or
`tickets/`.

## Ticket fields

The bold header form:

```markdown
# 03 — Draft-order tool

**What to build:** …

**Repo:** harbor-point

**Blocked by:** 01, 02 — [the ERP schema](01-erp-schema.md)

**Label:** sandcastle

**Status:** ready-for-agent
```

- **`Status`**: the first word decides state. `closed` / `done` / `resolved` / `☑` / `✅` / `x` are
  closed. `◐` / `awaiting` / `on hold` / `paused` / `needs human` mean *open but parked on a
  human*, kept out of `list`. Everything else is open. Stamp every write to a `Status` line with
  `date '+%Y-%m-%d %H:%M %Z'`, run at that moment: an agent has no clock of its own.
- **`Blocked by`**: only a comma-separated segment that *opens with a number* counts. A markdown
  link alone registers nothing, and the ticket then reads as unblocked. Put the bare number first.
- **`Repo`**: `harbor-point` for any change to this repository; `n/a — operational` for an action
  outside it (a dashboard setting, a secret), which sandcastle holds for a human.
- **`Type`** (decision tickets): `research` / `prototype` / `grilling` / `task`.
- **`Label`**: comma-separated; `sandcastle` is the one the tooling reads, and only `/to-tickets`
  writes it.

## Commands

All go through [`tracker.mjs`](../../.sandcastle/tracker.mjs) (plain Node, zero deps), run from the
repository root:

| Action | Command |
| --- | --- |
| list open tasks as JSON | `node .sandcastle/tracker.mjs list` |
| the same backlog as a table | `npm run sandcastle:list` |
| either list, for one effort | add `--map <effort>`, e.g. `npm run sandcastle:list -- --map hp-1-order-intake` |
| view one task | `node .sandcastle/tracker.mjs view <ID>` |
| close one task | `node .sandcastle/tracker.mjs close <ID>` |

JSON is the default because [`main.mts`](../../.sandcastle/main.mts) parses `list`'s stdout.
`close` rewrites the `Status` line in the file's own convention, then commits that one file. It is
idempotent.

## When a skill says "publish to the issue tracker"

Create a new file with the next free `NN-` number and the field block above. **The skill that is
asking decides the directory**: `/wayfinder` writes to `grilled/<identifier>/issues/`, `/to-tickets`
to `grilled/<identifier>/tickets/` with `**Label:** sandcastle`. The skills' own docs say
`.scratch/<feature-slug>/issues/`; that is their default for a repo with no tracker, and this repo
has one, so `grilled/` wins.

## When a skill says "fetch the relevant ticket"

Read the file directly, or run `node .sandcastle/tracker.mjs view <ID>`.

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: `grilled/<identifier>/map.md`, with the Notes / Decisions-so-far / Fog body, labelled
  `wayfinder:map`, linking the brief's section it serves.
- **Frontier**: `grilled/<identifier>/README.md` lists what is takeable now.
- **Child ticket**: `grilled/<identifier>/issues/NN-<slug>.md`, with the question in the body.
- **Blocking**: a `Blocked by: NN, NN` line. A ticket is unblocked when every file it lists is
  closed.
- **Claim**: set `Status:` to a claimed state, with who and the stamp, before any work.
- **Resolve**: append the answer under `## Answer`, set `Status:` to closed with the stamp, then add
  a gist and a link to the map's Decisions-so-far.
