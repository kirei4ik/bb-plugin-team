import {z} from "zod";
export const sessionRecoveryActionSchema=z.enum(["continue","abort","confirm","release"]);
export const sessionRecoverySchema=z.object({revision:z.string(),stage:z.string().nullable(),delivery:z.string().nullable(),oldThreadId:z.string().nullable(),newThreadId:z.string().nullable(),actions:z.array(sessionRecoveryActionSchema),candidates:z.array(z.string()),reasonCode:z.string().nullable()});
export type SessionRecovery=z.infer<typeof sessionRecoverySchema>;
