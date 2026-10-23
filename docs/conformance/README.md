# Clients I did not write

`tests/mcp-conformance.test.ts` connects the MCP SDK's own client to the server
over a real socket. That proves the server agrees with the SDK it was built on.
These four runs put clients and checkers from other authors in front of it, and
commit what they returned.

| client | what it ran | result | output |
|---|---|---|---|
| **MCP Inspector** CLI, `@modelcontextprotocol/inspector` 2.12.0 | `initialize`, `tools/list`, `resources/list`, `resources/read`, then the whole demo as 14 `tools/call`, each its own process and session | protocol **2025-11-25**, 16 tools, 6 views, the refusal, then $4,030 / $420 / $200 and "Seal penetrations"; 18 of 18 calls without an error | [`INSPECTOR.md`](INSPECTOR.md), [`inspector.json`](inspector.json) |
| **MCP conformance suite**, `@modelcontextprotocol/conformance` 0.2.0-alpha.12, requirements 2025-11-25 | every scenario the 2025-11-25 requirement set scores, plus three it runs unscored | **7 of 7** scenarios that apply to this server pass; two of them failed on the first run and were fixed | [`suite.json`](suite.json) |
| **Virtual Alexa**, `virtual-alexa` 0.7.8 (Bespoken) | the classic skill's 18-turn conversation, resolved from the words against the interaction model, sent to the deployed Lambda | 18 of 18 turns resolved to the expected intent and answered | [`../alexa/RUN.md`](../alexa/RUN.md), [`../alexa/run.json`](../alexa/run.json) |
| **skills-ref**, the Agent Skills specification's reference validator | `skills-ref validate skills/circa-quote-check` | valid | CI |

All four run in GitHub Actions on every push (`.github/workflows/verify.yml`):
`pnpm inspector --check`, `pnpm conformance --check`, `tests/alexa-skill.test.ts`
(Virtual Alexa, in-process) and `skills-ref validate`. The committed files above
come from the same scripts without `--check`.

## What the conformance suite found

Two defects, both on the transport, both invisible to a client written against
the same SDK:

- **No DNS rebinding protection.** `dns-rebinding-protection` sent an
  `initialize` with `Host: evil.example.com` and got 200. A web page on any
  domain that rebinds to 127.0.0.1 could have driven a local CIRCA server. The
  MCP endpoint now accepts only loopback, the configured public hostname and the
  hostname Render assigns, through the SDK's `hostHeaderValidation`, and answers
  a browser `Origin` on any other host with 403.
- **400 instead of 404 for a session that has ended.** `server-session-lifecycle`
  terminated a session and reused its id. The specification's answer is 404,
  which tells a client to initialize again; CIRCA answered 400, which tells it
  the request was malformed. A request with no session id still gets 400.

`tests/mcp-conformance.test.ts` now asserts both.

## How the 30 scored scenarios divide

| | scenarios | |
|---|---|---|
| apply to this server, and pass | 6 | `server-initialize`, `ping`, `tools-list`, `resources-list`, `server-sse-multiple-streams`, `dns-rebinding-protection` (and, unscored, `server-session-lifecycle`) |
| call a fixture the suite expects a reference server to carry | 12 | `test_image_content`, `test_audio_content`, `test_embedded_resource`, `test://static-text` and the like; `suite.json` names each one |
| exercise a capability CIRCA does not declare | 10 | prompts (5), logging (2), completions (1), resource subscriptions (2) |
| report a pass on a fixture that is not there | 2 | `tools-call-simple-text` and `tools-call-error` record SUCCESS on an isError "not found" result; not counted above |

CIRCA declares `tools`, `resources` and the MCP Apps extension, which is what an
Alexa+ add-on uses. The scenarios in the last three rows are reported in
`suite.json` exactly as the suite returned them.
