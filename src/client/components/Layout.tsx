import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import { endpoints } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

export function Layout() {
  const { t, locale, setLocale } = useI18n();
  const me = useQuery({ queryKey: ["me"], queryFn: endpoints.me });
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme | null) ?? "system");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  const nav = [
    ["/", t("overview"), "overview"],
    ["/requests", t("requests"), "requests"],
    ["/security", t("security"), "security"],
    ["/archives", t("archives"), "archives"],
    ["/settings", t("settings"), "settings"],
  ] as const;
  return (
    <div className="app-shell">
      <header className="global-nav">
        <div className="global-nav-inner">
          <NavLink className="brand-mark" to="/" aria-label={t("brand")}>
            <span className="brand-cloud" aria-hidden><svg viewBox="0 0 24 24"><path d="M4 13.5h3.2l1.8-5 3 9 2-5h6" /></svg></span>
            <span>{t("brand")}</span>
          </NavLink>
          <nav aria-label="Primary">
            {nav.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === "/"}><NavIcon name={icon} /><span>{label}</span></NavLink>)}
          </nav>
          <div className="nav-tools">
            <label><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => setLocale(event.target.value as "zh-CN" | "en")}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
            <label><span>{t("theme")}</span><select aria-label={t("theme")} value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="system">{t("system")}</option><option value="light">{t("light")}</option><option value="dark">{t("dark")}</option></select></label>
            <div className="identity" title={me.data?.email}><span>{t("signedInAs")}</span><strong>{me.data?.email ?? "—"}</strong></div>
          </div>
        </div>
      </header>
      <main className="main-content"><Outlet /></main>
    </div>
  );
}

function NavIcon({ name }: { name: "overview" | "requests" | "security" | "archives" | "settings" }) {
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    requests: <><path d="M5 5h14M5 12h14M5 19h9" /><circle cx="3" cy="5" r=".5" /><circle cx="3" cy="12" r=".5" /><circle cx="3" cy="19" r=".5" /></>,
    security: <path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" />,
    archives: <><path d="M4 7h16v14H4zM3 3h18v4H3z" /><path d="M9 11h6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden>{paths[name]}</svg>;
}

export function PageHeader({ title, eyebrow, actions }: { title: string; eyebrow?: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>{actions && <div className="header-actions">{actions}</div>}</header>;
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warning" }) {
  return <div className={`notice ${tone}`}><span aria-hidden>{tone === "warning" ? "!" : "i"}</span><div>{children}</div></div>;
}
