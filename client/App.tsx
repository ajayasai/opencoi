import { FileQuestion, ShieldCheck } from "lucide-react";
import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { EmptyState, PageLoader } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
import { useAuth } from "./state/AuthContext";

const AuditPage = lazy(() =>
  import("./pages/AuditPage").then((module) => ({ default: module.AuditPage })),
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })),
);
const ExceptionsPage = lazy(() =>
  import("./pages/ExceptionsPage").then((module) => ({ default: module.ExceptionsPage })),
);
const IntegrationsPage = lazy(() =>
  import("./pages/IntegrationsPage").then((module) => ({ default: module.IntegrationsPage })),
);
const RemindersPage = lazy(() =>
  import("./pages/RemindersPage").then((module) => ({ default: module.RemindersPage })),
);
const RequirementsPage = lazy(() =>
  import("./pages/RequirementsPage").then((module) => ({ default: module.RequirementsPage })),
);
const ReviewsPage = lazy(() =>
  import("./pages/ReviewsPage").then((module) => ({ default: module.ReviewsPage })),
);
const VendorDetailPage = lazy(() =>
  import("./pages/VendorDetailPage").then((module) => ({ default: module.VendorDetailPage })),
);
const VendorsPage = lazy(() =>
  import("./pages/VendorsPage").then((module) => ({ default: module.VendorsPage })),
);
const CertificateDetailPage = lazy(() =>
  import("./review/CertificateDetailPage").then((module) => ({
    default: module.CertificateDetailPage,
  })),
);
const CertificateReviewPage = lazy(() =>
  import("./review/CertificateReviewPage").then((module) => ({
    default: module.CertificateReviewPage,
  })),
);
const PublicUploadPage = lazy(() =>
  import("./review/PublicUploadPage").then((module) => ({ default: module.PublicUploadPage })),
);

function AppLoading() {
  return (
    <div className="app-loading">
      <div className="brand-mark">
        <ShieldCheck size={24} />
      </div>
      <PageLoader />
    </div>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AppLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

function AuthenticatedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function NotFoundPage() {
  return (
    <EmptyState
      icon={<FileQuestion size={24} />}
      title="Page not found"
      description="The page may have moved, or you may not have access to it."
      action={
        <a className="button button--primary button--md" href="/">
          Return to overview
        </a>
      }
    />
  );
}

export function App() {
  return (
    <Suspense fallback={<AppLoading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/upload/:token" element={<PublicUploadPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/vendors/:vendorId/certificates/new" element={<CertificateReviewPage />} />
          <Route path="/certificates/:certificateId" element={<CertificateDetailPage />} />
          <Route element={<AuthenticatedLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="vendors" element={<VendorsPage />} />
            <Route path="vendors/:vendorId" element={<VendorDetailPage />} />
            <Route path="reviews" element={<ReviewsPage />} />
            <Route path="requirements" element={<RequirementsPage />} />
            <Route path="exceptions" element={<ExceptionsPage />} />
            <Route path="reminders" element={<RemindersPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
