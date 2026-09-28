function normalize(text = '') {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function validateRequiredText(extractedText, requirements = []) {
  const normalized = normalize(extractedText);
  const checks = requirements.map((requirement) => ({
    key: requirement.key,
    label: requirement.label,
    found: requirement.keywords.some((keyword) => normalized.includes(normalize(keyword)))
  }));

  return {
    checks,
    complete: checks.every((item) => item.found)
  };
}

const MAX_NAME_GAP_TOKENS = 2;
const MAX_GEMINI_PRECHECK_ATTEMPTS = 3;
const RETRYABLE_GEMINI_FAILURE_CODES = new Set(['api_error', 'network_error', 'timeout']);

function containsNameSequence(tokens, sequence, start) {
  return sequence.every((token, offset) => tokens[start + offset] === token);
}

function namePartsAppearNear(tokens, firstName, lastName) {
  const orders = [[firstName, lastName], [lastName, firstName]];
  return orders.some(([left, right]) => {
    for (let leftStart = 0; leftStart <= tokens.length - left.length; leftStart += 1) {
      if (!containsNameSequence(tokens, left, leftStart)) continue;
      const rightStart = leftStart + left.length;
      const lastRightStart = Math.min(tokens.length - right.length, rightStart + MAX_NAME_GAP_TOKENS);
      for (let index = rightStart; index <= lastRightStart; index += 1) {
        if (containsNameSequence(tokens, right, index)) return true;
      }
    }
    return false;
  });
}

function linkedStudentNameFound(extractedText, student = {}) {
  const firstName = normalize(student.first_name).split(' ').filter(Boolean);
  const lastName = normalize(student.last_name).split(' ').filter(Boolean);
  if (!firstName.length || !lastName.length
    || firstName.join('').length < 2 || lastName.join('').length < 2) return false;

  return String(extractedText ?? '').split(/\r?\n/).some((line) => {
    const tokens = normalize(line).split(' ').filter(Boolean);
    return namePartsAppearNear(tokens, firstName, lastName);
  });
}

function possibleSchoolNameFound(extractedText) {
  return findPossibleSchoolNames(extractedText).length > 0;
}

function candidateLines(extractedText, predicate) {
  return String(extractedText).split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && predicate(line))
    .slice(0, 3)
    .map((line) => line.slice(0, 200));
}

function findPossibleSchoolNames(extractedText) {
  return candidateLines(extractedText, (line) => /\b(?:school|academy|college|university|institute|educational|education|learning center)\b/i.test(line));
}

function advisoryChecks(documentType, extractedText, student) {
  if (!['good_moral', 'psa_birth_certificate', 'report_card'].includes(documentType)) return [];
  const checks = [{
    key: 'linked_student_name',
    label: 'Possible linked student-name match',
    found: linkedStudentNameFound(extractedText, student)
  }];

  if (documentType === 'good_moral') {
    checks.push({ key: 'possible_school_name', label: 'Possible school name', found: possibleSchoolNameFound(extractedText), candidates: findPossibleSchoolNames(extractedText) });
  }

  return checks;
}

function form137AdvisoryChecks(extractedText, student) {
  const possibleSchoolNames = findPossibleSchoolNames(extractedText);
  return [
    {
      key: 'linked_student_name',
      label: 'Possible linked student-name match',
      found: linkedStudentNameFound(extractedText, student)
    },
    {
      key: 'possible_school_name',
      label: 'Possible school name',
      found: possibleSchoolNames.length > 0,
      candidates: possibleSchoolNames
    }
  ];
}

function canRetryGeminiPrecheck({
  documentType,
  isLegacyArchive = null,
  documentStatus,
  validationSummary,
  precheckAttemptCount,
  hasFinalDecision = false
} = {}) {
  const attempts = Number(precheckAttemptCount);
  const gemini = validationSummary?.gemini;
  const retryableDocumentType = ['good_moral', 'psa_birth_certificate'].includes(documentType)
    || (documentType === 'report_card' && (isLegacyArchive === false || isLegacyArchive === 0));
  return retryableDocumentType
    && documentStatus === 'needs_review'
    && !hasFinalDecision
    && Number.isSafeInteger(attempts)
    && attempts >= 1
    && attempts < MAX_GEMINI_PRECHECK_ATTEMPTS
    && validationSummary?.stage === 'gemini_precheck'
    && validationSummary?.precheckVersion === 2
    && validationSummary?.outcome === 'gemini_unavailable'
    && validationSummary?.fileFormatPassed === true
    && gemini?.status === 'unavailable'
    && RETRYABLE_GEMINI_FAILURE_CODES.has(gemini.code);
}

module.exports = {
  MAX_GEMINI_PRECHECK_ATTEMPTS,
  advisoryChecks,
  canRetryGeminiPrecheck,
  form137AdvisoryChecks,
  validateRequiredText,
  linkedStudentNameFound,
  possibleSchoolNameFound,
  findPossibleSchoolNames
};
