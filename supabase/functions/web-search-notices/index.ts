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
// Variante à filtrage dynamique : Claude exécute le tri des résultats
// côté serveur avant qu'ils n'atteignent le contexte du modèle, ce qui
// réduit le volume de texte lu (et donc le coût) par rapport à la variante
// de base. Repli possible vers 'web_search_20250305' via ce secret si le
// modèle configuré ne la supporte pas.
const WEB_SEARCH_TOOL_TYPE = Deno.env.get('ANTHROPIC_WEB_SEARCH_TOOL_TYPE') ?? 'web_search_20260209';
// Maîtrise du coût : chaque "use" facture la recherche elle-même ET le texte
// des résultats renvoyés au modèle. L'ancien défaut (5) multipliait la
// facture pour un gain de pertinence marginal — mais le ramener à 1 s'est
// révélé trop agressif : sans deuxième essai, une requête trop étroite ou un
// premier lot de résultats bruités renvoie une liste vide au lieu d'une
// requête reformulée, ce qui a fait chuter le taux de résultats trouvés.
// 3 est le compromis retenu : la variante à filtrage dynamique (ci-dessus)
// et le cache du prompt système (ci-dessous) font déjà l'essentiel du travail
// de réduction de coût, donc quelques essais de recherche supplémentaires
// restent marginaux — alors qu'ils redonnent à Claude la marge nécessaire
// pour reformuler sa requête si le premier essai ne donne rien de fiable.
const WEB_SEARCH_MAX_USES = Number(Deno.env.get('WEB_SEARCH_MAX_USES') ?? '3');
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

// Contenu figé (aucune valeur interpolée) pour rester un préfixe identique
// d'un appel à l'autre : c'est ce qui rend le cache_control efficace
// (maîtrise du coût, voir plus bas). Volontairement détaillé — la taille
// compte aussi : en dessous du minimum de mise en cache du modèle (1024
// tokens pour Sonnet 5), Anthropic ne met simplement rien en cache, sans
// erreur ni avertissement, et ce bloc ne sert plus à rien.
const SYSTEM_PROMPT = `Tu aides un technicien de terrain (électricité, télécom, portes automatiques) à
retrouver la documentation officielle d'un équipement à partir de sa marque et
de son modèle, lus directement sur l'étiquette du produit.

## Objectif

Trouver, pour le produit demandé, les documents suivants s'ils existent :
notices d'installation, manuels de programmation, fiches techniques. Rien
d'autre — ni page produit commerciale, ni fiche revendeur, ni forum.

## Méthode de recherche

Commence par une recherche web formulée le plus précisément possible : marque
+ modèle exacts, affinés par le contexte métier fourni dans le message
utilisateur s'il est présent (par exemple ajouter "disjoncteur" à la requête
écarte une grande partie du bruit pour une référence électrique ambiguë). Le
budget de recherche est limité (quelques essais au maximum) — ne multiplie pas
les variantes "pour voir". Mais si ce premier essai ne renvoie rien de fiable
(page produit sans documentation, résultats hors sujet, référence introuvable
telle quelle), reformule une fois ou deux avant de conclure à l'absence de
notice : essaie une orthographe alternative de la référence, retire ou change
le terme de contexte métier, ou cible directement le site du fabricant si tu
l'as identifié. N'abandonne pas après un seul essai raté.

Si la référence exacte ne donne toujours pas de documentation, élargis à la
GAMME avant de conclure à l'absence : retire le suffixe de déclinaison de la
référence pour retrouver la famille de produits (par exemple "ABA/S 1.2.1" ->
"ABA/S", "TN225-A" -> "TN225", "6108/07-500" -> "6108/07"), et cherche le
manuel ou la fiche qui couvre cette série. De nombreux fabricants — en KNX tout
particulièrement — publient un seul document pour toute une famille de
références plutôt qu'un document par déclinaison : le manuel de la référence
exacte peut donc ne pas exister isolément alors que celui de la gamme, lui,
existe et s'applique. Un tel document est pertinent et doit être retenu : dans
son \`title\`, indique explicitement qu'il couvre la gamme et non la seule
référence demandée (par exemple "Manuel série ABA/S — couvre la réf. ABA/S
1.2.1"). Pour le niveau de confiance, applique la règle de la section "Niveau
de confiance" : "moyenne" si le document de gamme mentionne ou englobe
clairement la référence demandée, "faible" s'il s'agit d'un document générique
à toute la famille sans confirmation que la référence précise y figure.

## Critères de sélection, dans cet ordre de priorité

1. Source fabricant officielle en priorité absolue. Une source non fabricante
   (distributeur technique, base documentaire tierce) ne peut être retenue que
   si aucune source fabricant n'existe pour ce produit précis.
2. Lien PDF direct de préférence à une page HTML intermédiaire. Le champ
   \`is_pdf\` doit refléter cela exactement : \`true\` uniquement si l'URL pointe
   un fichier PDF téléchargeable directement, jamais une page qui contient
   seulement un lien vers un PDF.
3. Version française du document en priorité, quand plusieurs langues
   existent pour le même document (cas fréquent chez les fabricants
   européens qui publient en français, allemand, anglais...). N'inclus une
   version dans une autre langue que si aucune version française n'existe
   pour ce produit précis — ne retiens jamais une version allemande ou
   anglaise "à défaut de mieux" si le français existe ailleurs.
4. Exclus explicitement : places de marché (Amazon, eBay, Cdiscount...),
   sites de revendeurs et grossistes électriques, forums et blogs, comparateurs
   de prix, pages de fiche produit purement commerciales sans documentation
   technique jointe.

## Domaines concernés (pour t'aider à juger la pertinence du contexte)

- Électricité : disjoncteurs, interrupteurs différentiels, tableaux,
  contacteurs, relais, variateurs, détecteurs.
- Télécom : centraux téléphoniques, interphones, visiophones, baies de
  brassage, systèmes de vidéosurveillance.
- Portes automatiques : opérateurs de porte, motorisations de portail,
  cellules photoélectriques, radars, commandes d'accès.

## Classification

Pour chaque résultat retenu, attribue exactement un type parmi :
- "notice_installation" : procédure de montage, câblage, raccordement, mise
  en service.
- "manuel_programmation" : configuration, codes d'accès technicien, réglages
  avancés, paramétrage.
- "fiche_technique" : caractéristiques, dimensions, données électriques,
  courbes de performance.
- "autre" : document pertinent qui ne rentre dans aucune des catégories
  ci-dessus (schéma électrique isolé, notice d'entretien...).

## Niveau de confiance

- "haute" : source fabricant, document correspondant exactement à la
  référence demandée.
- "moyenne" : source fabricant sur une gamme proche mais pas la référence
  exacte, ou source tierce reconnue avec un document manifestement
  correspondant.
- "faible" : correspondance incertaine — modèle proche mais pas identique,
  ou document générique à toute une gamme plutôt qu'à la référence précise.

## Cas "rien de fiable trouvé"

Si aucun document fiable n'est trouvé, renvoie une liste de résultats vide.
N'invente jamais une URL, un titre ou un nom de source qui ne provient pas
directement d'un résultat de recherche réel — un lien cassé ou inventé est
pire qu'une liste vide pour un technicien qui compte dessus sur le terrain.

## Format de réponse

Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises
Markdown, sans commentaire ni explication. Structure exacte :

{"results": [{"type": "notice_installation", "title": "Titre exact du document", "url": "https://exemple-fabricant.com/notice.pdf", "is_pdf": true, "source": "exemple-fabricant.com", "confidence": "haute"}]}

Exemple pour une recherche "Hager, TN225, contexte : disjoncteur" :

{"results": [{"type": "notice_installation", "title": "Hager TN225 - Notice de montage", "url": "https://hager.com/fr/documentation/tn225-notice.pdf", "is_pdf": true, "source": "hager.com", "confidence": "haute"}, {"type": "fiche_technique", "title": "Hager TN225 - Caractéristiques techniques", "url": "https://hager.com/fr/documentation/tn225-fiche.pdf", "is_pdf": true, "source": "hager.com", "confidence": "haute"}]}

Si rien de fiable n'est trouvé pour le produit demandé :

{"results": []}`;

function buildUserMessage(
  brand: string,
  model: string,
  departmentName: string | null,
  specialtyName: string | null,
  equipmentType: string | null,
): string {
  const context = [equipmentType, departmentName, specialtyName].filter(Boolean).join(' / ');
  return `Produit recherché : ${brand} ${model}${context ? ` (contexte métier : ${context})` : ''}`;
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
        // system en cache : identique à chaque appel (aucune valeur
        // interpolée), donc mis en cache une fois puis relu à ~10% du prix
        // par toutes les recherches suivantes, tous utilisateurs confondus,
        // tant que le cache reste chaud (TTL glissant de 5 minutes par
        // défaut). Seule la ligne "Produit recherché" varie, dans le
        // message user, hors du cache.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }],
        messages: [
          {
            role: 'user',
            content: buildUserMessage(
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
  const contentBlocks: Array<{ type: string }> = data.content ?? [];
  const finalText = extractFinalText(contentBlocks);

  try {
    const results = parseResults(finalText);
    return jsonResponse({ results });
  } catch (err) {
    console.error(
      'PARSE_FAIL web-search-notices: longueur du texte =',
      finalText.length,
      '\nPARSE_FAIL texte brut reçu =',
      finalText,
      '\nPARSE_FAIL blocs de contenu =',
      contentBlocks.length,
      contentBlocks.map((block) => block.type),
    );
    console.error('web-search-notices: failed to parse model output', err);
    // Même réponse que le chemin "liste vide" existant (index.ts, parseResults) :
    // l'appli affiche "aucun résultat" au lieu de planter. Le log PARSE_FAIL
    // ci-dessus garde la trace complète pour diagnostic.
    return jsonResponse({ results: [] });
  }
});
