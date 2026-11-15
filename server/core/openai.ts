export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function openaiApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return key;
}

export async function openaiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenAI ${path} failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
}
