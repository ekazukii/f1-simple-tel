import { NavLink } from "react-router-dom";
import { navLinks } from "../config/navLinks";
import sharedStyles from "../styles/Shared.module.css";
import styles from "../styles/GaragePortal.module.css";

const cx = (...names: string[]) =>
  names
    .map((name) => styles[name] || sharedStyles[name])
    .filter(Boolean)
    .join(" ");

export default function GarageNavBar() {
  return (
    <nav className={cx("garage-nav")}>
      {navLinks.map((link) => (
        <NavLink
          key={link.id}
          to={link.to}
          end={link.end}
          className={({ isActive }) =>
            cx("garage-nav__link", isActive ? "garage-nav__link--active" : "")
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
