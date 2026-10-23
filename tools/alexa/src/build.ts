import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

/**
 * `pnpm alexa:build`: the classic skill's Lambda, as one ES module.
 *
 * Everything is bundled, the AWS SDK included, so the function runs the
 * dependency versions this repository tests rather than whichever SDK the
 * Lambda runtime happens to ship. The provider directory is a data file the
 * MCP server reads at run time, so it travels beside the handler and
 * `CIRCA_PROVIDERS` names it.
 */

const OUT = path.resolve("dist/alexa-skill");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ["apps/alexa-skill/src/lambda.ts"],
  outfile: path.join(OUT, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Some dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});
await copyFile(path.resolve("fixtures/providers/providers.json"), path.join(OUT, "providers.json"));

const size = (await stat(path.join(OUT, "index.mjs"))).size;
console.log(`dist/alexa-skill/index.mjs  ${(size / 1024).toFixed(0)} KiB`);
console.log("dist/alexa-skill/providers.json");
