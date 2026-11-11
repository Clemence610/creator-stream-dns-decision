import { createServer } from "node:http";
import { z } from "zod";
import { deliveryInput, decideDelivery, dnsRequest, DnsRejection } from "./delivery_policy.ts";

const key = process.env.INFRAI_API_KEY;
if (!key) throw new Error("Set INFRAI_API_KEY before starting the service");
const zoneData = z.object({ zone_id: z.string().min(1) });

createServer(async (request, response) => {
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.method !== "POST" || request.url !== "/creator-delivery") {
    send(404, { message: "Use POST /creator-delivery" });
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 16384) {
        send(413, { message: "Request body exceeds 16 KiB" });
        return;
      }
    }
    const input = deliveryInput.parse(JSON.parse(body));
    const decision = decideDelivery(input);
    if (decision.state === "waiting") {
      send(202, decision);
      return;
    }
    const zone = zoneData.parse(await dnsRequest("/v1/dns/domain/get", "GET", { domain: input.domain }, key));
    await dnsRequest("/v1/dns/record/upsert", "PUT", { zone_id: zone.zone_id, ...decision.record }, key);
    const records = await dnsRequest("/v1/dns/record/list", "GET", { zone_id: zone.zone_id }, key);
    send(200, {
      state: "published", assetId: input.assetId,
      hostname: `${decision.record.name}.${input.domain}`, zone_id: zone.zone_id, records
    });
  } catch (error) {
    if (error instanceof DnsRejection) {
      send(error.status, { error: { code: error.code, message: error.message } });
    } else if (error instanceof SyntaxError || error instanceof z.ZodError) {
      send(400, { message: "Invalid delivery request" });
    } else {
      send(502, { message: "Delivery request could not be completed" });
    }
  }
}).listen(3000, "127.0.0.1", () => console.log("Creator delivery listening on http://127.0.0.1:3000"));
