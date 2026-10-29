import { z } from 'zod';

export const connectionProbeSchema = z.object({ version: z.literal(1) }).strict();
export const connectionLatenciesSchema = z.array(z.object({
  userId: z.string().min(1).max(80),
  milliseconds: z.number().int().min(0).max(5000).nullable(),
  measuredAt: z.number().int().nonnegative().nullable()
}).strict()).max(1000);
export type ConnectionLatency = z.infer<typeof connectionLatenciesSchema>[number];
