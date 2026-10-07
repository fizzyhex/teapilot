import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';

/** Current recovery context, not a history of failures. */
export const blockerSchema = z.object({
  reason: z.string().trim().min(1).max(240),
  next: z.string().trim().min(1).max(240).optional(),
  needsInput: z.boolean().optional(),
}).strict();
export type Blocker = z.infer<typeof blockerSchema>;
export const blockerParameters = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 240, description: 'Why the work cannot continue.' }),
  next: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: 'Concrete action that would unblock it.' })),
  needsInput: Type.Optional(Type.Boolean({ description: 'True only when the person needs to act, not for an instructor question.' })),
});
