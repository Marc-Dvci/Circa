import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { CircaStack } from "./stack.js";

/**
 * `pnpm cdk:synth`.
 *
 * `app.synth()` rather than the CDK CLI, on purpose: synthesis is a local
 * operation that needs no credentials and no bootstrap, so this command works on
 * a clean clone and produces the CloudFormation template that
 * `tests/cdk.test.ts` reads. Reaching for `cdk deploy` would need an account
 * that this project does not have — see `docs/AWS.md`.
 */

// Under `dist/`, which is ignored by git and excluded from the container asset,
// so the template is somewhere a person can read it after the command exits and
// staging is not copying its own output.
const app = new App({
  outdir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/cdk.out"),
});

new CircaStack(app, "CircaStack", {
  description: "CIRCA — an Alexa+ MCP add-on that guards a home-repair transaction. Never deployed; see docs/AWS.md.",
  ...(process.env["CDK_DEFAULT_ACCOUNT"] && process.env["CDK_DEFAULT_REGION"]
    ? { env: { account: process.env["CDK_DEFAULT_ACCOUNT"], region: process.env["CDK_DEFAULT_REGION"] } }
    : {}),
  ...(process.env["CIRCA_CERTIFICATE_ARN"] ? { certificateArn: process.env["CIRCA_CERTIFICATE_ARN"] } : {}),
});

const assembly = app.synth();
process.stdout.write(
  `synthesised ${assembly.stacks.length} stack${assembly.stacks.length === 1 ? "" : "s"} to ${assembly.directory}\n`,
);
