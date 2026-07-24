import { supabase } from './supabase';
import { getLocalDepartments, getLocalSpecialties, replaceDepartments, replaceSpecialties } from './db';
import type { Department, Specialty } from '../types/database';

/**
 * Refreshes the local (IndexedDB) copy of departments/specialties from
 * Supabase. Small, append-only-ish reference data — CLAUDE.md §4 treats it as
 * "toujours synchronisé", so screens read the local copy directly and this
 * just keeps it current whenever we happen to be online.
 */
export async function syncReferentiel(): Promise<void> {
  const [{ data: departments, error: deptError }, { data: specialties, error: specError }] =
    await Promise.all([
      supabase.from('departments').select('id, name, slug, icon, sort_order').returns<Department[]>(),
      supabase
        .from('specialties')
        .select('id, department_id, name, slug, sort_order')
        .returns<Specialty[]>(),
    ]);

  if (deptError) throw deptError;
  if (specError) throw specError;

  await Promise.all([replaceDepartments(departments ?? []), replaceSpecialties(specialties ?? [])]);
}

export { getLocalDepartments, getLocalSpecialties };
