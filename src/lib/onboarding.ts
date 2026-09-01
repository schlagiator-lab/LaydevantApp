import { supabase, supabaseUrl } from './supabase';
import type { OnboardingInvitation, ProfileRole } from '../types/database';

// --- Gestion des invitations (admin uniquement, la RLS l'impose) -----------

export async function listInvitations(): Promise<OnboardingInvitation[]> {
  const { data, error } = await supabase
    .from('onboarding_invitations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OnboardingInvitation[];
}

/**
 * Invite (ou ré-invite) un email. upsert on conflict email : ré-inviter un
 * email déjà consommé le remet en "pending" (consumed_at = null) avec le
 * nouveau rôle/note. Un email = une invitation, statut mutable.
 */
export async function addInvitation(input: {
  email: string;
  role: ProfileRole;
  note: string | null;
}): Promise<void> {
  const { error } = await supabase.from('onboarding_invitations').upsert(
    {
      email: input.email.trim().toLowerCase(),
      role: input.role,
      note: input.note,
      consumed_at: null,
      consumed_by: null,
    },
    { onConflict: 'email' }
  );
  if (error) throw error;
}

export async function removeInvitation(email: string): Promise<void> {
  const { error } = await supabase
    .from('onboarding_invitations')
    .delete()
    .eq('email', email.trim().toLowerCase());
  if (error) throw error;
}

// --- Auto-enrôlement (public, sans session) --------------------------------

/**
 * Crée le compte via l'Edge Function `enroll`. Pas de session ici (la personne
 * n'a pas encore de compte), donc on tape la fonction avec la seule clé anon.
 * fetch brut plutôt que functions.invoke : lecture directe du message d'erreur
 * FR renvoyé par la fonction (403 "pas autorisé", 409 "déjà utilisé", etc.),
 * même pattern que /api/photos. Après succès, l'ÉCRAN appelle signInWithPassword.
 */
export async function enroll(input: {
  email: string;
  password: string;
  fullName: string;
}): Promise<void> {
  const res = await fetch(`${supabaseUrl}/functions/v1/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      email: input.email.trim().toLowerCase(),
      password: input.password,
      fullName: input.fullName.trim(),
    }),
  });
  if (!res.ok) {
    let message = `Enregistrement échoué (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* garde le message par défaut */
    }
    throw new Error(message);
  }
}
