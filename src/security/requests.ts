const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

const CONFIRMATION_DOMAINS: Record<string, string> = {
  whitepages: "whitepages.com",
  spokeo: "spokeo.com",
  fastpeoplesearch: "fastpeoplesearch.com",
}

export class RequestValidationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "RequestValidationError"
    this.status = status
  }
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/** Reject API traffic addressed to a non-loopback host or sent cross-origin. */
export function assertTrustedLocalRequest(request: Request): void {
  const target = new URL(request.url)
  if (!isLoopback(target.hostname)) {
    throw new RequestValidationError("API requests must use localhost", 403)
  }

  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new RequestValidationError("cross-site API request blocked", 403)
  }

  const origin = request.headers.get("origin")
  if (!origin) return // local scripts and curl do not always send Origin

  let source: URL
  try {
    source = new URL(origin)
  } catch {
    throw new RequestValidationError("invalid request origin", 403)
  }
  const sameLocalOrigin =
    isLoopback(source.hostname) &&
    source.protocol === target.protocol &&
    source.port === target.port
  if (!sameLocalOrigin) {
    throw new RequestValidationError("cross-origin API request blocked", 403)
  }
}

/** Confirmation links may only navigate to HTTPS pages owned by that broker. */
export function validateBrokerConfirmationUrl(raw: string, brokerId: string): string {
  const baseDomain = CONFIRMATION_DOMAINS[brokerId]
  if (!baseDomain) throw new RequestValidationError("unsupported confirmation broker")

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RequestValidationError("confirmation URL is invalid")
  }

  const hostname = url.hostname.toLowerCase()
  const isBrokerHost = hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)
  if (
    url.protocol !== "https:" ||
    !isBrokerHost ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new RequestValidationError(`confirmation URL must be an HTTPS ${baseDomain} link`)
  }

  return url.toString()
}
