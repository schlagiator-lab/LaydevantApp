import { useContext } from 'react';
import { VaultSessionContext, type VaultSessionContextValue } from './vaultSessionContext';

export function useVaultSession(): VaultSessionContextValue {
  const ctx = useContext(VaultSessionContext);
  if (!ctx) throw new Error('useVaultSession must be used within a VaultSessionProvider');
  return ctx;
}
