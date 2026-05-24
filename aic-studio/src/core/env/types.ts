import { z } from "zod";

export const EnvironmentColor = z.enum(["blue", "green", "yellow", "red", "slate"]);
export type EnvironmentColor = z.infer<typeof EnvironmentColor>;

export const EnvironmentSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/, {
    message: "name must be lowercase alphanumeric (with - or _)"
  }),
  label: z.string().min(1).max(120),
  tenantUrl: z.string().url(),
  username: z.string().min(1),
  clientId: z.string().min(1),
  color: EnvironmentColor.default("slate"),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export const NewEnvironmentSchema = EnvironmentSchema.omit({ createdAt: true, updatedAt: true });
export type NewEnvironment = z.infer<typeof NewEnvironmentSchema>;
