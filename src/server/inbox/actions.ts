"use server";

import { revalidatePath } from "next/cache";
import { getDatabase } from "@/db/client";
import { requireRole } from "@/server/auth/current-user";
import { dismissTip } from "./inbox";

// The tip card stays dismissed for this person on every device (DESIGN.md, "Tip card").
export async function dismissTipAction(): Promise<void> {
  const user = await requireRole("reviewer");
  await dismissTip(getDatabase(), user.id, new Date());
  revalidatePath("/");
}
