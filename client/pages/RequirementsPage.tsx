import { CheckCircle2, CopyPlus, Layers3, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Modal,
  PageLoader,
  Select,
  TextInput,
} from "../components/ui";
import { useAuth } from "../state/AuthContext";
import { useToast } from "../state/ToastContext";
import type { CoverageRequirement, VendorType } from "../types";
import { formatDate } from "../utils";
import { errorMessage, PageError, PageHeading } from "./pageHelpers";
import "./pages.css";

const blankRequirement = (): CoverageRequirement => ({
  coverageType: "general_liability",
  label: "Commercial General Liability",
  required: true,
  minimumEachOccurrence: 1_000_000_00,
  minimumAggregate: 2_000_000_00,
  currency: "USD",
  requiredEndorsements: [],
  endorsementEvidence: "document",
  expirationWarningDays: 30,
});

const coverageOptions = [
  ["general_liability", "Commercial General Liability"],
  ["automobile_liability", "Automobile Liability"],
  ["workers_compensation", "Workers’ Compensation"],
  ["employers_liability", "Employers’ Liability"],
  ["professional_liability", "Professional Liability / E&O"],
  ["cyber_liability", "Cyber Liability"],
  ["umbrella_excess", "Umbrella / Excess Liability"],
  ["pollution_liability", "Pollution Liability"],
] as const;

function cloneRequirements(requirements?: CoverageRequirement[]) {
  return (requirements ?? []).map((requirement) => ({
    ...requirement,
    requiredEndorsements: [...requirement.requiredEndorsements],
  }));
}

export function RequirementsPage() {
  const [types, setTypes] = useState<VendorType[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<CoverageRequirement[]>([]);
  const [baseline, setBaseline] = useState<CoverageRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [typeName, setTypeName] = useState("");
  const [typeDescription, setTypeDescription] = useState("");
  const [createError, setCreateError] = useState("");
  const { user } = useAuth();
  const canAdminister = user?.role === "owner" || user?.role === "admin";
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await api.vendorTypes();
      setTypes(rows);
      setSelectedId((current) => current || rows[0]?.id || "");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = types.find((type) => type.id === selectedId) ?? null;

  useEffect(() => {
    const next = cloneRequirements(selected?.requirements);
    setDraft(next);
    setBaseline(next);
    setSaveError("");
  }, [selected]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [baseline, draft],
  );

  const chooseType = (id: string) => {
    if (dirty && !window.confirm("Discard unpublished requirement changes?")) return;
    setSelectedId(id);
  };

  const updateRule = <K extends keyof CoverageRequirement>(
    index: number,
    key: K,
    value: CoverageRequirement[K],
  ) => {
    setDraft((current) =>
      current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [key]: value } : rule)),
    );
  };

  const setMoney = (
    index: number,
    key: "minimumEachOccurrence" | "minimumAggregate",
    value: string,
  ) => {
    const dollars = value === "" ? null : Number(value);
    updateRule(
      index,
      key,
      dollars === null || Number.isNaN(dollars) ? null : Math.round(dollars * 100),
    );
  };

  const addRule = () => {
    setDraft((current) => [...current, blankRequirement()]);
  };

  const removeRule = (index: number) => {
    setDraft((current) => current.filter((_, ruleIndex) => ruleIndex !== index));
  };

  const publish = async () => {
    if (!selected) return;
    if (draft.some((rule) => !rule.coverageType.trim() || !rule.label.trim())) {
      setSaveError("Every rule needs a coverage key and display label.");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const updated = await api.publishRequirements(selected.id, { requirements: draft });
      setTypes((current) => current.map((type) => (type.id === updated.id ? updated : type)));
      const next = cloneRequirements(updated.requirements);
      setDraft(next);
      setBaseline(next);
      toast(`Version ${updated.version} published`, {
        message: "New certificate checks will use this immutable requirement version.",
      });
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const createType = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!typeName.trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      const created = await api.createVendorType({
        name: typeName.trim(),
        description: typeDescription.trim(),
      });
      setTypes((current) => [...current, created]);
      setSelectedId(created.id);
      setCreateOpen(false);
      setTypeName("");
      setTypeDescription("");
      toast("Vendor type created", { message: "Add its coverage rules, then publish version 1." });
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <PageLoader />;
  if (error) return <PageError message={error} onRetry={load} />;

  return (
    <div className="page-stack">
      <PageHeading
        title="Coverage requirements"
        description="Create reusable rule sets by vendor type. Publishing creates a new version so historical document decisions remain reproducible."
        actions={
          canAdminister && (
            <Button
              variant="secondary"
              onClick={() => {
                setCreateError("");
                setCreateOpen(true);
              }}
            >
              <Plus size={16} />
              New vendor type
            </Button>
          )
        }
      />

      <Callout tone="info" title="Versions preserve the decision context">
        A certificate records the requirement version and evaluation date used for its checks.
        Editing here never silently rewrites a prior result.
      </Callout>

      {types.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers3 size={25} />}
            title="No vendor types yet"
            description="Start with a group of vendors that share the same contractual insurance requirements."
            action={
              canAdminister ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus size={16} />
                  Create vendor type
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="requirements-layout">
          <aside className="type-list" aria-label="Vendor types">
            <div className="type-list__header">
              <span>Vendor types</span>
              <small>{types.length}</small>
            </div>
            {types.map((type) => (
              <button
                type="button"
                key={type.id}
                className={`type-card ${selectedId === type.id ? "type-card--active" : ""}`}
                onClick={() => chooseType(type.id)}
                aria-pressed={selectedId === type.id}
              >
                <span>
                  <strong>{type.name}</strong>
                  <small>
                    {type.vendorCount} {type.vendorCount === 1 ? "vendor" : "vendors"}
                  </small>
                </span>
                <span>
                  <Badge tone={type.publishedAt ? "success" : "warning"} dot={false}>
                    v{type.version}
                  </Badge>
                  <small>{type.requirementCount} rules</small>
                </span>
              </button>
            ))}
          </aside>

          {selected && (
            <section className="requirements-editor" aria-labelledby="requirements-title">
              <Card className="requirements-summary">
                <div>
                  <span className="section-kicker">Requirement profile</span>
                  <h3 id="requirements-title">{selected.name}</h3>
                  <p>{selected.description || "No profile description has been added."}</p>
                </div>
                <dl>
                  <div>
                    <dt>Current version</dt>
                    <dd>v{selected.version}</dd>
                  </div>
                  <div>
                    <dt>Published</dt>
                    <dd>{formatDate(selected.publishedAt)}</dd>
                  </div>
                  <div>
                    <dt>Assigned vendors</dt>
                    <dd>{selected.vendorCount}</dd>
                  </div>
                </dl>
              </Card>

              <div className="editor-toolbar">
                <div>
                  <strong>Coverage rules</strong>
                  <span>{draft.length} configured · currency values are stored in minor units</span>
                </div>
                {canAdminister && (
                  <Button variant="secondary" size="sm" onClick={addRule}>
                    <CopyPlus size={15} />
                    Add coverage
                  </Button>
                )}
              </div>

              {saveError && (
                <div className="form-error" role="alert">
                  {saveError}
                </div>
              )}

              {draft.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<ShieldCheck size={25} />}
                    title="No coverage rules"
                    description="Add the first required policy type, limits, and endorsement evidence expectations."
                    action={
                      canAdminister ? (
                        <Button onClick={addRule}>
                          <Plus size={16} />
                          Add coverage rule
                        </Button>
                      ) : undefined
                    }
                  />
                </Card>
              ) : (
                <div className="rule-list">
                  {draft.map((rule, index) => (
                    <Card className="rule-card" key={rule.id ?? `new-${index}`}>
                      <div className="rule-card__header">
                        <span className="rule-number">{index + 1}</span>
                        <div>
                          <strong>{rule.label || "Untitled coverage"}</strong>
                          <small>{rule.coverageType || "No coverage key"}</small>
                        </div>
                        <label className="switch-control">
                          <input
                            type="checkbox"
                            checked={rule.required}
                            disabled={!canAdminister}
                            onChange={(event) =>
                              updateRule(index, "required", event.target.checked)
                            }
                          />
                          <span aria-hidden="true" />
                          <em>{rule.required ? "Required" : "Optional"}</em>
                        </label>
                        {canAdminister && (
                          <button
                            type="button"
                            className="rule-delete"
                            onClick={() => removeRule(index)}
                            aria-label={`Remove ${rule.label || "coverage rule"}`}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                      <div className="rule-form-grid">
                        <Field label="Coverage type">
                          <Select
                            value={rule.coverageType}
                            disabled={!canAdminister}
                            onChange={(event) => {
                              const match = coverageOptions.find(
                                ([value]) => value === event.target.value,
                              );
                              updateRule(index, "coverageType", event.target.value);
                              if (
                                match &&
                                (!rule.label ||
                                  coverageOptions.some(([, label]) => label === rule.label))
                              )
                                updateRule(index, "label", match[1]);
                            }}
                          >
                            <option value="">Select coverage</option>
                            {coverageOptions.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                            <option
                              value={
                                rule.coverageType &&
                                !coverageOptions.some(([value]) => value === rule.coverageType)
                                  ? rule.coverageType
                                  : "custom"
                              }
                            >
                              Custom coverage
                            </option>
                          </Select>
                        </Field>
                        <Field label="Display label">
                          <TextInput
                            value={rule.label}
                            disabled={!canAdminister}
                            onChange={(event) => updateRule(index, "label", event.target.value)}
                          />
                        </Field>
                        <Field label="Each occurrence minimum" hint="Whole currency units">
                          <div className="money-input">
                            <span>{rule.currency}</span>
                            <TextInput
                              type="number"
                              min="0"
                              step="1"
                              value={
                                rule.minimumEachOccurrence === null ||
                                rule.minimumEachOccurrence === undefined
                                  ? ""
                                  : rule.minimumEachOccurrence / 100
                              }
                              disabled={!canAdminister}
                              onChange={(event) =>
                                setMoney(index, "minimumEachOccurrence", event.target.value)
                              }
                              placeholder="No minimum"
                            />
                          </div>
                        </Field>
                        <Field label="Aggregate minimum" hint="Whole currency units">
                          <div className="money-input">
                            <span>{rule.currency}</span>
                            <TextInput
                              type="number"
                              min="0"
                              step="1"
                              value={
                                rule.minimumAggregate === null ||
                                rule.minimumAggregate === undefined
                                  ? ""
                                  : rule.minimumAggregate / 100
                              }
                              disabled={!canAdminister}
                              onChange={(event) =>
                                setMoney(index, "minimumAggregate", event.target.value)
                              }
                              placeholder="No minimum"
                            />
                          </div>
                        </Field>
                        <Field label="Currency" hint="v0.1 compares U.S. dollar limits only">
                          <Select value="USD" disabled aria-label="Requirement currency">
                            <option value="USD">USD</option>
                          </Select>
                        </Field>
                        <Field label="Expiration warning" hint="Days before the document date">
                          <div className="suffix-input">
                            <TextInput
                              type="number"
                              min="0"
                              max="365"
                              value={rule.expirationWarningDays}
                              disabled={!canAdminister}
                              onChange={(event) =>
                                updateRule(
                                  index,
                                  "expirationWarningDays",
                                  Number(event.target.value),
                                )
                              }
                            />
                            <span>days</span>
                          </div>
                        </Field>
                        <Field
                          label="Required endorsements"
                          className="rule-form-grid__wide"
                          hint="Comma-separated; each item becomes a separate explainable check"
                        >
                          <TextInput
                            value={rule.requiredEndorsements.join(", ")}
                            disabled={!canAdminister}
                            onChange={(event) =>
                              updateRule(
                                index,
                                "requiredEndorsements",
                                event.target.value
                                  .split(",")
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              )
                            }
                            placeholder="Additional insured, Waiver of subrogation"
                          />
                        </Field>
                        <Field label="Evidence standard" className="rule-form-grid__wide">
                          <Select
                            value={rule.endorsementEvidence}
                            disabled={!canAdminister}
                            onChange={(event) =>
                              updateRule(
                                index,
                                "endorsementEvidence",
                                event.target.value as CoverageRequirement["endorsementEvidence"],
                              )
                            }
                          >
                            <option value="indicated">
                              Certificate box or text indicates endorsement
                            </option>
                            <option value="document">Endorsement document is attached</option>
                            <option value="reviewed_document">
                              Attached endorsement is reviewed by a person
                            </option>
                          </Select>
                        </Field>
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              {canAdminister && (
                <div className="publish-bar">
                  <span>
                    {dirty ? (
                      "You have unpublished changes."
                    ) : (
                      <>
                        <CheckCircle2 size={16} />
                        Published version is up to date.
                      </>
                    )}
                  </span>
                  <div>
                    <Button
                      variant="quiet"
                      disabled={!dirty || saving}
                      onClick={() => setDraft(cloneRequirements(baseline))}
                    >
                      Discard
                    </Button>
                    <Button disabled={!dirty} loading={saving} onClick={publish}>
                      <Save size={16} />
                      Publish as version {selected.version + 1}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        title="Create vendor type"
        description="Group vendors that share one set of contractual insurance requirements."
        footer={
          <>
            <Button variant="quiet" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" form="create-type-form" loading={creating}>
              Create type
            </Button>
          </>
        }
      >
        <form id="create-type-form" className="modal-form" onSubmit={createType}>
          {createError && (
            <div className="form-error" role="alert">
              {createError}
            </div>
          )}
          <Field label="Name">
            <TextInput
              autoFocus
              required
              value={typeName}
              onChange={(event) => setTypeName(event.target.value)}
              placeholder="Field contractors"
            />
          </Field>
          <Field label="Description" hint="Explain when this profile should be assigned.">
            <textarea
              className="input"
              value={typeDescription}
              onChange={(event) => setTypeDescription(event.target.value)}
              placeholder="Vendors performing on-site trade work…"
            />
          </Field>
          <Callout tone="info" title="Starts as a draft">
            Add coverage rules after creation, then publish the first immutable version.
          </Callout>
        </form>
      </Modal>
    </div>
  );
}
