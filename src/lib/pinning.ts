import { supabase } from './supabase';
import { fetchPdfBlob, fetchPdfBlobR2 } from './documents';
import { putPdf, deletePdf } from './pdfCache';
import { putPinnedDocument, deletePinnedDocument, type PinnedDocumentRecord } from './db';
import type { DocumentDetail } from './documentDetail';

/**
 * Pin sequence, exactly as specified in CLAUDE.md §4:
 * signed URL → fetch blob → Cache API → IndexedDB → insert pinned_documents.
 * `pinned_documents` is account-wide (synced across devices) but the Cache
 * API blob is per-device — this is what actually makes the document
 * available offline *here*, the DB row alone would not.
 */
export async function pinDocument(detail: DocumentDetail, userId: string): Promise<void> {
  const { doc } = detail;
  const blob =
    doc.storage_provider === 'r2'
      ? await fetchPdfBlobR2(doc.file_path, doc.mime_type)
      : await fetchPdfBlob(doc.file_path, doc.mime_type);

  await putPdf(doc.id, blob, doc.mime_type || 'application/pdf');

  const record: PinnedDocumentRecord = {
    ...detail.doc,
    specialtyName: detail.specialtyName,
    departmentName: detail.departmentName,
    productLabel: detail.productLabel,
  };
  await putPinnedDocument(record);

  const { error } = await supabase
    .from('pinned_documents')
    .upsert({ user_id: userId, document_id: detail.doc.id }, { onConflict: 'user_id,document_id' });
  if (error) throw error;
}

/**
 * Reverse order per CLAUDE.md §4 ("Retirer = l'inverse, dans l'ordre
 * inverse"): delete the account-wide row, then the local IndexedDB record,
 * then the cached PDF. The account-wide delete is best-effort when offline —
 * removing the document from *this device* is a legitimate offline action
 * (freeing storage on-site); it just can't also update the synced pin state
 * until the network comes back. Left un-synced, it lands exactly on the same
 * "pinned on the account, absent on this device" case CLAUDE.md already
 * defines for other documents — not a broken state.
 */
export async function unpinDocument(
  documentId: string,
  userId: string,
  isOnline: boolean,
): Promise<void> {
  if (isOnline) {
    const { error } = await supabase
      .from('pinned_documents')
      .delete()
      .eq('user_id', userId)
      .eq('document_id', documentId);
    if (error) throw error;
  }
  await deletePinnedDocument(documentId);
  await deletePdf(documentId);
}

/** Is this document pinned on the account (possibly on another device)? Online only. */
export async function isPinnedOnAccount(documentId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('pinned_documents')
    .select('document_id')
    .eq('user_id', userId)
    .eq('document_id', documentId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
