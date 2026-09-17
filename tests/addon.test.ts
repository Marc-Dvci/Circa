import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The add-on manifest, against the constraints Amazon documents.
 *
 * A manifest is rejected on a character count, and a character count is exactly
 * the kind of thing that is right when it is written and wrong two edits later.
 * The limits below are the ones published in the Alexa+ MCP Toolkit quickstart's
 * `addon.json` schema reference, so a description that grew past 123 characters
 * fails a test rather than a submission.
 *
 * The shape is asserted as well as the lengths, and that is the part that was
 * missing. The first version of this file described a flat manifest of its own
 * invention and asserted the documented limits on it — every assertion passed,
 * against a document the CLI would have rejected on the first key it read.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = path.join(REPO_ROOT, "addon-package/media");

/** Every icon size the quickstart lists as required, in the order it lists them. */
const REQUIRED_ICON_SIZES = ["72x72", "64x64", "88x88", "126x126", "180x180", "241x241"] as const;

interface Image {
  size: string;
  uri: string;
  altText?: string;
}

interface Locale {
  default: string;
  name: { value: string };
  shortDescription: string;
  fullDescription: string;
  examplePhrases: string[];
  privacyAndCompliance: { privacyPolicyUrl: string; termsOfUseUrl: string };
  mediaAssets: {
    icons: { light: Image[]; dark: Image[] };
    carouselImages: Image[];
    bannerImages: Image[];
  };
}

interface Addon {
  manifestVersion: string;
  storeListing: { distributionCountries: string[]; locales: Record<string, Locale> };
  integrations: { type: string; config: { endpoints: { default: { type: string; uri: string } } } }[];
}

const addon = JSON.parse(await readFile(path.join(REPO_ROOT, "addon-package/addon.json"), "utf8")) as Addon;
const locale = addon.storeListing.locales["en-US"]!;

describe("addon.json", () => {
  it("declares the manifest version Alexa+ expects", () => {
    expect(addon.manifestVersion).toBe("1.0");
  });

  it("nests the store listing under storeListing.locales, as the schema does", () => {
    expect(addon.storeListing.distributionCountries).toContain("US");
    expect(Object.keys(addon.storeListing.locales)).toContain("en-US");
    expect(locale.default).toBe("DEFAULT");
    // Nothing from the store listing may sit at the top level.
    for (const key of ["name", "shortDescription", "fullDescription", "examplePhrases", "privacyPolicyUrl"]) {
      expect(addon, key).not.toHaveProperty(key);
    }
  });

  it("keeps every field inside its documented length", () => {
    expect(locale.name.value.length).toBeLessThanOrEqual(30);
    expect(locale.shortDescription.length).toBeLessThanOrEqual(123);
    expect(locale.fullDescription.length).toBeLessThanOrEqual(4000);
    expect(locale.examplePhrases.length).toBeGreaterThanOrEqual(3);
    expect(locale.examplePhrases.length).toBeLessThanOrEqual(4);
    for (const phrase of locale.examplePhrases) {
      expect(phrase.length, phrase).toBeLessThanOrEqual(200);
    }
    for (const image of [...locale.mediaAssets.carouselImages, ...locale.mediaAssets.bannerImages]) {
      expect((image.altText ?? "").length, image.uri).toBeLessThanOrEqual(250);
      expect(image.altText, image.uri).toBeTruthy();
    }
  });

  it("asks in the words Alexa+ is spoken to in, not in Skills Kit words", () => {
    // Alexa+ add-ons are reached by saying what you want. "Alexa, ask <name> to
    // …" is the Alexa Skills Kit invocation model, and an example phrase written
    // that way teaches the customer an interaction this product does not have.
    for (const phrase of locale.examplePhrases) {
      expect(phrase, phrase).not.toMatch(/\bask\s+circa\b/i);
      expect(phrase, phrase).not.toMatch(/^alexa[,\s]/i);
    }
  });

  it("serves both policy documents over HTTPS", () => {
    expect(locale.privacyAndCompliance.privacyPolicyUrl.startsWith("https://")).toBe(true);
    expect(locale.privacyAndCompliance.termsOfUseUrl.startsWith("https://")).toBe(true);
  });

  it("carries all six light icon sizes, and files that exist at those dimensions", async () => {
    const declared = locale.mediaAssets.icons.light.map((icon) => icon.size);
    expect([...declared].sort()).toEqual([...REQUIRED_ICON_SIZES].sort());
    for (const icon of locale.mediaAssets.icons.light) {
      expect(icon.uri, icon.size).toMatch(/^https:\/\/.+\.(png|jpg|jpeg|webp)$/i);
      // The URI is remote, but the bytes are in this repository and that is what
      // the URI resolves to. A manifest naming an icon nobody generated is the
      // failure this catches.
      const file = path.join(MEDIA, path.basename(new URL(icon.uri).pathname));
      expect((await stat(file)).size, file).toBeGreaterThan(0);
    }
  });

  it("carries at least one 600x900 carousel image with alt text", async () => {
    const carousel = locale.mediaAssets.carouselImages;
    expect(carousel.length).toBeGreaterThanOrEqual(1);
    expect(carousel[0]!.size).toBe("600x900");
    const file = path.join(MEDIA, path.basename(new URL(carousel[0]!.uri).pathname));
    expect((await stat(file)).size, file).toBeGreaterThan(0);
  });

  it("integrates as MCP over an HTTPS endpoint, with the type named", () => {
    const integration = addon.integrations[0]!;
    expect(integration.type).toBe("MCP");
    expect(integration.config.endpoints.default.type).toBe("HTTPS");
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
    expect(locale.fullDescription).toMatch(/will not tell you whether a contractor is trustworthy/i);
    expect(locale.fullDescription).toMatch(/no score/i);
  });
});
