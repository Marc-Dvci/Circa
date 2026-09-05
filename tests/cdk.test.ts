import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CircaStack, DEFAULT_MODEL_ID } from "../infrastructure/cdk/stack.js";

/**
 * The stack, read as CloudFormation.
 *
 * `infrastructure/cdk` has never been deployed — there is no account behind
 * these credentials, and `docs/AWS.md` says so plainly. What can still be
 * checked is the part that matters: the shape of what the running server would
 * be allowed to do. An IAM policy is a claim about a blast radius, and a claim
 * is worth asserting whether or not anything is currently running under it.
 *
 * These assertions are on the synthesised template rather than on the
 * construct's own properties, because the template is what would be applied.
 */

let template: Template;

beforeAll(() => {
  const app = new App();
  template = Template.fromStack(new CircaStack(app, "TestStack"));
});

describe("the record", () => {
  it("partitions by user and never indexes across them", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
    // No GSI. There is no query in this product that crosses households, and an
    // index that permits one is a query somebody eventually writes.
    const tables = template.findResources("AWS::DynamoDB::Table");
    for (const table of Object.values(tables)) {
      expect(table["Properties"]?.["GlobalSecondaryIndexes"]).toBeUndefined();
    }
  });

  it("keeps the accepted scope recoverable and does not delete it with the stack", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
  });

  it("blocks public access to documents and expires them", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 90, Status: "Enabled" })]),
      },
    });
  });
});

describe("what the server may reach", () => {
  const statements = (): { Action: unknown; Resource: unknown }[] => {
    const policies = template.findResources("AWS::IAM::Policy");
    return Object.values(policies).flatMap(
      (policy) => (policy["Properties"]?.["PolicyDocument"]?.["Statement"] ?? []) as { Action: unknown; Resource: unknown }[],
    );
  };

  const actionsOf = (statement: { Action: unknown }): string[] =>
    Array.isArray(statement.Action) ? (statement.Action as string[]) : [statement.Action as string];

  it("can read a document by key and cannot list the bucket", () => {
    const all = statements().flatMap(actionsOf);
    expect(all).toContain("s3:GetObject");
    // A defect that walks the bucket is a defect that reads another household's
    // quote, so the permission that would let it is simply absent.
    expect(all).not.toContain("s3:ListBucket");
    expect(all.filter((action) => action.startsWith("s3:"))).not.toContain("s3:*");
  });

  it("can invoke exactly one Bedrock model", () => {
    const bedrock = statements().filter((s) => actionsOf(s).includes("bedrock:InvokeModel"));
    expect(bedrock).toHaveLength(1);
    expect(JSON.stringify(bedrock[0]!.Resource)).toContain(DEFAULT_MODEL_ID);
    expect(JSON.stringify(bedrock[0]!.Resource)).not.toBe('"*"');
  });

  it("uses DetectDocumentText and not AnalyzeExpense", () => {
    const all = statements().flatMap(actionsOf);
    expect(all).toContain("textract:DetectDocumentText");
    // AnalyzeExpense returns a vendor's opinion about what the line items are,
    // and the line items are the thing CIRCA is arguing about.
    expect(all).not.toContain("textract:AnalyzeExpense");
  });

  it("grants no wildcard action anywhere", () => {
    for (const statement of statements()) {
      expect(actionsOf(statement), JSON.stringify(statement)).not.toContain("*");
    }
  });
});

describe("the endpoint", () => {
  it("requires account linking on the deployed server", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: "CIRCA_AUTH", Value: "1" }]),
        }),
      ]),
    });
  });

  it("health checks the endpoint that reports the protocol version", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/health",
      Port: 8787,
    });
  });

  it("holds the server-to-client stream open longer than the default idle timeout", () => {
    // Streamable HTTP keeps a GET open for notifications, and a repair
    // conversation spans a fortnight, so the load balancer's 60-second default
    // would cut the stream underneath the session.
    //
    // This assertion is the reason the test exists. The timeout was first set on
    // the target group, where the property is accepted and produces nothing: the
    // synthesised template carried a single `stickiness.enabled` attribute and no
    // idle timeout at all. Reading the template is what found that; reading the
    // construct code would not have.
    const balancers = template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer");
    const attributes = Object.values(balancers)[0]!["Properties"]["LoadBalancerAttributes"] as { Key: string; Value: string }[];
    const idle = attributes.find((a) => a.Key === "idle_timeout.timeout_seconds");
    expect(idle, JSON.stringify(attributes)).toBeDefined();
    expect(Number(idle!.Value)).toBeGreaterThanOrEqual(600);
  });
});
