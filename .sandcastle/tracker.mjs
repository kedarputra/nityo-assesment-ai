#!/usr/bin/env node
// Local markdown issue tracker.
//
// The "tracker" for this workspace is the wayfinder notes under grilled/ — there
// is no Jira/GitHub CLI in the sandbox, and no auth. Tasks are markdown files in
// a map's `issues/` (or `tickets/`) directory:
//
//   grilled/hp-1-order-intake/tickets/03-draft-order-tool.md
//
// This is a monorepo root holding several projects, so notes are looked for at
// the root and one level down, in both the `grilled/` and legacy
// `.ai-notes/grilled/` layouts (see discoverNotesRoots). A task's id is its
// filename without `.md`. State is read from the `Status:` line, or from a
// `| **Status** | ... |` table row:
//
//   Status: **closed** — resolved 2026-11-06 14:05 WIB by kedar     -> closed
//   Status: open — **UNBLOCKED 2026-08-06 09:30 WIB**               -> open
//   | **Status** | ☑ Done |                                         -> closed
//
// `list` reports only files labelled `sandcastle` — see SANDCASTLE_LABEL.
//
// Usage:
//   node .sandcastle/tracker.mjs list          # open tasks as JSON (array)
//   node .sandcastle/tracker.mjs list --table  # the same backlog as a table, for a human
//   node .sandcastle/tracker.mjs list --map hp-1-order-intake  # only that effort's tasks
//   node .sandcastle/tracker.mjs view <ID>     # print one task + its parent map
//   node .sandcastle/tracker.mjs close <ID>    # flip Status to closed + commit
//
// JSON is the default because main.mts runs `list` and `JSON.parse`s its stdout;
// `--table` is the only mode that writes anything else there.
//
// `--map <identifier>` (repeatable, or comma-separated) limits either `list` to those
// efforts; without it, SANDCASTLE_MAPS does the same. See selectedMaps.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Directories inside a map that hold one file per task.
const TASK_DIRS = ["issues", "tickets"];

// A task is closed when its state word is one of these. Everything else — `open`,
// `☐`, `in progress`, `blocked` — is open and therefore work the agent may pick up.
const CLOSED_STATE = /^(closed|done|resolved|☑|✅|x)\b|^☑|^✅/;

// Open, but parked on a human — production access, a vendor credential, a decision
// someone else owns. `list` leaves these out: the runner relies on a list
// already filtered to work an agent can actually start.
const AWAITING_HUMAN_STATE = /^(◐|awaiting|on hold|paused|needs human|needs a human)/;

// The label that marks a file as sandcastle's work. `/to-tickets` writes it onto
// every implementation ticket under `tickets/`; `/wayfinder`'s decision notes under
// `issues/` carry no label, because a question to answer with a human is not a
// change to implement. `list` offers only labelled files, so handing sandcastle a
// grilling ticket is impossible rather than merely discouraged. Matched as one
// entry in a comma-separated `Label:` field, so a ticket may carry others.
const SANDCASTLE_LABEL = /(^|,)\s*sandcastle\s*(,|$)/i;

// Files in a task directory that are documentation, not tasks.
const NOT_A_TASK = new Set(["README.md", "readme.md", "index.md", "00-README.md"]);

// Directories never worth descending into when hunting for a project's notes.
const NOT_A_PROJECT = /^(\.|node_modules$)/;

// The two places a `grilled` directory is looked for, relative to a base.
//
// `grilled` is the live layout: the notes are committed at this workspace root.
// `.ai-notes/grilled` is where they sat when they belonged to a single project,
// and is still honoured so moving them back needs no code change.
const GRILLED_LAYOUTS = [["grilled"], [".ai-notes", "grilled"]];

/**
 * Every `grilled` directory in the workspace, as `{ project, grilled }`.
 *
 * Scans this root *and* each immediate subdirectory, in both layouts above. The
 * breadth matters: a lookup that misses returns an empty backlog, which reads
 * exactly like "all work is done" rather than like a broken path. `project` is
 * "." for notes at the root itself.
 */
function discoverNotesRoots() {
  const bases = [{ project: ".", dir: REPO_ROOT }];

  for (const name of readdirSync(REPO_ROOT).sort()) {
    if (NOT_A_PROJECT.test(name)) continue;
    const dir = join(REPO_ROOT, name);
    if (statSync(dir).isDirectory()) bases.push({ project: name, dir });
  }

  const found = [];
  for (const { project, dir } of bases) {
    for (const layout of GRILLED_LAYOUTS) {
      const grilled = join(dir, ...layout);
      if (existsSync(grilled) && statSync(grilled).isDirectory()) {
        found.push({ project, grilled });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function discoverTaskFiles() {
  const files = [];

  for (const { project, grilled } of discoverNotesRoots()) {
    for (const mapName of readdirSync(grilled).sort()) {
      const mapDir = join(grilled, mapName);
      if (!statSync(mapDir).isDirectory()) continue;

      for (const taskDir of TASK_DIRS) {
        const dir = join(mapDir, taskDir);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;

        for (const name of readdirSync(dir).sort()) {
          if (name.endsWith(".md") && !NOT_A_TASK.has(name)) {
            files.push({ project, grilled, file: join(dir, name) });
          }
        }
      }
    }
  }

  return files;
}

/**
 * Splits a file into lines, tolerating CRLF. Splitting on "\n" alone leaves a
 * trailing "\r" on every line, and in JS regex `.` never matches "\r" while `$`
 * (without /m) will not match before it — so every `^Field:\s*(.+)$` pattern
 * below silently misses, and a whole map's tickets get reported as having no
 * Status line. Editors on Windows write CRLF, so this is not hypothetical.
 */
function splitLines(content) {
  return content.split(/\r?\n/);
}

/**
 * Unwraps the markdown emphasis a field label may be written in. `issues/` writes
 * a bare `Status: open`; `tickets/` writes `**Status:** ready-for-agent`. Both name
 * the same field, so normalise the label here rather than teaching every pattern
 * below about asterisks. Leaves a line without a leading marker untouched, and
 * leaves the `| **Status** | … |` table row alone (it does not start with a marker).
 */
function unwrapLabel(line) {
  return line.replace(/^\s*(\*\*|__|\*|_)\s*([A-Za-z][A-Za-z ]*?)\s*:?\s*\1\s*:?/, "$2:");
}

/** Reads `Name: value` header fields, bold or bare. */
function readField(lines, name) {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = unwrapLabel(line).match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/** Reads a `| **Name** | value |` table row. */
function readRow(lines, name) {
  const pattern = new RegExp(`^\\|\\s*\\*\\*${name}\\*\\*\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * The header fields a note opens with, which are metadata rather than its prose.
 *
 * Both note conventions put these above the first paragraph — `issues/` as bare
 * `Type:` / `Blocked by:` lines, some `tickets/` as a borderless table —
 * so a description reader that takes "the first non-empty line after the title"
 * reports `grilling` or `harbor-point` as what the ticket is about.
 */
const META_FIELD =
  /^(type|status|label|labels|repo|repos|blocked by|blocks|unblocks|contract|source|source decisions|owner|priority|estimate|assignee|audience|map)\b\s*:/i;

/** Strips the markdown a sentence carries, so it can sit in a fixed-width cell. */
function stripMarkdown(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first real paragraph at or after `start`, as one line.
 *
 * Skips what precedes it — headings, metadata tables, blockquotes, fenced code,
 * rules and the header fields above — while nothing has been collected yet, and
 * stops at the first of them once it has. That one pass covers both shapes in
 * use: a ticket that opens `**What to build:** ...` directly under its title, and
 * a ticket that puts a metadata table and a `## What to build` heading in
 * between.
 */
function paragraphAt(lines, start) {
  const collected = [];

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const skippable =
      line === "" ||
      /^(#|\||>|```|---|===|\*\*\*)/.test(line) ||
      META_FIELD.test(unwrapLabel(line));

    if (skippable) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(line.replace(/^[-*+]\s+/, ""));
  }

  return collected.join(" ");
}

/**
 * One line saying what a task is for, for the `--table` view.
 *
 * `**What to build:**` — or `What to do:`, which the operational tickets use — is
 * a label on the paragraph rather than part of the sentence, so it is dropped:
 * every row would otherwise open with the same dozen characters, and the column
 * would show a dozen fewer characters of the thing it is naming.
 */
function readDescription(lines, titleIndex) {
  const paragraph = paragraphAt(lines, titleIndex + 1);
  return stripMarkdown(paragraph).replace(/^what to [a-z]+:\s*/i, "");
}

/** Locates the status line, in either the header or the table convention. */
function findStatus(lines) {
  for (const [index, line] of lines.entries()) {
    const header = unwrapLabel(line).match(/^Status:\s*(.+)$/i);
    if (header) {
      return {
        index,
        text: header[1].trim(),
        style: "header",
        // Preserved so `close` rewrites the line in the convention the file
        // already uses, instead of un-bolding every ticket it touches.
        label: line.match(/^\s*(\*\*|__|\*|_)/) ? "**Status:**" : "Status:",
      };
    }

    const row = line.match(/^\|\s*\*\*Status\*\*\s*\|\s*(.+?)\s*\|\s*$/i);
    if (row) return { index, text: row[1].trim(), style: "table" };
  }
  return null;
}

/**
 * Reduces a status line to its state word. The state always comes first, before
 * an em-dash that introduces the resolution note:
 *   `**closed** — resolved 2026-11-06 14:05 WIB by kedar` -> `closed`
 * Splitting on the dash keeps a note like "resolved upstream" from closing an
 * issue whose actual state is `open`.
 */
function stateOf(statusText) {
  return statusText
    .split(/—|\s-\s|;|,/)[0]
    .replace(/[*~`_[\]()]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Task ids referenced by `Blocked by: 02 (resolved), 11 (resolved)`.
 *
 * Only a comma-separated segment that *opens* with a number counts. Scraping every
 * digit in the line instead invents blockers out of prose — `Blocked by: 06, and the
 * branch feat/order-review-phase-1 landing` would report a dependency on
 * task 01, which silently parks a ticket that is ready to start.
 */
function referencedNumbers(field) {
  if (!field) return [];
  return field
    .split(",")
    .map((segment) => segment.trim().match(/^\*{0,2}(\d{1,3})\b/))
    .filter((match) => match !== null)
    .map((match) => match[1]);
}

function parseTask({ project, grilled, file }) {
  const content = readFileSync(file, "utf8");
  const lines = splitLines(content);
  const status = findStatus(lines);
  const titleLine = lines.find((line) => line.startsWith("# "));

  return {
    // `name` is the bare filename and never changes; `id` starts there and is
    // qualified in loadTasks() only as far as uniqueness demands.
    name: basename(file, ".md"),
    id: basename(file, ".md"),
    project,
    grilled,
    map: basename(dirname(dirname(file))),
    file: relative(REPO_ROOT, file),
    title: titleLine ? titleLine.replace(/^#\s*/, "").trim() : basename(file, ".md"),
    description: readDescription(lines, lines.indexOf(titleLine)),
    status: status ? status.text : null,
    state: status ? stateOf(status.text) : null,
    // Both note conventions are in use: `issues/` writes header fields, the
    // table form writes a table. Read either.
    type: readField(lines, "Type") ?? readRow(lines, "Type"),
    label: readField(lines, "Label") ?? readField(lines, "Labels") ?? readRow(lines, "Label"),
    repos: readField(lines, "Repos") ?? readField(lines, "Repo") ?? readRow(lines, "Repo"),
    blockedBy: readField(lines, "Blocked by") ?? readRow(lines, "Blocked by"),
    body: content,
  };
}

function loadTasks() {
  const tasks = [];
  for (const entry of discoverTaskFiles()) {
    const task = parseTask(entry);
    if (task.state === null) {
      console.error(`tracker: skipping ${task.file} — no Status line found`);
      continue;
    }
    tasks.push({
      ...task,
      closed: CLOSED_STATE.test(task.state),
      awaitingHuman: AWAITING_HUMAN_STATE.test(task.state),
      sandcastle: SANDCASTLE_LABEL.test(task.label ?? ""),
    });
  }

  // Ids are filenames, which are only guaranteed unique within a map. Qualify
  // progressively — bare name, then map, then project — and give each task the
  // shortest form that is unique across the whole workspace.
  //
  // The last rung is the file path, which cannot collide. It is not decoration:
  // the same base can carry both the `grilled/` and `.ai-notes/grilled/` layouts
  // at once, and then map and project are identical for two genuinely different
  // files. Without a unique id, `view` and `close` can only refuse as ambiguous.
  const rungs = [
    (task) => task.name,
    (task) => `${task.map}/${task.name}`,
    (task) => `${task.project}/${task.map}/${task.name}`,
    (task) => task.file.replace(/\.md$/, ""),
  ];

  for (const task of tasks) {
    for (const rung of rungs) {
      const candidate = rung(task);
      if (tasks.filter((other) => rung(other) === candidate).length === 1) {
        task.id = candidate;
        break;
      }
      // Nothing was unique — the path rung guarantees one, so this cannot fall
      // through, but assign anyway rather than leave the scaffold id in place.
      task.id = candidate;
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

// The widest a column is allowed to get, and the narrowest it may be squeezed to
// when the terminal cannot hold every column at its natural width. DESCRIPTION is
// last and given the largest ceiling, so the slack left over after the four
// identifying columns goes to prose rather than to padding.
const TABLE_COLUMNS = [
  { key: "dir", head: "DIR", min: 12, max: 32 },
  { key: "file", head: "FILE", min: 16, max: 44 },
  { key: "status", head: "STATUS", min: 8, max: 22 },
  { key: "title", head: "TITLE", min: 14, max: 42 },
  { key: "description", head: "DESCRIPTION", min: 20, max: 90 },
];

const COLUMN_GAP = "  ";

// Piping into `less` or a file leaves `columns` undefined; 120 is a terminal wide
// enough to be worth targeting and narrow enough not to wrap a normal one.
const DEFAULT_TERMINAL_WIDTH = 120;

function truncate(text, width) {
  if (text.length <= width) return text;
  return width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width);
}

/**
 * Column widths that fit the terminal.
 *
 * Starts from what each column actually needs (capped at its `max`) and, while
 * the row is too wide, takes a character from whichever column has the most room
 * above its `min`. Shrinking the *widest* rather than the last one keeps the
 * narrow identifying columns legible: the alternative eats DESCRIPTION to nothing
 * while DIR still holds a column of trailing spaces.
 */
function fitColumns(rows, terminalWidth) {
  const widths = TABLE_COLUMNS.map((column) =>
    Math.min(
      column.max,
      Math.max(column.head.length, ...rows.map((row) => row[column.key].length), column.min),
    ),
  );

  const gaps = COLUMN_GAP.length * (TABLE_COLUMNS.length - 1);
  const total = () => widths.reduce((sum, width) => sum + width, 0) + gaps;

  while (total() > terminalWidth) {
    let widest = -1;
    let slack = 0;
    for (const [index, width] of widths.entries()) {
      if (width - TABLE_COLUMNS[index].min > slack) {
        slack = width - TABLE_COLUMNS[index].min;
        widest = index;
      }
    }
    // Every column is already at its minimum: the terminal is narrower than the
    // table can be. Overflow and let the terminal wrap rather than loop forever.
    if (widest === -1) break;
    widths[widest] -= 1;
  }

  return widths;
}

function renderTable(rows) {
  const widths = fitColumns(rows, process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH);

  const line = (cells) =>
    cells
      .map((cell, index) =>
        index === cells.length - 1
          ? truncate(cell, widths[index])
          : truncate(cell, widths[index]).padEnd(widths[index]),
      )
      .join(COLUMN_GAP)
      .trimEnd();

  const out = [
    line(TABLE_COLUMNS.map((column) => column.head)),
    widths.map((width) => "─".repeat(width)).join(COLUMN_GAP),
  ];
  for (const row of rows) out.push(line(TABLE_COLUMNS.map((column) => row[column.key])));
  return out.join("\n");
}

/**
 * The row a task makes.
 *
 * The title loses its `01 — ` prefix because FILE already opens with the same
 * number, and the status loses the note after its em-dash: `◐ needs human` is the
 * whole of what a column this narrow can say, and keeping the rest would push the
 * state word itself out of the cell on the tickets that have the most to explain.
 */
function tableRow(task) {
  return {
    dir: task.map,
    file: `${task.name}.md`,
    status: stripMarkdown((task.status ?? "").split(/—/)[0]),
    title: stripMarkdown(task.title).replace(/^\d+\s*[—–-]\s*/, ""),
    description: task.description || "—",
  };
}

// ---------------------------------------------------------------------------
// Limiting `list` to some efforts
// ---------------------------------------------------------------------------

/**
 * The efforts `list` is limited to, or null for every effort.
 *
 * `--map <identifier>` wins, repeatable or comma-separated; otherwise
 * SANDCASTLE_MAPS, comma-separated. The variable is how `main.mts --map` reaches
 * the `list` it runs as a child process. An identifier is an effort
 * directory's name, e.g. `hp-1-order-intake`.
 */
function selectedMaps(args) {
  const fromArgs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--map") fromArgs.push(args[++index] ?? "");
    else if (arg.startsWith("--map=")) fromArgs.push(arg.slice("--map=".length));
  }
  const raw = fromArgs.length > 0 ? fromArgs.join(",") : process.env.SANDCASTLE_MAPS ?? "";
  const maps = raw
    .split(",")
    .map((map) => map.trim())
    .filter(Boolean);
  return maps.length > 0 ? maps : null;
}

/**
 * The tasks of the selected efforts, or all of them when none is selected.
 *
 * A name that matches no effort is an error, not an empty result. An empty
 * backlog reads exactly like "all work is done", so a typo in `--map` would
 * otherwise end a sandcastle run with "nothing to do" and no hint why.
 */
function scopeToMaps(tasks, maps) {
  if (!maps) return tasks;

  const known = [...new Set(tasks.map((task) => task.map))].sort();
  const unknown = maps.filter((map) => !known.includes(map));
  if (unknown.length > 0) {
    throw new Error(
      `--map names no effort with tasks: ${unknown.join(", ")}. Known efforts:\n` +
        known.map((map) => `  ${map}`).join("\n"),
    );
  }

  console.error(`tracker: listing only ${maps.join(", ")}`);
  return tasks.filter((task) => maps.includes(task.map));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * A task named for a human to read, always carrying its effort directory:
 * `hp-9-credit-checks/14-hold-an-order-past-the-credit-limit`.
 *
 * `id` is the shortest *unique* form, so the map appears only once two files
 * collide — which makes a bare `14-...` on screen say nothing about which effort
 * it belongs to, and a workspace holding several efforts at once numbers each
 * from 01. Prefixing unconditionally keeps every reported line self-locating.
 * Ids already qualified past the map are left alone: they carry it plus the
 * project, and re-prefixing would only duplicate it. Both forms are accepted
 * back by `view` and `close`, which fall back to matching on the basename.
 */
function displayName(task) {
  return task.id.includes("/") ? task.id : `${task.map}/${task.name}`;
}

/**
 * The backlog as a table, for a human at a terminal.
 *
 * Shows every open `sandcastle` ticket, *including* the ones held back for a
 * human — unlike `list`, whose JSON promises the runner only work an agent can
 * start. Here the STATUS column is what distinguishes them, and dropping them
 * would leave a ticket that is genuinely waiting on somebody visible nowhere.
 * Closed tickets stay out: what is left to do is the question this answers.
 */
function listTable(maps) {
  const tasks = scopeToMaps(loadTasks(), maps);
  const open = tasks.filter((task) => !task.closed && task.sandcastle);

  if (open.length === 0) {
    console.log("No open ticket carries the `sandcastle` label.");
  } else {
    console.log(renderTable(open.map(tableRow)));
  }

  // Same reasoning as `list`: an empty or short table reads like "all work is
  // done", and the count of what was filtered out is the difference between that
  // and "nothing carries the label yet".
  //
  // Counted against *this* view's filter, not `list`'s. `list` discounts the
  // awaiting-a-human files before counting unlabelled ones because it has already
  // reported each by name; the table shows the labelled ones as rows instead, so
  // an unlabelled file parked on a human appears nowhere and has to be counted
  // here — otherwise the footer under-reports what it is hiding.
  const awaiting = open.filter((task) => task.awaitingHuman).length;
  const unlabelled = tasks.filter((task) => !task.closed && !task.sandcastle).length;

  const parts = [`${open.length} open ticket(s)`];
  if (awaiting > 0) parts.push(`${awaiting} awaiting a human`);
  if (unlabelled > 0) parts.push(`${unlabelled} open file(s) without the label, not shown`);
  console.log("");
  console.log(parts.join(" — "));
}

function list(maps) {
  const tasks = scopeToMaps(loadTasks(), maps);
  const open = tasks.filter((task) => !task.closed && !task.awaitingHuman && task.sandcastle);

  for (const task of tasks.filter((task) => !task.closed && task.awaitingHuman)) {
    console.error(`tracker: holding back ${displayName(task)} — awaiting a human (${task.status})`);
  }

  // An unlabelled file is the common case, not an error: every `/wayfinder`
  // decision note is one. Count them rather than naming each, but do say the
  // number — an empty backlog reads exactly like "all work is done", and the
  // difference between that and "nothing carries the label yet" is the whole
  // question when sandcastle finds nothing to do.
  const unlabelled = tasks.filter(
    (task) => !task.closed && !task.awaitingHuman && !task.sandcastle,
  );
  if (unlabelled.length > 0) {
    console.error(
      `tracker: skipping ${unlabelled.length} open file(s) without the \`sandcastle\` label` +
        ` — only \`/to-tickets\` output under tickets/ is sandcastle's to implement`,
    );
  }

  const issues = open.map((task) => {
    // Which of this task's stated blockers are themselves still open. The
    // runner starts only a ticket with none (lib/selection.mjs); blockers are
    // written as bare numbers, scoped to the same map.
    const blockedByOpen = referencedNumbers(task.blockedBy).filter((number) =>
      tasks.some(
        (other) =>
          other.map === task.map &&
          other.project === task.project &&
          !other.closed &&
          other.id !== task.id &&
          basename(other.id).startsWith(`${number}-`),
      ),
    );

    return {
      id: task.id,
      title: task.title,
      body: task.body,
      status: task.status,
      type: task.type,
      label: task.label,
      repos: task.repos,
      project: task.project,
      map: task.map,
      file: task.file,
      blockedBy: task.blockedBy,
      blockedByOpen,
    };
  });

  // What `list` is actually offering, in the same human-readable shape as the
  // lines above. Without it the only legible half of this command is the half
  // reporting *exclusions*, so a ticket that is being offered normally shows up
  // nowhere a reader looks — the JSON below is the runner's interface, not a
  // thing anyone scans — and its absence from the held-back lines reads as
  // "missing" rather than as "fine". Stderr, because stdout is parsed as JSON
  // by main.mts and a single stray line there breaks the run.
  if (issues.length === 0) {
    console.error("tracker: offering nothing — no open file carries the `sandcastle` label");
  } else {
    console.error(`tracker: offering ${issues.length} ticket(s):`);
    // `issues` is `open` mapped one-for-one, so the index carries across; taking
    // the name from the task keeps this spelling identical to the held-back
    // lines, project rung and all.
    for (const [index, task] of open.entries()) {
      const stillOpen = issues[index].blockedByOpen;
      const blocked =
        stillOpen.length > 0 ? ` — blocked by ${stillOpen.join(", ")} (still open)` : "";
      console.error(`tracker:   ${displayName(task)}${blocked}`);
    }
  }

  console.log(JSON.stringify(issues, null, 2));
}

function resolveTask(id) {
  const tasks = loadTasks();

  // An exact id wins outright. Without this precedence the loose matching below
  // drags the collided siblings back in — their ids differ only in the path
  // prefix that was added to separate them, and every one shares a basename.
  const exact = tasks.find((task) => task.id === id);
  if (exact) return exact;

  const matches = tasks.filter(
    (task) => task.name === id || task.name === basename(id),
  );

  if (matches.length === 0) {
    const known = tasks.map((task) => `  ${task.id}`).join("\n");
    throw new Error(`no task matching "${id}". Known tasks:\n${known}`);
  }
  if (matches.length > 1) {
    // List the qualified ids, which are unique — repeating the ambiguous short
    // form would just show the same string twice and offer no way forward.
    const candidates = matches.map((task) => `  ${task.id}`).join("\n");
    throw new Error(`"${id}" is ambiguous. Use one of:\n${candidates}`);
  }
  return matches[0];
}

function view(id) {
  const task = resolveTask(id);

  // The map is the task's parent PRD — either <map>/map.md or a <map>.md sibling.
  const mapDir = join(task.grilled, task.map);
  const parents = [join(mapDir, "map.md"), `${mapDir}.md`].filter((path) => existsSync(path));

  console.log(`File: ${task.file}`);
  if (parents.length > 0) {
    console.log(`Parent map (read this too): ${parents.map((p) => relative(REPO_ROOT, p)).join(", ")}`);
  }
  console.log("");
  console.log(task.body);
}

/** Runs git with stderr captured, so a probe that is expected to fail stays quiet. */
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * The git repository that actually tracks a task file, and the file's path within it.
 *
 * A project here may be its own repository rather than part of the root one, so
 * committing from REPO_ROOT would either miss the file or fail outright. Ask git
 * which worktree owns the file instead of assuming.
 */
function repoFor(absolutePath) {
  const cwd = dirname(absolutePath);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return { cwd: top, path: relative(top, absolutePath).split(sep).join("/") };
}

/** Whether a merge is in progress in `cwd`. */
function mergeInProgress(cwd) {
  try {
    git(cwd, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Commits work even when the sandbox has no git identity configured. */
function gitIdentityArgs(cwd) {
  try {
    if (git(cwd, ["config", "user.email"])) return [];
  } catch {
    // `git config` exits 1 when the key is unset.
  }
  return ["-c", "user.name=sandcastle", "-c", "user.email=sandcastle@localhost"];
}

/**
 * Now, as the stamp a closed ticket carries: `2026-09-25 13:59 WIB`.
 *
 * Read from `date` rather than built here so it is exactly the stamp an agent
 * writes by hand — docs/agents/issue-tracker.md gives agents the same command.
 * `date` also names the host's zone, which is the point: `toISOString()` is the
 * UTC date, so a ticket closed before 07:00 WIB was dated the day before.
 */
function stamp() {
  return execFileSync("date", ["+%Y-%m-%d %H:%M %Z"], { encoding: "utf8" }).trim();
}

function close(id) {
  const task = resolveTask(id);

  if (task.closed) {
    console.log(`${task.id} is already closed (${task.status}). Nothing to do.`);
    return;
  }

  const absolute = join(REPO_ROOT, task.file);
  const original = readFileSync(absolute, "utf8");
  // Rejoin with the ending the file already uses, so closing one ticket does not
  // land a whole-file line-ending flip in the commit.
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(original);
  const status = findStatus(lines);

  lines[status.index] =
    status.style === "table"
      ? "| **Status** | ☑ Done |"
      : `${status.label} closed — resolved ${stamp()} by sandcastle`;

  writeFileSync(absolute, lines.join(newline));

  const repo = repoFor(absolute);
  const message = `chore(tracker): close ${task.id}`;
  const identity = gitIdentityArgs(repo.cwd);
  // Path-limited commits only: they record this file and leave whatever else is
  // staged, a developer's own review mark, untouched.
  const commitThisFile = () =>
    git(repo.cwd, [...identity, "commit", "--no-verify", "-m", message, "--", repo.path]);
  try {
    commitThisFile();
  } catch (error) {
    // Mid-merge, git refuses a commit of one path, and a whole commit would take
    // the merge and everything staged with it. The file is closed on disk; the
    // commit is left to whoever finishes the merge.
    if (mergeInProgress(repo.cwd)) {
      throw new Error(
        `${task.file} is marked closed, but not committed: ${repo.cwd} is in the middle of a ` +
          `merge (${error.message}). Finish or abort the merge, then commit the file.`,
      );
    }
    // Otherwise the file is new to git, which a path-limited commit refuses until
    // it is added.
    git(repo.cwd, ["add", "--", repo.path]);
    commitThisFile();
  }

  console.log(`Closed ${task.id} (${task.file}) and committed.`);
}

// ---------------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "list":
      if (args.includes("--table")) listTable(selectedMaps(args));
      else list(selectedMaps(args));
      break;
    case "view":
      if (!args[0]) throw new Error("view needs a task id");
      view(args[0]);
      break;
    case "close":
      if (!args[0]) throw new Error("close needs a task id");
      close(args[0]);
      break;
    default:
      throw new Error(
        `unknown command "${command ?? ""}". Use: list [--table] [--map <effort>] | view <ID> | close <ID>`,
      );
  }
} catch (error) {
  console.error(`tracker: ${error.message}`);
  process.exit(1);
}
