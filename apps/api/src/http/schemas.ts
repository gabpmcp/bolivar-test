import { z } from "zod";

const isoUtc = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid UTC datetime");

export const paginationQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : undefined)),
  nextCursor: z.string().optional(),
  scope: z.enum(["me", "global"]).optional()
});

export const userCommandEnvelopeSchema = z.object({
  command: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("BootstrapAdmin"),
      payload: z.object({
        email: z.string().email(),
        password: z.string().min(8)
      })
    }),
    z.object({
      type: z.literal("RegisterUser"),
      payload: z.object({
        email: z.string().email(),
        password: z.string().min(8)
      })
    }),
    z.object({
      type: z.literal("LoginUser"),
      payload: z.object({
        email: z.string().email(),
        password: z.string().min(8)
      })
    })
  ])
});

export const resourceCommandEnvelopeSchema = z.object({
  command: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("CreateResource"),
      payload: z.object({
        name: z.string().min(1),
        details: z.string().min(1)
      })
    }),
    z.object({
      type: z.literal("UpdateResourceMetadata"),
      payload: z.object({
        resourceId: z.string().uuid(),
        details: z.string().min(1)
      })
    }),
    z.object({
      type: z.literal("CreateReservationInResource"),
      payload: z.object({
        resourceId: z.string().uuid(),
        fromUtc: isoUtc,
        toUtc: isoUtc,
        reservationUserId: z.string().uuid().optional()
      })
    }),
    z.object({
      type: z.literal("CancelReservationInResource"),
      payload: z.object({
        resourceId: z.string().uuid(),
        reservationId: z.string().uuid()
      })
    })
  ])
});
