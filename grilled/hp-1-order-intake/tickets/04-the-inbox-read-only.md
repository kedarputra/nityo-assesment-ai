# 04 — The inbox, read-only

**What to build:** A signed-in person sees the order desk: the day's 40 emails in the chosen three-pane layout, each email readable as plain text, with the greeting, filters and an empty audit log page, on phone, tablet and desk.

**Repo:** harbor-point

**Blocked by:** 02, 03 — [Load the data pack into the database as the Snapshot](02-load-the-data-pack.md), [Sign-in, sessions and roles](03-sign-in-sessions-and-roles.md)

**Label:** sandcastle

**Status:** ready-for-agent

## Context

The map is [`map.md`](../map.md); words are defined in [`CONTEXT.md`](../../../CONTEXT.md); every screen follows [`DESIGN.md`](../../../DESIGN.md), whose living example is Variant A of [the prototype](../assets/prototype-review-ui.html). The business rules are in the [data pack README](../../../data/harbor_point_data_pack/README.md); the data pack is read-only.

- Layout chosen in [What the ops review UI looks like](../issues/02-review-ui-prototype.md#answer); the
  phone, tablet and desk arrangements, voice, components and states are in `DESIGN.md` (version 2).
  Screenshots: [desk](../assets/review-ui-variant-a-three-pane-inbox.png),
  [tablet](../assets/review-ui-a-tablet.png), [phone list](../assets/review-ui-a-phone-list.png),
  [phone detail](../assets/review-ui-a-phone-detail.png). Rebuild it properly; the prototype is
  throwaway code.
- [Security 4](../issues/06-security-controls.md#answer): email bodies, subjects and sender names are
  untrusted and only ever rendered as text (no `dangerouslySetInnerHTML`).
- No agent runs yet: every email shows a "Not run yet" state. The Proposal pane shows an empty state.

## Acceptance criteria

- [ ] The list shows all 40 emails in `received_at` order with the sender's avatar initials, name, time, subject and a status pill; filters All / Needs you / Done / Other with counts wrap rather than truncate.
- [ ] The greeting card shows "Good morning", the day's count in words and the progress bar; the tip card can be dismissed and stays dismissed for that user (stored server-side).
- [ ] Selecting an email shows its subject, sender, time and body as plain text; the selected email and filter are in the URL and survive a reload.
- [ ] Phone (under 768px): list, then detail with "← All emails"; tablet (768–1199px): two panes; desk (1200px and up): three card panes, each scrolling on its own. No horizontal scroll at 390, 900 or 1440px wide.
- [ ] An Audit log page exists, shows an empty state, and is linked from the header.
- [ ] Accessibility per `DESIGN.md`: rows are buttons, one `h1` per screen, visible focus ring, skip link, status never by colour alone.
- [ ] Component tests cover the empty, list and selected states; a test renders an email body containing `<script>` and proves it appears as text.
