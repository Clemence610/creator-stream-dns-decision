import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryInput, decideDelivery } from "./delivery_policy.ts";

const input = deliveryInput.parse({
  domain: "media.example.com", creator: "mira", assetId: "film-42",
  ingestion: "complete", processing: "ready", deliveryTarget: "edge.example.net",
  record_id: "f3aa5bc0-a6c2-49c0-83f4-e415488430bc"
});
test("creator leaves room for the watch- prefix in a DNS label", () => {
  const longest = deliveryInput.parse({ ...input, creator: "a".repeat(57) });
  const result = decideDelivery(longest);
  assert.equal(result.state, "publish");
  if (result.state === "publish") assert.equal(result.record.name.length, 63);
  for (const length of [58, 63]) {
    assert.equal(deliveryInput.safeParse({ ...input, creator: "a".repeat(length) }).success, false);
  }
});
test("delivery waits for both ingestion and processing, then publishes one stable CNAME", () => {
  assert.equal(decideDelivery({ ...input, ingestion: "receiving" }).state, "waiting");
  assert.equal(decideDelivery({ ...input, processing: "running" }).state, "waiting");
  const result = decideDelivery(input);
  assert.equal(result.state, "publish");
  if (result.state === "publish") {
    assert.deepEqual(result.record, {
      record_type: "CNAME", name: "watch-mira", content: "edge.example.net",
      ttl: 300, record_id: input.record_id
    });
    assert.deepEqual(decideDelivery(input), result);
  }
  assert.equal(deliveryInput.safeParse({ ...input, processing: "done" }).success, false);
});
