const financeNavigationItems = [
  { id: 'finance-overview', label: 'Overview', href: '/finance/overview', group: 'Finance' },
  { id: 'finance-roster', label: 'Student accounts', href: '/finance', group: 'Finance' },
  { id: 'finance-schedules', label: 'Fee schedules', href: '/finance/schedules', group: 'Finance' },
  { id: 'finance-reports', label: 'Reports', href: '/finance/reports', group: 'Finance' },
  { id: 'finance-departures', label: 'Departure review', href: '/finance/departures', group: 'Finance' },
  { id: 'finance-review-drafts', label: 'Saved reviews', href: '/finance/review-drafts', group: 'Finance' }
];

const navigationByRole = {
  database_admin: [
    { id: 'overview', label: 'Overview', href: '/admin', group: 'Workspace' },
    { id: 'accounts', label: 'User accounts', href: '/admin/users', group: 'People and records' },
    { id: 'students', label: 'Student records', href: '/registrar/records', group: 'People and records' },
    { id: 'pre-enrollments', label: 'Pre-enrollment records', href: '/pre-enrollments', group: 'People and records' },
    { id: 'audit', label: 'Activity log', href: '/admin/audit', group: 'Activity & documents' },
    { id: 'documents', label: 'Documents', href: '/documents', group: 'Activity & documents' },
    ...financeNavigationItems
  ],
  registrar: [
    { id: 'overview', label: 'Overview', href: '/registrar', group: 'Workspace' },
    { id: 'students', label: 'Student records', href: '/registrar/records', group: 'Records' },
    { id: 'intake', label: 'Enrollments', href: '/registrar/intake', group: 'Records' },
    { id: 'pre-enrollments', label: 'Pre-enrollment records', href: '/pre-enrollments', group: 'Records' },
    { id: 'documents', label: 'Document review', href: '/documents', group: 'Records' },
    { id: 'grade-submissions', label: 'Grade review', href: '/registrar/grade-submissions', group: 'Academic work' },
    { id: 'schedules', label: 'Class schedules', href: '/registrar/schedules', group: 'Academic work' },
    { id: 'subjects', label: 'Subjects', href: '/registrar/records/subjects', group: 'Setup' },
    { id: 'assignments', label: 'Teacher assignments', href: '/registrar/records/teacher-assignments', group: 'Setup' },
    { id: 'academic-setup', label: 'Academic setup', href: '/registrar/records?view=setup', group: 'Setup' }
  ],
  front_desk: [
    { id: 'front-desk-pre-enrollments', label: 'Pre-enrollment records', href: '/pre-enrollments', group: 'Workspace' }
  ],
  teacher: [
    { id: 'teacher-workspace', label: 'My classes', href: '/teacher', group: 'Teaching' },
    { id: 'grade-upload', label: 'Submit grades', href: '/teacher/grades', group: 'Teaching' }
  ],
  finance: financeNavigationItems,
  student: [
    { id: 'home', label: 'Home', href: '/student', group: 'My school' },
    { id: 'schedule', label: 'Class schedule', href: '/student/schedule', group: 'My school' },
    { id: 'grades', label: 'Grades', href: '/student/grades', group: 'My school' },
    { id: 'finance', label: 'Fees & payments', href: '/student/finance', group: 'My school' },
    { id: 'records', label: 'My records', href: '/student/records', group: 'My school' },
    { id: 'documents', label: 'Documents', href: '/documents', group: 'My school' }
  ]
};

function buildNavigation(role, currentPath = '') {
  const source = typeof currentPath === 'string' ? currentPath : '';
  const queryStart = source.indexOf('?');
  const hashStart = source.indexOf('#');
  const queryEnd = hashStart === -1 ? source.length : hashStart;
  const pathEnd = queryStart === -1 ? queryEnd : Math.min(queryStart, queryEnd);
  const path = source.slice(0, pathEnd) || '/';
  const query = new URLSearchParams(queryStart === -1 || queryStart >= queryEnd ? '' : source.slice(queryStart + 1, queryEnd));
  const financeStudentPath = /^\/finance\/students\/[^/]+(?:\/.*)?$/.test(path);
  const roleItems = (navigationByRole[role] || []).map((item) => {
    let current = false;
    if (item.id === 'overview') current = path === '/admin' || path === '/registrar';
    else if (item.id === 'front-desk-pre-enrollments') current = path.startsWith('/pre-enrollments');
    else if (item.id === 'pre-enrollments') current = path.startsWith('/pre-enrollments');
    else if (item.id === 'accounts') current = path.startsWith('/admin/users') || path.startsWith('/admin/student-accounts');
    else if (item.id === 'audit') current = path === '/admin/audit';
    else if (item.id === 'students') current = (path === '/registrar/records' && (role !== 'registrar' || query.get('view') !== 'setup')) || path.startsWith('/registrar/records/students') || path.startsWith('/registrar/records/return-evaluations');
    else if (item.id === 'intake') current = path.startsWith('/registrar/intake');
    else if (item.id === 'subjects') current = path.startsWith('/registrar/records/subjects');
    else if (item.id === 'assignments') current = path.startsWith('/registrar/records/teacher-assignments');
    else if (item.id === 'academic-setup') current = role === 'registrar' && path === '/registrar/records' && query.get('view') === 'setup';
    else if (item.id === 'schedules') current = path.startsWith('/registrar/schedules');
    else if (item.id === 'grade-submissions') current = path.startsWith('/registrar/grade-submissions');
    else if (item.id === 'teacher-workspace') current = path === '/teacher';
    else if (item.id === 'grade-upload') current = path.startsWith('/teacher/grades');
    else if (item.id === 'schedule') current = path.startsWith('/student/schedule');
    else if (item.id === 'grades') current = path.startsWith('/student/grades');
    else if (item.id === 'records') current = path.startsWith('/student/records');
    else if (item.id === 'finance') current = role === 'student'
      ? path.startsWith('/student/finance')
      : false;
    else if (item.id === 'finance-overview') current = path === '/finance/overview';
    else if (item.id === 'finance-roster') current = path === '/finance' || financeStudentPath;
    else if (item.id === 'finance-schedules') current = path.startsWith('/finance/schedules');
    else if (item.id === 'finance-reports') current = path.startsWith('/finance/reports');
    else if (item.id === 'finance-departures') current = path.startsWith('/finance/departures');
    else if (item.id === 'finance-review-drafts') current = path.startsWith('/finance/review-drafts');
    else if (item.id === 'documents') current = path === '/documents' || path.startsWith('/documents/');
    else if (item.id === 'home') current = path === '/student';
    return { ...item, current };
  });

  const items = [...roleItems, {
    id: 'account', label: 'Account settings', href: '/account', group: 'Account',
    current: path === '/account' || path.startsWith('/account/')
  }];
  const groups = [...new Set(roleItems.map((item) => item.group))].map((label) => ({
    label,
    items: roleItems.filter((item) => item.group === label)
  }));

  return { items, groups, currentPage: items.find((item) => item.current)?.id || null };
}

module.exports = { buildNavigation };
