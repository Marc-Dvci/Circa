import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext } from "../apps/mcp-server/src/context.js";
import { startHttpServer, type RunningServer } from "../apps/mcp-server/src/http.js";
import { verifyPkce } from "../apps/mcp-server/src/oauth.js";

/**
 * The account-linking flow, driven rather than read.
 *
 * `apps/mcp-server/src/oauth.ts` was written from the Alexa+ account-linking
 * documentation and, until this file existed, had never been executed. An OAuth
 * implementation that has only been read is an OAuth implementation whose
 * rejection paths are decorative, so every one of them is driven here: `plain`
 * instead of S256, a replayed code, a wrong verifier, a missing `resource`, an
 * unregistered redirect, a token minted for a different resource.
 *
 * The happy path ends where it has to end — the MCP SDK's own client completing
 * `initialize` and a `tools/call` through the bearer gate — because a token the
 * authorization server is happy with and the transport cannot use is not a
 * working account link.
 */

const CLIENT_ID = "circa-alexa-addon";
const REDIRECT = "http://localhost:8788/callback";

let running: RunningServer;
let issuer: string;
let resource: string;

/**
 * Bind a port, read it, release it.
 *
 * The OAuth metadata documents contain absolute URLs, so the issuer has to be
 * known before the app is constructed, which rules out the `port: 0` trick the
 * other suites use. Taking a port and handing it straight back is a small race
 * against the rest of the machine, and it is the honest version: the alternative
 * is an issuer that does not match the socket the test is talking to, which
 * would make the RFC 8707 resource binding vacuous exactly where it is asserted.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(params: Record<string, string>): Promise<Response> {
  const url = new URL(`${issuer}/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url, { redirect: "manual" });
}

async function exchange(params: Record<string, string>): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

/** One complete authorization-code + PKCE round trip, returning the access token. */
async function link(): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const authorized = await authorize({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "alexa-state",
    resource,
    scope: "repair:read repair:write",
  });
  expect(authorized.status).toBe(302);
  const location = new URL(authorized.headers.get("location") ?? "");
  expect(location.searchParams.get("state")).toBe("alexa-state");
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await exchange({
    grant_type: "authorization_code",
    code: code!,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    resource,
  });
  expect(token.status).toBe(200);
  expect(token.body["token_type"]).toBe("Bearer");
  return token.body["access_token"]!;
}

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://localhost:${port}`;
  resource = `${issuer}/mcp`;
  const context = await createContext({} as NodeJS.ProcessEnv, {
    service: new CaseService(new MemoryCaseRepository()),
  });
  running = await startHttpServer(context, { port, auth: true, publicUrl: issuer });
});

afterAll(async () => {
  await running.close();
});

describe("discovery", () => {
  it("publishes protected-resource metadata that names this endpoint and its issuer", async () => {
    const response = await fetch(`${issuer}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["resource"]).toBe(resource);
    expect(body["authorization_servers"]).toEqual([issuer]);
    expect(body["bearer_methods_supported"]).toEqual(["header"]);
  });

  it("publishes authorization-server metadata restricted to what Alexa+ drives", async () => {
    const body = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(body["issuer"]).toBe(issuer);
    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(body["response_types_supported"]).toEqual(["code"]);
    // Alexa+ performs no dynamic client registration. Advertising the endpoint
    // anyway would be an invitation to somebody who is not Alexa+.
    expect(body).not.toHaveProperty("registration_endpoint");
    // And only grants that exist: this document advertised `refresh_token`
    // before the grant did, which is a promise the token endpoint could not keep.
    expect(body["grant_types_supported"]).toEqual(["authorization_code"]);
  });
});

describe("the gate", () => {
  it("refuses an unauthenticated call and points at the metadata document instead of a header", async () => {
    const response = await fetch(`${issuer}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
    // The deliberate deviation from RFC 9728 §5.1, pinned here so it stays
    // deliberate. The Alexa+ account-linking page documents a 401 with a JSON
    // error body and no WWW-Authenticate, so the route from "not authorised" to
    // "here is where to get authorised" is the body.
    expect(response.headers.get("www-authenticate")).toBeNull();
    const body = (await response.json()) as Record<string, string>;
    expect(body["resource_metadata"]).toBe(`${issuer}/.well-known/oauth-protected-resource`);
  });

  it("refuses a token presented as a query parameter", async () => {
    const token = await link();
    const response = await fetch(`${issuer}/mcp?access_token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses a bearer token it never issued", async () => {
    const response = await fetch(`${issuer}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });
});

describe("authorization code with PKCE", () => {
  it("carries a linked account all the way to a tool result", async () => {
    const token = await link();
    const transport = new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "circa-oauth-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const started = await client.callTool({
        name: "start_repair_case",
        arguments: { issueSummary: "A plumber says the water heater has to be replaced", trade: "plumbing" },
      });
      expect((started.structuredContent as { caseId: string }).caseId).toMatch(/^case_/);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("rejects plain, which OAuth 2.1 removed and which would make PKCE decorative", async () => {
    const { challenge } = pkcePair();
    const response = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "plain",
      resource,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, string>)["error"]).toBe("invalid_request");
  });

  it("rejects an authorization request with no resource, which would mint a token good anywhere", async () => {
    const { challenge } = pkcePair();
    const response = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, string>)["error_description"]).toContain("resource");
  });

  it("rejects a redirect_uri that was not configured out of band", async () => {
    const { challenge } = pkcePair();
    const response = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: "https://not-alexa.example.com/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    expect(response.status).toBe(400);
  });

  it("rejects a verifier that does not match the challenge", async () => {
    const { challenge } = pkcePair();
    const other = pkcePair();
    const authorized = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code")!;
    const result = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: other.verifier,
      redirect_uri: REDIRECT,
      resource,
    });
    expect(result.status).toBe(400);
    expect(result.body["error"]).toBe("invalid_grant");
  });

  it("burns a code on first use, whether or not the exchange succeeded", async () => {
    const { verifier, challenge } = pkcePair();
    const authorized = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code")!;
    const args = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource };

    expect((await exchange(args)).status).toBe(200);
    const replay = await exchange(args);
    expect(replay.status).toBe(400);
    expect(replay.body["error"]).toBe("invalid_grant");
  });

  it("rejects an exchange whose resource is not the one the code was bound to", async () => {
    const { verifier, challenge } = pkcePair();
    const authorized = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code")!;
    const result = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: "https://someone-elses-mcp.example.com/mcp",
    });
    expect(result.status).toBe(400);
    expect(result.body["error"]).toBe("invalid_target");
  });

  it("rejects a redirect_uri at the token endpoint that differs from the one authorized", async () => {
    const { verifier, challenge } = pkcePair();
    const authorized = await authorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code")!;
    const result = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://layla.amazon.com/api/skill/link/circa",
      resource,
    });
    expect(result.status).toBe(400);
    expect(result.body["error"]).toBe("invalid_grant");
  });

  it("supports only the authorization_code grant", async () => {
    const result = await exchange({ grant_type: "client_credentials", code: "x", code_verifier: "y" });
    expect(result.body["error"]).toBe("unsupported_grant_type");
  });
});

describe("verifyPkce", () => {
  it("accepts the verifier that produced the challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects a different verifier of the same length", () => {
    const { challenge } = pkcePair();
    expect(verifyPkce(pkcePair().verifier, challenge)).toBe(false);
  });

  it("rejects a verifier outside the RFC 7636 length bounds without hashing it", () => {
    expect(verifyPkce("short", createHash("sha256").update("short").digest("base64url"))).toBe(false);
    const long = "a".repeat(129);
    expect(verifyPkce(long, createHash("sha256").update(long).digest("base64url"))).toBe(false);
  });

  it("returns false rather than throwing when the challenge is the wrong length", () => {
    // timingSafeEqual throws on a length mismatch, and a throw here would be a
    // 500 with a stack trace instead of invalid_grant — a worse answer and a
    // side channel at the same time.
    const { verifier } = pkcePair();
    expect(() => verifyPkce(verifier, "truncated")).not.toThrow();
    expect(verifyPkce(verifier, "truncated")).toBe(false);
  });
});
