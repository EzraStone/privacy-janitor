import {
  RequestValidationError,
  assertTrustedLocalRequest,
  validateBrokerConfirmationUrl,
} from "../src/security/requests.ts"

let failures = 0
function check(name: string, condition: boolean) {
  if (condition) console.log(`  ok    ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}`)
  }
}

function rejected(name: string, fn: () => void, status = 400) {
  try {
    fn()
    check(name, false)
  } catch (error) {
    check(name, error instanceof RequestValidationError && error.status === status)
  }
}

console.log("smoke: local API boundary")
assertTrustedLocalRequest(new Request("http://127.0.0.1:3000/api/state"))
check("local scripts may omit Origin", true)
assertTrustedLocalRequest(new Request("http://localhost:3000/api/state", {
  headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
}))
check("same-origin browser request allowed", true)
assertTrustedLocalRequest(new Request("http://127.0.0.1:3000/api/state", {
  headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
}))
check("localhost and 127.0.0.1 aliases allowed on the same port", true)
rejected(
  "LAN-addressed request blocked",
  () => assertTrustedLocalRequest(new Request("http://192.168.1.20:3000/api/state")),
  403,
)
rejected(
  "cross-origin request blocked",
  () => assertTrustedLocalRequest(new Request("http://localhost:3000/api/state", {
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  })),
  403,
)
rejected(
  "different local port blocked",
  () => assertTrustedLocalRequest(new Request("http://127.0.0.1:3000/api/state", {
    headers: { origin: "http://localhost:4000", "sec-fetch-site": "same-origin" },
  })),
  403,
)

console.log("smoke: broker confirmation URL allowlist")
check(
  "broker HTTPS link accepted",
  validateBrokerConfirmationUrl("https://email.spokeo.com/confirm?id=test", "spokeo")
    === "https://email.spokeo.com/confirm?id=test",
)
rejected(
  "lookalike broker domain blocked",
  () => validateBrokerConfirmationUrl("https://spokeo.com.evil.example/confirm", "spokeo"),
)
rejected(
  "insecure broker link blocked",
  () => validateBrokerConfirmationUrl("http://www.spokeo.com/confirm", "spokeo"),
)
rejected(
  "credential-bearing URL blocked",
  () => validateBrokerConfirmationUrl("https://user:pass@spokeo.com/confirm", "spokeo"),
)

if (failures) {
  console.error(`\n${failures} security smoke check(s) failed`)
  process.exit(1)
}
console.log("\nall security smoke checks passed ✓")
