import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { MODE } from "../api";
import CategoryBadge from "../components/CategoryBadge";
import { startExample } from "../example";
import { QC_SOURCE, QC_TABLES } from "../qc";
import { useSession } from "../session";
import { Legend } from "./PlatePage";
// Screenshots of the example plate (src/assets/example-plate.jpg) at each step, taken from the browser build.
import step1 from "../assets/help/step1-organism.webp";
import step2 from "../assets/help/step2-preprocessing.webp";
import step3 from "../assets/help/step3-disks.webp";
import step4 from "../assets/help/step4-antibiotics.webp";
import step5 from "../assets/help/step5-zones.webp";
import plateView from "../assets/help/plate-view.webp";
import experimentView from "../assets/help/experiment-view.webp";

const SECTIONS = [
  ["about", "What AntibiogramJ does"],
  ["example", "Try the example plate"],
  ["photos", "Taking good photos"],
  ["workflow", "Step by step"],
  ["results", "Results and export"],
  ["qc", "Quality control"],
  ["standards", "Standards and categories"],
  ["expert", "Expert system"],
  ["data", "Where your data is"],
  ["faq", "FAQ and troubleshooting"],
] as const;

// Results of the example plate with EUCAST 16.1 (see the screenshots).
const EXAMPLE_RESULTS: [string, string, string, string, string][] = [
  ["Tetracycline 30", "TE 30", "6.0", "–", "Not available"],
  ["Cefotaxime 5", "CTX 5", "8.6", "S ≥ 20 / R < 17", "Resistant"],
  ["Amoxicillin-clavulanic acid 20-10", "AMC 20-10", "6.0", "S ≥ 19 / R < 19", "Resistant"],
  ["Cefoxitin 30 (screen only)", "FOX 30", "17.5", "S ≥ 19 / R < 19", "Resistant"],
  ["Chloramphenicol 30", "C 30", "22.1", "–", "Not available"],
  ["Ceftazidime 10", "CAZ 10", "16.5", "S ≥ 22 / R < 19", "Resistant"],
  ["Ampicillin 10", "AMP 10", "6.3", "S ≥ 14 / R < 14", "Resistant"],
];

function Figure({ src, caption, width = 1000, height = 625 }: { src: string; caption: string; width?: number; height?: number }) {
  return (
    <figure className="figure">
      <a href={src} target="_blank" rel="noreferrer" title="Open full size">
        <img src={src} alt={caption} width={width} height={height} loading="lazy" />
      </a>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export default function HelpPage() {
  const { catalog } = useSession();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [error, setError] = useState<string | null>(null);
  const defaultStandard = catalog.standards.find((s) => s.is_default) ?? catalog.standards[0];

  // Scroll to the section in the URL (#/help#photos in the browser build, /help#photos in the server build).
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [hash]);

  const tryExample = () => startExample(catalog).then(navigate).catch((e) => setError((e as Error).message));
  // Links inside the page: a plain href="#id" would change the route of the HashRouter.
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate({ hash: id }, { replace: true });
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/">Experiments</Link> / Help</nav>
      <div className="page-head">
        <h1>How to use AntibiogramJ</h1>
        <div className="actions">
          <button className="primary" onClick={tryExample}>Try it with an example plate</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="help-page">
        <nav className="help-toc" aria-label="Help contents">
          {SECTIONS.map(([id, title]) => <a key={id} href={`#${id}`} onClick={go(id)}>{title}</a>)}
        </nav>

        <div className="help-body">
          <section id="about" className="card">
            <h2>What AntibiogramJ does</h2>
            <p className="lead">
              AntibiogramJ measures the inhibition zones of disk-diffusion antibiograms (Kirby-Bauer) from a photo of the
              Petri dish and interprets them with the breakpoints of EUCAST or CLSI.
            </p>
            <p>From one image it locates the plate and the antibiotic disks, reads the code printed on each disk,
              measures the diameter of every inhibition zone, and assigns the category S, I or R. Several plates of the
              same isolate form an <b>antibiogram</b>, and antibiograms are grouped in <b>experiments</b>, which can be
              exported to Excel.</p>
            <p className="warn">
              <b>Decision support, not a diagnosis.</b> Every automatic step can be wrong: check the disks, the
              antibiotic codes and each zone before saving, and have a qualified microbiologist validate the results.
              AntibiogramJ is a research tool, not a certified medical device (it has no CE-IVD / FDA clearance) and must
              not be the only basis for clinical decisions.
            </p>
          </section>

          <section id="example" className="card">
            <h2>Try the example plate</h2>
            <p>
              No photo at hand? <button className="link" onClick={tryExample}>Try it with an example plate</button>:
              this creates an experiment called <i>Example: E. coli plate</i> ({defaultStandard?.name} {defaultStandard?.version})
              and opens the wizard with the organism and the image already filled in. Press <b>Next</b> at every step and
              compare with the screenshots below. Delete the experiment when you no longer need it.
            </p>
            <p className="muted small">
              The example is an <i>Escherichia coli</i> plate on Mueller-Hinton agar with 7 disks: tetracycline (TE 30),
              cefotaxime (CTX 5), cefoxitin (FOX 30), amoxicillin-clavulanic acid (AMC 20-10), chloramphenicol (C 30),
              ceftazidime (CAZ 10) and ampicillin (AMP 10). The expected result is shown in <a href="#results" onClick={go("results")}>Results</a>.
            </p>
          </section>

          <section id="photos" className="card">
            <h2>Taking good photos</h2>
            <p>The quality of the measurements depends mostly on the photo. A smartphone is enough if you follow these rules:</p>
            <div className="dos">
              <div>
                <h3>Do</h3>
                <ul>
                  <li><b>Remove the lid</b> to avoid reflections and condensation.</li>
                  <li>Put the plate on a <b>dark, matte, non-reflective background</b> (black cardboard or cloth).</li>
                  <li>Use <b>even, diffuse lighting</b>: daylight or two lamps at the sides; no direct flash.</li>
                  <li>Hold the camera <b>parallel to the plate</b>, right above its centre, so the dish looks round, not oval.</li>
                  <li><b>Centre the plate</b> and let it fill most of the picture, with a small margin around the rim.</li>
                  <li>Focus on the agar surface; the codes printed on the disks must be sharp.</li>
                  <li>Use the full resolution of the camera (at least 1500 × 1500 px for the plate). JPEG, PNG and TIFF are accepted.</li>
                </ul>
              </div>
              <div>
                <h3>Avoid</h3>
                <ul>
                  <li>Shadows of the camera or of your hand over the plate.</li>
                  <li>Bright spots or glare on the agar (move the lights or tilt them).</li>
                  <li>Photos taken at an angle, or with digital zoom.</li>
                  <li>Labels or writing covering the inhibition zones.</li>
                  <li>Heavily compressed images (e.g. sent through messaging apps), which can blur the disk codes.</li>
                  <li>Scaling the image down before uploading it: keep the original file.</li>
                </ul>
              </div>
            </div>
            <h3>Automatic photo checks</h3>
            <p>
              Right after the upload, AntibiogramJ checks the photo and shows a warning (you can still continue) when
              it finds one of these problems:
            </p>
            <ul>
              <li><b>Out of focus</b>: the edges of the disks and of their printed codes are not sharp.</li>
              <li><b>Glare</b>: saturated white areas on the agar that are not disks (reflections of the lamps or of the lid).</li>
              <li><b>Plate outside the photo</b>, <b>plate small in the frame</b> or <b>plate not found</b> (located with the same circle detection as the automatic crop).</li>
              <li><b>Low resolution</b>: the plate is less than 700 pixels across.</li>
            </ul>
            <p className="muted small">
              If you get a warning, the easiest fix is usually to take the photo again following the rules above.
            </p>
          </section>

          <section id="workflow" className="card">
            <h2>Step by step</h2>
            <h3>1. Create an experiment</h3>
            <p>On the <Link to="/">Experiments</Link> page press <b>New experiment</b>, give it a name and choose the
              standard ({catalog.standards.map((s) => `${s.name} ${s.version}`).join(", ")}). All the plates of an experiment
              are interpreted with that standard. Then open the experiment and press <b>Add plate</b>, which starts a
              wizard of five steps.</p>

            <h3><span className="step-num">1</span>Organism &amp; image</h3>
            <p>Choose whether the plate belongs to an antibiogram already in the experiment (another plate of the same
              isolate) or to a new one. For a new antibiogram choose the <b>bacteria family / group</b> as named in the
              standard (it selects the breakpoints) and, preferably, the genus and species (the expert system uses them).
              Strain, sample and comments are optional. Then choose or drop the image.</p>
            <Figure src={step1} caption="Step 1 with the example plate: Enterobacteriaceae, Escherichia coli." />

            <h3><span className="step-num">2</span>Pre-processing</h3>
            <p>The Petri dish is located automatically and shown with a cyan circle. Drag the circle to move it and use
              its handle to resize it so that it follows the rim of the dish; everything outside is discarded.
              <b> Automatic selection</b> restores the detected circle, <b>Use the whole image</b> skips the crop.
              Keep <b>Automatic brightness &amp; contrast</b> on unless the image is already well exposed.</p>
            <Figure src={step2} caption="Step 2: the detected plate (cyan circle)." />

            <h3><span className="step-num">3</span>Disks</h3>
            <p>The antibiotic disks are detected and numbered (magenta). Check that there is exactly one circle per disk
              and that it fits the border of the disk: drag to move it, use the handle to resize it, <b>Add disk</b> and
              click on the image for a missing one, select one and press <b>Delete disk</b> (or <kbd>Delete</kbd>) to
              remove a false detection. The <b>disk diameter</b> (6 mm for standard disks) gives the scale used to
              convert pixels to millimetres, so the disk circles must be accurate.</p>
            <Figure src={step3} caption="Step 3: 7 disks detected; scale 19.6 px/mm." />

            <h3><span className="step-num">4</span>Antibiotics</h3>
            <p>The code printed on each disk is read automatically; recognised disks are marked <span className="auto">auto</span>.
              Correct any wrong or empty entry with the dropdown (antibiotics are grouped by class). When you save the
              plate, AntibiogramJ learns the appearance of the confirmed disks, so recognition improves with use.
              The same antibiotic cannot be assigned to two disks.</p>
            <Figure src={step4} caption="Step 4: the 7 codes of the example are recognised automatically." />

            <h3><span className="step-num">5</span>Inhibition zones</h3>
            <p>Each zone is measured automatically. Select an antibiotic in the list or on the image to see its zone
              (yellow) and the breakpoints of the standard as dashed circles: the <span style={{ color: "#2f6fff" }}>blue</span> circle
              is the susceptible limit and the <span style={{ color: "#ff3030" }}>red</span> one the resistant limit.
              If the yellow circle does not follow the edge of the zone, drag its handle or use the slider / number field.
              A zone equal to the disk (6 mm) means there is no inhibition.</p>
            <ul>
              <li><b>Breakpoint</b>: when the standard has several (e.g. meningitis / other indications, iv / oral), choose the right one.</li>
              <li><b>Category</b>: automatic from the diameter, or set manually.</li>
              <li><b>Microcolonies</b> and <b>Interpretation</b>: free notes stored with the measurement.</li>
              <li><b>Mark as checked</b> once you have verified the zone; it jumps to the next unchecked antibiotic.</li>
            </ul>
            <p>Press <b>Save plate</b> when all antibiotics are checked (you are warned otherwise).</p>
            <Figure src={step5} caption="Step 5: the measured zones of the example. Tetracycline and amoxicillin-clavulanic acid show no inhibition (6 mm)." />
            <Legend />
          </section>

          <section id="results" className="card">
            <h2>Results and export</h2>
            <p>After saving, the <b>plate view</b> shows the annotated image (disk, zone and breakpoint circles; the label
              of each disk is its code and category) and the table of measurements. <b>Download image</b> saves the
              annotated picture.</p>
            <Figure src={plateView} caption="Plate view of the example." height={641} />
            <p>The expected result for the example plate with {defaultStandard?.name} {defaultStandard?.version} is:</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Antibiotic</th><th>Code</th><th className="num">Diameter (mm)</th><th>Breakpoints (mm)</th><th>Category</th></tr></thead>
                <tbody>
                  {EXAMPLE_RESULTS.map(([name, code, d, bp, cat]) => (
                    <tr key={code}><td>{name}</td><td>{code}</td><td className="num">{d}</td><td className="muted">{bp}</td>
                      <td><CategoryBadge category={cat} standard={defaultStandard} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Diameters may differ by a few tenths of a millimetre between browsers or versions.
              Tetracycline and chloramphenicol are <i>Not available</i> because EUCAST 16.1 has no zone-diameter
              breakpoints for them in Enterobacterales; create the experiment with EUCAST 6.0 or CLSI 2015 to compare.</p>
            <p>The <b>experiment view</b> lists every antibiogram with its plates and all measurements, the category
              reported after the expert rules, and the expert-system messages. <b>Export to Excel</b> downloads an .xlsx
              workbook with all the measurements of the experiment. <b>Edit</b> changes the organism data of an
              antibiogram; plates, antibiograms and experiments can be deleted.</p>
            <Figure src={experimentView} caption="Experiment view of the example, with the expert-system messages." height={846} />
          </section>

          <section id="qc" className="card">
            <h2>Quality control</h2>
            <p>To check the disks, the medium and the reading, test a <b>EUCAST QC strain</b> (for example <i>E. coli</i>
              ATCC 25922, <i>P. aeruginosa</i> ATCC 27853, <i>S. aureus</i> ATCC 29213 or <i>E. faecalis</i> ATCC 29212)
              and mark its antibiogram as a QC strain: choose it in <b>Quality-control strain</b> in the first step of the
              wizard (the organism data are filled in) or with <b>Edit</b> on an existing antibiogram.</p>
            <p>Every zone diameter of a QC antibiogram is then compared with the QC range and target of that strain:
              the <b>QC range</b> column of the plate and experiment views shows ✓ (in range) or ✗ (out of range), the
              experiment view summarises the results, and the Excel export adds the QC strain, range, target and result.
              Diameters are rounded to the whole millimetre. An out-of-range result means the tests of the day must be
              investigated (disk potency, medium, inoculum, incubation, reading) before reporting patient results.</p>
            <p className="muted small">Ranges and targets: <a href={QC_TABLES.url} target="_blank" rel="noreferrer">{QC_SOURCE}</a>,
              routine QC strains, the β-lactamase-producing strains that control the inhibitor of β-lactam–inhibitor
              combinations and the extended QC strains of resistance mechanisms (zone diameters only). They are the same
              whatever breakpoint standard the experiment uses.</p>
          </section>

          <section id="standards" className="card">
            <h2>Standards and categories</h2>
            <p>Each experiment uses one standard: <b>EUCAST 16.1</b> (2026, the default), <b>EUCAST 6.0</b> (2016) or
              <b> CLSI 2015</b>. The breakpoints depend on the organism group, the antibiotic and sometimes the
              indication; when an antibiotic has no zone breakpoint for the group the category is <i>Not available</i>.</p>
            <dl className="cat-defs">
              <dt><CategoryBadge category="Susceptible" standard={null} /></dt>
              <dd>Susceptible, standard dosing regimen: high likelihood of therapeutic success.</dd>
              <dt><CategoryBadge category="Intermediate" standard={defaultStandard} /></dt>
              <dd>EUCAST (since 2019) <b>Susceptible, increased exposure</b>: success is likely when exposure is increased
                (higher dose or concentration at the site of infection). In EUCAST 6.0 and CLSI it is shown as
                <b> Intermediate</b>: uncertain therapeutic effect.</dd>
              <dt><CategoryBadge category="Resistant" standard={null} /></dt>
              <dd>Resistant: high likelihood of therapeutic failure.</dd>
              <dt><CategoryBadge category="Not available" standard={null} /></dt>
              <dd>No zone-diameter breakpoint in the standard for this organism and antibiotic (MIC may be required).</dd>
            </dl>
            <p>With EUCAST a zone is S when its diameter is ≥ the S breakpoint and R when it is &lt; the R breakpoint; with
              CLSI, S is ≥ S and R is ≤ R. When both EUCAST breakpoints are equal there is no I category.
              The circles on the images use these colours:</p>
            <Legend />
          </section>

          <section id="expert" className="card">
            <h2>Expert system</h2>
            <p>For each antibiogram the expert system checks the results of all its plates against the EUCAST expected
              resistant and susceptible phenotypes, the EUCAST expert rules and the resistance-mechanism screening
              guidelines. It shows messages such as:</p>
            <ul>
              <li><b>Unexpected susceptible / resistant</b>: a result that contradicts the intrinsic phenotype of the species; check the identification and the test.</li>
              <li><b>Resistance mechanism</b>: e.g. a zone below the ESBL or carbapenemase screening cut-off, with the confirmation test to perform.</li>
              <li><b>Inference</b>: categories that can be deduced for agents not tested (e.g. ampicillin R → piperacillin R).</li>
              <li><b>Technical uncertainty</b>: the zone falls in an EUCAST Area of Technical Uncertainty.</li>
            </ul>
            <p>Some rules need the genus and species (use <b>Edit</b> on the antibiogram) or the result of a
              supplementary test (open <b>Supplementary tests</b> and record it). Rules never change the measurements: they
              suggest the category to report, shown in the <b>Reported</b> column with an asterisk. In the example,
              the low cefotaxime and ceftazidime zones trigger the ESBL screening message, and ampicillin R infers
              piperacillin R. The expert rules are decision support and must be reviewed by a microbiologist.</p>
          </section>

          <section id="data" className="card">
            <h2>Where your data is</h2>
            {MODE === "browser" ? (
              <>
                <p>This version runs entirely in your browser: images are analysed on your computer and nothing is
                  uploaded. Experiments, images and learned disk templates are stored in this browser's storage
                  (IndexedDB), only for this browser profile on this computer.</p>
                <ul>
                  <li><b>Back up</b> (Experiments page) saves everything to a .json file. Do it regularly.</li>
                  <li><b>Restore</b> adds the experiments of a backup file; use it to move your data to another computer or browser.</li>
                  <li>Clearing the browsing data / site data, using a private window, or uninstalling the browser deletes
                    the data. Some browsers may also evict storage when the disk is almost full.</li>
                </ul>
              </>
            ) : (
              <p>This version stores your experiments and images on the AntibiogramJ server of your organisation, in
                your account. Sign in with the same account from any computer to see them; ask the administrator about
                backups.</p>
            )}
          </section>

          <section id="faq" className="card faq">
            <h2>FAQ and troubleshooting</h2>
            <details>
              <summary>An antibiotic code is not recognised or is wrong</summary>
              <p>Choose the right antibiotic in step 4. Recognition depends on the codes being sharp and readable: take
                the photo in focus, without glare on the disks. AntibiogramJ learns from the codes you confirm, so
                the same disks are recognised better next time. If your antibiotic or disk content is not in the list,
                it is not in the catalogue of the standards.</p>
            </details>
            <details>
              <summary>A zone is missing, too small or too large</summary>
              <p>Drag the handle of the yellow circle in step 5 or type the diameter. Zones with fuzzy edges, overlapping
                zones, swarming or microcolonies are hard to measure automatically: always check them. Read the edge as
                indicated by the standard (EUCAST: the point of complete inhibition seen by the naked eye).</p>
            </details>
            <details>
              <summary>A disk is missing, or something that is not a disk was detected</summary>
              <p>In step 3 use <b>Add disk</b> and click on the centre of the missing disk, or select the false detection
                and press <b>Delete disk</b>. Make sure every circle fits its disk: the scale (px/mm) is computed from them.</p>
            </details>
            <details>
              <summary>The plate is not found or the crop is wrong</summary>
              <p>Adjust the cyan circle by hand in step 2, or use <b>Use the whole image</b>. A dark background and
                a centred plate make the automatic detection reliable.</p>
            </details>
            <details>
              <summary>My experiments disappeared</summary>
              <p>{MODE === "browser"
                ? "The data lives in the storage of the browser where you created it. Check you are using the same browser, profile and address (not a private window). If the site data was cleared it can only be recovered from a backup file (Restore)."
                : "Check that you are signed in with the same account. Contact the administrator of the server if the data is still missing."}</p>
            </details>
            <details>
              <summary>Which browsers work?</summary>
              <p>Recent versions of Chrome, Edge, Firefox and Safari on a computer (Windows, macOS, Linux). The analysis
                needs WebAssembly, Web Workers and IndexedDB; it also works on tablets and recent phones, but large
                images are slower and editing circles is easier with a mouse.{MODE === "browser" && " The first analysis downloads the image processing engine (about 10 MB), which is then cached."}</p>
            </details>
            <details>
              <summary>Can I use AntibiogramJ for clinical reports?</summary>
              <p>Only as an aid: the measurements and categories must be checked by qualified staff following your
                laboratory's procedures. AntibiogramJ is not a certified medical device.</p>
            </details>
            <details>
              <summary>Is there a Spanish version?</summary>
              <p>Not yet: the interface is in English.</p>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}
