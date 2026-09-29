import { describe, expect, test } from "bun:test";

import { AuthenticationError, AuthorizationError } from "../auth/acl";
import { RateLimitError } from "../auth/budget";
import { MethodNotAllowedError, ThinContentError } from "../errors";
import { SlugExistsError } from "../vault/vault";
import { errorBody, toApiError } from "./errors";

describe("toApiError", () => {
  test.each([
    [new AuthenticationError("Missing X-Api-Key"), "authentication_error", 401, false],
    [new AuthorizationError("bot may not webclip.save"), "forbidden", 403, false],
    [new RateLimitError("Compose limit reached"), "rate_limited", 429, true],
    [new SlugExistsError("notes/x.md already exists"), "slug_conflict", 409, false],
    [new MethodNotAllowedError("PUT is not allowed"), "method_not_allowed", 405, false],
    [new Error("boom"), "internal_error", 500, false],
    ["not even an Error", "internal_error", 500, false],
  ])("%p → %s / %i", (error, code, status, retryable) => {
    const apiError = toApiError(error);
    expect<string>(apiError.code).toBe(code as string);
    expect(apiError.status).toBe(status as number);
    expect(apiError.retryable).toBe(retryable as boolean);
  });

  test("keeps the original message", () => {
    expect(toApiError(new AuthorizationError("bot may not webclip.save")).message).toBe("bot may not webclip.save");
    expect(toApiError("not even an Error").message).toBe("not even an Error");
  });

  test("passes an ApiError through untouched, details included", () => {
    const error = new ThinContentError(120, 500);
    expect(toApiError(error)).toBe(error);
    expect(errorBody(error)).toEqual({
      code: "thin_content",
      message: error.message,
      retryable: false,
      details: { chars: 120, minChars: 500 },
    });
  });
});
