"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { highlightSegments } from "@/lib/highlight";
import { formatMoney } from "@/lib/money";
import { SAMPLES } from "@/lib/samples";
import {
  FIELD_LABELS,
  FIELD_NAMES,
  type AuditEvent,
  type CaseStatus,
  type CaseSummary,
  type Currency,
  type PaymentCase,
} from "@/lib/types";

type AiInfo = {
  provider: string;
  model: string;
  note: string;
};

type Meta = {
  paypal: { mode: "mock" | "sandbox"; label: string };
  ai: AiInfo;
  knownPayees: { name: string; email: string }[];
  largeAmount: number;
};

type CaseView = {
  record: PaymentCase;
  audits: AuditEvent[];
};

type ListResponse = {
  records: CaseSummary[];
  audits: AuditEvent[];
};

type Panel = "edit" | "reject" | null;

type EditDraft = {
  payeeName: string;
  payeeEmail: string;
  amount: string;
  currency: Currency;
  purpose: string;
  when: string;
};

const STATUS_COPY: Record<CaseStatus, string> = {
  proposed: "Waiting for a person",
  approved: "Approved, not captured",
  rejected: "Rejected",
  captured: "Captured",
};

class ApiError extends Error {
  status: number;
  body: { record?: PaymentCase; audits?: AuditEvent[]; error?: { code?: string; message?: string } };

  constructor(message: string, status: number, body: ApiError["body"]) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as ApiError["body"];
  if (!response.ok) {
    throw new ApiError(body.error?.message || "The server refused that step.", response.status, body);
  }
  return body as T;
}

export function Desk() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [records, setRecords] = useState<CaseSummary[]>([]);
  const [allAudits, setAllAudits] = useState<AuditEvent[]>([]);
  const [detail, setDetail] = useState<CaseView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"new" | "case">("new");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [captureCode, setCaptureCode] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [wholeDesk, setWholeDesk] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const viewKey = useRef("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [metaBody, listBody] = await Promise.all([api<Meta>("/api/meta"), api<ListResponse>("/api/cases")]);
        if (cancelled) return;
        setMeta(metaBody);
        setRecords(listBody.records);
        setAllAudits(listBody.audits);
        const id = new URLSearchParams(window.location.search).get("case");
        if (id && listBody.records.some((item) => item.id === id)) {
          const next = await api<CaseView>(`/api/cases/${id}`);
          if (cancelled) return;
          setDetail(next);
          setSelectedId(id);
          setView("case");
        }
      } catch (caught) {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "The desk could not load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyView(next: CaseView) {
    const nextKey = `${next.record.id}:${next.record.version}:${next.record.status}`;
    if (viewKey.current !== nextKey) {
      viewKey.current = nextKey;
      setChecked([]);
      setCaptureMessage(null);
      setCaptureCode(null);
      setNote("");
      setReason("");
      setPanel(null);
      setEdit(null);
    }
    setDetail(next);
    setView("case");
    setSelectedId(next.record.id);
    setAllAudits((prev) =>
      [...prev.filter((item) => item.caseId !== next.record.id), ...next.audits].sort((a, b) => a.seq - b.seq),
    );
    setRecords((prev) => {
      const summary: CaseSummary = {
        id: next.record.id,
        status: next.record.status,
        payeeName: next.record.proposal.payeeName,
        amount: next.record.proposal.amount,
        currency: next.record.proposal.currency,
        purpose: next.record.proposal.purpose,
        createdAt: next.record.createdAt,
        version: next.record.version,
      };
      return [summary, ...prev.filter((item) => item.id !== summary.id)].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      );
    });
    const url = new URL(window.location.href);
    url.searchParams.set("case", next.record.id);
    window.history.replaceState(null, "", url);
  }

  async function prepare(text: string) {
    setBusy("prepare");
    setError(null);
    try {
      const next = await api<CaseView>("/api/cases", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      applyView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request did not become a proposal.");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!detail || !edit) return;
    setBusy("edit");
    setError(null);
    try {
      const next = await api<CaseView>(`/api/cases/${detail.record.id}`, {
        method: "PATCH",
        body: JSON.stringify({ reviewerName: reviewer, ...edit }),
      });
      applyView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The edit was not saved.");
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!detail) return;
    setBusy("approve");
    setError(null);
    try {
      const next = await api<CaseView>(`/api/cases/${detail.record.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          reviewerName: reviewer,
          note,
          acknowledgedRiskCodes: checked,
        }),
      });
      applyView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Approval was refused.");
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!detail) return;
    setBusy("reject");
    setError(null);
    try {
      const next = await api<CaseView>(`/api/cases/${detail.record.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewerName: reviewer, reason }),
      });
      applyView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rejection was refused.");
    } finally {
      setBusy(null);
    }
  }

  async function capture() {
    if (!detail) return;
    setBusy("capture");
    setError(null);
    setCaptureMessage(null);
    setCaptureCode(null);
    try {
      const next = await api<CaseView>(`/api/cases/${detail.record.id}/capture`, {
        method: "POST",
        body: JSON.stringify({ reviewerName: reviewer }),
      });
      applyView(next);
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      if (apiError?.body.record && apiError.body.audits) {
        applyView({ record: apiError.body.record, audits: apiError.body.audits });
      }
      setCaptureMessage(caught instanceof Error ? caught.message : "Capture was refused.");
      setCaptureCode(apiError?.body.error?.code ?? null);
    } finally {
      setBusy(null);
    }
  }

  async function clearDesk() {
    setBusy("clear");
    try {
      const list = await api<ListResponse>("/api/cases", { method: "DELETE" });
      setRecords(list.records);
      setAllAudits(list.audits);
      setDetail(null);
      setSelectedId(null);
      setView("new");
      viewKey.current = "";
      setConfirmClear(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("case");
      window.history.replaceState(null, "", url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The desk was not cleared.");
    } finally {
      setBusy(null);
    }
  }

  function openCase(id: string) {
    setError(null);
    setBusy("open");
    api<CaseView>(`/api/cases/${id}`)
      .then((next) => applyView(next))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "That request could not be opened."))
      .finally(() => setBusy(null));
  }

  const visibleAudits = useMemo(() => {
    const rows = wholeDesk || !selectedId ? allAudits : allAudits.filter((item) => item.caseId === selectedId);
    return [...rows].sort((a, b) => a.seq - b.seq);
  }, [allAudits, selectedId, wholeDesk]);

  return (
    <div className="desk">
      <aside className="rail">
        <div>
          <p className="eyebrow">PayPal AI Hackathon</p>
          <h1 className="brand">Approve before Pay</h1>
          <p className="rail-copy">
            An agent prepares the PayPal order. A person checks the evidence. Capture waits for that approval.
          </p>
          <p className="credit">Isaac Adekunle / Drew & Crew, with AI coding agents.</p>
        </div>
        {meta ? (
          <div className="mode-stack" data-testid="mode-banner">
            <p className="mode-kicker">What is running</p>
            <p>
              <strong>PayPal:</strong> {meta.paypal.mode === "mock" ? "mock mode" : "sandbox"}
            </p>
            <p className="mode-note">
              {meta.paypal.mode === "mock" ? "No live PayPal call is made." : "Orders v2 on the sandbox API."}
            </p>
            <p>
              <strong>AI:</strong> {providerLabel(meta.ai)}
            </p>
            <p className="mode-note">{meta.ai.model}</p>
          </div>
        ) : null}
        <div className="rail-list">
          <div className="rail-list-head">
            <h2>Requests</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-white/20 bg-transparent text-paper hover:bg-white/10"
              onClick={() => {
                setView("new");
                setSelectedId(null);
                setError(null);
                const url = new URL(window.location.href);
                url.searchParams.delete("case");
                window.history.replaceState(null, "", url);
              }}
            >
              New request
            </Button>
          </div>
          {loading ? <p className="rail-copy">Loading the desk.</p> : null}
          {records.length === 0 && !loading ? <p className="rail-copy">No requests yet.</p> : null}
          <ul className="case-list">
            {records.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === selectedId && view === "case" ? "case-card is-selected" : "case-card"}
                  onClick={() => openCase(item.id)}
                >
                  <span className="case-card-title">{item.payeeName}</span>
                  <span>
                    {formatMoney(item.currency, item.amount)} · {STATUS_COPY[item.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="rail-foot">
          <p className="mode-note">
            Known payees: {meta ? meta.knownPayees.map((payee) => payee.name).join(", ") : "loading"}
          </p>
          {confirmClear ? (
            <div className="clear-row">
              <Button type="button" size="sm" variant="destructive" onClick={clearDesk} disabled={busy === "clear"}>
                Confirm clear
              </Button>
              <Button type="button" size="sm" variant="ghost" className="text-paper hover:bg-white/10" onClick={() => setConfirmClear(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button type="button" size="sm" variant="ghost" className="text-paper hover:bg-white/10" onClick={() => setConfirmClear(true)}>
              Clear local desk
            </Button>
          )}
          </div>
      </aside>

      <main className="sheet-wrap">
        {loadError ? (
          <p className="alert" role="alert">
            {loadError}
          </p>
        ) : null}
        {view === "new" || !detail ? (
          <Composer
            draft={draft}
            setDraft={setDraft}
            busy={busy === "prepare"}
            error={error}
            onPrepare={prepare}
          />
        ) : (
          <Sheet
            detail={detail}
            busy={busy}
            error={error}
            captureMessage={captureMessage}
            captureCode={captureCode}
            reviewer={reviewer}
            setReviewer={setReviewer}
            note={note}
            setNote={setNote}
            reason={reason}
            setReason={setReason}
            checked={checked}
            setChecked={setChecked}
            panel={panel}
            setPanel={setPanel}
            edit={edit}
            setEdit={setEdit}
            onApprove={approve}
            onReject={reject}
            onCapture={capture}
            onSaveEdit={saveEdit}
          />
        )}
      </main>

      <aside className="log" data-testid="audit-log">
        <div className="log-head">
          <h2>Audit log</h2>
          <button type="button" className="text-button" onClick={() => setWholeDesk((value) => !value)}>
            {wholeDesk ? "Showing the whole desk" : "Showing this request"}
          </button>
        </div>
        {visibleAudits.length === 0 ? (
          <p className="log-empty">
            Every step lands here: the request, the agent mode, the source check, the risk flags, the PayPal order, edits,
            approval, refusals, and capture.
          </p>
        ) : (
          <ol className="log-list">
            {visibleAudits.map((event) => (
              <li key={event.id}>
                <div className="log-meta">
                  <span>#{event.seq}</span>
                  <time dateTime={event.at}>{formatTime(event.at)}</time>
                  <span>{event.actor}</span>
                </div>
                <p>{event.message}</p>
                {event.data ? (
                  <details>
                    <summary>Recorded data</summary>
                    <pre>{JSON.stringify(event.data, null, 2)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  busy,
  error,
  onPrepare,
}: {
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  error: string | null;
  onPrepare: (text: string) => void;
}) {
  return (
    <section className="sheet">
      <p className="sheet-kicker">New payment request</p>
      <h2 className="sheet-title">Say what the payment is for.</h2>
      <p className="lede">
        Paste a request in plain language. The agent turns it into a PayPal order with intent CAPTURE. You then see the
        payee, amount, currency, purpose, and the exact words each value came from. Capture stays closed until you
        approve that version. The server enforces the gate, and every step is written to the audit log.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error} No payment was captured.
        </p>
      ) : null}
      <div className="sample-grid">
        {SAMPLES.map((sample) => (
          <article key={sample.id} className="sample-card">
            <h3>{sample.title}</h3>
            <p className="sample-detail">{sample.detail}</p>
            <p className="sample-text">{sample.text}</p>
            <Button
              type="button"
              variant="outline"
              data-testid={`sample-${sample.id}`}
              disabled={busy}
              onClick={() => onPrepare(sample.text)}
            >
              {busy ? "Preparing" : "Prepare this payment"}
            </Button>
          </article>
        ))}
      </div>
      <form
        className="own-request"
        onSubmit={(event) => {
          event.preventDefault();
          onPrepare(draft);
        }}
      >
        <Label htmlFor="request">Or write your own</Label>
        <Textarea
          id="request"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Example: Plumber needs a £150 deposit to book a boiler service next Tuesday"
        />
        <Button type="submit" disabled={busy || draft.trim().length === 0}>
          {busy ? "The agent is preparing the order" : "Prepare payment"}
        </Button>
        {busy ? (
          <p className="hint" role="status">
            The agent is reading the request and opening a PayPal order. Capture is not part of this step.
          </p>
        ) : null}
      </form>
    </section>
  );
}

function Sheet({
  detail,
  busy,
  error,
  captureMessage,
  captureCode,
  reviewer,
  setReviewer,
  note,
  setNote,
  reason,
  setReason,
  checked,
  setChecked,
  panel,
  setPanel,
  edit,
  setEdit,
  onApprove,
  onReject,
  onCapture,
  onSaveEdit,
}: {
  detail: CaseView;
  busy: string | null;
  error: string | null;
  captureMessage: string | null;
  captureCode: string | null;
  reviewer: string;
  setReviewer: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
  reason: string;
  setReason: (value: string) => void;
  checked: string[];
  setChecked: (value: string[]) => void;
  panel: Panel;
  setPanel: (value: Panel) => void;
  edit: EditDraft | null;
  setEdit: (value: EditDraft | null) => void;
  onApprove: () => void;
  onReject: () => void;
  onCapture: () => void;
  onSaveEdit: () => void;
}) {
  const record = detail.record;
  const segments = highlightSegments(record.rawText, record.evidence);
  const required = record.risks.filter((flag) => flag.severity === "warning" || flag.severity === "block");
  const captured = record.status === "captured";
  const receiver =
    record.paypal.mode === "mock"
      ? "Receiver: mock merchant. No PayPal account is connected, and no live charge is made."
      : "Receiver: the sandbox merchant for these API credentials. The named payee is stored on the order description. It is not sent as a PayPal payee email.";

  return (
    <section className="sheet" data-testid="sheet">
      <div className="sheet-top">
        <div>
          <p className="sheet-kicker">Approval sheet · version {record.version}</p>
          <h2 className="sheet-title">{record.proposal.payeeName}</h2>
        </div>
        <p className={`stamp stamp-${record.status}`} data-testid="status-stamp">
          {STATUS_COPY[record.status]}
        </p>
      </div>

      {captureMessage ? (
        <p className="alert" role="alert" data-testid="capture-result">
          <strong>{captureCode ?? "Capture refused"}.</strong> {captureMessage}
        </p>
      ) : null}
      {record.status === "captured" ? (
        <p className="receipt" data-testid="capture-result">
          {record.paypal.mode === "mock"
            ? `Simulated capture ${record.paypal.captureId}. Order ${record.paypal.orderId} is COMPLETED. PayPal was not called.`
            : `Sandbox capture ${record.paypal.captureId}. Order ${record.paypal.orderId} is ${record.paypal.orderStatus}.`}
        </p>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <p className="ai-line" data-testid="ai-line">
        This request used {providerLabel(record.ai)} ({record.ai.model}). {record.ai.note}
      </p>

      <h3>Request</h3>
      <p className="source-text" data-testid="proposal-text">
        {segments.map((segment, index) =>
          segment.field ? (
            <mark key={`${segment.field}-${index}`} className={`mark mark-${segment.field}`}>
              {segment.text}
            </mark>
          ) : (
            <span key={`plain-${index}`}>{segment.text}</span>
          ),
        )}
      </p>
      <ul className="legend">
        <li><i className="swatch mark-amount" /> Amount</li>
        <li><i className="swatch mark-payeeName" /> Payee</li>
        <li><i className="swatch mark-purpose" /> Purpose</li>
        <li><i className="swatch mark-when" /> When</li>
      </ul>

      <h3>What was extracted</h3>
      <table className="evidence">
        <caption className="sr-only">Extracted fields and the words they came from</caption>
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Source in the request</th>
            <th>Check</th>
          </tr>
        </thead>
        <tbody>
          {FIELD_NAMES.map((field) => {
            const item = record.evidence.find((entry) => entry.field === field);
            const value = item?.value ?? "";
            const quote = item?.sourceQuote ?? "";
            const check = !value ? "Not found" : item?.verified ? "In the text" : "Not in the text";
            return (
              <tr key={field}>
                <th scope="row">{FIELD_LABELS[field]}</th>
                <td>{value || "None"}</td>
                <td>{quote ? `“${quote}”` : "None"}</td>
                <td>{check}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Risk flags</h3>
      {record.risks.length === 0 ? (
        <p className="quiet">No risk flags on this version.</p>
      ) : (
        <ul className="flags">
          {record.risks.map((flag) => (
            <li key={flag.code} className={`flag flag-${flag.severity}`}>
              <span>{flag.severity}</span>
              <strong>{flag.code}</strong>
              <p>{flag.message}</p>
            </li>
          ))}
        </ul>
      )}

      <h3>What happened at PayPal</h3>
      <div className="paypal-box" data-testid="order-id">
        <p>{receiver}</p>
        <ol>
          <li>
            POST /v2/checkout/orders with intent CAPTURE. Done. Order {record.paypal.orderId}, create status kept as{" "}
            {record.status === "captured" ? "CREATED, then captured" : record.paypal.orderStatus}. Amount{" "}
            {formatMoney(record.proposal.currency, record.proposal.amount)}. Description: {record.paypal.description}
          </li>
          <li>GET /v2/checkout/orders/{record.paypal.orderId}. Done. Latest status {record.paypal.orderStatus}.</li>
          <li>
            POST /v2/checkout/orders/{record.paypal.orderId}/capture.{" "}
            {record.paypal.captureId
              ? `Done. Capture ${record.paypal.captureId} is ${record.paypal.captureStatus}.`
              : "Not called."}
          </li>
        </ol>
        {record.paypal.previousOrderIds.length > 0 ? (
          <p>Earlier uncaptured orders: {record.paypal.previousOrderIds.join(", ")}.</p>
        ) : null}
        {record.paypal.approveUrl ? (
          <p>
            <a href={record.paypal.approveUrl} target="_blank" rel="noreferrer">
              Payer approval link from PayPal
            </a>
          </p>
        ) : null}
      </div>

      {record.approval ? (
        <p className="quiet">
          Approved by {record.approval.reviewerName}. Note: {record.approval.note}
        </p>
      ) : null}
      {record.rejection ? (
        <p className="quiet">
          Rejected by {record.rejection.reviewerName}. Reason: {record.rejection.reason}
        </p>
      ) : null}

      {!captured ? (
        <div className="actions">
          {record.status !== "approved" ? (
            <Button type="button" variant="outline" data-testid="capture-attempt" onClick={onCapture} disabled={Boolean(busy)}>
              {busy === "capture" ? "Asking the server" : "Attempt capture"}
            </Button>
          ) : (
            <Button type="button" variant="moss" data-testid="capture-submit" onClick={onCapture} disabled={Boolean(busy)}>
              {busy === "capture" ? "Capturing" : "Capture payment"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setEdit({
                payeeName: record.proposal.payeeName,
                payeeEmail: record.proposal.payeeEmail ?? "",
                amount: record.proposal.amount,
                currency: record.proposal.currency,
                purpose: record.proposal.purpose,
                when: record.proposal.when ?? "",
              });
              setPanel(panel === "edit" ? null : "edit");
            }}
          >
            Edit
          </Button>
          {record.status !== "rejected" ? (
            <Button type="button" variant="ghost" onClick={() => setPanel(panel === "reject" ? null : "reject")}>
              Reject
            </Button>
          ) : null}
        </div>
      ) : null}

      {!captured && record.status === "proposed" ? (
        <form
          className="decision"
          onSubmit={(event) => {
            event.preventDefault();
            onApprove();
          }}
        >
          <h3>Approve this version</h3>
          <div className="field">
            <Label htmlFor="reviewer">Reviewer name</Label>
            <Input
              id="reviewer"
              data-testid="approve-name"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
              autoComplete="name"
            />
          </div>
          <div className="field">
            <Label htmlFor="note">What you checked</Label>
            <Textarea
              id="note"
              data-testid="approve-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="I checked the amount, the payee, and the quoted words."
            />
          </div>
          {required.length > 0 ? (
            <fieldset>
              <legend>Acknowledge each flag. The server rejects approval without this.</legend>
              {required.map((flag) => (
                <label key={flag.code} className="check">
                  <input
                    type="checkbox"
                    checked={checked.includes(flag.code)}
                    onChange={(event) => {
                      setChecked(
                        event.target.checked ? [...checked, flag.code] : checked.filter((code) => code !== flag.code),
                      );
                    }}
                  />
                  <span>
                    {flag.code}. {flag.message}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <Button type="submit" data-testid="approve-submit" disabled={Boolean(busy)}>
            {busy === "approve" ? "Saving approval" : "Approve this version"}
          </Button>
        </form>
      ) : null}

      {panel === "edit" && edit ? (
        <form
          className="decision"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveEdit();
          }}
        >
          <h3>Edit the proposal</h3>
          <p className="hint">Saving opens a new uncaptured PayPal order and clears any approval on the previous version.</p>
          <div className="edit-grid">
            <Field label="Payee" value={edit.payeeName} onChange={(payeeName) => setEdit({ ...edit, payeeName })} />
            <Field label="Payee email" value={edit.payeeEmail} onChange={(payeeEmail) => setEdit({ ...edit, payeeEmail })} />
            <Field label="Amount" value={edit.amount} onChange={(amount) => setEdit({ ...edit, amount })} />
            <div className="field">
              <Label htmlFor="currency">Currency</Label>
              <select
                id="currency"
                value={edit.currency}
                onChange={(event) => setEdit({ ...edit, currency: event.target.value as Currency })}
              >
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
            <Field label="Purpose" value={edit.purpose} onChange={(purpose) => setEdit({ ...edit, purpose })} />
            <Field label="When" value={edit.when} onChange={(when) => setEdit({ ...edit, when })} />
          </div>
          <Button type="submit" disabled={Boolean(busy)}>
            {busy === "edit" ? "Saving" : "Save and open a new order"}
          </Button>
        </form>
      ) : null}

      {panel === "reject" ? (
        <form
          className="decision"
          onSubmit={(event) => {
            event.preventDefault();
            onReject();
          }}
        >
          <h3>Reject this proposal</h3>
          <div className="field">
            <Label htmlFor="reviewer-reject">Reviewer name</Label>
            <Input id="reviewer-reject" value={reviewer} onChange={(event) => setReviewer(event.target.value)} />
          </div>
          <div className="field">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <Button type="submit" variant="destructive" disabled={Boolean(busy)}>
            {busy === "reject" ? "Rejecting" : "Reject this proposal"}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = `edit-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function providerLabel(ai: AiInfo): string {
  if (ai.provider === "offline_fallback") return "offline fallback";
  if (ai.provider === "openai") return "OpenAI";
  if (ai.provider === "cloudflare") return "Cloudflare Workers AI";
  return ai.provider;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
