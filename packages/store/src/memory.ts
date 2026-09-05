import type { RepairCase } from "#schema";
import { CaseNotFoundError, VersionConflictError, type CaseRecord, type CaseRepository } from "./types.js";

/**
 * In-memory repository.
 *
 * Deep-copies on the way in and on the way out. A repository that hands back a
 * reference into its own state makes every caller an accidental writer, and the
 * bug that produces — a mutation that persisted without a version bump — is
 * exactly the class of bug the version field exists to catch.
 */
export class MemoryCaseRepository implements CaseRepository {
  private readonly records = new Map<string, CaseRecord>();

  async create(record: CaseRecord): Promise<void> {
    if (this.records.has(record.case.id)) throw new Error(`case ${record.case.id} already exists`);
    this.records.set(record.case.id, structuredClone({ ...record, version: 1 }));
  }

  async get(caseId: string): Promise<CaseRecord | undefined> {
    const found = this.records.get(caseId);
    return found ? structuredClone(found) : undefined;
  }

  async put(record: CaseRecord): Promise<CaseRecord> {
    const current = this.records.get(record.case.id);
    if (!current) throw new CaseNotFoundError(record.case.id);
    if (current.version !== record.version)
      throw new VersionConflictError(record.case.id, record.version, current.version);
    const next = structuredClone({ ...record, version: current.version + 1 });
    this.records.set(record.case.id, next);
    return structuredClone(next);
  }

  async listByUser(userId: string): Promise<RepairCase[]> {
    return [...this.records.values()]
      .filter((r) => r.case.userId === userId)
      .map((r) => structuredClone(r.case))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(caseId: string): Promise<boolean> {
    return this.records.delete(caseId);
  }

  describe(): string {
    return `memory (${this.records.size} case${this.records.size === 1 ? "" : "s"})`;
  }
}
