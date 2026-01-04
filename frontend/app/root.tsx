import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation } from "react-router";
import { NavLink } from "react-router-dom";
import appStyles from "../src/styles/AppShell.module.css";
import sharedStyles from "../src/styles/Shared.module.css";
import "../src/styles/base.css";
import "../src/index.css";

type AppShellProps = {
  children: ReactNode;
};

function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const isGarage = location.pathname.startsWith("/garage");
  const styles = { ...sharedStyles, ...appStyles };
  const cx = (...names: string[]) => names.map((name) => styles[name]).filter(Boolean).join(" ");

  return (
    <div className={cx("app-shell")}>
      {!isGarage && (
        <nav className={cx("app-nav")}>
          <div className={cx("app-nav__brand")}>
            <span className={cx("eyebrow")}>F1 telemetry</span>
            <strong>Session Studio</strong>
          </div>
          <div className={cx("app-nav__links")}>
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                cx("app-nav__link", isActive ? "app-nav__link--active" : "")
              }
            >
              Session Explorer
            </NavLink>
            <NavLink
              to="/replayer"
              className={({ isActive }) =>
                cx("app-nav__link", isActive ? "app-nav__link--active" : "")
              }
            >
              Race Replayer
            </NavLink>
            <NavLink
              to="/garage"
              className={({ isActive }) =>
                cx("app-nav__link", isActive ? "app-nav__link--active" : "")
              }
            >
              Garage Portal
            </NavLink>
            <NavLink
              to="/strategy"
              className={({ isActive }) =>
                cx("app-nav__link", isActive ? "app-nav__link--active" : "")
              }
            >
              Strategy Lab
            </NavLink>
          </div>
        </nav>
      )}
      <div
        className={
          isGarage
            ? cx("app-shell__content", "app-shell__content--full")
            : cx("app-shell__content")
        }
      >
        {children}
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
