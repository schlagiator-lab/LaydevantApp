// Flag de couleur sur l'entrée "Outils" (accueil) — prévient le monteur
// qu'un admin a répondu à l'une de ses remontées (`demandes`) ou demandes
// d'équipement (`dossier_equipment_requests`). Deux canaux indépendants,
// agrégés par useToolsFlag.ts (vert prime sur orange). SELECT minimal dédié
// (statut/vu seulement) plutôt que `listMesDemandes`/`listMyEquipmentRequests`,
// qui ramènent bien plus que nécessaire pour ce calcul (vue jointe, jointure
// dossier).
import { supabase } from './supabase';

export type FlagColor = 'green' | 'orange' | null;

export interface ToolsFlagState {
  feedback: FlagColor;
  equipment: FlagColor;
}

function isFeedbackUnseen(row: { seen_by_requester_at: string | null; updated_at: string }): boolean {
  return row.seen_by_requester_at === null || row.seen_by_requester_at < row.updated_at;
}

export async function getToolsFlagState(): Promise<ToolsFlagState> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { feedback: null, equipment: null };

  const [feedbackResult, equipmentResult] = await Promise.all([
    supabase.from('demandes').select('statut, seen_by_requester_at, updated_at').eq('auteur', userId),
    supabase.from('dossier_equipment_requests').select('status, seen_by_requester_at').eq('requested_by', userId),
  ]);
  if (feedbackResult.error) throw feedbackResult.error;
  if (equipmentResult.error) throw equipmentResult.error;

  const feedbackRows = (feedbackResult.data ?? []) as {
    statut: string;
    seen_by_requester_at: string | null;
    updated_at: string;
  }[];
  const equipmentRows = (equipmentResult.data ?? []) as { status: string; seen_by_requester_at: string | null }[];

  let feedback: FlagColor = null;
  if (feedbackRows.some((r) => r.statut === 'traitee' && isFeedbackUnseen(r))) {
    feedback = 'green';
  } else if (feedbackRows.some((r) => r.statut === 'en_cours' && isFeedbackUnseen(r))) {
    feedback = 'orange';
  }

  const equipment: FlagColor = equipmentRows.some(
    (r) => (r.status === 'approved' || r.status === 'rejected') && r.seen_by_requester_at === null
  )
    ? 'green'
    : null;

  return { feedback, equipment };
}
