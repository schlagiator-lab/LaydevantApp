import { useEffect, useState } from 'react';
import { AuthProvider } from './lib/auth';
import { useAuth } from './lib/useAuth';
import { NavigationProvider } from './lib/NavigationProvider';
import { useNavigation } from './lib/useNavigation';
import { ToastProvider } from './lib/ToastProvider';
import { VaultSessionProvider } from './lib/vaultSession';
import { syncReferentiel } from './lib/referentiel';
import { LoginScreen } from './screens/LoginScreen';
import { EnrollScreen } from './screens/EnrollScreen';
import { HomeScreen } from './screens/HomeScreen';
import { DepartmentScreen } from './screens/DepartmentScreen';
import { GalerieScreen } from './screens/GalerieScreen';
import { SearchScreen } from './screens/SearchScreen';
import { DocumentScreen } from './screens/DocumentScreen';
import { DiagnosticScreen } from './screens/DiagnosticScreen';
import { WebSearchScreen } from './screens/WebSearchScreen';
import { DossiersScreen } from './screens/DossiersScreen';
import { DossierScreen } from './screens/DossierScreen';
import { VaultEnrollScreen } from './screens/VaultEnrollScreen';
import { VaultAdminScreen } from './screens/VaultAdminScreen';
import { GameScreen } from './screens/GameScreen';
import { GameLeaderboardScreen } from './screens/GameLeaderboardScreen';
import { GameDuoLobbyScreen } from './screens/GameDuoLobbyScreen';
import { ToolsScreen } from './screens/ToolsScreen';
import { CommunicationsScreen } from './screens/CommunicationsScreen';
import { DemandesScreen } from './screens/DemandesScreen';
import { AddCatalogNoticeScreen } from './screens/AddCatalogNoticeScreen';
import { requestPersistentStorage } from './lib/storagePersistence';

function Screens() {
  const nav = useNavigation();
  switch (nav.state.screen) {
    case 'home':
      return <HomeScreen />;
    case 'department':
      return <DepartmentScreen department={nav.state.department} />;
    case 'galerie':
      return <GalerieScreen key={nav.state.specialty.id} specialty={nav.state.specialty} />;
    case 'search':
      return <SearchScreen params={nav.state.params} />;
    case 'document':
      return <DocumentScreen key={nav.state.documentId} documentId={nav.state.documentId} />;
    case 'diagnostic':
      return <DiagnosticScreen />;
    case 'webSearch':
      return <WebSearchScreen context={nav.state.context} />;
    case 'dossiers':
      return <DossiersScreen />;
    case 'dossier':
      return <DossierScreen key={nav.state.dossierId} dossierId={nav.state.dossierId} />;
    case 'vaultEnroll':
      return <VaultEnrollScreen />;
    case 'vaultAdmin':
      return <VaultAdminScreen />;
    case 'game':
      return <GameScreen />;
    case 'gameLeaderboard':
      return <GameLeaderboardScreen />;
    case 'gameDuoLobby':
      return <GameDuoLobbyScreen />;
    case 'tools':
      return <ToolsScreen />;
    case 'communications':
      return <CommunicationsScreen />;
    case 'demandes':
      return <DemandesScreen />;
    case 'addCatalogNotice':
      return <AddCatalogNoticeScreen />;
  }
}

function AuthedApp() {
  const { isOnline } = useAuth();

  // Best-effort refresh of the local référentiel whenever we're online —
  // screens always read departments/specialties from IndexedDB (§4), this
  // just keeps that copy current instead of gating any UI on it.
  useEffect(() => {
    if (isOnline) void syncReferentiel();
  }, [isOnline]);

  // Ask once per session — CLAUDE.md §10. Browsers may grant this silently
  // based on engagement heuristics or not at all (notably iOS Safari); the
  // diagnostic screen reports the actual outcome.
  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  return (
    <NavigationProvider>
      <VaultSessionProvider>
        <ToastProvider>
          <Screens />
        </ToastProvider>
      </VaultSessionProvider>
    </NavigationProvider>
  );
}

// Pas de routeur : la bascule login/enrôlement est un simple état local.
// AuthGate reste monté en permanence (seule la branche needsLogin change),
// donc `mode` ne se réinitialise pas tout seul entre deux passages par
// l'écran de login — sans le reset ci-dessous (fait pendant le rendu, pas
// dans un effet : pattern React standard pour ajuster un état au changement
// d'une prop/valeur externe), un aller-retour enrôlement → connexion auto →
// déconnexion plus tard rouvrirait l'app directement sur EnrollScreen.
function AuthGate() {
  const { isReady, needsLogin } = useAuth();
  const [mode, setMode] = useState<'login' | 'enroll'>('login');
  const [prevNeedsLogin, setPrevNeedsLogin] = useState(needsLogin);

  if (needsLogin !== prevNeedsLogin) {
    setPrevNeedsLogin(needsLogin);
    if (!needsLogin) setMode('login');
  }

  if (!isReady) return null;
  if (!needsLogin) return <AuthedApp />;
  return mode === 'login' ? (
    <LoginScreen onEnroll={() => setMode('enroll')} />
  ) : (
    <EnrollScreen onLogin={() => setMode('login')} />
  );
}

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

export default App;
