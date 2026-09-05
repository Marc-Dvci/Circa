import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The add-on manifest, against the constraints Amazon documents.
 *
 * A manifest is rejected on a character count, and a character count is exactly
 * the kind of thing that is right when it is written and wrong two edits later.
 * The limits below are the documented ones; keeping them here means a
 * description that grew past 123 characters fails a test rather than a
 * submission.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Addon {
  manifestVersion: string;
  name: { value: string };
  shortDescription: string;
  fullDescription: string;
  examplePhrases: string[];
  privacyPolicyUrl: string;
  termsOfUseUrl: string;
  integrations: { type: string; config: { endpoints: { default: { uri: string } } } }[];
}

const addon = JSON.parse(await readFile(path.join(REPO_ROOT, "addon-package/addon.json"), "utf8")) as Addon;

describe("addon.json", () => {
  it("declares the manifest version Alexa+ expects", () => {
    expect(addon.manifestVersion).toBe("1.0");
  });

  it("keeps every field inside its documented length", () => {
    expect(addon.name.value.length).toBeLessThanOrEqual(30);
    expect(addon.shortDescription.length).toBeLessThanOrEqual(123);
    expect(addon.fullDescription.length).toBeLessThanOrEqual(4000);
    expect(addon.examplePhrases.length).toBeGreaterThanOrEqual(3);
    expect(addon.examplePhrases.length).toBeLessThanOrEqual(4);
    for (const phrase of addon.examplePhrases) {
      expect(phrase.length, phrase).toBeLessThanOrEqual(200);
    }
  });

  it("serves both policy documents over HTTPS", () => {
    expect(addon.privacyPolicyUrl.startsWith("https://")).toBe(true);
    expect(addon.termsOfUseUrl.startsWith("https://")).toBe(true);
  });

  it("integrates as MCP and names a default endpoint", () => {
    const integration = addon.integrations[0]!;
    expect(integration.type).toBe("MCP");
    expect(integration.config.endpoints.default.uri.startsWith("https://")).toBe(true);
  });

  it("does not claim an endpoint that exists", () => {
    // The manifest is complete and the host is IANA's reserved example domain,
    // on purpose: nothing is deployed, and a plausible-looking hostname here
    // would be the one part of this repository that misleads a reader.
    expect(addon.integrations[0]!.config.endpoints.default.uri).toContain("example.com");
  });

  it("says what CIRCA will not do, in the description a customer reads", () => {
    // The product's first promise is a refusal, and it belongs in the store
    // listing rather than only in the code.
    expect(addon.fullDescription).toMatch(/will not tell you whether a contractor is trustworthy/i);
    expect(addon.fullDescription).toMatch(/no score/i);
  });
});
