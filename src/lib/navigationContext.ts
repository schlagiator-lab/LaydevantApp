import { createContext } from 'react';
import type { Department } from '../types/database';

export interface SearchParams {
  query: string;
  /** null = no department filter ("Tout"). */
  departmentId: string | null;
  /** Specialty drill-down from the Department screen, if any. */
  specialtyId: string | null;
  pinnedOnly: boolean;
}

export type NavState =
  | { screen: 'home' }
  | { screen: 'department'; department: Department }
  | { screen: 'search'; params: SearchParams }
  | { screen: 'document'; documentId: string }
  | { screen: 'diagnostic' }
  | { screen: 'webSearch'; context: WebSearchContext };

export const BLANK_SEARCH: SearchParams = {
  query: '',
  departmentId: null,
  specialtyId: null,
  pinnedOnly: false,
};

/** Contexte de filtre actif transmis depuis l'écran de recherche, pour
 * affiner la requête web sans que l'utilisateur ait à le ressaisir (§4). */
export interface WebSearchContext {
  departmentName: string | null;
  specialtyName: string | null;
}

export interface NavigationContextValue {
  state: NavState;
  canGoBack: boolean;
  goHome: () => void;
  goDepartment: (department: Department) => void;
  /** Blank search — used by the home search bar and "Toute la documentation". */
  goSearchBlank: () => void;
  goPinned: () => void;
  goSearch: (params: SearchParams) => void;
  goDocument: (documentId: string) => void;
  /** Storage diagnostic screen (CLAUDE.md §10) — not part of the core 4-screen UX. */
  goDiagnostic: () => void;
  /** Recherche web de notices (Feature recherche web notices.md, §4) — en ligne uniquement. */
  goWebSearch: (context: WebSearchContext) => void;
  /** Pops the navigation stack — the back chevron on Search and Document screens. */
  goBack: () => void;
}

export const NavigationContext = createContext<NavigationContextValue | null>(null);
