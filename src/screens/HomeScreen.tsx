import { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import { useNavigation } from '../lib/useNavigation';
import { useToast } from '../lib/useToast';
import { getLocalDepartments, getRecentDocuments, getAllPinnedDocuments } from '../lib/db';
import { isVaultAdmin } from '../lib/vaultAdmin';
import { countNouvellesDemandes } from '../lib/demandes';
import type { Department } from '../types/database';
import type { RecentDocument } from '../lib/db';
import { StatusPill } from '../components/StatusPill';
import { SearchBarButton } from '../components/SearchBarButton';
import { departmentBadge } from '../lib/departmentStyle';
import { colors, fonts, textA } from '../styles/tokens';

const DANGER = '#D14343';

export function HomeScreen() {
  const { isOnline } = useAuth();
  const nav = useNavigation();
  const { showToast } = useToast();

  const [departments, setDepartments] = useState<Department[]>([]);
  const [recentDocs, setRecentDocs] = useState<RecentDocument[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [nouvellesDemandes, setNouvellesDemandes] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [depts, recents, pinned] = await Promise.all([
        getLocalDepartments(),
        getRecentDocuments(),
        getAllPinnedDocuments(),
      ]);
      if (cancelled) return;
      setDepartments(depts);
      setRecentDocs(recents);
      setPinnedIds(new Set(pinned.map((d) => d.id)));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Flag "Coffre (admin)" en rouge s'il y a des demandes 'nouvelle' à
  // traiter — admin uniquement (isVaultAdmin()), un monteur ne verrait sinon
  // que ses propres demandes via la RLS, pas un vrai signal global. Best-
  // effort : en ligne uniquement, échec silencieux (comme
  // canPublishCommunications), jamais de blocage de l'accueil pour ça.
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    void (async () => {
      try {
        const admin = await isVaultAdmin();
        if (!admin || cancelled) return;
        const count = await countNouvellesDemandes();
        if (!cancelled) setNouvellesDemandes(count);
      } catch {
        // Reste à 0 en cas d'échec — pas de flag affiché à tort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  const pinnedCount = pinnedIds.size;
  const pinnedLabel =
    pinnedCount === 0
      ? 'Aucun document téléchargé'
      : `${pinnedCount} document${pinnedCount === 1 ? '' : 's'} téléchargé${pinnedCount === 1 ? '' : 's'}`;

  const openRecentDoc = (doc: RecentDocument) => {
    const availableOffline = pinnedIds.has(doc.documentId);
    if (!availableOffline && !isOnline) {
      showToast(`Connexion réseau requise pour ouvrir « ${doc.title} ».`);
      return;
    }
    nav.goDocument(doc.documentId);
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
      }}
    >
      <div style={{ flex: 'none', padding: '12px 16px 8px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: textA(0.55),
            }}
          >
            Laydevant SA
          </span>
          <StatusPill online={isOnline} />
        </div>
        <SearchBarButton onClick={nav.goSearchBlank} />
      </div>

      <div
        className="no-scrollbar"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-start',
          gap: 8,
          padding: '8px 16px',
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        {departments.map((dept, index) => {
          const badge = departmentBadge(index);
          return (
            <button
              key={dept.id}
              type="button"
              onClick={() => nav.goDepartment(dept)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                minHeight: 64,
                flex: 'none',
                background: colors.card,
                border: 'none',
                borderRadius: 14,
                padding: '0 16px',
                cursor: 'pointer',
                textAlign: 'left',
                boxSizing: 'border-box',
              }}
            >
              <span
                style={{
                  flex: 'none',
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: fonts.mono,
                  fontWeight: 700,
                  fontSize: 16,
                  background: badge.bg,
                  color: badge.color,
                }}
              >
                {dept.name.charAt(0).toUpperCase()}
              </span>
              <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: colors.text }}>
                {dept.name}
              </span>
              <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
            </button>
          );
        })}

        {(() => {
          const badge = departmentBadge(departments.length);
          return (
            <button
              type="button"
              onClick={nav.goDossiers}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                minHeight: 64,
                flex: 'none',
                background: colors.card,
                border: 'none',
                borderRadius: 14,
                padding: '0 16px',
                cursor: 'pointer',
                textAlign: 'left',
                boxSizing: 'border-box',
              }}
            >
              <span
                style={{
                  flex: 'none',
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: fonts.mono,
                  fontWeight: 700,
                  fontSize: 16,
                  background: badge.bg,
                  color: badge.color,
                }}
              >
                D
              </span>
              <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: colors.text }}>Dossiers clients</span>
              <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
            </button>
          );
        })()}

        {recentDocs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: textA(0.45),
                padding: '0 2px',
              }}
            >
              Derniers documents consultés
            </span>
            <div style={{ background: colors.card, borderRadius: 12, overflow: 'hidden' }}>
              {recentDocs.map((doc) => {
                const dim = !pinnedIds.has(doc.documentId) && !isOnline;
                return (
                  <button
                    key={doc.documentId}
                    type="button"
                    onClick={() => openRecentDoc(doc)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      width: '100%',
                      minHeight: 48,
                      background: 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${textA(0.08)}`,
                      padding: '0 14px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      boxSizing: 'border-box',
                      opacity: dim ? 0.55 : 1,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: colors.text,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {doc.title}
                    </span>
                    <span style={{ flex: 'none', fontSize: 11.5, fontWeight: 600, color: textA(0.5) }}>
                      {doc.specialtyName}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={nav.goPinned}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            minHeight: 48,
            flex: 'none',
            background: 'transparent',
            border: '1px solid rgba(131, 163, 60, 0.4)',
            borderRadius: 12,
            padding: '0 16px',
            cursor: 'pointer',
            textAlign: 'left',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: colors.success }} />
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: colors.text }}>
            Documents téléchargés
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: textA(0.55) }}>{pinnedLabel}</span>
          <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
        </button>

        <button
          type="button"
          onClick={nav.goCommunications}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            minHeight: 44,
            flex: 'none',
            background: 'transparent',
            border: `1px solid ${textA(0.2)}`,
            borderRadius: 12,
            padding: '0 16px',
            cursor: 'pointer',
            textAlign: 'left',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: colors.text }}>
            Communication d'entreprise
          </span>
          <span style={{ color: textA(0.35), fontSize: 18 }}>›</span>
        </button>
      </div>

      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '10px 16px 14px',
        }}
      >
        <img
          src="/branding/logo-laydevant.jpg"
          alt="Laydevant SA — Électricité, Télécom, Automatisation de portes et portails"
          style={{ width: '100%', maxWidth: 360, borderRadius: 6 }}
        />
      </div>

      <div style={{ flex: 'none', display: 'flex', justifyContent: 'space-between', padding: '0 16px 10px' }}>
        {/* Mini-jeu autonome (PdfTetris standalone) — occupe l'emplacement
            historique de "Diagnostic stockage", déplacé dans "Outils". */}
        <button
          type="button"
          onClick={nav.goGame}
          style={{ background: 'transparent', border: 'none', color: textA(0.35), fontSize: 11, cursor: 'pointer' }}
        >
          Jeu
        </button>
        {/* Sous-menu Outils : diagnostic stockage + enrôlement coffre,
            fonctionnalités inchangées, juste regroupées (ToolsScreen). */}
        <button
          type="button"
          onClick={nav.goTools}
          style={{ background: 'transparent', border: 'none', color: textA(0.35), fontSize: 11, cursor: 'pointer' }}
        >
          Outils
        </button>
        {/* Panneau admin du coffre (tranche 5) — lien visible par tout le
            monde, le garde-fou (is_vault_admin) se fait dans l'écran
            lui-même. Passe en rouge (nouvellesDemandes > 0) quand des
            demandes 'nouvelle' attendent l'admin (canal de remontée
            terrain, onglet "Demandes" → section "Remontées terrain") —
            calculé uniquement pour un admin, cf. effet ci-dessus. */}
        <button
          type="button"
          onClick={nav.goVaultAdmin}
          style={{
            background: 'transparent',
            border: 'none',
            color: nouvellesDemandes > 0 ? DANGER : textA(0.35),
            fontSize: 11,
            fontWeight: nouvellesDemandes > 0 ? 700 : 400,
            cursor: 'pointer',
          }}
        >
          Coffre (admin){nouvellesDemandes > 0 ? ` (${nouvellesDemandes})` : ''}
        </button>
      </div>
    </div>
  );
}
