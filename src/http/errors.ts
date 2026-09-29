// http/errors.ts — the one place foreign errors become the API contract.
//
// acl.ts and budget.ts are vendored from scholion-places and keep their own
// error classes (README Decision 4); vault.ts raises SlugExistsError without
// knowing about HTTP. Everything is mapped to an ApiError here, so the rest
// of the HTTP layer only ever sees the {error:{code,...}} contract
// (README Decision 7).

import { AuthenticationError as AclAuthenticationError, AuthorizationError } from "../auth/acl";
import { RateLimitError } from "../auth/budget";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  InternalError,
  RateLimitedError,
  describe,
} from "../errors";
import { SlugExistsError } from "../vault/vault";

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AclAuthenticationError) return new AuthenticationError(error.message);
  if (error instanceof AuthorizationError) return new ForbiddenError(error.message);
  if (error instanceof RateLimitError) return new RateLimitedError(error.message);
  // routes.ts already maps this with the slug in hand; this is the fallback
  // for any other path that reaches the vault, keeping the vault's message.
  if (error instanceof SlugExistsError) return new ApiError("slug_conflict", 409, false, error.message);
  return new InternalError(describe(error));
}

export function errorBody(error: ApiError): { code: string; message: string; retryable: boolean; details?: unknown } {
  return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
}
