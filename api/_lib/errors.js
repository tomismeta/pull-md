export class AppError extends Error {
  constructor(status, payload, options = {}) {
    const fallbackMessage = options.message || payload?.error || 'Application error';
    super(fallbackMessage);
    this.name = 'AppError';
    this.status = Number(status) || 500;
    this.payload = payload && typeof payload === 'object' ? payload : { error: fallbackMessage };
    this.code = this.payload.code || options.code || null;
    if (options.cause) this.cause = options.cause;
  }
}

export function isAppError(error) {
  return (
    error instanceof AppError ||
    (error &&
      typeof error === 'object' &&
      Number.isFinite(error.status) &&
      error.payload &&
      typeof error.payload === 'object')
  );
}

