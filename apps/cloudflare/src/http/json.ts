export function jsonOk(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonError(message: string, status: number = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
