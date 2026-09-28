function formatGradeLevel(value) {
  const grade = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!grade) return '';
  return /^grade\b/i.test(grade) ? grade : `Grade ${grade}`;
}

function formatStudentPlacement(gradeLevel, sectionName) {
  const section = typeof sectionName === 'string' ? sectionName.trim() : '';
  const grade = typeof gradeLevel === 'string' || typeof gradeLevel === 'number' ? String(gradeLevel).trim() : '';
  const gradeNumber = grade.replace(/^grade\b\s*/i, '').trim();
  const gradeLabel = formatGradeLevel(grade);

  if (!section) return gradeLabel;

  let sectionLabel = section;
  if (gradeNumber) {
    const escapedGrade = gradeNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repeatedGrade = new RegExp(`^grade\\s*${escapedGrade}(?:\\b|\\s|$)\\s*`, 'i');
    sectionLabel = section.replace(repeatedGrade, '').trim();
    if (!sectionLabel && section.toLowerCase() === gradeLabel.toLowerCase()) sectionLabel = '';
    if (!sectionLabel && section !== gradeLabel) sectionLabel = section;
  }

  return [gradeLabel, sectionLabel].filter(Boolean).join(' · ');
}

module.exports = { formatGradeLevel, formatStudentPlacement };
