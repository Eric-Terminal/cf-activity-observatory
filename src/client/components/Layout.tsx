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
    ["/", t("overview"), "◫"],
    ["/requests", t("requests"), "⌁"],
    ["/security", t("security"), "◇"],
    ["/archives", t("archives"), "▱"],
    ["/settings", t("settings"), "⚙"],
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><span className="brand-cloud">◉</span><span>{t("brand")}</span></div>
        <nav aria-label="Primary">
          {nav.map(([to, label, icon]) => <NavLink key={to} to={to} end={to === "/"}><span aria-hidden>{icon}</span>{label}</NavLink>)}
        </nav>
        <div className="sidebar-foot">
          <label><span>{t("language")}</span><select value={locale} onChange={(event) => setLocale(event.target.value as "zh-CN" | "en")}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
          <label><span>{t("theme")}</span><select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="system">{t("system")}</option><option value="light">{t("light")}</option><option value="dark">{t("dark")}</option></select></label>
          <div className="identity"><span>{t("signedInAs")}</span><strong>{me.data?.email ?? "—"}</strong></div>
        </div>
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
  );
}

export function PageHeader({ title, eyebrow, actions }: { title: string; eyebrow?: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>{actions && <div className="header-actions">{actions}</div>}</header>;
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warning" }) {
  return <div className={`notice ${tone}`}><span aria-hidden>{tone === "warning" ? "!" : "i"}</span><div>{children}</div></div>;
}
