# ARKTIESIIS Demo Visual Guide

Open [`index.html`](index.html) in a browser for the offline interactive guide. It opens on the new-student enrollment flow. Use the workflow buttons to switch diagrams, then select a numbered node, use Previous/Next step, or click a node to highlight its presenter line. “What to click” expands the corresponding screen details.

Open a process directly with a query such as `index.html?process=payments`. Use **Print all diagrams** to print or save all ten landscape pages. Individual chart PNGs are in [`charts/`](charts/); [`demo-visual-guide.pdf`](demo-visual-guide.pdf) contains one diagram per page, and [`demo-visual-guide-bundle.zip`](demo-visual-guide-bundle.zip) includes the guide, charts, and PDF.

The page uses inline HTML, CSS, JavaScript, and SVG, so it needs no network connection or installed application packages. For an optional local static preview, run `python3 -m http.server 8000 --directory docs/demo-visuals` from the repository root and open `http://127.0.0.1:8000/`. To regenerate the PDF, use the browser's print dialog with landscape layout and backgrounds enabled. The exported charts are programmatic screenshots of the same SVG diagrams shown in the guide.

Use synthetic student records and documents when presenting. These diagrams describe the current thesis prototype and do not establish school policy or live service behavior.
