const fs = require('node:fs');
const path = require('node:path');

if (process.argv.slice(2).join(' ') === 'login --help') {
  process.stdout.write(process.env.LOGIN_FIXTURE_MODE === 'unsupported'
    ? 'Usage: copilot login\n'
    : 'Usage: copilot login --web-flow\n');
  process.exit(0);
}
if (process.argv.slice(2).join(' ') !== 'login --web-flow') {
  throw new Error('Unexpected login arguments.');
}
const settings = JSON.parse(fs.readFileSync(path.join(process.env.COPILOT_HOME, 'settings.json')));
if (settings.storeTokenPlaintext !== false || process.stdin.isTTY || process.stdout.isTTY) {
  throw new Error('Login must use secure storage and non-interactive pipes.');
}
fs.writeFileSync(process.env.LOGIN_FIXTURE_STARTED, 'started');
if (process.env.LOGIN_FIXTURE_MODE === 'wait') {
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    fs.writeFileSync(process.env.LOGIN_FIXTURE_STOPPED, 'stopped');
    process.exit(1);
  });
}
process.stdout.write('Opening your browser to authenticate...\n');
process.stdout.write('https://github.com/login/oauth/authorize?client_id=synthetic&state=synthetic\n');
if (process.env.LOGIN_FIXTURE_MODE !== 'wait') {
  process.exit(process.env.LOGIN_FIXTURE_MODE === 'fail' ? 1 : 0);
}
