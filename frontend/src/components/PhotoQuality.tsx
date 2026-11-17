import { Link } from "react-router-dom";
import type { PhotoQuality } from "../api";

// Texts of the photo quality warnings (codes from backend/app/cv/quality.py and browser/cv.ts::photoQuality).
const WARNINGS: Record<string, { title: (q: PhotoQuality) => string; tip: string }> = {
  blur: {
    title: () => "The photo looks out of focus.",
    tip: "Focus on the agar (tap on a disk), hold the camera steady or use a stand, and avoid digital zoom. The codes printed on the disks must be sharp.",
  },
  glare: {
    title: (q) => `Glare or over-exposed areas on the agar (${(q.metrics.glare_fraction * 100).toFixed(1)} % of the plate).`,
    tip: "Remove the lid and use diffuse light from the sides; move or tilt the lamps so that they are not reflected on the agar.",
  },
  plate_cut: {
    title: () => "The plate is partly outside the photo.",
    tip: "Frame the whole dish, centred, with a small margin around the rim.",
  },
  plate_small: {
    title: (q) => `The plate fills only ${Math.round((q.metrics.plate_fraction ?? 0) * 100)} % of the width of the photo.`,
    tip: "Move the camera closer (not with digital zoom) so the dish fills most of the picture.",
  },
  plate_not_found: {
    title: () => "The plate could not be located in the photo.",
    tip: "Photograph it from right above, centred and filling most of the picture, on a dark uniform background. You can still place the circle by hand.",
  },
  low_resolution: {
    title: (q) => `Low resolution: the plate is about ${q.metrics.plate_diameter_px ?? Math.min(q.metrics.width, q.metrics.height)} px across.`,
    tip: "Upload the original file at the full camera resolution (at least 700 px across the plate, ideally 1500 or more); messaging apps reduce it.",
  },
};

/** Non-blocking warnings about the uploaded photo, with tips and a link to the Help page. */
export default function PhotoQualityNotice({ quality }: { quality: PhotoQuality | undefined }) {
  const known = (quality?.warnings ?? []).filter((w) => WARNINGS[w]);
  if (!quality || !known.length) return null;
  return (
    <div className="warn photo-quality" role="status">
      <b>Photo quality</b>
      <ul>
        {known.map((w) => (
          <li key={w}>{WARNINGS[w].title(quality)} <span className="small">{WARNINGS[w].tip}</span></li>
        ))}
      </ul>
      <span className="small">
        You can continue, but the measurements may be less accurate. See <Link to="/help#photos">how to take good photos</Link>.
      </span>
    </div>
  );
}
