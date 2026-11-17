/// <reference lib="dom" />

export function isFile(value: unknown): boolean {
  return (
    (typeof File !== 'undefined' && value instanceof File) ||
    value instanceof Blob ||
    (typeof FileList !== 'undefined' && value instanceof FileList && value.length > 0)
  );
}

export function hasFiles(data: unknown): boolean {
  return (
    isFile(data) ||
    (typeof data === 'object' && data !== null && Object.values(data).some(hasFiles))
  );
}

export function objectToFormData(
  source: Record<string, unknown>,
  form?: FormData,
  parentKey?: string,
): FormData {
  form = form || new FormData();
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const composed = parentKey ? parentKey + '[' + key + ']' : key;
    const value = source[key];
    if (value instanceof File) {
      form.append(composed, value, value.name);
    } else if (value instanceof Blob) {
      form.append(composed, value);
    } else if (typeof FileList !== 'undefined' && value instanceof FileList) {
      for (let i = 0; i < value.length; i++) {
        form.append(composed + '[]', value[i], value[i].name);
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        objectToFormData({ [i]: value[i] }, form, composed);
      }
    } else if (value instanceof Date) {
      form.append(composed, value.toISOString());
    } else if (typeof value === 'boolean') {
      form.append(composed, value ? '1' : '0');
    } else if (typeof value === 'string') {
      form.append(composed, value);
    } else if (typeof value === 'number') {
      form.append(composed, String(value));
    } else if (value === null || value === undefined) {
      form.append(composed, '');
    } else {
      objectToFormData(value as Record<string, unknown>, form, composed);
    }
  }
  return form;
}
