import fs from "node:fs";
import path from "node:path";

import type { AuditEvent, PaymentCase } from "@/lib/types";

export type DeskState = {
  cases: PaymentCase[];
  audits: AuditEvent[];
};

export interface Store {
  listCases(): PaymentCase[];
  getCase(id: string): PaymentCase | null;
  listAudits(caseId?: string): AuditEvent[];
  apply(mutator: (draft: DeskState) => void): void;
  replace(state: DeskState): void;
}

function sortCases(cases: PaymentCase[]): PaymentCase[] {
  return [...cases].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function sortAudits(audits: AuditEvent[]): AuditEvent[] {
  return [...audits].sort((a, b) => a.seq - b.seq);
}

export class MemoryStore implements Store {
  constructor(private state: DeskState = { cases: [], audits: [] }) {}

  listCases(): PaymentCase[] {
    return sortCases(this.state.cases);
  }

  getCase(id: string): PaymentCase | null {
    return this.state.cases.find((item) => item.id === id) ?? null;
  }

  listAudits(caseId?: string): AuditEvent[] {
    const rows = caseId ? this.state.audits.filter((item) => item.caseId === caseId) : this.state.audits;
    return sortAudits(rows);
  }

  apply(mutator: (draft: DeskState) => void): void {
    const next = structuredClone(this.state);
    mutator(next);
    this.state = next;
  }

  replace(state: DeskState): void {
    this.state = structuredClone(state);
  }
}

export class FileStore implements Store {
  private state: DeskState;

  constructor(private filePath: string) {
    this.state = this.load();
  }

  listCases(): PaymentCase[] {
    return sortCases(this.state.cases);
  }

  getCase(id: string): PaymentCase | null {
    return this.state.cases.find((item) => item.id === id) ?? null;
  }

  listAudits(caseId?: string): AuditEvent[] {
    const rows = caseId ? this.state.audits.filter((item) => item.caseId === caseId) : this.state.audits;
    return sortAudits(rows);
  }

  apply(mutator: (draft: DeskState) => void): void {
    const next = structuredClone(this.state);
    mutator(next);
    this.state = next;
    this.persist();
  }

  replace(state: DeskState): void {
    this.state = structuredClone(state);
    this.persist();
  }

  private load(): DeskState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DeskState;
      return { cases: parsed.cases ?? [], audits: parsed.audits ?? [] };
    } catch {
      return { cases: [], audits: [] };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.filePath);
  }
}
