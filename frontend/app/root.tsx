import type { ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";
import AppNavBar from "../src/components/AppNavBar";
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
  const cx = (...names: string[]) =>
    names
      .map((name) => styles[name])
      .filter(Boolean)
      .join(" ");

  return (
    <div className={cx("app-shell")}>
      {!isGarage && <AppNavBar />}
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
        <script
          defer
          src="http://umamiprod.ekazuki.fr/script.js"
          data-website-id="44ca271f-21ff-4bfc-b768-a7110228f5eb"
        ></script>
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
