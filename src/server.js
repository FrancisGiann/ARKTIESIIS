if (process.env.APP_MAINTENANCE_MODE === 'true') {
  require('./maintenanceRuntime').start();
} else {
  require('./serverRuntime').start();
}
