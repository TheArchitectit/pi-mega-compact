/**
 * Shared runtime-helpers for the api-contracts split test files.
 *
 * Extracted from api-contracts.test.ts so each per-endpoint describe file can
 * reuse the same field/type assertion primitives without duplicating them.
 * Only runtime helpers live here — compile-time `satisfies` checks and the
 * ENDPOINTS registry assertions stay in endpoints-registry.test.ts.
 */
import assert from "node:assert/strict";

/** Primitive type name from a JSON-parsed value (matches typeof for JSON types). */
export function primitiveType(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/** Assert that a field exists on an object and has one of the expected primitive types. */
export function assertField(
	obj: Record<string, unknown>,
	field: string,
	expected: string[],
): void {
	assert.ok(field in obj, `field "${field}" must exist`);
	const actual = primitiveType(obj[field]);
	assert.ok(
		expected.includes(actual),
		`field "${field}" expected type ${expected.join("|")}, got ${actual}`,
	);
}

/** Assert that a nested object field exists and is an object (or null if allowed). */
export function assertObject(
	obj: Record<string, unknown>,
	field: string,
	allowNull: boolean = false,
): Record<string, unknown> | null {
	assert.ok(field in obj, `field "${field}" must exist`);
	const val = obj[field];
	if (allowNull && val === null) return null;
	assert.equal(
		primitiveType(val),
		"object",
		`field "${field}" must be an object${allowNull ? " or null" : ""}`,
	);
	return val as Record<string, unknown>;
}
