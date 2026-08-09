import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Department } from '../types/database';
import {
  NavigationContext,
  BLANK_SEARCH,
  type NavState,
  type SearchParams,
  type WebSearchContext,
} from './navigationContext';

const HOME: NavState = { screen: 'home' };

/**
 * Synchronise `stack` avec l'History API pour que le retour système Android
 * (swipe ou bouton) remonte d'un cran dans la pile au lieu de quitter l'app.
 *
 * Principe : chaque niveau de la pile correspond à une entrée d'historique
 * (même URL, seul `state.navDepth` change). L'entrée initiale est
 * remplacée (jamais poussée) par l'ancre `{ navDepth: 1 }` = HOME : une fois
 * cette entrée atteinte, un retour système ne trouve plus rien à nous
 * remettre en popstate et quitte l'app normalement — c'est le comportement
 * voulu, on ne fait rien pour l'empêcher.
 *
 * Tout retour — bouton UI ou geste système — passe par le MÊME chemin
 * (popstate) : `goBack()` n'agit plus directement sur la pile, il appelle
 * `history.back()`. C'est le popstate qui en résulte qui dépile réellement.
 * Ça évite deux implémentations parallèles du "retour d'un cran" qui
 * risqueraient de diverger.
 */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<NavState[]>([HOME]);
  const state = stack[stack.length - 1];

  // Profondeur d'historique déjà reflétée par pushState/replaceState. Sert à
  // ne pousser que la différence quand `stack` grandit, et à ne RIEN pousser
  // quand elle rétrécit suite à un popstate qu'on vient nous-mêmes de traiter
  // (sinon on repousserait une entrée pour une pile qui vient de se vider :
  // boucle avec le prochain retour système).
  const syncedDepthRef = useRef(1);
  // Vrai le temps d'un cycle de rendu quand la diminution de `stack` vient du
  // handler popstate ci-dessous (retour déjà pris en compte par le
  // navigateur) plutôt que d'un `goHome()` applicatif (qui saute directement
  // à la racine sans passer par l'historique, et a donc besoin qu'on rembobine
  // les entrées intermédiaires nous-mêmes avec `history.go`).
  const fromPopStateRef = useRef(false);

  useEffect(() => {
    // Ancre de niveau racine : REMPLACE l'entrée courante, n'en ajoute pas.
    window.history.replaceState({ navDepth: 1 }, '');

    const onPopState = () => {
      setStack((s) => {
        if (s.length <= 1) {
          // Déjà à la racine : rien à dépiler côté app, on laisse le retour
          // système se propager (fermeture de l'app), sans y toucher.
          return s;
        }
        fromPopStateRef.current = true;
        syncedDepthRef.current = s.length - 1;
        return s.slice(0, -1);
      });
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const depth = stack.length;
    if (depth > syncedDepthRef.current) {
      for (let d = syncedDepthRef.current + 1; d <= depth; d++) {
        window.history.pushState({ navDepth: d }, '');
      }
      syncedDepthRef.current = depth;
    } else if (depth < syncedDepthRef.current) {
      if (!fromPopStateRef.current) {
        // Diminution hors popstate (ex. goHome() depuis un écran profond) :
        // l'historique réel garde encore les entrées intermédiaires. On les
        // consomme pour de vrai, sinon le prochain retour système les
        // retrouverait et redéclencherait des popstate sans plus rien à
        // dépiler côté app.
        window.history.go(depth - syncedDepthRef.current);
      }
      syncedDepthRef.current = depth;
    }
    fromPopStateRef.current = false;
  }, [stack.length]);

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
  const goVaultEnroll = () => push({ screen: 'vaultEnroll' });
  const goVaultAdmin = () => push({ screen: 'vaultAdmin' });
  const goGame = () => push({ screen: 'game' });
  const goTools = () => push({ screen: 'tools' });
  // Passe TOUJOURS par l'historique : c'est le popstate en résultant qui
  // dépile (voir le handler ci-dessus), jamais un setStack direct ici.
  const goBack = () => {
    if (stack.length > 1) window.history.back();
  };

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
        goVaultEnroll,
        goVaultAdmin,
        goGame,
        goTools,
        goBack,
      }}
    >
      {children}
    </NavigationContext.Provider>
  );
}
