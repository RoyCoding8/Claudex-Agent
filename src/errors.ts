// cx-agent error envelope — typed { code, message }.

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "PERMISSION_REQUEST_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RESOURCE_EXHAUSTED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INTERRUPTED"
  | "INCOMPLETE"
  | "INTERNAL";

export interface StructuredError {
  code: ErrorCode;
  message: string;
}

export type WithError<T extends Record<string, unknown>> = Omit<T, "error"> & {
  error: StructuredError | null;
};


export function withStructured<T extends Record<string, unknown>>(
  out: T,
  code: ErrorCode,
  message: string,
): WithError<T> {
  return { ...out, error: structured(code, message) } as WithError<T>;
}

export function structured(code: ErrorCode, message: string): StructuredError {
  return { code, message: message || defaultMessage(code) };
}

export function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case "INVALID_ARGUMENT": return "invalid argument";
    case "SESSION_NOT_FOUND": return "no job with that id was found";
    case "SESSION_BUSY": return "the session is still running; reply after it completes";
    case "PERMISSION_REQUEST_NOT_FOUND": return "no pending permission request for that id";
    case "PERMISSION_DENIED": return "permission denied";
    case "RESOURCE_EXHAUSTED": return "resource exhausted";
    case "TIMEOUT": return "the job exceeded its time limit";
    case "CANCELLED": return "the job was cancelled";
    case "INTERRUPTED": return "the job was interrupted";
    case "INCOMPLETE": return "the job did not finish (max turns reached)";
    case "INTERNAL": return "internal error";
  }
}


export function codeForStatus(status: string, error: string | null): StructuredError | null {
  switch (status) {
    case "completed": return null;
    case "interrupted": return structured("INTERRUPTED", error ?? defaultMessage("INTERRUPTED"));
    case "incomplete": {
                  if (error && /^timeout after /i.test(error)) return structured("TIMEOUT", error);
      if (error && /max budget/i.test(error)) return structured("RESOURCE_EXHAUSTED", error);
      return structured("INCOMPLETE", error ?? defaultMessage("INCOMPLETE"));
    }
    case "failed": {
      if (error && /timeout/i.test(error)) return structured("TIMEOUT", error);
      return structured("INTERNAL", error ?? defaultMessage("INTERNAL"));
    }
    default: return structured("INTERNAL", error ?? defaultMessage("INTERNAL"));
  }
}
