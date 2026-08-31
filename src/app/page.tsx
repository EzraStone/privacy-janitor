"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Identity, Listing, ScanRun, Submission, SubmissionStatus } from "@/types"
import type { ExposureReport } from "@/scoring"

interface StateResponse {
  identities: Identity[]
  listings: Listing[]
  submissions: Submission[]
  scans: ScanRun[]
}

const statusLabel: Record<SubmissionStatus, string> = {
  prepared: "Awaiting your approval",
  approved: "Submitting…",
  submitted: "Submitted to broker",
  awaiting_email: "Waiting on email confirmation",
  confirmed: "Confirmed — removal in progress",
  removed: "Removed ✓ (verified by re-scan)",
  failed: "Failed — see error",
  cancelled: "Cancelled",
}

export default function Home() {
  const [state, setState] = useState<StateResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ExposureReport | null>(null)
  const [contactEmail, setContactEmail] = useState("")
  const [confirmUrl, setConfirmUrl] = useState<Record<string, string>>({})
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state")
    if (res.ok) setState(await res.json())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while a scan is running so results stream in.
  useEffect(() => {
    const scanActive = state?.scans.some((s) => !s.finishedAt)
    if (scanActive && !pollRef.current) {
      pollRef.current = setInterval(() => void refresh(), 4000)
    } else if (!scanActive && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [state, refresh])

  async function action(body: Record<string, unknown>, label: string) {
    setBusy(label)
    setError(null)
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "action failed")
      if (body.action === "score") setReport(json.report)
      await refresh()
      return json
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed")
      return null
    } finally {
      setBusy(null)
    }
  }

  async function stateAction(body: Record<string, unknown>, label: string) {
    setBusy(label)
    setError(null)
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "action failed")
      await refresh()
      return json
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed")
      return null
    } finally {
      setBusy(null)
    }
  }

  const identity = state?.identities[0]
  const confirmedListings = (state?.listings ?? []).filter((l) => l.confirmedMine === true)
  const pendingListings = (state?.listings ?? []).filter((l) => l.confirmedMine === null)
  const activeScan = state?.scans.find((s) => !s.finishedAt)

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">
          Privacy<span className="text-emerald-400">Janitor</span>
        </h1>
        <p className="text-zinc-400 text-sm">
          Local-first data-broker removal agent. Your data lives in{" "}
          <code className="text-zinc-300">data/privacy-janitor.db</code> on this machine — nowhere
          else. Nothing is submitted anywhere without your approval.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ── Step 1: identity ─────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
        <h2 className="font-semibold text-lg">1. Who are we scrubbing?</h2>
        {identity ? (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-zinc-300">
              <span className="font-medium">{identity.fullName}</span> · {identity.city},{" "}
              {identity.stateCode}
              {identity.ageRange ? ` · ${identity.ageRange}` : ""}
            </p>
            <div className="flex gap-3">
              <button
                className="btn-primary"
                disabled={!!busy || !identity}
                onClick={() => void stateAction({ action: "scan", identityId: identity.id }, "scan")}
              >
                {activeScan ? "Scanning…" : busy === "scan" ? "Starting…" : "Run broker scan"}
              </button>
            </div>
          </div>
        ) : (
          <IdentityForm
            onSave={async (i) => {
              await stateAction({ action: "save-identity", identity: i }, "identity")
            }}
          />
        )}
        {activeScan && (
          <p className="text-xs text-zinc-500">
            Scan running against all brokers — pages stream in below as each finishes (polling
            every 4s).
          </p>
        )}
      </section>

      {/* ── Step 2: disambiguation ───────────────────────────────────── */}
      {pendingListings.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
          <h2 className="font-semibold text-lg">2. Is this you?</h2>
          <p className="text-sm text-zinc-400">
            Confirm each listing before anything is removed — namesakes are common and wrong
            removals are irreversible trouble.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {pendingListings.map((l) => (
              <ListingCard key={l.id} listing={l} store={state} mode="disambiguate"
                onConfirm={() => void stateAction({ action: "confirm-listing", listingId: l.id }, `c-${l.id}`)}
                onReject={() => void stateAction({ action: "reject-listing", listingId: l.id }, `c-${l.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Step 3: exposure score ───────────────────────────────────── */}
      {confirmedListings.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="font-semibold text-lg">3. Exposure score</h2>
            <button
              className="btn-primary"
              disabled={!!busy}
              onClick={() =>
                void action({ action: "score", identityId: identity?.id }, "score")
              }
            >
              {busy === "score" ? "Scoring (redacted, via Groq)…" : "Rank my exposure"}
            </button>
          </div>
          {report ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-300">
                Overall exposure:{" "}
                <span className="font-bold text-amber-400">{report.totalScore}/100</span>
                <span className="text-zinc-500"> · model {report.model}</span>
              </p>
              <p className="text-sm text-zinc-400">{report.summary}</p>
              <div className="space-y-2">
                {report.rankings.map((r) => {
                  const listing = confirmedListings.find((l) => l.id === r.listingId)
                  return (
                    <div key={r.listingId} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm space-y-1">
                      <div className="flex justify-between font-medium">
                        <span>{listing?.displayName} · {r.brokerId}</span>
                        <span className="text-amber-400">{r.score}/100</span>
                      </div>
                      <p className="text-zinc-400">{r.rationale}</p>
                      <p className="text-emerald-400">→ {r.recommendedAction}</p>
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-zinc-500">
                LLM saw tokenized placeholders only ([NAME_1], [ADDR_1] …) — no real PII left this
                machine.
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              {confirmedListings.length} confirmed listing(s). Rank them by risk to know which to
              kill first (optional — requires GROQ_API_KEY).
            </p>
          )}
        </section>
      )}

      {/* ── Step 4: opt-out queue ────────────────────────────────────── */}
      {confirmedListings.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
          <h2 className="font-semibold text-lg">4. Opt-out queue</h2>
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <label className="text-zinc-400">
              Contact email brokers will see:
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="you@example.com"
                className="input-std ml-2"
              />
            </label>
          </div>
          <div className="space-y-3">
            {confirmedListings.map((l) => {
              const sub = (state?.submissions ?? []).find((s) => s.listingId === l.id)
              return (
                <OptOutRow
                  key={l.id}
                  listing={l}
                  sub={sub}
                  busy={busy}
                  contactEmail={contactEmail}
                  confirmUrl={confirmUrl[l.id] ?? ""}
                  onConfirmUrlChange={(v) => setConfirmUrl((m) => ({ ...m, [l.id]: v }))}
                  onPrepare={() => void action({ action: "prepare-optout", listingId: l.id, contactEmail }, `p-${l.id}`)}
                  onApprove={() => void action({ action: "approve-optout", listingId: l.id }, `a-${l.id}`)}
                  onCancel={() => void action({ action: "cancel-optout", listingId: l.id }, `x-${l.id}`)}
                  onConfirmEmail={() => void action({ action: "confirm-email", listingId: l.id, confirmationUrl: confirmUrl[l.id] }, `e-${l.id}`)}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* ── Step 5: rescan ───────────────────────────────────────────── */}
      {confirmedListings.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-3">
          <h2 className="font-semibold text-lg">5. Verify removals</h2>
          <p className="text-sm text-zinc-400">
            Brokers relist data. Re-run the scan after a few days — the diff shows removed,
            still-listed, and relisted records. (Re-scan button runs the same flow as Step 1.)
          </p>
          <button
            className="btn-secondary"
            disabled={!!busy || !identity}
            onClick={() => void stateAction({ action: "scan", identityId: identity?.id }, "scan")}
          >
            Re-scan & diff
          </button>
        </section>
      )}

      {state && state.scans.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-3">
          <h2 className="font-semibold text-lg">Scan history</h2>
          <div className="space-y-2 text-sm">
            {[...state.scans].reverse().map((s) => (
              <div key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-zinc-300">
                  {new Date(s.startedAt).toLocaleString()} —{" "}
                  {s.finishedAt ? `${s.results.length} broker(s) done` : "running…"}
                </div>
                <div className="mt-1 space-y-1">
                  {s.results.map((r) => (
                    <div key={r.brokerId} className={r.ok ? "text-emerald-400" : "text-red-400"}>
                      {r.brokerId}: {r.ok ? `${r.listingsFound} listing(s)` : `error — ${r.error}`}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}

function IdentityForm({ onSave }: { onSave: (i: Partial<Identity>) => Promise<void> }) {
  const [fullName, setFullName] = useState("")
  const [city, setCity] = useState("")
  const [stateCode, setStateCode] = useState("")
  const [ageRange, setAgeRange] = useState("")
  const [saving, setSaving] = useState(false)

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        await onSave({ fullName, city, stateCode, ageRange: ageRange || undefined })
        setSaving(false)
      }}
    >
      <input className="input-std" placeholder="Full name (First Last)" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      <input className="input-std" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} required />
      <input className="input-std" placeholder="State code (e.g. WA)" maxLength={2} value={stateCode} onChange={(e) => setStateCode(e.target.value)} required />
      <input className="input-std" placeholder="Age range (optional, e.g. 25-30)" value={ageRange} onChange={(e) => setAgeRange(e.target.value)} />
      <button className="btn-primary sm:col-span-2" disabled={saving || !fullName || !city || !stateCode}>
        {saving ? "Saving…" : "Save & scan-ready"}
      </button>
    </form>
  )
}

function ListingCard({
  listing, store, mode, onConfirm, onReject,
}: {
  listing: Listing
  store: StateResponse | null
  mode: "disambiguate" | "queue"
  onConfirm?: () => void
  onReject?: () => void
}) {
  const e = listing.exposedData
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 space-y-2 text-sm">
      <div className="font-medium">{listing.displayName}</div>
      <div className="text-zinc-400">{listing.brokerId}</div>
      {e.addresses?.length ? <div>📍 {e.addresses.slice(0, 2).join(" · ")}</div> : null}
      {e.phones?.length ? <div>📞 {e.phones.slice(0, 2).join(" · ")}</div> : null}
      {e.age ? <div>👤 age {e.age}</div> : null}
      {e.relatives?.length ? <div>👥 {e.relatives.slice(0, 3).join(" · ")}</div> : null}
      <a href={listing.url} target="_blank" className="link-std block truncate">
        {listing.url}
      </a>
      {mode === "disambiguate" && (
        <div className="flex gap-2 pt-1">
          <button className="btn-primary" onClick={onConfirm}>This is me</button>
          <button className="btn-secondary" onClick={onReject}>Not me</button>
        </div>
      )}
      {listing.screenshotPath && mode === "disambiguate" && (
        <EvidenceImage path={listing.screenshotPath} />
      )}
      <span className="sr-only">{store?.identities.length ?? 0}</span>
    </div>
  )
}

function EvidenceImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    // Path may be a directory (scan evidence) — try the standard file name.
    const file = path.replace(/\\/g, "/").endsWith(".png")
      ? path.replace(/\\/g, "/")
      : `${path.replace(/\\/g, "/")}/scan-result.png`
    setSrc(`/api/evidence?file=${encodeURIComponent(file)}`)
  }, [path])
  if (!src) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="listing evidence" className="mt-2 rounded border border-zinc-800 max-h-64 w-full object-cover object-top" />
}

function OptOutRow({
  listing, sub, busy, contactEmail, confirmUrl, onConfirmUrlChange,
  onPrepare, onApprove, onCancel, onConfirmEmail,
}: {
  listing: Listing
  sub?: Submission
  busy: string | null
  contactEmail: string
  confirmUrl: string
  onConfirmUrlChange: (v: string) => void
  onPrepare: () => void
  onApprove: () => void
  onCancel: () => void
  onConfirmEmail: () => void
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-medium">{listing.displayName}</div>
          <div className="text-zinc-400">{listing.brokerId}</div>
        </div>
        <div className={sub?.status === "failed" ? "text-red-400" : sub?.status === "removed" ? "text-emerald-400" : "text-zinc-400"}>
          {sub ? statusLabel[sub.status] : "Not started"}
        </div>
      </div>

      {sub?.lastError && <div className="text-red-400 text-xs">{sub.lastError}</div>}

      {/* preview evidence after prepare */}
      {sub?.previewScreenshotPath && (
        <div className="space-y-1">
          <p className="text-zinc-400">Filled form preview — approve before we submit:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/evidence?file=${encodeURIComponent(sub.previewScreenshotPath.replace(/\\/g, "/"))}`}
            alt="opt-out form preview"
            className="rounded border border-zinc-800 max-h-96 w-full object-cover object-top"
          />
        </div>
      )}

      {!sub && (
        <button className="btn-primary" disabled={!contactEmail || !!busy} onClick={onPrepare} title={!contactEmail ? "Set a contact email above first" : ""}>
          {busy === `p-${listing.id}` ? "Filling form (Solari session)…" : "Prepare opt-out"}
        </button>
      )}

      {sub?.status === "prepared" && (
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" disabled={!!busy} onClick={onApprove}>
            {busy === `a-${listing.id}` ? "Submitting…" : "Approve & submit"}
          </button>
          <button className="btn-secondary" disabled={!!busy} onClick={onCancel}>Cancel</button>
        </div>
      )}

      {(sub?.status === "awaiting_email" || sub?.status === "submitted") && (
        <div className="space-y-2">
          <p className="text-zinc-400">
            Check your inbox for the broker&apos;s confirmation email, paste the link here, and
            we&apos;ll click it in a recorded session:
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              className="input-std flex-1 min-w-64"
              placeholder="https://…confirmation-link…"
              value={confirmUrl}
              onChange={(e) => onConfirmUrlChange(e.target.value)}
            />
            <button className="btn-primary" disabled={!confirmUrl || !!busy} onClick={onConfirmEmail}>
              {busy === `e-${listing.id}` ? "Confirming…" : "Confirm removal"}
            </button>
          </div>
        </div>
      )}

      {sub?.resultScreenshotPath && (
        <div className="space-y-1">
          <p className="text-zinc-400">Submit result:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/evidence?file=${encodeURIComponent(sub.resultScreenshotPath.replace(/\\/g, "/"))}`}
            alt="opt-out result"
            className="rounded border border-zinc-800 max-h-96 w-full object-cover object-top"
          />
        </div>
      )}
    </div>
  )
}
