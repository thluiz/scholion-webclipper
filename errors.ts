// errors.ts — the structured error contract (README Decision 7).
//
// Every error the API can return is one of these, and every one carries a
// stable `code`, a `retryable` hint, and optional `details`. The code is
// what a caller branches on; the HTTP status is secondary. Codes are
// deliberately aligned with the skip-reason vocabulary
// `add-scholion-webclip/batch-playbook.md` already logs
// (thin_unrecoverable, audit_unresolved, build_failed).

export type ErrorCode =
  | "validation_error"
  | "authentication_error"
  | "forbidden"
  | "rate_limited"
  | "fetch_timeout"
  | "fetch_failed"
  | "blocked_domain"
  | "consent_wall_unresolved"
  | "thin_content"
  | "summary_failed"
  | "audit_red"
  | "slug_conflict"
  | "operation_not_found"
  | "operation_already_saved"
  | "not_found"
  | "method_not_allowed";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, retryable: boolean, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_error", 400, false, message, details);
  }
}

export class AuthenticationError extends ApiError {
  constructor(message: string) {
    super("authentication_error", 401, false, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string) {
    super("forbidden", 403, false, message);
  }
}

export class RateLimitedError extends ApiError {
  constructor(message: string) {
    super("rate_limited", 429, true, message);
  }
}

export class FetchTimeoutError extends ApiError {
  constructor(url: string, timeoutMs: number) {
    super("fetch_timeout", 504, true, `rendering ${url} exceeded the internal timeout (${timeoutMs}ms)`);
  }
}

export class FetchFailedError extends ApiError {
  constructor(url: string, reason: string) {
    super("fetch_failed", 502, true, `could not render ${url}: ${reason}`);
  }
}

export class BlockedDomainError extends ApiError {
  constructor(domain: string) {
    super("blocked_domain", 422, false, `${domain} is known to block scraping; not attempting a fetch`);
  }
}

export class ConsentWallUnresolvedError extends ApiError {
  constructor(url: string) {
    super("consent_wall_unresolved", 422, false, `a cookie-consent wall on ${url} could not be dismissed`);
  }
}

export class ThinContentError extends ApiError {
  constructor(chars: number, minChars: number) {
    super(
      "thin_content",
      422,
      false,
      `extracted content is only ${chars} chars, below the ${minChars} minimum`,
      { chars, minChars },
    );
  }
}

export class SummaryFailedError extends ApiError {
  constructor(reason: string) {
    super("summary_failed", 502, true, `webclip-summary composition failed: ${reason}`);
  }
}

export class AuditRedError extends ApiError {
  constructor(findings: unknown) {
    super(
      "audit_red",
      403,
      false,
      "ghost-audit verdict is red; save requires webclip.save.force",
      { findings },
    );
  }
}

export class SlugConflictError extends ApiError {
  constructor(slug: string) {
    super("slug_conflict", 409, false, `a note with slug ${slug} already exists`);
  }
}

export class OperationNotFoundError extends ApiError {
  constructor(operationId: string) {
    super("operation_not_found", 404, false, `no pending operation ${operationId}`);
  }
}

export class OperationAlreadySavedError extends ApiError {
  constructor(operationId: string) {
    super("operation_already_saved", 409, false, `operation ${operationId} was already consumed`);
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string) {
    super("not_found", 404, false, message);
  }
}

export class MethodNotAllowedError extends ApiError {
  constructor(message: string) {
    super("method_not_allowed", 405, false, message);
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
