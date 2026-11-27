const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

// The SDK can preserve a socket error's generic name while placing the useful
// classification in code or cause. Keep programming errors as server errors.
export function dependencyUnavailable(error) {
  if (['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ServiceUnavailable'].includes(error?.name)) return true;
  if (error?.$metadata?.httpStatusCode >= 500) return true;
  for (let cause = error, depth = 0; cause && depth < 3; cause = cause.cause, depth++) {
    if (networkCodes.has(cause.code)) return true;
  }
  return false;
}
