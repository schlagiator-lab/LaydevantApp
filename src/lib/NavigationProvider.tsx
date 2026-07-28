import { useState, type ReactNode } from 'react';
import type { Department } from '../types/database';
import {
  NavigationContext,
  BLANK_SEARCH,
  type NavState,
  type SearchParams,
  type WebSearchContext,
} from './navigationContext';

const HOME: NavState = { screen: 'home' };

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<NavState[]>([HOME]);
  const state = stack[stack.length - 1];

  const push = (next: NavState) => setStack((s) => [...s, next]);

  const goHome = () => setStack([HOME]);
  const goDepartment = (department: Department) => push({ screen: 'department', department });
  const goSearchBlank = () => push({ screen: 'search', params: BLANK_SEARCH });
  const goPinned = () => push({ screen: 'search', params: { ...BLANK_SEARCH, pinnedOnly: true } });
  const goSearch = (params: SearchParams) => push({ screen: 'search', params });
  const goDocument = (documentId: string) => push({ screen: 'document', documentId });
  const goDiagnostic = () => push({ screen: 'diagnostic' });
  const goWebSearch = (context: WebSearchContext) => push({ screen: 'webSearch', context });
  const goDossiers = () => push({ screen: 'dossiers' });
  const goDossier = (dossierId: string) => push({ screen: 'dossier', dossierId });
  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  return (
    <NavigationContext.Provider
      value={{
        state,
        canGoBack: stack.length > 1,
        goHome,
        goDepartment,
        goSearchBlank,
        goPinned,
        goSearch,
        goDocument,
        goDiagnostic,
        goWebSearch,
        goDossiers,
        goDossier,
        goBack,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
}
