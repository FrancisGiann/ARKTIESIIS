'use strict';

const crypto = require('node:crypto');

const REVIEWABLE_PROFILE_FIELDS = Object.freeze([
  ['firstName', 'first_name'], ['middleName', 'middle_name'], ['lastName', 'last_name'], ['suffix', 'suffix'],
  ['birthDate', 'birth_date'], ['sex', 'sex'], ['email', 'email'], ['address', 'address'], ['phone', 'phone'],
  ['birthplace', 'birthplace'], ['facebookName', 'facebook_name'],
  ['addressBlockLotStreetPurok', 'address_block_lot_street_purok'], ['addressBarangay', 'address_barangay'],
  ['addressCity', 'address_city'], ['addressProvince', 'address_province'], ['addressZip', 'address_zip'],
  ['emergencyContactPerson', 'emergency_contact_person'], ['emergencyContactRelationship', 'emergency_contact_relationship'],
  ['emergencyContactPhone', 'emergency_contact_phone'], ['emergencyContactAddress', 'emergency_contact_address'],
  ['emergencyContactAddressBlockLotStreetPurok', 'emergency_contact_address_block_lot_street_purok'],
  ['emergencyContactAddressBarangay', 'emergency_contact_address_barangay'], ['emergencyContactAddressCity', 'emergency_contact_address_city'],
  ['emergencyContactAddressProvince', 'emergency_contact_address_province'], ['emergencyContactAddressZip', 'emergency_contact_address_zip'],
  ['motherName', 'mother_name'], ['motherPhone', 'mother_phone'], ['fatherName', 'father_name'], ['fatherPhone', 'father_phone']
]);

const ADDRESS_REVIEW_COLUMNS = Object.freeze({
  address: Object.freeze(['address', 'address_block_lot_street_purok', 'address_barangay', 'address_city', 'address_province', 'address_zip']),
  emergencyContactAddress: Object.freeze(['emergency_contact_address', 'emergency_contact_address_block_lot_street_purok',
    'emergency_contact_address_barangay', 'emergency_contact_address_city', 'emergency_contact_address_province', 'emergency_contact_address_zip'])
});
const ADDRESS_REVIEW_KEYS = new Set(['address', 'emergencyContactAddress']);
for (const columns of Object.values(ADDRESS_REVIEW_COLUMNS)) {
  for (const [key, column] of REVIEWABLE_PROFILE_FIELDS) {
    if (columns.includes(column)) ADDRESS_REVIEW_KEYS.add(key);
  }
}
const PROFILE_REVIEW_GROUPS = Object.freeze([
  ...REVIEWABLE_PROFILE_FIELDS.filter(([key]) => !ADDRESS_REVIEW_KEYS.has(key))
    .map(([key, column]) => Object.freeze({ key, label: column.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), columns: Object.freeze([column]) })),
  Object.freeze({ key: 'address', label: 'Student address and components', columns: ADDRESS_REVIEW_COLUMNS.address }),
  Object.freeze({ key: 'emergencyContactAddress', label: 'Emergency contact address and components', columns: ADDRESS_REVIEW_COLUMNS.emergencyContactAddress })
]);

function profileReviewFingerprint(row = {}) {
  const snapshot = Object.fromEntries(REVIEWABLE_PROFILE_FIELDS.map(([key, column]) => {
    let value = row[key] ?? row[column] ?? null;
    if (value instanceof Date) value = value.toISOString().slice(0, 10);
    if (value !== null) value = String(value);
    return [key, value];
  }));
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function comparePreEnrollmentProfile(source = {}, student = {}) {
  const columnForInput = new Map(REVIEWABLE_PROFILE_FIELDS.map(([key, column]) => [column, key]));
  const normalize = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value == null ? '' : String(value);
  return PROFILE_REVIEW_GROUPS.map((group) => {
    const display = (row, isSource) => {
      if (group.key !== 'address' && group.key !== 'emergencyContactAddress') {
        const column = group.columns[0];
        const inputKey = columnForInput.get(column);
        const sourceColumn = inputKey === 'phone' ? 'profile_phone' : column;
        return normalize(isSource ? row[sourceColumn] : row[column]);
      }
      const componentColumns = group.columns.slice(1);
      const formatted = normalize(row[group.columns[0]]);
      const componentLabels = ['Block and lot, street/purok', 'Barangay', 'City', 'Province', 'ZIP code'];
      const components = componentColumns.map((column, index) => {
        const value = normalize(row[column]);
        return value ? `${componentLabels[index]}: ${value}` : '';
      }).filter(Boolean);
      const legacy = formatted && !components.length ? `Legacy free-text address: ${formatted}` : formatted;
      return [legacy || '—', components.length ? `Components — ${components.join('; ')}` : 'No structured components'].join('\n');
    };
    const sourceValue = display(source, true);
    const studentValue = display(student, false);
    return { key: group.key, label: group.label, sourceValue, studentValue, differs: sourceValue !== studentValue };
  });
}

module.exports = { REVIEWABLE_PROFILE_FIELDS, PROFILE_REVIEW_GROUPS, profileReviewFingerprint, comparePreEnrollmentProfile };
