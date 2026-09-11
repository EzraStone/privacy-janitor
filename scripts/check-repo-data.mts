/** Guard known sensitive artifacts in the Git index. Not a general PII audit. */
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export function blockedArtifact(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  if (normalized === ".env.example") return false
  return /^(?:data|evidence|traces)\//i.test(normalized) ||
    /(^|\/)\.env(?:\.|$)/i.test(normalized) ||
    /\.(?:db(?:-(?:wal|shm|journal))?|sqlite\d?(?:-(?:wal|shm|journal))?|har|log)$/i.test(normalized)
}

export function containsProviderKey(text: string): boolean {
  const candidates = text.match(/\b(?:slr_live_|gsk_)[A-Za-z0-9_-]{16,}\b/g) ?? []
  return candidates.some((key) => !/^(?:slr_live_|gsk_)x+$/i.test(key)) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
}

export function checkIndex(): number {
  const paths = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
  const failures: string[] = []
  for (const path of paths) {
    if (blockedArtifact(path)) {
      failures.push(`${path}: runtime or environment file must not be committed`)
      continue
    }
    // Media cannot be inspected for PII here. Human review remains mandatory.
    if (!/\.(?:[cm]?[jt]sx?|json|md|ya?ml|txt|example|toml|css)$/.test(path)) continue
    const content = execFileSync("git", ["show", `:${path}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    if (containsProviderKey(content)) failures.push(`${path}: possible credential (value withheld)`)
  }
  if (failures.length) {
    for (const failure of failures) console.error(failure)
    return 1
  }
  console.log(`Repository guard: ${paths.length} indexed paths checked; no known runtime artifacts or provider keys found.`)
  console.log("This does not audit arbitrary personal data, image/video contents, or Git history.")
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = checkIndex()
