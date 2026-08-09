import PdfTetris from '../components/PdfTetris';
import { colors, fonts } from '../styles/tokens';

/**
 * Mini-jeu PdfTetris lancé en autonome depuis l'accueil, sans recherche web
 * derrière. Toute la logique de jeu vit dans PdfTetris (mode `standalone`,
 * qui ajoute son propre titre + bouton retour) — cet écran se contente de le
 * monter dans la pile de navigation.
 */
export function GameScreen() {
  return (
    <div
      className="no-scrollbar"
      style={{
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: colors.bg,
        color: colors.text,
        fontFamily: fonts.sans,
        padding: '16px 16px 24px',
      }}
    >
      <PdfTetris standalone />
    </div>
  );
}
