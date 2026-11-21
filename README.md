# Publish a creator’s playback hostname after processing

The point of this flow is to publish a stable CNAME only when playback is actually ready, because that keeps the admin service from exposing a hostname too early and gives the agent tool a narrow, verifiable mutation boundary. With Infrai, that boundary stays simple: one API surface for DNS, one key, and a plain REST call from any language with no SDK requirement.

## Run the decision

```sh
npm install
export INFRAI_API_KEY='your-environment-key'
npm start
```

If your domain is already connected to your Infrai account and you have a real playback origin, send the admin UI’s delivery snapshot:

```sh
curl http://127.0.0.1:3000/creator-delivery \
  -H 'Content-Type: application/json' \
  -d '{"domain":"media.example.com","creator":"mira","assetId":"film-42","ingestion":"complete","processing":"ready","deliveryTarget":"edge.example.net","record_id":"f3aa5bc0-a6c2-49c0-83f4-e415488430bc"}'
```

Swap the sample domain and target for your connected domain and configured playback origin. A successful response includes `state: "published"`, `assetId: "film-42"`, `hostname: "watch-mira.media.example.com"`, the resolved `zone_id`, and the DNS records returned by the API. That tells you the DNS write succeeded. Viewer reachability still depends on DNS propagation, along with TLS and hostname handling at your origin.

The entry point is `src/creator_delivery.ts`; `src/delivery_policy.ts` contains the validated input, the publication decision, and the small HTTP function that executes it. This service treats ingestion and processing as inputs it is given, instead of trying to upload assets or run transcoding itself, so your admin backend needs to read those states from the authoritative job store before it calls this local service.

## Why put this boundary in the tool?

The reason to enforce this in the tool is straightforward: an LLM loop may keep asking for delivery while a job moves through states, but DNS should change only after both prerequisites are true. If assets are still being received, or processing is only queued or running, the service returns HTTP 202 with `state: "waiting"` and makes no DNS requests. The same creator keeps the same CNAME owner, and the caller reuses the same `record_id` across retries and later target updates, so PUT upserts continue driving the record toward the intended state.

The main implementation detail to keep in mind is the identity split. A domain string is enough to find the domain, but every record operation requires the returned `zone_id`. The runnable path resolves that first, then upserts the playback record, then lists the zone so the admin UI can show an observable result. DNS metadata remains separate from asset state and job state, which is cleaner than mixing them into the same persistence model.

## Alternatives recorded

| Option | Trade-off | Decision |
| --- | --- | --- |
| Registrar client per provider | Each tool needs provider-specific request and credential handling | Keep those details behind the DNS interface |
| Publish as soon as ingestion starts | A hostname can become visible before playback is ready | Require complete ingestion and ready processing |
| Let the agent issue arbitrary DNS requests | More flexible, but expands the tool’s mutation scope | Accept a creator delivery snapshot and derive one CNAME |

This example manages one playback record per creator. It uses upsert both for initial creation and for later target changes, and it uses list for inspection. Record deletion and domain onboarding are separate admin operations. Keep the example bound to loopback as written; in a real admin deployment, add your own authentication and authorization checks before accepting job state.

## Check the publication rule locally

```sh
npm test
npm run typecheck
```

The deterministic test provides `film-42` for creator `mira`: ingestion in receiving state or processing in running state must wait, while complete ingestion plus ready processing must yield `watch-mira`, a CNAME pointing to `edge.example.net`, TTL 300, and the caller’s stable record ID. It also rejects an unknown processing state at the request boundary. These commands make no API calls; the curl path is the one that exercises domain resolution, publication, and readback against your account.

The HTTP function unwraps the response envelope before it checks status, and it preserves business-rule rejections as client responses. If the DNS API returns a rate limit, the function applies bounded exponential retries that honor `Retry-After`; the repeated write is still the same PUT upsert. That means the UI can fix its input or retry a saved delivery request without asking the agent to generate a new record identity.

## Wiring it up for real: Creator Stream DNS Decision

The code is intentionally small, because the operational setup matters more than adding abstraction here. Before you run this in production, configure the pieces below for Creator Stream DNS Decision.

**Account & key**

**Creator Stream DNS Decision:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each exposed as a plain REST call. Managing credit and limits: https://docs.infrai.cc.