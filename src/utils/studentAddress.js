'use strict';

const ADDRESS_DEFINITIONS = Object.freeze({
  address: [
    ['addressBlockLotStreetPurok', 'address_block_lot_street_purok', 'Block and lot, street/purok', 200],
    ['addressBarangay', 'address_barangay', 'Barangay', 100],
    ['addressCity', 'address_city', 'City', 100],
    ['addressProvince', 'address_province', 'Province', 100],
    ['addressZip', 'address_zip', 'ZIP code', 4]
  ],
  emergencyContactAddress: [
    ['emergencyContactAddressBlockLotStreetPurok', 'emergency_contact_address_block_lot_street_purok', 'Emergency contact block and lot, street/purok', 200],
    ['emergencyContactAddressBarangay', 'emergency_contact_address_barangay', 'Emergency contact barangay', 100],
    ['emergencyContactAddressCity', 'emergency_contact_address_city', 'Emergency contact city', 100],
    ['emergencyContactAddressProvince', 'emergency_contact_address_province', 'Emergency contact province', 100],
    ['emergencyContactAddressZip', 'emergency_contact_address_zip', 'Emergency contact ZIP code', 4]
  ]
});

class StudentAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StudentAddressError';
  }
}

function normalizeStructuredAddress(input = {}, prefix) {
  const fields = ADDRESS_DEFINITIONS[prefix];
  if (!fields) throw new TypeError('An address prefix is required.');
  const values = {};
  for (const [inputName, column, label, maxLength] of fields) {
    const raw = input[inputName];
    if (raw === undefined || raw === null || raw === '') { values[column] = null; continue; }
    if (typeof raw !== 'string') throw new StudentAddressError(`${label} must be text.`);
    const value = raw.trim();
    if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new StudentAddressError(`${label} must be ${maxLength} printable characters or fewer.`);
    }
    if (inputName.endsWith('Zip') && value && !/^\d{4}$/.test(value)) {
      throw new StudentAddressError('ZIP code must be blank or exactly four digits.');
    }
    values[column] = value || null;
  }
  const formatted = fields.map(([, column]) => values[column]).filter(Boolean).join(', ');
  if (formatted && formatted.length > 500) {
    throw new StudentAddressError('The combined formatted address must be 500 characters or fewer. Shorten one or more address components.');
  }
  return { ...values, formatted: formatted || null };
}

function formattedStudentAddress(record = {}, prefix = 'address') {
  const fields = ADDRESS_DEFINITIONS[prefix];
  const components = fields.map(([, column]) => record[column]).filter(Boolean);
  return components.length ? components.join(', ') : record[prefix === 'address' ? 'address' : 'emergency_contact_address'] || '';
}

module.exports = { ADDRESS_DEFINITIONS, StudentAddressError, normalizeStructuredAddress, formattedStudentAddress };
