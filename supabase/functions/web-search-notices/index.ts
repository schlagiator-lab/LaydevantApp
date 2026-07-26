// Edge Function "web-search-notices" — Feature recherche web notices.md, §3.
//
// Relaie une recherche marque + modèle vers l'API Anthropic (recherche web
// côté serveur) et renvoie une liste triée de notices candidates. C'est la
// SEULE pièce du système qui détient ANTHROPIC_API_KEY (secret de fonction) —
// jamais exposée au front (CLAUDE.md §8).
//
// Auth : verify_jwt reste à sa valeur par défaut (activé) au déploiement —
// seul un utilisateur authentifié atteint ce code. La fonction n'utilise
// jamais la clé service_role (réservée à n8n, CLAUDE.md §8) : elle rejoue le
// JWT de l'appelant sur un client Supabase classique, donc les mêmes règles
// RLS que le front s'appliquent pour la journalisation/le plafond.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
// À vérifier sur docs.claude.com avant tout déploiement : le nom de modèle
// et la version datée de l'outil de recherche web évoluent (feature doc §3).
// Réglables sans toucher au code via les secrets de la fonction.
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-5';
const WEB_SEARCH_TOOL_TYPE = Deno.env.get('ANTHROPIC_WEB_SEARCH_TOOL_TYPE') ?? 'web_search_20250305';
const DAILY_LIMIT = Number(Deno.env.get('WEB_SEARCH_DAILY_LIMIT') ?? '50');

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ResultType = 'notice_installation' | 'manuel_programmation' | 'fiche_technique' | 'autre';

interface WebSearchResult {
  type: ResultType;
  title: string;
  url: string;
  is_pdf: boolean;
  source: string;
  confidence: 'haute' | 'moyenne' | 'faible';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * `sub` du JWT porteur. La signature a déjà été vérifiée par la passerelle
 * verify_jwt de la plateforme avant que ce code ne s'exécute — décoder sans
 * appel réseau supplémentaire est sûr tant que cette passerelle reste active.
 */
function userIdFromAuthHeader(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice('Bearer '.length);
    const payloadSegment = token.split('.')[1];
    const json = atob(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = JSON.parse(json).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

function buildPrompt(
  brand: string,
  model: string,
  departmentName: string | null,
  specialtyName: string | null,
  equipmentType: string | null,
): string {
  const context = [equipmentType, departmentName, specialtyName].filter(Boolean).join(' / ');

  return `Tu aides un technicien de terrain à retrouver la documentation officielle d'un équipement.

Produit recherché : ${brand} ${model}${context ? ` (contexte métier : ${context})` : ''}

Recherche spécifiquement les notices d'installation, manuels de programmation
et fiches techniques de ce produit exact. Intègre le contexte métier fourni à
ta requête pour écarter le bruit (par exemple préférer "${model} disjoncteur"
à "${model}" seul si le contexte l'indique).

Privilégie fortement les sources fabricant et les liens PDF directs. Écarte
explicitement les pages commerciales, les revendeurs, les places de marché et
les forums.

Le technicien lit le français. Quand plusieurs versions linguistiques du même
document existent (ex. un fabricant qui publie sa notice en français, allemand
et anglais), choisis en priorité la version française. N'inclus une version
dans une autre langue que si aucune version française n'est disponible pour ce
produit.

Pour chaque résultat retenu, indique son type parmi exactement ces valeurs :
"notice_installation", "manuel_programmation", "fiche_technique", "autre".

Si tu ne trouves rien de fiable, renvoie une liste vide — n'invente jamais
d'URL ni de titre.

Réponds UNIQUEMENT avec le JSON suivant, sans texte autour, sans balises
Markdown :
{"results": [{"type": "notice_installation", "title": "...", "url": "https://...", "is_pdf": true, "source": "nom-de-domaine.com", "confidence": "haute"}]}`;
}

function extractFinalText(content: Array<{ type: string; text?: string }>): string {
  const textBlocks = content.filter(
    (block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string',
  );
  return textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : '';
}

function parseResults(rawText: string): WebSearchResult[] {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const parsed = JSON.parse(stripped);
  if (!Array.isArray(parsed?.results)) return [];
  return parsed.results;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (!ANTHROPIC_API_KEY) return jsonResponse({ error: 'server_misconfigured' }, 500);

  const authHeader = req.headers.get('Authorization');
  const userId = userIdFromAuthHeader(authHeader);
  if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: {
    brand?: string;
    model?: string;
    department_name?: string | null;
    specialty_name?: string | null;
    equipment_type?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const brand = body.brand?.trim();
  const model = body.model?.trim();
  if (!brand || !model) return jsonResponse({ error: 'brand_and_model_required' }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader! } },
  });

  // Garde-fou de coût : plafond souple par utilisateur et par jour
  // (feature doc §3 "Sécurité et maîtrise du coût").
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error: countError } = await supabase
    .from('web_search_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since.toISOString());
  if (countError) {
    console.error('web-search-notices: rate limit check failed', countError);
    return jsonResponse({ error: 'rate_limit_check_failed' }, 500);
  }
  if ((count ?? 0) >= DAILY_LIMIT) {
    return jsonResponse({ error: 'daily_limit_reached', limit: DAILY_LIMIT }, 429);
  }

  // Journalisation avant l'appel : compte dans le plafond même si l'appel
  // Anthropic échoue ensuite, pour ne pas laisser une boucle d'échecs
  // contourner la limite.
  const { error: logError } = await supabase.from('web_search_log').insert({ user_id: userId, brand, model });
  if (logError) {
    console.error('web-search-notices: logging failed', logError);
    return jsonResponse({ error: 'rate_limit_check_failed' }, 500);
  }

  let anthropicResponse: Response;
  try {
    anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: 5 }],
        messages: [
          {
            role: 'user',
            content: buildPrompt(
              brand,
              model,
              body.department_name ?? null,
              body.specialty_name ?? null,
              body.equipment_type?.trim() || null,
            ),
          },
        ],
      }),
    });
  } catch (err) {
    console.error('web-search-notices: Anthropic call failed', err);
    return jsonResponse({ error: 'search_failed' }, 502);
  }

  if (!anthropicResponse.ok) {
    const detail = await anthropicResponse.text().catch(() => '');
    console.error('web-search-notices: Anthropic API error', anthropicResponse.status, detail);
    return jsonResponse({ error: 'search_failed' }, 502);
  }

  const data = await anthropicResponse.json();
  const finalText = extractFinalText(data.content ?? []);

  try {
    const results = parseResults(finalText);
    return jsonResponse({ results });
  } catch (err) {
    console.error('web-search-notices: failed to parse model output', err, finalText);
    return jsonResponse({ results: [], error: 'parse_failed' });
  }
});
