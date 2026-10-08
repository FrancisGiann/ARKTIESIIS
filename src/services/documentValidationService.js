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

// Field extraction should contain one person's name, so unlike the full-page
// advisory matcher this accepts only a compact name and one surname-first comma.
function linkedStudentFieldNameFound(extractedName, student = {}) {
  if (typeof extractedName !== 'string' || extractedName.length > 240
    || /[;|/\\&\n\r]|\b(?:and|or)\b/i.test(extractedName)) return false;

  const firstName = normalize(student.first_name).split(' ').filter(Boolean);
  const lastName = normalize(student.last_name).split(' ').filter(Boolean);
  if (!firstName.length || !lastName.length
    || firstName.join('').length < 2 || lastName.join('').length < 2) return false;

  const commaCount = (extractedName.match(/,/g) || []).length;
  if (commaCount > 1 || /^\s*,|,\s*$|,\s*,/.test(extractedName)) return false;
  if (commaCount === 1) {
    const [surname, given] = extractedName.split(',');
    const surnameTokens = normalize(surname).split(' ').filter(Boolean);
    const givenTokens = normalize(given).split(' ').filter(Boolean);
    const extraGivenTokens = givenTokens.length - firstName.length;
    return surnameTokens.join(' ') === lastName.join(' ')
      && extraGivenTokens >= 0 && extraGivenTokens <= 2
      && containsNameSequence(givenTokens, firstName, 0);
  }

  const tokens = normalize(extractedName).split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 8) return false;
  return namePartsAppearNear(tokens, firstName, lastName);
}

function hasUncertainGoodMoralEvidence(text) {
  if (/\b(?:unclear|uncertain|possibly|maybe|perhaps|might be|may be|could be|appears to be|seems to be|cannot determine|cannot tell|not sure whether|not clear whether)\b/i.test(text)) return true;
  const negativeClaim = /\b(?:not|never|no)\s+(?:(?:a|an)\s+)?(?:(?:person|individual)\s+)?(?:of\s+)?(?:good moral(?: character)?|good character|good conduct)(?: certificate)?\b/i;
  const negativeTitle = /\b(?:not|never|no)\b.{0,35}\b(?:good moral(?: character)? certificate|good character certificate|moral character certificate|certificate of (?:good moral(?: character)?|moral character|good character)|good conduct certificate|character certificate)\b/i;
  const negatedPredicate = /\b(?:does|did|has|have|had)\s+not\s+(?:have|maintain|possess|demonstrate|show|meet|exhibit|uphold|qualify as)\b.{0,35}\b(?:good moral character|good character|good conduct)\b/i;
  return String(text).split(/[.!?;]+/).some((sentence) =>
    negativeClaim.test(sentence) || negativeTitle.test(sentence) || negatedPredicate.test(sentence));
}

function goodMoralContextEvidencePasses(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240
    || hasUncertainGoodMoralEvidence(value)) return false;
  const text = normalize(value);
  const affirmativeTitle = /^(?:good moral(?: character)? certificate|good character certificate|moral character certificate|certificate of (?:good moral(?: character)?|moral character|good character)|good conduct certificate|character certificate)$/.test(text);
  const affirmativeStatement = /\b(?:this certifies|certifies that|we certify that|i certify that|this certificate certifies)\b.{0,90}\b(?:good moral character|good character|good conduct|no derogatory record|not been involved in misconduct)\b/.test(text)
    || /\b(?:is|are)\s+(?:a person\s+)?of (?:good moral character|good character)\b/.test(text)
    || /\b(?:has|maintains|possesses|demonstrates|exhibits)\s+(?:a )?(?:good moral character|good character)\b/.test(text)
    || /\bhas\s+(?:maintained|demonstrated|exhibited|shown|possessed)\s+(?:a )?(?:good moral character|good character|good conduct)\b/.test(text)
    || /\b(?:has|maintains|demonstrates)\s+good conduct\b/.test(text)
    || /\bhas no derogatory record\b/.test(text)
    || /\bhas not been involved in (?:any )?misconduct\b/.test(text);
  return affirmativeTitle || affirmativeStatement;
}

function goodMoralLayoutEvidencePasses(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240
    || hasUncertainGoodMoralEvidence(value)) return false;
  const layoutClueMissing = String(value).split(/[.!?;]+/).some((sentence) =>
    /\b(?:no|not|without|missing|absent|unreadable|cannot see)\b.{0,45}\b(?:certificate|title|heading|header|student details|statement|body wording)\b/i.test(sentence)
    || /\b(?:certificate|title|heading|header|student details|statement|body wording)\b.{0,35}\b(?:not visible|not present|not shown|missing|absent|unreadable)\b/i.test(sentence));
  if (layoutClueMissing) return false;
  const text = normalize(value);
  const describesTitleOrStatement = /\b(?:title|heading|header|statement|body wording)\b/.test(text);
  const describesCertificateContent = /\b(?:certificate|certification|certifies)\b/.test(text)
    && /\b(?:student|name|recipient|details|date|issued|body|statement|wording)\b/.test(text);
  return describesTitleOrStatement && describesCertificateContent;
}

function evaluateGoodMoralFields(fields = {}) {
  const contextEvidencePassed = goodMoralContextEvidencePasses(fields.goodMoralContextEvidence);
  const layoutEvidencePassed = goodMoralLayoutEvidencePasses(fields.goodMoralLayoutEvidence);
  return {
    eligible: Boolean(contextEvidencePassed && layoutEvidencePassed),
    contextEvidencePassed,
    layoutEvidencePassed
  };
}

function evaluateExtractedFields(documentType, fields = {}, student = {}, fileFormatPassed = false) {
  const studentName = typeof fields.studentName === 'string' ? fields.studentName.slice(0, 240) : '';
  const normalizedFields = { studentName };
  const studentNameMatchesLinkedRecord = studentName
    ? linkedStudentFieldNameFound(studentName, student)
    : false;
  let requiredFieldsPresent = Boolean(studentName) && studentNameMatchesLinkedRecord;

  if (documentType === 'good_moral') {
    const issuingSchoolName = typeof fields.issuingSchoolName === 'string' ? fields.issuingSchoolName.slice(0, 240) : '';
    const goodMoralContextEvidence = typeof fields.goodMoralContextEvidence === 'string'
      ? fields.goodMoralContextEvidence.slice(0, 240) : '';
    const goodMoralLayoutEvidence = typeof fields.goodMoralLayoutEvidence === 'string'
      ? fields.goodMoralLayoutEvidence.slice(0, 240) : '';
    normalizedFields.issuingSchoolName = issuingSchoolName;
    normalizedFields.goodMoralContextEvidence = goodMoralContextEvidence;
    normalizedFields.goodMoralLayoutEvidence = goodMoralLayoutEvidence;
    const evidence = evaluateGoodMoralFields(normalizedFields);
    requiredFieldsPresent = requiredFieldsPresent && Boolean(issuingSchoolName) && evidence.eligible;
  }

  return {
    status: 'extracted',
    code: requiredFieldsPresent && fileFormatPassed ? 'precheck_pass' : 'precheck_attention',
    fields: normalizedFields,
    studentNameMatchesLinkedRecord,
    requiredFieldsPresent
  };
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
  findPossibleSchoolNames,
  linkedStudentFieldNameFound,
  evaluateGoodMoralFields,
  evaluateExtractedFields
};
