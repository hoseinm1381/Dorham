// Capture failure must not tear down an otherwise healthy receive connection.
export function microphoneUnavailable(error: unknown): boolean {
  return ['NotAllowedError', 'PermissionDeniedError', 'NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'SecurityError'].includes((error as { name?: string })?.name || '');
}
export const listenOnlyNotice = 'Listening only. Microphone unavailable or permission denied. Rejoin to try again.';
