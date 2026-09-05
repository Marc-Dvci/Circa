import type {
  AgreementBaseline,
  Offer,
  Quote,
  RepairCase,
  ScopeChange,
  TimelineEvent,
} from "#schema";
import type { EvidenceItem, SecondOpinionRequest } from "#domain";

/**
 * The persisted record.
 *
 * One document per case, versioned. A repair is a small object that is read far
 * more often than it is written and is only ever written by one customer, so a
 * single versioned document is the right shape and a table of events joined at
 * read time is not.
 *
 * `version` exists because a voice turn can put two tool calls in flight at
 * once. Alexa asking "and did they give you a licence number?" while the user is
 * already answering a different question is not an edge case, it is Tuesday.
 */
export interface CaseRecord {
  version: number;
  case: RepairCase;
  offers: Offer[];
  quotes: Quote[];
  changes: ScopeChange[];
  baseline?: AgreementBaseline;
  evidence: EvidenceItem[];
  secondOpinionRequests: SecondOpinionRequest[];
  timeline: TimelineEvent[];
}

export class VersionConflictError extends Error {
  constructor(
    readonly caseId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`case ${caseId} changed underneath: expected version ${expected}, found ${actual}`);
    this.name = "VersionConflictError";
  }
}

export class CaseNotFoundError extends Error {
  constructor(readonly caseId: string) {
    super(`no case ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

export interface CaseRepository {
  /** Fails if the case already exists. */
  create(record: CaseRecord): Promise<void>;
  get(caseId: string): Promise<CaseRecord | undefined>;
  /** Optimistic: `record.version` must equal the stored version. Stores `version + 1`. */
  put(record: CaseRecord): Promise<CaseRecord>;
  listByUser(userId: string): Promise<RepairCase[]>;
  /** Complete removal, including the timeline. The product promises this and has to keep it. */
  delete(caseId: string): Promise<boolean>;
  describe(): string;
}
