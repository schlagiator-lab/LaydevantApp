import { useEffect, useState } from 'react';
import { useNavigation } from '../lib/useNavigation';
import { getAllPinnedDocuments } from '../lib/db';
import {
  requestPersistentStorage,
  isStoragePersisted,
  getStorageEstimate,
  formatBytes,
  type StorageEstimate,
} from '../lib/storagePersistence';
import { colors, fonts, textA } from '../styles/tokens';

export function DiagnosticScreen() {
  const nav = useNavigation();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [pinnedCount, setPinnedCount] = useState<number | null>(null);
  const [requesting, setRequesting] = useState(false);

  const refresh = async () => {
    const [p, e, pinned] = await Promise.all([
      isStoragePersisted(),
      getStorageEstimate(),
      getAllPinnedDocuments(),
    ]);
    setPersisted(p);
    setEstimate(e);
    setPinnedCount(pinned.length);
  };

  useEffect(() => {
    async function load() {
      await refresh();
    }
    void load();
  }, []);

  const handleRequest = async () => {
    setRequesting(true);
    await requestPersistentStorage();
    await refresh();
    setRequesting(false);
  };

  const usagePct =
    estimate?.usageBytes != null && estimate.quotaBytes ? (estimate.usageBytes / estimate.quotaBytes) * 100 : null;

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        padding: 16,
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={nav.goBack}
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
        <span style={{ fontSize: 18, fontWeight: 700 }}>Diagnostic stockage</span>
      </div>

      <div style={{ background: colors.card, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Row label="Stockage persistant" value={persisted === null ? 'Non supporté par ce navigateur' : persisted ? 'Accordé' : 'Non accordé'} />
        <Row label="Espace utilisé" value={formatBytes(estimate?.usageBytes ?? null)} />
        <Row label="Quota disponible" value={formatBytes(estimate?.quotaBytes ?? null)} />
        {usagePct !== null && <Row label="Occupation" value={`${usagePct.toFixed(1)} %`} />}
        <Row label="Documents épinglés (cet appareil)" value={pinnedCount === null ? '—' : String(pinnedCount)} />
      </div>

      <button
        type="button"
        onClick={() => void handleRequest()}
        disabled={requesting}
        style={{
          height: 48,
          borderRadius: 12,
          border: 'none',
          background: colors.accent,
          color: '#132146',
          fontSize: 15,
          fontWeight: 700,
          cursor: requesting ? 'default' : 'pointer',
          opacity: requesting ? 0.7 : 1,
        }}
      >
        {requesting ? 'Demande en cours…' : 'Redemander le stockage persistant'}
      </button>

      <p style={{ fontSize: 12.5, color: textA(0.5), lineHeight: 1.5 }}>
        Écran de vérification (CLAUDE.md §10) — les règles d'éviction du cache diffèrent entre iOS et
        Android, et entre navigateur et PWA installée sur l'écran d'accueil. À contrôler sur un
        appareil de chaque type avant de déployer à l'équipe.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ fontSize: 13.5, color: textA(0.6) }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{value}</span>
    </div>
  );
}
