import "../src/styles/index.css";
import "./gallery.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Logo, type LogoVariant } from "../src";
import { CARDS, type Card } from "./cards";

const readmes = import.meta.glob<string>("../../../design-system/components/*/README.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

function readme(name: string): string {
  const text = readmes[`../../../design-system/components/${name}/README.md`] ?? "";
  return text.replace(/^#.*\n+/, "").trim();
}

type Theme = "light" | "dark";

function initialTheme(): Theme {
  return new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";
}

function CardView({ card }: { card: Card }) {
  return (
    <section className="g-card">
      <div
        className={card.canvas ? "g-preview g-preview--canvas" : "g-preview"}
        style={{ height: card.height }}
      >
        {card.render()}
      </div>
      <div className="g-meta">
        <h3>{card.name}</h3>
        <p>{readme(card.name)}</p>
      </div>
    </section>
  );
}

const LOGOS: { variant: LogoVariant; caption: string }[] = [
  { variant: "mark", caption: "Logo (mark, follows the theme)" },
  { variant: "mono", caption: 'Logo variant="mono"' },
  { variant: "app-icon", caption: 'Logo variant="app-icon"' },
];

function Gallery() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const groups = [...new Set(CARDS.map((c) => c.group))];
  return (
    <div className="g-wrap">
      <header className="g-header">
        <h1>Drawpane UI gallery</h1>
        <button
          type="button"
          className="dp-btn dp-btn--secondary dp-btn--md"
          aria-pressed={theme === "dark"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          Graphite theme
        </button>
        <p>
          Every component from <code>@drawpane/ui</code>, laid out like{" "}
          <code>design-system/index.html</code> so the two can be compared side by side.
        </p>
      </header>
      {groups.map((group) => (
        <div key={group}>
          <h2>{group}</h2>
          <div className="g-grid">
            {CARDS.filter((c) => c.group === group).map((card) => (
              <CardView key={card.name} card={card} />
            ))}
          </div>
        </div>
      ))}
      <h2>Logos</h2>
      <div className="g-logos">
        {LOGOS.map(({ variant, caption }) => (
          <figure key={variant}>
            <Logo variant={variant} size={64} />
            <figcaption>{caption}</figcaption>
          </figure>
        ))}
        <figure>
          <Logo wordmark size={32} />
          <figcaption>Logo wordmark</figcaption>
        </figure>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  root.className = "dp-root";
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}
