// Demandes (canal de remontée terrain) — table possédée par cette app, créée
// hors dépôt (CLAUDE.md §3). Côté monteur : dépôt + suivi de ses propres
// demandes (RLS SELECT restreint déjà aux lignes de l'auteur, pas besoin de
// filtrer côté client). Côté admin : vue et résolution de toutes les
// demandes (RLS laisse l'admin tout voir/modifier), section "Remontées
// terrain" de l'onglet "Demandes" de VaultAdminScreen.
import { supabase } from './supabase';
import { isIosDevice } from './pdfMeasure';
import type { Demande, DemandeStatut, DemandeType } from '../types/database';

const TYPE_LABELS: Record<DemandeType, string> = {
  amelioration: "Proposition d'amélioration",
  bug: 'Remonter un bug',
  autre: 'Autre',
};

export function demandeTypeLabel(type: DemandeType): string {
  return TYPE_LABELS[type];
}

const STATUT_LABELS: Record<DemandeStatut, string> = {
  nouvelle: 'Nouvelle',
  en_cours: 'En cours',
  traitee: 'Traitée',
};

export function demandeStatutLabel(statut: DemandeStatut): string {
  return STATUT_LABELS[statut];
}

/** Contexte technique joint à la demande — utile à l'admin pour reproduire un
 * bug (plateforme, user agent) sans que le monteur ait à le décrire. */
function buildContexte(): Record<string, unknown> {
  return {
    platform: isIosDevice() ? 'ios' : 'android_web',
    userAgent: navigator.userAgent,
    ecran: 'outils',
  };
}

/** Dépôt d'une demande (CLAUDE.md — canal de remontée terrain). `auteur` est
 * fourni par l'appelant via useAuth() (même mécanisme que createDossierNote,
 * dossiers.ts) : la policy RLS d'INSERT exige `auteur = auth.uid()`. */
export async function createDemande(input: {
  type: DemandeType;
  titre: string | null;
  message: string;
  auteur: string;
}): Promise<Demande> {
  const { data, error } = await supabase
    .from('demandes')
    .insert({
      type: input.type,
      titre: input.titre,
      message: input.message,
      auteur: input.auteur,
      contexte: buildContexte(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as Demande;
}

/** Demandes de l'utilisateur courant, plus récente d'abord — la RLS SELECT
 * restreint déjà aux lignes de l'auteur (l'admin voit tout, pas cet écran). */
export async function listMesDemandes(): Promise<Demande[]> {
  const { data, error } = await supabase
    .from('demandes_view')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Demande[];
}

/** Toutes les demandes (admin) — la RLS SELECT laisse l'admin tout voir, pas
 * de filtre par auteur ici. `type`/`statut` omis = pas de filtre sur cet axe. */
export async function listAllDemandes(
  filters: { type?: DemandeType; statut?: DemandeStatut } = {}
): Promise<Demande[]> {
  let query = supabase.from('demandes_view').select('*').order('created_at', { ascending: false });
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.statut) query = query.eq('statut', filters.statut);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Demande[];
}

/** Colonnes de la TABLE `demandes` (pas la vue demandes_view) : sans
 * auteur_nom/resolved_by_nom, qui n'existent que côté vue jointe. */
type DemandeRow = Omit<Demande, 'auteur_nom' | 'resolved_by_nom'>;

/**
 * Transition de statut et/ou réponse admin (admin uniquement, RLS laisse
 * l'admin écrire sur toute ligne). Écrit sur la TABLE, jamais sur la vue en
 * lecture seule. N'envoie que les champs fournis — un trigger côté base pose
 * resolved_by/resolved_at (et les efface si le statut ressort de 'traitee'),
 * jamais depuis le front.
 */
export async function updateDemandeStatut(
  id: string,
  input: { statut?: DemandeStatut; reponse_admin?: string | null }
): Promise<DemandeRow> {
  const patch: Record<string, unknown> = {};
  if (input.statut !== undefined) patch.statut = input.statut;
  if (input.reponse_admin !== undefined) patch.reponse_admin = input.reponse_admin;

  const { data, error } = await supabase.from('demandes').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data as DemandeRow;
}
