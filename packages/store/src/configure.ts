import path from "node:path";
import { FileCaseRepository } from "./file.js";
import { MemoryCaseRepository } from "./memory.js";
import { DynamoCaseRepository, PLAIN_COMMANDS, type DynamoCommandFactory, type DynamoLike } from "./dynamo.js";
import type { CaseRepository } from "./types.js";

/**
 * Which repository is live, decided by environment and reported by `pnpm doctor`.
 *
 * `CIRCA_STORE=dynamodb` needs credentials and `CIRCA_TABLE`; anything else
 * falls back to a file store under `.state/cases`, which is what a judge gets on
 * a clean clone. There is no silent fallback from dynamodb to file: asking for
 * DynamoDB and quietly getting a local file is how a demo appears to persist to
 * the cloud when it does not.
 */
export async function configureRepository(env: NodeJS.ProcessEnv = process.env): Promise<CaseRepository> {
  const kind = (env["CIRCA_STORE"] ?? "file").toLowerCase();
  if (kind === "memory") return new MemoryCaseRepository();
  if (kind === "file") return new FileCaseRepository(env["CIRCA_STATE_DIR"] ?? path.resolve(".state/cases"));
  if (kind !== "dynamodb") throw new Error(`unknown CIRCA_STORE: ${kind}`);

  const table = env["CIRCA_TABLE"];
  if (!table) throw new Error("CIRCA_STORE=dynamodb needs CIRCA_TABLE");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const client = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const commands: DynamoCommandFactory = {
    get: (input) => new lib.GetCommand(input as never) as never,
    put: (input) => new lib.PutCommand(input as never) as never,
    query: (input) => new lib.QueryCommand(input as never) as never,
    delete: (input) => new lib.DeleteCommand(input as never) as never,
  };
  void PLAIN_COMMANDS;
  return new DynamoCaseRepository(client as unknown as DynamoLike, table, commands);
}
