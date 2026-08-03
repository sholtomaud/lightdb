export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.reduce((acc, str, i) => {
    let val: unknown = values[i];
    if (val === undefined || val === null) {
      val = '';
    } else if (Array.isArray(val)) {
      val = val.join('');
    } else if (typeof val === 'function') {
      val = (val as () => unknown)();
    }
    return acc + str + String(val);
  }, '');
}

export function css(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.reduce(
    (acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
    ''
  );
}

/** Escapes text destined for an HTML text node or quoted attribute. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
