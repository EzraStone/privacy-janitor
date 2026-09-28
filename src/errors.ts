/**
 * Expected failures, each with the HTTP status the local API reports for it.
 * Anything else thrown is a bug and surfaces as a 500.
 */
export class StatusError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = new.target.name
    this.status = status
  }
}

/** The record does not exist, or does not belong where the request says. */
export class NotFoundError extends StatusError {
  constructor(message: string) {
    super(message, 404)
  }
}

/** The record exists, but its current state does not allow the request. */
export class ConflictError extends StatusError {
  constructor(message: string) {
    super(message, 409)
  }
}
