import { createContext } from 'react';
import type { Department, DocType, Specialty } from '../types/database';

export interface SearchParams {
  query: string;
  /** null = no department filter ("Tout"). */
  departmentId: string | null;
  /** Specialty drill-down from the Department screen, if any. */
  specialtyId: string | null;
  pinnedOnly: boolean;
  /** Chips "type de document"/"fabricant" (mode parcours scopé) — portés par
   * le cran plutôt que par un useState local, pour survivre à l'aller-retour
   * document ouvert/refermé (SearchScreen démonte/remonte à chaque poussée/
   * dépilement, seul ce qui vit dans `params` traverse ce cycle). Optionnels
   * pour ne pas casser les autres call sites de SearchParams (BLANK_SEARCH,
   * goSearchBlank, goPinned) qui n'ont pas ces filtres à connaître. */
  docTypeFilter?: DocType | null;
  brandFilter?: string | null;
}

export type NavState =
  | { screen: 'home' }
  | { screen: 'department'; department: Department }
  | { screen: 'galerie'; specialty: Specialty }
  | { screen: 'search'; params: SearchParams }
  | { screen: 'document'; documentId: string }
  | { screen: 'diagnostic' }
  | { screen: 'webSearch'; context: WebSearchContext }
  | { screen: 'dossiers' }
  | { screen: 'dossier'; dossierId: string }
  | { screen: 'vaultEnroll' }
  | { screen: 'vaultAdmin' }
  | { screen: 'game' }
  | { screen: 'gameLeaderboard' }
  | { screen: 'gameDuoLobby' }
  | { screen: 'tools' }
  | { screen: 'communications' }
  | { screen: 'demandes' }
  | { screen: 'addCatalogNotice' };

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
  /** Spécialité en display_mode 'galerie' (CLAUDE.md §4) — grille de pastilles produit, pas de liste de documents. */
  goGalerie: (specialty: Specialty) => void;
  /** Blank search — used by the home search bar and "Toute la documentation". */
  goSearchBlank: () => void;
  goPinned: () => void;
  goSearch: (params: SearchParams) => void;
  /** Met à jour les params de l'entrée 'search' COURANTE en place (pas de
   * push, pas de pop, `stack.length` inchangé — n'interagit jamais avec la
   * synchro History API). No-op si le sommet de pile n'est pas 'search'. Sert
   * à faire survivre les chips type/fabricant à un aller-retour vers une
   * fiche document (le composant SearchScreen démonte/remonte, cette donnée
   * portée par la pile non). */
  updateSearchParams: (patch: Partial<SearchParams>) => void;
  goDocument: (documentId: string) => void;
  /** Storage diagnostic screen (CLAUDE.md §10) — not part of the core 4-screen UX. */
  goDiagnostic: () => void;
  /** Recherche web de notices (Feature recherche web notices.md, §4) — en ligne uniquement. */
  goWebSearch: (context: WebSearchContext) => void;
  /** Dossiers clients — liste (brief dossiers clients, étape A). */
  goDossiers: () => void;
  goDossier: (dossierId: string) => void;
  /** Enrôlement au coffre de données sensibles (étape B, tranche 4) — hors du
   * parcours principal tant que le reste du coffre n'existe pas. */
  goVaultEnroll: () => void;
  /** Panneau admin du coffre (tranche 5) — réservé aux admins, garde-fou fait
   * par l'écran lui-même (is_vault_admin), pas par la navigation. */
  goVaultAdmin: () => void;
  /** Mini-jeu PdfTetris lancé en autonome depuis l'accueil (hors recherche web). */
  goGame: () => void;
  /** Classement du mini-jeu, accessible depuis le menu du jeu ou l'écran de
   * fin de partie — cran séparé pour que le retour Android revienne au menu
   * du jeu plutôt qu'à l'accueil. */
  goGameLeaderboard: () => void;
  /** Lobby du mode duo (brique 4) — matchmaking par code, cran séparé pour
   * que le retour Android revienne au menu du jeu plutôt qu'à l'accueil,
   * même convention que goGameLeaderboard. */
  goGameDuoLobby: () => void;
  /** Sous-menu "Outils" — regroupe diagnostic stockage et enrôlement coffre. */
  goTools: () => void;
  /** Liste des communications d'entreprise (item 4) — remplace l'ancien
   * raccourci "Toute la documentation" sur l'accueil. */
  goCommunications: () => void;
  /** Dépôt et suivi des demandes (canal de remontée terrain), accessible
   * depuis l'onglet "Outils". */
  goDemandes: () => void;
  /** Ajout d'une notice à la bibliothèque sans dossier client, accessible
   * depuis l'onglet "Outils" — chemin direct sans validation admin, même
   * principe que le chemin direct de EquipmentRequestSheet mais sans
   * rattachement à un dossier. */
  goAddCatalogNotice: () => void;
  /** Pops the navigation stack — the back chevron on Search and Document screens. */
  goBack: () => void;
}

export const NavigationContext = createContext<NavigationContextValue | null>(null);
