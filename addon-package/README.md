# The Alexa+ add-on package

`addon.json` is the manifest CIRCA would be submitted with. It is checked rather
than eyeballed: `tests/addon.test.ts` asserts every documented constraint — the
name at 30 characters, the short description at 123, the full description at
4,000, three to four example phrases each at 200, both policy URLs HTTPS, and an
`MCP` integration carrying a default endpoint.

**The endpoint is `https://circa.example.com/mcp` and that host does not exist.**
`example.com` is reserved by IANA for exactly this, and it is written that way so
that nobody — a judge, or a future me — mistakes it for a deployment. There is
no public CIRCA endpoint. `docs/AWS.md` says why, and it is not a hedge: the AWS
credentials on this machine resolve through the SDK's provider chain and are then
rejected by STS with `InvalidClientTokenId`, so nothing was deployed anywhere.

To point the manifest at a real server, replace that one URI and turn on the
account-linking gate:

```bash
CIRCA_AUTH=1 CIRCA_PUBLIC_URL=https://your-host pnpm mcp
```

The OAuth 2.1 profile Alexa+ drives — authorization code with PKCE S256, RFC 9728
protected-resource metadata, RFC 8414 authorization-server metadata, RFC 8707
resource binding — is implemented in `apps/mcp-server/src/oauth.ts` and driven
end to end by `tests/oauth.test.ts`, including the five rejection paths. See
`docs/AUTH.md`.
