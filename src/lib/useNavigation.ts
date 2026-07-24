import { useContext } from 'react';
import { NavigationContext, type NavigationContextValue } from './navigationContext';

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within a NavigationProvider');
  return ctx;
}
