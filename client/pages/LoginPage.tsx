import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Eye,
  EyeOff,
  FileCheck2,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Button, Callout, Field, TextInput } from "../components/ui";
import { useAuth } from "../state/AuthContext";
import type { OidcStatus } from "../types";
import { errorMessage } from "./pageHelpers";
import "./pages.css";

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ssoSubmitting, setSsoSubmitting] = useState(false);
  const [oidc, setOidc] = useState<OidcStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [navigate, user]);

  useEffect(() => {
    let active = true;
    void api
      .oidcStatus()
      .then((status) => {
        if (active) setOidc(status);
      })
      .catch(() => {
        if (active) setOidc({ enabled: false, displayName: null, organizationName: null });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(location.search).get("sso") === "failed") {
      setError(
        "Single sign-on could not be completed. Your account may not be provisioned, or the identity response may have expired.",
      );
    }
  }, [location.search]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(email.trim(), password, organizationSlug.trim() || undefined);
      const destination = (location.state as { from?: { pathname?: string } } | null)?.from
        ?.pathname;
      navigate(destination || "/", { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSso = async () => {
    setError("");
    setSsoSubmitting(true);
    try {
      const result = await api.beginOidcLogin();
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(errorMessage(cause));
      setSsoSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-story" aria-labelledby="login-story-title">
        <a className="login-brand" href="/" aria-label="OpenCOI home">
          <span className="brand-mark">
            <ShieldCheck size={23} />
          </span>
          <span>
            <strong>OpenCOI</strong>
            <small>Document compliance</small>
          </span>
        </a>
        <div className="login-story__content">
          <span className="login-kicker">Open, explainable COI tracking</span>
          <h1 id="login-story-title">Know what the certificate shows—and what it doesn’t.</h1>
          <p>
            Review vendor insurance documents against your own coverage rules, keep every decision
            traceable, and give vendors a direct path to submit renewals.
          </p>
          <ul className="login-benefits">
            <li>
              <CheckCircle2 size={17} />
              Rule results include the expected and observed evidence.
            </li>
            <li>
              <CheckCircle2 size={17} />
              Exceptions record an owner, rationale, and expiration.
            </li>
            <li>
              <CheckCircle2 size={17} />
              Your data stays portable with CSV exports.
            </li>
          </ul>
        </div>
        <p className="login-scope">
          <FileCheck2 size={17} /> OpenCOI checks submitted documents. It does not confirm that a
          policy remains active with an insurer.
        </p>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-form-wrap">
          <div className="login-form-heading">
            <span>Welcome back</span>
            <h2 id="login-title">Sign in to your workspace</h2>
            <p>Use the account issued by your OpenCOI administrator.</p>
          </div>

          {error && (
            <Callout tone="danger" title="Sign-in failed">
              {error}
            </Callout>
          )}

          {oidc?.enabled && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                loading={ssoSubmitting}
                className="login-sso"
                onClick={handleSso}
              >
                {!ssoSubmitting && <KeyRound size={17} aria-hidden="true" />}
                Continue with {oidc.displayName ?? "single sign-on"}
              </Button>
              <div className="login-divider">
                <span>or use a local account</span>
              </div>
            </>
          )}

          <form className="login-form" onSubmit={handleSubmit}>
            <Field label="Email address">
              <TextInput
                type="email"
                name="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password">
              <span className="password-input">
                <TextInput
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </Field>
            <Field
              label="Workspace slug"
              hint="Optional unless the same email is active in more than one workspace."
            >
              <TextInput
                name="organization"
                autoComplete="organization"
                value={organizationSlug}
                onChange={(event) => setOrganizationSlug(event.target.value.toLowerCase())}
                pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                placeholder="acme-general-contractors"
              />
            </Field>
            <Button type="submit" size="lg" loading={submitting}>
              Sign in
              {!submitting && <ArrowRight size={17} aria-hidden="true" />}
            </Button>
          </form>

          <p className="login-help">
            Need access? Contact your workspace administrator. Local sign-in remains available as a
            break-glass path; this self-hosted release does not send password-reset email.
          </p>
          <a
            className="login-source"
            href="https://github.com/ajayasai/opencoi"
            target="_blank"
            rel="noreferrer"
          >
            <Code2 size={14} /> View Corresponding Source (AGPL-3.0)
          </a>
        </div>
      </section>
    </main>
  );
}
