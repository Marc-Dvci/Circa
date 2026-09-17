import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/**
 * What deploying CIRCA would create.
 *
 * **Nothing here has been deployed.** The AWS credentials on the machine this
 * was built on resolve through the SDK's provider chain and are then refused by
 * STS with `InvalidClientTokenId`, so this stack has been synthesised and never
 * applied. `docs/AWS.md` says so at the top and `pnpm cdk:synth` is the only
 * command in this repository that touches it. A stack that claims a deployment
 * it never had is worse than no stack.
 *
 * It is written out anyway, and checked by `tests/cdk.test.ts` against the
 * synthesised CloudFormation, because the interesting part of an add-on's
 * infrastructure is not that it exists — it is the shape of the permissions, and
 * that is readable whether or not anything is running.
 *
 * Four decisions worth defending:
 *
 * **One table, partitioned by user.** A repair record is only ever read by the
 * person it belongs to, so the partition key is the user and the sort key is the
 * case. There is no global secondary index, because there is no query in this
 * product that crosses users, and an index that permits one is a query somebody
 * will eventually write.
 *
 * **The task role can read documents and cannot list them.** `s3:GetObject` on
 * the object prefix, no `s3:ListBucket`. A bug that walks the bucket is a bug
 * that reads other households' quotes.
 *
 * **Bedrock is scoped to one model id.** `bedrock:InvokeModel` on the exact
 * model ARN rather than `*`, so a change of model is a deliberate change to this
 * file rather than something a prompt can reach.
 *
 * **The load balancer terminates TLS and nothing else is public.** Alexa+ will
 * only speak Streamable HTTP to an HTTPS endpoint, and the container has no
 * public address of its own.
 */

export interface CircaStackProps extends StackProps {
  /** The Bedrock model the voice and extraction paths are allowed to invoke. */
  modelId?: string;
  /** Where documents land. Left undefined, a bucket is created. */
  documentBucketName?: string;
  /** An ACM certificate for the public listener. Without one the listener is HTTP and the stack says so. */
  certificateArn?: string;
}

export const DEFAULT_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

export class CircaStack extends Stack {
  readonly table: dynamodb.Table;
  readonly documents: s3.Bucket;
  readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: CircaStackProps = {}) {
    super(scope, id, props);

    const modelId = props.modelId ?? DEFAULT_MODEL_ID;

    // ── the record ──────────────────────────────────────────────────────────

    this.table = new dynamodb.Table(this, "Cases", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // The repair record is the product. Point-in-time recovery is not an
      // operational nicety here: the accepted scope is the thing a customer
      // would be arguing from three weeks into a job.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.documents = new s3.Bucket(this, "Documents", {
      ...(props.documentBucketName ? { bucketName: props.documentBucketName } : {}),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          // A photographed quote has done its job once it has been parsed and
          // the structure is on the case. Keeping the image for a year would be
          // keeping a household's paperwork for a year.
          id: "expire-uploads",
          expiration: Duration.days(90),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── the add-on ──────────────────────────────────────────────────────────

    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "What the CIRCA MCP server may reach. Deliberately short.",
    });

    this.table.grantReadWriteData(taskRole);

    // Read one object at a time, by key. No ListBucket: the server never
    // enumerates, and a permission that allows it is a permission a defect can
    // use to read another household's quote.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [this.documents.arnForObjects("uploads/*")],
      }),
    );

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );

    // DetectDocumentText only. AnalyzeExpense returns a vendor's opinion about
    // what the line items are, and CIRCA's whole argument is that the line items
    // are the thing under dispute.
    taskRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["textract:DetectDocumentText"], resources: ["*"] }),
    );

    const task = new ecs.FargateTaskDefinition(this, "Task", { cpu: 512, memoryLimitMiB: 1024, taskRole });

    task.addContainer("Server", {
      // The exclusions are stated here rather than left to `.dockerignore`.
      // CDK stages the asset by copying the directory, `cdk.out` lives inside
      // the repository, and a staging copy that includes its own destination is
      // a copy that does not finish — which is exactly what happened once.
      image: ecs.ContainerImage.fromAsset(".", {
        file: "Dockerfile",
        exclude: ["node_modules", "dist", "cdk.out", ".git", ".state", "demo_video", "**/*.log"],
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "circa", logRetention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        CIRCA_STORE: "dynamodb",
        CIRCA_TABLE: this.table.tableName,
        CIRCA_BUCKET: this.documents.bucketName,
        CIRCA_MODEL_ID: modelId,
        CIRCA_BEDROCK: "1",
        CIRCA_TEXTRACT: "1",
        // Account linking is required in front of a public endpoint. It is off
        // by default everywhere else so a clean clone runs without an account.
        CIRCA_AUTH: "1",
        PORT: "8787",
      },
      portMappings: [{ containerPort: 8787 }],
      healthCheck: {
        command: ["CMD-SHELL", "node -e \"fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(30),
        retries: 3,
      },
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: task,
      desiredCount: 2,
      circuitBreaker: { rollback: true },
    });

    const balancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      // Streamable HTTP holds a GET open so the server can send a notification
      // without being asked, and a repair conversation spans a fortnight. The
      // load balancer's 60-second default would cut that stream underneath the
      // session — and it is a load-balancer attribute, not a target-group one,
      // which is a distinction `tests/cdk.test.ts` had to find the hard way.
      idleTimeout: Duration.minutes(10),
    });
    const listener = balancer.addListener("Listener", {
      port: props.certificateArn ? 443 : 80,
      ...(props.certificateArn
        ? { certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)], protocol: elbv2.ApplicationProtocol.HTTPS }
        : { protocol: elbv2.ApplicationProtocol.HTTP }),
    });
    listener.addTargets("Mcp", {
      port: 8787,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: "/health",
        // The health endpoint reports the negotiated protocol version and the
        // one Alexa+ requires as separate fields, so a task that came up against
        // an SDK whose default moved is unhealthy rather than quietly serving.
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
      },
    });
  }
}
