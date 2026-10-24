(() => {
  for (const form of document.querySelectorAll('[data-account-role-form]')) {
    const role = form.querySelector('[name="role"]');
    if (!role) continue;

    const update = () => {
      const isStudent = role.value === 'student';
      for (const field of form.querySelectorAll('[data-staff-profile], [data-student-profile]')) {
        const active = field.hasAttribute('data-student-profile') ? isStudent : !isStudent;
        field.hidden = !active;
        for (const control of field.querySelectorAll('input, select, textarea')) {
          control.disabled = !active;
        }
      }
    };

    role.addEventListener('change', update);
    update();
  }
})();
