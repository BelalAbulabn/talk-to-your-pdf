'use client';

import { useState, type DragEvent } from 'react';
import {
  AlertCircle,
  Clock,
  FileText,
  Lock,
  Mic,
  Plus,
  Trash2,
  Upload,
  X,
} from 'react-feather';
import type { DocSummary, Quota } from '@/lib/api';

interface DocumentsPanelProps {
  documents: DocSummary[];
  quota: Quota | null;
  uploadingName: string | null;
  uploadError: string | null;
  open: boolean;
  onClose: () => void;
  onPick: () => void;
  onFile: (file: File) => void;
  onDelete: (id: string) => void;
  onDismissError: () => void;
}

export function expiresIn(expiresAt: number): string {
  const hours = Math.max(0, Math.round((expiresAt - Date.now()) / 3_600_000));
  return hours >= 1 ? `expires in ${hours} h` : 'expires soon';
}

export function Slots({
  total,
  filled,
  processing,
}: {
  total: number;
  filled: number;
  processing: boolean;
}) {
  return (
    <span className="slots" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i
          key={i}
          className={i < filled ? 'f' : i === filled && processing ? 'p' : ''}
        />
      ))}
    </span>
  );
}

export function DocumentsPanel(props: DocumentsPanelProps) {
  const { documents, quota, uploadingName } = props;
  const [dragging, setDragging] = useState(false);

  const maxDocs = quota?.maxFiles ?? 3;
  const fileLimitReached = documents.length >= maxDocs;
  const uploadsBlocked =
    !!quota && (!quota.serviceAvailable || quota.uploadsLeftToday <= 0);
  const canUpload = !uploadingName && !fileLimitReached && !uploadsBlocked;

  const voiceLeft = quota?.voiceMinutesLeft ?? 0;
  const voicePct = quota
    ? Math.round(
        (100 * quota.voiceMinutesLeft) / Math.max(1, quota.voiceMinutesPerDay),
      )
    : 0;

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && canUpload) props.onFile(file);
  };

  return (
    <aside
      className={`panel docs${props.open ? ' open' : ''}`}
      aria-label="Your documents"
    >
      <div className="docs-head">
        <div className="docs-title">
          <h2 className="h2">Your documents</h2>
          <button
            type="button"
            className="iconbtn docs-close"
            aria-label="Close documents"
            onClick={props.onClose}
          >
            <X className="i" />
          </button>
        </div>
        <p className="muted">
          Upload a PDF, then talk or type to ask questions about it.
        </p>
        <p className="muted lock">
          <Lock className="i i-sm" aria-hidden="true" />
          <span>Your files are private and deleted after 24 hours.</span>
        </p>
      </div>

      {canUpload || uploadingName ? (
        <div
          className={`drop${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (canUpload) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="drop-icon">
            <Upload className="i i-lg" aria-hidden="true" />
          </div>
          <p className="drop-title">Drag a PDF here, or</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={props.onPick}
            disabled={!canUpload}
          >
            <Plus className="i i-sm" aria-hidden="true" />
            Upload PDF
          </button>
          <p className="drop-meta">
            PDF only · up to {quota?.maxUploadMb ?? 10} MB ·{' '}
            {quota?.maxPages ?? 50} pages
          </p>
        </div>
      ) : (
        <div className="drop is-disabled" aria-disabled="true">
          <div className="drop-icon">
            <Upload className="i i-lg" aria-hidden="true" />
          </div>
          <p className="drop-title">
            {fileLimitReached
              ? `${maxDocs} of ${maxDocs} files used`
              : 'Uploads paused until tomorrow'}
          </p>
          <button type="button" className="btn btn-primary" disabled>
            Upload PDF
          </button>
        </div>
      )}

      {props.uploadError && (
        <div className="alert alert--error" role="alert">
          <AlertCircle className="i" aria-hidden="true" />
          <div className="alert-body">
            <p className="alert-title">Couldn’t add this PDF</p>
            <p>{props.uploadError}</p>
          </div>
          <button
            type="button"
            className="alert-x"
            aria-label="Dismiss"
            onClick={props.onDismissError}
          >
            <X className="i i-sm" />
          </button>
        </div>
      )}

      <div className="files">
        <div className="files-head">
          <span>Files · {documents.length}</span>
          <Slots
            total={maxDocs}
            filled={documents.length}
            processing={!!uploadingName}
          />
        </div>
        {documents.length === 0 && !uploadingName && (
          <div className="files-empty">No documents yet</div>
        )}
        {documents.map((doc, index) => (
          <div
            key={doc.id}
            className="file"
            style={{ animationDelay: `${index * 0.06}s` }}
          >
            <div className="file-ic">
              <FileText className="i" aria-hidden="true" />
              <small>PDF</small>
            </div>
            <div className="file-body">
              <p className="file-name" title={doc.name}>
                {doc.name}
              </p>
              <p className="file-meta">
                <span>
                  {doc.pages} {doc.pages === 1 ? 'page' : 'pages'}
                </span>
                <span aria-hidden="true">·</span>
                <Clock aria-hidden="true" />
                <span>{expiresIn(doc.expiresAt)}</span>
              </p>
            </div>
            <button
              type="button"
              className="file-del"
              aria-label={`Delete ${doc.name}`}
              onClick={() => props.onDelete(doc.id)}
            >
              <Trash2 className="i i-sm" />
            </button>
          </div>
        ))}
        {uploadingName && (
          <div className="file is-processing" aria-live="polite">
            <div className="file-ic">
              <span className="spin" style={{ width: 18, height: 18 }} />
            </div>
            <div className="file-body">
              <p className="file-name" title={uploadingName}>
                {uploadingName}
              </p>
              <p className="file-meta">Reading and indexing…</p>
              <div
                className="progress"
                role="progressbar"
                aria-label={`Processing ${uploadingName}`}
              >
                <i />
              </div>
            </div>
          </div>
        )}
      </div>

      {quota && (
        <div className="quota">
          <div className="quota-row">
            <FileText className="i i-sm" aria-hidden="true" />
            <span>
              Up to {quota.maxFiles} files, {quota.maxUploadMb} MB /{' '}
              {quota.maxPages} pages each
            </span>
          </div>
          <div className="quota-row">
            <Mic className="i i-sm" aria-hidden="true" />
            <span>
              <strong className={voiceLeft === 0 ? 'zero' : ''}>
                {voiceLeft}
              </strong>{' '}
              voice minutes left today
            </span>
          </div>
          <div className="meterline" aria-hidden="true">
            <i
              className={voiceLeft === 0 ? 'zero' : ''}
              style={{ width: `${voicePct}%` }}
            />
          </div>
        </div>
      )}
    </aside>
  );
}
