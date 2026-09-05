import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RepairCase } from "#schema";
import { CaseNotFoundError, VersionConflictError, type CaseRecord, type CaseRepository } from "./types.js";

/**
 * File-backed repository, one JSON document per case.
 *
 * This is the default, and it is the reason a judge can clone the repository and
 * see state survive a restart without an AWS account. The DynamoDB adapter next
 * to it is the same interface against the same tests; which one is live is one
 * environment variable, and `pnpm doctor` prints which.
 *
 * Writes go to a temporary file and are renamed into place. `rename` within a
 * directory is atomic on both POSIX and NTFS, so a process killed mid-write
 * leaves the previous version intact rather than a truncated one — which for a
 * record of what somebody agreed to pay is the difference between an
 * inconvenience and a lost baseline.
 */
export class FileCaseRepository implements CaseRepository {
  constructor(private readonly directory: string) {}

  private file(caseId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(caseId)) throw new Error(`unsafe case id: ${caseId}`);
    return path.join(this.directory, `${caseId}.json`);
  }

  private async ensure(): Promise<void> {
    if (!existsSync(this.directory)) await mkdir(this.directory, { recursive: true });
  }

  private async write(record: CaseRecord): Promise<void> {
    await this.ensure();
    const target = this.file(record.case.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    await rename(temporary, target);
  }

  async create(record: CaseRecord): Promise<void> {
    await this.ensure();
    if (existsSync(this.file(record.case.id))) throw new Error(`case ${record.case.id} already exists`);
    await this.write({ ...record, version: 1 });
  }

  async get(caseId: string): Promise<CaseRecord | undefined> {
    const target = this.file(caseId);
    if (!existsSync(target)) return undefined;
    return JSON.parse(await readFile(target, "utf8")) as CaseRecord;
  }

  async put(record: CaseRecord): Promise<CaseRecord> {
    const current = await this.get(record.case.id);
    if (!current) throw new CaseNotFoundError(record.case.id);
    if (current.version !== record.version)
      throw new VersionConflictError(record.case.id, record.version, current.version);
    const next = { ...record, version: current.version + 1 };
    await this.write(next);
    return next;
  }

  async listByUser(userId: string): Promise<RepairCase[]> {
    await this.ensure();
    const files = (await readdir(this.directory)).filter((f) => f.endsWith(".json"));
    const out: RepairCase[] = [];
    for (const file of files) {
      const record = JSON.parse(await readFile(path.join(this.directory, file), "utf8")) as CaseRecord;
      if (record.case.userId === userId) out.push(record.case);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(caseId: string): Promise<boolean> {
    const target = this.file(caseId);
    if (!existsSync(target)) return false;
    await rm(target);
    return true;
  }

  describe(): string {
    return `file (${this.directory})`;
  }
}
