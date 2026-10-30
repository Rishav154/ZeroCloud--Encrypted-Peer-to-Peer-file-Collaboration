import { z } from "zod";

export const pingSchema = z.object({
  type: z.literal("ping"),
  ts: z.number(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
  ts: z.number(),
  serverTime: z.number(),
});

export const signalMessageSchema = z.discriminatedUnion("type", [
  pingSchema,
  pongSchema,
]);

export type PingMessage = z.infer<typeof pingSchema>;
export type PongMessage = z.infer<typeof pongSchema>;
export type SignalMessage = z.infer<typeof signalMessageSchema>;

export type ParseMessageResult =
  { success: true; data: SignalMessage } | { success: false; error: string };

export function parseMessage(raw: string): ParseMessageResult {
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return { success: false, error: "Message must contain valid JSON" };
  }

  const result = signalMessageSchema.safeParse(input);
  if (!result.success) {
    return {
      success: false,
      error: "Message does not match the signalling protocol",
    };
  }

  return { success: true, data: result.data };
}
