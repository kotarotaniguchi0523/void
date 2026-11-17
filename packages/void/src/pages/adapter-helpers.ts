/// <reference lib="dom" />

export function getValidationErrors(body: unknown): Record<string, string> | null {
  if (
    body &&
    typeof body === 'object' &&
    'errors' in body &&
    body.errors &&
    typeof body.errors === 'object' &&
    !Array.isArray(body.errors)
  ) {
    return body.errors as Record<string, string>;
  }
  return null;
}

export function isModifiedEvent(
  e: Pick<MouseEvent, 'currentTarget' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'button'>,
): boolean {
  const target = (e.currentTarget as HTMLElement).getAttribute('target');
  return (
    (target !== null && target !== '_self') ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey ||
    e.altKey ||
    e.button !== 0
  );
}
