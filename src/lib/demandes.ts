// Demandes (canal de remontée terrain) — table possédée par cette app, créée
// hors dépôt (CLAUDE.md §3). Écran monteur uniquement : dépôt + suivi de ses
// propres demandes. La RLS restreint déjà le SELECT aux lignes de l'auteur,
// pas besoin de filtrer côté client.
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
