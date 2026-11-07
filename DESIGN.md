---
version: 2
name: Harbor Point Order Desk
description: >-
  A friendly desk for the ops team's order inbox: an apricot-cream ground, white cards, rounded
  shapes, one dusk-blue accent (apricot on the dark theme) and pumpkin-spice warmth for good news. Plain, kind words; phone-first
  layouts that grow into three panes on a desk. Plus Jakarta Sans for words, DM Mono for identifiers.
  Status is never colour alone.

colors:
  light:
    canvas: "#fbf6ee"           # warm apricot-cream ground: the page behind the cards
    surface: "#ffffff"          # white: cards, panes, inputs
    sunken: "#f5eee3"           # the quoted email, table heads, wells
    hairline: "#ebe3d6"         # dividers (decorative only)
    control-border: "#878aa0"   # input and checkbox edges (3.4:1 on surface)
    ink: "#1f2236"
    ink-muted: "#555a72"
    ink-faint: "#878aa0"        # disabled text and placeholders only
    accent: "#4e598c"           # dusk blue: primary button, links, focus, selection
    accent-hover: "#3f4875"
    accent-soft: "#e6e8f2"      # selected row, "what the agent thinks"
    on-accent: "#ffffff"
    sun: "#ff8c42"              # pumpkin spice: progress, all-clear; always under ink text
    sun-soft: "#fdefdc"
    ok: "#1d7543"
    ok-soft: "#e3f4e9"
    warn: "#9c4a10"             # burnt pumpkin: text on warn-soft (5:1)
    warn-soft: "#ffe9d4"
    bad: "#b0251d"
    bad-soft: "#fde8e5"
    avatar: ["#e6e8f2", "#fdefdc", "#ffe3cc", "#fbe8c4", "#ecebf3"]   # sender initials, by name
  dark:
    canvas: "#151726"
    surface: "#1e2135"
    sunken: "#191c2d"
    hairline: "#2e3250"
    control-border: "#7f84a3"
    ink: "#f3f1ec"
    ink-muted: "#b2b5c7"
    ink-faint: "#7f84a3"
    accent: "#f9c784"           # apricot cream: on dusk-blue night it carries the accent
    accent-hover: "#fcaf58"     # sandy brown
    accent-soft: "#2c3357"      # dusk blue: the selected row
    on-accent: "#1f2236"
    sun: "#ff8c42"
    sun-soft: "#3d2a1c"
    ok: "#74d19a"
    ok-soft: "#183322"
    warn: "#fcaf58"             # sandy brown
    warn-soft: "#3a2a17"
    bad: "#f58b80"
    bad-soft: "#3d1d1a"
    avatar: ["#2c3357", "#3d2a1c", "#40281a", "#3a3046", "#262b42"]

typography:
  sans: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
  mono: "'DM Mono', ui-monospace, 'SF Mono', Menlo, monospace"
  greeting:  { size: 22px, weight: 700, lineHeight: 1.25, letterSpacing: -0.3px }  # "Good morning", the all-clear
  title:     { size: 20px, weight: 700, lineHeight: 1.3,  letterSpacing: -0.2px }  # an email's subject, a page title
  headline:  { size: 18px, weight: 700, lineHeight: 1.35, letterSpacing: -0.1px }  # the Proposal's one-line headline
  reading:   { size: 16px, weight: 400, lineHeight: 1.6 }                           # the email, the agent's words, the reply
  body:      { size: 15px, weight: 400, lineHeight: 1.5 }                           # lists, cards, tables (16px on phones)
  label:     { size: 14px, weight: 600, lineHeight: 1.35 }                          # section names, buttons
  meta:      { size: 13px, weight: 500, lineHeight: 1.4 }                           # times, ids, hints; nothing is smaller
  id:        { family: mono, size: 13px, weight: 500 }                              # E005, HPS-1305, SO-24059, C005

rounded: { sm: 6px, md: 10px, lg: 14px, xl: 20px, pill: 9999px }
spacing: { 1: 4px, 2: 8px, 3: 12px, 4: 16px, 5: 24px, 6: 32px, 7: 48px }
elevation:
  card: "0 1px 2px rgb(31 34 54 / .05)"                                       # cards resting on the cream
  popover: "0 2px 4px rgb(31 34 54 / .06), 0 12px 32px rgb(31 34 54 / .14)"   # toasts, menus, sheets
motion: { fast: 140ms, base: 200ms, easing: "cubic-bezier(.2,.8,.2,1)" }
breakpoints: { phone: "< 768px", tablet: "768–1199px", desk: "≥ 1200px" }
---

# Harbor Point Order Desk

<!-- Palette (2026-11-07, the developer's choice): Dusk Blue #4E598C, White #FFFFFF, Apricot Cream
#F9C784, Sandy Brown #FCAF58, Pumpkin Spice #FF8C42. Text colours are darkened or lightened from
them where contrast needs it; green and red stay for Done and errors, so status keeps its meaning. -->

The design standard for every screen this repository builds. Only the developer's own request
outranks it. Words are defined in [`CONTEXT.md`](CONTEXT.md). The layout was chosen in
[What the ops review UI looks like](grilled/hp-1-order-intake/issues/02-review-ui-prototype.md);
Variant A of [`prototype-review-ui.html`](grilled/hp-1-order-intake/assets/prototype-review-ui.html)
is this file, working.

## Who it is for, and the feel

The ops team at a supplies distributor, working through a day's order inbox. The agent does the
reading and drafting; people make the calls. The desk should feel like **a helpful colleague who has
already done the legwork**: friendly, clear and calm, never alarming and never cute.

- **Friendly.** A warm cream page, white cards with soft corners, sender initials in gentle colours,
  and plain words. Good news gets a little sunshine.
- **Clear.** Every screen answers "what needs me, and why?" first. Jargon from the ERP is always
  explained beside it.
- **Safe.** Friendliness never hides a risk: hard rules look firm, and every decision can be undone
  or explained.
- **Works anywhere.** Designed for a phone first, then a tablet, then a desk with three panes.

## Voice and words

Write the way a thoughtful colleague talks: short, plain, warm, specific.

| Instead of | Write |
| --- | --- |
| Needs review | **Needs you** |
| Released by agent | **Done by the agent** |
| What stops it | **Why it's waiting for you** |
| 7 checks pass | **7 checks look good** |
| CREDIT_HOLD | **On credit hold**: "Accounts has paused this customer." (the ERP word stays visible in `meta`) |
| Hard rule: cannot be overridden | **Can't be overridden.** Accounts needs to clear this first. |
| Give a reason to override | **Add a quick note about why it's OK.** |
| Agent steps (13) | **See how the agent worked it out** (13 steps) |
| Error 400 | **The model's spending limit is reached, so runs are paused.** Ask an admin to raise it. |

- **Greet and orient.** The inbox opens with the time of day and the day's progress: "Good morning.
  4 of 6 emails need you; the agent handled the rest."
- **Celebrate lightly.** One 🎉 when the queue is empty, and a friendly count in toasts ("Released
  SO-24060. 3 to go."). Never confetti, never on every action.
- **Explain, don't blame.** Errors say what happened and what to do next. Never "invalid".
- **Buttons say what happens:** "Approve & release", "Reject…", "Put on hold…", "Mark reply ready".
  An ellipsis means a note follows.
- Sentence case, curly quotes, `…`, and numbers with their units (`4&nbsp;cases`).

## Colour

Tokens are in the front matter, as CSS custom properties; never raw hex in a component.

- **Teal is the one accent:** the primary button, links, focus, the selected email, and "what the
  agent thinks". **Sun** is only for good news (the progress bar, the all-clear) and always sits
  under dark ink.
- **Status colours mean status only:** `ok` done or approved, `warn` needs you or a soft check,
  `bad` a hard rule, rejected or an error. Each has a `-soft` background for its pill or panel.
- **Never colour alone:** every status has an icon and words (✓ Done, ! Needs you, 🔒 Can't be
  overridden, ✕ Rejected, ◐ On hold, – No action needed).
- **Avatars** use the five `avatar` tints, chosen by the sender's name, so the same person always
  gets the same colour. They carry no meaning.
- **No violet or lavender.** Contrast is checked: every text token is 4.8:1 or more on its
  backgrounds in both themes; `ink-faint` is only for disabled text, placeholders and control edges.
- **Dark theme** follows `prefers-color-scheme`, with `color-scheme: dark` on `<html>`.

## Type

- **Plus Jakarta Sans** for words: friendly, round and very legible. **DM Mono** for identifiers
  (email ids, SKUs, sales orders, customers, tool names). Both through `next/font`.
- Use only the front matter's roles. **Reading text is 16px** (the email, the agent's words, the
  reply); lists and tables are 15px, and **16px on phones**. Nothing under 13px.
- Sentence case everywhere; section names are 14px/600 in `ink-muted`, never uppercase or tracked.
- Figures use `tabular-nums` and are right-aligned in tables; money through `Intl.NumberFormat`
  in USD; dates on the business clock ("Mon 2 Nov", "07:26").

## Layout and responsiveness

Phone first. One codebase, three arrangements:

| Width | Arrangement |
| --- | --- |
| **Phone**, under 768px | **List, then detail.** The inbox is a full-width list. Tapping an email opens its detail screen with a "← All emails" back link: the Proposal's headline and actions first, then why it's waiting, the lines as stacked cards, the reply, and the email folded below. Actions sit in a **sticky bar at the bottom**, inside the safe area, with 48px buttons. |
| **Tablet**, 768–1199px | **Two panes.** The list on the left (300px); the detail on the right, with the email above the Proposal, scrolling as one. |
| **Desk**, 1200px and up | **Three panes**, as white cards on the cream with 12px between them: the list (340px), the email with what the agent thinks (fluid, reading width at most 720px), and the Proposal (460px). Each pane scrolls on its own. |

- Use `100dvh`, never `100vh`; respect `env(safe-area-inset-*)`; no sideways scrolling at any width.
- On phones the lines table becomes one card per line (product, then quantity, price and total in a
  row), and the email body folds behind "Read the email".
- Spacing comes from the 4px scale: card padding 20px (16px on phones), 24px between blocks.

## Components

One of each.

- **Buttons.** Radius `md`, label 14px/600, 40px high on a desk and **48px on touch**, with at least
  8px between buttons. **Primary:** `accent` fill, one per view, for the main decision.
  **Secondary:** white with a `control-border` edge. **Destructive** (Reject): secondary shape with
  `bad` text. Pressed buttons dip 1px; busy buttons keep their label and show a spinner.
- **Status pill.** Radius `pill`, 13px/600, the status's soft background, icon and words.
- **Kind tag.** Pill in `sunken` with `ink-muted` text: "New order", "Order change",
  "Cancellation", "Return", "Billing dispute", "Quote request", "Order inquiry", "No action".
- **Email row.** Avatar (initials, 36px circle), sender and time on the first line, the subject on
  the second, kind and status on the third. The selected row gets `accent-soft` and a 3px accent edge.
  The whole row is one button, at least 64px tall.
- **Greeting card.** At the top of the list: "Good morning" in `greeting`, the day's count in words,
  and a progress bar in `sun` on `sun-soft` showing emails handled out of the day's total.
- **Tip card.** Dismissible, once per person: how the desk works in two sentences, and what the
  colours mean. Remembered per user (stored on the server, not only in the browser).
- **Why it's waiting.** A soft `warn` card (or `bad` for a hard rule) listing only the failing
  checks. A soft check has a note field ("Add a quick note about why it's OK…"); a hard rule shows
  🔒 and a plain explanation. Passing checks fold into "7 checks look good".
- **What the agent thinks.** `accent-soft` card, `reading` type, in plain third person about the
  customer ("Jenna asks for three deliveries…"). Steps fold behind "See how the agent worked it out".
- **Lines.** A table on a tablet or desk (product with SKU and the customer's own words, quantity
  with availability, price with its source, total); stacked cards on a phone. Quantities are editable
  while the Proposal is open, and every change re-runs the checks at once.
- **Reply to customer.** A textarea in `reading` type and a "Mark reply ready" button, with the note
  "We never send email from here; this is what would go out."
- **Toast.** Bottom right on a desk, bottom centre above the action bar on a phone. Says what
  happened and what's left, and offers **Undo** for 10 seconds after a release.
- **Audit log.** A table on a desk, a list of cards on a phone: when, who (agent, gate, or a named
  person), what, which email, and the detail. Newest first, filterable by email.
- **Sign-in.** Two halves of one card on a desk: on the left, an `accent-soft` panel saying what the
  desk does (an accent kicker, a 30px headline, three numbered points, the inbox's day); on the right,
  the form. On a phone the form comes first and the panel follows, so signing in never needs a scroll.
- **Account.** At the right of the header: the business date (desk only), then the account menu.
  Its button is the avatar with the username and role (the avatar alone on phones) and a small
  caret; it opens a menu with "Sign out", and for an admin "Run all" (or "Stop the run") and
  "Reset to 07:00…". With the agent switched off, an admin sees a one-line note in place of Run all.

## Interaction

- **Keys on a desk** (shown as hints, never intercepted while typing): `j` / `k` next or previous,
  `a` approve, `r` reject, `h` hold, `?` the list of keys. Phones and tablets get visible buttons
  for every action; nothing depends on a key, hover or swipe.
- **Focus** is always visible: a 2px accent ring offset 2px. After a decision, focus and selection move
  to the next email that needs you.
- **Reasons are typed inline**, never in a browser prompt; Enter confirms, Esc cancels.
- **The URL holds the state:** the selected email, the filter, and the phone's list or detail view.
- **Motion** is gentle and explains a change: rows sliding out of "Needs you", the progress bar
  filling, a toast rising. 140–200ms on `transform` and `opacity` only; nothing moves under
  `prefers-reduced-motion`.

## States

- **All clear:** "All clear 🎉 Nothing needs you right now. The agent handled 2 on its own and you
  decided 4." with a link to the audit log.
- **Agent working:** the row says "Reading…" with a soft pulse; the detail keeps its shape with
  skeletons.
- **Agent switched off** (a deploy with no model key): the greeting says the emails are the reader's
  to read, and the Proposal pane shows a `sunken` note with a pause icon in place of "Run the agent".
- **Errors** are calm sentences with a next step, in a `bad-soft` card, never a raw code.
- **Long content** truncates in rows and wraps in cards; names, subjects and products are tested at
  5 and 80 characters.

## Accessibility

The Vercel Web Interface Guidelines' MUST rules apply: native elements first (rows are buttons,
tables are tables), a skip link, one `<h1>` per screen, names on icon-only controls, hit targets of
44px or more on touch, redundant status cues, `aria-live="polite"` for toasts and inline errors, and
the contrast above. Friendliness is never carried by colour, emoji or motion alone.

## Not part of this desk

- Marketing-site patterns: heroes, photography, gradients, illustrations, confetti.
- Charts, until a metrics view is planned.
- A logo beyond the wordmark: "Harbor Point" in 16px/700, then "Order desk" in `ink-muted`.
