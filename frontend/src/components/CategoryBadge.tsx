import { categoryLabel, type Standard } from "../api";

const CLASS: Record<string, string> = {
  Susceptible: "cat-s",
  Intermediate: "cat-i",
  Resistant: "cat-r",
};

const SHORT: Record<string, string> = { Susceptible: "S", Intermediate: "I", Resistant: "R" };

/** With the standard, I is labelled with its meaning in that standard (see categoryLabel). */
/** compact: the letter only (the full label in the tooltip). */
export default function CategoryBadge({ category, standard, compact }: {
  category: string; standard?: Pick<Standard, "name" | "valid_from"> | null; compact?: boolean;
}) {
  const label = categoryLabel(category, standard);
  return (
    <span className={`badge ${CLASS[category] ?? "cat-na"}`} title={label}>
      <b>{SHORT[category] ?? "–"}</b>{!compact && <> {label}</>}
    </span>
  );
}
