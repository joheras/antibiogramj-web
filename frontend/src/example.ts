// "Try it with an example plate": a sample antibiogram that new users can analyse without a photo of their own.
// The image is backend/tests/images/1.tiff (an E. coli plate with 7 disks: TE 30, CTX 5, FOX 30, AMC 20-10, C 30,
// CAZ 10, AMP 10) as a JPEG (quality 85, full resolution: downscaling it changes the detected disks and codes);
// both pipelines find the same disks, codes and zones as with the TIFF.
// It is imported as a module asset so that it is served from assets/ in both the server and the browser builds.
import exampleUrl from "./assets/example-plate.jpg";
import { api, type BacteriaIn } from "./api";
import type { Catalog } from "./session";

export const EXAMPLE_IMAGE_URL = exampleUrl;
export const EXAMPLE_FILENAME = "example-e-coli-plate.jpg";

export async function exampleFile(): Promise<File> {
  const res = await fetch(exampleUrl);
  if (!res.ok) throw new Error(`Cannot load the example image (${res.status})`);
  return new File([await res.blob()], EXAMPLE_FILENAME, { type: "image/jpeg" });
}

export function exampleBacteria(catalog: Catalog): BacteriaIn {
  const family = catalog.families.find((f) => /^Enterobac/i.test(f.name));
  return {
    family_id: family?.id ?? 0, genus: "Escherichia", species: "coli", strain: "", sample: "Example plate",
    comments: "Sample plate bundled with AntibiogramJ.",
  };
}

/** Creates an experiment for the example and returns the route of its "Add plate" wizard. */
export async function startExample(catalog: Catalog): Promise<string> {
  const standard = catalog.standards.find((s) => s.is_default) ?? catalog.standards[0];
  const exp = await api.createExperiment({
    name: "Example: E. coli plate", comments: "Created with \"Try it with an example plate\". Delete it when you no longer need it.",
    standard_id: standard?.id ?? null,
  });
  return `/experiments/${exp.id}/add-plate?example=1`;
}
