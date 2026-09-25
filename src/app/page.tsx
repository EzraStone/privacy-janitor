"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Identity, Listing, MatchExplanation, ScanRun, Submission, SubmissionStatus } from "@/types"
import type { ExposureReport } from "@/scoring"
import { activeSubmissionStatuses } from "@/engine/submission-state"
import type { SetupStatus } from "@/config/setup"
import { SetupPanel } from "./setup-panel"

interface StateResponse {
  identities: Identity[]
  listings: Listing[]
  submissions: Submission[]
  scans: ScanRun[]
  matchHints?: Record<string, MatchExplanation>
}

const statusLabel: Record<SubmissionStatus, string> = {
  prepared: "Awaiting your approval",
  approved: "Approved — queued",
  submitting: "Submitting…",
  submitted: "Submitted to broker",
  awaiting_email: "Waiting on email confirmation",
  confirmed: "Confirmed — removal in progress",
  confirming: "Confirming…",
  attention_required: "Review needed — outcome uncertain",
  removed: "Removed ✓ (verified by re-scan)",
  failed: "Failed — see error",
  cancelled: "Cancelled",
}

export default function Home() {
  const [state, setState] = useState<StateResponse | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [checkingSetup, setCheckingSetup] = useState(false)
  const [report, setReport] = useState<ExposureReport | null>(null)
  const [contactEmail, setContactEmail] = useState("")
  const [confirmUrl, setConfirmUrl] = useState<Record<string, string>>({})
  const [activeIdentityId, setActiveIdentityId] = useState<string | null>(null)
  const [showIdentityForm, setShowIdentityForm] = useState(false)
  const [editingIdentity, setEditingIdentity] = useState<Identity | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Could not load local data.")
      setState(json)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not reach the local app.")
    }
  }, [])

  const refreshSetup = useCallback(async () => {
    setCheckingSetup(true)
    try {
      const res = await fetch("/api/setup", { cache: "no-store" })
      if (!res.ok) throw new Error("Setup check unavailable. Restart the local app and try again.")
      setSetup(await res.json())
      setSetupError(null)
    } catch (error) {
      setSetup(null)
      setSetupError(error instanceof Error ? error.message : "Could not check local setup.")
    } finally {
      setCheckingSetup(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshSetup()
  }, [refresh, refreshSetup])

  // Default to first identity when none is selected.
  useEffect(() => {
    if (!activeIdentityId && state?.identities.length) {
      setActiveIdentityId(state.identities[0].id)
    }
  }, [state, activeIdentityId])

  // Poll while a scan is running so results stream in.
  useEffect(() => {
    const scanActive = state?.scans.some((s) => !s.finishedAt) ||
      state?.submissions.some((s) => ["approved", "submitting", "confirming"].includes(s.status))
    if (scanActive && !pollRef.current) {
      pollRef.current = setInterval(() => void refresh(), 4000)
    } else if (!scanActive && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
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

  async function deleteIdentity(id: string, name: string) {
    if (
      !window.confirm(
        `Delete profile "${name}"?\n\nThis permanently removes their listings, submissions, and all local evidence screenshots. Broker-side opt-outs already submitted stay submitted.`,
      )
    )
      return
    await stateAction({ action: "delete-identity", identityId: id }, `del-${id}`)
    if (activeIdentityId === id) {
      setActiveIdentityId(null)
      setReport(null)
    }
  }

  async function resetAll() {
    if (
      !window.confirm(
        "Reset EVERYTHING?\n\nAll profiles, listings, submissions, and evidence are permanently deleted. This cannot be undone.",
      )
    )
      return
    await stateAction({ action: "reset-all" }, "reset")
    setActiveIdentityId(null)
    setReport(null)
  }

  const identity = state?.identities.find((i) => i.id === activeIdentityId) ?? null
  const scopedListings = (state?.listings ?? []).filter((l) => l.identityId === activeIdentityId)
  const scopedSubmissions = (state?.submissions ?? []).filter((s) =>
    scopedListings.some((l) => l.id === s.listingId),
  )
  const scopedScans = (state?.scans ?? []).filter((s) => s.identityId === activeIdentityId)
  const confirmedListings = scopedListings.filter((l) => l.confirmedMine === true)
  const presentConfirmedListings = confirmedListings.filter((l) => l.presenceStatus !== "absent")
  const pendingListings = scopedListings.filter(
    (l) => l.confirmedMine === null && l.presenceStatus !== "absent",
  )
  const rejectedListings = scopedListings.filter(
    (l) => l.confirmedMine === false && l.presenceStatus !== "absent",
  )
  const activeScan = scopedScans.find((s) => !s.finishedAt)
  const latestRescan = scopedScans.find((s) => s.kind === "rescan")
  // Rescan events cover every record on each broker. Name the listing each one
  // is about (brokers often hold several per person), and leave out records
  // already marked as someone else.
  const rescanChanges = (latestRescan?.events ?? []).flatMap((event) => {
    const listing = scopedListings.find((l) => l.id === event.listingId)
    return listing?.confirmedMine === false ? [] : [{ event, listing }]
  })

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-5 py-12 sm:px-8 sm:py-16">
      <header className="border-b border-white/10 pb-10">
        <p className="eyebrow mb-4">Local-first privacy workspace</p>
        <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
          Privacy<span className="font-light text-muted">Janitor</span>
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">
          Profiles, findings, and evidence are saved locally in{" "}
          <code className="rounded bg-white/5 px-1.5 py-0.5 text-zinc-300">data/</code>.
          Searches and form previews send details to Solari and the broker sites.
          Removal requests require your approval. Solari sessions are recorded remotely.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-white/20 bg-white/[0.04] px-4 py-3 text-sm text-zinc-200">
          <span className="mr-2 font-semibold text-white">Something went wrong.</span>{error}
        </div>
      )}

      {loadError && (
        <div role="alert" className="rounded-xl border border-white/20 p-4 text-sm text-zinc-300">
          <p>Local data could not be refreshed: {loadError}</p>
          <button className="btn-secondary mt-3" onClick={() => void refresh()}>Retry loading data</button>
        </div>
      )}

      <SetupPanel status={setup} error={setupError} checking={checkingSetup} onCheck={() => void refreshSetup()} />

      {/* ── Profile bar ─────────────────────────────────────────────── */}
      <section className="panel space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="eyebrow">01 / Profiles</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">Who are we protecting?</h2>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => {
                setEditingIdentity(null)
                setShowIdentityForm((v) => !v)
              }}
            >
              + Add profile
            </button>
            {identity && (
              <button
                className="btn-secondary"
                onClick={() => {
                  setEditingIdentity(identity)
                  setShowIdentityForm(true)
                }}
              >
                Edit
              </button>
            )}
            {identity && (
              <button
                className="btn-danger"
                disabled={!!busy}
                onClick={() => void deleteIdentity(identity.id, identity.fullName)}
              >
                Delete profile
              </button>
            )}
            {state && (state.identities.length > 0 || state.listings.length > 0) && (
              <button className="btn-danger" disabled={!!busy} onClick={() => void resetAll()}>
                Reset all
              </button>
            )}
          </div>
        </div>

        {/* profile selector */}
        {state && state.identities.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {state.identities.map((i) => (
              <button
                key={i.id}
                onClick={() => {
                  setActiveIdentityId(i.id)
                  setReport(null)
                }}
                className={
                  i.id === activeIdentityId
                    ? "rounded-xl border border-white bg-white px-4 py-3 text-left text-sm font-semibold text-black"
                    : "rounded-xl border border-white/10 bg-black px-4 py-3 text-left text-sm text-zinc-300 transition hover:border-white/40"
                }
              >
                {i.fullName}
                <span className={i.id === activeIdentityId ? "text-black/60" : "text-muted"}>
                  {" "}
                  · {i.city}, {i.stateCode}
                </span>
              </button>
            ))}
          </div>
        )}

        {(showIdentityForm || state?.identities.length === 0) && (
          <IdentityForm
            key={editingIdentity?.id ?? "new"}
            existing={editingIdentity}
            onCancel={
              state?.identities.length
                ? () => {
                    setShowIdentityForm(false)
                    setEditingIdentity(null)
                  }
                : undefined
            }
            onSave={async (i) => {
              const res = await stateAction(
                { action: "save-identity", identity: i },
                "identity",
              )
              if (res?.identity) {
                setActiveIdentityId(res.identity.id as string)
                setReport(null)
                setShowIdentityForm(false)
                setEditingIdentity(null)
              }
            }}
          />
        )}

        {state?.identities.length === 0 && (
          <p className="text-sm leading-6 text-muted">
            No profiles yet — add the person whose data-broker listings you want to find and
            remove. (You can manage multiple people: yourself, family members with their
            consent, etc.)
          </p>
        )}
      </section>

      {/* ── Scan ────────────────────────────────────────────────────── */}
      {identity && (
        <section className="panel space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="eyebrow">02 / Scan</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">Scan for {identity.fullName}</h2>
              <p className="mt-1 text-sm text-muted">
                Searches all brokers for this profile&apos;s data.
              </p>
            </div>
            <button
              className="btn-primary"
              disabled={!!busy || !identity || Boolean(activeScan) || !setup?.canStartScan}
              onClick={() => void stateAction({ action: "scan", identityId: identity.id }, "scan")}
            >
              {activeScan ? "Scanning…" : busy === "scan" ? "Starting…" : "Run broker scan"}
            </button>
          </div>
          {activeScan && (
            <p className="text-xs text-muted">
              Scan running — results stream in below as each broker finishes (polling every 4s).
            </p>
          )}
        </section>
      )}

      {/* ── Disambiguation ───────────────────────────────────────────── */}
      {identity && pendingListings.length > 0 && (
        <section className="panel space-y-4">
          <p className="eyebrow">03 / Review matches</p>
          <h2 className="text-xl font-semibold tracking-tight">Is this {identity.fullName}?</h2>
          <p className="text-sm leading-6 text-muted">
            Confirm each listing before anything is removed — namesakes are common and wrong
            removals cause real trouble. Each card notes which details match your profile;
            the hints never decide for you.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {pendingListings.map((l) => (
              <ListingCard key={l.id} listing={l} match={state?.matchHints?.[l.id]}
                onConfirm={() => void stateAction({ action: "confirm-listing", listingId: l.id }, `c-${l.id}`)}
                onReject={() => void stateAction({ action: "reject-listing", listingId: l.id }, `c-${l.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {identity && rejectedListings.length > 0 && (
        <details className="panel space-y-4">
          <summary className="cursor-pointer text-sm text-zinc-400">
            Marked not you ({rejectedListings.length})
          </summary>
          <p className="text-sm leading-6 text-muted">
            Clicked “Not me” by mistake? Send the listing back to review.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {rejectedListings.map((l) => (
              <ListingCard key={l.id} listing={l}
                onReviewAgain={() => void stateAction({ action: "review-listing", listingId: l.id }, `r-${l.id}`)}
              />
            ))}
          </div>
        </details>
      )}

      {/* ── Exposure score ──────────────────────────────────────────── */}
      {identity && presentConfirmedListings.length > 0 && (
        <section className="panel space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="eyebrow">04 / Prioritize</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">Exposure score</h2>
            </div>
            <button
              className="btn-primary"
              disabled={!!busy || setup?.groq !== "configured"}
              onClick={() => void action({ action: "score", identityId: identity.id }, "score")}
            >
              {busy === "score" ? "Scoring (redacted, via Groq)…" : "Rank my exposure"}
            </button>
          </div>
          {report ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-300">
                Overall exposure:{" "}
                <span className="font-bold text-white">{report.totalScore}/100</span>
                <span className="text-muted"> · model {report.model}</span>
              </p>
              <p className="text-sm text-zinc-400">{report.summary}</p>
              <div className="space-y-2">
                {report.rankings.map((r) => {
                  const listing = presentConfirmedListings.find((l) => l.id === r.listingId)
                  return (
                    <div key={r.listingId} className="card space-y-1 text-sm">
                      <div className="flex justify-between font-medium">
                        <span>{listing?.displayName} · {r.brokerId}</span>
                        <span className="text-white">{r.score}/100</span>
                      </div>
                      <p className="text-zinc-400">{r.rationale}</p>
                      <p className="text-zinc-200">→ {r.recommendedAction}</p>
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted">
                Optional Groq scoring receives tokenized listing and profile-location fields;
                redaction reduces disclosure but does not guarantee anonymity. Skip scoring
                if you do not want to send this information to Groq.
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              {presentConfirmedListings.length} visible confirmed listing(s) for {identity.fullName}. Rank them
              by risk to know which to kill first (optional — requires GROQ_API_KEY).
            </p>
          )}
        </section>
      )}

      {/* ── Opt-out queue ────────────────────────────────────────────── */}
      {identity && confirmedListings.length > 0 && (
        <section className="panel space-y-4">
          <p className="eyebrow">05 / Remove</p>
          <h2 className="text-xl font-semibold tracking-tight">Opt-out queue</h2>
          <div className="max-w-md text-sm">
            <label className="field-label">
              Contact email brokers will see
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="you@example.com"
                className="input-std"
              />
            </label>
          </div>
          <div className="space-y-3">
            {confirmedListings.map((l) => {
              const sub = scopedSubmissions.find((s) => s.listingId === l.id && activeSubmissionStatuses.includes(s.status)) ??
                scopedSubmissions.find((s) => s.listingId === l.id)
              return (
                <OptOutRow
                  key={l.id}
                  listing={l}
                  sub={sub}
                  busy={busy}
                  remoteReady={setup?.canStartScan === true}
                  contactEmail={contactEmail}
                  confirmUrl={confirmUrl[l.id] ?? ""}
                  onConfirmUrlChange={(v) => setConfirmUrl((m) => ({ ...m, [l.id]: v }))}
                  onPrepare={() => void action({ action: "prepare-optout", listingId: l.id, contactEmail }, `p-${l.id}`)}
                  onApprove={(retryAcknowledged = false) => void action({ action: "approve-optout", listingId: l.id, submissionId: sub?.id, retryAcknowledged }, `a-${l.id}`)}
                  onCancel={() => void action({ action: "cancel-optout", listingId: l.id, submissionId: sub?.id }, `x-${l.id}`)}
                  onConfirmEmail={(retryAcknowledged = false) => void action({ action: "confirm-email", listingId: l.id, submissionId: sub?.id, confirmationUrl: confirmUrl[l.id], retryAcknowledged }, `e-${l.id}`)}
                  onReviewAgain={() => void stateAction({ action: "review-listing", listingId: l.id }, `r-${l.id}`)}
                  onReopen={() => void action({ action: "reopen-removal", listingId: l.id, submissionId: sub?.id }, `o-${l.id}`)}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* ── Rescan ──────────────────────────────────────────────────── */}
      {identity && confirmedListings.length > 0 && (
        <section className="panel space-y-3">
          <p className="eyebrow">06 / Verify</p>
          <h2 className="text-xl font-semibold tracking-tight">Verify removals</h2>
          <p className="text-sm leading-6 text-muted">
            Brokers relist data. Re-run the scan after a few days — removed listings that
            reappear get flagged. A blocked or unfamiliar broker page is reported as
            inconclusive and never counted as a removal.
          </p>
          <button
            className="btn-secondary"
            disabled={!!busy || Boolean(activeScan) || !setup?.canStartScan}
            onClick={() => void stateAction({ action: "rescan", identityId: identity.id }, "rescan")}
          >
            {activeScan?.kind === "rescan" || busy === "rescan" ? "Verifying…" : "Re-scan & diff"}
          </button>
          {latestRescan?.finishedAt && (
            <div className="card space-y-2 text-sm">
              <div className="font-medium text-zinc-200">
                Latest verification: {latestRescan.results.some((r) => r.outcome === "inconclusive")
                  ? "incomplete — review broker warnings"
                  : "complete"}
              </div>
              {rescanChanges.length === 0 ? (
                <p className="text-muted">No changes to your listings were recorded.</p>
              ) : (
                <div className="space-y-1 text-zinc-400">
                  {rescanChanges.map(({ event, listing }) => (
                    <div key={`${event.brokerId}-${event.listingId}-${event.type}`}>
                      {event.brokerId}: {listing?.displayName ?? "a listing"}
                      {listing?.exposedData.addresses?.[0] ? ` (${listing.exposedData.addresses[0]})` : ""}
                      {" — "}{event.type.replaceAll("_", " ")}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Scan history (scoped) ─────────────────────────────────────── */}
      {identity && scopedScans.length > 0 && (
        <section className="panel space-y-3">
          <p className="eyebrow">Activity</p>
          <h2 className="text-xl font-semibold tracking-tight">Scan history — {identity.fullName}</h2>
          <div className="space-y-2 text-sm">
            {[...scopedScans].reverse().map((s) => (
              <div key={s.id} className="card">
                <div className="text-zinc-300">
                  {new Date(s.startedAt).toLocaleString()} · {s.kind} —{" "}
                  {s.finishedAt ? `${s.results.length} broker(s) done` : "running…"}
                </div>
                <div className="mt-1 space-y-1">
                  {s.results.map((r) => (
                    <div key={r.brokerId} className={r.ok ? "text-zinc-300" : "text-muted"}>
                      {r.outcome === "inconclusive" ? "⚠" : "✓"} {r.brokerId}: {r.outcome}
                      {r.outcome === "found" ? ` — ${r.listingsFound} listing(s)` : ""}
                      {r.error ? ` — ${r.error}` : ""}
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

function IdentityForm({
  existing,
  onSave,
  onCancel,
}: {
  existing: Identity | null
  onSave: (i: Partial<Identity>) => Promise<void>
  onCancel?: () => void
}) {
  const [fullName, setFullName] = useState(existing?.fullName ?? "")
  const [city, setCity] = useState(existing?.city ?? "")
  const [stateCode, setStateCode] = useState(existing?.stateCode ?? "")
  const [ageRange, setAgeRange] = useState(existing?.ageRange ?? "")
  const [relatives, setRelatives] = useState(existing?.relatives?.join(", ") ?? "")
  const [consent, setConsent] = useState(!!existing)
  const [saving, setSaving] = useState(false)

  return (
    <form
      className="grid gap-4 border-t border-white/10 pt-5 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        await onSave({
          id: existing?.id,
          createdAt: existing?.createdAt,
          fullName,
          city,
          stateCode,
          ageRange: ageRange || undefined,
          relatives: relatives
            ? relatives.split(",").map((r) => r.trim()).filter(Boolean)
            : undefined,
        })
        setSaving(false)
      }}
    >
      <label className="field-label">
        Full name
        <input className="input-std" placeholder="First Last" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </label>
      <label className="field-label">
        City
        <input className="input-std" placeholder="Chicago" value={city} onChange={(e) => setCity(e.target.value)} required />
      </label>
      <label className="field-label">
        State
        <input className="input-std" placeholder="IL" maxLength={2} value={stateCode} onChange={(e) => setStateCode(e.target.value)} required />
      </label>
      <label className="field-label">
        Age range <span className="font-normal text-muted">Optional</span>
        <input className="input-std" placeholder="25-30" value={ageRange} onChange={(e) => setAgeRange(e.target.value)} />
      </label>
      <label className="field-label sm:col-span-2">
        Relatives <span className="font-normal text-muted">Optional, comma-separated</span>
        <input
          className="input-std"
          placeholder="Improves match accuracy"
          value={relatives}
          onChange={(e) => setRelatives(e.target.value)}
        />
      </label>
      {!existing && (
        <label className="flex items-start gap-3 text-xs leading-5 text-muted sm:col-span-2">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1 size-4 accent-white"
          />
          I am searching for myself, or I have this person&apos;s permission to manage their
          broker-removal requests.
        </label>
      )}
      {existing && (
        <p className="text-xs leading-5 text-muted sm:col-span-2">
          If you change the name or location, run a new scan so saved matches can be refreshed.
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn-primary" disabled={saving || !fullName || !city || !stateCode || !consent}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add profile"}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

// Name and location alone never read as a strong match: they are exactly what
// a namesake shares. Only an agreeing age or relative earns the stronger line,
// and any contradiction leads.
function matchSummary(m: MatchExplanation): string {
  if (m.place === "elsewhere" || m.age === "outside") {
    return "Some details don’t fit your profile — this may be someone else."
  }
  const placeFits = m.place === "city_and_state" || m.place === "state"
  if (placeFits && m.name !== "other" && (m.age === "fits" || m.relatives === "shared")) {
    return "Name, location and a personal detail match your profile."
  }
  if (placeFits) return "Location matches — so would a namesake’s. Check age and relatives."
  return "Too few details to compare — open the listing before deciding."
}

// ✓ agrees, ✗ contradicts, – unknown or inconclusive; the words carry the meaning.
function matchDetails(m: MatchExplanation): Array<[string, string]> {
  const details: Array<[string, string]> = [
    m.name === "same" ? ["✓", "Same name as your profile"]
      : m.name === "similar" ? ["✓", "Similar name, such as a middle initial"]
        : ["–", "Name printed differently from your profile"],
    m.place === "city_and_state" ? ["✓", "An address in your city and state"]
      : m.place === "state" ? ["–", "An address in your state, another city"]
        : m.place === "elsewhere" ? ["✗", "No address in your state"]
          : ["–", "No address listed"],
  ]
  if (m.age) details.push(m.age === "fits" ? ["✓", "Age fits your profile’s range"] : ["✗", "Age outside your profile’s range"])
  if (m.relatives) details.push(m.relatives === "shared" ? ["✓", "Shares a relative’s first name"] : ["–", "No relatives in common"])
  return details
}

function MatchHint({ match }: { match: MatchExplanation }) {
  return (
    <div className="space-y-1 border-l border-white/20 pl-3 text-xs">
      <p className="text-zinc-300">{matchSummary(match)}</p>
      <ul className="space-y-0.5 text-muted">
        {matchDetails(match).map(([mark, text]) => (
          <li key={text}><span aria-hidden="true" className="inline-block w-4">{mark}</span>{text}</li>
        ))}
      </ul>
    </div>
  )
}

function ListingCard({
  listing, match, onConfirm, onReject, onReviewAgain,
}: {
  listing: Listing
  match?: MatchExplanation
  onConfirm?: () => void
  onReject?: () => void
  onReviewAgain?: () => void
}) {
  const e = listing.exposedData
  return (
    <div className="card space-y-2 text-sm">
      <div className="font-semibold tracking-tight">{listing.displayName}</div>
      <div className="eyebrow">{listing.brokerId}</div>
      {e.addresses?.length ? <div>📍 {e.addresses.slice(0, 2).join(" · ")}</div> : null}
      {e.phones?.length ? <div>📞 {e.phones.slice(0, 2).join(" · ")}</div> : null}
      {e.age ? <div>👤 age {e.age}</div> : null}
      {e.relatives?.length ? <div>👥 {e.relatives.slice(0, 3).join(" · ")}</div> : null}
      <a href={listing.url} target="_blank" rel="noopener noreferrer" className="link-std block truncate">
        {listing.url}
      </a>
      {match && <MatchHint match={match} />}
      {onConfirm && onReject && (
        <div className="flex gap-2 pt-1">
          <button className="btn-primary" onClick={onConfirm}>This is me</button>
          <button className="btn-secondary" onClick={onReject}>Not me</button>
        </div>
      )}
      {onReviewAgain && (
        <button className="btn-secondary" onClick={onReviewAgain}>Review again</button>
      )}
    </div>
  )
}

function OptOutRow({
  listing, sub, busy, remoteReady, contactEmail, confirmUrl, onConfirmUrlChange,
  onPrepare, onApprove, onCancel, onConfirmEmail, onReviewAgain, onReopen,
}: {
  listing: Listing
  sub?: Submission
  busy: string | null
  remoteReady: boolean
  contactEmail: string
  confirmUrl: string
  onConfirmUrlChange: (v: string) => void
  onPrepare: () => void
  onApprove: (retryAcknowledged?: boolean) => void
  onCancel: () => void
  onConfirmEmail: (retryAcknowledged?: boolean) => void
  onReviewAgain: () => void
  onReopen: () => void
}) {
  const [retryAcknowledged, setRetryAcknowledged] = useState(false)
  useEffect(() => setRetryAcknowledged(false), [sub?.id, sub?.status])
  const isAbsent = listing.presenceStatus === "absent"
  const isRelisted = !isAbsent && sub?.status === "removed"
  return (
    <div className="card space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-medium">{listing.displayName}</div>
          <div className="text-zinc-400">{listing.brokerId}</div>
        </div>
        <div className={sub?.status === "failed" ? "text-muted" : sub?.status === "removed" ? "text-white" : "text-zinc-400"}>
          {isRelisted
            ? "Relisted — removal needed again"
            : isAbsent && !sub
              ? "No longer visible; no removal was submitted"
              : sub
                ? statusLabel[sub.status]
                : "Not started"}
        </div>
      </div>

      {sub?.lastError && <div className="border-l border-white/30 pl-3 text-xs text-zinc-400">{sub.lastError}</div>}

      {/* The recorded sessions are the evidence for what the broker actually saw. */}
      {(sub?.submitSessionId || sub?.confirmSessionId) && (
        <p className="text-xs text-muted">
          Recorded Solari sessions —{" "}
          {[
            sub.submitSessionId && `submit ${sub.submitSessionId}`,
            sub.confirmSessionId && `confirm ${sub.confirmSessionId}`,
          ].filter(Boolean).join(" · ")}
        </p>
      )}

      {sub?.previewScreenshotPath && (
        <div className="space-y-1">
          <p className="text-zinc-400">
            {sub.status === "prepared"
              ? "Filled form preview — approve before we submit:"
              : "Form preview from this request:"}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/evidence?file=${encodeURIComponent(sub.previewScreenshotPath.replace(/\\/g, "/"))}`}
            alt="opt-out form preview"
            className="max-h-96 w-full rounded-lg border border-white/10 object-cover object-top"
          />
        </div>
      )}

      {(!sub || isRelisted || sub.status === "failed" || sub.status === "cancelled") && !isAbsent && (
        <button className="btn-primary" disabled={!contactEmail || !!busy || !remoteReady} onClick={onPrepare} title={!contactEmail ? "Set a contact email above first" : ""}>
          {busy === `p-${listing.id}`
            ? "Filling form (Solari session)…"
            : isRelisted
              ? "Prepare another opt-out"
              : "Prepare opt-out"}
        </button>
      )}

      {/* A sent request the broker ignored: a rescan saw the listing again since. */}
      {(sub?.status === "submitted" || sub?.status === "confirmed") && !isAbsent &&
        listing.lastSeenAt > sub.updatedAt && (
        <div className="space-y-2 border-l border-white/30 pl-3">
          <p className="text-zinc-400">
            A rescan still found this listing after your request. Brokers can take several
            days to remove records; if it is still here after that, request removal again.
          </p>
          <button className="btn-secondary" disabled={!!busy} onClick={onReopen}>
            Request removal again
          </button>
        </div>
      )}

      {/* Only before any request: once one is sent, the decision is on record. */}
      {(!sub || sub.status === "failed" || sub.status === "cancelled") && !isAbsent && (
        <button className="btn-secondary ml-2" disabled={!!busy} onClick={onReviewAgain}>
          Not me after all
        </button>
      )}

      {isAbsent && (sub?.status === "prepared" || sub?.status === "awaiting_email") && (
        <p className="text-zinc-400">
          This listing is currently absent, so PrivacyJanitor will not send another broker
          action. Re-scan if it reappears.
        </p>
      )}

      {!isAbsent && sub?.status === "prepared" && (
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" disabled={!!busy || !remoteReady} onClick={() => onApprove()}>
            {busy === `a-${listing.id}` ? "Submitting…" : "Approve & submit"}
          </button>
          <button className="btn-secondary" disabled={!!busy} onClick={onCancel}>Cancel</button>
        </div>
      )}

      {sub?.status === "approved" && (
        <button className="btn-secondary" disabled={!!busy} onClick={onCancel}>Cancel queued request</button>
      )}

      {sub?.status === "attention_required" && (
        <div className="space-y-3 border-l border-white/30 pl-3">
          <p>The broker may already have received this action. Check your inbox and the broker result before retrying.</p>
          {!isAbsent && (
            <label className="flex items-start gap-2 text-zinc-400">
              <input type="checkbox" checked={retryAcknowledged} onChange={(event) => setRetryAcknowledged(event.target.checked)} className="mt-1 accent-white" />
              I checked and understand a retry could duplicate the request.
            </label>
          )}
          {sub.attentionOperation === "submit" && !isAbsent && (
            <button className="btn-primary" disabled={!!busy || !retryAcknowledged || !remoteReady} onClick={() => onApprove(true)}>Retry submission</button>
          )}
          <button className="btn-secondary ml-2" disabled={!!busy} onClick={onCancel}>Close attempt locally</button>
        </div>
      )}

      {!isAbsent && (sub?.status === "awaiting_email" || (sub?.status === "attention_required" && sub.attentionOperation === "confirm")) && (
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
            <button className="btn-primary" disabled={!confirmUrl || !!busy || !remoteReady || (sub.status === "attention_required" && !retryAcknowledged)} onClick={() => onConfirmEmail(sub.status === "attention_required" && retryAcknowledged)}>
              {busy === `e-${listing.id}` ? "Confirming…" : "Confirm removal"}
            </button>
          </div>
          {sub.status === "awaiting_email" && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>No email after a day or two? Check spam first; confirmation links can also expire.</span>
              <button className="btn-secondary" disabled={!!busy} onClick={onCancel}>Close attempt locally</button>
            </div>
          )}
        </div>
      )}

      {sub?.resultScreenshotPath && (
        <div className="space-y-1">
          <p className="text-zinc-400">Submit result:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/evidence?file=${encodeURIComponent(sub.resultScreenshotPath.replace(/\\/g, "/"))}`}
            alt="opt-out result"
            className="max-h-96 w-full rounded-lg border border-white/10 object-cover object-top"
          />
        </div>
      )}
    </div>
  )
}
