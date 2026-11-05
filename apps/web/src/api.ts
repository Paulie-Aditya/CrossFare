import { errorMessage } from "./journey.ts";

export interface ApiAnswer {
  ok: boolean;
  status: number;
  body: any;
  message: string;
}

async function answer(response: Response): Promise<ApiAnswer> {
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body, message: response.ok ? "" : errorMessage(body, response.status) };
}

export async function post(path: string, body: unknown): Promise<ApiAnswer> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answer(response);
}

export async function get(path: string): Promise<ApiAnswer> {
  return answer(await fetch(path));
}
