/** Registry of all broker adapters. The engine iterates this. */
import type { BrokerAdapter } from "@/types"
import { whitepages } from "./whitepages.ts"
import { spokeo } from "./spokeo.ts"
import { fastpeoplesearch } from "./fastpeoplesearch.ts"

export const adapters: BrokerAdapter[] = [whitepages, spokeo, fastpeoplesearch]

export function getAdapter(brokerId: string): BrokerAdapter {
  const a = adapters.find((x) => x.id === brokerId)
  if (!a) throw new Error(`no adapter registered for broker '${brokerId}'`)
  return a
}
