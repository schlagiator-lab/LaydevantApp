import { createContext } from 'react';

export interface VaultSessionContextValue {
  /** Clé privée RSA déverrouillée, en mémoire uniquement. Jamais persistée. */
  privateKey: CryptoKey | null;
  unlocked: boolean;
  unlocking: boolean;
  /** Message d'échec du dernier essai de déverrouillage (mot de passe incorrect). */
  error: string | null;
  /** Tente le déverrouillage avec le mot de passe de coffre ; renvoie le succès. */
  unlock: (password: string) => Promise<boolean>;
  /** Verrouillage explicite ou automatique — purge la clé privée. */
  lock: () => void;
  /** Réarme le minuteur d'auto-verrouillage (15 min) sur interaction. */
  touch: () => void;
}

export const VaultSessionContext = createContext<VaultSessionContextValue | null>(null);
