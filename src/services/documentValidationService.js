const { createHash, createHmac } = require('node:crypto');

function normalize(text = '') {
  return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10],
  ['october', 10], ['nov', 11], ['november', 11], ['dec', 12], ['december', 12]
]);

function datePartsToIso(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseVisibleBirthDate(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) {
    return { status: 'not_identified', normalizedDate: null };
  }
  const text = value.trim().replace(/\s+/g, ' ');
  let match = /^(\d{4})([-./])(\d{1,2})\2(\d{1,2})$/.exec(text);
  if (match) {
    const normalizedDate = datePartsToIso(Number(match[1]), Number(match[3]), Number(match[4]));
    return normalizedDate ? { status: 'identified', normalizedDate } : { status: 'uncertain', normalizedDate: null };
  }

  match = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(text);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[3]);
    let day;
    let month;
    if (first > 12 && second <= 12) { day = first; month = second; }
    else if (second > 12 && first <= 12) { month = first; day = second; }
    else if (first === second && first <= 12) { day = first; month = second; }
    else return { status: 'uncertain', normalizedDate: null };
    const normalizedDate = datePartsToIso(Number(match[4]), month, day);
    return normalizedDate ? { status: 'identified', normalizedDate } : { status: 'uncertain', normalizedDate: null };
  }

  const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  match = new RegExp(`^${monthPattern}\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})$`, 'i').exec(text);
  if (match) {
    const normalizedDate = datePartsToIso(Number(match[3]), MONTHS.get(match[1].toLowerCase()), Number(match[2]));
    return normalizedDate ? { status: 'identified', normalizedDate } : { status: 'uncertain', normalizedDate: null };
  }
  match = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}[,]?\\s+(\\d{4})$`, 'i').exec(text);
  if (match) {
    const normalizedDate = datePartsToIso(Number(match[3]), MONTHS.get(match[2].toLowerCase()), Number(match[1]));
    return normalizedDate ? { status: 'identified', normalizedDate } : { status: 'uncertain', normalizedDate: null };
  }
  return { status: 'uncertain', normalizedDate: null };
}

function profileDateOnly(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return datePartsToIso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return match ? datePartsToIso(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function profileValueFingerprint(value, sessionSecret) {
  const normalizedDate = profileDateOnly(value);
  if (typeof sessionSecret !== 'string' || sessionSecret.trim().length < 32) return null;
  return createHmac('sha256', sessionSecret)
    .update(`ARKTIESIIS:document-advisory:birth-date:v1:${normalizedDate ? `date:${normalizedDate}` : 'missing-date'}`)
    .digest('hex');
}

function schoolNameFingerprint(source = {}) {
  const sourceId = typeof source.recordId === 'string' || Number.isSafeInteger(source.recordId)
    ? String(source.recordId).slice(0, 80)
    : 'missing-record';
  const normalizedName = normalize(source.value || '').slice(0, 240);
  return createHash('sha256').update(`${sourceId}|${normalizedName}`).digest('hex');
}

function evaluateBirthDateAdvisory(fields = {}, student = {}, sessionSecret) {
  if (!Object.prototype.hasOwnProperty.call(fields, 'dateOfBirthText')) {
    return {
      extractionStatus: 'not_recorded',
      comparisonStatus: 'unknown',
      comparisonReason: 'not_recorded',
      profileFingerprint: null
    };
  }
  const visibleValue = typeof fields.dateOfBirthText === 'string' ? fields.dateOfBirthText.slice(0, 240) : '';
  const extracted = parseVisibleBirthDate(visibleValue);
  const linkedBirthDate = profileDateOnly(student.birth_date);
  const profileFingerprint = profileValueFingerprint(student.birth_date, sessionSecret);
  const comparisonStatus = extracted.status === 'identified' && linkedBirthDate && profileFingerprint
    ? extracted.normalizedDate === linkedBirthDate ? 'match' : 'mismatch'
    : 'unknown';
  const comparisonReason = comparisonStatus !== 'unknown' ? null
    : extracted.status === 'not_identified' ? 'date_not_identified'
      : extracted.status === 'uncertain' ? 'date_ambiguous_or_invalid'
        : !linkedBirthDate ? 'profile_date_not_recorded' : 'comparison_unavailable';
  return {
    extractionStatus: extracted.status,
    visibleValue,
    comparisonStatus,
    comparisonReason,
    profileFingerprint
  };
}

function normalizeSchoolName(value) {
  return normalize(typeof value === 'string' ? value : '').slice(0, 240);
}

function schoolNameTextIsUncertain(value) {
  return /\b(?:unclear|uncertain|possibly|maybe|perhaps|might be|may be|could be|not sure|unknown|or)\b|[\/;|]/i.test(String(value || ''));
}

function evaluateIssuingSchoolAdvisory(fields = {}, student = {}) {
  const hasSource = Boolean(student.lastSchoolSource && student.lastSchoolSource.recordId);
  const issuingSchoolName = typeof fields.issuingSchoolName === 'string' ? fields.issuingSchoolName.slice(0, 240) : '';
  const recordedSchool = typeof student.lastSchoolSource?.value === 'string'
    ? student.lastSchoolSource.value.slice(0, 200) : '';
  const source = hasSource ? {
    recordId: String(student.lastSchoolSource.recordId).slice(0, 80),
    schoolYear: typeof student.lastSchoolSource.schoolYear === 'string' ? student.lastSchoolSource.schoolYear.slice(0, 20) : null,
    createdAt: student.lastSchoolSource.createdAt instanceof Date && Number.isFinite(student.lastSchoolSource.createdAt.getTime())
      ? student.lastSchoolSource.createdAt.toISOString()
      : typeof student.lastSchoolSource.createdAt === 'string' ? student.lastSchoolSource.createdAt.slice(0, 40) : null,
    updatedAt: student.lastSchoolSource.updatedAt instanceof Date && Number.isFinite(student.lastSchoolSource.updatedAt.getTime())
      ? student.lastSchoolSource.updatedAt.toISOString()
      : typeof student.lastSchoolSource.updatedAt === 'string' ? student.lastSchoolSource.updatedAt.slice(0, 40) : null,
    fingerprint: schoolNameFingerprint(student.lastSchoolSource)
  } : null;
  const issuerText = normalizeSchoolName(issuingSchoolName);
  const savedText = normalizeSchoolName(recordedSchool);
  const issuerIsUncertain = schoolNameTextIsUncertain(issuingSchoolName);
  const savedSchoolIsUncertain = schoolNameTextIsUncertain(recordedSchool);
  const sourceIsComplete = Boolean(source?.schoolYear && /^\d{4}-\d{4}$/.test(source.schoolYear)
    && source.createdAt && source.recordId && savedText);
  return {
    status: issuerText && savedText && sourceIsComplete && !issuerIsUncertain && !savedSchoolIsUncertain
      ? issuerText === savedText ? 'match' : 'mismatch' : 'unknown',
    reason: !issuerText ? 'issuer_school_not_identified'
      : issuerIsUncertain ? 'issuer_school_uncertain'
        : !sourceIsComplete ? 'recorded_last_school_not_available'
          : savedSchoolIsUncertain ? 'recorded_last_school_uncertain' : null,
    issuingSchoolName,
    recordedSchool,
    source
  };
}

function currentComparisonStatus(snapshot, currentFingerprint, defaultStatus, defaultReason) {
  if (!snapshot?.profileFingerprint) return { status: 'unknown', reason: snapshot?.comparisonReason || 'not_recorded' };
  if (snapshot.profileFingerprint !== currentFingerprint) return { status: 'unknown', reason: 'source_changed_since_precheck' };
  const status = new Set(['match', 'mismatch', 'unknown']).has(defaultStatus) ? defaultStatus : 'unknown';
  const reason = new Set([
    'not_recorded', 'source_changed_since_precheck', 'date_not_identified', 'date_ambiguous_or_invalid',
    'profile_date_not_recorded', 'comparison_unavailable'
  ]).has(defaultReason) ? defaultReason : null;
  return { status, reason };
}

function schoolComparisonForCurrentSource(snapshot, currentSource) {
  if (!snapshot?.source?.fingerprint) return { status: 'unknown', reason: 'not_recorded' };
  if (snapshot.source.fingerprint !== schoolNameFingerprint(currentSource)) {
    return { status: 'unknown', reason: 'source_changed_since_precheck' };
  }
  const status = new Set(['match', 'mismatch', 'unknown']).has(snapshot.status) ? snapshot.status : 'unknown';
  const reason = new Set([
    'not_recorded', 'source_changed_since_precheck', 'issuer_school_not_identified', 'issuer_school_uncertain',
    'recorded_last_school_not_available', 'recorded_last_school_uncertain'
  ]).has(snapshot.reason) ? snapshot.reason : null;
  return { status, reason };
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

function evaluateExtractedFields(documentType, fields = {}, student = {}, fileFormatPassed = false, sessionSecret) {
  const boundedText = (value, maximum = 240) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
  const studentName = boundedText(fields.studentName);
  const normalizedFields = { studentName };
  const advisories = {};
  const studentNameMatchesLinkedRecord = studentName
    ? linkedStudentFieldNameFound(studentName, student)
    : false;
  let requiredFieldsPresent = Boolean(studentName) && studentNameMatchesLinkedRecord;

  if (documentType === 'good_moral') {
    const issuingSchoolName = boundedText(fields.issuingSchoolName);
    const goodMoralContextEvidence = boundedText(fields.goodMoralContextEvidence);
    const goodMoralLayoutEvidence = boundedText(fields.goodMoralLayoutEvidence);
    normalizedFields.issuingSchoolName = issuingSchoolName;
    normalizedFields.goodMoralContextEvidence = goodMoralContextEvidence;
    normalizedFields.goodMoralLayoutEvidence = goodMoralLayoutEvidence;
    const evidence = evaluateGoodMoralFields(normalizedFields);
    requiredFieldsPresent = requiredFieldsPresent && Boolean(issuingSchoolName) && evidence.eligible;
    advisories.issuingSchool = evaluateIssuingSchoolAdvisory(normalizedFields, student);
  } else if (documentType === 'psa_birth_certificate') {
    normalizedFields.dateOfBirthText = boundedText(fields.dateOfBirthText);
    advisories.birthDate = evaluateBirthDateAdvisory(normalizedFields, student, sessionSecret);
  }

  return {
    status: 'extracted',
    code: requiredFieldsPresent && fileFormatPassed ? 'precheck_pass' : 'precheck_attention',
    fields: normalizedFields,
    studentNameMatchesLinkedRecord,
    requiredFieldsPresent,
    advisories
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
  currentComparisonStatus,
  evaluateBirthDateAdvisory,
  evaluateIssuingSchoolAdvisory,
  form137AdvisoryChecks,
  parseVisibleBirthDate,
  validateRequiredText,
  linkedStudentNameFound,
  possibleSchoolNameFound,
  findPossibleSchoolNames,
  linkedStudentFieldNameFound,
  profileDateOnly,
  profileValueFingerprint,
  schoolComparisonForCurrentSource,
  schoolNameFingerprint,
  evaluateGoodMoralFields,
  evaluateExtractedFields
};
