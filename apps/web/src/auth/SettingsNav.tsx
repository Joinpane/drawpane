/** The settings sections: your account, keyboard shortcuts and access tokens. */
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
      <Link
        to="/settings/tokens"
        className="settings-nav__link"
        activeProps={{ "aria-current": "page" }}
      >
        Access tokens
      </Link>
    </nav>
  );
}
