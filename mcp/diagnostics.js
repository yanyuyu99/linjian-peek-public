export function diagnosticResponseHeaders(headers) {
  const allowed = ["server", "cf-ray", "rndr-id", "retry-after", "content-type"];
  return Object.fromEntries(allowed.map((name) => [name, headers?.get?.(name) || null]));
}
