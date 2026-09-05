import type { RepairCase } from "#schema";
import { CaseNotFoundError, VersionConflictError, type CaseRecord, type CaseRepository } from "./types.js";

/**
 * DynamoDB repository.
 *
 * The client is an interface rather than the SDK type, so the suite runs the
 * whole adapter — the condition expression, the conflict mapping, the GSI query,
 * the delete — against a table double, with no credentials and no network. The
 * double is in `packages/store/src/dynamo-double.ts` and it enforces the
 * condition expression rather than ignoring it, because a test that accepts
 * every write proves nothing about optimistic concurrency.
 *
 * Table: partition key `pk` = `CASE#<caseId>`, sort key `sk` = `RECORD`.
 * GSI `byUser`: partition key `userId`, sort key `updatedAt`.
 */

export interface DynamoLike {
  send(command: { __type: string; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export interface DynamoCommandFactory {
  get(input: Record<string, unknown>): { __type: string; input: Record<string, unknown> };
  put(input: Record<string, unknown>): { __type: string; input: Record<string, unknown> };
  query(input: Record<string, unknown>): { __type: string; input: Record<string, unknown> };
  delete(input: Record<string, unknown>): { __type: string; input: Record<string, unknown> };
}

/** The default factory, shaped like `@aws-sdk/lib-dynamodb` commands. */
export const PLAIN_COMMANDS: DynamoCommandFactory = {
  get: (input) => ({ __type: "GetCommand", input }),
  put: (input) => ({ __type: "PutCommand", input }),
  query: (input) => ({ __type: "QueryCommand", input }),
  delete: (input) => ({ __type: "DeleteCommand", input }),
};

const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

export class DynamoCaseRepository implements CaseRepository {
  constructor(
    private readonly client: DynamoLike,
    private readonly tableName: string,
    private readonly commands: DynamoCommandFactory = PLAIN_COMMANDS,
  ) {}

  private pk(caseId: string): string {
    return `CASE#${caseId}`;
  }

  async create(record: CaseRecord): Promise<void> {
    const item = { pk: this.pk(record.case.id), sk: "RECORD", userId: record.case.userId, updatedAt: record.case.updatedAt, ...record, version: 1 };
    try {
      await this.client.send(
        this.commands.put({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) throw new Error(`case ${record.case.id} already exists`);
      throw error;
    }
  }

  async get(caseId: string): Promise<CaseRecord | undefined> {
    const result = await this.client.send(
      this.commands.get({ TableName: this.tableName, Key: { pk: this.pk(caseId), sk: "RECORD" } }),
    );
    const item = result["Item"] as (CaseRecord & Record<string, unknown>) | undefined;
    return item ? stripKeys(item) : undefined;
  }

  async put(record: CaseRecord): Promise<CaseRecord> {
    const next: CaseRecord = { ...record, version: record.version + 1 };
    const item = { pk: this.pk(record.case.id), sk: "RECORD", userId: record.case.userId, updatedAt: record.case.updatedAt, ...next };
    try {
      await this.client.send(
        this.commands.put({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_exists(pk) AND #v = :expected",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":expected": record.version },
        }),
      );
    } catch (error) {
      if (isConditionalFailure(error)) {
        const current = await this.get(record.case.id);
        if (!current) throw new CaseNotFoundError(record.case.id);
        throw new VersionConflictError(record.case.id, record.version, current.version);
      }
      throw error;
    }
    return next;
  }

  async listByUser(userId: string): Promise<RepairCase[]> {
    const result = await this.client.send(
      this.commands.query({
        TableName: this.tableName,
        IndexName: "byUser",
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ScanIndexForward: false,
      }),
    );
    const items = (result["Items"] as (CaseRecord & Record<string, unknown>)[] | undefined) ?? [];
    return items.map((item) => stripKeys(item).case);
  }

  async delete(caseId: string): Promise<boolean> {
    const result = await this.client.send(
      this.commands.delete({
        TableName: this.tableName,
        Key: { pk: this.pk(caseId), sk: "RECORD" },
        ReturnValues: "ALL_OLD",
      }),
    );
    return Boolean(result["Attributes"]);
  }

  describe(): string {
    return `dynamodb (${this.tableName})`;
  }
}

function isConditionalFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === CONDITIONAL_CHECK_FAILED;
}

function stripKeys(item: CaseRecord & Record<string, unknown>): CaseRecord {
  const { pk, sk, userId, updatedAt, ...rest } = item as Record<string, unknown>;
  void pk;
  void sk;
  void userId;
  void updatedAt;
  return rest as unknown as CaseRecord;
}
