/** The settings sections: your account, and your keyboard shortcuts. */
import { Link } from "@tanstack/react-router";

export function SettingsNav() {
  return (
    <nav className="settings-nav" aria-label="Settings">
      <Link
        to="/settings"
        className="settings-nav__link"
        activeOptions={{ exact: true, includeSearch: false }}
        activeProps={{ "aria-current": "page" }}
      >
        Account
      </Link>
      <Link
        to="/settings/shortcuts"
        className="settings-nav__link"
        activeProps={{ "aria-current": "page" }}
      >
        Keyboard shortcuts
      </Link>
    </nav>
  );
}
