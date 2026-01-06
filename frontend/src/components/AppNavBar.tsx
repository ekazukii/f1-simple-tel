import { NavLink } from "react-router-dom";
import { navLinks } from "../config/navLinks";
import appStyles from "../styles/AppShell.module.css";
import sharedStyles from "../styles/Shared.module.css";

const styles = { ...sharedStyles, ...appStyles };
const cx = (...names: string[]) => names.map((name) => styles[name]).filter(Boolean).join(" ");

export default function AppNavBar() {
  return (
    <nav className={cx("app-nav")}>
      <div className={cx("app-nav__brand")}>
        <span className={cx("eyebrow")}>F1 telemetry</span>
        <strong>Session Studio</strong>
      </div>
      <div className={cx("app-nav__links")}>
        {navLinks.map((link) => (
          <NavLink
            key={link.id}
            to={link.to}
            end={link.end}
            className={({ isActive }) =>
              cx("app-nav__link", isActive ? "app-nav__link--active" : "")
            }
          >
            {link.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
