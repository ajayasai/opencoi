import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AppShell } from "../components/AppShell";
import { Button, PageLoader } from "../components/ui";
import { useToast } from "../state/ToastContext";
import type { VendorDetail } from "../types";
import { DocumentIntake, type IntakeSubmission } from "./DocumentIntake";
import "./review.css";

export function CertificateReviewPage() {
  const { vendorId = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [vendor, setVendor] = useState<VendorDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .vendor(vendorId)
      .then(setVendor)
      .finally(() => setLoading(false));
  }, [vendorId]);

  if (loading)
    return (
      <AppShell>
        <PageLoader />
      </AppShell>
    );
  if (!vendor)
    return (
      <AppShell>
        <p>Vendor not found.</p>
      </AppShell>
    );

  const submit = async (file: File, metadata: IntakeSubmission) => {
    const certificate = await api.uploadCertificate(
      vendor.id,
      file,
      metadata as unknown as Record<string, unknown>,
    );
    toast("Certificate evaluated", {
      message: "The confirmed fields were compared with the published requirement version.",
    });
    navigate(`/certificates/${certificate.id}`);
  };

  return (
    <AppShell
      actions={
        <Button variant="secondary" size="sm" onClick={() => navigate(`/vendors/${vendor.id}`)}>
          <ArrowLeft size={15} /> Vendor
        </Button>
      }
    >
      <div className="review-page-heading">
        <div>
          <Link to={`/vendors/${vendor.id}`}>{vendor.legalName}</Link>
          <h2>Upload, extract, and confirm</h2>
          <p>
            Review the evidence before deterministic document checks run. Unknown values stay
            unknown.
          </p>
        </div>
      </div>
      <DocumentIntake
        vendorName={vendor.legalName}
        confirmationMode="staff"
        submitLabel="Confirm & evaluate"
        onSubmit={submit}
      />
    </AppShell>
  );
}
