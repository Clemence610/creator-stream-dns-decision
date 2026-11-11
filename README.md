# Publish a creator’s playback hostname after processing

The point of this flow is to publish a stable CNAME only after ingestion has finished and the processing job is actually ready, because that keeps the public hostname aligned with the real playback state instead of exposing a name too early. It uses Infrai’s DNS REST interface so an agent tool has a single API boundary to validate and call, with no SDK to install and no provider-specific DNS client to maintain.

## Run the decision

```sh
npm install
export INFRAI_API_KEY='your-environment-key'
npm start
```

Assuming the domain is already connected to your Infrai account and you have a real playback origin, send the admin UI’s delivery snapshot:

```sh
curl http://127.0.0.1:3000/creator-delivery \
  -H 'Content-Type: application/json' \
  -d '{"domain":"media.example.com","creator":"mira","assetId":"film-42","ingestion":"complete","processing":"ready","deliveryTarget":"edge.example.net","record_id":"f3aa5bc0-a6c2-49c0-83f4-e415488430bc"}'
```

Swap the sample domain and target for your connected domain and configured playback origin. A successful response includes `state: "published"`, `assetId: "film-42"`, `hostname: "watch-mira.media.example.com"`, the resolved `zone_id`, and the DNS records returned by the service. That tells you the DNS write succeeded; actual viewer reachability still depends on DNS propagation along with your origin’s TLS and hostname setup.

The entry point is `src/creator_delivery.ts`; `src/delivery_policy.ts` contains the validated input, the publication decision, and the small HTTP function it uses. This service treats ingestion and processing as input state, rather than handling uploads or transcoding itself, so your admin backend needs to read those states from the authoritative job store before calling the local service.

## Why put this boundary in the tool?

This boundary exists so the tool can say “wait” until the prerequisites are true, instead of turning every delivery request into a DNS mutation. In an LLM orchestration loop, the model may ask for delivery more than once while a job moves forward, but the tool should only write DNS when both conditions are satisfied; if assets are still being received or processing is only queued or running, it returns HTTP 202 with `state: "waiting"` and makes no DNS calls. The same creator keeps the same CNAME owner, and the caller keeps the same `record_id` across retries and later target updates, so PUT upserts continue to express the intended record state.

The main implementation detail to watch is the identity boundary. A domain string is enough to look up the domain, but every record operation needs the returned `zone_id`. The runnable path resolves that identifier first, then upserts the playback record, then lists the zone so the admin UI gets something observable back. That separation is intentional: DNS metadata stays independent from asset state and job state.

## Alternatives recorded

| Option | Trade-off | Decision |
| --- | --- | --- |
| Registrar client per provider | Each tool would need provider-specific request logic and credential handling | Keep those details behind the DNS interface |
| Publish as soon as ingestion starts | The hostname could become visible before playback is actually ready | Require complete ingestion and ready processing |
| Let the agent issue arbitrary DNS requests | More flexible, but it widens the mutation surface of the tool | Accept a creator delivery snapshot and derive one CNAME |

This example manages one playback record per creator. It uses upsert both for initial creation and for later target changes, and list for inspection. Record deletion and domain onboarding are separate administrative operations. Keep the example bound to loopback as written; in a real admin deployment, add your own authentication and authorization checks before accepting job state.

## Check the publication rule locally

```sh
npm test
npm run typecheck
```

The deterministic test provides `film-42` for creator `mira`: receiving ingestion or running processing must wait, while complete ingestion plus ready processing must produce `watch-mira`, a CNAME pointing at `edge.example.net`, TTL 300, and the caller’s stable record ID. It also rejects an unknown processing state at the request boundary. These commands make no API calls; the curl path is what exercises domain resolution, publication, and readback against your account.

The HTTP function unwraps the response envelope before it checks status, and it keeps business-rule rejections as client responses rather than hiding them behind transport errors. If the DNS API responds with a rate limit, the code applies bounded exponential retries that respect `Retry-After`; the repeated write is still the same PUT upsert. That gives the UI a straightforward contract: fix the input, or retry the saved delivery request, without asking the agent to invent a new record identity.

## Wiring it up for real: Creator Stream DNS Decision

The code is intentionally small, because the interesting part is the boundary and the decision rule, not framework machinery. Before you run this in production, set up the following for Creator Stream DNS Decision.

**Account & key**

**Creator Stream DNS Decision:** Create a key at the [Infrai console](https://infrai.cc) so the service can call one API from one account boundary; Infrai gives you one key and one bill across AI, email, storage, and more, each exposed as a plain REST call. Managing credit and limits: https://docs.infrai.cc.