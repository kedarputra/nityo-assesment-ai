import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, avatarInitials, avatarTint } from "./avatar";

describe("Avatar", () => {
  it("shows up to two initials from the sender's name", () => {
    expect(avatarInitials("Jenna Brooks")).toBe("JB");
    expect(avatarInitials("maria de la cruz")).toBe("MD");
    expect(avatarInitials("Accounts")).toBe("A");
    expect(avatarInitials("  ")).toBe("?");
  });

  it("gives the same name the same one of the five tints", () => {
    expect(avatarTint("Jenna Brooks")).toBe(avatarTint("Jenna Brooks"));
    for (const name of ["Maria Lopez", "Priya Shah", "Paul Ng", "X"]) {
      expect(avatarTint(name)).toBeGreaterThanOrEqual(0);
      expect(avatarTint(name)).toBeLessThan(5);
    }
  });

  it("is decorative: the sender's name is always written beside it", () => {
    const html = renderToStaticMarkup(<Avatar name="Jenna Brooks" />);

    expect(html).toBe(`<span class="av av--${avatarTint("Jenna Brooks")}" aria-hidden="true">JB</span>`);
  });
});
