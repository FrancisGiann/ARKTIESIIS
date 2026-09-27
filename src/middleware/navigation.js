const navigationByRole = {
  database_admin: [
    { id: 'overview', label: 'Overview', href: '/dashboard' },
    { id: 'audit', label: 'Audit activity', href: '/admin/audit' },
    { id: 'student-records', label: 'Student records', href: '/records' },
    { id: 'documents', label: 'Documents', href: '/documents' },
    { id: 'subjects', label: 'Subject catalog', href: '/records/subjects' },
    { id: 'teacher-assignments', label: 'Teacher assignments', href: '/records/teacher-assignments' },
    { id: 'finance', label: 'Finance', href: '/finance' }
  ],
  registrar: [
    { id: 'overview', label: 'Overview', href: '/dashboard' },
    { id: 'student-records', label: 'Student records', href: '/records' },
    { id: 'documents', label: 'Documents', href: '/documents' },
    { id: 'subjects', label: 'Subject catalog', href: '/records/subjects' },
    { id: 'teacher-assignments', label: 'Teacher assignments', href: '/records/teacher-assignments' },
    { id: 'grade-submissions', label: 'Grade submissions', href: '/registrar/grade-submissions' }
  ],
  teacher: [
    { id: 'teacher-workspace', label: 'My classes', href: '/teacher/grades' }
  ],
  finance: [
    { id: 'finance', label: 'Finance workspace', href: '/finance' }
  ],
  student: [
    { id: 'my-record', label: 'My record', href: '/dashboard/student' },
    { id: 'documents', label: 'My documents', href: '/documents' }
  ]
};

function buildNavigation(role, currentPath = '') {
  const path = typeof currentPath === 'string' ? currentPath.split('?', 1)[0] : '';
  const items = (navigationByRole[role] || []).map((item) => {
    let current = false;
    if (item.id === 'overview') {
      current = role === 'database_admin'
        ? path === '/admin' || path.startsWith('/admin/users/')
        : role === 'registrar' && path === '/dashboard/registrar';
    } else if (item.id === 'audit') {
      current = role === 'database_admin' && path === '/admin/audit';
    } else if (item.id === 'student-records') {
      current = path === '/records' || (path.startsWith('/records/') && !path.startsWith('/records/subjects'));
    } else if (item.id === 'subjects') {
      current = path === '/records/subjects' || path.startsWith('/records/subjects/');
    } else if (item.id === 'teacher-assignments') {
      current = path === '/records/teacher-assignments' || path.startsWith('/records/teacher-assignments/');
    } else if (item.id === 'grade-submissions') {
      current = path === '/registrar/grade-submissions' || path.startsWith('/registrar/grade-submissions/');
    } else if (item.id === 'teacher-workspace') {
      current = path === '/dashboard/teacher' || path.startsWith('/teacher/grades');
    } else if (item.id === 'finance') {
      current = path === '/finance' || path.startsWith('/finance/');
    } else if (item.id === 'documents') {
      current = path === '/documents' || path.startsWith('/documents/');
    } else if (item.id === 'my-record') {
      current = path === '/dashboard/student';
    }
    return { ...item, current };
  });

  return {
    items,
    currentPage: items.find((item) => item.current)?.id || null
  };
}

module.exports = { buildNavigation };
