/** Remove only redundant navigation text, never claims, quotes or known conflicts. */
export function compactDirectionContext<
	T extends {
		sources: { ranges: { preview: string }[] }[];
		memory: { knowledge: unknown[]; episodes: unknown[]; concepts: unknown[] };
	},
>(input: T, maxBytes: number, measure: (value: T) => number) {
	const fullBytes = measure(input);
	if (fullBytes <= maxBytes)
		return { input, fullBytes, bytes: fullBytes, compacted: false, fits: true };
	const compact = structuredClone(input);
	for (const source of compact.sources)
		for (const range of source.ranges) range.preview = "";
	for (const key of ["knowledge", "episodes", "concepts"] as const) {
		compact.memory[key] = compact.memory[key].map((value) => {
			const object = value as Record<string, unknown>;
			return {
				id: object.id,
				claimIds: object.claimIds,
				eventIds: object.eventIds,
			};
		});
	}
	const bytes = measure(compact);
	return {
		input: compact,
		fullBytes,
		bytes,
		compacted: true,
		fits: bytes <= maxBytes,
	};
}
