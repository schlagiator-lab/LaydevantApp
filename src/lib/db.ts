import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Department, Specialty, DocumentRow } from '../types/database';

// Local IndexedDB schema — the three IndexedDB rows of CLAUDE.md §4's storage
// table. Cache API (PDF blobs) is handled separately in lib/pdfCache.ts; it
// doesn't belong here (IndexedDB is a poor fit for large binaries).
interface LocalDB extends DBSchema {
  departments: { key: string; value: Department };
  specialties: { key: string; value: Specialty };
  // Full document row (incl. `content`) for documents pinned on this device —
  // populated by the pin workflow (CLAUDE.md §4, step 4). Display fields that
  // live in joined tables (specialty/department/product) are denormalized in
  // at pin time so offline screens never need those joins.
  pinnedDocuments: { key: string; value: PinnedDocumentRecord };
  // Locally-viewed documents, most-recent-first — never synced (§5). Denormalized
  // display fields are stored alongside the id so the home screen can render
  // this list purely from IndexedDB, without a network round-trip, even for
  // documents that were never pinned.
  recentDocuments: { key: string; value: RecentDocument };
}

export interface RecentDocument {
  documentId: string;
  title: string;
  specialtyName: string;
  viewedAt: string;
}

export interface PinnedDocumentRecord extends DocumentRow {
  specialtyName: string;
  departmentName: string;
  productLabel: string | null;
}

const DB_NAME = 'laydevant-docs';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<LocalDB>> | null = null;

function getDb(): Promise<IDBPDatabase<LocalDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LocalDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('departments', { keyPath: 'id' });
        db.createObjectStore('specialties', { keyPath: 'id' });
        db.createObjectStore('pinnedDocuments', { keyPath: 'id' });
        db.createObjectStore('recentDocuments', { keyPath: 'documentId' });
      },
    });
  }
  return dbPromise;
}

export async function replaceDepartments(rows: Department[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('departments', 'readwrite');
  await tx.store.clear();
  await Promise.all(rows.map((row) => tx.store.put(row)));
  await tx.done;
}

export async function replaceSpecialties(rows: Specialty[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('specialties', 'readwrite');
  await tx.store.clear();
  await Promise.all(rows.map((row) => tx.store.put(row)));
  await tx.done;
}

export async function getLocalDepartments(): Promise<Department[]> {
  const db = await getDb();
  const rows = await db.getAll('departments');
  return rows.sort((a, b) => a.sort_order - b.sort_order);
}

export async function getLocalSpecialties(departmentId?: string): Promise<Specialty[]> {
  const db = await getDb();
  const rows = await db.getAll('specialties');
  const filtered = departmentId ? rows.filter((s) => s.department_id === departmentId) : rows;
  return filtered.sort((a, b) => a.sort_order - b.sort_order);
}

export async function getPinnedDocument(
  documentId: string,
): Promise<PinnedDocumentRecord | undefined> {
  const db = await getDb();
  return db.get('pinnedDocuments', documentId);
}

export async function getAllPinnedDocuments(): Promise<PinnedDocumentRecord[]> {
  const db = await getDb();
  return db.getAll('pinnedDocuments');
}

export async function putPinnedDocument(doc: PinnedDocumentRecord): Promise<void> {
  const db = await getDb();
  await db.put('pinnedDocuments', doc);
}

export async function deletePinnedDocument(documentId: string): Promise<void> {
  const db = await getDb();
  await db.delete('pinnedDocuments', documentId);
}

const RECENT_DOCUMENTS_LIMIT = 5;

export async function recordRecentDocument(
  entry: Omit<RecentDocument, 'viewedAt'>,
): Promise<void> {
  const db = await getDb();
  await db.put('recentDocuments', { ...entry, viewedAt: new Date().toISOString() });
}

export async function getRecentDocuments(): Promise<RecentDocument[]> {
  const db = await getDb();
  const rows = await db.getAll('recentDocuments');
  return rows
    .sort((a, b) => b.viewedAt.localeCompare(a.viewedAt))
    .slice(0, RECENT_DOCUMENTS_LIMIT);
}
