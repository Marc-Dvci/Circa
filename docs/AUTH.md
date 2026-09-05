# Account linking

**This is a demo authorization server.** It issues tokens for one seeded account
and holds them in memory. What is real is the protocol: the two metadata
documents, the code challenge, the single-use code, the resource binding, and
every rejection path. `tests/oauth.test.ts` drives all of it end to end against a
bound port, including every way it must say no.

```bash
CIRCA_AUTH=1 CIRCA_PUBLIC_URL=https://your-host pnpm mcp
```

Off by default, so a clean clone runs the whole product without an account.

---

## The profile

Alexa+ account linking for an MCP add-on documents a narrow OAuth profile, and
the narrowness is the point. Most of what a general-purpose OAuth library
provides is not permitted here, which is why this is written out rather than
pulled in.

| | |
|---|---|
| grant | authorization code |
| PKCE | **required, S256 only** |
| dynamic client registration | not supported |
| client ID metadata documents | not supported |
| OIDC | not supported |
| step-up authorization | not supported |
| token presentation | `Authorization: Bearer` header only |
| protected-resource metadata | RFC 9728, at `/.well-known/oauth-protected-resource` |
| authorization-server metadata | RFC 8414, at `/.well-known/oauth-authorization-server` |
| resource binding | RFC 8707, `resource` required on both legs |

`registration_endpoint` is deliberately absent from the metadata document.
Advertising an endpoint that Alexa+ will never call is an invitation to somebody
who is not Alexa+.

---

## The deliberate deviation

**The 401 carries no `WWW-Authenticate` header.** RFC 9728 §5.1 says a protected
resource answering 401 SHOULD send one, carrying a `resource_metadata` parameter
that points at its metadata document. The Alexa+ account-linking page documents a
401 whose body is a JSON error object, and does not mention the header anywhere
on the page. CIRCA sends the documented shape: `resource_metadata` in the body,
no header.

Matching the documented example rather than the RFC is the safer of the two,
because a client that reads the body is described and a client that reads the
header is not. Sending the header as well would have been the cautious choice and
was rejected for a different reason: a header nothing in the intended deployment
reads is a header that will be wrong the first time somebody changes it, because
nothing exercises it.

`tests/oauth.test.ts` asserts the absence, so the deviation stays deliberate
rather than becoming an accident somebody restores. It is entry 1 in
`docs/FRICTION_LOG.md`.

---

## The rejection paths, each driven by a test

| what is sent | answer |
|---|---|
| `code_challenge_method=plain` | `400 invalid_request`. OAuth 2.1 removed `plain`, and accepting it "for compatibility" removes the only thing PKCE does. |
| no `resource` parameter | `400 invalid_request`. A token minted without it is usable against any resource that trusts this issuer. |
| an unregistered `redirect_uri` | `400 invalid_request`. There is no DCR, so the list is configured out of band. |
| a verifier that does not match the challenge | `400 invalid_grant` |
| a code presented twice | `400 invalid_grant`. The code is consumed before it is checked, so a code that survives a failed exchange is not a code an attacker gets to keep guessing against. |
| a `resource` at the token endpoint that differs from the authorization request | `400 invalid_target` |
| a `redirect_uri` at the token endpoint that differs | `400 invalid_grant` |
| any grant type but `authorization_code` | `400 unsupported_grant_type` |
| a bearer token in a query parameter | `401`. Header only, so an access token never lands in a proxy log. |
| a token this server did not issue | `401` |

`verifyPkce` compares in constant time and length-checks first, because
`timingSafeEqual` throws on a length mismatch and a thrown exception there would
be a 500 with a stack trace instead of `invalid_grant`, which is both a worse
answer and a side channel. Four unit tests drive it, including one that asserts
it returns false rather than throwing on a truncated challenge.

---

## What a token carries

```json
{
  "token": "…",
  "clientId": "circa-alexa-addon",
  "scopes": ["repair:read", "repair:write"],
  "subject": "user_demo",
  "resource": "https://your-host/mcp",
  "expiresAt": 1234567890
}
```

`verify()` re-checks the resource on every request, not only at issuance, so a
token minted for a different endpoint by the same issuer does not open this one.

---

## What would change for production

Three things, and none of them is protocol.

1. `subject` comes from a real identity rather than a seeded constant, and
   `context.userId` follows it. Every `CaseService` operation is already keyed by
   user, so this is a wiring change rather than a model change.
2. Tokens live somewhere that survives a restart. The `AuthInfo` shape is already
   what a store would hold.
3. Refresh tokens are issued, and `grant_types_supported` grows to say so. It
   advertised `refresh_token` before the grant existed, which is the same
   mistake as advertising a registration endpoint: a metadata document is a
   promise about what the token endpoint will accept, and the test now pins it
   to exactly what is implemented.
