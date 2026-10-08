(() => {
  for (const selection of document.querySelectorAll('[data-grade-import-selection]')) {
    const selectAll = selection.querySelector('[data-grade-select-all]');
    const countMessage = selection.querySelector('[data-grade-selection-count]');
    if (!selectAll || !countMessage) continue;

    const controlledTables = (selectAll.getAttribute('aria-controls') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const rows = controlledTables.flatMap((table) =>
      [...table.querySelectorAll('[data-grade-import-row][data-bulk-selectable="true"]')]
    ).filter((row) => !row.disabled);
    selection.hidden = false;
    selectAll.disabled = rows.length === 0;

    const updateSelectionState = () => {
      const selectedCount = rows.filter((row) => row.checked).length;
      selectAll.checked = rows.length > 0 && selectedCount === rows.length;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < rows.length;
      countMessage.textContent = rows.length
        ? `${selectedCount} of ${rows.length} rows selected.`
        : 'No rows are ready for selection.';
    };

    selectAll.addEventListener('change', () => {
      if (selectAll.disabled) return;
      for (const row of rows) row.checked = selectAll.checked;
      updateSelectionState();
    });

    for (const row of rows) row.addEventListener('change', updateSelectionState);
    updateSelectionState();
  }
})();
