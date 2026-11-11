import type { FieldEvidence, FieldName } from "./types";

export type TextSegment = {
  text: string;
  field: FieldName | null;
};

const PRIORITY: FieldName[] = ["amount", "payeeName", "purpose", "when", "payeeEmail", "currency"];

export function highlightSegments(text: string, evidence: FieldEvidence[]): TextSegment[] {
  const spans: { start: number; end: number; field: FieldName }[] = [];
  for (const field of PRIORITY) {
    const item = evidence.find((entry) => entry.field === field && entry.verified && entry.start !== null && entry.end !== null);
    if (!item || item.start === null || item.end === null || item.end <= item.start) continue;
    const overlaps = spans.some((span) => item.start! < span.end && item.end! > span.start);
    if (overlaps) continue;
    spans.push({ start: item.start, end: item.end, field });
  }
  spans.sort((a, b) => a.start - b.start);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), field: null });
    }
    segments.push({ text: text.slice(span.start, span.end), field: span.field });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), field: null });
  }
  return segments.filter((segment) => segment.text.length > 0);
}
