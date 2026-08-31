import { ArrowRight, Building2, Download, Plus, Search, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import {
  Button,
  Card,
  EmptyState,
  Field,
  LifecycleBadge,
  Modal,
  PageLoader,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import { useToast } from "../state/ToastContext";
import type { VendorSummary, VendorType } from "../types";
import { formatDate, formatRelativeDate } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

interface VendorForm {
  legalName: string;
  dbaName: string;
  vendorTypeId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  externalReference: string;
  notes: string;
}

const blankVendor: VendorForm = {
  legalName: "",
  dbaName: "",
  vendorTypeId: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  externalReference: "",
  notes: "",
};

export function VendorsPage() {
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [vendorTypes, setVendorTypes] = useState<VendorType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<VendorForm>(blankVendor);
  const [formError, setFormError] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const canAdminister = user?.role === "owner" || user?.role === "admin";
  const { toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [vendorRows, typeRows] = await Promise.all([api.vendors(), api.vendorTypes()]);
      setVendors(vendorRows);
      setVendorTypes(typeRows);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const query = searchParams.get("q") ?? "";
  const typeFilter = searchParams.get("type") ?? "all";
  const statusFilter = searchParams.get("check") ?? "all";
  const lifecycleFilter = searchParams.get("document") ?? "all";

  const setFilter = (key: string, value: string, emptyValue = "all") => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === emptyValue) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return vendors.filter((vendor) => {
      const matchesQuery =
        !needle ||
        [
          vendor.legalName,
          vendor.dbaName,
          vendor.contactName,
          vendor.contactEmail,
          vendor.externalReference,
        ].some((value) => value?.toLowerCase().includes(needle));
      return (
        matchesQuery &&
        (typeFilter === "all" || vendor.vendorTypeId === typeFilter) &&
        (statusFilter === "all" || vendor.status === statusFilter) &&
        (lifecycleFilter === "all" || vendor.lifecycleStatus === lifecycleFilter)
      );
    });
  }, [lifecycleFilter, query, statusFilter, typeFilter, vendors]);

  const activeFilterCount = [typeFilter, statusFilter, lifecycleFilter].filter(
    (value) => value !== "all",
  ).length;
  const exportQuery = new URLSearchParams();
  if (query) exportQuery.set("q", query);
  if (typeFilter !== "all") exportQuery.set("type", typeFilter);
  if (statusFilter !== "all") exportQuery.set("check", statusFilter);
  if (lifecycleFilter !== "all") exportQuery.set("document", lifecycleFilter);
  const exportHref = `/api/vendors/export.csv${exportQuery.size ? `?${exportQuery}` : ""}`;

  const openCreate = () => {
    setForm({ ...blankVendor, vendorTypeId: vendorTypes[0]?.id ?? "" });
    setFormError("");
    setCreateOpen(true);
  };

  const updateForm = (key: keyof VendorForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const createVendor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.legalName.trim() || !form.vendorTypeId || !form.contactEmail.trim()) {
      setFormError("Legal name, vendor type, and contact email are required.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      const created = await api.createVendor(
        Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim() || null])),
      );
      toast("Vendor added", {
        message: `${created.legalName} is ready for certificate collection.`,
      });
      setCreateOpen(false);
      navigate(`/vendors/${created.id}`);
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <PageLoader />;
  if (error) return <PageError message={error} onRetry={load} />;

  return (
    <div className="page-stack">
      <PageHeading
        title="Vendor directory"
        description="Track who must provide insurance evidence and the latest result from each vendor’s submitted document."
        actions={
          canAdminister && (
            <Button onClick={openCreate}>
              <Plus size={17} />
              Add vendor
            </Button>
          )
        }
      />

      <Card className="directory-card">
        <div className="directory-toolbar">
          <div className="search-input">
            <Search size={17} aria-hidden="true" />
            <TextInput
              aria-label="Search vendors"
              value={query}
              onChange={(event) => setFilter("q", event.target.value, "")}
              placeholder="Search name, contact, or reference"
            />
          </div>
          <fieldset className="filter-row">
            <legend className="sr-only">Vendor filters</legend>
            <span className="filter-label">
              <SlidersHorizontal size={15} />
              Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
            </span>
            <Select
              aria-label="Filter by vendor type"
              value={typeFilter}
              onChange={(event) => setFilter("type", event.target.value)}
            >
              <option value="all">All vendor types</option>
              {vendorTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by document check result"
              value={statusFilter}
              onChange={(event) => setFilter("check", event.target.value)}
            >
              <option value="all">All check results</option>
              <option value="meets">Meets checks</option>
              <option value="deficient">Deficient</option>
              <option value="needs_review">Needs review</option>
              <option value="approved_exception">Approved exception</option>
              <option value="not_submitted">Not submitted</option>
            </Select>
            <Select
              aria-label="Filter by document lifecycle"
              value={lifecycleFilter}
              onChange={(event) => setFilter("document", event.target.value)}
            >
              <option value="all">All document dates</option>
              <option value="current">Current document</option>
              <option value="expiring">Expiring soon</option>
              <option value="expired">Expired</option>
              <option value="future">Future-dated</option>
              <option value="unknown">Date unknown</option>
            </Select>
            <a className="button button--secondary button--md" href={exportHref} download>
              <Download size={16} />
              Export CSV
            </a>
          </fieldset>
        </div>

        <div className="result-summary" aria-live="polite">
          Showing <strong>{filtered.length}</strong> of {vendors.length} vendors
          {(query || activeFilterCount > 0) && (
            <button type="button" onClick={() => setSearchParams({}, { replace: true })}>
              Clear filters
            </button>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<Building2 size={25} />}
            title={vendors.length ? "No vendors match these filters" : "Add your first vendor"}
            description={
              vendors.length
                ? "Change or clear a filter to see more records."
                : "Create a vendor, assign its coverage requirements, then invite it to submit a certificate."
            }
            action={
              !vendors.length && canAdminister ? (
                <Button onClick={openCreate}>
                  <Plus size={16} />
                  Add vendor
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table vendor-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Vendor type</th>
                  <th>Document check</th>
                  <th>Document date</th>
                  <th>Next expiration</th>
                  <th>Findings</th>
                  <th>
                    <span className="sr-only">View</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((vendor) => (
                  <tr key={vendor.id}>
                    <td>
                      <div className="table-primary">
                        <Link to={`/vendors/${vendor.id}`}>
                          <strong>{vendor.legalName}</strong>
                        </Link>
                        <span>{vendor.dbaName || vendor.contactEmail}</span>
                      </div>
                    </td>
                    <td>{vendor.vendorTypeName}</td>
                    <td>
                      <StatusBadge status={vendor.status} />
                    </td>
                    <td>
                      <LifecycleBadge status={vendor.lifecycleStatus} />
                    </td>
                    <td>
                      <div className="table-primary">
                        <strong>{formatDate(vendor.nextExpiration)}</strong>
                        <span>
                          {vendor.nextExpiration
                            ? formatRelativeDate(vendor.nextExpiration)
                            : "No confirmed date"}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={
                          vendor.openFindings
                            ? "finding-count finding-count--open"
                            : "finding-count"
                        }
                      >
                        {vendor.openFindings}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="row-link"
                        to={`/vendors/${vendor.id}`}
                        aria-label={`View ${vendor.legalName}`}
                      >
                        <ArrowRight size={17} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        title="Add vendor"
        description="Assign a requirements profile now; a certificate can be collected next."
        size="lg"
        footer={
          <>
            <Button variant="quiet" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" form="create-vendor-form" loading={creating}>
              Add vendor
            </Button>
          </>
        }
      >
        <form id="create-vendor-form" className="form-grid" onSubmit={createVendor}>
          {formError && (
            <div className="form-error" role="alert">
              {formError}
            </div>
          )}
          <Field label="Legal name" className="form-grid__wide">
            <TextInput
              required
              autoFocus
              value={form.legalName}
              onChange={(event) => updateForm("legalName", event.target.value)}
              placeholder="Northstar Electrical LLC"
            />
          </Field>
          <Field label="Doing business as">
            <TextInput
              value={form.dbaName}
              onChange={(event) => updateForm("dbaName", event.target.value)}
              placeholder="Optional trading name"
            />
          </Field>
          <Field label="Vendor type">
            <Select
              required
              value={form.vendorTypeId}
              onChange={(event) => updateForm("vendorTypeId", event.target.value)}
            >
              <option value="">Select a profile</option>
              {vendorTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name} · v{type.version}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contact name">
            <TextInput
              value={form.contactName}
              onChange={(event) => updateForm("contactName", event.target.value)}
              placeholder="Primary insurance contact"
            />
          </Field>
          <Field label="Contact email">
            <TextInput
              required
              type="email"
              value={form.contactEmail}
              onChange={(event) => updateForm("contactEmail", event.target.value)}
              placeholder="insurance@vendor.com"
            />
          </Field>
          <Field label="Contact phone">
            <TextInput
              type="tel"
              value={form.contactPhone}
              onChange={(event) => updateForm("contactPhone", event.target.value)}
              placeholder="Optional"
            />
          </Field>
          <Field label="External reference">
            <TextInput
              value={form.externalReference}
              onChange={(event) => updateForm("externalReference", event.target.value)}
              placeholder="Vendor ID or ERP reference"
            />
          </Field>
          <Field label="Internal notes" className="form-grid__wide">
            <Textarea
              value={form.notes}
              onChange={(event) => updateForm("notes", event.target.value)}
              placeholder="Visible only to workspace users"
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
