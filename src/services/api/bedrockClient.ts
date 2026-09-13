import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import type {
  Middleware,
  MiddlewareNext,
} from '@anthropic-ai/sdk/core/middleware.mjs'

/**
 * Extends AnthropicBedrock to work around an upstream bug where the SDK
 * re-plants the `anthropic-beta` HTTP header value into the request body
 * as `anthropic_beta`. Bedrock's Opus 4.7 endpoint rejects any request with
 * `anthropic_beta` in the body with a 400 "invalid beta flag" error.
 *
 * Source of the bug (bedrock-sdk 0.33.5):
 *   node_modules/@anthropic-ai/bedrock-sdk/client.js
 *   `_AnthropicBedrock_adaptRequest` (dist/client.js lines 149-158):
 *     parsedBody['anthropic_beta'] = headers.get('anthropic-beta').split(',')
 *   Since 0.33 the adaptation runs as backend *middleware* (not inside
 *   `buildRequest` as in 0.26-0.29), immediately around `fetch` — so a
 *   `buildRequest` override is too early: the middleware re-plants the field
 *   and signs the re-planted body.
 *
 * Related upstream issue: anthropics/claude-code#49238 (opened 2026-04-16).
 *
 * Fix strategy: override `backendMiddleware()` and wrap the backend chain.
 * Before super's middleware runs (Bedrock URL/body rewrite + SigV4 signing),
 * strip the `anthropic-beta` header — so nothing is planted into the body —
 * and drop any `anthropic_beta` already present in the body. Then re-add the
 * header in a wrapped innermost `next`, right before `fetch`: at that point
 * the signature is already computed, and `anthropic-beta` merely becomes an
 * unsigned extra header (AWS SigV4 only verifies the headers listed in
 * `SignedHeaders`), so beta flags still reach Bedrock the way it accepts
 * them while the signed payload stays clean.
 *
 * When upstream ships a fix (stops planting `anthropic_beta`), delete this
 * class and change `services/api/client.ts` to instantiate `AnthropicBedrock`
 * directly.
 */

function stripAnthropicBetaFromBody<
  T extends { body?: unknown; headers: Headers },
>(req: T): T {
  if (typeof req.body !== 'string' || req.body.length === 0) {
    return req
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(req.body) as Record<string, unknown>
  } catch {
    return req
  }
  if (!('anthropic_beta' in parsed)) {
    return req
  }
  delete parsed.anthropic_beta
  const cleanedBody = JSON.stringify(parsed)
  const headers = new Headers(req.headers)
  if (headers.has('content-length')) {
    headers.set(
      'content-length',
      String(new TextEncoder().encode(cleanedBody).length),
    )
  }
  return { ...req, body: cleanedBody, headers }
}

export class BedrockClient extends AnthropicBedrock {
  protected override backendMiddleware(): ReadonlyArray<Middleware> {
    const backend = super.backendMiddleware()
    return [
      async (request, next, ctx) => {
        // Capture the beta flags header the base SDK built from `betas:`,
        // then remove it so the backend adaptation cannot plant it into
        // the body it signs.
        const betaHeader = request.headers.get('anthropic-beta')
        const headers = new Headers(request.headers)
        headers.delete('anthropic-beta')
        const stripped = stripAnthropicBetaFromBody({
          ...request,
          headers,
        })

        // Innermost continuation, immediately around fetch: re-attach the
        // beta header AFTER super's middleware has signed the request.
        let chained: MiddlewareNext = async wireRequest => {
          if (betaHeader == null) {
            return next(wireRequest)
          }
          const wireHeaders = new Headers(wireRequest.headers)
          wireHeaders.set('anthropic-beta', betaHeader)
          return next({ ...wireRequest, headers: wireHeaders })
        }
        // Compose super's backend middlewares over that continuation
        // (last one ends up innermost, matching the SDK's own ordering).
        for (let i = backend.length - 1; i >= 0; i--) {
          const mw = backend[i]
          const inner = chained
          chained = async adapted => mw(adapted, inner, ctx)
        }
        return chained(stripped)
      },
    ]
  }
}
