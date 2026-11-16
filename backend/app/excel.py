"""Excel export of an experiment (workspace/utils/ExcelGeneration.java).

A summary sheet with one row per measurement, followed by one sheet per
antibiogram with the same layout as the desktop application.
"""

from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from .models import Experiment

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


def _limit(bp, attr: str):
    return getattr(bp, attr) if bp is not None else None


def experiment_workbook(experiment: Experiment) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Experiment", experiment.name])
    ws.append(["Standard", f"{experiment.standard.name} {experiment.standard.version}"])
    ws.append(["Comments", experiment.comments])
    ws.append([])
    _header(ws, 5, ["Antibiogram", "Family", "Genus", "Species", "Strain", "Sample", "Plate", "Antibiotic",
                    "Code", "Disk content", "Diameter (mm)", "Category", "Microcolonies", "Interpretation",
                    "Breakpoint case", "S limit (mm)", "R limit (mm)"])
    for a in experiment.antibiograms:
        for p in a.plates:
            for m in p.measurements:
                ws.append([a.id, a.family.name, a.genus, a.species, a.strain, a.sample, p.id, m.antibiotic.name,
                           m.antibiotic.code, m.antibiotic.disk_content, m.diameter_mm, m.category,
                           "Yes" if m.microcolonies else "No", m.interpretation,
                           m.breakpoint.case if m.breakpoint else "", _limit(m.breakpoint, "susceptible"),
                           _limit(m.breakpoint, "resistant")])
                fill = _CATEGORY_FILL.get(m.category)
                if fill:
                    ws.cell(row=ws.max_row, column=12).fill = fill
    _autosize(ws)

    for i, a in enumerate(experiment.antibiograms, start=1):
        ws = wb.create_sheet(f"Antibiogram {i}")
        _header(ws, 1, ["Bacteria information", "", "", "Date"])
        ws.cell(row=2, column=4, value=a.created_at.strftime("%Y-%m-%d"))
        for row, (label, value) in enumerate([("Family", a.family.name), ("Species", a.species),
                                              ("Genus", a.genus), ("Strain number", a.strain),
                                              ("Sample", a.sample), ("Comments", a.comments)], start=2):
            ws.cell(row=row, column=1, value=label).font = _BOLD
            ws.cell(row=row, column=2, value=value)
        ws.cell(row=9, column=1, value="Antibiotics").font = _BOLD
        _header(ws, 10, ["Antibiotic name", "Category", "Microcolonies", "Interpretation", "Diameter (mm)", "Plate"])
        for p in a.plates:
            for m in p.measurements:
                ws.append([f"{m.antibiotic.name} {m.antibiotic.disk_content}", m.category,
                           "Yes" if m.microcolonies else "No", m.interpretation, m.diameter_mm, p.id])
                fill = _CATEGORY_FILL.get(m.category)
                if fill:
                    ws.cell(row=ws.max_row, column=2).fill = fill
        _autosize(ws)

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()
