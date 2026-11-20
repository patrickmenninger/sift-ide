export type SiftErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "SIFT_INVALID"
  | "SIFT_TOO_NEW"
  | "SOURCE_NOT_FOUND"
  | "UNSUPPORTED_FILE"
  | "RULES_INVALID"
  | "GIT_FAILED"
  | "PROVIDER_FAILED"
  | "PROVIDER_AUTH"
  | "MODEL_UNAVAILABLE"
  | "NOT_IMPLEMENTED";

/** An expected failure with a message fit to show the user as-is. */
export class SiftError extends Error {
  constructor(
    readonly code: SiftErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "SiftError";
  }
}
