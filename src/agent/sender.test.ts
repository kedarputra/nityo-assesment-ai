import { describe, expect, it } from "vitest";
import { matchSender, type Contact } from "./sender";

// The data pack's own contacts for the cases ticket 09 of the map decided.
const contacts: Contact[] = [
  { customerId: "C008", name: "Nora Fields", email: "nora@riversideclinic.example", role: "Practice Manager" },
  { customerId: "C011", name: "Frank Russo", email: "frank.russo.deli@mail.example", role: "Owner" },
  { customerId: "C014", name: "Rita Gomez", email: "goldenspoondiner@mail.example", role: "Owner" },
  { customerId: "C017", name: "Hannah Moore", email: "maple.bakery@mail.example", role: "Owner" },
];

describe("matchSender", () => {
  it("matches a known contact by their exact address, whatever its case", () => {
    expect(matchSender(contacts, " Nora@RiversideClinic.example ")).toMatchObject({
      matchedBy: "address",
      customerId: "C008",
      contact: { name: "Nora Fields" },
    });
  });

  it("matches an unknown sender at a domain only one customer uses, unverified (E013)", () => {
    expect(matchSender(contacts, "kevin.osei@riversideclinic.example")).toEqual({
      matchedBy: "domain",
      customerId: "C008",
      domain: "riversideclinic.example",
    });
  });

  it("matches no one for a stranger at a domain several customers share (U16)", () => {
    expect(matchSender(contacts, "stranger@mail.example")).toEqual({ matchedBy: "none", sharedDomain: true });
  });

  it("still matches a shared domain's own contacts by address", () => {
    expect(matchSender(contacts, "maple.bakery@mail.example")).toMatchObject({ matchedBy: "address", customerId: "C017" });
  });

  it("matches no one at a domain no customer uses (E014)", () => {
    expect(matchSender(contacts, "sofia@freshstartjuice.example")).toEqual({ matchedBy: "none", sharedDomain: false });
  });
});
