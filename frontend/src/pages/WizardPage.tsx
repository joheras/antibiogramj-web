import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  api, bacteriaLabel, categorise, CATEGORIES, categoryLabel, familyLabel, type BacteriaIn, type Breakpoint, type Circle,
  type ExperimentDetail, type UploadResult,
} from "../api";
import CategoryBadge from "../components/CategoryBadge";
import { exampleBacteria, exampleFile } from "../example";
import { genusSuggestions, speciesSuggestions } from "../expertRules";
import { useImageUrl } from "../components/AsyncImage";
import ImageEditor, { type EditorCircle } from "../components/ImageEditor";
import PhotoQualityNotice from "../components/PhotoQuality";
import { QcCell, QcStrainSelect } from "../components/Qc";
import { qcFamily, qcResult, qcStrain, QC_SOURCE } from "../qc";
import { onProgress } from "../progress";
import { useSession } from "../session";
import { Legend } from "./PlatePage";

const STEPS = ["Organism & image", "Pre-processing", "Disks", "Antibiotics", "Inhibition zones"];
const COLORS = { disk: "#ff00ff", halo: "#ffd400", s: "#2f6fff", r: "#ff3030", crop: "#00e0ff" };

interface Disk extends Circle { id: string }
interface Reading {
  halo_r: number;
  breakpoints: Breakpoint[];
  breakpoint_id: number | null;
  categoryOverride: string | null;
  microcolonies: boolean;
  interpretation: string;
  checked: boolean;
}

let nextId = 0;
const newId = () => `d${++nextId}`;

export default function WizardPage() {
  const experimentId = Number(useParams().id);
  const navigate = useNavigate();
  const { catalog } = useSession();
  const isExample = useSearchParams()[0].get("example") === "1";

  const [exp, setExp] = useState<ExperimentDetail | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 0
  const [target, setTarget] = useState<"new" | number>("new");
  const [bacteria, setBacteria] = useState<BacteriaIn>({ family_id: 0, genus: "", species: "", strain: "", sample: "", comments: "", qc_strain: "" });
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  // Step 1
  const [crop, setCrop] = useState<Circle | null>(null);
  const [autoContrast, setAutoContrast] = useState(true);
  const [working, setWorking] = useState<{ width: number; height: number; version: number } | null>(null);
  // Step 2
  const [disks, setDisks] = useState<Disk[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [diskMm, setDiskMm] = useState(6);
  // Step 3
  const [antibioticIds, setAntibioticIds] = useState<(number | null)[]>([]);
  const [autoIds, setAutoIds] = useState<(number | null)[]>([]);
  // Step 4
  const [readings, setReadings] = useState<Reading[]>([]);
  const [pxPerMm, setPxPerMm] = useState(1);

  useEffect(() => {
    api.experiment(experimentId).then((e) => {
      setExp(e);
      if (e.antibiograms.length) setTarget(e.antibiograms[e.antibiograms.length - 1].id);
    }).catch((e) => setError(e.message));
  }, [experimentId]);

  // "Try it with an example plate": fill in the organism and load the bundled image.
  const loadExample = () => {
    setTarget("new");
    setBacteria(exampleBacteria(catalog));
    exampleFile().then(setFile).catch((e) => setError(e.message));
  };
  useEffect(() => { if (isExample) loadExample(); }, [isExample]); // eslint-disable-line react-hooks/exhaustive-deps

  const familyId = target === "new" ? bacteria.family_id : exp?.antibiograms.find((a) => a.id === target)?.family.id ?? 0;

  async function run(message: string, fn: () => Promise<void>) {
    setBusy(message);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------ transitions
  const toPreprocessing = () => run("Uploading image and locating the plate…", async () => {
    if (!file) throw new Error("Choose an image of the plate");
    if (target === "new" && !bacteria.family_id) throw new Error("Choose the bacteria family");
    const up = await api.upload(file);
    setUpload(up);
    setCrop(up.plate);
    setStep(1);
  });

  const toDisks = () => run("Pre-processing and detecting antibiotic disks…", async () => {
    const res = await api.process(upload!.upload_id, crop, autoContrast);
    setWorking((w) => ({ ...res, version: (w?.version ?? 0) + 1 }));
    const found = await api.detectDisks(upload!.upload_id);
    setDisks(found.disks.map((d) => ({ ...d, id: newId() })));
    setSelected(null);
    setStep(2);
  });

  const toAntibiotics = () => run("Reading the antibiotic codes…", async () => {
    if (!disks.length) throw new Error("Add at least one disk");
    const res = await api.identify(upload!.upload_id, disks);
    const ids = res.results.map((r) => r.antibiotic_id);
    // Keep the user's previous choices when coming back to this step.
    setAntibioticIds(ids.map((id, i) => (antibioticIds.length === disks.length && antibioticIds[i] !== null ? antibioticIds[i] : id)));
    setAutoIds(ids);
    setStep(3);
  });

  const toHalos = () => run("Measuring inhibition zones…", async () => {
    if (antibioticIds.some((x) => x === null)) throw new Error("Choose the antibiotic of every disk");
    const ids = antibioticIds as number[];
    if (new Set(ids).size !== ids.length) throw new Error("The same antibiotic is assigned to several disks");
    const res = await api.halos(upload!.upload_id, {
      disks, antibiotic_ids: ids, family_id: familyId, standard_id: exp!.standard.id, disk_mm: diskMm,
    });
    setPxPerMm(res.px_per_mm);
    setReadings(res.results.map((r) => ({
      halo_r: r.halo_r, breakpoints: r.breakpoints, breakpoint_id: r.breakpoint_id, categoryOverride: null,
      microcolonies: false, interpretation: "", checked: false,
    })));
    setSelected(disks[0]?.id ?? null);
    setStep(4);
  });

  const save = () => run("Saving the plate…", async () => {
    const unchecked = readings.filter((r) => !r.checked).length;
    if (unchecked && !confirm(`${unchecked} antibiotic(s) have not been checked. Save anyway?`)) return;
    const plate = await api.savePlate({
      upload_id: upload!.upload_id,
      antibiogram_id: target === "new" ? null : target,
      experiment_id: target === "new" ? experimentId : null,
      bacteria: target === "new" ? bacteria : null,
      disk_mm: diskMm,
      measurements: disks.map((d, i) => ({
        antibiotic_id: antibioticIds[i]!, breakpoint_id: readings[i].breakpoint_id,
        disk: { cx: d.cx, cy: d.cy, r: d.r }, halo_r: readings[i].halo_r,
        category: readings[i].categoryOverride, microcolonies: readings[i].microcolonies,
        interpretation: readings[i].interpretation,
      })),
    });
    navigate(`/plates/${plate.id}`);
  });

  const originalSrc = useImageUrl(upload ? () => api.uploadImage(upload.upload_id, "original") : null, [upload?.upload_id]);
  const workingSrc = useImageUrl(upload && working ? () => api.uploadImage(upload.upload_id, "working", working.version) : null,
    [upload?.upload_id, working?.version]) ?? "";

  const selectedIndex = disks.findIndex((d) => d.id === selected);

  if (!exp) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</div>;


  return (
    <div className="page wizard">
      <nav className="crumbs"><Link to="/">Experiments</Link> / <Link to={`/experiments/${exp.id}`}>{exp.name}</Link> / Add plate</nav>
      <ol className="stepper">
        {STEPS.map((s, i) => <li key={s} className={i === step ? "current" : i < step ? "done" : ""}><span>{i + 1}</span>{s}</li>)}
      </ol>
      <p className="stepper-compact" aria-hidden>Step {step + 1}/{STEPS.length} · <b>{STEPS[step]}</b></p>
      {isExample && (
        <p className="note">
          <b>Example plate.</b> The organism and the image are already filled in: press <b>Next</b> at every step and
          compare with the worked example in <Link to="/help#example">Help</Link>.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {busy && <Busy message={busy} />}

      {step === 0 && (
        <StepOrganism
          exp={exp} target={target} setTarget={setTarget} bacteria={bacteria} setBacteria={setBacteria}
          file={file} setFile={setFile} onNext={toPreprocessing} onExample={loadExample} busy={!!busy}
        />
      )}

      {step === 1 && upload && (
        <div className="step-layout">
          <ImageEditor
            src={originalSrc ?? ""} width={upload.width} height={upload.height}
            circles={crop ? [{ id: "crop", ...crop, color: COLORS.crop, edit: "both" }] : []}
            selectedId="crop" onChange={(_, c) => setCrop(c)}
          />
          <aside className="panel">
            <h2>Pre-processing</h2>
            <PhotoQualityNotice quality={upload.quality} />
            <p className="help">Adjust the circle to the Petri dish: drag it to move it and use the handle to resize it. The image is cropped to the circle.</p>
            <div className="btn-col">
              <button onClick={() => setCrop(upload.plate)} disabled={!upload.plate}>Automatic selection</button>
              <button onClick={() => setCrop({ cx: upload.width / 2, cy: upload.height / 2, r: Math.min(upload.width, upload.height) / 2 })}>Centred circle</button>
              <button onClick={() => setCrop(null)}>Use the whole image</button>
            </div>
            {!upload.plate && <p className="muted small">The plate could not be located automatically.</p>}
            <label className="check"><input type="checkbox" checked={autoContrast} onChange={(e) => setAutoContrast(e.target.checked)} /> Automatic brightness &amp; contrast</label>
            <Nav onBack={() => setStep(0)} onNext={toDisks} busy={!!busy} />
          </aside>
        </div>
      )}

      {step === 2 && working && (
        <div className="step-layout">
          <ImageEditor
            src={workingSrc} width={working.width} height={working.height}
            circles={disks.map((d, i) => ({ ...d, color: COLORS.disk, edit: "both", label: String(i + 1) }))}
            selectedId={selected} onSelect={setSelected}
            onChange={(id, c) => setDisks((ds) => ds.map((d) => (d.id === id ? { ...d, ...c } : d)))}
            cursor={addMode ? "crosshair" : undefined}
            onBackgroundClick={addMode ? (x, y) => {
              const r = disks.length ? median(disks.map((d) => d.r)) : Math.min(working.width, working.height) * 0.04;
              const d = { id: newId(), cx: x, cy: y, r };
              setDisks((ds) => [...ds, d]);
              setSelected(d.id);
              setAddMode(false);
            } : undefined}
          />
          <aside className="panel" onKeyDown={(e) => {
            if ((e.key === "Delete" || e.key === "Backspace") && selected && (e.target as HTMLElement).tagName !== "INPUT") {
              setDisks((ds) => ds.filter((d) => d.id !== selected));
              setSelected(null);
            }
          }} tabIndex={-1}>
            <h2>Antibiotic disks</h2>
            <p className="help">{disks.length} disk(s) detected. Check that every disk is marked and fits its border: drag to move, use the handle to resize. Pinch or use + to zoom in.</p>
            <div className="btn-row">
              <button className={addMode ? "primary" : ""} onClick={() => setAddMode(!addMode)}>{addMode ? "Tap the image…" : "Add disk"}</button>
              <button disabled={!selected} onClick={() => { setDisks((ds) => ds.filter((d) => d.id !== selected)); setSelected(null); }}>Delete disk</button>
            </div>
            <button className="link" onClick={() => run("Detecting antibiotic disks…", async () => {
              const found = await api.detectDisks(upload!.upload_id);
              setDisks(found.disks.map((d) => ({ ...d, id: newId() })));
            })}>Detect again</button>
            <h3>Scale</h3>
            <label>Disk diameter (mm)
              <input type="number" min={1} max={50} step={0.5} value={diskMm} onChange={(e) => setDiskMm(Number(e.target.value) || 6)} />
            </label>
            {disks.length > 0 && <p className="muted small">Mean disk diameter {(2 * mean(disks.map((d) => d.r))).toFixed(1)} px → {(2 * mean(disks.map((d) => d.r)) / diskMm).toFixed(2)} px/mm</p>}
            <Nav onBack={() => setStep(1)} onNext={toAntibiotics} busy={!!busy}>
              <span className="nav-info">{disks.length} disk{disks.length === 1 ? "" : "s"}</span>
            </Nav>
          </aside>
        </div>
      )}

      {step === 3 && working && (
        <div className="step-layout">
          <ImageEditor
            src={workingSrc} width={working.width} height={working.height}
            circles={disks.map((d, i) => ({
              ...d, color: COLORS.disk, label: `${i + 1}${antibioticIds[i] !== null ? " " + catalog.antibioticById.get(antibioticIds[i]!)?.code : ""}`,
            }))}
            selectedId={selected} onSelect={setSelected}
          />
          <aside className="panel">
            <h2>Antibiotics</h2>
            <p className="help">The codes printed on the disks are read automatically. Correct any mistake: AntibiogramJ learns from your confirmed choices.</p>
            <div className="ab-list">
              {disks.map((d, i) => (
                <div key={d.id} className={`ab-row ${selected === d.id ? "sel" : ""}`} onClick={() => setSelected(d.id)}>
                  <span className="num-badge">{i + 1}</span>
                  <AntibioticSelect value={antibioticIds[i]} onChange={(v) => setAntibioticIds((xs) => xs.map((x, j) => (j === i ? v : x)))} />
                  {autoIds[i] !== null && autoIds[i] === antibioticIds[i] && <span className="auto" title="Recognised automatically">auto</span>}
                </div>
              ))}
            </div>
            <Nav onBack={() => setStep(2)} onNext={toHalos} busy={!!busy}>
              {selectedIndex >= 0 && (
                <span className="nav-info"><span className="num-badge">{selectedIndex + 1}</span>
                  {antibioticIds[selectedIndex] !== null ? catalog.antibioticById.get(antibioticIds[selectedIndex]!)?.name : "—"}</span>
              )}
            </Nav>
          </aside>
        </div>
      )}

      {step === 4 && working && (
        <HaloStep
          src={workingSrc} width={working.width} height={working.height} disks={disks} antibioticIds={antibioticIds as number[]}
          readings={readings} setReadings={setReadings} pxPerMm={pxPerMm} diskMm={diskMm} exp={exp} target={target} qcId={bacteria.qc_strain}
          selected={selected} setSelected={setSelected} onBack={() => setStep(3)} onSave={save} busy={!!busy}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ step 0
function StepOrganism({ exp, target, setTarget, bacteria, setBacteria, file, setFile, onNext, onExample, busy }: {
  exp: ExperimentDetail; target: "new" | number; setTarget: (t: "new" | number) => void;
  bacteria: BacteriaIn; setBacteria: (b: BacteriaIn) => void; file: File | null; setFile: (f: File | null) => void;
  onNext: () => void; onExample: () => void; busy: boolean;
}) {
  const { catalog } = useSession();
  const set = (k: keyof BacteriaIn) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setBacteria({ ...bacteria, [k]: k === "family_id" ? Number(e.target.value) : e.target.value });
  const preview = useMemo(() => (file && !/\.tiff?$/i.test(file.name) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const distinct = (k: "genus" | "species") => [...new Set(exp.antibiograms.map((a) => a[k]).filter(Boolean))];

  return (
    <div className="card step0">
      <section>
        <h2>Organism</h2>
        {exp.antibiograms.length > 0 && (
          <div className="radio-col">
            {exp.antibiograms.map((a) => (
              <label key={a.id} className="check">
                <input type="radio" checked={target === a.id} onChange={() => setTarget(a.id)} />
                Add to antibiogram: <b>{bacteriaLabel(a)}</b> {a.qc_strain && <span className="tag">QC</span>} <span className="muted">({familyLabel(a.family.name, exp.standard)}, {a.plates.length} plate{a.plates.length === 1 ? "" : "s"})</span>
              </label>
            ))}
            <label className="check"><input type="radio" checked={target === "new"} onChange={() => setTarget("new")} /> New antibiogram (new organism)</label>
          </div>
        )}
        {target === "new" && (
          <div className="form-grid">
            <label className="span2">Quality-control strain
              <QcStrainSelect value={bacteria.qc_strain} onChange={(id) => {
                const s = qcStrain(id);
                setBacteria(s
                  ? { ...bacteria, qc_strain: id, genus: s.genus, species: s.species, strain: s.id,
                      family_id: qcFamily(s, catalog.families)?.id ?? bacteria.family_id }
                  : { ...bacteria, qc_strain: "" });
              }} />
              <span className="muted small">Mark the plate of a EUCAST QC strain to compare its zones with the QC ranges ({QC_SOURCE}).</span>
            </label>
            <label className="span2">Bacteria family / group (as in the standard)
              <select required value={bacteria.family_id || ""} onChange={set("family_id")}>
                <option value="" disabled>Choose…</option>
                {catalog.families.map((f) => <option key={f.id} value={f.id}>{familyLabel(f.name, exp.standard)}</option>)}
              </select>
            </label>
            <label>Genus<input list="genus-list" value={bacteria.genus} onChange={set("genus")} maxLength={100} /></label>
            <label>Species<input list="species-list" value={bacteria.species} onChange={set("species")} maxLength={100} /></label>
            <label>Strain<input value={bacteria.strain} onChange={set("strain")} maxLength={100} /></label>
            <label>Sample<input value={bacteria.sample} onChange={set("sample")} maxLength={100} /></label>
            <label className="span2">Comments<textarea value={bacteria.comments} onChange={set("comments")} maxLength={1000} /></label>
            <datalist id="genus-list">{genusSuggestions(distinct("genus")).map((g) => <option key={g} value={g} />)}</datalist>
            <datalist id="species-list">{speciesSuggestions(bacteria.genus, distinct("species")).map((g) => <option key={g} value={g} />)}</datalist>
          </div>
        )}
      </section>
      <section>
        <h2>Plate image</h2>
        <label className="dropzone">
          <input type="file" accept="image/*,.tif,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {preview ? <img src={preview} alt="" /> : <span>{file ? file.name : "Choose or drop an image (JPEG, PNG, TIFF…)"}</span>}
        </label>
        <div className="photo-buttons">
          {/* On phones and tablets, opens the rear camera directly. */}
          <label className="button primary camera-button">
            <input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            📷 Take photo
          </label>
          <label className="button">
            <input type="file" accept="image/*,.tif,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            Choose file
          </label>
        </div>
        <p className="muted small">
          No photo at hand? <button className="link" onClick={onExample}>Use the example plate</button> (E. coli, 7 disks).
          See <Link to="/help#photos">how to take good photos</Link>.
        </p>
        <div className="nav"><span className="nav-info">{file ? file.name : ""}</span><button className="primary" onClick={onNext} disabled={busy}>Next</button></div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ step 3
function AntibioticSelect({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { catalog } = useSession();
  const groups = useMemo(() => {
    const m = new Map<string, typeof catalog.antibiotics>();
    for (const a of catalog.antibiotics) m.set(a.drug_class, [...(m.get(a.drug_class) ?? []), a]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalog.antibiotics]);
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">— choose antibiotic —</option>
      {groups.map(([cls, abs]) => (
        <optgroup key={cls} label={cls}>
          {abs.map((a) => <option key={a.id} value={a.id}>{a.name} {a.disk_content}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ step 4
function HaloStep({ src, width, height, disks, antibioticIds, readings, setReadings, pxPerMm, diskMm, exp, target, qcId, selected, setSelected, onBack, onSave, busy }: {
  src: string; width: number; height: number; disks: Disk[]; antibioticIds: number[]; readings: Reading[];
  setReadings: React.Dispatch<React.SetStateAction<Reading[]>>; pxPerMm: number; diskMm: number; exp: ExperimentDetail;
  target: "new" | number; qcId: string; selected: string | null; setSelected: (id: string | null) => void; onBack: () => void; onSave: () => void; busy: boolean;
}) {
  const { catalog } = useSession();
  const qc = qcStrain(target === "new" ? qcId : exp.antibiograms.find((a) => a.id === target)?.qc_strain);
  const idx = Math.max(0, disks.findIndex((d) => d.id === selected));
  const reading = readings[idx];
  const disk = disks[idx];
  const diam = (r: Reading) => Math.round((20 * r.halo_r) / pxPerMm) / 10;
  const bp = (r: Reading) => r.breakpoints.find((b) => b.id === r.breakpoint_id) ?? null;
  const category = (r: Reading) => r.categoryOverride ?? categorise(diam(r), bp(r), exp.standard);
  const update = (patch: Partial<Reading>) => setReadings((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const setDiameter = (mm: number) => update({ halo_r: Math.max(disk.r, (Math.round(mm * 10) / 10 * pxPerMm) / 2) });

  const circles: EditorCircle[] = [];
  disks.forEach((d, i) => {
    const r = readings[i];
    const isSel = i === idx;
    if (isSel) {
      const b = bp(r);
      if (b?.resistant) circles.push({ id: "R", cx: d.cx, cy: d.cy, r: (b.resistant * pxPerMm) / 2, color: COLORS.r, dashed: true });
      if (b?.susceptible) circles.push({ id: "S", cx: d.cx, cy: d.cy, r: (b.susceptible * pxPerMm) / 2, color: COLORS.s, dashed: true });
    }
    circles.push({ id: `h${d.id}`, cx: d.cx, cy: d.cy, r: r.halo_r, color: COLORS.halo, edit: isSel ? "resize" : "none" });
    circles.push({
      id: d.id, cx: d.cx, cy: d.cy, r: d.r, color: r.checked ? "#2ecc71" : COLORS.disk,
      label: `${r.checked ? "✓ " : ""}${catalog.antibioticById.get(antibioticIds[i])?.code ?? ""}`,
      fill: "rgba(255,255,255,0.01)",
    });
  });

  const b = bp(reading);
  const maxMm = Math.max(50, Math.ceil(diam(reading) + 5));

  return (
    <div className="step-layout">
      <div>
        <ImageEditor
          src={src} width={width} height={height} circles={circles} selectedId={disk.id}
          onSelect={(id) => {
            if (!id) return;
            const d = disks.find((x) => x.id === id || `h${x.id}` === id);
            if (d) setSelected(d.id);
          }}
          onChange={(id, c) => { if (id === `h${disk.id}`) update({ halo_r: Math.max(disk.r, c.r) }); }}
        />
        <Legend />
      </div>
      <aside className="panel">
        <h2>Inhibition zones</h2>
        <div className="halo-list">
          {disks.map((d, i) => (
            <button key={d.id} className={`halo-item ${i === idx ? "sel" : ""}`} onClick={() => setSelected(d.id)}>
              <span className="check-mark">{readings[i].checked ? "✓" : ""}</span>
              <span className="grow">{catalog.antibioticById.get(antibioticIds[i])?.name}</span>
              <span className="num">{diam(readings[i]).toFixed(1)}</span>
              {qc && (() => {
                const s = qcResult(qc, { antibiotic: catalog.antibioticById.get(antibioticIds[i])!, diameter_mm: diam(readings[i]) }).status;
                return s === "low" || s === "high" ? <span className="qc qc-low" title="Out of the QC range">QC ✗</span> : null;
              })()}
              <CategoryBadge category={category(readings[i])} standard={exp.standard} compact />
            </button>
          ))}
        </div>

        <div className="detail">
          <h3>{catalog.antibioticById.get(antibioticIds[idx])?.name} {catalog.antibioticById.get(antibioticIds[idx])?.disk_content}</h3>
          {reading.breakpoints.length > 1 && (
            <label>Breakpoint
              <select value={reading.breakpoint_id ?? ""} onChange={(e) => update({ breakpoint_id: Number(e.target.value) })}>
                {reading.breakpoints.map((x) => <option key={x.id} value={x.id}>{x.case || "General"}{x.available ? ` (S ${exp.standard.susceptible_op} ${x.susceptible}, R ${exp.standard.resistant_op} ${x.resistant})` : " (not available)"}</option>)}
              </select>
            </label>
          )}
          <p className="limits">
            {b?.available && b.susceptible !== null
              ? <>Susceptible <b>{exp.standard.susceptible_op} {b.susceptible} mm</b> · Resistant <b>{exp.standard.resistant_op} {b.resistant} mm</b>{b.case && <span className="muted"> · {b.case}</span>}</>
              : <span className="muted">No zone-diameter breakpoint in {exp.standard.name} {exp.standard.version} for this organism.</span>}
          </p>
          {b?.comments && <details><summary>Breakpoint notes</summary><p className="small">{b.comments}</p></details>}
          {qc && (
            <p className="limits">QC range ({qc.id}):{" "}
              <QcCell strain={qc} measurement={{ antibiotic: catalog.antibioticById.get(antibioticIds[idx])!, diameter_mm: diam(reading) }} />
            </p>
          )}

          <label>Inhibition zone diameter (mm)
            <div className="slider-row">
              <button type="button" className="step-btn" aria-label="0.5 mm smaller" onClick={() => setDiameter(diam(reading) - 0.5)}>−</button>
              <input type="range" min={Math.min(diskMm, diam(reading))} max={maxMm} step={0.1} value={diam(reading)}
                onChange={(e) => update({ halo_r: (Number(e.target.value) * pxPerMm) / 2 })} />
              <button type="button" className="step-btn" aria-label="0.5 mm larger" onClick={() => setDiameter(diam(reading) + 0.5)}>+</button>
              <input type="number" min={diskMm} max={150} step={0.1} value={diam(reading)}
                onChange={(e) => setDiameter(Number(e.target.value))} />
            </div>
          </label>
          <label>Category
            <select value={reading.categoryOverride ?? ""} onChange={(e) => update({ categoryOverride: e.target.value || null })}>
              <option value="">Automatic: {categoryLabel(categorise(diam(reading), b, exp.standard), exp.standard)}</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c, exp.standard)} (manual)</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={reading.microcolonies} onChange={(e) => update({ microcolonies: e.target.checked })} /> Microcolonies</label>
          <label>Interpretation<textarea maxLength={1000} value={reading.interpretation} onChange={(e) => update({ interpretation: e.target.value })} /></label>
          <button className="primary" onClick={() => {
            update({ checked: true });
            const next = readings.findIndex((r, i) => i !== idx && !r.checked);
            if (next >= 0) setSelected(disks[next].id);
          }}>{reading.checked ? "Checked ✓" : "Mark as checked"}</button>
        </div>

        <div className="nav">
          <button onClick={onBack} disabled={busy}>Back</button>
          <span className="nav-info">
            <span className="nav-wide muted small">{readings.filter((r) => r.checked).length}/{readings.length} checked</span>
            <span className="nav-narrow">
              <b>{catalog.antibioticById.get(antibioticIds[idx])?.code}</b> {diam(reading).toFixed(1)} mm{" "}
              <CategoryBadge category={category(reading)} standard={exp.standard} compact />
            </span>
          </span>
          <button className="primary" onClick={onSave} disabled={busy}>Save plate</button>
        </div>
      </aside>
    </div>
  );
}

/** Back / Next; on phones it is a bar fixed at the bottom of the screen. */
function Nav({ onBack, onNext, busy, children }: { onBack: () => void; onNext: () => void; busy: boolean; children?: React.ReactNode }) {
  return (
    <div className="nav">
      <button onClick={onBack} disabled={busy}>Back</button>
      {children ?? <span />}
      <button className="primary" onClick={onNext} disabled={busy}>Next</button>
    </div>
  );
}

/** Overlay shown while computing, with the progress reported by the analysis. */
function Busy({ message }: { message: string }) {
  const [detail, setDetail] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const off = onProgress(setDetail);
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500);
    return () => { off(); clearInterval(timer); };
  }, [message]);
  return (
    <div className="busy" role="status" aria-live="polite">
      <div className="spinner" />
      <span>{message}</span>
      {(detail || seconds >= 2) && <span className="busy-detail">{detail}{seconds >= 2 ? ` (${seconds} s)` : ""}</span>}
    </div>
  );
}

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
