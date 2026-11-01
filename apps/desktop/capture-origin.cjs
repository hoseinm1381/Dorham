// Electron serializes the custom-scheme capture origin with a trailing slash.
// Accept either origin spelling, while retaining the requesting main-frame check.
function trustedCaptureRequest(request, contents) {
  if (!contents || contents.isDestroyed() || !request.frame || request.frame.detached) return false;
  return (request.securityOrigin === 'dorham://app' || request.securityOrigin === 'dorham://app/') &&
    request.frame === contents.mainFrame && request.frame.url.startsWith('dorham://app/');
}
module.exports = { trustedCaptureRequest };
