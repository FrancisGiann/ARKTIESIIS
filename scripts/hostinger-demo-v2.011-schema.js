'use strict';

// These are the tables and views available in the exact baseline + migrations v2.002–v2.011
// supported by the guarded Hostinger demo expansion tools. Keep this version-scoped instead of
// importing check-db's application-wide object list, which includes later forward migrations.
const REQUIRED_OBJECTS = Object.freeze([
  'academic_terms', 'annual_assessments', 'annual_enrollments', 'annual_enrollment_admin_revisions',
  'annual_enrollment_events', 'annual_enrollment_tags', 'annual_registrar_confirmations', 'annual_special_subjects',
  'annual_workflow_events', 'application_locks', 'assessed_charges', 'audit_logs', 'class_schedules', 'documents',
  'document_decision_events', 'document_review_events', 'document_validations', 'enrollments', 'enrollment_clearances',
  'finance_allocation_batches', 'finance_charge_adjustments', 'finance_departure_cases', 'finance_departure_case_terms',
  'finance_exemption_applications', 'finance_exemption_cases', 'finance_exemption_rules', 'finance_fee_comment_events',
  'finance_handbook_number_events', 'finance_legacy_opening_charges', 'finance_legacy_reconciliations',
  'finance_legacy_reconciliation_batches', 'finance_legacy_reconciliation_releases', 'finance_payments',
  'finance_payment_allocations', 'finance_payment_allocation_releases', 'finance_payment_metadata_events',
  'finance_payment_reversals', 'finance_schedules', 'finance_schedule_lines', 'finance_transaction_reversals',
  'financial_accounts', 'financial_transactions', 'form137_status_events', 'grades', 'grade_import_previews',
  'grade_import_preview_grades', 'grade_import_preview_rows', 'password_reset_tokens', 'pending_email_changes',
  'physical_requirement_definitions', 'previous_school_report_card_status_events', 'schema_migrations',
  'school_year_term_order', 'school_year_term_order_reviews', 'sections', 'staff_profiles', 'students',
  'student_document_claim_slips', 'student_document_clearance_events', 'student_document_requests',
  'student_document_request_events', 'student_physical_checklist_events', 'student_profile_revisions',
  'student_subjects', 'subjects', 'teacher_assignments', 'teacher_grade_submissions',
  'teacher_grade_submission_events', 'teacher_grade_submission_grades', 'teacher_grade_submission_rows',
  'term_clearance_events', 'term_finance_approvals', 'two_factor_auth_limits', 'two_factor_codes', 'users',
  'v_document_latest_decision_event', 'v_document_latest_review_event', 'v_document_latest_validation',
  'v_finance_assessed_charge_due', 'v_finance_legacy_account_balance', 'v_finance_net_legacy_reconciliations',
  'v_finance_net_payment_allocations', 'v_finance_opening_liability_due', 'v_finance_payment_credit',
  'v_form137_latest_status_event', 'v_previous_school_report_card_latest_status_event'
]);

module.exports = { REQUIRED_OBJECTS };
