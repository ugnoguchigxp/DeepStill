import { isAbsolute } from "node:path";
import { z } from "zod";

export const repositoryIdentitySchema = z
	.object({
		projectRef: z.string().trim().min(1).optional(),
		repoKey: z.string().trim().min(1).optional(),
		repoPath: z
			.string()
			.trim()
			.min(1)
			.refine(isAbsolute, "repoPath must be absolute")
			.optional(),
	})
	.refine((value) => Object.values(value).some(Boolean), {
		message: "at least one repository identity field is required",
	});

export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

export function repositoryIdentityFromConfig(
	config: Record<string, unknown>,
): RepositoryIdentity | undefined {
	if (config.repositoryIdentity === undefined) return;
	const result = repositoryIdentitySchema.safeParse(config.repositoryIdentity);
	if (!result.success) throw new Error("INVALID_REPOSITORY_IDENTITY");
	return result.data;
}
