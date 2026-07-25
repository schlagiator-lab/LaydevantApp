import { useEffect, useMemo, useState } from 'react';
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

/** Sum of a parent specialty's own document count over its full subtree —
 * a parent never holds documents directly (CLAUDE.md), so its count is
 * entirely its children's, recursively. Null = unknown (offline / not yet
 * loaded), matching the existing "no count shown" behavior of a leaf. */
function aggregateCount(
  specialtyId: string,
  childrenByParent: Map<string, Specialty[]>,
  leafCounts: Record<string, number>,
  memo: Map<string, number | null>,
): number | null {
  if (memo.has(specialtyId)) return memo.get(specialtyId) ?? null;
  const children = childrenByParent.get(specialtyId);
  let value: number | null;
  if (!children || children.length === 0) {
    value = specialtyId in leafCounts ? leafCounts[specialtyId] : null;
  } else {
    let total = 0;
    let any = false;
    for (const child of children) {
      const c = aggregateCount(child.id, childrenByParent, leafCounts, memo);
      if (c !== null) {
        total += c;
        any = true;
      }
    }
    value = any ? total : null;
  }
  memo.set(specialtyId, value);
  return value;
}

export function DepartmentScreen({ department, parent }: { department: Department; parent?: Specialty }) {
  const { isOnline } = useAuth();
  const nav = useNavigation();
  const [allSpecialties, setAllSpecialties] = useState<Specialty[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // All levels for the department in one shot — small referentiel data
      // (CLAUDE.md §4), lets every browse level (however deep) derive its
      // children client-side without extra round-trips.
      const local = await getLocalSpecialties(department.id);
      if (cancelled) return;
      setAllSpecialties(local);
      // Counts require a network round-trip (no local index of document
      // counts) — skip it offline rather than show a stale or fabricated number.
      if (isOnline) {
        try {
          const result = await countDocumentsBySpecialty(local.map((s) => s.id));
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

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Specialty[]>();
    for (const s of allSpecialties) {
      if (s.parent_id) {
        const list = map.get(s.parent_id) ?? [];
        list.push(s);
        map.set(s.parent_id, list);
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [allSpecialties]);

  const visibleSpecialties = useMemo(() => {
    const list = parent
      ? (childrenByParent.get(parent.id) ?? [])
      : allSpecialties.filter((s) => s.parent_id === null);
    return list.slice().sort((a, b) => a.sort_order - b.sort_order);
  }, [allSpecialties, childrenByParent, parent]);

  const quickSearch = () =>
    nav.goSearch({ query: '', departmentId: null, specialtyId: null, pinnedOnly: false });

  const openSpecialty = (specialty: Specialty) => {
    const children = childrenByParent.get(specialty.id);
    if (children && children.length > 0) {
      nav.goSpecialtyGroup(department, specialty);
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
              onClick={parent ? nav.goBack : nav.goHome}
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
              {parent ? department.name : 'Département'}
            </span>
          </div>
          <StatusPill online={isOnline} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <SearchBarButton onClick={quickSearch} />
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: colors.text }}>{parent ? parent.name : department.name}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '8px 16px 24px' }}>
        {visibleSpecialties.map((specialty) => {
          const count = aggregateCount(specialty.id, childrenByParent, counts, new Map());
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
