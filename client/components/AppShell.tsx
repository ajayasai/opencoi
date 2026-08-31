import {
  Activity,
  Building2,
  ChevronDown,
  ClipboardCheck,
  FileClock,
  FileOutput,
  LogOut,
  Menu,
  Scale,
  ScrollText,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../state/AuthContext";
import { initials } from "../utils";
import { Button, IconButton } from "./ui";

const navigation = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/vendors", label: "Vendors", icon: Building2 },
  { to: "/reviews", label: "Review queue", icon: ClipboardCheck },
  { to: "/requirements", label: "Requirements", icon: Settings2 },
  { to: "/exceptions", label: "Exceptions", icon: Scale },
  { to: "/reminders", label: "Reminders", icon: FileClock },
  { to: "/audit", label: "Audit trail", icon: ScrollText },
];

const pageTitles: Record<string, { eyebrow?: string; title: string }> = {
  "/": { eyebrow: "Portfolio", title: "Overview" },
  "/vendors": { eyebrow: "Directory", title: "Vendors" },
  "/reviews": { eyebrow: "Documents", title: "Review queue" },
  "/requirements": { eyebrow: "Rules", title: "Requirements" },
  "/exceptions": { eyebrow: "Risk decisions", title: "Exceptions" },
  "/reminders": { eyebrow: "Renewals", title: "Reminders" },
  "/audit": { eyebrow: "Accountability", title: "Audit trail" },
};

function currentTitle(pathname: string) {
  if (pageTitles[pathname]) return pageTitles[pathname];
  if (/^\/vendors\/[^/]+\/certificates\/new/.test(pathname)) {
    return { eyebrow: "Documents", title: "Review certificate" };
  }
  if (/^\/vendors\/[^/]+/.test(pathname)) return { eyebrow: "Directory", title: "Vendor record" };
  if (/^\/certificates\//.test(pathname))
    return { eyebrow: "Evidence", title: "Certificate review" };
  return { title: "OpenCOI" };
}

export function AppShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const title = currentTitle(location.pathname);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__brand">
          <div className="brand-mark" aria-hidden="true">
            <ShieldCheck size={22} />
          </div>
          <div>
            <strong>OpenCOI</strong>
            <span>Document compliance</span>
          </div>
          <IconButton
            className="sidebar__close"
            label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={20} />
          </IconButton>
        </div>

        <nav className="sidebar__nav" aria-label="Main navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) => `nav-link ${isActive ? "nav-link--active" : ""}`}
              >
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar__scope">
          <FileOutput size={18} aria-hidden="true" />
          <div>
            <strong>Document-scoped checks</strong>
            <p>OpenCOI does not verify active coverage with insurers.</p>
          </div>
        </div>

        <div className="sidebar__footer">
          <a href="https://github.com/ajayasai/opencoi" target="_blank" rel="noreferrer">
            Open-source project
            <span>v0.1.1</span>
          </a>
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__title">
            <IconButton
              className="menu-button"
              label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={21} />
            </IconButton>
            <div>
              {title.eyebrow && <span>{title.eyebrow}</span>}
              <h1>{title.title}</h1>
            </div>
          </div>
          <div className="topbar__actions">
            {actions}
            <div className="profile-menu">
              <button
                type="button"
                className="profile-trigger"
                onClick={() => setProfileOpen((open) => !open)}
                aria-expanded={profileOpen}
              >
                <span className="avatar">{initials(user?.name ?? "User")}</span>
                <span className="profile-trigger__copy">
                  <strong>{user?.name}</strong>
                  <small>{user?.role}</small>
                </span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {profileOpen && (
                <div className="profile-popover">
                  <div>
                    <strong>{user?.organizationName}</strong>
                    <span>{user?.email}</span>
                  </div>
                  <Button variant="quiet" size="sm" onClick={handleLogout}>
                    <LogOut size={16} />
                    Sign out
                  </Button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
