import { BASIS } from "#verification";

/**
 * `pnpm check:citations`.
 *
 * Every rule in this product cites published guidance by URL, and the product
 * says so out loud: "cites published FTC guidance by URL" is in the README, in
 * the store listing and in the narration. That claim is only worth making if the
 * URLs resolve, and for a while three of them did not — the FTC reorganised its
 * consumer-advice paths and `articles/hiring-contractor` became a 404 without
 * anything in this repository noticing.
 *
 * So the citations are checked against the live web, on demand rather than in
 * `pnpm verify`: a test suite that fails when a network is unavailable is a
 * suite people learn to ignore. Run it before a submission, and record the run.
 */

const TIMEOUT_MS = 20_000;

interface Result {
  key: string;
  url: string;
  status: number | string;
}

async function head(url: string): Promise<number | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // GET, not HEAD: consumer.ftc.gov answers HEAD with 403 and GET with 200,
    // and a check that reports a false failure is worse than no check.
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "circa-citation-check" },
    });
    return response.status;
  } catch (error) {
    return error instanceof Error ? error.name : "failed";
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const cited = Object.entries(BASIS as Record<string, { url?: string }>)
    .filter((entry): entry is [string, { url: string }] => typeof entry[1].url === "string")
    .map(([key, basis]) => ({ key, url: basis.url }));

  const results: Result[] = await Promise.all(
    cited.map(async ({ key, url }) => ({ key, url, status: await head(url) })),
  );

  const width = Math.max(...results.map((r) => r.key.length));
  console.log("");
  console.log(`CITATIONS  ${results.length} rule bases carrying a URL, ${new Set(cited.map((c) => c.url)).size} distinct pages`);
  for (const result of results.sort((a, b) => a.key.localeCompare(b.key))) {
    const ok = result.status === 200;
    console.log(`  ${ok ? "·" : "!"} ${result.key.padEnd(width)}  ${String(result.status).padEnd(6)}${result.url}`);
  }
  const bad = results.filter((r) => r.status !== 200);
  console.log("");
  if (bad.length > 0) {
    console.log(`${bad.length} of ${results.length} did not answer 200. A rule citing a dead page is a rule citing nothing.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${results.length} answered 200.`);
  }
}

await main();
