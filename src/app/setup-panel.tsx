import type { SetupStatus } from "@/config/setup"

export function SetupPanel({ status, error, checking, onCheck }: {
  status: SetupStatus | null
  error: string | null
  checking: boolean
  onCheck: () => void
}) {
  return (
    <section className="panel space-y-4" aria-label="Setup checks">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="eyebrow">Before your first scan</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            {checking ? "Checking local setup…" : status?.canStartScan ? "Local setup ready" : "Let’s get you set up"}
          </h2>
        </div>
        <button className="btn-secondary" disabled={checking} onClick={onCheck}>Recheck setup</button>
      </div>
      {error && <p role="alert" className="text-sm text-zinc-300">{error}</p>}
      {status && (
        <>
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="card">
              <p className="font-medium">Local runtime</p>
              <p className="mt-1 text-zinc-400">{status.node.supported ? `Node ${status.node.version}` : "Install Node.js 24 or newer"}</p>
              <p className="mt-1 text-zinc-400">{status.storage.message}</p>
            </div>
            <div className="card">
              <p className="font-medium">Broker connection</p>
              <p className="mt-1 text-zinc-400">{status.solari === "configured" ? "Solari key configured" : status.solari === "placeholder" ? "Replace the example Solari key" : "Add your Solari key"}</p>
              <p className="mt-1 text-xs text-zinc-500">Provider access not yet tested</p>
            </div>
            <div className="card">
              <p className="font-medium">Optional scoring</p>
              <p className="mt-1 text-zinc-400">{status.groq === "configured" ? "Groq key configured" : "Off — add a Groq key to enable"}</p>
              <p className="mt-1 text-xs text-zinc-500">Not required for scans or removals</p>
            </div>
          </div>
          {!status.canStartScan && (
            <div className="border-l border-white/25 pl-4 text-sm leading-6 text-zinc-300">
              Copy <code>.env.example</code> to <code>.env</code> in the project folder,
              add your <code>SOLARI_API_KEY</code>, then restart the app. Keep keys in that
              local file, never in GitHub. You can add and review profiles while setting up.
            </div>
          )}
        </>
      )}
      <p className="text-xs leading-5 text-zinc-500">
        This check stays on your computer and tests local folder access. It does not open a
        browser session or verify provider billing, permissions, or broker compatibility.
        Scans and form previews use recorded cloud browsers and may incur provider charges.
      </p>
    </section>
  )
}
