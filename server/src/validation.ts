import { z, ZodError } from 'zod';
import { ValidationError } from './errors';

/**
 * Centralized input validation. Resolvers call `parseInput(schema, raw)` which
 * either returns the typed value or throws a `ValidationError` whose details
 * surface as `extensions.code = 'BAD_USER_INPUT'` on the GraphQL response.
 */
export function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown
): z.infer<T> {
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError('Invalid input', {
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }
    throw err;
  }
}

// IDs arrive as strings from GraphQL but represent integer primary keys. Parse
// to number once at the edge so the rest of the codebase deals in numbers.
const idString = z
  .string()
  .regex(/^\d+$/, 'Must be a numeric ID')
  .transform((s) => Number(s));

export const bookSeatsInput = z.object({
  eventId: idString,
  seatIds: z
    .array(idString)
    .min(1, 'At least one seat is required')
    .max(10, 'Cannot book more than 10 seats at once')
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'Duplicate seat IDs are not allowed',
    }),
  userId: z.string().min(1).max(64),
});

export const eventIdInput = z.object({ id: idString });
export const seatsInput = z.object({ eventId: idString });
