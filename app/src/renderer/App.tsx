import { useEffect, useState } from "react";

import { LoginPage } from "@/features/auth/login-page";
import { WorkspacePage } from "@/features/workspace/workspace-page";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    void window.tietiezhi.auth.status().then(
      (status) => setAuthenticated(status.authenticated),
      () => setAuthenticated(false),
    );
  }, []);

  useEffect(() => {
    if (authenticated === null) return;
    void window.tietiezhi.app.setWindowMode(authenticated ? "normal" : "setup");
  }, [authenticated]);

  if (authenticated === null) return <div className="bg-background h-svh" />;

  return (
    <div className="text-foreground h-svh overflow-hidden bg-transparent">
      {authenticated ? (
        <WorkspacePage />
      ) : (
        <LoginPage
          onAuthenticated={() => setAuthenticated(true)}
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
