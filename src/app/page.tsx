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
  const [activeIdentityId, setActiveIdentityId] = useState<string | null>(null)
  const [showIdentityForm, setShowIdentityForm] = useState(false)
  const [editingIdentity, setEditingIdentity] = useState<Identity | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state")
    if (res.ok) setState(await res.json())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Default to first identity when none is selected.
  useEffect(() => {
    if (!activeIdentityId && state?.identities.length) {
      setActiveIdentityId(state.identities[0].id)
    }
  }, [state, activeIdentityId])

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
  const pendingListings = scopedListings.filter((l) => l.confirmedMine === null)
  const activeScan = scopedScans.find((s) => !s.finishedAt)

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-5 py-12 sm:px-8 sm:py-16">
      <header className="border-b border-white/10 pb-10">
        <p className="eyebrow mb-4">Local-first privacy workspace</p>
        <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
          Privacy<span className="font-light text-zinc-500">Janitor</span>
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-500">
          Profiles, findings, and evidence are saved locally in{" "}
          <code className="rounded bg-white/5 px-1.5 py-0.5 text-zinc-300">data/</code>.
          Broker scans run through recorded Solari browser sessions, and nothing is submitted
          to a broker without your approval.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-white/20 bg-white/[0.04] px-4 py-3 text-sm text-zinc-200">
          <span className="mr-2 font-semibold text-white">Something went wrong.</span>{error}
        </div>
      )}

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
                <span className={i.id === activeIdentityId ? "text-black/60" : "text-zinc-600"}>
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
              }
              setShowIdentityForm(false)
              setEditingIdentity(null)
            }}
          />
        )}

        {state?.identities.length === 0 && (
          <p className="text-sm leading-6 text-zinc-500">
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
              <p className="mt-1 text-sm text-zinc-500">
                Searches all brokers for this profile&apos;s data.
              </p>
            </div>
            <button
              className="btn-primary"
              disabled={!!busy || !identity}
              onClick={() => void stateAction({ action: "scan", identityId: identity.id }, "scan")}
            >
              {activeScan ? "Scanning…" : busy === "scan" ? "Starting…" : "Run broker scan"}
            </button>
          </div>
          {activeScan && (
            <p className="text-xs text-zinc-500">
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
          <p className="text-sm leading-6 text-zinc-500">
            Confirm each listing before anything is removed — namesakes are common and wrong
            removals cause real trouble.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {pendingListings.map((l) => (
              <ListingCard key={l.id} listing={l}
                onConfirm={() => void stateAction({ action: "confirm-listing", listingId: l.id }, `c-${l.id}`)}
                onReject={() => void stateAction({ action: "reject-listing", listingId: l.id }, `c-${l.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Exposure score ──────────────────────────────────────────── */}
      {identity && confirmedListings.length > 0 && (
        <section className="panel space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="eyebrow">04 / Prioritize</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">Exposure score</h2>
            </div>
            <button
              className="btn-primary"
              disabled={!!busy}
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
                <span className="text-zinc-500"> · model {report.model}</span>
              </p>
              <p className="text-sm text-zinc-400">{report.summary}</p>
              <div className="space-y-2">
                {report.rankings.map((r) => {
                  const listing = confirmedListings.find((l) => l.id === r.listingId)
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
              <p className="text-xs text-zinc-500">
                Optional Groq scoring receives tokenized listing fields plus the profile&apos;s
                coarse city and state context.
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              {confirmedListings.length} confirmed listing(s) for {identity.fullName}. Rank them
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
              const sub = scopedSubmissions.find((s) => s.listingId === l.id)
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

      {/* ── Rescan ──────────────────────────────────────────────────── */}
      {identity && confirmedListings.length > 0 && (
        <section className="panel space-y-3">
          <p className="eyebrow">06 / Verify</p>
          <h2 className="text-xl font-semibold tracking-tight">Verify removals</h2>
          <p className="text-sm leading-6 text-zinc-500">
            Brokers relist data. Re-run the scan after a few days — removed listings that
            reappear get flagged.
          </p>
          <button
            className="btn-secondary"
            disabled={!!busy}
            onClick={() => void stateAction({ action: "scan", identityId: identity.id }, "scan")}
          >
            Re-scan & diff
          </button>
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
                  {new Date(s.startedAt).toLocaleString()} —{" "}
                  {s.finishedAt ? `${s.results.length} broker(s) done` : "running…"}
                </div>
                <div className="mt-1 space-y-1">
                  {s.results.map((r) => (
                    <div key={r.brokerId} className={r.ok ? "text-zinc-300" : "text-zinc-500"}>
                      {r.ok ? "✓" : "×"} {r.brokerId}: {r.ok ? `${r.listingsFound} listing(s)` : `error — ${r.error}`}
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
        Age range <span className="font-normal text-zinc-600">Optional</span>
        <input className="input-std" placeholder="25-30" value={ageRange} onChange={(e) => setAgeRange(e.target.value)} />
      </label>
      <label className="field-label sm:col-span-2">
        Relatives <span className="font-normal text-zinc-600">Optional, comma-separated</span>
        <input
          className="input-std"
          placeholder="Improves match accuracy"
          value={relatives}
          onChange={(e) => setRelatives(e.target.value)}
        />
      </label>
      {!existing && (
        <label className="flex items-start gap-3 text-xs leading-5 text-zinc-500 sm:col-span-2">
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
        <p className="text-xs leading-5 text-zinc-600 sm:col-span-2">
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

function ListingCard({
  listing, onConfirm, onReject,
}: {
  listing: Listing
  onConfirm?: () => void
  onReject?: () => void
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
      <a href={listing.url} target="_blank" className="link-std block truncate">
        {listing.url}
      </a>
      {onConfirm && onReject && (
        <div className="flex gap-2 pt-1">
          <button className="btn-primary" onClick={onConfirm}>This is me</button>
          <button className="btn-secondary" onClick={onReject}>Not me</button>
        </div>
      )}
    </div>
  )
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
    <div className="card space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-medium">{listing.displayName}</div>
          <div className="text-zinc-400">{listing.brokerId}</div>
        </div>
        <div className={sub?.status === "failed" ? "text-zinc-500" : sub?.status === "removed" ? "text-white" : "text-zinc-400"}>
          {sub ? statusLabel[sub.status] : "Not started"}
        </div>
      </div>

      {sub?.lastError && <div className="border-l border-white/30 pl-3 text-xs text-zinc-400">{sub.lastError}</div>}

      {sub?.previewScreenshotPath && (
        <div className="space-y-1">
          <p className="text-zinc-400">Filled form preview — approve before we submit:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/evidence?file=${encodeURIComponent(sub.previewScreenshotPath.replace(/\\/g, "/"))}`}
            alt="opt-out form preview"
            className="max-h-96 w-full rounded-lg border border-white/10 object-cover object-top"
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
            className="max-h-96 w-full rounded-lg border border-white/10 object-cover object-top"
          />
        </div>
      )}
    </div>
  )
}
