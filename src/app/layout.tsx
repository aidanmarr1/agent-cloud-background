import type { Metadata } from "next";
import Script from "next/script";
import { cookies } from "next/headers";
import "katex/dist/katex.min.css";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthGate } from "@/components/auth/AuthGate";
import { AuthSessionProvider } from "@/components/auth/AuthSessionProvider";
import { ChatStoreSync } from "@/components/chat/ChatStoreSync";
import { AppFrame } from "@/components/layout/AppFrame";
import { auth } from "@/auth";

export const metadata: Metadata = {
  title: "Agent",
  description: "Autonomous agent for research, coding, and creation",
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
    ],
    shortcut: "/logo.svg",
    apple: "/logo.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const session = await auth().catch(() => null);
  const sidebarCookie = cookieStore.get("agent-sidebar-collapsed")?.value;
  const initialSidebarKnown = sidebarCookie === "0" || sidebarCookie === "1";
  const initialSidebarCollapsed = sidebarCookie === "1";
  const initialAccessStatus = session?.user?.accessStatus;
  const initialAccountDeleted = session?.user?.accountDeleted === true;

  return (
    <html
      lang="en"
      data-sidebar-known={initialSidebarKnown ? "true" : "false"}
      data-sidebar-state={initialSidebarCollapsed ? "collapsed" : "expanded"}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="agent-boot-preferences"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                function installChunkRecovery() {
                  if (window.__agentChunkRecoveryInstalled) return;
                  window.__agentChunkRecoveryInstalled = true;
                  function isChunkFailure(value) {
                    return /ChunkLoadError|Loading chunk [^\\s]+ failed|\\/_next\\/static\\/chunks\\//i.test(String(value || ''));
                  }
                  function reloadOnce() {
                    try {
                      var key = 'agent-last-chunk-reload-at';
                      var last = Number(sessionStorage.getItem(key) || '0');
                      var now = Date.now();
                      if (now - last < 5000) return;
                      sessionStorage.setItem(key, String(now));
                    } catch (storageError) {}
                    window.location.reload();
                  }
                  window.addEventListener('error', function(event) {
                    var target = event && event.target;
                    if (target && target.tagName === 'SCRIPT' && isChunkFailure(target.src)) {
                      reloadOnce();
                      return;
                    }
                    if (isChunkFailure(event && (event.message || event.error))) reloadOnce();
                  }, true);
                  window.addEventListener('unhandledrejection', function(event) {
                    var reason = event && event.reason;
                    if (isChunkFailure(reason && (reason.message || reason))) reloadOnce();
                  });
                }
                function applyTheme(mode) {
                  var root = document.documentElement;
                  root.classList.remove('light', 'dark');
                  root.classList.add(mode);
                  root.style.colorScheme = mode;
                }
                function applyUiPreferences() {
                  var root = document.documentElement;
                  root.setAttribute('data-ui-booting', '');
                  var cookie = document.cookie.match(/(?:^|; )agent-sidebar-collapsed=([01])(?:;|$)/);
                  if (cookie) {
                    var cookieCollapsed = cookie[1] === '1';
                    root.setAttribute('data-sidebar-known', 'true');
                    root.setAttribute('data-sidebar-state', cookieCollapsed ? 'collapsed' : 'expanded');
                    try {
                      var uiRaw = localStorage.getItem('agent-ui-preferences');
                      var uiParsed = uiRaw ? JSON.parse(uiRaw) : { state: {}, version: 0 };
                      uiParsed.state = uiParsed.state || {};
                      uiParsed.state.sidebarExpanded = cookieCollapsed;
                      localStorage.setItem('agent-ui-preferences', JSON.stringify(uiParsed));
                    } catch (storageError) {}
                    return;
                  }
                  var raw = localStorage.getItem('agent-ui-preferences');
                  if (!raw) {
                    root.setAttribute('data-sidebar-known', 'false');
                    root.setAttribute('data-sidebar-state', 'expanded');
                    return;
                  }
                  var parsed = JSON.parse(raw);
                  var state = parsed.state || {};
                  var collapsed = !!state.sidebarExpanded;
                  root.setAttribute('data-sidebar-known', 'false');
                  root.setAttribute('data-sidebar-state', collapsed ? 'collapsed' : 'expanded');
                  document.cookie = 'agent-sidebar-collapsed=' + (collapsed ? '1' : '0') + '; Path=/; Max-Age=31536000; SameSite=Lax';
                }
                try {
                  installChunkRecovery();
                  applyUiPreferences();
                  var raw = localStorage.getItem('agent-settings-store');
                  if (raw) {
                    var parsed = JSON.parse(raw);
                    var theme = parsed.state && parsed.state.theme;
                    var explicitTheme = parsed.state && parsed.state.themePreferenceSet === true;
                    if (theme === 'light') {
                      applyTheme('light');
                    } else if (theme === 'dark' && explicitTheme) {
                      applyTheme('dark');
                    } else {
                      var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                      applyTheme(dark ? 'dark' : 'light');
                    }
                    if (parsed.state && parsed.state.reduceMotion) {
                      document.documentElement.setAttribute('data-reduce-motion', '');
                    }
                    if (parsed.state && parsed.state.reduceTransparency) {
                      document.documentElement.setAttribute('data-reduce-transparency', '');
                    }
                  } else {
                    var defaultDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    applyTheme(defaultDark ? 'dark' : 'light');
                  }
                } catch(e) {
                  var fallbackDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                  applyTheme(fallbackDark ? 'dark' : 'light');
                  document.documentElement.setAttribute('data-sidebar-state', 'expanded');
                }
              })();
            `,
          }}
        />
      </head>
      <body
        className="antialiased bg-bg-primary text-text-primary min-h-screen flex"
      >
        <ThemeProvider>
          <AuthSessionProvider session={session}>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-4 focus:py-2 focus:bg-accent-blue focus:text-text-on-accent focus:rounded-lg focus:text-sm"
            >
              Skip to content
            </a>
            <AppFrame
              initialSidebarCollapsed={initialSidebarCollapsed}
              initialSidebarKnown={initialSidebarKnown}
              initialAccessStatus={initialAccessStatus}
              initialAccountDeleted={initialAccountDeleted}
            >
              <ErrorBoundary>
                <AuthGate>
                  <ChatStoreSync />
                  {children}
                </AuthGate>
              </ErrorBoundary>
            </AppFrame>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
