import { is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "@/db/database";
import {
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
import * as schema from "@/db/schema";
import { readDataPack, type Snapshot } from "./data-pack";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Loads the Snapshot into an empty database, in one transaction.
export async function ingestSnapshot(db: Database, snapshot: Snapshot = readDataPack()): Promise<void> {
  await db.transaction((tx) => insertSnapshot(tx, snapshot));
}

// The Reset: empties every app table and reloads the Snapshot, in one transaction, so a failure
// part-way leaves the data as it was. The seed is the same ingest that builds a fresh database.
export async function resetToSnapshot(db: Database, snapshot: Snapshot = readDataPack()): Promise<void> {
  await db.transaction(async (tx) => {
    await truncateAppTables(tx);
    await insertSnapshot(tx, snapshot);
  });
}

// Every table the schema declares, so a table a later migration adds is emptied too. Drizzle's
// migration journal is not in the schema and is left alone.
async function truncateAppTables(tx: Transaction): Promise<void> {
  const tables = Object.values(schema).filter((value) => is(value, PgTable));
  await tx.execute(sql`truncate table ${sql.join(tables, sql`, `)} restart identity cascade`);
}

// Parents before children, so every foreign key finds its row.
async function insertSnapshot(tx: Transaction, snapshot: Snapshot): Promise<void> {
  await tx.insert(customers).values(snapshot.customers);
  await tx.insert(customerContacts).values(snapshot.customerContacts);
  await tx.insert(shipToAddresses).values(snapshot.shipToAddresses);
  await tx.insert(products).values(snapshot.products);
  await tx.insert(customerPrices).values(snapshot.customerPrices);
  await tx.insert(inventory).values(snapshot.inventory);
  await tx.insert(incomingSupply).values(snapshot.incomingSupply);
  await tx.insert(salesOrders).values(snapshot.salesOrders);
  await tx.insert(salesOrderLines).values(snapshot.salesOrderLines);
  await tx.insert(emails).values(snapshot.emails);
}
