declare const __APP_VERSION__: string;

export const clientVersion = __APP_VERSION__;

export function gameApiRoute(route: string) {
  return `${route}${route.includes('?') ? '&' : '?'}clientVersion=${encodeURIComponent(clientVersion)}`;
}
