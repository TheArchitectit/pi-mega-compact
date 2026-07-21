import { randomUUID } from "node:crypto";

const CSRF_TOKENS = new Map<string, number>();
export const CSRF_MAX_AGE_MS = 60 * 60 * 1000; // 60 min rotation

export function generateCsrfToken(): string {
	const token = randomUUID();
	CSRF_TOKENS.set(token, Date.now());
	return token;
}

export function isCsrfValid(token: string): boolean {
	if (!CSRF_TOKENS.has(token)) return false;
	const ts = CSRF_TOKENS.get(token) ?? 0;
	if (Date.now() - ts > CSRF_MAX_AGE_MS) {
		CSRF_TOKENS.delete(token);
		return false;
	}
	return true;
}
