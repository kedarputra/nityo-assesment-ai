const AVATAR_TINTS = 5;

export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
  return initials || "?";
}

// One of DESIGN.md's five avatar tints, chosen by the name so the same person always gets the
// same colour. The tint carries no meaning.
export function avatarTint(name: string): number {
  let sum = 0;
  for (const character of name) sum += character.codePointAt(0) ?? 0;
  return sum % AVATAR_TINTS;
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className={`av av--${avatarTint(name)}`} aria-hidden="true">
      {avatarInitials(name)}
    </span>
  );
}
