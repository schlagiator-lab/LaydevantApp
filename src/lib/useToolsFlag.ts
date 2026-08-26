import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import { getToolsFlagState, type FlagColor } from './toolsFlag';

export interface ToolsFlag {
  toolsColor: FlagColor;
  feedbackColor: FlagColor;
  equipmentColor: FlagColor;
  refresh: () => void;
}

/**
 * Flag de couleur agrégé sur l'entrée "Outils" de l'accueil — vert prime sur
 * orange, aucun canal non-vu -> pas de flag. Rafraîchi au montage et au
 * retour au premier plan (visibilitychange), pas de polling serré. Chaque
 * écran qui l'appelle a sa propre instance (pas de state partagé) : les
 * écrans de cette app ne sont pas gardés montés en arrière-plan (§ switch de
 * navigation), donc un remontage sur retour à l'accueil suffit à refléter un
 * acquittement fait entre-temps ailleurs.
 */
export function useToolsFlag(): ToolsFlag {
  const { isOnline, session } = useAuth();
  const [feedbackColor, setFeedbackColor] = useState<FlagColor>(null);
  const [equipmentColor, setEquipmentColor] = useState<FlagColor>(null);

  const refresh = useCallback(() => {
    if (!isOnline || !session?.user.id) return;
    void (async () => {
      try {
        const state = await getToolsFlagState();
        setFeedbackColor(state.feedback);
        setEquipmentColor(state.equipment);
      } catch {
        // Best-effort — garde le dernier état connu plutôt qu'un flag affiché à tort.
      }
    })();
  }, [isOnline, session?.user.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refresh]);

  const toolsColor: FlagColor =
    feedbackColor === 'green' || equipmentColor === 'green' ? 'green' : feedbackColor === 'orange' ? 'orange' : null;

  return { toolsColor, feedbackColor, equipmentColor, refresh };
}
