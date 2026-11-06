import { getDatabase } from "@/db/client";
import { checkHealth } from "@/server/health";

export function GET(): Promise<Response> {
  return checkHealth(getDatabase);
}
