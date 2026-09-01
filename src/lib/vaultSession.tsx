import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { unlockWithPassword, unlockWithRecovery } from './vault.js';
import { getOwnVaultKeyRecord } from './vaultSecrets';
import { useAuth } from './useAuth';
import { useNavigation } from './useNavigation';
import { VaultSessionContext, type VaultSessionContextValue } from './vaultSessionContext';

const AUTO_LOCK_MS = 15 * 60 * 1000;

/**
 * Session de déverrouillage du coffre (Feature coffre données sensibles.md,
 * tranche 4). Mémoire uniquement, jamais de storage : la clé privée RSA
 * déverrouillée vit ici, au-dessus de la navigation, pour survivre au
 * remontage de DossierScreen quand on passe d'un dossier à un autre
 * (App.tsx monte `<DossierScreen key={dossierId}>` — sans ce contexte, la
 * clé serait perdue à chaque changement de dossier).
 *
 * Purge (verrouillage) sur trois déclencheurs :
 *  - bouton "Verrouiller" explicite (lock()) ;
 *  - 15 min d'inactivité dans l'écran coffre (timer réarmé par touch()) ;
 *  - sortie de la zone "dossier" : dès que nav.state.screen n'est plus
 *    'dossier' (retour à l'accueil, recherche, liste des dossiers...).
 *    Rester sur l'écran dossier en changeant simplement de dossierId ne
 *    verrouille PAS — un même utilisateur ne doit pas retaper son mot de
 *    passe en passant d'un coffre à l'autre.
 */
export function VaultSessionProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const nav = useNavigation();

  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lock = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPrivateKey(null);
    setError(null);
  }, []);

  const armTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(lock, AUTO_LOCK_MS);
  }, [lock]);

  const touch = useCallback(() => {
    setPrivateKey((current) => {
      if (current) armTimer();
      return current;
    });
  }, [armTimer]);

  const unlock = useCallback(
    async (password: string) => {
      const userId = session?.user.id;
      if (!userId) return false;
      setUnlocking(true);
      setError(null);
      try {
        const record = await getOwnVaultKeyRecord(userId);
        // Cas distinct d'un mot de passe faux : pas de clé du tout pour ce
        // compte (jamais enrôlé). Sorti du try/catch générique ci-dessous
        // pour ne pas être masqué par "Mot de passe incorrect", qui induirait
        // en erreur quelqu'un qui n'a en réalité jamais rien configuré.
        if (!record) {
          setError('Aucune clé de coffre pour ce compte — enregistrement requis.');
          return false;
        }
        const key = await unlockWithPassword(password, record);
        setPrivateKey(key);
        armTimer();
        return true;
      } catch {
        setError('Mot de passe incorrect.');
        return false;
      } finally {
        setUnlocking(false);
      }
    },
    [session, armTimer],
  );

  const unlockWithRecoveryKey = useCallback(
    async (recoveryKey: string) => {
      const userId = session?.user.id;
      if (!userId) return false;
      setUnlocking(true);
      setError(null);
      try {
        const record = await getOwnVaultKeyRecord(userId);
        if (!record) {
          setError('Aucune clé de coffre pour ce compte — enregistrement requis.');
          return false;
        }
        const key = await unlockWithRecovery(recoveryKey, record);
        setPrivateKey(key);
        armTimer();
        return true;
      } catch {
        setError('Clé de récupération incorrecte.');
        return false;
      } finally {
        setUnlocking(false);
      }
    },
    [session, armTimer],
  );

  // Zone "dossiers" au sens large : la fiche ET la liste. Passer de la fiche
  // d'un dossier à un autre transite par la liste (Retour -> tape un autre
  // dossier) — si on ne gardait que 'dossier', ce passage par la liste
  // ferait un aller-retour false->true qui verrouillerait à chaque fois.
  const isDossierArea = nav.state.screen === 'dossier' || nav.state.screen === 'dossiers';
  useEffect(() => {
    if (!isDossierArea) return;
    // Cleanup, pas le corps de l'effet : ne se déclenche donc que quand on
    // QUITTE la zone dossiers (isDossierArea true -> false), jamais en
    // passant d'un dossierId à un autre ou en repassant par la liste —
    // c'est exactement le point 2 de la consigne coffre : pas de re-prompt
    // en changeant de coffre.
    return () => {
      lock();
    };
  }, [isDossierArea, lock]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const value: VaultSessionContextValue = {
    privateKey,
    unlocked: privateKey !== null,
    unlocking,
    error,
    unlock,
    unlockWithRecoveryKey,
    lock,
    touch,
  };

  return <VaultSessionContext.Provider value={value}>{children}</VaultSessionContext.Provider>;
}
