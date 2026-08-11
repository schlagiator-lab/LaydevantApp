import { useEffect, useState } from 'react';
import type { Department, Specialty } from '../types/database';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { getLocalSpecialties } from '../lib/db';
import { countDocumentsBySpecialty } from '../lib/documents';
import { StatusPill } from '../components/StatusPill';
import { SearchBarButton } from '../components/SearchBarButton';
import { colors, fonts, textA } from '../styles/tokens';

function countLabel(count: number): string {
  return count === 0 ? 'Aucun document' : `${count} document${count === 1 ? '' : 's'}`;
}

export function DepartmentScreen({ department }: { department: Department }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const local = await getLocalSpecialties(department.id);
      if (cancelled) return;
      setSpecialties(local);
      // Counts require a network round-trip (no local index of document
      // counts) — skip it offline rather than show a stale or fabricated number.
      // Galerie specialties are excluded entirely: they have no `documents`
      // rows by nature, so a count would always read 0 — indistinguishable
      // from "empty" even though the specialty has content (its galerie items).
      const documentSpecialtyIds = local.filter((s) => s.display_mode !== 'galerie').map((s) => s.id);
      if (isOnline && documentSpecialtyIds.length > 0) {
        try {
          const result = await countDocumentsBySpecialty(documentSpecialtyIds);
          if (!cancelled) setCounts(result);
        } catch {
          // Non-critical — the row just renders without a count.
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [department.id, isOnline]);

  const quickSearch = () =>
    nav.goSearch({ query: '', departmentId: null, specialtyId: null, pinnedOnly: false });

  const openSpecialty = (specialty: Specialty) => {
    if (specialty.display_mode === 'galerie') {
      nav.goGalerie(specialty);
      return;
    }
    nav.goSearch({
      query: '',
      departmentId: department.id,
      specialtyId: specialty.id,
      pinnedOnly: false,
    });
  };

  return (
    <div
      className="no-scrollbar"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        overflowX: 'hidden',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
      }}
    >
      <div style={{ flex: 'none', padding: '14px 16px 16px', borderBottom: `1px solid ${textA(0.12)}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={nav.goHome}
              aria-label="Retour"
              style={{
                flex: 'none',
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: textA(0.1),
                border: 'none',
                color: colors.text,
                fontSize: 17,
                cursor: 'pointer',
              }}
            >
              ‹
            </button>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: textA(0.55),
              }}
            >
              Département
            </span>
          </div>
          <StatusPill online={isOnline} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <SearchBarButton onClick={quickSearch} />
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: colors.text }}>{department.name}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '8px 16px 24px' }}>
        {specialties.map((specialty) => {
          const count = counts[specialty.id] ?? null;
          return (
            <button
              key={specialty.id}
              type="button"
              onClick={() => openSpecialty(specialty)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                width: '100%',
                minHeight: 64,
                background: 'transparent',
                border: 'none',
                borderBottom: `1px solid ${textA(0.1)}`,
                padding: '0 4px',
                cursor: 'pointer',
                textAlign: 'left',
                boxSizing: 'border-box',
              }}
            >
              <span style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>{specialty.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                {count !== null && (
                  <span style={{ fontSize: 13, fontWeight: 600, color: textA(0.55) }}>
                    {countLabel(count)}
                  </span>
                )}
                <span style={{ color: textA(0.35), fontSize: 20 }}>›</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
