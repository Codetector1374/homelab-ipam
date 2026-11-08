export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('ipam:unauthorized'));
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `Request failed (${response.status}). Please try again.`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
