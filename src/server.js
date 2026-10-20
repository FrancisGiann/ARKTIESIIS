if (process.env.APP_MAINTENANCE_MODE === 'true') {
  require('./maintenanceRuntime').start();
} else {
  void require('./serverRuntime').start().catch(() => {
    process.exitCode = 1;
  });
}
