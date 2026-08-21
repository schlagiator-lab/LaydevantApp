/**
 * Musique de fond de PdfTetris — chemin/volume partagés entre le composant
 * (lecture normale) et le lobby duo (amorçage iOS côté host,
 * GameDuoLobbyScreen).
 */
export const TETRIS_MUSIC_SRC = '/tetris_audio.mp3';
export const TETRIS_MUSIC_VOLUME = 0.35;

/**
 * Amorce l'élément de musique DANS le geste utilisateur synchrone du tap
 * "Créer un match" — iOS WebKit n'autorise le démarrage d'un son que s'il
 * est déclenché synchronement par un geste. Côté host, la partie (et donc
 * le montage de PdfTetris qui joue la musique) ne démarre que plus tard,
 * depuis le callback de poll qui détecte l'arrivée du guest — hors geste,
 * donc bloqué sans cet amorçage préalable. Côté guest, le jeu démarre dans
 * le tap "Rejoindre" lui-même : pas besoin d'amorçage, chemin inchangé.
 *
 * Joue puis coupe immédiatement (muet le temps du blocage, sans bribe
 * audible) : débloque l'élément pour un `.play()` programmatique ultérieur.
 * L'instance retournée doit être réutilisée telle quelle par PdfTetris
 * (jamais recréée) — le déblocage iOS est attaché à CET élément, pas à la
 * page.
 */
export function primeMusicAudio(): HTMLAudioElement {
  const audio = new Audio(TETRIS_MUSIC_SRC);
  audio.loop = true;
  audio.volume = TETRIS_MUSIC_VOLUME;
  audio.muted = true;
  void audio
    .play()
    .then(() => {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    })
    .catch(() => {
      audio.muted = false;
    });
  return audio;
}
