import type { ReactNode } from "react";
import "./auth.css";

/** The split sign-in layout: the brand on the left, one focused form on the right. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="auth">
      <aside className="auth__art" aria-hidden="true">
        <div className="auth__shapes">
          <span className="auth__shape auth__shape--ink" />
          <span className="auth__shape auth__shape--teal" />
          <span className="auth__shape auth__shape--signal" />
        </div>
        <div className="auth__tagline">
          <p className="auth__display">Design you own.</p>
          <p className="auth__lede">
            Open source, real-time and fast. This instance runs on its owner's Cloudflare account,
            so your files never leave it.
          </p>
        </div>
      </aside>
      <main className="auth__panel">
        <div className="auth__form">
          <div className="auth__brand">
            <img src="/drawpane-mark.svg" alt="" width={24} height={24} />
            <span>Drawpane</span>
          </div>
          <h1 className="auth__title">{title}</h1>
          {subtitle ? <p className="auth__subtitle">{subtitle}</p> : null}
          {children}
          <p className="auth__footer">
            {window.location.host} · Open source under{" "}
            <a href="https://github.com/Joinpane/drawpane" target="_blank" rel="noreferrer">
              MPL-2.0
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="auth__error" role="alert">
      {message}
    </p>
  );
}
