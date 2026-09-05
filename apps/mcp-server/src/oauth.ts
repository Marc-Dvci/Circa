import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";

/**
 * OAuth 2.1 for the MCP endpoint: authorization code with PKCE S256.
 *
 * Alexa+ account-linking for an MCP add-on documents a narrow profile, and the
 * narrowness is the point — most of what an OAuth library gives you is not
 * allowed here. Dynamic client registration is not supported. Client ID metadata
 * documents are not supported. OIDC is not supported. Step-up authorization is
 * not supported. Tokens go in the Authorization header and nowhere else.
 *
 * So this is written out rather than pulled in: an authorization server small
 * enough to read in one sitting, implementing exactly the profile Alexa+ will
 * drive, with the PKCE verification in one function that a test drives into its
 * failing branch on purpose.
 *
 * It is a *demo* authorization server. It issues tokens for one seeded account
 * and stores them in memory, and `docs/AUTH.md` says so in the first line. What
 * is real is the protocol: the metadata documents, the code challenge, the
 * single-use code, the resource binding and the rejection paths.
 */

export interface OAuthConfig {
  /** The externally reachable base URL, e.g. https://circa.example.com */
  issuer: string;
  /** The MCP endpoint this token is good for. RFC 8707 binds the token to it. */
  resource: string;
  /** Registered redirect URIs. Alexa+ has no DCR, so these are configured out of band. */
  redirectUris: string[];
  clientId: string;
  accessTokenTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
}

export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  subject: string;
  expiresAt: number;
  resource: string;
}

interface PendingCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scopes: string[];
  subject: string;
  resource: string;
  expiresAt: number;
  used: boolean;
}

export const SCOPES = ["repair:read", "repair:write"] as const;

const DEFAULT_CODE_TTL = 60;
const DEFAULT_TOKEN_TTL = 3600;

export class DemoAuthorizationServer {
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<string, AuthInfo>();

  constructor(private readonly config: OAuthConfig) {}

  /**
   * RFC 9728 protected-resource metadata.
   *
   * `authorization_servers` is what turns a bare 401 into something a client can
   * act on. It carries more weight here than usual, because the Alexa+
   * account-linking page documents a 401 body and never mentions the
   * `WWW-Authenticate` header, so this document is the route from "you are not
   * authorised" to "here is where to get authorised". See `docs/FRICTION_LOG.md`
   * entry 1.
   */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: `${this.config.issuer}/docs`,
    };
  }

  /** RFC 8414 authorization-server metadata, restricted to what Alexa+ drives. */
  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/oauth/authorize`,
      token_endpoint: `${this.config.issuer}/oauth/token`,
      response_types_supported: ["code"],
      // Only what is implemented. `refresh_token` was advertised here first and
      // the grant did not exist, which is the same mistake as the absent
      // `registration_endpoint` in the other direction: a metadata document is a
      // promise about what the token endpoint will accept.
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...SCOPES],
      // Deliberately absent: registration_endpoint. Alexa+ does not perform
      // dynamic client registration, and advertising an endpoint nobody may call
      // is an invitation to somebody else.
    };
  }

  authorize(params: URLSearchParams): { redirect: string } | { error: string; description: string } {
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const responseType = params.get("response_type");
    const challenge = params.get("code_challenge");
    const method = params.get("code_challenge_method");
    const state = params.get("state");
    const resource = params.get("resource");
    const scope = params.get("scope") ?? SCOPES.join(" ");

    if (clientId !== this.config.clientId) return { error: "invalid_client", description: "unknown client_id" };
    if (!redirectUri || !this.config.redirectUris.includes(redirectUri))
      return { error: "invalid_request", description: "redirect_uri is not registered" };
    if (responseType !== "code") return { error: "unsupported_response_type", description: "only code is supported" };
    if (!challenge) return { error: "invalid_request", description: "code_challenge is required" };
    // OAuth 2.1 removes `plain`. Accepting it "for compatibility" would remove
    // the only thing PKCE does, so it is rejected rather than downgraded.
    if (method !== "S256") return { error: "invalid_request", description: "code_challenge_method must be S256" };
    // RFC 8707. Alexa+ sends it, and a token minted without it would be usable
    // against any resource that trusts this issuer.
    if (!resource) return { error: "invalid_request", description: "resource is required" };

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scopes: scope.split(/\s+/).filter(Boolean),
      subject: "user_demo",
      resource,
      expiresAt: Date.now() + (this.config.authorizationCodeTtlSeconds ?? DEFAULT_CODE_TTL) * 1000,
      used: false,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return { redirect: url.toString() };
  }

  token(params: URLSearchParams): { body: Record<string, unknown> } | { error: string; description: string } {
    if (params.get("grant_type") !== "authorization_code")
      return { error: "unsupported_grant_type", description: "only authorization_code is supported" };
    const code = params.get("code");
    const verifier = params.get("code_verifier");
    const redirectUri = params.get("redirect_uri");
    const resource = params.get("resource");
    if (!code || !verifier) return { error: "invalid_request", description: "code and code_verifier are required" };

    const pending = this.codes.get(code);
    if (!pending) return { error: "invalid_grant", description: "unknown code" };
    // Single use, and consumed before it is checked. A code that survives a
    // failed exchange is a code an attacker gets to keep guessing against.
    this.codes.delete(code);
    if (pending.used) return { error: "invalid_grant", description: "code already used" };
    if (pending.expiresAt < Date.now()) return { error: "invalid_grant", description: "code expired" };
    if (redirectUri && redirectUri !== pending.redirectUri)
      return { error: "invalid_grant", description: "redirect_uri does not match the authorization request" };
    if (resource && resource !== pending.resource)
      return { error: "invalid_target", description: "resource does not match the authorization request" };
    if (!verifyPkce(verifier, pending.codeChallenge))
      return { error: "invalid_grant", description: "code_verifier does not match code_challenge" };

    const token = randomBytes(32).toString("base64url");
    const ttl = this.config.accessTokenTtlSeconds ?? DEFAULT_TOKEN_TTL;
    this.tokens.set(token, {
      token,
      clientId: pending.clientId,
      scopes: pending.scopes,
      subject: pending.subject,
      expiresAt: Date.now() + ttl * 1000,
      resource: pending.resource,
    });
    return {
      body: {
        access_token: token,
        token_type: "Bearer",
        expires_in: ttl,
        scope: pending.scopes.join(" "),
      },
    };
  }

  verify(token: string): AuthInfo | undefined {
    const info = this.tokens.get(token);
    if (!info) return undefined;
    if (info.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    if (info.resource !== this.config.resource) return undefined;
    return info;
  }
}

/**
 * S256, compared in constant time.
 *
 * The comparison is length-checked first because `timingSafeEqual` throws on a
 * length mismatch, and a thrown exception here would be a 500 rather than an
 * `invalid_grant` — which is both a worse answer and a side channel.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(/\s+/, 2);
  // Bearer header only. Alexa+ documents no query-parameter or body form, and
  // accepting one would put an access token in every proxy log on the way.
  if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return undefined;
  return value;
}

/**
 * The 401.
 *
 * RFC 9728 §5.1 says a protected resource answering 401 SHOULD send
 * `WWW-Authenticate` carrying a `resource_metadata` parameter. The Alexa+
 * account-linking documentation shows a 401 whose body is a JSON error object
 * and does not mention the header anywhere, so the shape it documents is the
 * shape sent here: `resource_metadata` in the body, and no header.
 *
 * Matching the documented example rather than the RFC is the safer of the two,
 * because a client that reads the body is described and a client that reads the
 * header is not. It is still a deviation, and it is written up as entry 1 of
 * `docs/FRICTION_LOG.md` rather than left to be discovered.
 */
export function unauthorized(response: Response, resourceMetadataUrl: string): void {
  response.status(401).json({
    error: "unauthorized",
    error_description: "This resource requires an access token.",
    resource_metadata: resourceMetadataUrl,
  });
}

export function oauthRouter(authServer: DemoAuthorizationServer, config: OAuthConfig): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(authServer.protectedResourceMetadata());
  });
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authServer.authorizationServerMetadata());
  });

  router.get("/oauth/authorize", (req, res) => {
    const result = authServer.authorize(new URLSearchParams(req.query as Record<string, string>));
    if ("error" in result) {
      res.status(400).json({ error: result.error, error_description: result.description });
      return;
    }
    res.redirect(302, result.redirect);
  });

  router.post("/oauth/token", (req, res) => {
    const params = new URLSearchParams(req.body as Record<string, string>);
    const result = authServer.token(params);
    if ("error" in result) {
      res.status(400).json({ error: result.error, error_description: result.description });
      return;
    }
    res.set("Cache-Control", "no-store").json(result.body);
  });

  void config;
  return router;
}

/** Gate the MCP endpoint. Off unless `CIRCA_AUTH=1`, so a clean clone runs with no account. */
export function requireBearer(authServer: DemoAuthorizationServer, config: OAuthConfig): RequestHandler {
  const metadataUrl = `${config.issuer}/.well-known/oauth-protected-resource`;
  return (req, res, next) => {
    const token = bearerToken(req);
    const info = token ? authServer.verify(token) : undefined;
    if (!info) {
      unauthorized(res, metadataUrl);
      return;
    }
    (req as Request & { auth?: AuthInfo }).auth = info;
    next();
  };
}
