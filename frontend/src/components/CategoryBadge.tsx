const CLASS: Record<string, string> = {
  Susceptible: "cat-s",
  Intermediate: "cat-i",
  Resistant: "cat-r",
};

const SHORT: Record<string, string> = { Susceptible: "S", Intermediate: "I", Resistant: "R" };

export default function CategoryBadge({ category }: { category: string }) {
  return (
    <span className={`badge ${CLASS[category] ?? "cat-na"}`} title={category}>
      <b>{SHORT[category] ?? "–"}</b> {category}
    </span>
  );
}
