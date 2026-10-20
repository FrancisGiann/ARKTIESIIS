'use strict';

const { sql, getPool, closePool } = require('../src/config/database');
const env = require('../src/config/environment');

const REQUIRED_OBJECTS = Object.freeze([
  'schema_migrations', 'application_locks', 'users', 'staff_profiles', 'students', 'academic_terms', 'sections',
  'enrollments', 'subjects', 'student_subjects', 'grades', 'financial_accounts', 'financial_transactions',
  'documents', 'document_validations', 'two_factor_codes', 'audit_logs', 'two_factor_auth_limits',
  'document_review_events', 'document_decision_events', 'form137_status_events', 'grade_import_previews',
  'grade_import_preview_rows', 'grade_import_preview_grades', 'teacher_assignments', 'teacher_grade_submissions',
  'teacher_grade_submission_rows', 'teacher_grade_submission_grades', 'teacher_grade_submission_events',
  'password_reset_tokens', 'pending_email_changes', 'enrollment_clearances', 'class_schedules',
  'previous_school_report_card_status_events', 'annual_enrollments', 'annual_enrollment_events', 'finance_schedules',
  'finance_schedule_lines', 'annual_assessments', 'assessed_charges', 'finance_charge_adjustments', 'finance_payments',
  'finance_allocation_batches', 'finance_payment_allocations', 'finance_legacy_reconciliation_batches',
  'finance_legacy_reconciliations', 'finance_payment_reversals', 'term_finance_approvals', 'term_clearance_events',
  'student_physical_checklist_events', 'physical_requirement_definitions', 'finance_transaction_reversals',
  'school_year_term_order', 'school_year_term_order_reviews', 'annual_workflow_events', 'annual_enrollment_tags',
  'annual_special_subjects', 'finance_exemption_cases', 'finance_exemption_rules', 'finance_exemption_applications',
  'finance_departure_cases', 'finance_departure_case_terms', 'finance_payment_metadata_events',
  'finance_legacy_opening_charges', 'finance_payment_allocation_releases', 'finance_legacy_reconciliation_releases',
  'v_finance_net_payment_allocations', 'v_finance_net_legacy_reconciliations', 'v_finance_payment_credit',
  'v_finance_assessed_charge_due', 'v_finance_opening_liability_due', 'v_finance_legacy_account_balance',
  'student_document_requests', 'student_document_request_events', 'student_profile_revisions',
  'annual_registrar_confirmations', 'annual_finance_assessment_reviews', 'annual_enrollment_admin_revisions', 'finance_fee_comment_events',
  'finance_handbook_number_events', 'student_document_clearance_events', 'student_document_claim_slips',
  'finance_review_drafts',
  'v_document_latest_review_event', 'v_document_latest_decision_event',
  'v_document_latest_validation', 'v_form137_latest_status_event', 'v_previous_school_report_card_latest_status_event',
  'pre_enrollments', 'pre_enrollment_receipts', 'pre_enrollment_events', 'pre_enrollment_revisions',
  'readmission_evaluations', 'readmission_evaluation_events', 'annual_continuity_source_events',
  'term_clearance_templates', 'term_clearance_template_items', 'student_term_clearances',
  'student_term_clearance_items', 'student_term_clearance_events', 'annual_term_finalizations',
  'finance_departure_cutoff_reviews', 'finance_departure_charge_reviews',
  'registrar_retake_referrals', 'registrar_retake_item_keys', 'registrar_retake_referral_items',
  'finance_retake_item_decisions', 'registrar_retake_referral_events', 'finance_departure_application_events'
]);

const REQUIRED_COLUMNS = Object.freeze({
  users: ['auth_session_version', 'must_change_password'],
  students: ['birthplace', 'emergency_contact_person', 'debt_increase_revision', 'address_block_lot_street_purok',
    'address_barangay', 'address_city', 'address_province', 'address_zip', 'emergency_contact_address_block_lot_street_purok',
    'emergency_contact_address_barangay', 'emergency_contact_address_city',
    'emergency_contact_address_province', 'emergency_contact_address_zip'],
  documents: ['is_legacy_archive'],
  enrollments: ['finalized_at', 'annual_enrollment_id', 'term_scope_status'],
  annual_enrollments: ['esc_id', 'eform_status', 'finance_handbook_number', 'pre_enrollment_id', 'intake_kind',
    'readmission_evaluation_id', 'readmission_evaluation_version', 'continuity_source_annual_enrollment_id'],
  annual_registrar_confirmations: ['input_fingerprint', 'clearance_snapshot_fingerprint', 'finance_review_id', 'entry_dp_state_at_confirmation'],
  annual_finance_assessment_reviews: ['annual_enrollment_id', 'assessment_id', 'schedule_id', 'schedule_version', 'voucher_code_snapshot',
    'current_voucher_code_snapshot', 'voucher_review_event_id', 'selection_json', 'assessment_fingerprint', 'dependency_fingerprint',
    'zero_dp_attested', 'reviewed_by', 'reviewed_by_role', 'reviewed_at', 'idempotency_key', 'request_fingerprint'],
  annual_enrollment_events: ['annual_enrollment_id', 'finance_assessment_id'],
  previous_school_report_card_status_events: ['status'],
  finance_payment_allocations: ['legacy_opening_charge_id'],
  assessed_charges: ['gross_amount', 'waived_amount'],
  student_document_requests: ['expected_claim_date', 'handover_reference', 'current_claim_slip_id'],
  student_document_request_events: ['handover_reference_before', 'handover_reference_after', 'handover_reference'],
  pre_enrollments: ['id', 'school_year', 'status', 'version', 'created_by', 'created_by_role', 'updated_by', 'applicant_kind', 'email',
    'birth_date', 'readmission_evaluation_id', 'readmission_evaluation_version'],
  pre_enrollment_receipts: ['pre_enrollment_id', 'requirement_code', 'original_received', 'original_pieces', 'photocopy_received', 'photocopy_pieces'],
  pre_enrollment_events: ['pre_enrollment_id', 'actor_id', 'event_type', 'version'],
  pre_enrollment_revisions: ['pre_enrollment_id', 'actor_id', 'field_name', 'before_value', 'after_value'],
  readmission_evaluations: ['applicant_lrn', 'student_id', 'school_year', 'target_grade_level', 'curriculum_review_status', 'status', 'version'],
  readmission_evaluation_events: ['evaluation_id', 'actor_id', 'event_type', 'evaluation_version'],
  annual_continuity_source_events: ['annual_enrollment_id', 'source_annual_enrollment_id', 'student_id', 'actor_id', 'reason', 'idempotency_key'],
  term_clearance_templates: ['grade_level', 'track_label', 'version_no', 'status', 'created_by'],
  term_clearance_template_items: ['template_id', 'category', 'label', 'sort_order'],
  student_term_clearances: ['enrollment_id', 'annual_enrollment_id', 'student_id', 'template_id', 'recording_mode', 'scope_status', 'scope_reason', 'inspected_on', 'attested_by', 'attested_at', 'version'],
  student_term_clearance_items: ['clearance_id', 'category', 'label_snapshot', 'teacher_context_status', 'applicability_status', 'signature_present', 'signer_name'],
  student_term_clearance_events: ['clearance_id', 'actor_id', 'event_type', 'before_json', 'after_json', 'idempotency_key'],
  annual_term_finalizations: ['enrollment_id', 'student_id', 'idempotency_key', 'input_fingerprint', 'clearance_snapshot_fingerprint', 'result_json', 'finalized_by'],
  finance_departure_cutoff_reviews: ['departure_case_id', 'effective_enrollment_id', 'effective_term_number',
    'last_payable_installment', 'review_reason', 'reviewed_by', 'reviewed_by_role', 'idempotency_key', 'request_fingerprint'],
  finance_departure_cases: ['application_status', 'application_review_reason', 'student_id_at_recording',
    'school_year_at_recording', 'grade_level_at_recording', 'entry_term_number_at_recording', 'intake_kind_at_recording',
    'pre_enrollment_id_at_recording', 'readmission_evaluation_id_at_recording', 'readmission_evaluation_version_at_recording',
    'continuity_source_annual_enrollment_id_at_recording', 'application_updated_at'],
  finance_departure_case_terms: ['enrollment_status_at_recording', 'student_id_at_recording',
    'annual_enrollment_id_at_recording', 'academic_term_id_at_recording', 'annual_term_number_at_recording',
    'school_year_at_recording', 'term_scope_status_at_recording', 'enrollment_status_at_application',
    'academic_activity_review_required_at_application', 'applied_at'],
  finance_departure_application_events: ['departure_case_id', 'event_type', 'source', 'actor_id', 'actor_role', 'details_json', 'created_at'],
  finance_departure_charge_reviews: ['cutoff_review_id', 'departure_case_id', 'charge_id', 'enrollment_id', 'term_number',
    'fee_category_snapshot', 'line_name_snapshot', 'installment_snapshot', 'review_category', 'decision',
    'payable_before_amount', 'proposed_reduction_amount', 'reviewed_reduction_amount', 'payable_after_amount', 'review_reason'],
  registrar_retake_referrals: ['annual_enrollment_id', 'revision_no', 'intake_kind_snapshot', 'evaluation_reference',
    'readmission_evaluation_id', 'readmission_evaluation_version', 'status', 'is_current', 'idempotency_key', 'created_by', 'finalized_by'],
  registrar_retake_item_keys: ['annual_enrollment_id', 'idempotency_key'],
  registrar_retake_referral_items: ['referral_id', 'annual_enrollment_id', 'item_key_id', 'subject_name', 'subject_id',
    'target_term_number', 'finance_explanation'],
  finance_retake_item_decisions: ['item_key_id', 'referral_item_id', 'decision', 'approved_amount', 'charge_description',
    'decision_reason', 'charge_id', 'reviewed_by', 'reviewed_by_role', 'idempotency_key', 'request_fingerprint', 'superseded_at'],
  registrar_retake_referral_events: ['referral_id', 'actor_id', 'event_type', 'details_json']
});
const REQUIRED_CONSTRAINTS = Object.freeze([
  { tableName: 'previous_school_report_card_status_events', constraintName: 'CK_previous_school_report_card_status_status', type: 'CHECK' },
  { tableName: 'users', constraintName: 'CK_users_role', type: 'CHECK', clauseIncludes: "'front_desk'" },
  { tableName: 'students', constraintName: 'CK_student_address_zip', type: 'CHECK', clauseIncludes: 'address_zip' },
  { tableName: 'students', constraintName: 'CK_student_emergency_address_zip', type: 'CHECK', clauseIncludes: 'emergency_contact_address_zip' },
  { tableName: 'readmission_evaluations', constraintName: 'CK_readmission_evaluation_status', type: 'CHECK', clauseIncludes: 'not_accepted' },
  { tableName: 'readmission_evaluations', constraintName: 'CK_readmission_evaluation_curriculum_status', type: 'CHECK', clauseIncludes: 'resolved' },
  { tableName: 'term_clearance_templates', constraintName: 'CK_term_clearance_template_confirmations', type: 'CHECK', clauseIncludes: 'laboratory_rows_confirmed' },
  { tableName: 'student_term_clearances', constraintName: 'CK_student_term_clearance_scope_reason', type: 'CHECK', clauseIncludes: 'not_attended' },
  { tableName: 'student_term_clearances', constraintName: 'CK_student_term_clearance_recording_mode', type: 'CHECK', clauseIncludes: 'paper_confirmation' },
  { tableName: 'student_term_clearances', constraintName: 'CK_student_term_clearance_attestation', type: 'CHECK', clauseIncludes: 'paper_confirmation' },
  { tableName: 'student_term_clearance_items', constraintName: 'CK_student_term_clearance_item_teacher_subject', type: 'CHECK', clauseIncludes: 'subject_name_snapshot' },
  { tableName: 'student_term_clearance_items', constraintName: 'CK_student_term_clearance_item_exclusion', type: 'CHECK', clauseIncludes: 'applicability_reason' },
  { tableName: 'annual_continuity_source_events', constraintName: 'CK_annual_continuity_source_event_reason', type: 'CHECK', clauseIncludes: 'reason' },
  { tableName: 'pre_enrollments', constraintName: 'CK_pre_enrollment_created_by_role', type: 'CHECK', clauseIncludes: 'front_desk' },
  { tableName: 'annual_enrollments', constraintName: 'CK_annual_enrollment_intake_kind', type: 'CHECK', clauseIncludes: 'readmission' },
  { tableName: 'annual_registrar_confirmations', constraintName: 'CK_annual_registrar_confirmation_entry_dp_state', type: 'CHECK', clauseIncludes: 'zero_due' },
  { tableName: 'finance_departure_cutoff_reviews', constraintName: 'CK_finance_departure_cutoff_installment', type: 'CHECK', clauseIncludes: 'last_payable_installment' },
  { tableName: 'finance_departure_charge_reviews', constraintName: 'CK_finance_departure_charge_review_result', type: 'CHECK', clauseIncludes: 'reviewed_reduction_amount' },
  { tableName: 'finance_departure_cases', constraintName: 'CK_finance_departure_application_status', type: 'CHECK', clauseIncludes: 'legacy_applied' },
  { tableName: 'finance_departure_cases', constraintName: 'CK_finance_departure_application_review_reason', type: 'CHECK', clauseIncludes: 'needs_review' },
  { tableName: 'finance_departure_case_terms', constraintName: 'CK_finance_departure_term_snapshot_status', type: 'CHECK', clauseIncludes: 'pending_payment' },
  { tableName: 'finance_departure_case_terms', constraintName: 'CK_finance_departure_term_applied_status', type: 'CHECK', clauseIncludes: 'enrolled' },
  { tableName: 'finance_departure_application_events', constraintName: 'CK_finance_departure_application_event_type', type: 'CHECK', clauseIncludes: 'needs_review' },
  { tableName: 'finance_departure_application_events', constraintName: 'CK_finance_departure_application_event_source', type: 'CHECK', clauseIncludes: 'system_scheduler' },
  { tableName: 'finance_departure_application_events', constraintName: 'CK_finance_departure_application_event_actor', type: 'CHECK', clauseIncludes: 'database_admin' },
  { tableName: 'registrar_retake_referrals', constraintName: 'CK_registrar_retake_referral_kind', type: 'CHECK', clauseIncludes: 'transferee' },
  { tableName: 'registrar_retake_referrals', constraintName: 'CK_registrar_retake_referral_finalization', type: 'CHECK', clauseIncludes: 'finalized_at' },
  { tableName: 'registrar_retake_referral_items', constraintName: 'CK_registrar_retake_item_term', type: 'CHECK', clauseIncludes: 'between 1 and 3' },
  { tableName: 'finance_retake_item_decisions', constraintName: 'CK_finance_retake_item_decision_type', type: 'CHECK', clauseIncludes: 'no_charge' },
  { tableName: 'finance_retake_item_decisions', constraintName: 'CK_finance_retake_item_decision_shape', type: 'CHECK', clauseIncludes: 'approved_amount' },
  { tableName: 'finance_retake_item_decisions', constraintName: 'CK_finance_retake_item_decision_supersession', type: 'CHECK', clauseIncludes: 'superseded_at' },
  { tableName: 'registrar_retake_referral_events', constraintName: 'CK_registrar_retake_referral_event_type', type: 'CHECK', clauseIncludes: 'reference_updated' }
]);
const REQUIRED_INDEXES = Object.freeze([
  { tableName: 'students', indexName: 'UX_students_user_id_linked', columns: ['user_id'] },
  { tableName: 'pre_enrollments', indexName: 'UQ_pre_enrollment_idempotency', columns: ['idempotency_key'] },
  { tableName: 'pre_enrollments', indexName: 'UQ_pre_enrollment_year_lrn', columns: ['school_year', 'complete_lrn'] },
  { tableName: 'annual_enrollments', indexName: 'UQ_annual_enrollment_pre_enrollment', columns: ['pre_enrollment_id'] },
  { tableName: 'term_clearance_templates', indexName: 'UQ_term_clearance_template_version', columns: ['grade_level', 'track_label', 'version_no'] },
  { tableName: 'student_term_clearances', indexName: 'UQ_student_term_clearance_enrollment', columns: ['enrollment_id'] },
  { tableName: 'annual_term_finalizations', indexName: 'UQ_annual_term_finalization_token', columns: ['idempotency_key'] },
  { tableName: 'annual_finance_assessment_reviews', indexName: 'UQ_annual_finance_assessment_review_key', columns: ['idempotency_key'] },
  { tableName: 'annual_finance_assessment_reviews', indexName: 'UQ_annual_finance_assessment_review_confirmation_context',
    columns: ['id', 'annual_enrollment_id', 'assessment_id'] },
  { tableName: 'annual_enrollment_events', indexName: 'IX_annual_enrollment_event_finance_assessment',
    columns: ['finance_assessment_id', 'created_at', 'id'], unique: false },
  { tableName: 'annual_continuity_source_events', indexName: 'UQ_annual_continuity_source_event_token', columns: ['idempotency_key'] },
  { tableName: 'finance_departure_cutoff_reviews', indexName: 'UQ_finance_departure_cutoff_case', columns: ['departure_case_id'] },
  { tableName: 'finance_departure_cutoff_reviews', indexName: 'UQ_finance_departure_cutoff_key', columns: ['idempotency_key'] },
  { tableName: 'finance_departure_cutoff_reviews', indexName: 'UQ_finance_departure_cutoff_context', columns: ['id', 'departure_case_id'] },
  { tableName: 'finance_departure_charge_reviews', indexName: 'UQ_finance_departure_charge_review', columns: ['cutoff_review_id', 'charge_id'] },
  { tableName: 'finance_departure_charge_reviews', indexName: 'IX_finance_departure_charge_review_case', columns: ['departure_case_id', 'term_number', 'charge_id'], unique: false },
  { tableName: 'finance_departure_cases', indexName: 'IX_finance_departure_application_due', columns: ['application_status', 'effective_date', 'id'], unique: false },
  { tableName: 'finance_departure_application_events', indexName: 'IX_finance_departure_application_event_history', columns: ['departure_case_id', 'created_at', 'id'], unique: false },
  { tableName: 'registrar_retake_referrals', indexName: 'UQ_registrar_retake_referral_revision', columns: ['annual_enrollment_id', 'revision_no'] },
  { tableName: 'registrar_retake_referrals', indexName: 'UQ_registrar_retake_referral_key', columns: ['idempotency_key'] },
  { tableName: 'registrar_retake_referrals', indexName: 'UX_registrar_retake_referral_current', columns: ['current_annual_enrollment_id'] },
  { tableName: 'registrar_retake_item_keys', indexName: 'UQ_registrar_retake_item_key', columns: ['idempotency_key'] },
  { tableName: 'registrar_retake_referral_items', indexName: 'UQ_registrar_retake_item_revision', columns: ['referral_id', 'item_key_id'] },
  { tableName: 'finance_retake_item_decisions', indexName: 'UQ_finance_retake_item_decision_current', columns: ['current_item_key_id'] },
  { tableName: 'finance_retake_item_decisions', indexName: 'UQ_finance_retake_item_decision_charge_item', columns: ['charge_item_key_id'] },
  { tableName: 'finance_retake_item_decisions', indexName: 'UQ_finance_retake_item_decision_key', columns: ['idempotency_key'] }
]);
const REQUIRED_FOREIGN_KEYS = Object.freeze([
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_annual',
    columnName: 'annual_enrollment_id', referencedTable: 'annual_enrollments', referencedColumn: 'id' },
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_context',
    columnName: 'assessment_id', referencedTable: 'annual_assessments', referencedColumn: 'id' },
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_context',
    columnName: 'annual_enrollment_id', referencedTable: 'annual_assessments', referencedColumn: 'annual_enrollment_id' },
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_context',
    columnName: 'schedule_id', referencedTable: 'annual_assessments', referencedColumn: 'schedule_id' },
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_context',
    columnName: 'schedule_version', referencedTable: 'annual_assessments', referencedColumn: 'schedule_version' },
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_context',
    columnName: 'voucher_code_snapshot', referencedTable: 'annual_assessments', referencedColumn: 'voucher_code_snapshot' },
  { tableName: 'annual_finance_assessment_reviews', constraintName: 'FK_annual_finance_assessment_review_actor',
    columnName: 'reviewed_by', referencedTable: 'users', referencedColumn: 'id' },
  { tableName: 'annual_enrollment_events', constraintName: 'FK_annual_enrollment_event_finance_assessment',
    columnName: 'finance_assessment_id', referencedTable: 'annual_assessments', referencedColumn: 'id' },
  { tableName: 'annual_registrar_confirmations', constraintName: 'FK_annual_registrar_confirmation_finance_review_context',
    columnName: 'finance_review_id', referencedTable: 'annual_finance_assessment_reviews', referencedColumn: 'id' },
  { tableName: 'annual_registrar_confirmations', constraintName: 'FK_annual_registrar_confirmation_finance_review_context',
    columnName: 'annual_enrollment_id', referencedTable: 'annual_finance_assessment_reviews', referencedColumn: 'annual_enrollment_id' },
  { tableName: 'annual_registrar_confirmations', constraintName: 'FK_annual_registrar_confirmation_finance_review_context',
    columnName: 'assessment_id', referencedTable: 'annual_finance_assessment_reviews', referencedColumn: 'assessment_id' },
  { tableName: 'annual_enrollments', constraintName: 'FK_annual_enrollment_pre_enrollment',
    columnName: 'pre_enrollment_id', referencedTable: 'pre_enrollments', referencedColumn: 'id' },
  { tableName: 'pre_enrollments', constraintName: 'FK_pre_enrollment_readmission_evaluation',
    columnName: 'readmission_evaluation_id', referencedTable: 'readmission_evaluations', referencedColumn: 'id' },
  { tableName: 'annual_enrollments', constraintName: 'FK_annual_enrollment_readmission_evaluation',
    columnName: 'readmission_evaluation_id', referencedTable: 'readmission_evaluations', referencedColumn: 'id' },
  { tableName: 'annual_enrollments', constraintName: 'FK_annual_enrollment_continuity_source',
    columnName: 'continuity_source_annual_enrollment_id', referencedTable: 'annual_enrollments', referencedColumn: 'id' },
  { tableName: 'student_term_clearances', constraintName: 'FK_student_term_clearance_enrollment',
    columnName: 'enrollment_id', referencedTable: 'enrollments', referencedColumn: 'id' },
  { tableName: 'annual_term_finalizations', constraintName: 'FK_annual_term_finalization_enrollment',
    columnName: 'enrollment_id', referencedTable: 'enrollments', referencedColumn: 'id' },
  { tableName: 'term_clearance_template_items', constraintName: 'FK_term_clearance_template_item_template',
    columnName: 'template_id', referencedTable: 'term_clearance_templates', referencedColumn: 'id' },
  { tableName: 'finance_departure_cutoff_reviews', constraintName: 'FK_finance_departure_cutoff_case',
    columnName: 'departure_case_id', referencedTable: 'finance_departure_cases', referencedColumn: 'id' },
  { tableName: 'finance_departure_cutoff_reviews', constraintName: 'FK_finance_departure_cutoff_enrollment',
    columnName: 'effective_enrollment_id', referencedTable: 'enrollments', referencedColumn: 'id' },
  { tableName: 'finance_departure_cutoff_reviews', constraintName: 'FK_finance_departure_cutoff_actor',
    columnName: 'reviewed_by', referencedTable: 'users', referencedColumn: 'id' },
  { tableName: 'finance_departure_application_events', constraintName: 'FK_finance_departure_application_event_case',
    columnName: 'departure_case_id', referencedTable: 'finance_departure_cases', referencedColumn: 'id' },
  { tableName: 'finance_departure_application_events', constraintName: 'FK_finance_departure_application_event_actor',
    columnName: 'actor_id', referencedTable: 'users', referencedColumn: 'id' },
  { tableName: 'finance_departure_charge_reviews', constraintName: 'FK_finance_departure_charge_review_charge',
    columnName: 'charge_id', referencedTable: 'assessed_charges', referencedColumn: 'id' },
  { tableName: 'finance_departure_charge_reviews', constraintName: 'FK_finance_departure_charge_review_enrollment',
    columnName: 'enrollment_id', referencedTable: 'enrollments', referencedColumn: 'id' },
  { tableName: 'finance_departure_charge_reviews', constraintName: 'FK_finance_departure_charge_review_context',
    columnName: 'cutoff_review_id', referencedTable: 'finance_departure_cutoff_reviews', referencedColumn: 'id' },
  { tableName: 'finance_departure_charge_reviews', constraintName: 'FK_finance_departure_charge_review_context',
    columnName: 'departure_case_id', referencedTable: 'finance_departure_cutoff_reviews', referencedColumn: 'departure_case_id' },
  { tableName: 'registrar_retake_referrals', constraintName: 'FK_registrar_retake_referral_annual',
    columnName: 'annual_enrollment_id', referencedTable: 'annual_enrollments', referencedColumn: 'id' },
  { tableName: 'registrar_retake_referrals', constraintName: 'FK_registrar_retake_referral_readmission',
    columnName: 'readmission_evaluation_id', referencedTable: 'readmission_evaluations', referencedColumn: 'id' },
  { tableName: 'registrar_retake_item_keys', constraintName: 'FK_registrar_retake_item_key_annual',
    columnName: 'annual_enrollment_id', referencedTable: 'annual_enrollments', referencedColumn: 'id' },
  { tableName: 'registrar_retake_referral_items', constraintName: 'FK_registrar_retake_item_referral',
    columnName: 'referral_id', referencedTable: 'registrar_retake_referrals', referencedColumn: 'id' },
  { tableName: 'registrar_retake_referral_items', constraintName: 'FK_registrar_retake_item_key',
    columnName: 'item_key_id', referencedTable: 'registrar_retake_item_keys', referencedColumn: 'id' },
  { tableName: 'finance_retake_item_decisions', constraintName: 'FK_finance_retake_item_decision_key',
    columnName: 'item_key_id', referencedTable: 'registrar_retake_item_keys', referencedColumn: 'id' },
  { tableName: 'finance_retake_item_decisions', constraintName: 'FK_finance_retake_item_decision_revision',
    columnName: 'referral_item_id', referencedTable: 'registrar_retake_referral_items', referencedColumn: 'id' },
  { tableName: 'finance_retake_item_decisions', constraintName: 'FK_finance_retake_item_decision_charge',
    columnName: 'charge_id', referencedTable: 'assessed_charges', referencedColumn: 'id' },
  { tableName: 'registrar_retake_referral_events', constraintName: 'FK_registrar_retake_referral_event_referral',
    columnName: 'referral_id', referencedTable: 'registrar_retake_referrals', referencedColumn: 'id' }
]);
const EXPECTED_VERSIONS = Object.freeze(Array.from({ length: 22 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`));

function bindInList(request, values, prefix) {
  return values.map((value, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.VarChar(100), value);
    return `@${name}`;
  });
}

async function checkDatabase({ getDatabasePool = getPool, closeDatabasePool = closePool, logger = console } = {}) {
  try {
    const pool = await getDatabasePool();
    const databaseResult = await pool.request().query('SELECT DATABASE() AS databaseName');
    const databaseName = databaseResult.recordset?.[0]?.databaseName;
    if (!databaseName || databaseName !== env.database.database) {
      logger.error('MariaDB is reachable, but the selected database does not match DB_NAME.');
      process.exitCode = 1;
      return;
    }

    const versionRequest = pool.request();
    const versionNames = bindInList(versionRequest, EXPECTED_VERSIONS, 'version');
    const versionResult = await versionRequest.query(`SELECT version FROM schema_migrations WHERE version IN (${versionNames.join(', ')})`);
    const versions = new Set((versionResult.recordset || []).map(({ version }) => String(version)));

    const objectRequest = pool.request();
    const objectNames = bindInList(objectRequest, REQUIRED_OBJECTS, 'object');
    const objectResult = await objectRequest.query(`SELECT table_name AS objectName FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (${objectNames.join(', ')})`);
    const objects = new Set((objectResult.recordset || []).map(({ objectName }) => String(objectName)));

    const columnRequest = pool.request();
    const columnPairs = [];
    for (const [tableName, columnNames] of Object.entries(REQUIRED_COLUMNS)) {
      for (const columnName of columnNames) {
        const index = columnPairs.length;
        const tableParameter = `columnTable${index}`;
        const columnParameter = `columnName${index}`;
        columnRequest.input(tableParameter, sql.VarChar(100), tableName);
        columnRequest.input(columnParameter, sql.VarChar(100), columnName);
        columnPairs.push(`(table_name = @${tableParameter} AND column_name = @${columnParameter})`);
      }
    }
    const columnResult = await columnRequest.query(`SELECT table_name AS tableName, column_name AS columnName
      FROM information_schema.columns WHERE table_schema = DATABASE() AND (${columnPairs.join(' OR ')})`);
    const columns = new Set((columnResult.recordset || []).map(({ tableName, columnName }) => `${tableName}.${columnName}`));

    const constraintRequest = pool.request();
    const constraintPairs = REQUIRED_CONSTRAINTS.map(({ tableName, constraintName }, index) => {
      constraintRequest.input(`constraintTable${index}`, sql.VarChar(100), tableName);
      constraintRequest.input(`constraintName${index}`, sql.VarChar(100), constraintName);
      return `(constraints.table_name = @constraintTable${index} AND constraints.constraint_name = @constraintName${index})`;
    });
    const constraintResult = await constraintRequest.query(`SELECT constraints.table_name AS tableName,
        constraints.constraint_name AS constraintName, constraints.constraint_type AS constraintType,
        checks.check_clause AS checkClause
      FROM information_schema.table_constraints AS constraints
      LEFT JOIN information_schema.check_constraints AS checks
        ON checks.constraint_schema = constraints.constraint_schema
          AND checks.table_name = constraints.table_name AND checks.constraint_name = constraints.constraint_name
      WHERE constraints.constraint_schema = DATABASE() AND (${constraintPairs.join(' OR ')})`);

    const indexRequest = pool.request();
    const indexPairs = REQUIRED_INDEXES.map(({ tableName, indexName }, index) => {
      indexRequest.input(`indexTable${index}`, sql.VarChar(100), tableName);
      indexRequest.input(`indexName${index}`, sql.VarChar(100), indexName);
      return `(table_name = @indexTable${index} AND index_name = @indexName${index})`;
    });
    const indexResult = await indexRequest.query(`SELECT table_name AS tableName, index_name AS indexName, non_unique AS nonUnique,
        GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
      FROM information_schema.statistics WHERE table_schema = DATABASE() AND (${indexPairs.join(' OR ')})
      GROUP BY table_name, index_name, non_unique`);

    const foreignKeyRequest = pool.request();
    const foreignKeyPairs = REQUIRED_FOREIGN_KEYS.map(({ tableName, constraintName }, index) => {
      foreignKeyRequest.input(`foreignKeyTable${index}`, sql.VarChar(100), tableName);
      foreignKeyRequest.input(`foreignKeyName${index}`, sql.VarChar(100), constraintName);
      return `(table_name = @foreignKeyTable${index} AND constraint_name = @foreignKeyName${index})`;
    });
    const foreignKeyResult = await foreignKeyRequest.query(`SELECT table_name AS tableName, constraint_name AS constraintName,
        column_name AS columnName, referenced_table_name AS referencedTable, referenced_column_name AS referencedColumn
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND (${foreignKeyPairs.join(' OR ')})`);

    const constraints = new Map((constraintResult.recordset || []).map((row) => [`${row.tableName}.${row.constraintName}`, row]));
    const indexes = new Map((indexResult.recordset || []).map((row) => [`${row.tableName}.${row.indexName}`, row]));
    const missingConstraints = REQUIRED_CONSTRAINTS.filter((expected) => {
      const actual = constraints.get(`${expected.tableName}.${expected.constraintName}`);
      return !actual || String(actual.constraintType).toUpperCase() !== expected.type
        || (expected.clauseIncludes && !String(actual.checkClause || '').toLowerCase().includes(expected.clauseIncludes));
    }).map(({ tableName, constraintName }) => `constraint ${tableName}.${constraintName}`);
    const missingIndexes = REQUIRED_INDEXES.filter((expected) => {
      const actual = indexes.get(`${expected.tableName}.${expected.indexName}`);
      const expectedUnique = expected.unique !== false;
      const actualUnique = actual ? Number(actual.nonUnique) === 0 : false;
      return !actual || actualUnique !== expectedUnique
        || String(actual.columns || '').split(',').join('\0') !== expected.columns.join('\0');
    }).map(({ tableName, indexName, unique }) => `${unique === false ? 'index' : 'unique index'} ${tableName}.${indexName}`);
    const missingForeignKeys = REQUIRED_FOREIGN_KEYS.filter((expected) => {
      const actual = (foreignKeyResult.recordset || []).find((row) => row.tableName === expected.tableName
        && row.constraintName === expected.constraintName && row.columnName === expected.columnName);
      return !actual || actual.columnName !== expected.columnName || actual.referencedTable !== expected.referencedTable
        || actual.referencedColumn !== expected.referencedColumn;
    }).map(({ tableName, constraintName }) => `foreign key ${tableName}.${constraintName}`);

    const missing = [
      ...REQUIRED_OBJECTS.filter((name) => !objects.has(name)).map((name) => `object ${name}`),
      ...Object.entries(REQUIRED_COLUMNS).flatMap(([tableName, columnNames]) => columnNames
        .filter((columnName) => !columns.has(`${tableName}.${columnName}`))
        .map((columnName) => `column ${tableName}.${columnName}`)),
      ...EXPECTED_VERSIONS.filter((version) => !versions.has(version)).map((version) => `migration ${version}`),
      ...missingConstraints,
      ...missingIndexes,
      ...missingForeignKeys
    ];
    if (missing.length) {
      logger.error(`MariaDB is reachable, but its ARKTIESIIS schema is incomplete: ${missing.join(', ')}.`);
      process.exitCode = 1;
      return;
    }
    logger.log(`MariaDB connectivity and schema in ${databaseName} are verified through v2.022.`);
  } catch {
    logger.error('MariaDB database check failed. Confirm DB_HOST, DB_PORT, DB_NAME, DB_USER, and DB_PASSWORD, then run npm run db:setup.');
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabasePool();
    } catch {
      logger.error('MariaDB database check could not close its connection cleanly.');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) checkDatabase();

module.exports = { REQUIRED_OBJECTS, REQUIRED_COLUMNS, REQUIRED_CONSTRAINTS, REQUIRED_INDEXES, REQUIRED_FOREIGN_KEYS, EXPECTED_VERSIONS, checkDatabase };
