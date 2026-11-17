"""Excel export of an experiment (workspace/utils/ExcelGeneration.java).

The web interface builds its export in the browser (frontend/src/excel.ts) so that it includes the expert
system; this endpoint keeps the plain export for API clients.

A summary sheet with one row per measurement, followed by one sheet per
antibiogram with the same layout as the desktop application.
"""

from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from . import qc
from .models import Experiment
from .standards import family_label

_BOLD = Font(bold=True)
_HEADER_FILL = PatternFill("solid", fgColor="DDE6F0")
_CATEGORY_FILL = {
    "Susceptible": PatternFill("solid", fgColor="D9F2D9"),
    "Intermediate": PatternFill("solid", fgColor="FFF2CC"),
    "Resistant": PatternFill("solid", fgColor="F8D7DA"),
}


def _header(ws, row: int, values: list[str]) -> None:
    for col, value in enumerate(values, start=1):
        cell = ws.cell(row=row, column=col, value=value)
        cell.font, cell.fill = _BOLD, _HEADER_FILL


def _autosize(ws) -> None:
    for col in ws.columns:
        width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
        ws.column_dimensions[get_column_letter(col[0].column)].width = min(60, width + 2)


def _category(category: str, standard) -> str:
    """Since 2019 EUCAST defines I as "Susceptible, increased exposure" (stored as "Intermediate")."""
    increased = (standard.name.upper() == "EUCAST" and standard.valid_from is not None
                 and standard.valid_from.isoformat() >= "2019-01-01")
    return "Susceptible, increased exposure" if category == "Intermediate" and increased else category


def _limit(bp, attr: str):
    return getattr(bp, attr) if bp is not None else None


_QC_FILL = {"in": PatternFill("solid", fgColor="D9F2D9"), "low": PatternFill("solid", fgColor="F8D7DA"),
            "high": PatternFill("solid", fgColor="F8D7DA")}


def _qc_cells(strain: dict | None, m) -> tuple[list, str | None]:
    """QC strain, range, target and result of a measurement (empty when not a QC strain), and the status."""
    if strain is None:
        return ["", "", "", ""], None
    r, status = qc.result(strain, m.antibiotic.name, m.antibiotic.disk_content, m.diameter_mm)
    target = (r.get("target") or r.get("expected_category", "")) if r else ""
    return [strain["id"], qc.range_label(r) if r else "", target, qc.STATUS_LABEL[status]], status


def experiment_workbook(experiment: Experiment) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Experiment", experiment.name])
    ws.append(["Standard", f"{experiment.standard.name} {experiment.standard.version}"])
    ws.append(["Comments", experiment.comments])
    any_qc = any(qc.strain(a.qc_strain) for a in experiment.antibiograms)
    ws.append(["QC ranges", qc.source() if any_qc else "No QC strains in this experiment"])
    ws.append(["Reinterpretation of", experiment.reinterpreted_from or ""])
    _header(ws, 6, ["Antibiogram", "Family", "Genus", "Species", "Strain", "Sample", "Plate", "Antibiotic",
                    "Code", "Disk content", "Diameter (mm)", "Category", "Microcolonies", "Interpretation",
                    "Breakpoint case", "S limit (mm)", "R limit (mm)", "QC strain", "QC range (mm)", "QC target",
                    "QC result", "Standard", "Original standard", "Original category"])
    for a in experiment.antibiograms:
        strain = qc.strain(a.qc_strain)
        for p in a.plates:
            for m in p.measurements:
                qc_cells, status = _qc_cells(strain, m)
                original = m.original_standard
                ws.append([a.id, family_label(a.family.name, experiment.standard), a.genus, a.species, a.strain,
                           a.sample, p.id, m.antibiotic.name,
                           m.antibiotic.code, m.antibiotic.disk_content, m.diameter_mm,
                           _category(m.category, experiment.standard),
                           "Yes" if m.microcolonies else "No", m.interpretation,
                           m.breakpoint.case if m.breakpoint else "", _limit(m.breakpoint, "susceptible"),
                           _limit(m.breakpoint, "resistant"), *qc_cells, f"{m.standard.name} {m.standard.version}",
                           f"{original.name} {original.version}" if original else "",
                           (_category(m.original_category, original)
                            + (" (set manually)" if m.original_overridden else "")) if original else ""])
                fill = _CATEGORY_FILL.get(m.category)
                if fill:
                    ws.cell(row=ws.max_row, column=12).fill = fill
                if status in _QC_FILL:
                    ws.cell(row=ws.max_row, column=21).fill = _QC_FILL[status]
    _autosize(ws)

    for i, a in enumerate(experiment.antibiograms, start=1):
        strain = qc.strain(a.qc_strain)
        ws = wb.create_sheet(f"Antibiogram {i}")
        _header(ws, 1, ["Bacteria information", "", "", "Date"])
        ws.cell(row=2, column=4, value=a.created_at.strftime("%Y-%m-%d"))
        for row, (label, value) in enumerate([("Family", family_label(a.family.name, experiment.standard)), ("Species", a.species),
                                              ("Genus", a.genus), ("Strain number", a.strain),
                                              ("Sample", a.sample), ("Comments", a.comments)], start=2):
            ws.cell(row=row, column=1, value=label).font = _BOLD
            ws.cell(row=row, column=2, value=value)
        if strain:
            ws.cell(row=8, column=1, value="QC strain").font = _BOLD
            ws.cell(row=8, column=2, value=f"{strain['name']} ({qc.source()})")
        ws.cell(row=9, column=1, value="Antibiotics").font = _BOLD
        _header(ws, 10, ["Antibiotic name", "Category", "Microcolonies", "Interpretation", "Diameter (mm)", "Plate",
                         *(["QC range (mm)", "QC target", "QC result"] if strain else [])])
        for p in a.plates:
            for m in p.measurements:
                qc_cells, status = _qc_cells(strain, m)
                ws.append([f"{m.antibiotic.name} {m.antibiotic.disk_content}", _category(m.category, experiment.standard),
                           "Yes" if m.microcolonies else "No", m.interpretation, m.diameter_mm, p.id,
                           *(qc_cells[1:] if strain else [])])
                fill = _CATEGORY_FILL.get(m.category)
                if fill:
                    ws.cell(row=ws.max_row, column=2).fill = fill
                if status in _QC_FILL:
                    ws.cell(row=ws.max_row, column=9).fill = _QC_FILL[status]
        _autosize(ws)

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()
