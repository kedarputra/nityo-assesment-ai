import { Tag } from "lucide-react";
import type { DeskLabel } from "./folders";

// A label as Outlook shows a category: its colour, an icon and its name, so colour is never alone.
export function LabelChip({ label }: { label: Pick<DeskLabel, "name" | "color"> }) {
  return (
    <span className={`label-chip label-chip--${label.color}`}>
      <Tag size={12} aria-hidden="true" />
      {label.name}
    </span>
  );
}
