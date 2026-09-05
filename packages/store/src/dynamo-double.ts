import type { DynamoLike } from "./dynamo.js";

/**
 * A table double that enforces the condition expression.
 *
 * The point of this file is that it can fail. A double that accepts every write
 * would let `DynamoCaseRepository` ship with its optimistic concurrency
 * inverted, and the suite would be green. This one understands the two
 * expressions the adapter actually sends, and `tests/store.test.ts` drives it
 * into the conflict branch on purpose.
 *
 * It is deliberately not a general DynamoDB emulator. It supports exactly what
 * the adapter uses, and it throws on anything else rather than quietly
 * succeeding, so a future change to the adapter that this file does not
 * understand fails loudly here instead of passing untested.
 */
export class ConditionalCheckFailedException extends Error {
  override readonly name = "ConditionalCheckFailedException";
  constructor() {
    super("The conditional request failed");
  }
}

interface Item {
  pk: string;
  sk: string;
  userId?: string;
  updatedAt?: string;
  version?: number;
  [key: string]: unknown;
}

export class DynamoTableDouble implements DynamoLike {
  readonly items = new Map<string, Item>();
  readonly calls: { type: string; input: Record<string, unknown> }[] = [];

  private keyOf(key: Record<string, unknown>): string {
    return `${String(key["pk"])}|${String(key["sk"])}`;
  }

  async send(command: { __type: string; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    this.calls.push({ type: command.__type, input: command.input });
    switch (command.__type) {
      case "GetCommand":
        return { Item: this.items.get(this.keyOf(command.input["Key"] as Record<string, unknown>)) };

      case "PutCommand": {
        const item = command.input["Item"] as Item;
        const key = this.keyOf(item);
        const existing = this.items.get(key);
        const condition = command.input["ConditionExpression"] as string | undefined;
        if (condition) this.evaluate(condition, command.input, existing);
        this.items.set(key, structuredClone(item));
        return {};
      }

      case "QueryCommand": {
        if (command.input["IndexName"] !== "byUser") throw new Error(`double does not implement index ${String(command.input["IndexName"])}`);
        const values = (command.input["ExpressionAttributeValues"] ?? {}) as Record<string, unknown>;
        const wanted = values[":u"];
        const forward = command.input["ScanIndexForward"] !== false;
        const items = [...this.items.values()]
          .filter((i) => i.userId === wanted)
          .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
        return { Items: forward ? items : items.reverse() };
      }

      case "DeleteCommand": {
        const key = this.keyOf(command.input["Key"] as Record<string, unknown>);
        const existing = this.items.get(key);
        this.items.delete(key);
        return command.input["ReturnValues"] === "ALL_OLD" && existing ? { Attributes: existing } : {};
      }

      default:
        throw new Error(`double does not implement ${command.__type}`);
    }
  }

  /** Exactly the two expressions `DynamoCaseRepository` sends, and nothing else. */
  private evaluate(condition: string, input: Record<string, unknown>, existing: Item | undefined): void {
    if (condition === "attribute_not_exists(pk)") {
      if (existing) throw new ConditionalCheckFailedException();
      return;
    }
    if (condition === "attribute_exists(pk) AND #v = :expected") {
      const values = (input["ExpressionAttributeValues"] ?? {}) as Record<string, unknown>;
      const names = (input["ExpressionAttributeNames"] ?? {}) as Record<string, string>;
      if (names["#v"] !== "version") throw new Error(`double expected #v to name "version", got ${String(names["#v"])}`);
      if (!existing) throw new ConditionalCheckFailedException();
      if (existing.version !== values[":expected"]) throw new ConditionalCheckFailedException();
      return;
    }
    throw new Error(`double does not understand condition: ${condition}`);
  }
}
