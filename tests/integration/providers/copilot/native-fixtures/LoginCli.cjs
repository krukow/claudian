const fs = require('node:fs');
const path = require('node:path');

function waitForTermination() {
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    fs.writeFileSync(process.env.LOGIN_FIXTURE_STOPPED, 'stopped');
    process.exit(1);
  });
}

function main() {
  if (process.argv.slice(2).join(' ') === 'login --help') {
    if (process.env.LOGIN_FIXTURE_MODE === 'help-wait') {
      waitForTermination();
      return;
    }
    process.stdout.write(process.env.LOGIN_FIXTURE_MODE === 'unsupported'
      ? 'Usage: copilot login\n'
      : 'Usage: copilot login --web-flow\n');
    process.exit(process.env.LOGIN_FIXTURE_MODE === 'help-fail' ? 1 : 0);
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
    waitForTermination();
  }
  process.stdout.write('Opening your browser to authenticate...\n');
  process.stdout.write('https://github.com/login/oauth/authorize?client_id=synthetic&state=synthetic\n');
  if (process.env.LOGIN_FIXTURE_MODE !== 'wait') {
    process.exit(process.env.LOGIN_FIXTURE_MODE === 'fail' ? 1 : 0);
  }
}

main();
