import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database";
import {
  appSettings,
  customerContacts,
  customerPrices,
  customers,
  emails,
  incomingSupply,
  inventory,
  products,
  salesOrderLines,
  salesOrders,
  shipToAddresses,
} from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "@/test/database";
import { dataPackDirectory, readDataPack, type Snapshot } from "./data-pack";
import { ingestSnapshot, resetToSnapshot } from "./snapshot";

describe("the Snapshot", () => {
  let snapshot: Snapshot;
  let databases: TestDatabase[] = [];

  beforeAll(() => {
    snapshot = readDataPack();
  });

  async function ingestedDatabase(): Promise<Database> {
    const database = await createTestDatabase();
    databases.push(database);
    await ingestSnapshot(database.db, snapshot);
    return database.db;
  }

  afterEach(async () => {
    await Promise.all(databases.map((database) => database.close()));
    databases = [];
  });

  async function rowCounts(db: Database) {
    return {
      customers: await db.$count(customers),
      contacts: await db.$count(customerContacts),
      shipTos: await db.$count(shipToAddresses),
      products: await db.$count(products),
      contractPrices: await db.$count(customerPrices),
      inventory: await db.$count(inventory),
      incomingSupply: await db.$count(incomingSupply),
      salesOrders: await db.$count(salesOrders),
      orderLines: await db.$count(salesOrderLines),
      emails: await db.$count(emails),
    };
  }

  const packCounts = {
    customers: 20,
    contacts: 22,
    shipTos: 23,
    products: 30,
    contractPrices: 8,
    inventory: 30,
    incomingSupply: 2,
    salesOrders: 9,
    orderLines: 24,
    emails: 40,
  };

  it("loads every table of the pack into an empty database", async () => {
    const db = await ingestedDatabase();

    expect(await rowCounts(db)).toEqual(packCounts);
  });

  it("holds C007's HPS-1201 contract price in cents with its validity dates", async () => {
    const db = await ingestedDatabase();

    const rows = await db
      .select()
      .from(customerPrices)
      .where(and(eq(customerPrices.customerId, "C007"), eq(customerPrices.sku, "HPS-1201")));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unitPriceCents: 3510,
      validFrom: "2026-07-01",
      validTo: "2027-06-30",
    });
  });

  it("keeps cents on prices the pack writes with a trailing zero or none", async () => {
    const db = await ingestedDatabase();

    const [line] = await db
      .select()
      .from(salesOrderLines)
      .where(and(eq(salesOrderLines.soNumber, "SO-24058"), eq(salesOrderLines.lineNo, 1)));
    const [customer] = await db.select().from(customers).where(eq(customers.customerId, "C003"));

    expect(line?.unitPriceCents).toBe(4860);
    expect(customer).toMatchObject({ creditLimitCents: 5_000_000, openBalanceCents: 1_875_000 });
  });

  it("holds HPS-1004 as DISCONTINUED, replaced by HPS-1001", async () => {
    const db = await ingestedDatabase();

    const [product] = await db.select().from(products).where(eq(products.sku, "HPS-1004"));

    expect(product).toMatchObject({ status: "DISCONTINUED", replacedBy: "HPS-1001" });
  });

  it("sells HPS-1409 and HPS-1410 per EA", async () => {
    const db = await ingestedDatabase();

    const foil = await db.select().from(products).where(eq(products.sku, "HPS-1409"));
    const clingFilm = await db.select().from(products).where(eq(products.sku, "HPS-1410"));

    expect(foil[0]?.sellUom).toBe("EA");
    expect(clingFilm[0]?.sellUom).toBe("EA");
  });

  it("stores E011's body intact", async () => {
    const db = await ingestedDatabase();
    const packLine = readFileSync(path.join(dataPackDirectory, "emails.jsonl"), "utf8")
      .split("\n")
      .find((line) => line.includes('"email_id": "E011"'));
    const packBody: unknown = JSON.parse(packLine ?? "{}").body;

    const [email] = await db.select().from(emails).where(eq(emails.emailId, "E011"));

    expect(typeof packBody).toBe("string");
    expect(email?.body).toBe(packBody);
    expect(email?.body).toContain("Buenos dias,\n\nPor favor envien:");
  });

  it("types quantities, dates, flags and timestamps", async () => {
    const db = await ingestedDatabase();

    const [stock] = await db.select().from(inventory).where(eq(inventory.sku, "HPS-1001"));
    const [order] = await db.select().from(salesOrders).where(eq(salesOrders.soNumber, "SO-24040"));
    const [shipTo] = await db.select().from(shipToAddresses).where(eq(shipToAddresses.shipToId, "S004"));
    const [email] = await db.select().from(emails).where(eq(emails.emailId, "E001"));

    expect(stock).toEqual({ sku: "HPS-1001", onHand: 70, allocated: 10, available: 60 });
    expect(order).toMatchObject({ customerPo: null, orderDate: "2026-10-12", status: "SHIPPED" });
    expect(shipTo?.isDefault).toBe(false);
    expect(email?.receivedAt.toISOString()).toBe("2026-11-02T12:02:00.000Z");
  });

  it("refuses a status the schema does not know", async () => {
    const db = await ingestedDatabase();

    await expect(
      db.execute(`update customers set status = 'SUSPENDED' where customer_id = 'C001'`),
    ).rejects.toThrow();
  });

  it("Reset restores the Snapshot after rows were changed", async () => {
    const db = await ingestedDatabase();
    await db.update(inventory).set({ allocated: 70 }).where(eq(inventory.sku, "HPS-1001"));
    await db.delete(emails).where(eq(emails.emailId, "E040"));
    await db.insert(appSettings).values({ key: "left_over", value: "yes" });

    await resetToSnapshot(db, snapshot);

    const [stock] = await db.select().from(inventory).where(eq(inventory.sku, "HPS-1001"));
    expect(stock?.available).toBe(60);
    expect(await rowCounts(db)).toEqual(packCounts);
    expect(await db.$count(appSettings)).toBe(0);
  });

  it("Reset is one transaction: a failure part-way leaves the previous data", async () => {
    const db = await ingestedDatabase();
    await db.update(inventory).set({ allocated: 70 }).where(eq(inventory.sku, "HPS-1001"));
    // Emails load last, so a duplicate id there fails after every other table was reloaded.
    const brokenSnapshot: Snapshot = {
      ...snapshot,
      emails: [...snapshot.emails, ...snapshot.emails.slice(0, 1)],
    };

    await expect(resetToSnapshot(db, brokenSnapshot)).rejects.toThrow();

    const [stock] = await db.select().from(inventory).where(eq(inventory.sku, "HPS-1001"));
    expect(stock?.allocated).toBe(70);
    expect(await rowCounts(db)).toEqual(packCounts);
  });
});
