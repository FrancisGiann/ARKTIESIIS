const navigationByRole = {
  database_admin: [
    { id: 'overview', label: 'Overview', href: '/admin', group: 'Workspace' },
    { id: 'accounts', label: 'Accounts', href: '/admin/users', group: 'People and records' },
    { id: 'students', label: 'Student records', href: '/registrar/records', group: 'People and records' },
    { id: 'audit', label: 'Audit activity', href: '/admin/audit', group: 'Oversight' },
    { id: 'documents', label: 'Documents', href: '/documents', group: 'Oversight' },
    { id: 'finance', label: 'Finance', href: '/finance', group: 'Oversight' }
  ],
  registrar: [
    { id: 'overview', label: 'Overview', href: '/registrar', group: 'Workspace' },
    { id: 'students', label: 'Student records', href: '/registrar/records', group: 'Records' },
    { id: 'intake', label: 'Enrollment intake', href: '/registrar/intake', group: 'Records' },
    { id: 'documents', label: 'Document review', href: '/documents', group: 'Records' },
    { id: 'grade-submissions', label: 'Grade review', href: '/registrar/grade-submissions', group: 'Academic work' },
    { id: 'schedules', label: 'Class schedules', href: '/registrar/schedules', group: 'Academic work' },
    { id: 'subjects', label: 'Subject catalog', href: '/registrar/records/subjects', group: 'Setup' },
    { id: 'assignments', label: 'Teacher assignments', href: '/registrar/records/teacher-assignments', group: 'Setup' }
  ],
  teacher: [
    { id: 'teacher-workspace', label: 'My classes', href: '/teacher', group: 'Teaching' },
    { id: 'grade-upload', label: 'Submit grades', href: '/teacher/grades', group: 'Teaching' }
  ],
  finance: [
    { id: 'finance', label: 'Finance workspace', href: '/finance', group: 'Finance' }
  ],
  student: [
    { id: 'home', label: 'Home', href: '/student', group: 'My school' },
    { id: 'schedule', label: 'Schedule', href: '/student/schedule', group: 'My school' },
    { id: 'grades', label: 'Grades', href: '/student/grades', group: 'My school' },
    { id: 'finance', label: 'Finance', href: '/student/finance', group: 'My school' },
    { id: 'records', label: 'My records', href: '/student/records', group: 'My school' },
    { id: 'documents', label: 'Documents', href: '/documents', group: 'My school' }
  ]
};

function buildNavigation(role, currentPath = '') {
  const path = typeof currentPath === 'string' ? currentPath.split(/[?#]/, 1)[0] : '';
  const roleItems = (navigationByRole[role] || []).map((item) => {
    let current = false;
    if (item.id === 'overview') current = path === '/admin' || path === '/registrar';
    else if (item.id === 'accounts') current = path.startsWith('/admin/users') || path.startsWith('/admin/student-accounts');
    else if (item.id === 'audit') current = path === '/admin/audit';
    else if (item.id === 'students') current = path === '/registrar/records' || path.startsWith('/registrar/records/students');
    else if (item.id === 'intake') current = path.startsWith('/registrar/intake');
    else if (item.id === 'subjects') current = path.startsWith('/registrar/records/subjects');
    else if (item.id === 'assignments') current = path.startsWith('/registrar/records/teacher-assignments');
    else if (item.id === 'schedules') current = path.startsWith('/registrar/schedules');
    else if (item.id === 'grade-submissions') current = path.startsWith('/registrar/grade-submissions');
    else if (item.id === 'teacher-workspace') current = path === '/teacher';
    else if (item.id === 'grade-upload') current = path.startsWith('/teacher/grades');
    else if (item.id === 'schedule') current = path.startsWith('/student/schedule');
    else if (item.id === 'grades') current = path.startsWith('/student/grades');
    else if (item.id === 'records') current = path.startsWith('/student/records');
    else if (item.id === 'finance') current = role === 'student'
      ? path.startsWith('/student/finance')
      : path === '/finance' || path.startsWith('/finance/');
    else if (item.id === 'documents') current = path === '/documents' || path.startsWith('/documents/');
    else if (item.id === 'home') current = path === '/student';
    return { ...item, current };
  });

  const items = [...roleItems, {
    id: 'account', label: 'Account', href: '/account', group: 'Account',
    current: path === '/account' || path.startsWith('/account/')
  }];
  const groups = [...new Set(roleItems.map((item) => item.group))].map((label) => ({
    label,
    items: roleItems.filter((item) => item.group === label)
  }));

  return { items, groups, currentPage: items.find((item) => item.current)?.id || null };
}

module.exports = { buildNavigation };
