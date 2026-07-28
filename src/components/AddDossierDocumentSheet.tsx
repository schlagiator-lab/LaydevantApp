import { useEffect, useState } from 'react';
import { searchDocuments, listDocuments } from '../lib/documents';
import { addDossierDocument } from '../lib/dossiers';
import { docTypeLabel } from '../lib/docType';
import { colors, fonts, textA } from '../styles/tokens';

interface Row {
  id: string;
  title: string;
  docTypeLabel: string;
  specialtyName: string;
}

export interface AddDossierDocumentSheetProps {
  dossierId: string;
  /** Documents déjà rattachés au dossier — exclus des résultats. */
  excludeDocumentIds: Set<string>;
  onClose: () => void;
  onAdded: (documentId: string) => void;
}

/** Recherche dans la bibliothèque pour rattacher un document directement au dossier. */
export function AddDossierDocumentSheet({
  dossierId,
  excludeDocumentIds,
  onClose,
  onAdded,
}: AddDossierDocumentSheetProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const trimmed = query.trim();
    void (async () => {
      try {
        const rows: Row[] = trimmed
          ? (await searchDocuments({ q: trimmed })).map((r) => ({
              id: r.id,
              title: r.title,
              docTypeLabel: docTypeLabel(r.doc_type),
              specialtyName: r.specialty_name,
            }))
          : (await listDocuments()).map((r) => ({
              id: r.id,
              title: r.title,
              docTypeLabel: docTypeLabel(r.doc_type),
              specialtyName: r.specialties?.name ?? '',
            }));
        if (!cancelled) setResults(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  const handleAdd = async (row: Row) => {
    setAddingId(row.id);
    setError(null);
    try {
      await addDossierDocument(dossierId, row.id);
      setAddedIds((prev) => new Set(prev).add(row.id));
      onAdded(row.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'ajout.");
    } finally {
      setAddingId(null);
    }
  };

  const visible = (results ?? []).filter((r) => !excludeDocumentIds.has(r.id) && !addedIds.has(r.id));

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} className="no-scrollbar" style={sheetStyle}>
        <div style={grabberStyle} />
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Ajouter un document</div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Référence, notice, mot-clé..."
          style={inputStyle}
          autoFocus
        />

        {error && <p style={{ fontSize: 13, color: colors.accent, marginTop: 10 }}>{error}</p>}

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results === null && (
            <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 20 }}>Recherche…</p>
          )}
          {results !== null && visible.length === 0 && (
            <p style={{ fontSize: 14, color: textA(0.5), textAlign: 'center', marginTop: 20 }}>
              Aucun document trouvé.
            </p>
          )}
          {visible.map((row) => (
            <div key={row.id} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.title}
                </div>
                <div style={{ fontSize: 12.5, color: textA(0.55), fontWeight: 500 }}>
                  {row.docTypeLabel} · {row.specialtyName}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleAdd(row)}
                disabled={addingId === row.id}
                style={smallPrimaryButtonStyle}
              >
                {addingId === row.id ? '…' : 'Ajouter'}
              </button>
            </div>
          ))}
        </div>

        <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, marginTop: 18 }}>
          Terminé
        </button>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'flex-end',
  zIndex: 1200,
};

const sheetStyle: React.CSSProperties = {
  width: '100%',
  maxHeight: '85vh',
  overflowY: 'auto',
  background: colors.bg,
  borderTopLeftRadius: 20,
  borderTopRightRadius: 20,
  padding: '18px 16px 24px',
  boxSizing: 'border-box',
  fontFamily: fonts.sans,
  color: colors.text,
};

const grabberStyle: React.CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 2,
  background: textA(0.25),
  margin: '0 auto 16px',
};

const inputStyle: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: 'none',
  background: textA(0.08),
  color: colors.text,
  fontSize: 15,
  fontFamily: fonts.sans,
  padding: '0 14px',
  boxSizing: 'border-box',
  width: '100%',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  background: colors.card,
  borderRadius: 12,
  padding: '10px 12px',
};

const smallPrimaryButtonStyle: React.CSSProperties = {
  flex: 'none',
  height: 34,
  borderRadius: 10,
  border: 'none',
  background: colors.accent,
  color: '#132146',
  fontSize: 13,
  fontWeight: 700,
  padding: '0 12px',
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  width: '100%',
  height: 48,
  borderRadius: 12,
  border: `1px solid ${textA(0.3)}`,
  background: 'transparent',
  color: colors.text,
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  boxSizing: 'border-box',
};
