/**
 * Test de restauration : R2 (daily/<date>/) -> projet Supabase de TEST.
 * Ne touche JAMAIS la prod. Toutes les creds viennent de l'environnement.
 *
 * Usage :
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *   PGURL='postgresql://...' BACKUP_DATE=2026-08-22 node restore.js
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Client } = require('pg');

const BUCKET = process.env.R2_BUCKET || 'laydevant-backups';
const DATE = process.env.BACKUP_DATE;
if (!DATE) { console.error('BACKUP_DATE manquant (ex. 2026-08-22)'); process.exit(1); }
if (!process.env.PGURL) { console.error('PGURL manquant'); process.exit(1); }

// Ordre imposé par le graphe de FK. Les parents avant les enfants.
const ORDER = [
  'profiles',
  'departments',
  'specialties',            // auto-référencée -> traitée en 2 passes
  'products',
  'documents',
  'dossiers',
  'dossier_notes',
  'dossier_photos',
  'dossier_plans',
  'dossier_produits',
  'dossier_documents',
  'dossier_deletion_requests',
  'dossier_equipment_requests',
  'dossier_equipment_request_files',
  'pinned_documents',
  'galerie_items',
  'galerie_photos',
  'communications',
  'demandes',
  'deletion_alert_acks',
  'duo_matches',
  'game_scores',
  'onboarding_invitations',
  'vault_user_keys',
  'vault_dossier_access',
  'vault_files',
  'vault_secrets',
  'web_search_jobs',
  'web_search_results',
  'web_search_log',
];

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

async function fetchJson(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await r.Body.transformToString('utf-8');
  return JSON.parse(body);
}

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

function norm(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;            // le driver pg convertit en array Postgres
  if (typeof v === 'object') return JSON.stringify(v); // jsonb
  return v;
}

async function insertRows(client, table, rows, cols) {
  if (!rows.length) return 0;
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map((row) => {
      const ph = cols.map((c) => { params.push(norm(row[c])); return '$' + params.length; });
      return '(' + ph.join(',') + ')';
    });
    const sql = `insert into public.${q(table)} (${cols.map(q).join(',')}) values ${tuples.join(',')} on conflict do nothing`;
    await client.query(sql, params);
    done += slice.length;
  }
  return done;
}

(async () => {
  const client = new Client({ connectionString: process.env.PGURL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connecté à la base de TEST.\n');

  const manifest = await fetchJson(`daily/${DATE}/_manifest.json`);
  console.log(`Manifest ${DATE} : ${manifest.table_count} tables annoncées.\n`);
  const attendu = Object.fromEntries(manifest.tables.map((t) => [t.table, t.row_count]));

  const report = [];

  for (const table of ORDER) {
    let rows;
    try {
      rows = await fetchJson(`daily/${DATE}/${table}.json`);
    } catch (e) {
      report.push({ table, statut: 'ABSENT du backup', inserees: 0, attendu: attendu[table] ?? '-' });
      continue;
    }
    if (!rows.length) {
      report.push({ table, statut: 'vide', inserees: 0, attendu: attendu[table] ?? 0 });
      continue;
    }
    const cols = Object.keys(rows[0]);

    try {
      if (table === 'specialties') {
        // Auto-référence parent_id : passe 1 sans le parent, passe 2 pour le poser.
        const sansParent = rows.map((r) => ({ ...r, parent_id: null }));
        await insertRows(client, table, sansParent, cols);
        for (const r of rows) {
          if (r.parent_id) {
            await client.query(
              `update public.specialties set parent_id = $1 where id = $2`,
              [r.parent_id, r.id]
            );
          }
        }
        report.push({ table, statut: 'OK (2 passes)', inserees: rows.length, attendu: attendu[table] ?? '-' });
      } else {
        const n = await insertRows(client, table, rows, cols);
        report.push({ table, statut: 'OK', inserees: n, attendu: attendu[table] ?? '-' });
      }
      console.log(`  ${table} : ${rows.length} lignes`);
    } catch (e) {
      report.push({ table, statut: 'ERREUR: ' + e.message.split('\n')[0], inserees: 0, attendu: attendu[table] ?? '-' });
      console.error(`  ${table} : ECHEC -> ${e.message.split('\n')[0]}`);
    }
  }

  // Verification finale : compte reel en base vs manifest.
  console.log('\n--- VERIFICATION (compte reel en base) ---');
  const final = [];
  for (const r of report) {
    let reel = '-';
    try {
      const res = await client.query(`select count(*)::int as n from public.${q(r.table)}`);
      reel = res.rows[0].n;
    } catch (e) { reel = 'n/a'; }
    const ok = (reel === r.attendu);
    final.push({ ...r, en_base: reel, conforme: ok ? 'oui' : 'NON' });
  }
  console.table(final);

  const ko = final.filter((f) => f.conforme === 'NON');
  console.log(`\n${final.length - ko.length}/${final.length} tables conformes au manifest.`);
  if (ko.length) console.log('Tables non conformes :', ko.map((k) => k.table).join(', '));

  await client.end();
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
