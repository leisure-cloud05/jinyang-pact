/** API errors with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
