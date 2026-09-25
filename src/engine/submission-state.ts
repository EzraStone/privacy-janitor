import type { SubmissionStatus } from "../types.ts"

export const activeSubmissionStatuses: SubmissionStatus[] = [
  "prepared", "approved", "submitting", "submitted", "awaiting_email",
  "confirming", "confirmed", "attention_required",
]

const transitions: Record<SubmissionStatus, SubmissionStatus[]> = {
  prepared: ["approved", "cancelled"],
  approved: ["submitting", "failed", "cancelled"],
  submitting: ["awaiting_email", "submitted", "attention_required"],
  // A sent request the broker ignored may be closed so a new one can be made.
  submitted: ["removed", "failed"],
  awaiting_email: ["confirming"],
  confirming: ["confirmed", "attention_required"],
  confirmed: ["removed", "failed"],
  attention_required: ["approved", "confirming", "cancelled"],
  removed: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return transitions[from].includes(to)
}
