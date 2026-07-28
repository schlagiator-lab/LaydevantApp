import { useEffect } from 'react';
import { AuthProvider } from './lib/auth';
import { useAuth } from './lib/useAuth';
import { NavigationProvider } from './lib/NavigationProvider';
import { useNavigation } from './lib/useNavigation';
import { ToastProvider } from './lib/ToastProvider';
import { syncReferentiel } from './lib/referentiel';
import { LoginScreen } from './screens/LoginScreen';
import { HomeScreen } from './screens/HomeScreen';
import { DepartmentScreen } from './screens/DepartmentScreen';
import { SearchScreen } from './screens/SearchScreen';
import { DocumentScreen } from './screens/DocumentScreen';
import { DiagnosticScreen } from './screens/DiagnosticScreen';
import { WebSearchScreen } from './screens/WebSearchScreen';
import { DossiersScreen } from './screens/DossiersScreen';
import { DossierScreen } from './screens/DossierScreen';
import { requestPersistentStorage } from './lib/storagePersistence';

function Screens() {
  const nav = useNavigation();
  switch (nav.state.screen) {
    case 'home':
      return <HomeScreen />;
    case 'department':
      return <DepartmentScreen department={nav.state.department} />;
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
      <ToastProvider>
        <Screens />
      </ToastProvider>
    </NavigationProvider>
  );
}

function AuthGate() {
  const { isReady, needsLogin } = useAuth();
  if (!isReady) return null;
  return needsLogin ? <LoginScreen /> : <AuthedApp />;
}

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

export default App;
