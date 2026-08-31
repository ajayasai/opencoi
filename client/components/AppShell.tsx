import { OPENCOI_VERSION } from "@shared/version";
import {
  Activity,
  Building2,
  ChevronDown,
  ClipboardCheck,
  FileClock,
  FileOutput,
  LogOut,
  Menu,
  PlugZap,
  Scale,
  ScrollText,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
  { to: "/integrations", label: "Integrations", icon: PlugZap },
];

const MOBILE_NAVIGATION_QUERY = "(max-width: 980px)";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

const pageTitles: Record<string, { eyebrow?: string; title: string }> = {
  "/": { eyebrow: "Portfolio", title: "Overview" },
  "/vendors": { eyebrow: "Directory", title: "Vendors" },
  "/reviews": { eyebrow: "Documents", title: "Review queue" },
  "/requirements": { eyebrow: "Rules", title: "Requirements" },
  "/exceptions": { eyebrow: "Risk decisions", title: "Exceptions" },
  "/reminders": { eyebrow: "Renewals", title: "Reminders" },
  "/audit": { eyebrow: "Accountability", title: "Audit trail" },
  "/integrations": { eyebrow: "Automation", title: "Integrations" },
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
  const isMobileNavigation = useMediaQuery(MOBILE_NAVIGATION_QUERY);
  const sidebarRef = useRef<HTMLElement>(null);
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const profilePopoverRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.title = `${currentTitle(location.pathname).title} · OpenCOI`;
    setMobileOpen(false);
    setProfileOpen(false);
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  useEffect(() => {
    if (!isMobileNavigation) setMobileOpen(false);
  }, [isMobileNavigation]);

  useEffect(() => {
    if (!isMobileNavigation || !mobileOpen) return undefined;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : navigationTriggerRef.current;
    const sidebar = sidebarRef.current;
    const focusableElements = () =>
      Array.from(sidebar?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("navigation-open");
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("navigation-open");
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isMobileNavigation, mobileOpen]);

  useEffect(() => {
    if (!profileOpen) return undefined;
    profilePopoverRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !profileRef.current?.contains(event.target)) {
        setProfileOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setProfileOpen(false);
      profileTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileOpen]);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside
        ref={sidebarRef}
        id="main-navigation"
        className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}
        aria-label="Primary navigation"
        aria-hidden={isMobileNavigation && !mobileOpen ? true : undefined}
        inert={isMobileNavigation && !mobileOpen ? true : undefined}
        role={isMobileNavigation ? "dialog" : undefined}
      >
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
            <span>v{OPENCOI_VERSION}</span>
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

      <div className="app-main" inert={isMobileNavigation && mobileOpen ? true : undefined}>
        <header className="topbar">
          <div className="topbar__title">
            <IconButton
              className="menu-button"
              label="Open navigation"
              aria-controls="main-navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              ref={navigationTriggerRef}
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
            <div className="profile-menu" ref={profileRef}>
              <button
                ref={profileTriggerRef}
                type="button"
                className="profile-trigger"
                onClick={() => setProfileOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setProfileOpen(true);
                  }
                  if (event.key === "Escape" && profileOpen) {
                    event.preventDefault();
                    setProfileOpen(false);
                  }
                }}
                aria-controls="profile-popover"
                aria-expanded={profileOpen}
                aria-haspopup="dialog"
                aria-label={`Account menu for ${user?.name ?? "user"}`}
              >
                <span className="avatar">{initials(user?.name ?? "User")}</span>
                <span className="profile-trigger__copy">
                  <strong>{user?.name}</strong>
                  <small>{user?.role}</small>
                </span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {profileOpen && (
                <div
                  ref={profilePopoverRef}
                  id="profile-popover"
                  className="profile-popover"
                  role="dialog"
                  aria-label="Account menu"
                >
                  <div>
                    <strong>{user?.organizationName}</strong>
                    <span>{user?.email}</span>
                  </div>
                  <Button variant="quiet" size="sm" onClick={handleLogout}>
                    <LogOut size={16} aria-hidden="true" />
                    Sign out
                  </Button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main ref={mainRef} id="main-content" className="page-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
