import { useEffect, useState } from "react";

import { LoginPage } from "@/features/auth/login-page";
import { WorkspacePage } from "@/features/workspace/workspace-page";
import type { AuthStatus } from "@shared/contracts";

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const authenticated = authStatus?.authenticated ?? false;

  useEffect(() => {
    void window.tietiezhi.auth.status().then(
      (status) => setAuthStatus(status),
      () => setAuthStatus({ authenticated: false }),
    );
  }, []);

  useEffect(() => {
    if (authStatus === null) return;
    void window.tietiezhi.app.setWindowMode(authenticated ? "normal" : "setup");
  }, [authenticated, authStatus]);

  if (authStatus === null) return <div className="bg-background h-svh" />;

  return (
    <div className="text-foreground h-svh overflow-hidden bg-transparent">
      {authenticated ? (
        <WorkspacePage
          auth={authStatus}
          onAuthChange={setAuthStatus}
          onLogout={async () => {
            await window.tietiezhi.auth.logout();
            setAuthStatus({ authenticated: false });
          }}
        />
      ) : (
        <LoginPage
          onAuthenticated={() => {
            void window.tietiezhi.auth.status().then(setAuthStatus);
          }}
          onOpenBrowserLogin={async () => {
            await window.tietiezhi.auth.openLogin();
          }}
          onCancelBrowserLogin={() => window.tietiezhi.auth.cancelLogin()}
          onLoginWithAPIKey={async (apiKey) => {
            await window.tietiezhi.auth.loginWithAPIKey(apiKey);
          }}
          onOpenRegistration={() => window.tietiezhi.auth.openRegistration()}
        />
      )}
    </div>
  );
}
