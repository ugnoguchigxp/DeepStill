import { z } from "zod";

export const resourceIdentitySchema = z.object({
	connectorKind: z.string().min(1),
	connectorInstanceId: z.string().min(1),
	resourceId: z.string().min(1),
	revision: z.string().min(1).optional(),
	scope: z.record(z.string(), z.string()).optional(),
	displayUrl: z.string().url().optional(),
	visibilityRef: z.string().min(1).optional(),
});

export const fragmentLocatorSchema = z.object({
	kind: z.string().min(1),
	value: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const evidenceLocatorSchema = z.object({
	resource: resourceIdentitySchema,
	fragment: fragmentLocatorSchema,
	snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
	quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ResourceIdentity = z.infer<typeof resourceIdentitySchema>;
export type FragmentLocator = z.infer<typeof fragmentLocatorSchema>;
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;
