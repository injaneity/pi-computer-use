export function toBoolean(value: unknown): boolean {
	return value === true || value === "true" || value === 1;
}

export function toFiniteNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
