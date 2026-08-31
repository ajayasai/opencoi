import { Code2, ShieldCheck } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "../api";
import { Callout, PageLoader } from "../components/ui";
import type { PublicUploadContext } from "../types";
import { DocumentIntake, type IntakeSubmission } from "./DocumentIntake";
import "./review.css";

export function PublicUploadPage() {
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
  );
  useLayoutEffect(() => {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);
  const [context, setContext] = useState<PublicUploadContext | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{
    title: string;
    description: string;
    receiptId: string;
  } | null>(null);

  useEffect(() => {
    if (!token) {
      setError("This upload link is invalid, expired, or has been revoked.");
      return;
    }
    api
      .publicUploadContext(token)
      .then(setContext)
      .catch(() => setError("This upload link is invalid, expired, or has been revoked."));
  }, [token]);

  const submit = async (file: File, metadata: IntakeSubmission) => {
    const receipt = await api.publicUpload(
      token,
      file,
      metadata as unknown as Record<string, unknown>,
    );
    setSuccess({
      title: "Your certificate was uploaded",
      description: `${context?.organizationName ?? "The requesting organization"} will review the extracted fields and contact you if anything is missing.`,
      receiptId: receipt.receiptId,
    });
  };

  if (error) {
    return (
      <main className="public-upload public-upload--centered">
        <div className="public-brand">
          <ShieldCheck size={23} />
          <strong>OpenCOI</strong>
        </div>
        <Callout tone="danger" title="Upload link unavailable">
          {error}
        </Callout>
      </main>
    );
  }
  if (!context)
    return (
      <main className="public-upload public-upload--centered">
        <PageLoader />
      </main>
    );

  return (
    <div className="public-upload">
      <header className="public-header">
        <div className="public-brand">
          <ShieldCheck size={23} />
          <strong>OpenCOI</strong>
        </div>
        <div>
          <span>Requested by</span>
          <strong>{context.organizationName}</strong>
        </div>
      </header>
      <main className="public-upload__content">
        <div className="public-intro">
          <span>Secure vendor upload</span>
          <h1>Submit insurance documents for {context.vendorName}</h1>
          <p>
            No account is required. Your document is assessed only after a human reviewer confirms
            the extracted fields.
          </p>
        </div>
        <DocumentIntake
          vendorName={context.vendorName}
          requirements={context.requirements}
          confirmationMode="vendor"
          submitLabel="Submit for review"
          onSubmit={submit}
          success={success}
        />
      </main>
      <footer className="public-footer">
        <span>Document assessment only — no insurer connectivity.</span>
        <a href="https://github.com/ajayasai/opencoi" target="_blank" rel="noreferrer">
          <Code2 size={14} /> Open source
        </a>
      </footer>
    </div>
  );
}
