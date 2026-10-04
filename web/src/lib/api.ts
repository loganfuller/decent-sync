// The management interface uses only the server's REST API, the same one any
// other client uses. The session cookie travels with every same-origin request.

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, errorMessage(data) ?? response.statusText);
  return data as T;
}

// Nest reports problems as { message: string | string[] }.
function errorMessage(data: unknown): string | undefined {
  const message = (data as { message?: unknown } | undefined)?.message;
  if (Array.isArray(message)) return message.join(". ");
  return typeof message === "string" ? message : undefined;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  role: "admin" | "staff";
}
