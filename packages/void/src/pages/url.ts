/** Only web and supported local-app schemes can represent a Pages navigation. */
export function isPageUrlProtocol(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'capacitor:';
}

/**
 * The current document URL: the base for relative URLs and for `isSameOrigin`.
 * A full URL, because the opaque origin of a Capacitor WebView is not a URL base.
 */
export function documentBaseUrl(): URL {
  if (typeof window === 'undefined') {
    return new URL('http://localhost/');
  }
  const { href, origin, pathname, search, hash } = window.location;
  return new URL(href || origin + pathname + search + hash);
}

/** Use the browser's origin or a URL base for custom schemes with opaque origins. */
export function isSameOrigin(url: URL, origin: string | URL): boolean {
  if (url.protocol === 'capacitor:') {
    const current = origin instanceof URL ? origin : new URL(origin);
    return current.protocol === 'capacitor:' && url.host !== '' && url.host === current.host;
  }
  return url.origin === (origin instanceof URL ? origin.origin : origin);
}

/** A URL the router can load page data for: a page scheme, on the document's origin. */
export function isSameOriginPageUrl(url: URL, base: URL = documentBaseUrl()): boolean {
  return isPageUrlProtocol(url) && isSameOrigin(url, base);
}

function isHexDigit(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F'))
  );
}

function tryDecodeURI(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/**
 * The path a page is matched on, decoded the way the server (Hono's getPath)
 * decodes it: `/caf%C3%A9` becomes `/café`, while `%25`, reserved escapes such
 * as `%2F` and malformed escapes stay encoded.
 */
export function decodePagePath(path: string): string {
  if (!path.includes('%')) {
    return path;
  }
  const escaped = path.split('%25').join('%2525');
  try {
    return decodeURI(escaped);
  } catch {
    // Decode each run of escapes on its own, keeping the runs that fail.
  }
  let decoded = '';
  let index = 0;
  while (index < escaped.length) {
    let end = index;
    while (escaped[end] === '%' && isHexDigit(escaped[end + 1]) && isHexDigit(escaped[end + 2])) {
      end += 3;
    }
    if (end === index) {
      decoded += escaped[index++];
    } else {
      decoded += tryDecodeURI(escaped.slice(index, end));
      index = end;
    }
  }
  return decoded;
}
