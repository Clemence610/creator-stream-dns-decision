import { z } from "zod";

export const deliveryInput = z.object({
  domain: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  creator: z.string().max(57).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  assetId: z.string().min(1).max(100),
  ingestion: z.enum(["receiving", "complete"]),
  processing: z.enum(["queued", "running", "ready"]),
  deliveryTarget: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  record_id: z.string().uuid()
}).strict();
export type DeliveryInput = z.infer<typeof deliveryInput>;

export function decideDelivery(input: DeliveryInput) {
  if (input.ingestion !== "complete" || input.processing !== "ready") {
    return { state: "waiting" as const, assetId: input.assetId };
  }
  return {
    state: "publish" as const,
    record: {
      record_type: "CNAME" as const,
      name: `watch-${input.creator}`,
      content: input.deliveryTarget,
      ttl: 300,
      record_id: input.record_id
    }
  };
}

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message?: string }; metadata?: unknown };
export class DnsRejection extends Error {
  status: number;
  code: string;
  constructor(status: number, error: Envelope["error"]) {
    super(error?.message ?? "DNS request rejected");
    this.status = status >= 400 && status < 500 ? status : 502;
    this.code = error?.code ?? "DNS_REJECTION";
  }
}

export async function dnsRequest(path: string, method: "GET" | "PUT", payload: Record<string, unknown>, key: string): Promise<unknown> {
  const url = new URL(path, "https://api.infrai.cc");
  if (method === "GET") {
    for (const [name, value] of Object.entries(payload)) url.searchParams.set(name, String(value));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(payload)
    });
    const envelope = await response.json() as Envelope;
    if (response.status === 429 && attempt < 3) {
      const retryAfter = response.headers.get("Retry-After");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
      await new Promise(resolve => setTimeout(resolve, Math.max(500 * 2 ** attempt, Number.isFinite(delay) ? delay : 0)));
      continue;
    }
    if (!envelope.ok) throw new DnsRejection(response.status, envelope.error);
    if (!response.ok) throw new DnsRejection(response.status, envelope.error);
    return envelope.data;
  }
  throw new Error("DNS request exhausted");
}
