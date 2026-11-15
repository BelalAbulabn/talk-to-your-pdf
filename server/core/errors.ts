/** Error codes of the public API (docs/api-pdf-voice.md). The frontend switches on these. */
export type ErrorCode =
  | 'file_too_large'
  | 'not_pdf'
  | 'no_text_found'
  | 'upload_limit'
  | 'file_limit'
  | 'upload_in_progress'
  | 'no_documents'
  | 'voice_minutes_used'
  | 'call_limit'
  | 'chat_limit'
  | 'call_in_progress'
  | 'service_busy'
  | 'service_daily_limit'
  | 'session_required'
  | 'forbidden_origin'
  | 'invalid_request'
  | 'not_found'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  file_too_large: 413,
  not_pdf: 415,
  no_text_found: 422,
  upload_limit: 429,
  file_limit: 409,
  upload_in_progress: 409,
  no_documents: 409,
  voice_minutes_used: 429,
  call_limit: 429,
  chat_limit: 429,
  call_in_progress: 409,
  service_busy: 503,
  service_daily_limit: 503,
  session_required: 401,
  forbidden_origin: 403,
  invalid_request: 400,
  not_found: 404,
  internal: 500,
};

/** An error whose code and message are safe to show to the visitor. */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

/** Maps any thrown value to the public error body; unexpected errors are logged, not exposed. */
export function toErrorBody(
  error: unknown,
  context: string,
): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  console.error(`[${context}]`, error);
  return {
    status: 500,
    body: {
      error: {
        code: 'internal',
        message: 'Something went wrong. Please try again later.',
      },
    },
  };
}
